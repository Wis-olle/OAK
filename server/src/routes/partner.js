// Partner console: overview, bookings, services, staff, promotions, revenue, salon.
import express from 'express';
import { db } from '../db.js';
import { withBookingCode } from '../lib/booking-code.js';
import { notifyUser } from '../lib/notify.js';
import { parseJsonArray, parsePagination } from '../lib/query.js';
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
import { httpError, requireAuth, requirePartner } from '../middleware/auth.js';

const router = express.Router();

// One gate for the whole file: nothing below is reachable by a customer or a guest.
router.use(requireAuth, requirePartner);

const BOOKING_STATUSES = ['pending', 'confirmed', 'completed', 'cancelled'];
const SERVICE_CATEGORIES = ['hair', 'nail', 'skincare', 'spa', 'eyelash', 'amenity'];
const PROMOTION_TYPES = ['discount', 'combo', 'flash_sale'];

// The only transitions a partner may drive. Terminal states list nothing, so
// completed/cancelled bookings can never be reopened.
const STATUS_TRANSITIONS = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

const REVENUE_DEFAULT_DAYS = 30;
const VIP_COMPLETED_BOOKINGS = 3;
const SEARCH_LIMIT = 5;
const TOP_BREAKDOWN_LIMIT = 5;
const DAYS_IN_WEEK = 7;
const MINUTES_PER_DAY = 24 * 60;

/* ============================================================================
 * Salon scoping — the security spine of this file
 * ========================================================================= */

const selectOwnedSalon = db.prepare('SELECT * FROM salons WHERE owner_id = ? ORDER BY id LIMIT 1');

/**
 * The salon every handler in this file operates on.
 *
 * The id is ALWAYS derived from the authenticated owner, never from the body, query
 * or path, so a partner cannot address another salon's rows by guessing an id.
 * The console works on a single salon, and every seeded partner owns exactly one. The
 * LIMIT stays as the defined reading of "the owner's salon" — the lowest id, the first
 * they registered — should an account ever end up with two.
 */
function ownedSalon(req) {
  const salon = selectOwnedSalon.get(req.user.id);
  if (!salon) {
    throw httpError(404, 'PARTNER_NO_SALON', 'Tài khoản của bạn chưa có salon nào.');
  }
  return salon;
}

/**
 * Fetch a row by id within the owner's salon.
 *
 * A row that exists but belongs to someone else answers exactly like one that does
 * not exist: 404, never 403. A 403 would confirm the id is real.
 */
function ownedRow(statement, id, salonId, message) {
  const row = statement.get(id, salonId);
  if (!row) {
    throw httpError(404, 'NOT_FOUND', message);
  }
  return row;
}

/* ============================================================================
 * Input validation — nothing unchecked ever reaches SQL
 * ========================================================================= */

/** Row id from any request source. Rejects NaN, floats and negatives. */
function requireId(value, message) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw httpError(400, 'VALIDATION_ERROR', message);
  }
  return id;
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw httpError(400, 'VALIDATION_ERROR', `Vui lòng nhập ${label}.`);
  }
  return value.trim();
}

/** Optional free text. null and '' both clear the column; a non-string is a client error. */
function optionalText(value, label) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw httpError(400, 'VALIDATION_ERROR', `${label} phải là chuỗi ký tự.`);
  }
  return value.trim() === '' ? null : value.trim();
}

/** Optional https URL. Empty clears the column; any non-https value is a client error. */
function optionalHttpsUrl(value, label) {
  const text = optionalText(value, label);
  if (text !== null && !/^https:\/\//i.test(text)) {
    throw httpError(400, 'VALIDATION_ERROR', `${label} phải là đường dẫn https hợp lệ.`);
  }
  return text;
}

/** Money and durations: integers >= 0. */
function requireCount(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw httpError(400, 'VALIDATION_ERROR', `${label} phải là số nguyên không âm.`);
  }
  return number;
}

/** Same as requireCount but keeps an explicitly cleared column null. */
function optionalCount(value, label) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return requireCount(value, label);
}

function requireFlag(value, label) {
  if (value === true || value === 1 || value === '1') {
    return 1;
  }
  if (value === false || value === 0 || value === '0') {
    return 0;
  }
  throw httpError(400, 'VALIDATION_ERROR', `${label} phải là true hoặc false.`);
}

function requireDate(value, label) {
  if (!isISODate(value)) {
    throw httpError(400, 'VALIDATION_ERROR', `${label} phải theo định dạng YYYY-MM-DD.`);
  }
  return value;
}

function requireTime(value, label) {
  if (!isHHMM(value)) {
    throw httpError(400, 'VALIDATION_ERROR', `${label} phải theo định dạng HH:MM.`);
  }
  return value;
}

function requireOneOf(value, allowed, message) {
  if (!allowed.includes(value)) {
    throw httpError(400, 'VALIDATION_ERROR', message);
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) {
    throw httpError(400, 'VALIDATION_ERROR', `${label} phải là một danh sách.`);
  }
  return value;
}

/** Array of plain strings -> JSON TEXT column. */
function requireJsonStringArray(value, label) {
  const items = requireArray(value, label).map((item) => {
    if (typeof item !== 'string') {
      throw httpError(400, 'VALIDATION_ERROR', `${label} chỉ nhận chuỗi ký tự.`);
    }
    return item.trim();
  });
  return JSON.stringify(items);
}

/**
 * Build the SET clause of a PATCH from a whitelist of {column: parse} entries.
 *
 * Only a column named in the whitelist can reach the SQL, so no request body can
 * ever reassign salon_id, id or any other column the endpoint does not own.
 */
function buildPatch(body, columns) {
  const assignments = [];
  const values = [];
  for (const [column, parse] of Object.entries(columns)) {
    if (Object.hasOwn(body, column)) {
      assignments.push(`"${column}" = ?`);
      values.push(parse(body[column]));
    }
  }
  if (assignments.length === 0) {
    throw httpError(400, 'VALIDATION_ERROR', 'Không có thông tin nào để cập nhật.');
  }
  return { assignments, values };
}

/** AVG() over an empty set is null; the dashboards want a number. */
function roundRating(value) {
  return value === null || value === undefined ? 0 : Math.round(value * 10) / 10;
}

/** 'YYYY-MM-DD' -> 'DD/MM/YYYY' for the Vietnamese notification bodies. */
function formatDateVN(iso) {
  const [year, month, day] = String(iso).split('-');
  return `${day}/${month}/${year}`;
}

/* ============================================================================
 * Shared shapes and day-schedule helpers
 * ========================================================================= */

