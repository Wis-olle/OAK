// Public salon browsing: list, profile, photos, services, staff, reviews.
import express from 'express';
import { db } from '../db.js';
import {
  SALON_CARD_COLUMNS,
  SERVICE_CARD_COLUMNS,
  toSalonCard,
  toServiceCard,
} from '../lib/cards.js';
import { parseJsonArray, parsePagination } from '../lib/query.js';
import { SOCIAL_PROFILE_PLATFORMS } from '../lib/social-profile.js';
import { bestMatchTier, countMatchedTokens, searchTokens } from '../lib/text.js';
import { httpError } from '../middleware/auth.js';

const router = express.Router();

const DEFAULT_LIMIT = 12;
// A name search is filtered in JS, so the rows it reads are capped first. The cap sits far
// above the number of salons the platform holds, so meta.total still counts every match.
// Past ~100 verified salons a match below the cap becomes unreachable and meta.total
// under-reports; that is when q moves onto a normalized search_text column (or unaccent)
// in SQL, and not before — the extra column is not worth carrying at this size.
const CANDIDATE_LIMIT = 100;
const REVIEW_LIMIT = 10;
const RATING_VALUES = [5, 4, 3, 2, 1];

// Sort keys are looked up in this table, never concatenated from the query string.
// NULLS LAST: a salon with no reviews has a NULL rating, and Postgres would otherwise
// put NULLs first on DESC (SQLite put them last).
const SORTS = {
  rating: 'rating DESC NULLS LAST, review_count DESC, s.id',
  popular: '(SELECT COUNT(*) FROM bookings b WHERE b.salon_id = s.id) DESC, s.id',
  newest: 's.id DESC', // id is identity-generated, so descending id is newest first.
};
const DEFAULT_SORT = 's.featured DESC, s.flagship DESC, s.id';

const SALON_DETAIL_COLUMNS = `
  ${SALON_CARD_COLUMNS},
  s.description, s.phone, s.open_time, s.close_time, s.featured, s.flagship, s.amenities,
  s.tour_url, s.created_at, s.cancel_cutoff_hours, s.cancel_policy_text
`;

const selectSalonById = db.prepare(`SELECT ${SALON_DETAIL_COLUMNS} FROM salons s WHERE s.id = ?`);
const selectSalonBySlug = db.prepare(
  `SELECT ${SALON_DETAIL_COLUMNS} FROM salons s WHERE s.slug = ?`,
);
const selectSalonExists = db.prepare('SELECT 1 FROM salons WHERE id = ?');

const selectSalonHours = db.prepare(`
  SELECT weekday, "start" AS start, "end" AS end, is_off
  FROM salon_hours WHERE salon_id = ? ORDER BY weekday
`);
const selectSalonSocialLinks = db.prepare(
  'SELECT platform, url FROM salon_social_links WHERE salon_id = ? ORDER BY platform',
);

async function socialLinksForSalon(salonId) {
  const links = Object.fromEntries(SOCIAL_PROFILE_PLATFORMS.map((platform) => [platform, null]));
  for (const row of await selectSalonSocialLinks.all(salonId)) {
    links[row.platform] = row.url;
  }
  return links;
}

const selectPhotos = db.prepare(
  'SELECT id, image, caption, sort FROM salon_photos WHERE salon_id = ? ORDER BY sort, id',
);

const selectSalonStaff = db.prepare(`
  SELECT id, name, title, specialty, image, rating, years_experience
  FROM staff
  WHERE salon_id = ? AND active = 1
  ORDER BY rating DESC, id
`);

const REVIEW_SOURCE = `
  FROM reviews r
  LEFT JOIN users u ON u.id = r.user_id
  LEFT JOIN staff st ON st.id = r.staff_id
  LEFT JOIN services sv ON sv.id = r.service_id
`;

// Sort keys are looked up in this table, never concatenated from the query string.
const REVIEW_SORTS = {
  newest: 'r.created_at DESC, r.id DESC',
  lowest: 'r.rating ASC, r.created_at DESC, r.id DESC',
};
const DEFAULT_REVIEW_SORT = REVIEW_SORTS.newest;

