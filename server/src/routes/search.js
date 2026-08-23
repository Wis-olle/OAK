// Salon search, the rule-based Vietnamese assistant and suggestion chips.
import express from 'express';
import { db } from '../db.js';
import { hasSlotsInRange } from '../lib/availability.js';
import { SALON_CARD_COLUMNS, toSalonCard } from '../lib/cards.js';
import { CITY_DISTRICTS } from '../lib/locations.js';
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
      `SELECT id, salon_id, name, subcategory, category, price
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

// Same switches as the two queries below: a category counted from drafts would offer a chip
// that lands the reader on fewer salons than the number promised.
const selectTopCategories = db.prepare(`
  SELECT sv.category AS category, COUNT(*) AS count
  FROM services sv JOIN salons s ON s.id = sv.salon_id
  WHERE sv.active = 1 AND sv.category <> 'amenity' AND s.verified = 1 AND s.published = 1
  GROUP BY sv.category
  ORDER BY count DESC, sv.category
  LIMIT 3
`);

// Same switches as selectDistrictSalonCount below and as the results page: a district
// counted from drafts would be offered as the alternative and land the reader on nothing.
const selectTopDistricts = db.prepare(`
  SELECT district, COUNT(*) AS count
  FROM salons
  WHERE verified = 1 AND published = 1 AND district IS NOT NULL
  GROUP BY district
  ORDER BY count DESC, district
  LIMIT 2