const BOOKING_COLUMNS = `
    b.id, b.code, b.date, b.time, b.status, b.total_price, b.note,
    b.payment_method, b.created_at, b.customer_name, b.customer_phone,
    u.name AS user_name, u.phone AS user_phone, u.avatar AS user_avatar,
    (SELECT COUNT(*) FROM bookings vb
      WHERE vb.user_id = b.user_id AND vb.salon_id = b.salon_id AND vb.status = 'completed'
    ) AS completed_count,
    sv.id AS service_id, sv.name AS service_name, sv.category AS service_category,
    sv.duration_min AS service_duration, sv.price AS service_price,
    st.id AS staff_id, st.name AS staff_name`;

// LEFT JOINs: a walk-in has no user account and a booking need not name a technician.
// The services join is defensive only — DELETE /api/partner/services/:id refuses while
// any booking references the service, so it can never actually be missing.
const BOOKING_SOURCE = `
  FROM bookings b
  LEFT JOIN users u ON u.id = b.user_id
  LEFT JOIN services sv ON sv.id = b.service_id
  LEFT JOIN staff st ON st.id = b.staff_id`;

function bookingShape(row) {
  const startMinutes = toMinutes(row.time);
  const hasWindow = startMinutes !== null && row.service_duration !== null;
  return {
    id: row.id,
    code: row.code,
    date: row.date,
    time: row.time,
    // Wrapped past midnight: a 23:30 booking of a 90-minute service ends at 01:00,
    // never at the "25:00" a plain sum would render.
    end_time: hasWindow
      ? fromMinutes((startMinutes + row.service_duration) % MINUTES_PER_DAY)
      : null,
    status: row.status,
    total_price: row.total_price,
    note: row.note,
    payment_method: row.payment_method,
    created_at: row.created_at,
    customer: {
      // Walk-ins carry no account, so the name typed at the counter is the fallback.
      name: row.user_name ?? row.customer_name,
      phone: row.user_phone ?? row.customer_phone,
      avatar: row.user_avatar ?? null,
      vip: row.completed_count >= VIP_COMPLETED_BOOKINGS,
    },
    service: row.service_id
      ? {
          id: row.service_id,
          name: row.service_name,
          category: row.service_category,
          duration_min: row.service_duration,
          price: row.service_price,
        }
      : null,
    staff: row.staff_id ? { id: row.staff_id, name: row.staff_name } : null,
  };
}

function serviceShape(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    subcategory: row.subcategory,
    price: row.price,
    duration_min: row.duration_min,
    image: row.image,
    featured: row.featured,
    is_package: row.is_package,
    price_is_from: row.price_is_from,
    active: row.active,
  };
}

function promotionShape(row) {
  return {
    id: row.id,
    code: row.code,
    type: row.type,
    title: row.title,
    description: row.description,
    discount_percent: row.discount_percent,
    discount_amount: row.discount_amount,
    original_price: row.original_price,
    sale_price: row.sale_price,
    service_ids: parseJsonArray(row.service_ids),
    image: row.image,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    active: row.active,
  };
}

function salonShape(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    address: row.address,
    district: row.district,
    city: row.city,
    phone: row.phone,
    image: row.image,
    open_time: row.open_time,
    close_time: row.close_time,
    lat: row.lat,
    lng: row.lng,
    verified: row.verified,
    featured: row.featured,
    flagship: row.flagship,
    tags: parseJsonArray(row.tags),
    amenities: parseJsonArray(row.amenities),
    tour_url: row.tour_url,
    created_at: row.created_at,
  };
}

// Cancelled and completed bookings occupy nobody, so only live ones count as "busy".
const selectDayBookingWindows = db.prepare(`
  SELECT b.staff_id, b.time, COALESCE(sv.duration_min, 0) AS duration_min
  FROM bookings b
  LEFT JOIN services sv ON sv.id = b.service_id
  WHERE b.salon_id = ? AND b.date = ? AND b.staff_id IS NOT NULL
    AND b.status IN ('pending','confirmed')
  ORDER BY b.time
`);

/** staff_id -> that day's booking windows in minutes, already in time order. */
function bookingWindowsByStaff(salonId, date) {
  const windows = new Map();
  for (const row of selectDayBookingWindows.all(salonId, date)) {
    const start = toMinutes(row.time);
    if (start === null) {
      continue;
    }
    if (!windows.has(row.staff_id)) {
      windows.set(row.staff_id, []);
    }
    windows.get(row.staff_id).push({ start, end: start + row.duration_min });
  }
  return windows;
}

/** Busy while a booking is running right now, otherwise free with the next start time. */
function staffState(windows, minutes) {
  const current = (windows ?? []).find((slot) => minutes >= slot.start && minutes < slot.end);
  if (current) {
    return { state: 'busy', busy_until: fromMinutes(current.end), next_booking: null };
  }
  const next = (windows ?? []).find((slot) => slot.start >= minutes);
  return { state: 'free', busy_until: null, next_booking: next ? fromMinutes(next.start) : null };
}

/* ============================================================================
 * Overview
 * ========================================================================= */

const selectDayRevenue = db.prepare(`
  SELECT COALESCE(SUM(total_price), 0) AS revenue
  FROM bookings
  WHERE salon_id = ? AND date = ? AND status = 'completed'
`);
const selectDayBookingCount = db.prepare(
  'SELECT COUNT(*) AS count FROM bookings WHERE salon_id = ? AND date = ?',
);
const selectUpcomingCount = db.prepare(`
  SELECT COUNT(*) AS count FROM bookings
  WHERE salon_id = ? AND date >= ? AND status IN ('pending','confirmed')
`);
// A customer is "new" on the day of their very first booking with this salon.
const selectNewCustomerCount = db.prepare(`
  SELECT COUNT(*) AS count FROM (
    SELECT user_id, MIN(date) AS first_date
    FROM bookings
    WHERE salon_id = ? AND user_id IS NOT NULL
    GROUP BY user_id
  )
  WHERE first_date = ?
`);
const selectSalonRating = db.prepare(
  'SELECT AVG(rating) AS average, COUNT(*) AS count FROM reviews WHERE salon_id = ?',
);
const selectActiveStaff = db.prepare(
  'SELECT id, name, image FROM staff WHERE salon_id = ? AND active = 1 ORDER BY id',
);

