// Public service catalogue: list, detail, availability, staff, categories.
import express from 'express';
import { db } from '../db.js';
import { SERVICE_CARD_COLUMNS, toServiceCard } from '../lib/cards.js';
import { getServiceSlots } from '../lib/availability.js';
import { parsePagination } from '../lib/query.js';
import { isISODate } from '../lib/time.js';
import { httpError } from '../middleware/auth.js';

const router = express.Router();

const DEFAULT_LIMIT = 12;

// The six categories the schema allows, in display order, with Vietnamese labels.
const CATEGORIES = [
  { key: 'nail', label: 'Nail' },
  { key: 'hair', label: 'Tóc' },
  { key: 'skincare', label: 'Chăm sóc da' },
  { key: 'spa', label: 'Spa & Massage' },
  { key: 'eyelash', label: 'Nối mi' },
  { key: 'amenity', label: 'Tiện ích' },
];

// Sort keys are looked up in this table, never concatenated from the query string.
// NULLS LAST on rating: Postgres puts NULLs first on DESC, SQLite put them last.
const SORTS = {
  popular: '(SELECT COUNT(*) FROM bookings b WHERE b.service_id = sv.id) DESC, sv.id',
  price_asc: 'sv.price ASC, sv.id',
  price_desc: 'sv.price DESC, sv.id',
  rating:
    '(SELECT ROUND(AVG(r.rating), 1) FROM reviews r WHERE r.salon_id = s.id) DESC NULLS LAST, sv.id',
};
const DEFAULT_SORT = 'sv.featured DESC, sv.id';

const SERVICE_SOURCE = 'FROM services sv JOIN salons s ON s.id = sv.salon_id';

const selectServiceDetail = db.prepare(`
  SELECT ${SERVICE_CARD_COLUMNS}, sv.featured, sv.is_package,
         s.address AS salon_address, s.image AS salon_image,
         s.open_time AS salon_open_time, s.close_time AS salon_close_time,
         (SELECT ROUND(AVG(r.rating), 1) FROM reviews r WHERE r.salon_id = s.id) AS salon_rating,
         (SELECT COUNT(*) FROM reviews r WHERE r.salon_id = s.id) AS salon_review_count
  ${SERVICE_SOURCE}
  WHERE sv.id = ? AND sv.active = 1
`);

// active = 1 on both public lookups: a service the salon has hidden must disappear
// from the whole customer side, not just from the listings. The partner console reads
// its own rows through partner.js and still sees hidden services.
const selectServiceExists = db.prepare('SELECT 1 FROM services WHERE id = ? AND active = 1');

const selectCategoryCount = db.prepare(
  'SELECT COUNT(*) AS count FROM services WHERE category = ? AND active = 1',
);

const selectServiceStaff = db.prepare(`
  SELECT st.id, st.name, st.title, st.specialty, st.image, st.rating, st.years_experience
  FROM staff st
  JOIN staff_services ss ON ss.staff_id = st.id
  WHERE ss.service_id = ? AND st.active = 1
  ORDER BY st.rating DESC, st.id
`);

/** A query-string filter value, or null when it is absent or not a plain string. */
function filterValue(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** A whole number from the query string, or null when the value is absent or garbage. */
function intValue(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

/** Resolve a :id path segment to an existing service id, or 404. */
async function serviceIdOrThrow(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || !(await selectServiceExists.get(id))) {
    throw httpError(404, 'NOT_FOUND', 'Không tìm thấy dịch vụ này.');
  }
  return id;
}

router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, DEFAULT_LIMIT);
    const conditions = ['sv.active = 1'];
    const params = [];

    const category = filterValue(req.query.category);
    if (category) {
      conditions.push('sv.category = ?');
      params.push(category);
    }

    const subcategory = filterValue(req.query.subcategory);
    if (subcategory) {
      conditions.push('sv.subcategory = ?');
      params.push(subcategory);
    }

    const salonId = intValue(req.query.salon_id);
    if (salonId !== null) {
      conditions.push('sv.salon_id = ?');
      params.push(salonId);
    }

    if (req.query.featured === '1') {
      conditions.push('sv.featured = 1');
    }
    if (req.query.is_package === '1') {
      conditions.push('sv.is_package = 1');
    }

    const priceMin = intValue(req.query.price_min);
    if (priceMin !== null) {
      conditions.push('sv.price >= ?');
      params.push(priceMin);
    }

    const priceMax = intValue(req.query.price_max);
    if (priceMax !== null) {
      conditions.push('sv.price <= ?');
      params.push(priceMax);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const order = Object.hasOwn(SORTS, req.query.sort) ? SORTS[req.query.sort] : DEFAULT_SORT;

    const { total } = await db
      .prepare(`SELECT COUNT(*) AS total ${SERVICE_SOURCE} ${where}`)
      .get(...params);
    const rows = await db
      .prepare(
        `SELECT ${SERVICE_CARD_COLUMNS} ${SERVICE_SOURCE} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);

    res.json({ success: true, data: rows.map(toServiceCard), meta: { page, limit, total } });
  } catch (error) {
    next(error);
  }
});

// Declared before /:id, otherwise Express matches "categories" as an id.
router.get('/categories', async (req, res, next) => {
  try {
    const data = [];
    for (const category of CATEGORIES) {
      data.push({
        key: category.key,
        label: category.label,
        count: (await selectCategoryCount.get(category.key)).count,
      });
    }
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/availability', async (req, res, next) => {
  try {
    const serviceId = await serviceIdOrThrow(req.params.id);
    const { date } = req.query;
    if (!isISODate(date)) {
      throw httpError(400, 'VALIDATION_ERROR', 'Vui lòng chọn ngày hợp lệ theo định dạng YYYY-MM-DD.');
    }
    res.json({ success: true, data: { date, slots: await getServiceSlots(serviceId, date) } });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/staff', async (req, res, next) => {
  try {
    const rows = await selectServiceStaff.all(await serviceIdOrThrow(req.params.id));
    res.json({ success: true, data: rows, meta: { total: rows.length } });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const row = /^\d+$/.test(req.params.id)
      ? await selectServiceDetail.get(Number(req.params.id))
      : null;
    if (!row) {
      throw httpError(404, 'NOT_FOUND', 'Không tìm thấy dịch vụ này.');
    }

    const card = toServiceCard(row);
    res.json({
      success: true,
      data: {
        ...card,
        featured: Boolean(row.featured),
        is_package: Boolean(row.is_package),
        salon: {
          ...card.salon,
          address: row.salon_address,
          image: row.salon_image,
          open_time: row.salon_open_time,
          close_time: row.salon_close_time,
          rating: row.salon_rating ?? 0,
          review_count: row.salon_review_count ?? 0,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
