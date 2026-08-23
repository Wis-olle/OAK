// Salon search, the rule-based Vietnamese assistant and suggestion chips.
import express from 'express';
import { db } from '../db.js';
import { hasSlotsInRange } from '../lib/availability.js';
import { SALON_CARD_COLUMNS, toSalonCard } from '../lib/cards.js';
import { haversineKm, parsePagination } from '../lib/query.js';
import { bestMatchTier, countMatchedTokens, normalize, searchTokens } from '../lib/text.js';
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
// Ranking, distance, availability and the diacritic-free q/style match are all computed
// in JS over every matching row, so the candidate set is capped before any of that runs.
// The cap sits far above the number of salons the platform holds, so meta.total still
// reports every real match.
// Past ~100 verified salons a match below the cap becomes unreachable and meta.total
// under-reports; that is when q/style move onto a normalized search_text column (or
// unaccent) in SQL, and not before — the extra column is not worth carrying at this size.
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
// No matched_tokens term: bestMatchTier() runs immediately before this sort and leaves
// only the rows that matched the most words, so every row here carries the same count.
const BY_RELEVANCE = (a, b) => b.score - a.score || b.rating - a.rating;

/**
 * The bookable services of every candidate salon, cheapest first, keyed by salon id. One
 * statement for the whole set: matching q and style reads the services of every candidate,
 * and a query per row would be up to CANDIDATE_LIMIT round trips per search.
 */
async function servicesBySalon(ids) {
  const grouped = new Map(ids.map((id) => [id, []]));
  if (ids.length === 0) {
    return grouped;
  }
  const rows = await db
    .prepare(
      `SELECT salon_id, name, subcategory, category, price
       FROM services
       WHERE salon_id IN (${ids.map(() => '?').join(',')})
         AND active = 1 AND category <> 'amenity'
       ORDER BY price ASC, id ASC`,
    )
    .all(...ids);
  for (const row of rows) {
    grouped.get(row.salon_id).push(row);
  }
  return grouped;
}

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

/*
 * Scoring and the quoted service read the same query words the filter did, not the whole
 * query string: "noi mi quan 3" matches "Nối mi Classic" on two of its words, and a
 * whole-string compare would score every multi-word query 0 and leave the card without
 * its "Có {dịch vụ} từ {giá}". Services arrive cheapest first, so the first service at
 * the best word count is also the "từ" price to quote.
 */
function pickMatchedService(services, category, queryTokens) {
  if (category) {
    const hit = services.find((service) => service.category === category);
    if (hit) {
      return hit;
    }
  }
  let best = null;
  let bestCount = 0;
  for (const service of services) {
    const count = countMatchedTokens(queryTokens, [service.name]);
    if (count > bestCount) {
      best = service;
      bestCount = count;
    }
  }
  return best;
}