router.get('/overview', (req, res, next) => {
  try {
    const salon = ownedSalon(req);
    const date = req.query.date ? requireDate(req.query.date, 'Ngày') : todayISO();
    const previousDate = addDaysISO(date, -1);

    const revenueToday = selectDayRevenue.get(salon.id, date).revenue;
    const revenueYesterday = selectDayRevenue.get(salon.id, previousDate).revenue;
    const rating = selectSalonRating.get(salon.id);

    const windows = bookingWindowsByStaff(salon.id, date);
    const minutes = nowMinutes();
    const staffStatus = selectActiveStaff.all(salon.id).map((member) => ({
      id: member.id,
      name: member.name,
      image: member.image,
      ...staffState(windows.get(member.id), minutes),
    }));

    res.json({
      success: true,
      data: {
        date,
        revenue_today: revenueToday,
        // A day with no revenue to compare against has no meaningful percentage.
        revenue_delta_pct:
          revenueYesterday === 0
            ? null
            : Math.round(((revenueToday - revenueYesterday) / revenueYesterday) * 1000) / 10,
        bookings_today: selectDayBookingCount.get(salon.id, date).count,
        // Counted from the requested day, so the whole card stays about that day.
        upcoming_count: selectUpcomingCount.get(salon.id, date).count,
        new_customers: selectNewCustomerCount.get(salon.id, date).count,
        rating_avg: roundRating(rating.average),
        review_count: rating.count,
        staff_status: staffStatus,
      },
    });
  } catch (error) {
    next(error);
  }
});

/* ============================================================================
 * Bookings
 * ========================================================================= */

const selectOwnedBooking = db.prepare(
  `SELECT ${BOOKING_COLUMNS} ${BOOKING_SOURCE} WHERE b.id = ? AND b.salon_id = ?`,
);
const selectOwnedBookingRow = db.prepare(
  'SELECT * FROM bookings WHERE id = ? AND salon_id = ?',
);
const selectOwnedService = db.prepare('SELECT * FROM services WHERE id = ? AND salon_id = ?');
const selectOwnedStaff = db.prepare('SELECT * FROM staff WHERE id = ? AND salon_id = ?');
const insertWalkInBooking = db.prepare(`
  INSERT INTO bookings
    (user_id, salon_id, service_id, staff_id, code, date, time, status, note,
     total_price, customer_name, customer_phone, payment_method, created_at)
  VALUES (NULL, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, 'at_salon', ?)
`);

const BOOKING_NOTIFICATIONS = {
  confirmed: (salon, booking) => ({
    title: 'Lịch hẹn đã được xác nhận',
    body: `${salon.name} đã xác nhận lịch hẹn ${booking.code} ngày ${formatDateVN(booking.date)} lúc ${booking.time}.`,
    type: 'booking',
  }),
  cancelled: (salon, booking) => ({
    title: 'Lịch hẹn đã bị huỷ',
    body: `${salon.name} đã huỷ lịch hẹn ${booking.code} ngày ${formatDateVN(booking.date)} lúc ${booking.time}.`,
    type: 'booking',
  }),
  completed: (salon, booking) => ({
    title: 'Buổi hẹn đã hoàn tất',
    body: `Cảm ơn bạn đã sử dụng dịch vụ tại ${salon.name}. Hãy dành một phút đánh giá lịch hẹn ${booking.code} nhé!`,
    type: 'review',
  }),
};

router.get('/bookings', (req, res, next) => {
  try {
    const salon = ownedSalon(req);
    const { page, limit, offset } = parsePagination(req.query, 20);

    // Every clause is a literal; only the values are bound.
    const conditions = ['b.salon_id = ?'];
    const params = [salon.id];

    if (req.query.date) {
      conditions.push('b.date = ?');
      params.push(requireDate(req.query.date, 'Ngày'));
    }
    if (req.query.from) {
      conditions.push('b.date >= ?');
      params.push(requireDate(req.query.from, 'Ngày bắt đầu'));
    }
    if (req.query.to) {
      conditions.push('b.date <= ?');
      params.push(requireDate(req.query.to, 'Ngày kết thúc'));
    }
    if (req.query.staff_id) {
      conditions.push('b.staff_id = ?');
      params.push(requireId(req.query.staff_id, 'Mã kỹ thuật viên không hợp lệ.'));
    }
    if (req.query.service_id) {
      conditions.push('b.service_id = ?');
      params.push(requireId(req.query.service_id, 'Mã dịch vụ không hợp lệ.'));
    }
    if (req.query.status) {
      conditions.push('b.status = ?');
      params.push(
        requireOneOf(req.query.status, BOOKING_STATUSES, 'Trạng thái lịch hẹn không hợp lệ.'),
      );
    }
    if (req.query.q) {
      const term = `%${String(req.query.q).trim()}%`;
      conditions.push('(b.code LIKE ? OR b.customer_name LIKE ?)');
      params.push(term, term);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM bookings b ${where}`).get(...params);
    const rows = db
      .prepare(
        `SELECT ${BOOKING_COLUMNS} ${BOOKING_SOURCE} ${where}
         ORDER BY b.date DESC, b.time DESC, b.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);

    res.json({ success: true, data: rows.map(bookingShape), meta: { page, limit, total } });
  } catch (error) {
    next(error);
  }
});

/**
 * Resolve a staff id for a booking assignment within the owner's salon. A soft-deleted
 * technician (active = 0) still exists for history but can take no new work, so assigning
 * one is a client error, not a 404.
 */
function activeStaffIdForBooking(value, salonId) {
  const staff = ownedRow(
    selectOwnedStaff,
    requireId(value, 'Mã kỹ thuật viên không hợp lệ.'),
    salonId,
    'Không tìm thấy kỹ thuật viên này tại salon của bạn.',
  );
  if (staff.active !== 1) {
    throw httpError(400, 'VALIDATION_ERROR', 'Kỹ thuật viên này đã ngừng hoạt động.');
  }
  return staff.id;
}

router.post('/bookings', (req, res, next) => {
  try {
    const salon = ownedSalon(req);
    const body = req.body ?? {};

    const customerName = requireText(body.customer_name, 'tên khách hàng');
    const customerPhone = requireText(body.customer_phone, 'số điện thoại khách hàng');
    const date = requireDate(body.date, 'Ngày hẹn');
    // A walk-in booked into the past would silently rewrite the revenue history that
    // GET /api/partner/revenue reads.
    if (date < todayISO()) {
      throw httpError(400, 'VALIDATION_ERROR', 'Không thể tạo lịch hẹn cho ngày đã qua.');
    }
    const time = requireTime(body.time, 'Giờ hẹn');
    const note = optionalText(body.note, 'Ghi chú');

    const service = ownedRow(
      selectOwnedService,
      requireId(body.service_id, 'Mã dịch vụ không hợp lệ.'),
      salon.id,
      'Không tìm thấy dịch vụ này tại salon của bạn.',
    );
    const staffId =
      body.staff_id === null || body.staff_id === undefined
        ? null
        : activeStaffIdForBooking(body.staff_id, salon.id);

    // Price comes from the service row, never from the request: the counter must not
    // be able to post an arbitrary total.
    let bookingId;
    withBookingCode((code) => {
      bookingId = Number(
        insertWalkInBooking.run(
          salon.id,
          service.id,
          staffId,
          code,
          date,
          time,
          note,
          service.price,
          customerName,
          customerPhone,
          new Date().toISOString(),
        ).lastInsertRowid,
      );
    });

    res.json({ success: true, data: bookingShape(selectOwnedBooking.get(bookingId, salon.id)) });
  } catch (error) {
    next(error);
  }
});

