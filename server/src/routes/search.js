// Salon search, the rule-based Vietnamese assistant and suggestion chips.
import express from 'express';
import { db } from '../db.js';
import { hasSlotsInRange } from '../lib/availability.js';
import { SALON_CARD_COLUMNS, toSalonCard } from '../lib/cards.js';
import { haversineKm, parsePagination } from '../lib/query.js';
import {
  addDaysISO,
  fromMinutes,
  isHHMM,
  isISODate,
  nowMinutes,
  toMinutes,
  todayISO,
  weekdayOf,
} from '../lib/time.js';
import { httpError } from '../middleware/auth.js';

const router = express.Router();

const DEFAULT_LIMIT = 12;
// Ranking, distance and availability are all computed in JS over every matching row, so
// the candidate set is capped before any of that runs. The cap sits far above the number
// of salons the platform holds, so meta.total still reports every real match.
const CANDIDATE_LIMIT = 100;
const MAX_REASONS = 3;
const MAX_CHIPS = 3;
const NOON_MIN = 12 * 60;
const EVENING_MIN = 17 * 60;

const CATEGORY_LABELS = {
  nail: 'Nail',
  hair: 'Tóc',
  skincare: 'Chăm sóc da',
  spa: 'Spa & Massage',
  eyelash: 'Nối mi',
};

// Relevance weights. Ranking is text/category match strength first, rating second.
const NAME_MATCH_SCORE = 3;
const SERVICE_MATCH_SCORE = 2;
const DISTRICT_MATCH_SCORE = 1;
const CATEGORY_MATCH_SCORE = 2;

// Sort comparators, looked up by key so the query string can never pick an arbitrary one.
const SORTS = {
  rating: (a, b) => b.rating - a.rating,
  distance: (a, b) => (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity),
  price: (a, b) => (a.price_from ?? Infinity) - (b.price_from ?? Infinity),
};
const BY_RELEVANCE = (a, b) => b.score - a.score || b.rating - a.rating;

const selectSalonServices = db.prepare(`
  SELECT name, category, price
  FROM services
  WHERE salon_id = ? AND active = 1 AND category <> 'amenity'
  ORDER BY price ASC, id ASC
`);

const selectTopCategories = db.prepare(`
  SELECT category, COUNT(*) AS count
  FROM services
  WHERE active = 1 AND category <> 'amenity'
  GROUP BY category
  ORDER BY count DESC, category
  LIMIT 3
`);

const selectTopDistricts = db.prepare(`
  SELECT district, COUNT(*) AS count
  FROM salons
  WHERE district IS NOT NULL
  GROUP BY district
  ORDER BY count DESC, district
  LIMIT 2
`);

/** Lowercase, diacritic-free text so the rules below can match plain ASCII. */
function normalize(value) {
  return String(value)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/đ/g, 'd');
}

// Object.hasOwn, so a caller-supplied category like "toString" cannot reach an
// inherited property and stringify a function into the reply.
function categoryLabel(key) {
  return Object.hasOwn(CATEGORY_LABELS, key) ? CATEGORY_LABELS[key] : String(key);
}

