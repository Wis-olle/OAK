// Customer bookings: price quote, create, list, detail, cancel.
import express from 'express';
import { db } from '../db.js';
import { getStaffSlots } from '../lib/availability.js';
import { withBookingCode } from '../lib/booking-code.js';
import { notifyUser } from '../lib/notify.js';
import { parsePagination } from '../lib/query.js';
import { isHHMM, isISODate, todayISO } from '../lib/time.js';
import { httpError, requireAuth } from '../middleware/auth.js';

const router = express.Router();

// Reserved line in the quote: the product decides per-staff pricing later, and having the
// line already wired means adding a price is a one-constant change, not a shape change.
const STAFF_SURCHARGE = 0;
const CANCEL_WINDOW_HOURS = 2;
const MINUTES_PER_HOUR = 60;
const PAYMENT_METHODS = ['at_salon', 'online'];
const DEFAULT_PAGE_SIZE = 10;

// Every booking belongs to exactly one customer, so nothing here is reachable as a guest.
router.use(requireAuth);

const BOOKING_COLUMNS = `
  b.id, b.user_id, b.code, b.date, b.time, b.status, b.total_price, b.note, b.payment_method,
  sv.id AS service_id, sv.name AS service_name, sv.duration_min AS service_duration,
  s.id AS salon_id, s.slug AS salon_slug, s.name AS salon_name, s.address AS salon_address,
  s.phone AS salon_phone, s.image AS salon_image, s.lat AS salon_lat, s.lng AS salon_lng,
  st.id AS staff_id, st.name AS staff_name
`;

// staff is LEFT JOINed: a booking without a chosen technician is valid.
const BOOKING_FROM = `
  FROM bookings b
  JOIN services sv ON sv.id = b.service_id
  JOIN salons s ON s.id = b.salon_id
  LEFT JOIN staff st ON st.id = b.staff_id
`;

const selectService = db.prepare(
  'SELECT id, salon_id, name, price, duration_min, active FROM services WHERE id = ?',
);
const selectPromotion = db.prepare(
  'SELECT code, salon_id, discount_percent, discount_amount, active, starts_at, ends_at FROM promotions WHERE code = ?',
);
const selectSalonStaff = db.prepare('SELECT id FROM staff WHERE id = ? AND salon_id = ?');
const selectStaffService = db.prepare(
  'SELECT 1 FROM staff_services WHERE staff_id = ? AND service_id = ?',
);
// Also used inside transactions, so the text is kept alongside the pool statement.
const SELECT_BOOKING = `SELECT ${BOOKING_COLUMNS} ${BOOKING_FROM} WHERE b.id = ?`;
const selectBooking = db.prepare(SELECT_BOOKING);
const INSERT_BOOKING = `
  INSERT INTO bookings
    (user_id, salon_id, service_id, staff_id, code, date, time, status, note, total_price,
     customer_name, customer_phone, payment_method, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
`;
const CANCEL_BOOKING = "UPDATE bookings SET status = 'cancelled', note = ? WHERE id = ?";

// The status filters double as the sort order: only "upcoming" reads forwards in time.
// Fragments are constants picked by key, never assembled from request text.
const MINE_FILTERS = {
  upcoming: {
    where: "b.date >= ? AND b.status IN ('pending', 'confirmed')",
    order: 'b.date ASC, b.time ASC',
    fromToday: true,
  },
  completed: { where: "b.status = 'completed'", order: 'b.date DESC, b.time DESC' },
  cancelled: { where: "b.status = 'cancelled'", order: 'b.date DESC, b.time DESC' },
};
const ALL_BOOKINGS_FILTER = { where: '1 = 1', order: 'b.date DESC, b.time DESC' };

/** Positive integer from a body/query value, or null when it is absent or malformed. */
function toId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** '2026-08-12' -> '12/08/2026', the format the app shows Vietnamese customers. */
function formatDate(date) {
  return date.split('-').reverse().join('/');
}