router.get('/bookings/:id', (req, res, next) => {
  try {
    const salon = ownedSalon(req);
    const booking = ownedRow(
      selectOwnedBooking,
      requireId(req.params.id, 'Mã lịch hẹn không hợp lệ.'),
      salon.id,
      'Không tìm thấy lịch hẹn này.',
    );
    res.json({ success: true, data: bookingShape(booking) });
  } catch (error) {
    next(error);
  }
});

router.patch('/bookings/:id', (req, res, next) => {
  try {
    const salon = ownedSalon(req);
    const body = req.body ?? {};
    const bookingId = requireId(req.params.id, 'Mã lịch hẹn không hợp lệ.');
    const booking = ownedRow(
      selectOwnedBookingRow,
      bookingId,
      salon.id,
      'Không tìm thấy lịch hẹn này.',
    );

    // Built per request because the parsers need the owner's salon and the current
    // status, but the column names are still a fixed whitelist.
    const { assignments, values } = buildPatch(body, {
      service_id: (value) =>
        ownedRow(
          selectOwnedService,
          requireId(value, 'Mã dịch vụ không hợp lệ.'),
          salon.id,
          'Không tìm thấy dịch vụ này tại salon của bạn.',
        ).id,
      staff_id: (value) => (value === null ? null : activeStaffIdForBooking(value, salon.id)),
      date: (value) => requireDate(value, 'Ngày hẹn'),
      time: (value) => requireTime(value, 'Giờ hẹn'),
      note: (value) => optionalText(value, 'Ghi chú'),
      status: (value) => {
        requireOneOf(value, BOOKING_STATUSES, 'Trạng thái lịch hẹn không hợp lệ.');
        if (!STATUS_TRANSITIONS[booking.status].includes(value)) {
          throw httpError(
            400,
            'INVALID_TRANSITION',
            `Không thể chuyển lịch hẹn từ trạng thái "${booking.status}" sang "${value}".`,
          );
        }
        return value;
      },
    });

    const notification = BOOKING_NOTIFICATIONS[body.status];

    db.exec('BEGIN');
    try {
      db.prepare(
        `UPDATE bookings SET ${assignments.join(', ')} WHERE id = ? AND salon_id = ?`,
      ).run(...values, bookingId, salon.id);

      if (notification) {
        const updated = selectOwnedBookingRow.get(bookingId, salon.id);
        const { title, body: message, type } = notification(salon, updated);
        // No-op for walk-ins (user_id NULL), so this needs no guard of its own.
        notifyUser(booking.user_id, title, message, type);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    res.json({ success: true, data: bookingShape(selectOwnedBooking.get(bookingId, salon.id)) });
  } catch (error) {
    next(error);
  }
});

/* ============================================================================
 * Services
 * ========================================================================= */

const selectServiceCategoryCounts = db.prepare(
  'SELECT category, COUNT(*) AS count FROM services WHERE salon_id = ? GROUP BY category',
);
const insertService = db.prepare(`
  INSERT INTO services
    (salon_id, category, subcategory, name, description, price, duration_min, image, active)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
`);
// Every booking, not just the upcoming ones: the foreign key blocks the delete as soon
// as any row references the service, so a narrower pre-check would make the 409 arrive
// from the pre-check or from the FK depending on the data.
const selectServiceBookingCount = db.prepare(
  'SELECT COUNT(*) AS count FROM bookings WHERE salon_id = ? AND service_id = ?',
);
const deleteServiceLinks = db.prepare('DELETE FROM staff_services WHERE service_id = ?');
const deleteService = db.prepare('DELETE FROM services WHERE id = ? AND salon_id = ?');

const SERVICE_COLUMNS = {
  name: (value) => requireText(value, 'tên dịch vụ'),
  category: (value) => requireOneOf(value, SERVICE_CATEGORIES, 'Danh mục dịch vụ không hợp lệ.'),
  subcategory: (value) => optionalText(value, 'Danh mục phụ'),
  description: (value) => optionalText(value, 'Mô tả'),
  price: (value) => requireCount(value, 'Giá dịch vụ'),
  duration_min: (value) => requireCount(value, 'Thời lượng'),
  image: (value) => optionalText(value, 'Ảnh dịch vụ'),
  active: (value) => requireFlag(value, 'Trạng thái hiển thị'),
};

router.get('/services', (req, res, next) => {
  try {
    const salon = ownedSalon(req);
    const { page, limit, offset } = parsePagination(req.query, 50);

    const conditions = ['salon_id = ?'];
    const params = [salon.id];
    if (req.query.category) {
      conditions.push('category = ?');
      params.push(
        requireOneOf(req.query.category, SERVICE_CATEGORIES, 'Danh mục dịch vụ không hợp lệ.'),
      );
    }
    if (req.query.q) {
      conditions.push('name LIKE ?');
      params.push(`%${String(req.query.q).trim()}%`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM services ${where}`).get(...params);
    const rows = db
      .prepare(`SELECT * FROM services ${where} ORDER BY category, name LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);

    // Counts cover the whole salon, not the filtered page, so the category tabs keep
    // their numbers while a filter is applied. Zero-filled for a stable shape.
    const categories = Object.fromEntries(SERVICE_CATEGORIES.map((key) => [key, 0]));
    for (const row of selectServiceCategoryCounts.all(salon.id)) {
      categories[row.category] = row.count;
    }

    res.json({
      success: true,
      data: rows.map(serviceShape),
      meta: { page, limit, total, categories },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/services', (req, res, next) => {
  try {
    const salon = ownedSalon(req);
    const body = req.body ?? {};

    const serviceId = Number(
      insertService.run(
        salon.id,
        SERVICE_COLUMNS.category(body.category),
        SERVICE_COLUMNS.subcategory(body.subcategory),
        SERVICE_COLUMNS.name(body.name),
        SERVICE_COLUMNS.description(body.description),
        SERVICE_COLUMNS.price(body.price),
        SERVICE_COLUMNS.duration_min(body.duration_min),
        SERVICE_COLUMNS.image(body.image),
      ).lastInsertRowid,
    );

    res.json({ success: true, data: serviceShape(selectOwnedService.get(serviceId, salon.id)) });
  } catch (error) {
    next(error);
  }
});

router.get('/services/:id', (req, res, next) => {
  try {
    const salon = ownedSalon(req);
    const service = ownedRow(
      selectOwnedService,
      requireId(req.params.id, 'Mã dịch vụ không hợp lệ.'),
      salon.id,
      'Không tìm thấy dịch vụ này.',
    );
    res.json({ success: true, data: serviceShape(service) });
  } catch (error) {
    next(error);
  }
});

router.patch('/services/:id', (req, res, next) => {
  try {
    const salon = ownedSalon(req);
    const serviceId = requireId(req.params.id, 'Mã dịch vụ không hợp lệ.');
    ownedRow(selectOwnedService, serviceId, salon.id, 'Không tìm thấy dịch vụ này.');

    const { assignments, values } = buildPatch(req.body ?? {}, SERVICE_COLUMNS);
    db.prepare(`UPDATE services SET ${assignments.join(', ')} WHERE id = ? AND salon_id = ?`).run(
      ...values,
      serviceId,
      salon.id,
    );

    res.json({ success: true, data: serviceShape(selectOwnedService.get(serviceId, salon.id)) });
  } catch (error) {
    next(error);
  }
});

router.delete('/services/:id', (req, res, next) => {
  try {
    const salon = ownedSalon(req);
    const serviceId = requireId(req.params.id, 'Mã dịch vụ không hợp lệ.');
    ownedRow(selectOwnedService, serviceId, salon.id, 'Không tìm thấy dịch vụ này.');

    const { count } = selectServiceBookingCount.get(salon.id, serviceId);
    if (count > 0) {
      throw httpError(
        409,
        'HAS_BOOKINGS',
        'Dịch vụ đã phát sinh lịch hẹn nên không thể xoá. Bạn có thể tạm ẩn dịch vụ.',
      );
    }

    db.exec('BEGIN');
    try {
      // The staff links belong to this service, so they go with it; bookings and
      // reviews do not, and their foreign keys are what stops the delete below.
      deleteServiceLinks.run(serviceId);
      deleteService.run(serviceId, salon.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      if (String(error.message).includes('FOREIGN KEY constraint failed')) {
        throw httpError(
          409,
          'HAS_BOOKINGS',
          'Dịch vụ đã phát sinh lịch hẹn hoặc đánh giá nên không thể xoá. Bạn có thể tạm ẩn dịch vụ.',
        );
      }
      throw error;
    }

    res.json({ success: true, data: { ok: true } });
  } catch (error) {
    next(error);
  }
});

/* ============================================================================
 * Staff
 * ========================================================================= */

const selectSalonStaff = db.prepare('SELECT * FROM staff WHERE salon_id = ? ORDER BY id');
const selectSalonSchedules = db.prepare(`
  SELECT ss.staff_id, ss.weekday, ss."start" AS start, ss."end" AS end, ss.is_off
  FROM staff_schedule ss
  JOIN staff st ON st.id = ss.staff_id
  WHERE st.salon_id = ?
  ORDER BY ss.weekday
`);
const selectStaffSchedule = db.prepare(`
  SELECT weekday, "start" AS start, "end" AS end, is_off
  FROM staff_schedule WHERE staff_id = ? ORDER BY weekday
`);
const selectStaffServiceIds = db.prepare(
  'SELECT service_id FROM staff_services WHERE staff_id = ? ORDER BY service_id',
);
// rating > 0 so an unrated new hire (rating defaults to 0) does not drag the average
// down: the roster figure should reflect technicians who actually have reviews.
const selectActiveStaffRating = db.prepare(
  'SELECT AVG(rating) AS average FROM staff WHERE salon_id = ? AND active = 1 AND rating > 0',
);
const insertStaff = db.prepare(
  'INSERT INTO staff (salon_id, name, title, specialty, image, active) VALUES (?, ?, ?, ?, ?, 1)',
);
const insertStaffSchedule = db.prepare(
  'INSERT INTO staff_schedule (staff_id, weekday, "start", "end", is_off) VALUES (?, ?, ?, ?, ?)',
);
const deleteStaffSchedule = db.prepare('DELETE FROM staff_schedule WHERE staff_id = ?');
const insertStaffService = db.prepare(
  'INSERT INTO staff_services (staff_id, service_id) VALUES (?, ?)',
);
const deleteStaffServices = db.prepare('DELETE FROM staff_services WHERE staff_id = ?');
const deactivateStaff = db.prepare('UPDATE staff SET active = 0 WHERE id = ? AND salon_id = ?');

const STAFF_COLUMNS = {
  name: (value) => requireText(value, 'tên kỹ thuật viên'),
  title: (value) => optionalText(value, 'Chức danh'),
  specialty: (value) => optionalText(value, 'Chuyên môn'),
  image: (value) => optionalText(value, 'Ảnh đại diện'),
  // Patchable so a soft-deleted technician (DELETE sets active = 0) can be restored.
  active: (value) => requireFlag(value, 'Trạng thái hoạt động'),
};

/** Validate a full-replace schedule payload: one row per weekday, start before end. */
function parseSchedule(value) {
  const rows = requireArray(value, 'Lịch làm việc').map((entry) => {
    if (entry === null || typeof entry !== 'object') {
      throw httpError(400, 'VALIDATION_ERROR', 'Mỗi ca làm việc phải là một đối tượng.');
    }
    const weekday = Number(entry.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw httpError(400, 'VALIDATION_ERROR', 'Thứ trong tuần phải là số từ 0 đến 6.');
    }
    const start = requireTime(entry.start, 'Giờ bắt đầu ca');
    const end = requireTime(entry.end, 'Giờ kết thúc ca');
    if (toMinutes(start) >= toMinutes(end)) {
      throw httpError(400, 'VALIDATION_ERROR', 'Giờ bắt đầu ca phải sớm hơn giờ kết thúc.');
    }
    const isOff = entry.is_off === undefined ? 0 : requireFlag(entry.is_off, 'Ngày nghỉ');
    return { weekday, start, end, is_off: isOff };
  });

  // UNIQUE(staff_id, weekday) would fail mid-transaction otherwise.
  if (new Set(rows.map((row) => row.weekday)).size !== rows.length) {
    throw httpError(400, 'VALIDATION_ERROR', 'Mỗi thứ trong tuần chỉ được khai báo một ca.');
  }
  return rows;
}

/** Read a list payload sent either as {key:[...]} or as a bare array body. */
function listPayload(body, key) {
  return Array.isArray(body) ? body : (body ?? {})[key];
}

/** Validate a full-replace service list: unique ids, all inside the owner's salon. */
function parseStaffServiceIds(value, salonId) {
  const ids = [
    ...new Set(
      requireArray(value, 'Danh sách dịch vụ').map((id) =>
        requireId(id, 'Mã dịch vụ không hợp lệ.'),
      ),
    ),
  ];
  for (const id of ids) {
    if (!selectOwnedService.get(id, salonId)) {
      throw httpError(400, 'VALIDATION_ERROR', 'Dịch vụ được chọn không thuộc salon của bạn.');
    }
  }
  return ids;
}

function staffDetail(staff) {
  return {
    id: staff.id,
    name: staff.name,
    title: staff.title,
    specialty: staff.specialty,
    bio: staff.bio,
    image: staff.image,
    rating: staff.rating,
    years_experience: staff.years_experience,
    portfolio: parseJsonArray(staff.portfolio),
    active: staff.active,
    schedule: selectStaffSchedule.all(staff.id),
    service_ids: selectStaffServiceIds.all(staff.id).map((row) => row.service_id),
  };
}

/** The next working day strictly after `fromDate`; today's shift is reported separately. */
function nextShift(scheduleByWeekday, fromDate) {
  for (let offset = 1; offset <= DAYS_IN_WEEK; offset += 1) {
    const date = addDaysISO(fromDate, offset);
    const shift = scheduleByWeekday.get(weekdayOf(date));
    if (shift && !shift.is_off) {
      return { date, start: shift.start, end: shift.end };
    }
  }
  return null;
}

router.get('/staff', (req, res, next) => {
  try {
    const salon = ownedSalon(req);
    const term = req.query.q ? `%${String(req.query.q).trim()}%` : null;
    const rows = term
      ? db
          .prepare('SELECT * FROM staff WHERE salon_id = ? AND name LIKE ? ORDER BY id')
          .all(salon.id, term)
      : selectSalonStaff.all(salon.id);

    const today = todayISO();
    const weekday = weekdayOf(today);
    const minutes = nowMinutes();
    const windows = bookingWindowsByStaff(salon.id, today);

    const schedules = new Map();
    for (const row of selectSalonSchedules.all(salon.id)) {
      if (!schedules.has(row.staff_id)) {
        schedules.set(row.staff_id, new Map());
      }
      schedules.get(row.staff_id).set(row.weekday, row);
    }

    let onShift = 0;
    const data = rows.map((member) => {
      const byWeekday = schedules.get(member.id) ?? new Map();
      const today_shift = byWeekday.get(weekday) ?? null;
      if (member.active === 1 && today_shift && !today_shift.is_off) {
        onShift += 1;
      }
      return {
        id: member.id,
        name: member.name,
        title: member.title,
        specialty: member.specialty,
        image: member.image,
        rating: member.rating,
        years_experience: member.years_experience,
        active: member.active,
        shift: today_shift
          ? { start: today_shift.start, end: today_shift.end, is_off: today_shift.is_off }
          : null,
        next_shift: nextShift(byWeekday, today),
        ...staffState(windows.get(member.id), minutes),
      };
    });

    res.json({
      success: true,
      data,
      meta: {
        // Soft-deleted staff stay in the roster with their flag so the console can show
        // them, but they are not counted here — rating_avg already excludes them, and a
        // headcount that disagreed with the rating it sits next to would be misleading.
        total: data.filter((member) => member.active === 1).length,
        on_shift: onShift,
        // Averaged over active staff only: the roster figure should reflect who works.
        rating_avg: roundRating(selectActiveStaffRating.get(salon.id).average),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/staff', (req, res, next) => {
  try {
    const salon = ownedSalon(req);
    const body = req.body ?? {};

    const name = STAFF_COLUMNS.name(body.name);
    const title = STAFF_COLUMNS.title(body.title);
    const specialty = STAFF_COLUMNS.specialty(body.specialty);
    const image = STAFF_COLUMNS.image(body.image);
    const schedule = body.schedule === undefined ? [] : parseSchedule(body.schedule);
    const serviceIds =
      body.service_ids === undefined ? [] : parseStaffServiceIds(body.service_ids, salon.id);

    db.exec('BEGIN');
    let staffId;
    try {
      staffId = Number(insertStaff.run(salon.id, name, title, specialty, image).lastInsertRowid);
      for (const shift of schedule) {
        insertStaffSchedule.run(staffId, shift.weekday, shift.start, shift.end, shift.is_off);
      }
      for (const serviceId of serviceIds) {
        insertStaffService.run(staffId, serviceId);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    res.json({ success: true, data: staffDetail(selectOwnedStaff.get(staffId, salon.id)) });
  } catch (error) {
    next(error);
  }
});

// Registered before /staff/:id so the literal sub-paths always win the match.
router.put('/staff/:id/schedule', (req, res, next) => {
  try {
    const salon = ownedSalon(req);
    const staffId = requireId(req.params.id, 'Mã kỹ thuật viên không hợp lệ.');
    ownedRow(selectOwnedStaff, staffId, salon.id, 'Không tìm thấy kỹ thuật viên này.');
    const schedule = parseSchedule(listPayload(req.body, 'schedule'));

    // Full replace: the payload is the whole week, so the old rows go first.
    db.exec('BEGIN');
    try {
      deleteStaffSchedule.run(staffId);
      for (const shift of schedule) {
        insertStaffSchedule.run(staffId, shift.weekday, shift.start, shift.end, shift.is_off);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    res.json({ success: true, data: staffDetail(selectOwnedStaff.get(staffId, salon.id)) });
  } catch (error) {
    next(error);
  }
});

router.put('/staff/:id/services', (req, res, next) => {
  try {
    const salon = ownedSalon(req);
    const staffId = requireId(req.params.id, 'Mã kỹ thuật viên không hợp lệ.');
    ownedRow(selectOwnedStaff, staffId, salon.id, 'Không tìm thấy kỹ thuật viên này.');
    const serviceIds = parseStaffServiceIds(listPayload(req.body, 'service_ids'), salon.id);

    db.exec('BEGIN');
    try {
      deleteStaffServices.run(staffId);
      for (const serviceId of serviceIds) {
        insertStaffService.run(staffId, serviceId);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    res.json({ success: true, data: staffDetail(selectOwnedStaff.get(staffId, salon.id)) });
  } catch (error) {
    next(error);
  }
});

router.get('/staff/:id', (req, res, next) => {
  try {
    const salon = ownedSalon(req);
    const staff = ownedRow(
      selectOwnedStaff,
      requireId(req.params.id, 'Mã kỹ thuật viên không hợp lệ.'),
      salon.id,
      'Không tìm thấy kỹ thuật viên này.',
    );
    res.json({ success: true, data: staffDetail(staff) });
  } catch (error) {
    next(error);
  }
});

router.patch('/staff/:id', (req, res, next) => {
  try {
    const salon = ownedSalon(req);
    const staffId = requireId(req.params.id, 'Mã kỹ thuật viên không hợp lệ.');
    ownedRow(selectOwnedStaff, staffId, salon.id, 'Không tìm thấy kỹ thuật viên này.');

    const { assignments, values } = buildPatch(req.body ?? {}, STAFF_COLUMNS);
    db.prepare(`UPDATE staff SET ${assignments.join(', ')} WHERE id = ? AND salon_id = ?`).run(
      ...values,
      staffId,
      salon.id,
    );

    res.json({ success: true, data: staffDetail(selectOwnedStaff.get(staffId, salon.id)) });
  } catch (error) {
    next(error);
  }
});

router.delete('/staff/:id', (req, res, next) => {
  try {
    const salon = ownedSalon(req);
    const staffId = requireId(req.params.id, 'Mã kỹ thuật viên không hợp lệ.');
    ownedRow(selectOwnedStaff, staffId, salon.id, 'Không tìm thấy kỹ thuật viên này.');

    // Soft delete: past bookings and reviews still point at this row.
    deactivateStaff.run(staffId, salon.id);
    res.json({ success: true, data: { ok: true } });
  } catch (error) {
    next(error);
  }
});

/* ============================================================================
 * Promotions
 * ========================================================================= */

const selectSalonPromotions = db.prepare(
  'SELECT * FROM promotions WHERE salon_id = ? ORDER BY starts_at DESC, id DESC',
);
const selectOwnedPromotion = db.prepare('SELECT * FROM promotions WHERE id = ? AND salon_id = ?');
const insertPromotion = db.prepare(`
  INSERT INTO promotions
    (salon_id, code, type, title, description, discount_percent, discount_amount,
     original_price, sale_price, service_ids, image, starts_at, ends_at, active)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
`);
const deletePromotion = db.prepare('DELETE FROM promotions WHERE id = ? AND salon_id = ?');

/** service_ids is a JSON TEXT column, so the array is stringified at the boundary. */
function requireServiceIdList(value, label) {
  if (value === null || value === undefined) {
    return null;
  }
  return JSON.stringify(
    requireArray(value, label).map((id) => requireId(id, 'Mã dịch vụ không hợp lệ.')),
  );
}

const PROMOTION_COLUMNS = {
  title: (value) => requireText(value, 'tên ưu đãi'),
  type: (value) => requireOneOf(value, PROMOTION_TYPES, 'Loại ưu đãi không hợp lệ.'),
  description: (value) => optionalText(value, 'Mô tả'),
  code: (value) => optionalText(value, 'Mã ưu đãi'),
  discount_percent: (value) => optionalCount(value, 'Phần trăm giảm giá'),
  discount_amount: (value) => optionalCount(value, 'Số tiền giảm'),
  original_price: (value) => optionalCount(value, 'Giá gốc'),
  sale_price: (value) => optionalCount(value, 'Giá ưu đãi'),
  service_ids: (value) => requireServiceIdList(value, 'Danh sách dịch vụ'),
  image: (value) => optionalText(value, 'Ảnh ưu đãi'),
  starts_at: (value) => requireDate(value, 'Ngày bắt đầu'),
  ends_at: (value) => requireDate(value, 'Ngày kết thúc'),
  active: (value) => requireFlag(value, 'Trạng thái hiển thị'),
};

/**
 * Let the UNIQUE index decide the duplicate case rather than a pre-check, the same
 * way registration does — a SELECT-then-INSERT would still lose the race.
 */
function asCodeTaken(error) {
  if (String(error.message).includes('UNIQUE constraint failed: promotions.code')) {
    return httpError(409, 'CODE_TAKEN', 'Mã ưu đãi này đã được sử dụng.');
  }
  return error;
}

router.get('/promotions', (req, res, next) => {
  try {
    const salon = ownedSalon(req);
    // Inactive and expired ones included: this is the owner's own management list.
    res.json({ success: true, data: selectSalonPromotions.all(salon.id).map(promotionShape) });
  } catch (error) {
    next(error);
  }
});

router.post('/promotions', (req, res, next) => {
  try {
    const salon = ownedSalon(req);
    const body = req.body ?? {};

    let promotionId;
    try {
      promotionId = Number(
        insertPromotion.run(
          salon.id,
          PROMOTION_COLUMNS.code(body.code),
          PROMOTION_COLUMNS.type(body.type),
          PROMOTION_COLUMNS.title(body.title),
          PROMOTION_COLUMNS.description(body.description),
          PROMOTION_COLUMNS.discount_percent(body.discount_percent),
          PROMOTION_COLUMNS.discount_amount(body.discount_amount),
          PROMOTION_COLUMNS.original_price(body.original_price),
          PROMOTION_COLUMNS.sale_price(body.sale_price),
          PROMOTION_COLUMNS.service_ids(body.service_ids),
          PROMOTION_COLUMNS.image(body.image),
          PROMOTION_COLUMNS.starts_at(body.starts_at),
          PROMOTION_COLUMNS.ends_at(body.ends_at),
        ).lastInsertRowid,
      );
    } catch (error) {
      throw asCodeTaken(error);
    }

    res.json({
      success: true,
      data: promotionShape(selectOwnedPromotion.get(promotionId, salon.id)),
    });
  } catch (error) {
    next(error);
  }
});

router.patch('/promotions/:id', (req, res, next) => {
  try {
    const salon = ownedSalon(req);
    const promotionId = requireId(req.params.id, 'Mã ưu đãi không hợp lệ.');
    ownedRow(selectOwnedPromotion, promotionId, salon.id, 'Không tìm thấy ưu đãi này.');

    const { assignments, values } = buildPatch(req.body ?? {}, PROMOTION_COLUMNS);
    try {
      db.prepare(
        `UPDATE promotions SET ${assignments.join(', ')} WHERE id = ? AND salon_id = ?`,
      ).run(...values, promotionId, salon.id);
    } catch (error) {
      throw asCodeTaken(error);
    }

    res.json({
      success: true,
      data: promotionShape(selectOwnedPromotion.get(promotionId, salon.id)),
    });
  } catch (error) {
    next(error);
  }
});

router.delete('/promotions/:id', (req, res, next) => {
  try {
    const salon = ownedSalon(req);
    const promotionId = requireId(req.params.id, 'Mã ưu đãi không hợp lệ.');
    ownedRow(selectOwnedPromotion, promotionId, salon.id, 'Không tìm thấy ưu đãi này.');

    deletePromotion.run(promotionId, salon.id);
    res.json({ success: true, data: { ok: true } });
  } catch (error) {
    next(error);
  }
});

/* ============================================================================
 * Revenue
 * ========================================================================= */

// The group key is a strftime format, never raw input: the request may only pick a
// key of this map, and the format itself is bound as a parameter.
const REVENUE_GROUPS = {
  day: '%Y-%m-%d',
  week: '%Y-W%W',
  month: '%Y-%m',
};

const selectRevenueSeries = db.prepare(`
  SELECT strftime(?, date) AS period,
         COALESCE(SUM(total_price), 0) AS revenue,
         COUNT(*) AS bookings
  FROM bookings
  WHERE salon_id = ? AND status = 'completed' AND date >= ? AND date <= ?
  GROUP BY period
  ORDER BY period
`);
const selectRevenueTotals = db.prepare(`
  SELECT COALESCE(SUM(total_price), 0) AS revenue, COUNT(*) AS bookings
  FROM bookings
  WHERE salon_id = ? AND status = 'completed' AND date >= ? AND date <= ?
`);
const selectRevenueByService = db.prepare(`
  SELECT sv.name AS service, COALESCE(SUM(b.total_price), 0) AS revenue, COUNT(*) AS count
  FROM bookings b
  JOIN services sv ON sv.id = b.service_id
  WHERE b.salon_id = ? AND b.status = 'completed' AND b.date >= ? AND b.date <= ?
  GROUP BY sv.id
  ORDER BY revenue DESC
  LIMIT ?
`);
const selectRevenueByStaff = db.prepare(`
  SELECT st.name AS staff, COALESCE(SUM(b.total_price), 0) AS revenue, COUNT(*) AS count
  FROM bookings b
  JOIN staff st ON st.id = b.staff_id
  WHERE b.salon_id = ? AND b.status = 'completed' AND b.date >= ? AND b.date <= ?
  GROUP BY st.id
  ORDER BY revenue DESC
  LIMIT ?
`);

router.get('/revenue', (req, res, next) => {
  try {
    const salon = ownedSalon(req);
    const group = req.query.group
      ? requireOneOf(req.query.group, Object.keys(REVENUE_GROUPS), 'Cách nhóm dữ liệu không hợp lệ.')
      : 'day';
    const to = req.query.to ? requireDate(req.query.to, 'Ngày kết thúc') : todayISO();
    const from = req.query.from
      ? requireDate(req.query.from, 'Ngày bắt đầu')
      : addDaysISO(to, -(REVENUE_DEFAULT_DAYS - 1));

    const totals = selectRevenueTotals.get(salon.id, from, to);

    res.json({
      success: true,
      data: {
        from,
        to,
        group,
        series: selectRevenueSeries.all(REVENUE_GROUPS[group], salon.id, from, to),
        totals: {
          revenue: totals.revenue,
          bookings: totals.bookings,
          // No bookings means no average, not a division by zero.
          avg_ticket: totals.bookings === 0 ? 0 : Math.round(totals.revenue / totals.bookings),
        },
        by_service: selectRevenueByService.all(salon.id, from, to, TOP_BREAKDOWN_LIMIT),
        by_staff: selectRevenueByStaff.all(salon.id, from, to, TOP_BREAKDOWN_LIMIT),
      },
    });
  } catch (error) {
    next(error);
  }
});

/* ============================================================================
 * Salon profile
 * ========================================================================= */

const selectSalonById = db.prepare('SELECT * FROM salons WHERE id = ?');

const SALON_COLUMNS = {
  name: (value) => requireText(value, 'tên salon'),
  description: (value) => optionalText(value, 'Mô tả'),
  address: (value) => optionalText(value, 'Địa chỉ'),
  district: (value) => optionalText(value, 'Quận/Huyện'),
  city: (value) => optionalText(value, 'Tỉnh/Thành phố'),
  phone: (value) => optionalText(value, 'Số điện thoại'),
  image: (value) => optionalText(value, 'Ảnh đại diện'),
  open_time: (value) => requireTime(value, 'Giờ mở cửa'),
  close_time: (value) => requireTime(value, 'Giờ đóng cửa'),
  amenities: (value) => requireJsonStringArray(value, 'Tiện ích'),
  tags: (value) => requireJsonStringArray(value, 'Thẻ phân loại'),
  tour_url: (value) => optionalHttpsUrl(value, 'Đường dẫn tour 360'),
};

router.get('/salon', (req, res, next) => {
  try {
    res.json({ success: true, data: salonShape(ownedSalon(req)) });
  } catch (error) {
    next(error);
  }
});

router.patch('/salon', (req, res, next) => {
  try {
    const salon = ownedSalon(req);
    const { assignments, values } = buildPatch(req.body ?? {}, SALON_COLUMNS);

    // Keyed by the derived id, so no body field can redirect the update elsewhere.
    db.prepare(`UPDATE salons SET ${assignments.join(', ')} WHERE id = ?`).run(...values, salon.id);

    res.json({ success: true, data: salonShape(selectSalonById.get(salon.id)) });
  } catch (error) {
    next(error);
  }
});

/* ============================================================================
 * Search
 * ========================================================================= */

const searchBookings = db.prepare(`
  SELECT id, code, customer_name FROM bookings
  WHERE salon_id = ? AND (code LIKE ? OR customer_name LIKE ?)
  ORDER BY date DESC, id DESC LIMIT ?
`);
const searchServices = db.prepare(
  'SELECT id, name FROM services WHERE salon_id = ? AND name LIKE ? ORDER BY name LIMIT ?',
);
const searchStaff = db.prepare(
  'SELECT id, name FROM staff WHERE salon_id = ? AND name LIKE ? ORDER BY name LIMIT ?',
);

router.get('/search', (req, res, next) => {
  try {
    const salon = ownedSalon(req);
    const query = req.query.q ? String(req.query.q).trim() : '';
    // An empty box is not an error, it simply has nothing to show yet.
    if (query === '') {
      res.json({ success: true, data: [] });
      return;
    }

    const term = `%${query}%`;
    const results = [
      ...searchBookings.all(salon.id, term, term, SEARCH_LIMIT).map((row) => ({
        type: 'booking',
        id: row.id,
        label: [row.code, row.customer_name].filter(Boolean).join(' · '),
      })),
      ...searchServices
        .all(salon.id, term, SEARCH_LIMIT)
        .map((row) => ({ type: 'service', id: row.id, label: row.name })),
      ...searchStaff
        .all(salon.id, term, SEARCH_LIMIT)
        .map((row) => ({ type: 'staff', id: row.id, label: row.name })),
    ];

    res.json({ success: true, data: results });
  } catch (error) {
    next(error);
  }
});

export default router;
