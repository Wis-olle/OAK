// Public service catalogue: list, detail, availability, staff, categories.
import express from 'express';
import { db } from '../db.js';
import { SERVICE_CARD_COLUMNS, toServiceCard } from '../lib/cards.js';
import { getServiceSlots, salonSettingsForService, timeOffOn } from '../lib/availability.js';
import { parsePagination } from '../lib/query.js';
import { addDaysISO, isISODate, todayISO } from '../lib/time.js';
import { httpError } from '../middleware/auth.js';

const router = express.Router();

const DEFAULT_LIMIT = 12;

// The same window /api/staff/:id/availability allows, so a caller that offers a day strip
// for either one is bounded the same way.
const DEFAULT_DAYS = 1;
const MIN_DAYS = 1;
const MAX_DAYS = 14;

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
         s.address AS salon_address, s.image AS salon_image, s.phone AS salon_phone,
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

// Same published switch the listing applies, or the number on a category chip would promise
// services the listing behind it does not show.
const selectCategoryCount = db.prepare(`
  SELECT COUNT(*) AS count FROM services sv JOIN salons s ON s.id = sv.salon_id
  WHERE sv.category = ? AND sv.active = 1 AND s.published = 1
`);

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
    // s.published: the category pages link straight to salon-profile.html, so listing a
    // draft salon's service here would put a salon with no address or hours on the public
    // side the moment it adds its first service. selectServiceDetail below stays open for
    // the same reason GET /api/salons/:idOrSlug is — a link the owner is previewing.
    const conditions = ['sv.active = 1', 's.published = 1'];
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

/**
 * Per-day slots for one service, in the same week shape /api/staff/:id returns — `closed`
 * included, so the day strip can tell a day the salon declared off from one whose calendar
 * simply filled up. Without it the wizard struck a declared day off through as "full".
 *
 * The salon and its lead time are read once for the whole week and the day-off rows once
 * per date, then handed to getServiceSlots, so a seven-day grid asks each question once.
 */
async function getServiceWeek(serviceId, from, days) {
  const settings = await salonSettingsForService(serviceId);
  const week = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = addDaysISO(from, offset);
    const off = settings === null ? { salon: false, staff: new Set() } : await timeOffOn(settings.salon_id, date);
    week.push({
      date,
      closed: off.salon,
      slots: await getServiceSlots(serviceId, date, off, settings?.lead_time_min ?? null),
    });
  }
  return week;
}

/**
 * Two shapes, chosen by whether ?days is there at all.
 *
 * With it the answer is `{ from, week }`, which is what a day strip needs: seven days in
 * one round trip rather than seven requests. Without it the answer stays `{ date, slots }`
 * for the single ?date — every caller that predates this reads `slots` off the top level,
 * so the older form cannot move. That is also why ?days=1 still answers in the week shape:
 * the shape follows the question asked, not the size of the answer.
 */
router.get('/:id/availability', async (req, res, next) => {
  try {
    const serviceId = await serviceIdOrThrow(req.params.id);

    if (req.query.days !== undefined) {
      const from = req.query.from === undefined ? todayISO() : req.query.from;
      if (!isISODate(from)) {
        throw httpError(400, 'VALIDATION_ERROR', 'Ngày bắt đầu phải theo định dạng YYYY-MM-DD.');
      }
      const days = Math.min(
        MAX_DAYS,
        Math.max(MIN_DAYS, Number.parseInt(req.query.days, 10) || DEFAULT_DAYS),
      );
      res.json({ success: true, data: { from, week: await getServiceWeek(serviceId, from, days) } });
      return;
    }

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
          // The service page offers Gọi/Zalo from this block, the way the salon page does.
          phone: row.salon_phone,
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
