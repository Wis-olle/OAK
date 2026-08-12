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
import { httpError } from '../middleware/auth.js';

const router = express.Router();

const DEFAULT_LIMIT = 12;
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
  s.tour_url, s.created_at
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

const selectPhotos = db.prepare(
  'SELECT id, image, caption, sort FROM salon_photos WHERE salon_id = ? ORDER BY sort, id',
);

const selectSalonStaff = db.prepare(`
  SELECT id, name, title, specialty, image, rating, years_experience
  FROM staff
  WHERE salon_id = ? AND active = 1
  ORDER BY rating DESC, id
`);

const selectReviews = db.prepare(`
  SELECT r.id, r.rating, r.comment, r.created_at,
         u.name AS user_name, u.avatar AS user_avatar,
         st.name AS staff_name
  FROM reviews r
  LEFT JOIN users u ON u.id = r.user_id
  LEFT JOIN staff st ON st.id = r.staff_id
  WHERE r.salon_id = ?
  ORDER BY r.created_at DESC, r.id DESC
  LIMIT ? OFFSET ?
`);

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
    created_at: row.created_at,
  };
}

router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, DEFAULT_LIMIT);
    // Every salon is verified on creation (auth.js) and a boot-time backfill (db.js) lifted
    // the older rows, so this matches every row today. It stays as the one switch that would
    // take a salon off the public list if a real verification flow ever returns.
    const conditions = ['s.verified = 1'];
    const params = [];

    const q = filterValue(req.query.q);
    if (q) {
      conditions.push('s.name ILIKE ?');
      params.push(`%${q}%`);
    }

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

    const rows = await db
      .prepare(
        `SELECT ${SERVICE_CARD_COLUMNS}
         FROM services sv
         JOIN salons s ON s.id = sv.salon_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY sv.featured DESC, sv.category, sv.price`,
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

    const summary = await selectReviewSummary.get(salonId);
    const counts = new Map(
      (await selectReviewBreakdown.all(salonId)).map((row) => [row.rating, row.count]),
    );
    const breakdown = Object.fromEntries(
      RATING_VALUES.map((value) => [value, counts.get(value) ?? 0]),
    );

    const rows = await selectReviews.all(salonId, limit, offset);

    res.json({
      success: true,
      data: rows.map((row) => ({
        id: row.id,
        rating: row.rating,
        comment: row.comment,
        created_at: row.created_at,
        user: { name: row.user_name, avatar: row.user_avatar },
        staff: row.staff_name ? { name: row.staff_name } : null,
      })),
      meta: {
        page,
        limit,
        total: summary.total,
        average: summary.average ?? 0,
        breakdown,
      },
    });
  } catch (error) {
    next(error);
  }
});

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
