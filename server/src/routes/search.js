// Salon search and suggestion chips.
import express from 'express';
import { db } from '../db.js';
import { salonsWithSlotsInRange } from '../lib/availability.js';
import { SALON_CARD_COLUMNS, toSalonCard } from '../lib/cards.js';
import { haversineKm, parsePagination } from '../lib/query.js';
import { bestMatchTier, countMatchedTokens, searchTokens } from '../lib/text.js';
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

const router = express.Router();

const DEFAULT_LIMIT = 12;
// Ranking, distance, availability and the diacritic-free q match are all computed in JS
// over every matching row, so the candidate set is capped before any of that runs.
// The cap sits far above the number of salons the platform holds, so meta.total still
// reports every real match.
// Past ~100 verified salons a match below the cap becomes unreachable and meta.total
// under-reports; that is when q moves onto a normalized search_text column (or unaccent)
// in SQL, and not before — the extra column is not worth carrying at this size.
const CANDIDATE_LIMIT = 100;
const MAX_REASONS = 3;
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
//
// A paid 'Nổi bật' placement is the first key, and only here: the three comparators in SORTS
// are what the reader asked for by name, and a placement that outranked "rẻ nhất trước" would
// answer a question about price with an advertisement. It sits above `score` rather than
// beside it because the salons it reorders all matched the query — bestMatchTier() already
// dropped the ones that did not, so this can never push an irrelevant salon onto the page.
const BY_RELEVANCE = (a, b) =>
  Number(b.featured) - Number(a.featured) || b.score - a.score || b.rating - a.rating;

/**
 * The bookable services of every candidate salon, cheapest first, keyed by salon id. One
 * statement for the whole set: matching q reads the services of every candidate,
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

// Same switches as the query below: a category counted from drafts would offer a chip
// that lands the reader on fewer salons than the number promised.
const selectTopCategories = db.prepare(`
  SELECT sv.category AS category, COUNT(*) AS count
  FROM services sv JOIN salons s ON s.id = sv.salon_id
  WHERE sv.active = 1 AND sv.category <> 'amenity' AND s.verified = 1 AND s.published = 1
  GROUP BY sv.category
  ORDER BY count DESC, sv.category
  LIMIT 3
`);

// Same switches as the results page: a district counted from drafts would be offered as a
// chip and land the reader on nothing.
const selectTopDistricts = db.prepare(`
  SELECT district, COUNT(*) AS count
  FROM salons
  WHERE verified = 1 AND published = 1 AND district IS NOT NULL
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

    // q is matched in JS over the loaded candidates, not here.
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
    // with an empty page. It reads the bookable services only: an amenity row ("Phòng VIP
    // riêng tư") is a facility, not something a customer searches for by name.
    const queryTokens = q ? searchTokens(q) : [];
    const servicesFor = await servicesBySalon(rows.map((row) => row.id));
    const candidates = [];
    for (const row of rows) {
      const card = toSalonCard(row);
      const services = servicesFor.get(row.id);
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
    // over what the cheap ones left, and it asks about all of them in one breath: the day's
    // calendars are read for every surviving salon at once (lib/availability.js), so this
    // costs a handful of queries rather than one per technician per salon.
    if (date) {
      // Today only has the hours it has left: POST /api/bookings refuses an hour that has
      // already started, so a salon whose last free slot was this morning is not a match at
      // 21:00 — offering it would send the customer into a wizard that cannot finish.
      // 'HH:MM' is zero-padded, so the later of the two is a plain string comparison.
      const now = fromMinutes(nowMinutes());
      const effectiveFrom =
        date === todayISO() ? (timeFrom && timeFrom > now ? timeFrom : now) : timeFrom;
      const withSlots = await salonsWithSlotsInRange(
        filtered.map((item) => item.id), date, effectiveFrom, timeTo,
      );
      filtered = filtered.filter((item) => withSlots.has(item.id));
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
