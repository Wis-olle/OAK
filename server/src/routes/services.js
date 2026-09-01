// Public service catalogue: list, detail, availability, staff, categories.
import express from 'express';
import { db } from '../db.js';
import { SERVICE_CARD_COLUMNS, toServiceCard } from '../lib/cards.js';
import { calendarServiceSlots, getServiceSlots, loadDayCalendar } from '../lib/availability.js';
import { exceptBookingIdFor } from '../lib/except-booking.js';
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

/* The booking wizard's technician picker — dat-lich.html and chi-tiet-dich-vu.html both choose
   from this list — and the whole of what a withdrawn profile does to it.

   The WHERE clause is deliberately NOT gated on staff.profile_hidden, and never may be. This
   list is operational: a technician who has taken their public page down is still working this
   week, and dropping them out of the picker would quietly take a salon's chair off sale. The
   withdrawal hides a page, never a person's shift.

   But the card is another matter. Served whole, it is the public profile in miniature — face,
   job title, speciality, rating, years in the trade — so a withdrawal that emptied the salon's
   team strip would leave the same showcase standing one click away in the wizard, which is the
   page back up under another name. So a CLAIMED row that has been hidden is reduced to what
   booking actually needs: an id and a name, enough for the customer who asks for her by name
   to pick her. Both halves of the one decision — hidden means no public showcase, and booking
   by name carries on regardless.

   Reduced here in JS rather than in SQL because the row must still come back: a predicate is
   how it would stop coming back. And CLAIMED only, the standing rule in this codebase —
   nobody stands behind an unclaimed row, so nobody has withdrawn anything from it, and its
   card is the salon's own description of a chair. st.user_id is selected to ask that question
   and never leaves this file. */
const selectServiceStaff = db.prepare(`
  SELECT st.id, st.name, st.title, st.specialty, st.image, st.rating, st.years_experience,
         st.user_id, st.profile_hidden
  FROM staff st
  JOIN staff_services ss ON ss.staff_id = st.id
  WHERE ss.service_id = ? AND st.active = 1
  ORDER BY st.rating DESC, st.id
`);

/** One picker entry: the whole card, or a name to book by when the page behind it is down. */
function pickerCard(row) {
  // The negation of VISIBLE_PROFILE in routes/staff.js, spelled the way JS spells it: an
  // unwritten flag is 0 there and falsy here, and neither is a reason to reduce anything.
  const withdrawn = row.user_id !== null && Boolean(row.profile_hidden);
  return {
    id: row.id,
    name: row.name,
    /* Whether a real account stands behind this chair, which is what the picker's ✓ chip
       marks: a name the salon typed into its roster and a technician who signed in and
       claimed it are not the same promise to a customer choosing between them. A boolean and
       never the id — user_id names an account and does not leave the server. True on a
       withdrawn row too, and that is consistent rather than a leak: the reduction below takes
       away the showcase, not the fact that somebody is there. */
    claimed: row.user_id !== null,
    title: withdrawn ? null : row.title,
    specialty: withdrawn ? null : row.specialty,
    image: withdrawn ? null : row.image,
    rating: withdrawn ? null : row.rating,
    years_experience: withdrawn ? null : row.years_experience,
  };
}

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
 * The whole week is read first and computed after: one loadDayCalendar covers every date
 * at once, so the strip costs a handful of queries instead of the roster's worth per day it
 * used to spend walking the technicians one at a time.
 */
async function getServiceWeek(serviceId, from, days, except = null) {
  const calendar = await loadDayCalendar({
    serviceIds: [serviceId],
    dateFrom: from,
    dateTo: addDaysISO(from, days - 1),
    exceptBookingId: except,
  });
  const salonId = calendar.services.get(serviceId)?.salon_id ?? null;
  return calendar.dates.map((date) => ({
    date,
    closed: calendar.offSalonDays.has(`${salonId}:${date}`),
    slots: calendarServiceSlots(calendar, serviceId, date),
  }));
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
    // The caller's own appointment, taken out of the calendar it is being moved off.
    // Ignored unless they are signed in and it is really theirs (lib/except-booking.js).
    const except = await exceptBookingIdFor(req);

    if (req.query.days !== undefined) {
      const from = req.query.from === undefined ? todayISO() : req.query.from;
      if (!isISODate(from)) {
        throw httpError(400, 'VALIDATION_ERROR', 'Ngày bắt đầu phải theo định dạng YYYY-MM-DD.');
      }
      const days = Math.min(
        MAX_DAYS,
        Math.max(MIN_DAYS, Number.parseInt(req.query.days, 10) || DEFAULT_DAYS),
      );
      res.json({
        success: true,
        data: { from, week: await getServiceWeek(serviceId, from, days, except) },
      });
      return;
    }

    const { date } = req.query;
    if (!isISODate(date)) {
      throw httpError(400, 'VALIDATION_ERROR', 'Vui lòng chọn ngày hợp lệ theo định dạng YYYY-MM-DD.');
    }
    res.json({
      success: true,
      data: { date, slots: await getServiceSlots(serviceId, date, null, null, except) },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/staff', async (req, res, next) => {
  try {
    const rows = await selectServiceStaff.all(await serviceIdOrThrow(req.params.id));
    res.json({ success: true, data: rows.map(pickerCard), meta: { total: rows.length } });
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