// Both computed over every review of the salon, not just the page being served.
const selectReviewSummary = db.prepare(
  'SELECT COUNT(*) AS total, ROUND(AVG(rating), 1) AS average FROM reviews WHERE salon_id = ?',
);
const selectReviewBreakdown = db.prepare(
  'SELECT rating, COUNT(*) AS count FROM reviews WHERE salon_id = ? GROUP BY rating',
);

/** A query-string filter value, or null when it is absent or not a plain string. */
function filterValue(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Resolve a :id path segment to an existing salon id, or 404. */
async function salonIdOrThrow(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || !(await selectSalonExists.get(id))) {
    throw httpError(404, 'NOT_FOUND', 'Không tìm thấy salon này.');
  }
  return id;
}

async function toSalonProfile(row) {
  return {
    ...toSalonCard(row),
    description: row.description,
    phone: row.phone,
    // The pair is the whole-week summary of `hours`, kept for the older consumers.
    open_time: row.open_time,
    close_time: row.close_time,
    hours: await selectSalonHours.all(row.id),
    featured: Boolean(row.featured),
    flagship: Boolean(row.flagship),
    amenities: parseJsonArray(row.amenities),
    tour_url: row.tour_url,
    social_links: await socialLinksForSalon(row.id),
    // What this salon promises about cancelling, so salon-profile.html and the wizard say
    // its window rather than the platform default.
    cancel_cutoff_hours: row.cancel_cutoff_hours,
    cancel_policy_text: row.cancel_policy_text,
    created_at: row.created_at,
  };
}