function toBookingCard(row) {
  return {
    id: row.id,
    code: row.code,
    date: row.date,
    time: row.time,
    status: row.status,
    total_price: row.total_price,
    service: { id: row.service_id, name: row.service_name, duration_min: row.service_duration },
    salon: {
      id: row.salon_id,
      slug: row.salon_slug,
      name: row.salon_name,
      address: row.salon_address,
      phone: row.salon_phone,
      image: row.salon_image,
    },
    staff: row.staff_id ? { id: row.staff_id, name: row.staff_name } : null,
  };
}

/** The card plus the fields only the detail screen needs. */
function toBookingDetail(row) {
  const card = toBookingCard(row);
  return {
    ...card,
    note: row.note,
    payment_method: row.payment_method,
    salon: { ...card.salon, lat: row.salon_lat, lng: row.salon_lng },
  };
}

/**
 * A promotion is usable only when it is active today and either platform-wide or owned by
 * the salon being booked. Anything else is rejected instead of silently ignored, so the
 * customer never sees a total that quietly dropped their code.
 */
async function requireUsablePromotion(code, salonId) {
  const promotion = await selectPromotion.get(code.trim());
  const today = todayISO();
  const usable =
    promotion &&
    promotion.active === 1 &&
    (!promotion.starts_at || promotion.starts_at <= today) &&
    (!promotion.ends_at || today <= promotion.ends_at) &&
    (promotion.salon_id === null || promotion.salon_id === salonId);

  if (!usable) {
    throw httpError(400, 'INVALID_PROMOTION', 'Mã ưu đãi không hợp lệ hoặc đã hết hạn.');
  }
  return promotion;
}

/**
 * The single source of truth for what a booking costs. GET /quote shows it and POST /
 * recomputes it, so a client cannot book at a price it made up.
 *
 * Money is whole đồng: the percentage discount is floored so rounding can never hand out
 * a fraction of a đồng, and the total is clamped at 0 for a discount larger than the price.
 */
async function buildQuote(service, staffId, promotionCode) {
  const items = [{ label: service.name, amount: service.price ?? 0 }];

  if (staffId !== null) {
    items.push({ label: 'Phụ phí kỹ thuật viên', amount: STAFF_SURCHARGE });
  }

  if (promotionCode) {
    const promotion = await requireUsablePromotion(promotionCode, service.salon_id);
    const discount =
      promotion.discount_percent !== null
        ? Math.floor(((service.price ?? 0) * promotion.discount_percent) / 100)
        : promotion.discount_amount ?? 0;
    if (discount > 0) {
      items.push({ label: `Ưu đãi ${promotion.code}`, amount: -discount });
    }
  }

  const total = items.reduce((sum, item) => sum + item.amount, 0);
  return { items, total: Math.max(0, total) };
}

/** Minutes from now until a local 'YYYY-MM-DD' + 'HH:MM' start. Negative once it has passed. */
function minutesUntilStart(date, time) {
  const [year, month, day] = date.split('-').map(Number);
  const [hours, minutes] = time.split(':').map(Number);
  return (new Date(year, month - 1, day, hours, minutes).getTime() - Date.now()) / 60000;
}