function matchScore(card, services, queryTokens, category) {
  let score = 0;
  if (countMatchedTokens(queryTokens, [card.name]) > 0) {
    score += NAME_MATCH_SCORE;
  }
  if (services.some((service) => countMatchedTokens(queryTokens, [service.name]) > 0)) {
    score += SERVICE_MATCH_SCORE;
  }
  if (countMatchedTokens(queryTokens, [card.district]) > 0) {
    score += DISTRICT_MATCH_SCORE;
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

    // q and style are matched in JS over the loaded candidates, not here.
    if (category) {
      conditions.push(
        'EXISTS (SELECT 1 FROM services sv WHERE sv.salon_id = s.id AND sv.active = 1 AND sv.category = ?)',
      );
      params.push(category);
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

    // Matched here rather than in SQL, where ILIKE compares diacritics and answers 'noi mi'
    // with an empty page. The schema has no style column either, so a style stays free text
    // over the service subcategory and name ("Nail art", "Uốn xoăn lơi Hàn Quốc", ...).
    // Both read the bookable services only: an amenity row ("Phòng VIP riêng tư") is a
    // facility, not something a customer searches for by name.
    const queryTokens = q ? searchTokens(q) : [];
    const styleTokens = style ? searchTokens(style) : [];
    const servicesFor = await servicesBySalon(rows.map((row) => row.id));
    const candidates = [];
    for (const row of rows) {
      const card = toSalonCard(row);
      const services = servicesFor.get(row.id);
      // Per service, not over all of them at once: "sơn mi" has to be one service, not
      // "Sơn gel" plus "Nối mi" — the same single row the SQL EXISTS used to require.
      // Within one service the subcategory and the name are read as one text, which is
      // wider than the old `sv.subcategory ILIKE ? OR sv.name ILIKE ?`: a style may now
      // straddle the two columns ("Nail art" / "Vẽ móng" answers style='nail ve').
      // Deliberate — a style is free text and a customer does not know which column a
      // word lives in.
      if (
        styleTokens.length > 0 &&
        !services.some(
          (sv) => countMatchedTokens(styleTokens, [sv.subcategory, sv.name]) === styleTokens.length,
        )
      ) {
        continue;
      }
      const matchedTokens = countMatchedTokens(queryTokens, [
        card.name,
        card.district,
        ...services.map((sv) => sv.name),
      ]);
      if (queryTokens.length > 0 && matchedTokens === 0) {
        continue;
      }
      candidates.push({
        ...card,
        distance_km: haversineKm(lat, lng, row.lat, row.lng),
        matched_tokens: matchedTokens,
        score: matchScore(card, services, queryTokens, category),
        matched_service: pickMatchedService(services, category, queryTokens),
      });
    }

    let filtered = candidates
      // A radius cannot filter anything when the caller gave no position to measure from.
      .filter((item) => radiusKm === null || item.distance_km === null || item.distance_km <= radiusKm)
      .filter((item) => ratingMin === null || item.rating >= ratingMin);

    // A date the caller asked for is part of matching, so it has to narrow the set before the
    // page slice — meta.total comes from filtered.length. It runs last of the filters and only
    // over what the cheap ones left, because each call fans out into a query per service.
    if (date) {
      // Today only has the hours it has left: POST /api/bookings refuses an hour that has
      // already started, so a salon whose last free slot was this morning is not a match at
      // 21:00 — offering it would send the customer into a wizard that cannot finish.
      // 'HH:MM' is zero-padded, so the later of the two is a plain string comparison.
      const now = fromMinutes(nowMinutes());
      const effectiveFrom =
        date === todayISO() ? (timeFrom && timeFrom > now ? timeFrom : now) : timeFrom;
      const withSlots = [];
      for (const item of filtered) {
        if (await hasSlotsInRange(item.id, date, effectiveFrom, timeTo)) {
          withSlots.push(item);
        }
      }
      filtered = withSlots;
    }

    // Only the salons that matched the most words of the query, and taken last so a filter
    // above can never leave an empty page while a weaker match that clears every filter is
    // still standing. Matching every word is the top tier when some salon does; when none
    // does, the best partial tier answers instead of nothing — no service is called "làm",
    // so "lam nail" has to survive on "nail" — and the weaker tiers are dropped rather than
    // padding the page below the real answer. meta.total counts the tier that is shown.
    filtered = bestMatchTier(filtered);

    const comparator = Object.hasOwn(SORTS, req.query.sort) ? SORTS[req.query.sort] : BY_RELEVANCE;
    filtered.sort(comparator);

    const slotLabel = date ? [windowLabel(timeFrom), dayLabel(date)].filter(Boolean).join(' ') : '';
    const data = [];
    for (const item of filtered.slice(offset, offset + limit)) {
      const { score, matched_tokens: matched, matched_service: matchedService, ...card } = item;
      const result = {
        ...card,
        // Resolved above, where it did the filtering: every survivor of a dated search has a
        // free slot, and slotLabel is empty when no date was asked for.
        match_reason: buildMatchReason(card, item.distance_km, matchedService, slotLabel),
      };
      if (date) {
        result.availability = true;
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

/*
 * "trong bán kính 3km" / "cách 1.5 km" -> a radius in km. Kept as a named pattern
 * because the budget rule below also has to be able to take these digits out of its
 * own way: "3km" is a distance, never 3.000đ.
 */
const RADIUS_PATTERN = /(\d+(?:[.,]\d+)?)\s*km\b/;

function parseRadius(text) {
  const match = text.match(RADIUS_PATTERN);
  return match ? Number(match[1].replace(',', '.')) : null;
}

/** "đánh giá từ 4.5 sao" / "4 sao trở lên" -> a minimum rating. */
function parseRating(text) {
  const match = text.match(/(\d(?:[.,]\d)?)\s*sao\b/);
  return match ? Number(match[1].replace(',', '.')) : null;
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

    // Distance and rating are read before the budget, and the matched distance is taken
    // out of the text the budget rule sees, so "3km" can never become a price.
    const radiusKm = parseRadius(text);
    if (radiusKm !== null) {
      parsed.radius_km = radiusKm;
    }

    const rating = parseRating(text);
    if (rating !== null) {
      parsed.rating_min = rating;
    }

    const budget = parseBudget(text.replace(RADIUS_PATTERN, ' '));
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