router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, DEFAULT_LIMIT);
    // Every salon is verified on creation (auth.js) and a boot-time backfill (db.js) lifted
    // the older rows, so this matches every row today. It stays as the one switch that would
    // take a salon off the public list if a real verification flow ever returns.
    // published is the switch that does bite: a salon signs up unlisted and its owner turns
    // it on from the console once the profile is worth showing. GET /:idOrSlug below is
    // deliberately left open to anyone holding the link — not just the owner — because that
    // is what makes the console's "xem trước" preview a plain page load with no second code
    // path. A draft is reachable only by a slug nothing public links to.
    const conditions = ['s.verified = 1', 's.published = 1'];
    const params = [];

    const q = filterValue(req.query.q);

    const city = filterValue(req.query.city);
    if (city) {
      conditions.push('s.city = ?');
      params.push(city);
    }

    const district = filterValue(req.query.district);
    if (district) {
      conditions.push('s.district = ?');
      params.push(district);
    }

    const category = filterValue(req.query.category);
    if (category) {
      conditions.push(
        'EXISTS (SELECT 1 FROM services sv WHERE sv.salon_id = s.id AND sv.active = 1 AND sv.category = ?)',
      );
      params.push(category);
    }

    if (req.query.featured === '1') {
      conditions.push('s.featured = 1');
    }
    if (req.query.flagship === '1') {
      conditions.push('s.flagship = 1');
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const order = Object.hasOwn(SORTS, req.query.sort) ? SORTS[req.query.sort] : DEFAULT_SORT;

    // The name is matched in JS rather than with ILIKE, which compares diacritics and would
    // answer 'noi mi' with an empty page; the helper strips them on both sides. Only the
    // name — this list is the wizard's salon picker, not the search page, which also reads
    // districts and service names — but the same best-tier rule, so "nail quận 1" answers
    // with the nail salons instead of nothing.
    if (q) {
      const tokens = searchTokens(q);
      const candidates = await db
        .prepare(`SELECT ${SALON_CARD_COLUMNS} FROM salons s ${where} ORDER BY ${order} LIMIT ?`)
        .all(...params, CANDIDATE_LIMIT);
      const matched = bestMatchTier(
        candidates
          .map((row) => ({ ...row, matched_tokens: countMatchedTokens(tokens, [row.name]) }))
          .filter((row) => row.matched_tokens > 0),
      );
      res.json({
        success: true,
        data: matched.slice(offset, offset + limit).map(toSalonCard),
        meta: { page, limit, total: matched.length },
      });
      return;
    }

    const { total } = await db
      .prepare(`SELECT COUNT(*) AS total FROM salons s ${where}`)
      .get(...params);
    const rows = await db
      .prepare(
        `SELECT ${SALON_CARD_COLUMNS} FROM salons s ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);

    res.json({ success: true, data: rows.map(toSalonCard), meta: { page, limit, total } });
  } catch (error) {
    next(error);
  }
});

// The /:id/... routes are declared before /:idOrSlug so the slug route can never
// swallow a more specific path.
router.get('/:id/photos', async (req, res, next) => {
  try {
    const photos = await selectPhotos.all(await salonIdOrThrow(req.params.id));
    res.json({ success: true, data: photos, meta: { total: photos.length } });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/services', async (req, res, next) => {
  try {
    const conditions = ['sv.salon_id = ?', 'sv.active = 1'];
    const params = [await salonIdOrThrow(req.params.id)];

    const category = filterValue(req.query.category);
    if (category) {
      conditions.push('sv.category = ?');
      params.push(category);
    }

    // sv.featured is deliberately no longer a sort key here: the salon sets the order of
    // its own menu from the console (services.sort_order), and a hidden second key would
    // silently override what it arranged. The column is still read as a card flag.
    const rows = await db
      .prepare(
        `SELECT ${SERVICE_CARD_COLUMNS}
         FROM services sv
         JOIN salons s ON s.id = sv.salon_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY sv.sort_order, sv.name`,
      )
      .all(...params);

    res.json({ success: true, data: rows.map(toServiceCard), meta: { total: rows.length } });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/staff', async (req, res, next) => {
  try {
    const rows = await selectSalonStaff.all(await salonIdOrThrow(req.params.id));
    res.json({ success: true, data: rows, meta: { total: rows.length } });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/reviews', async (req, res, next) => {
  try {
    const salonId = await salonIdOrThrow(req.params.id);
    const { page, limit, offset } = parsePagination(req.query, REVIEW_LIMIT);

    // average and breakdown answer for every review of the salon; the rating filter below
    // narrows the list and meta.total only, so the distribution bars keep their scale
    // while one of them is being read.
    const summary = await selectReviewSummary.get(salonId);
    const counts = new Map(
      (await selectReviewBreakdown.all(salonId)).map((row) => [row.rating, row.count]),
    );
    const breakdown = Object.fromEntries(
      RATING_VALUES.map((value) => [value, counts.get(value) ?? 0]),
    );

    const conditions = ['r.salon_id = ?'];
    const params = [salonId];

    const rating = Number.parseInt(req.query.rating, 10);
    if (RATING_VALUES.includes(rating)) {
      conditions.push('r.rating = ?');
      params.push(rating);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const order = Object.hasOwn(REVIEW_SORTS, req.query.sort)
      ? REVIEW_SORTS[req.query.sort]
      : DEFAULT_REVIEW_SORT;

    const { total } = await db
      .prepare(`SELECT COUNT(*) AS total ${REVIEW_SOURCE} ${where}`)
      .get(...params);
    const rows = await db
      .prepare(
        `SELECT r.id, r.rating, r.comment, r.created_at, r.reply_text, r.reply_at,
                u.name AS user_name, u.avatar AS user_avatar,
                st.name AS staff_name, sv.name AS service_name
         ${REVIEW_SOURCE} ${where}
         ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);

    res.json({
      success: true,
      data: rows.map((row) => ({
        id: row.id,
        rating: row.rating,
        comment: row.comment,
        created_at: row.created_at,
        user: { name: row.user_name, avatar: row.user_avatar },
        staff: row.staff_name ? { name: row.staff_name } : null,
        service_name: row.service_name ?? null,
        // The salon's public answer, shown indented under the comment it answers. Null
        // until the owner writes one, and null again if they take it back down.
        reply: row.reply_text ? { text: row.reply_text, at: row.reply_at } : null,
      })),
      meta: {
        page,
        limit,
        total,
        all_total: summary.total,
        average: summary.average ?? 0,
        breakdown,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Open on purpose, drafts included: see the note in GET / above. The listing, the search
// and the map are what published = 1 gates; this route is the preview link behind it.
router.get('/:idOrSlug', async (req, res, next) => {
  try {
    const { idOrSlug } = req.params;
    const row = /^\d+$/.test(idOrSlug)
      ? await selectSalonById.get(Number(idOrSlug))
      : await selectSalonBySlug.get(idOrSlug);

    if (!row) {
      throw httpError(404, 'NOT_FOUND', 'Không tìm thấy salon này.');
    }
    res.json({ success: true, data: await toSalonProfile(row) });
  } catch (error) {
    next(error);
  }
});

export default router;