// Registered before GET /:id, otherwise Express matches 'quote' and 'mine' as booking ids.
router.get('/quote', async (req, res, next) => {
  try {
    const serviceId = toId(req.query.service_id);
    if (serviceId === null) {
      throw httpError(400, 'VALIDATION_ERROR', 'Vui lòng chọn dịch vụ cần báo giá.');
    }

    const service = await selectService.get(serviceId);
    if (!service) {
      throw httpError(404, 'NOT_FOUND', 'Không tìm thấy dịch vụ.');
    }

    // A repeated query parameter arrives as an array, which requireUsablePromotion
    // would trim; the same check POST / already makes on the body.
    const promotionCode = req.query.promotion_code;
    if (promotionCode != null && typeof promotionCode !== 'string') {
      throw httpError(400, 'VALIDATION_ERROR', 'Mã ưu đãi phải là chuỗi ký tự.');
    }

    res.json({
      success: true,
      data: await buildQuote(service, toId(req.query.staff_id), promotionCode),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/mine', async (req, res, next) => {
  try {
    // Object.hasOwn, so a status like "constructor" cannot reach an inherited member
    // and put `undefined` into the WHERE clause.
    const filter = Object.hasOwn(MINE_FILTERS, req.query.status)
      ? MINE_FILTERS[req.query.status]
      : ALL_BOOKINGS_FILTER;
    const { page, limit, offset } = parsePagination(req.query, DEFAULT_PAGE_SIZE);
    const params = filter.fromToday ? [req.user.id, todayISO()] : [req.user.id];

    const total = (
      await db
        .prepare(`SELECT COUNT(*) AS count FROM bookings b WHERE b.user_id = ? AND ${filter.where}`)
        .get(...params)
    ).count;

    const rows = await db
      .prepare(
        `SELECT ${BOOKING_COLUMNS} ${BOOKING_FROM}
         WHERE b.user_id = ? AND ${filter.where}
         ORDER BY ${filter.order}
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);

    res.json({
      success: true,
      data: rows.map(toBookingCard),
      meta: { page, limit, total },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const {
      salon_id: salonIdInput,
      service_id: serviceIdInput,
      staff_id: staffIdInput,
      date,
      time,
      note,
      payment_method: paymentMethodInput,
      promotion_code: promotionCode,
      customer_name: customerName,
      customer_phone: customerPhone,
    } = req.body ?? {};

    for (const value of [note, promotionCode, customerName, customerPhone]) {
      if (value != null && typeof value !== 'string') {
        throw httpError(400, 'VALIDATION_ERROR', 'Ghi chú và thông tin liên hệ phải là chuỗi ký tự.');
      }
    }

    const salonId = toId(salonIdInput);
    const serviceId = toId(serviceIdInput);
    if (salonId === null || serviceId === null) {
      throw httpError(400, 'VALIDATION_ERROR', 'Vui lòng chọn salon và dịch vụ.');
    }

    // Trusting salon_id from the body would let a caller book a service under another
    // salon's name, so the service's own salon_id is the authority.
    const service = await selectService.get(serviceId);
    if (!service || service.salon_id !== salonId) {
      throw httpError(400, 'VALIDATION_ERROR', 'Dịch vụ không thuộc salon đã chọn.');
    }
    // "Tạm ẩn dịch vụ" is the salon's alternative to deleting one, so a hidden
    // service must stop taking bookings, not just drop out of the listings.
    if (service.active !== 1) {
      throw httpError(400, 'VALIDATION_ERROR', 'Dịch vụ này hiện không nhận đặt lịch.');
    }

    // Dates only: a booking later today is still in the future for the customer, and the
    // cancel window is what protects the salon from a last-minute change.
    if (!isISODate(date) || date < todayISO()) {
      throw httpError(400, 'VALIDATION_ERROR', 'Ngày hẹn không hợp lệ hoặc đã qua.');
    }
    if (!isHHMM(time)) {
      throw httpError(400, 'VALIDATION_ERROR', 'Giờ hẹn không hợp lệ.');
    }

    let staffId = null;
    if (staffIdInput != null) {
      staffId = toId(staffIdInput);
      if (staffId === null || !(await selectSalonStaff.get(staffId, salonId))) {
        throw httpError(400, 'VALIDATION_ERROR', 'Kỹ thuật viên không thuộc salon đã chọn.');
      }

      if (!(await selectStaffService.get(staffId, serviceId))) {
        throw httpError(
          400,
          'VALIDATION_ERROR',
          'Kỹ thuật viên này không thực hiện dịch vụ đã chọn.',
        );
      }

      // That technician's OWN calendar. getServiceSlots ORs availability across every
      // staff who performs the service, so it answers "is somebody free?" — using it
      // here let two customers book the same person at the same time.
      const slot = (await getStaffSlots(staffId, serviceId, date)).find(
        (candidate) => candidate.time === time,
      );
      if (!slot || !slot.available) {
        throw httpError(409, 'SLOT_TAKEN', 'Khung giờ này vừa có người đặt, vui lòng chọn giờ khác.');
      }
    }

    const paymentMethod = paymentMethodInput ?? 'at_salon';
    if (!PAYMENT_METHODS.includes(paymentMethod)) {
      throw httpError(400, 'VALIDATION_ERROR', 'Hình thức thanh toán không hợp lệ.');
    }

    // Recomputed here rather than read from the body: the client is never the price authority.
    const { total } = await buildQuote(service, staffId, promotionCode);
    const createdAt = new Date().toISOString();

    // The transaction sits INSIDE the code retry: a duplicate code aborts the whole
    // Postgres transaction, so each attempt has to start a fresh one.
    let booking;
    try {
      await withBookingCode((generated) =>
        db.withTransaction(async (tx) => {
          const bookingId = Number(
            (
              await tx.run(
                INSERT_BOOKING,
                req.user.id,
                salonId,
                serviceId,
                staffId,
                generated,
                date,
                time,
                note ?? null,
                total,
                customerName ?? req.user.name,
                customerPhone ?? req.user.phone,
                paymentMethod,
                createdAt,
              )
            ).lastInsertRowid,
          );

          booking = await tx.get(SELECT_BOOKING, bookingId);
          await notifyUser(
            tx,
            req.user.id,
            'Đặt lịch thành công',
            `Lịch hẹn ${generated} tại ${booking.salon_name} ngày ${formatDate(date)} lúc ${time} đã được ghi nhận.`,
            'booking',
          );
        }),
      );
    } catch (error) {
      // The idx_bookings_slot backstop: a second customer slipped past the availability
      // pre-check while this request awaited. Same answer as the pre-check. A duplicate
      // CODE (bookings_code_key) never reaches here — withBookingCode retries it.
      if (error.code === '23505' && error.constraint === 'idx_bookings_slot') {
        throw httpError(409, 'SLOT_TAKEN', 'Khung giờ này vừa có người đặt, vui lòng chọn giờ khác.');
      }
      throw error;
    }

    res.json({ success: true, data: toBookingDetail(booking) });
  } catch (error) {
    next(error);
  }
});

/** Load a booking the caller is allowed to see, or throw 404/403. */
async function ownedBooking(req) {
  const id = toId(req.params.id);
  const booking = id === null ? undefined : await selectBooking.get(id);
  if (!booking) {
    throw httpError(404, 'NOT_FOUND', 'Không tìm thấy lịch hẹn.');
  }
  // 403, not 404: the id is real, the caller simply does not own it.
  if (booking.user_id !== req.user.id) {
    throw httpError(403, 'FORBIDDEN', 'Bạn không có quyền truy cập lịch hẹn này.');
  }
  return booking;
}

router.get('/:id', async (req, res, next) => {
  try {
    res.json({ success: true, data: toBookingDetail(await ownedBooking(req)) });
  } catch (error) {
    next(error);
  }
});

router.patch('/:id/cancel', async (req, res, next) => {
  try {
    const booking = await ownedBooking(req);
    const { reason } = req.body ?? {};
    if (reason != null && typeof reason !== 'string') {
      throw httpError(400, 'VALIDATION_ERROR', 'Lý do huỷ phải là chuỗi ký tự.');
    }

    if (booking.status !== 'pending' && booking.status !== 'confirmed') {
      throw httpError(400, 'INVALID_STATUS', 'Lịch hẹn này không thể huỷ.');
    }
    if (minutesUntilStart(booking.date, booking.time) < CANCEL_WINDOW_HOURS * MINUTES_PER_HOUR) {
      throw httpError(
        400,
        'CANCEL_WINDOW',
        `Vui lòng huỷ trước giờ hẹn ít nhất ${CANCEL_WINDOW_HOURS} tiếng.`,
      );
    }

    // Appended, not replaced: the customer's original request stays readable for the salon.
    const cancelNote = reason ? `Lý do huỷ: ${reason}` : null;
    const note = [booking.note, cancelNote].filter(Boolean).join('\n') || null;

    await db.withTransaction(async (tx) => {
      await tx.run(CANCEL_BOOKING, note, booking.id);
      await notifyUser(
        tx,
        req.user.id,
        'Đã huỷ lịch hẹn',
        `Lịch hẹn ${booking.code} tại ${booking.salon_name} ngày ${formatDate(booking.date)} lúc ${booking.time} đã được huỷ.`,
        'booking',
      );
    });

    res.json({ success: true, data: toBookingDetail(await selectBooking.get(booking.id)) });
  } catch (error) {
    next(error);
  }
});

export default router;