`);

// Does the assistant have anything at all to offer in this district?
const selectDistrictSalonCount = db.prepare(
  'SELECT COUNT(*) AS count FROM salons WHERE verified = 1 AND published = 1 AND district = ?',
);

/**
 * How many salons the district, the category and the free keyword add up to — the three
 * filters GET /api/search/salons applies, matched here by the same rules, so the number
 * the assistant says is the number the page it hands the reader to shows. A date, a budget
 * or a rating narrows that page further, which is why buildReply names what it counted
 * rather than calling the number a count of every match.
 *
 * null when none of the three is known: that count is every verified salon on the
 * platform, which answers no question anybody asked.
 */
async function countMatchingSalons(criteria) {
  const queryTokens = typeof criteria.q === 'string' ? searchTokens(criteria.q) : [];
  if (
    queryTokens.length === 0 &&
    typeof criteria.district !== 'string' &&
    typeof criteria.category !== 'string'
  ) {
    return null;
  }
  const conditions = ['s.verified = 1', 's.published = 1'];
  const params = [];
  if (typeof criteria.district === 'string') {
    conditions.push('s.district = ?');
    params.push(criteria.district);
  }
  if (typeof criteria.category === 'string') {
    conditions.push(
      `EXISTS (SELECT 1 FROM services sv
        WHERE sv.salon_id = s.id AND sv.active = 1 AND sv.category = ?)`,
    );
    params.push(criteria.category);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const ratingMin = Number.isFinite(criteria.rating_min) ? criteria.rating_min : null;
  if (queryTokens.length === 0 && ratingMin === null) {
    const row = await db.prepare(`SELECT COUNT(*) AS count FROM salons s ${where}`).get(...params);
    return row.count;
  }
  // The keyword is matched in JS over the loaded rows, exactly as GET /api/search/salons
  // does it — same candidate cap, same texts, same best-tier cut — because a keyword no
  // salon carries empties that page, and a number that ignored it would promise results
  // the next screen does not have.
  const rows = await db
    .prepare(`SELECT ${SALON_CARD_COLUMNS} FROM salons s ${where} ORDER BY s.id LIMIT ?`)
    .all(...params, CANDIDATE_LIMIT);
  const servicesFor = await servicesBySalon(rows.map((row) => row.id));
  const matched = rows
    .map((row) => {
      const card = toSalonCard(row);
      return {
        rating: card.rating,
        matched_tokens: countMatchedTokens(queryTokens, [
          card.name,
          card.district,
          ...servicesFor.get(row.id).map((service) => service.name),
        ]),
      };
    })
    // The rating is a subquery on the card, so a bare COUNT cannot see it — which is why
    // this branch also runs when only a rating was asked for.
    .filter((item) => ratingMin === null || item.rating >= ratingMin)
    .filter((item) => queryTokens.length === 0 || item.matched_tokens > 0);
  return queryTokens.length === 0 ? matched.length : bestMatchTier(matched).length;
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

/**
 * "Nối mi từ 350.000đ" — the words that make a swapped `price_from` readable, on the card's
 * meta line and on the map pin, where nothing else says which service the number belongs to.
 * Null for a service whose category has no label to put in front (an amenity a keyword hit),
 * because "từ 350.000đ" on its own is still true of that service.
 */
function priceFromLabel(service) {
  const label = CATEGORY_LABELS[service.category];
  return label ? `${label} từ ${formatVnd(service.price)}` : null;
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

    // Same switches as GET /api/salons: verified excludes nothing today, published keeps a
    // salon that has not finished setting itself up off the results page and the map.
    const conditions = ['s.verified = 1', 's.published = 1'];
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
    // A budget belongs to what the customer asked for: "tóc dưới 300.000đ" must not be
    // answered with a salon whose nails are cheap and whose hair is not. Only a category
    // narrows it here — a bare keyword is matched in JS below, where this cannot reach.
    if (priceMax !== null) {
      conditions.push(`EXISTS (SELECT 1 FROM services sv
        WHERE sv.salon_id = s.id AND sv.active = 1 AND sv.category <> 'amenity' AND sv.price <= ?
          ${category ? 'AND sv.category = ?' : ''})`);
      params.push(priceMax);
      if (category) {
        params.push(category);
      }
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
      const matchedService = pickMatchedService(services, category, queryTokens);
      // The budget the SQL applied to a bare keyword is "anything in this salon is cheap
      // enough", which is not what the card goes on to quote: it quotes the service the
      // keyword matched. Without this, "nail dưới 200.000đ" answers with a card reading
      // "từ 450.000đ". The category branch is already narrowed inside the SQL EXISTS; this
      // is the same rule for the branch that could not reach it.
      if (
        priceMax !== null &&
        !category &&
        queryTokens.length > 0 &&
        matchedService &&
        matchedService.price > priceMax
      ) {
        continue;
      }
      // The "from" price of a salon is the cheapest thing it sells, which is the wrong
      // number to quote once the customer named what they came for: on a hair search the
      // card has to say what the hair costs. Taken before the price sort below, so the
      // ranking reads the same number the card does.
      const quotesService = Boolean((category || q) && matchedService);
      candidates.push({
        ...card,
        price_from: quotesService ? matchedService.price : card.price_from,
        // A swapped number needs the words that make it true: a bare "từ 350.000đ" beside a
        // salon states the salon's opening price, which this no longer is. Null whenever the
        // salon's own floor is quoted, and the surfaces fall back to the bare wording.
        price_from_label: quotesService ? priceFromLabel(matchedService) : null,
        distance_km: haversineKm(lat, lng, row.lat, row.lng),
        matched_tokens: matchedTokens,
        score: matchScore(card, services, queryTokens, category),
        matched_service: matchedService,
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
        // The service the search matched, so the card's booking link can open the wizard on
        // it instead of dropping the customer back at "which service?".
        matched_service: matchedService
          ? {
              id: matchedService.id,
              name: matchedService.name,
              price: matchedService.price,
              category: matchedService.category,
            }
          : null,
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

/*
 * Every named (non-numbered) district of the three cities the product serves, matched on
 * the distinctive part of its name: "Quận Bình Thạnh" is asked for as "bình thạnh". Read
 * out of lib/locations.js, which the profile form and PATCH /api/users/me already share,
 * so a district added there is understood here without a second edit. Longest key first,
 * so a shorter neighbour can never answer for a longer name.
 */
const NAMED_DISTRICTS = Object.values(CITY_DISTRICTS)
  .flat()
  .filter((name) => !/\d/.test(name))
  .map((name) => ({ name, key: normalize(name).replace(/^(?:quan|huyen)\s+/, '') }))
  .sort((first, second) => second.key.length - first.key.length)
  .map(({ name, key }) => ({ name, pattern: new RegExp(`\\b${key}\\b`) }));

/** The city a district belongs to, or null when lib/locations.js does not name it. */
function cityOfDistrict(district) {
  const city = Object.keys(CITY_DISTRICTS).find((name) => CITY_DISTRICTS[name].includes(district));
  return city ?? null;
}

/*
 * The scaffolding of a spoken request — pronouns, the verbs a service name rides behind,
 * the words around a place or a price — and the units the numeric rules leave behind.
 * Whatever survives all of it is a salon name or a free keyword, which is the one thing
 * the rules cannot recognise and the results page can.
 */
const STOP_WORDS = new Set([
  'a', 'anh', 'ban', 'buoi', 'ca', 'can', 'cat', 'cham', 'chi', 'cho', 'chua', 'co', 'cua',
  'cuoi', 'dang', 'danh', 'dat', 'den', 'dep', 'di', 'dong', 'duoi', 'duong', 'em', 'gan',
  'gi', 'gia', 'giup', 'goi', 'hay', 'hen', 'hoac', 'hom', 'huyen', 'k', 'khoang', 'khong',
  'khu', 'kiem', 'kinh', 'km', 'la', 'lam', 'lich', 'luc', 'mai', 'minh', 'muon', 'nao',
  'nay', 'ngan', 'ngay', 'nhe', 'nhuom', 'noi', 'o', 'oi', 'phuong', 'q', 'quan', 'sach',
  'sao', 'se', 'soc', 'son', 'tai', 'tam', 'the', 'tiem', 'tim', 'toi', 'tr', 'tren',
  'trieu', 'trong', 'tu', 'uon', 'va', 'vao', 've', 'vnd', 'voi', 'vuc', 'xem',
  // The words an opening message is made of. Without them "chào bạn" leaves 'chao' and
  // "tìm salon gần đây" leaves 'salon day', and q is a hard filter: the assistant would
  // report understanding a keyword that guarantees an empty results page.
  'bao', 'chao', 'day', 'moi', 'nhieu', 'salon', 'tot',
]);

// Shorter than this a leftover is noise ("ba", "cc"), not a name worth searching on.
const MIN_KEYWORD_LENGTH = 3;

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

/*
 * The district asked for, and the pattern that found it so its words can be taken out of
 * the running for `q`. A numbered district needs no pattern: "quan" is a stop word and the
 * number is a digit, and leftoverQuery drops both anyway.
 */
function parseDistrict(text) {
  const numbered = text.match(/\bquan\s*(\d{1,2})\b/) ?? text.match(/\bq\.?\s*(\d{1,2})\b/);
  if (numbered) {
    return { name: `Quận ${Number(numbered[1])}`, pattern: null };
  }
  return NAMED_DISTRICTS.find((rule) => rule.pattern.test(text)) ?? null;
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
  q: (value) => typeof value === 'string',
  category: (value) => typeof value === 'string',
  district: (value) => typeof value === 'string',
  date: isISODate,
  time_from: isHHMM,
  price_max: (value) => Number.isFinite(value),
  rating_min: (value) => Number.isFinite(value),
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

/**
 * Whatever the rules did not claim, as the free keyword `q` the results page can still
 * search on — a salon name ("Lala"), a style, anything nobody wrote a rule for. Words a
 * rule already consumed are removed first, then the scaffolding, then every word carrying
 * a digit: a price, a rating, a radius and a district number are all read elsewhere.
 */
function leftoverQuery(text, consumed) {
  let rest = text;
  for (const pattern of consumed) {
    // Global: "nail quận 1 làm nail" must lose both, or the second one comes back as a
    // keyword narrowing a search the category filter already covers.
    rest = rest.replace(new RegExp(pattern.source, 'g'), ' ');
  }
  const words = rest
    .split(/[^a-z0-9]+/)
    // Per word, not over the joined run: "co ai o do khong" left "ai do", which is two
    // fragments, not a name — and countMatchedTokens matches a short token by containment,
    // so it would have matched nearly every salon and been quoted back as understood.
    .filter((word) => word.length >= MIN_KEYWORD_LENGTH && !/\d/.test(word) && !STOP_WORDS.has(word));
  // searchTokens is what every consumer of q tokenises with, and it caps at MAX_QUERY_TOKENS,
  // so a 27KB message cannot be reflected back into the reply and the results URL.
  const keyword = searchTokens(words.join(' ')).join(' ');
  return keyword || null;
}

/** Every criterion one message carries. Pure: the district is not checked against the data here. */
function parseAssistantMessage(message) {
  const text = normalize(message);
  const parsed = {};
  // Each rule that fires takes its own words out of the running for the free keyword.
  const consumed = [];

  const category = CATEGORY_RULES.find((rule) => rule.pattern.test(text));
  if (category) {
    parsed.category = category.key;
    consumed.push(category.pattern);
  }

  const district = parseDistrict(text);
  if (district) {
    parsed.district = district.name;
    if (district.pattern) {
      consumed.push(district.pattern);
    }
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
    consumed.push(window.pattern);
  }

  const keyword = leftoverQuery(text, consumed);
  if (keyword) {
    parsed.q = keyword;
  }
  return parsed;
}

/** One sentence: what was understood, and what is still missing. */
function buildReply(criteria, found, unserved, droppedQuery = null) {
  const understood = [];
  if (criteria.q) {
    understood.push(`từ khoá "${criteria.q}"`);
  }
  if (criteria.category) {
    understood.push(`dịch vụ ${categoryLabel(criteria.category).toLowerCase()}`);
  }
  if (criteria.district) {
    understood.push(`khu vực ${criteria.district}`);
  }
  if (criteria.price_max) {
    understood.push(`ngân sách dưới ${formatVnd(criteria.price_max)}`);
  }
  if (criteria.rating_min) {
    understood.push(`đánh giá từ ${criteria.rating_min} sao`);
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

  const sentences = [];
  // Said first and said plainly: an area OAK does not cover yet is the one fact that makes
  // every other criterion beside the point, and silently searching the whole city instead
  // is what leaves a customer counting salons that are nowhere near them.
  if (unserved) {
    const nearest = unserved.nearest.length ? `, gần nhất là ${joinVi(unserved.nearest)}` : '';
    sentences.push(`Hiện OAK chưa có salon ở ${unserved.district}${nearest}.`);
  }

  if (understood.length === 0) {
    sentences.push(
      `Mình chưa nhận ra tiêu chí nào trong tin nhắn, bạn cho mình biết ${joinVi(missing)} nhé.`,
    );
  } else if (missing.length === 0) {
    sentences.push(
      `Mình đã hiểu bạn đang tìm ${understood.join(', ')} và đã đủ thông tin để gợi ý salon phù hợp.`,
    );
  } else {
    sentences.push(
      `Mình đã hiểu bạn đang tìm ${understood.join(', ')}, bạn cho mình biết thêm ${joinVi(missing)} để mình gợi ý chính xác hơn nhé.`,
    );
  }

  // Said before the count, because it is why the count is the number it is: the word was
  // let go, so the reader is not left comparing a sentence about a keyword with a page that
  // no longer filters by one.
  if (droppedQuery) {
    sentences.push(
      `Mình chưa thấy salon nào khớp từ khoá "${droppedQuery}" nên mình tìm theo các tiêu chí còn lại.`,
    );
  }

  // Said as what it counted, not as "phù hợp": the number knows the area, the service and
  // the keyword and nothing else, so a budget, a date or a rating in the criteria narrows
  // the results page further and an unnamed count would simply read as wrong.
  if (found !== null) {
    const counted = [
      criteria.category ? categoryLabel(criteria.category).toLowerCase() : null,
      criteria.district ? `ở ${criteria.district}` : null,
      criteria.q ? `khớp "${criteria.q}"` : null,
    ]
      .filter(Boolean)
      .join(' ');
    sentences.push(`Hiện có ${found} salon ${counted}.`);
  }
  return sentences.join(' ');
}

router.post('/assistant', async (req, res, next) => {
  try {
    const { message, criteria } = req.body ?? {};
    if (typeof message !== 'string' || message.trim() === '') {
      throw httpError(400, 'VALIDATION_ERROR', 'Vui lòng nhập nội dung bạn muốn tìm.');
    }

    const parsed = parseAssistantMessage(message);

    // A district the parser understood but the platform has no salon in is dropped rather
    // than carried: as a criterion it guarantees an empty results page, and the reply says
    // so instead.
    let unserved = null;
    if (parsed.district && (await selectDistrictSalonCount.get(parsed.district)).count === 0) {
      // selectTopDistricts is city-agnostic, so a district in Đà Nẵng was being answered with
      // "gần nhất là Quận 1" — 600km away. Only districts of the same city are near.
      const sameCity = cityOfDistrict(parsed.district);
      unserved = {
        district: parsed.district,
        // Never the district being reported — an alternative that is the same place is no
        // alternative. Both queries count listed salons only, so the suggestion always has
        // something behind it. An empty list renders as just "Hiện OAK chưa có salon ở X."
        nearest: (await selectTopDistricts.all())
          .filter((row) => row.district !== parsed.district)
          .filter((row) => sameCity === null || cityOfDistrict(row.district) === sameCity)
          .map((row) => row.district),
      };
      delete parsed.district;
    }

    // Parsed values win; every other usable key the caller was holding survives.
    const merged = { ...usableCriteria(criteria), ...parsed };
    if (unserved) {
      // Including the district the conversation held before: the reader just asked to move
      // somewhere else, and keeping the old area would name two of them in one sentence
      // and go on searching the one they left.
      delete merged.district;
    }
    const chips = CHIP_RULES.filter((rule) => merged[rule.key] == null)
      .slice(0, MAX_CHIPS)
      .map((rule) => rule.chip);

    let found = await countMatchingSalons(merged);
    // A keyword no salon carries is dropped rather than carried: `q` is a hard filter on
    // GET /api/search/salons, so keeping it hands the reader the empty page the rest of the
    // reply just said had salons on it. Only when the other criteria do have salons — an
    // area or a service with nothing in it is the reader's answer, not a keyword to blame.
    let droppedQuery = null;
    if (found === 0 && typeof merged.q === 'string') {
      const withoutQuery = { ...merged };
      delete withoutQuery.q;
      const fallback = await countMatchingSalons(withoutQuery);
      if (fallback !== null && fallback > 0) {
        droppedQuery = merged.q;
        delete merged.q;
        found = fallback;
      }
    }

    res.json({
      success: true,
      data: { reply: buildReply(merged, found, unserved, droppedQuery), criteria: merged, chips },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/suggestions', async (req, res, next) => {
  try {
    // Each chip carries what it filters by, not just what it reads as: a chip labelled
    // "Spa & Massage" matches no salon or service name, so as a keyword it lands on an
    // empty page — as a category it lands on every spa.
    const chips = [
      ...(await selectTopCategories.all()).map((row) => ({
        label: categoryLabel(row.category),
        type: 'category',
        key: row.category,
      })),
      ...(await selectTopDistricts.all()).map((row) => ({
        label: row.district,
        type: 'district',
        key: row.district,
      })),
    ];
    res.json({ success: true, data: { chips } });
  } catch (error) {
    next(error);
  }
});

export default router;