/** A query-string value, or null when it is absent or not a plain string. */
function textValue(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** A finite number from the query string, or null when the value is absent or garbage. */
function numberValue(value) {
  const text = textValue(value);
  if (text === null) {
    return null;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 350000 -> '350.000đ' */
function formatVnd(amount) {
  return `${String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}đ`;
}

function windowLabel(timeFrom) {
  const minutes = toMinutes(timeFrom);
  if (minutes === null) {
    return null;
  }
  if (minutes < NOON_MIN) {
    return 'sáng';
  }
  return minutes < EVENING_MIN ? 'chiều' : 'tối';
}

function dayLabel(date) {
  if (date === todayISO()) {
    return 'hôm nay';
  }
  if (date === addDaysISO(todayISO(), 1)) {
    return 'mai';
  }
  const [, month, day] = date.split('-');
  return `ngày ${day}/${month}`;
}

// Services arrive cheapest first, so the first hit is also the "từ" price to quote.
function pickMatchedService(services, category, normalizedQuery) {
  if (category) {
    const hit = services.find((service) => service.category === category);
    if (hit) {
      return hit;
    }
  }
  if (normalizedQuery) {
    return services.find((service) => normalize(service.name).includes(normalizedQuery)) ?? null;
  }
  return null;
}

function matchScore(card, services, normalizedQuery, category) {
  let score = 0;
  if (normalizedQuery) {
    if (normalize(card.name).includes(normalizedQuery)) {
      score += NAME_MATCH_SCORE;
    }
    if (services.some((service) => normalize(service.name).includes(normalizedQuery))) {
      score += SERVICE_MATCH_SCORE;
    }
    if (normalize(card.district ?? '').includes(normalizedQuery)) {
      score += DISTRICT_MATCH_SCORE;
    }
  }
  if (category && services.some((service) => service.category === category)) {
    score += CATEGORY_MATCH_SCORE;
  }
  return score;
}

/** Assembled from whichever facts hold; never empty, so a card always has a reason. */
function buildMatchReason(card, distanceKm, matchedService, slotLabel) {
  const reasons = [];
  if (distanceKm !== null) {
    reasons.push(`Cách bạn ${distanceKm}km`);
  }
  if (matchedService) {
    reasons.push(`Có ${matchedService.name} từ ${formatVnd(matchedService.price)}`);
  }
  if (slotLabel) {
    reasons.push(`Còn lịch ${slotLabel}`);
  }
  if (reasons.length < MAX_REASONS && card.rating > 0) {
    reasons.push(`Đánh giá ${card.rating}/5`);
  }
  if (reasons.length === 0) {
    reasons.push(card.district || card.city || card.name);
  }
  return reasons.slice(0, MAX_REASONS).join(' • ');
}

router.get('/salons', async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, DEFAULT_LIMIT);

    const q = textValue(req.query.q);
    const category = textValue(req.query.category);
    const style = textValue(req.query.style);
    const district = textValue(req.query.district);
    const lat = numberValue(req.query.lat);
    const lng = numberValue(req.query.lng);
    const radiusKm = numberValue(req.query.radius_km);
    const priceMax = numberValue(req.query.price_max);
    const ratingMin = numberValue(req.query.rating_min);
    const date = isISODate(req.query.date) ? req.query.date : null;
    const timeFrom = isHHMM(req.query.time_from) ? req.query.time_from : null;
    const timeTo = isHHMM(req.query.time_to) ? req.query.time_to : null;

    // Same switch as GET /api/salons: salons are verified on creation, so this excludes
    // nothing today and only matters if a real verification flow ever returns.
    const conditions = ['s.verified = 1'];
    const params = [];

    if (q) {
      conditions.push(`(s.name ILIKE ? OR s.district ILIKE ?
        OR EXISTS (SELECT 1 FROM services sv
                   WHERE sv.salon_id = s.id AND sv.active = 1 AND sv.name ILIKE ?))`);
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (category) {
      conditions.push(
        'EXISTS (SELECT 1 FROM services sv WHERE sv.salon_id = s.id AND sv.active = 1 AND sv.category = ?)',
      );
      params.push(category);
    }
    // The schema has no style column, so a style is matched as free text over the
    // service subcategory and name ("Nail art", "Uốn xoăn lơi Hàn Quốc", ...).
    if (style) {
      conditions.push(`EXISTS (SELECT 1 FROM services sv
        WHERE sv.salon_id = s.id AND sv.active = 1
          AND (sv.subcategory ILIKE ? OR sv.name ILIKE ?))`);
      params.push(`%${style}%`, `%${style}%`);
    }
    if (district) {
      conditions.push('s.district = ?');
      params.push(district);
    }
    if (priceMax !== null) {
      conditions.push(`EXISTS (SELECT 1 FROM services sv
        WHERE sv.salon_id = s.id AND sv.active = 1 AND sv.category <> 'amenity' AND sv.price <= ?)`);
      params.push(priceMax);
    }
    // Against today's own opening hours: 'HH:MM' compares correctly as plain text, and
    // a salon that has not published its week is never open now — the same answer the
    // whole-week pair gave while it was still NULL.
    if (req.query.open_now === '1') {
      const now = fromMinutes(nowMinutes());
      conditions.push(`EXISTS (SELECT 1 FROM salon_hours h
        WHERE h.salon_id = s.id AND h.weekday = ? AND h.is_off = 0
          AND h."start" <= ? AND h."end" >= ?)`);
      params.push(weekdayOf(todayISO()), now, now);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    // ORDER BY, so which salons the cap keeps is stable rather than left to the planner.
    const rows = await db
      .prepare(`SELECT ${SALON_CARD_COLUMNS} FROM salons s ${where} ORDER BY s.id LIMIT ?`)
      .all(...params, CANDIDATE_LIMIT);

    const normalizedQuery = q ? normalize(q) : '';
    const candidates = [];
    for (const row of rows) {
      const card = toSalonCard(row);
      const services = await selectSalonServices.all(row.id);
      candidates.push({
        ...card,
        distance_km: haversineKm(lat, lng, row.lat, row.lng),
        score: matchScore(card, services, normalizedQuery, category),
        matched_service: pickMatchedService(services, category, normalizedQuery),
      });
    }
    const filtered = candidates
      // A radius cannot filter anything when the caller gave no position to measure from.
      .filter((item) => radiusKm === null || item.distance_km === null || item.distance_km <= radiusKm)
      .filter((item) => ratingMin === null || item.rating >= ratingMin);

    const comparator = Object.hasOwn(SORTS, req.query.sort) ? SORTS[req.query.sort] : BY_RELEVANCE;
    filtered.sort(comparator);

    const slotLabel = date ? [windowLabel(timeFrom), dayLabel(date)].filter(Boolean).join(' ') : '';
    const data = [];
    for (const item of filtered.slice(offset, offset + limit)) {
      const { score, matched_service: matchedService, ...card } = item;
      const availability = date ? await hasSlotsInRange(item.id, date, timeFrom, timeTo) : null;
      const result = {
        ...card,
        match_reason: buildMatchReason(
          card,
          item.distance_km,
          matchedService,
          availability ? slotLabel : '',
        ),
      };
      if (date) {
        result.availability = availability;
      }
      data.push(result);
    }

    res.json({ success: true, data, meta: { page, limit, total: filtered.length } });
  } catch (error) {
    next(error);
  }
});

/*
 * Rule-based Vietnamese parser. Every rule runs on normalized (diacritic-free,
 * lowercase) text and anchors on word boundaries, so "mi" (nối mi) cannot fire
 * inside "mai" (ngày mai) and the date rule keeps its own word.
 */
const CATEGORY_RULES = [
  { key: 'nail', pattern: /\bnail\b|\bmong\b/ },
  { key: 'hair', pattern: /\btoc\b|\bhair\b/ },
  { key: 'skincare', pattern: /\bskincare\b|\bda\b|\bmun\b/ },
  { key: 'spa', pattern: /\bspa\b|\bmassage\b/ },
  { key: 'eyelash', pattern: /\bmi\b|\beyelash\b/ },
];

// Named districts, in the form the salons table stores.
const NAMED_DISTRICTS = [
  { pattern: /\bbinh thanh\b/, name: 'Quận Bình Thạnh' },
  { pattern: /\bphu nhuan\b/, name: 'Quận Phú Nhuận' },
  { pattern: /\bthu duc\b/, name: 'Thủ Đức' },
  { pattern: /\bgo vap\b/, name: 'Quận Gò Vấp' },
  { pattern: /\btan binh\b/, name: 'Quận Tân Bình' },
];

const TIME_WINDOWS = [
  { pattern: /\bsang\b/, time_from: '08:00', time_to: '12:00' },
  { pattern: /\bchieu\b/, time_from: '13:00', time_to: '17:00' },
  { pattern: /\btoi\b/, time_from: '17:00', time_to: '21:00' },
];

const MISSING_RULES = [
  { key: 'category', label: 'dịch vụ bạn muốn làm' },
  { key: 'district', label: 'khu vực' },
  { key: 'date', label: 'thời gian mong muốn' },
  { key: 'price_max', label: 'ngân sách' },
];

// One refinement chip per criterion still absent, most useful first.
const CHIP_RULES = [
  { key: 'category', chip: 'Làm nail' },
  { key: 'district', chip: 'Ở Quận 1' },
  { key: 'date', chip: 'Ngày mai' },
  { key: 'time_from', chip: 'Buổi chiều' },
  { key: 'price_max', chip: 'Dưới 500k' },
  { key: 'rating_min', chip: 'Đánh giá từ 4.5 sao' },
  { key: 'radius_km', chip: 'Trong bán kính 3km' },
];

function parseDistrict(text) {
  const numbered = text.match(/\bquan\s*(\d{1,2})\b/) ?? text.match(/\bq\.?\s*(\d{1,2})\b/);
  if (numbered) {
    return `Quận ${Number(numbered[1])}`;
  }
  return NAMED_DISTRICTS.find((rule) => rule.pattern.test(text))?.name ?? null;
}

/** "dưới 500k" / "500.000" / "500000" / "1tr" / "1 triệu" -> VND integer. */
function parseBudget(text) {
  const millions = text.match(/(\d+(?:[.,]\d+)?)\s*(?:tr\b|trieu\b)/);
  if (millions) {
    return Math.round(Number(millions[1].replace(',', '.')) * 1000000);
  }
  const thousands = text.match(/(\d+(?:[.,]\d+)?)\s*k\b/);
  if (thousands) {
    return Math.round(Number(thousands[1].replace(',', '.')) * 1000);
  }
  const grouped = text.match(/\b(\d{1,3}(?:[.,]\d{3})+)\b/);
  if (grouped) {
    return Number(grouped[1].replace(/[.,]/g, ''));
  }
  const plain = text.match(/\b(\d{4,})\b/);
  return plain ? Number(plain[1]) : null;
}

function parseDate(text) {
  if (/\bhom nay\b/.test(text)) {
    return todayISO();
  }
  return /\bmai\b/.test(text) ? addDaysISO(todayISO(), 1) : null;
}

function describeDate(date) {
  if (date === todayISO()) {
    return 'hôm nay';
  }
  return date === addDaysISO(todayISO(), 1) ? 'ngày mai' : `ngày ${date.split('-').reverse().join('/')}`;
}

/** ['a', 'b', 'c'] -> 'a, b và c', so the reply reads as one natural sentence. */
function joinVi(parts) {
  if (parts.length <= 1) {
    return parts.join('');
  }
  return `${parts.slice(0, -1).join(', ')} và ${parts[parts.length - 1]}`;
}

/*
 * The caller echoes its own criteria back at us, so a value can be anything JSON
 * carries. These are the keys buildReply renders: one of the wrong shape is dropped
 * instead of reaching String.split or a template. Keys the parser does not know are
 * left alone, so a client can still carry its own state through.
 */
const CRITERIA_GUARDS = {
  category: (value) => typeof value === 'string',
  district: (value) => typeof value === 'string',
  date: isISODate,
  time_from: isHHMM,
  price_max: (value) => Number.isFinite(value),
};

function usableCriteria(criteria) {
  if (criteria === null || typeof criteria !== 'object' || Array.isArray(criteria)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(criteria).filter(
      ([key, value]) => !Object.hasOwn(CRITERIA_GUARDS, key) || CRITERIA_GUARDS[key](value),
    ),
  );
}

/** One sentence: what was understood, and what is still missing. */
function buildReply(criteria) {
  const understood = [];
  if (criteria.category) {
    understood.push(`dịch vụ ${categoryLabel(criteria.category).toLowerCase()}`);
  }
  if (criteria.district) {
    understood.push(`khu vực ${criteria.district}`);
  }
  if (criteria.price_max) {
    understood.push(`ngân sách dưới ${formatVnd(criteria.price_max)}`);
  }
  const window = criteria.time_from ? ` buổi ${windowLabel(criteria.time_from)}` : '';
  if (criteria.date) {
    understood.push(`vào ${describeDate(criteria.date)}${window}`);
  } else if (window) {
    understood.push(window.trim());
  }

  const missing = MISSING_RULES.filter((rule) => criteria[rule.key] == null).map(
    (rule) => rule.label,
  );

  if (understood.length === 0) {
    return `Mình chưa nhận ra tiêu chí nào trong tin nhắn, bạn cho mình biết ${joinVi(missing)} nhé.`;
  }
  if (missing.length === 0) {
    return `Mình đã hiểu bạn đang tìm ${understood.join(', ')} và đã đủ thông tin để gợi ý salon phù hợp.`;
  }
  return `Mình đã hiểu bạn đang tìm ${understood.join(', ')}, bạn cho mình biết thêm ${joinVi(missing)} để mình gợi ý chính xác hơn nhé.`;
}

router.post('/assistant', (req, res, next) => {
  try {
    const { message, criteria } = req.body ?? {};
    if (typeof message !== 'string' || message.trim() === '') {
      throw httpError(400, 'VALIDATION_ERROR', 'Vui lòng nhập nội dung bạn muốn tìm.');
    }

    const text = normalize(message);
    const parsed = {};

    const category = CATEGORY_RULES.find((rule) => rule.pattern.test(text));
    if (category) {
      parsed.category = category.key;
    }

    const district = parseDistrict(text);
    if (district) {
      parsed.district = district;
    }

    const budget = parseBudget(text);
    if (budget !== null) {
      // The criteria object doubles as the query string for GET /api/search/salons,
      // where the parameter is price_max; `budget` is kept as the human-facing alias.
      parsed.price_max = budget;
      parsed.budget = budget;
    }

    const date = parseDate(text);
    if (date) {
      parsed.date = date;
    }

    const window = TIME_WINDOWS.find((rule) => rule.pattern.test(text));
    if (window) {
      parsed.time_from = window.time_from;
      parsed.time_to = window.time_to;
    }

    // Parsed values win; every other usable key the caller was holding survives.
    const merged = { ...usableCriteria(criteria), ...parsed };
    const chips = CHIP_RULES.filter((rule) => merged[rule.key] == null)
      .slice(0, MAX_CHIPS)
      .map((rule) => rule.chip);

    res.json({ success: true, data: { reply: buildReply(merged), criteria: merged, chips } });
  } catch (error) {
    next(error);
  }
});

router.get('/suggestions', async (req, res, next) => {
  try {
    const chips = [
      ...(await selectTopCategories.all()).map((row) => categoryLabel(row.category)),
      ...(await selectTopDistricts.all()).map((row) => row.district),
    ];
    res.json({ success: true, data: { chips } });
  } catch (error) {
    next(error);
  }
});

export default router;
