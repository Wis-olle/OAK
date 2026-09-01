// Customer bookings: price quote, create, list, detail, reschedule, cancel.
import express from 'express';
import { db } from '../db.js';
import {
  getStaffSlots,
  isSalonOpenFor,
  lockSalonDay,
  pickAvailableStaff,
  respectsLeadTime,
  staffCanDo,
  staffClashAt,
  timeOffOn,
} from '../lib/availability.js';
import { withBookingCode } from '../lib/booking-code.js';
import { notifyStaff, notifyUser } from '../lib/notify.js';
import { parsePagination } from '../lib/query.js';
import { fromMinutes, isHHMM, isISODate, nowMinutes, toMinutes, todayISO, vnNow } from '../lib/time.js';
import { httpError, requireAuth } from '../middleware/auth.js';

const router = express.Router();

// Reserved line in the quote: the product decides per-staff pricing later, and having the
// line already wired means adding a price is a one-constant change, not a shape change.
const STAFF_SURCHARGE = 0;
// What a salon that has never opened its settings still promises. The column carries the
// same default, so this only stands in for a row written before the column existed.
const DEFAULT_CANCEL_WINDOW_HOURS = 2;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const PAYMENT_METHODS = ['at_salon', 'online'];
const DEFAULT_PAGE_SIZE = 10;

// Every booking belongs to exactly one customer, so nothing here is reachable as a guest.
router.use(requireAuth);

const BOOKING_COLUMNS = `
  b.id, b.user_id, b.code, b.date, b.time, b.status, b.total_price, b.note, b.payment_method,
  b.auto_closed, b.customer_name, b.customer_phone,
  sv.id AS service_id, sv.name AS service_name, sv.duration_min AS service_duration,
  s.id AS salon_id, s.slug AS salon_slug, s.name AS salon_name, s.address AS salon_address,
  s.phone AS salon_phone, s.image AS salon_image, s.lat AS salon_lat, s.lng AS salon_lng,
  s.owner_id AS salon_owner_id,
  s.cancel_cutoff_hours AS salon_cancel_cutoff_hours,
  s.cancel_policy_text AS salon_cancel_policy_text,
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
  'SELECT code, salon_id, type, discount_percent, discount_amount, active, starts_at, ends_at FROM promotions WHERE code = ?',
);
// active = 1: a technician who has left keeps her row for the sake of the bookings and
// reviews that point at it, and without this clause a customer holding an old link could
// still name her — the one thing a departure is supposed to have stopped.
const selectSalonStaff = db.prepare(
  'SELECT id FROM staff WHERE id = ? AND salon_id = ? AND active = 1',
);
const selectSalonAutoConfirm = db.prepare('SELECT auto_confirm FROM salons WHERE id = ?');
// Whether the salon is on the public side at all. A booking is made from a link, and links
// outlive the switch: a favourite, a bookmark or a search result cached an hour before the
// owner hid the salon all still lead here.
const selectSalonListing = db.prepare('SELECT published, verified FROM salons WHERE id = ?');
// Also used inside transactions, so the text is kept alongside the pool statement.
const SELECT_BOOKING = `SELECT ${BOOKING_COLUMNS} ${BOOKING_FROM} WHERE b.id = ?`;
const selectBooking = db.prepare(SELECT_BOOKING);
// source 'customer' is a literal in the column list, like the statuses the console writes:
// this route is the one place a booking is made by the person who will sit in the chair, so
// it is a property of the route and never of the request.
const INSERT_BOOKING = `
  INSERT INTO bookings
    (user_id, salon_id, service_id, staff_id, code, date, time, status, note, total_price,
     customer_name, customer_phone, payment_method, source, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'customer', ?)
`;
const CANCEL_BOOKING = "UPDATE bookings SET status = 'cancelled', note = ? WHERE id = ?";
// The same write, refusing a row that is no longer live. A reschedule retires the old
// appointment under a lock held over the day it is moving TO, which is not always the day
// that appointment sits on — so "nothing changed" means the console settled it while this
// move was being made, and the move has to come apart rather than cancel a finished visit.
const RETIRE_BOOKING = `${CANCEL_BOOKING} AND status IN ('pending', 'confirmed')`;
// What a move says when the appointment it was built from is no longer that appointment.
// One sentence for both places that can find out, because it is one thing that happened.
const BOOKING_CHANGED_MESSAGE =
  'Lịch hẹn này vừa được cập nhật, vui lòng mở lại danh sách và thử lại.';

// The one appointment the header strip and the "Lịch kế tiếp" band name, answered as part
// of GET /api/auth/me so a page load asks once rather than three times. Stricter than the
// "upcoming" tab below on purpose: that tab keeps a visit that has already started, because
// the customer sitting in the chair must be able to find it, while a strip announcing "Bạn
// có lịch 09:00 hôm nay" at eight in the evening is simply wrong. Same reading of "still to
// come" as minutesUntilStart below, in SQL.
const SELECT_NEXT_BOOKING = `
  SELECT ${BOOKING_COLUMNS} ${BOOKING_FROM}
  WHERE b.user_id = ? AND b.status IN ('pending', 'confirmed')
    AND (b.date > ? OR (b.date = ? AND b.time > ?))
  ORDER BY b.date ASC, b.time ASC
  LIMIT 1
`;
const selectNextBooking = db.prepare(SELECT_NEXT_BOOKING);

// The status filters double as the sort order: only "upcoming" reads forwards in time.
// Fragments are constants picked by key, never assembled from request text.
const MINE_FILTERS = {
  upcoming: {
    /* The whole of today, in Vietnam time, and not only the hours it has left. An
       appointment at 09:00 read at 09:20 is under way, not over: it was in no tab at all
       once — past holds only what has closed out — so a customer sitting in the chair
       could not find the booking they were sitting in. It stays here until the tick
       (lib/tick.js) settles it the day after. What the customer may still DO with it
       is a separate question, and the screens ask it separately: an appointment that has
       started offers neither Hủy nor Đổi lịch. */
    where: "b.date >= ? AND b.status IN ('pending', 'confirmed')",
    order: 'b.date ASC, b.time ASC',
    fromToday: true,
  },
  completed: { where: "b.status = 'completed'", order: 'b.date DESC, b.time DESC' },
  /* Both ways an appointment closes out, which is what the customer's "Đã qua" tab shows,
     AND the day that has gone by which nothing has closed out yet. That last clause is here
     because the closing is a clock's job now (lib/tick.js) rather than something this very
     request does: for up to ten minutes a booking can be neither upcoming — the tab above
     starts at today — nor closed, and without this it would be in no tab at all, which is
     precisely the disappearance the "upcoming" comment above describes from the other side.
     The next tick settles it, and the row simply stops being matched by this clause and
     starts being matched by the first one. The card reads sensibly in the meantime: it is
     shown under its real status, and lich-hen-cua-toi.html offers Hủy and Đổi lịch only on
     the upcoming tab, so nothing here invites an action on a day already gone.

     Still a key of its own rather than a widening of `completed`: the review gates on the
     home, salon and service pages ask for that one, and a visit that never happened — or has
     not yet been said to have happened — is not a visit to review. */
  past: {
    where:
      "(b.status IN ('completed', 'no_show') OR (b.date < ? AND b.status IN ('pending', 'confirmed')))",
    order: 'b.date DESC, b.time DESC',
    fromToday: true,
  },
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
      // The cancel deadline the customer's own screens count down to. Per salon, so the
      // card cannot promise a window the server would refuse.
      cancel_cutoff_hours: cancelWindowHours(row),
      cancel_policy_text: row.salon_cancel_policy_text ?? null,
    },
    staff: row.staff_id ? { id: row.staff_id, name: row.staff_name } : null,
    // True when the tick (lib/tick.js) is what ended this booking, not the salon: the
    // card then says so instead of implying somebody looked at it.
    auto: Boolean(row.auto_closed),
  };
}

/**
 * The card plus the fields only the detail screen needs.
 *
 * The contact pair is in here and not on the card: it is the name and number the salon was
 * given for this one visit, which the account may since have changed, and every route that
 * answers a detail has already established that the caller owns the row. The wizard reads
 * it back when a booking is being MOVED — the move carries those two over, so showing them
 * is showing what will happen, and asking for them again would be asking twice.
 */
function toBookingDetail(row) {
  const card = toBookingCard(row);
  return {
    ...card,
    note: row.note,
    payment_method: row.payment_method,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
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
  // A combo is priced as a service of its own, not as a discount on another one: its price
  // is already the bundle price, so applying it as a code would take the saving twice.
  if (promotion.type === 'combo') {
    throw httpError(
      400,
      'INVALID_PROMOTION',
      'Combo được đặt như một dịch vụ, không dùng như mã giảm giá.',
    );
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

/** The salon's own free-cancellation window, in hours, from a joined booking row. */
function cancelWindowHours(row) {
  return row.salon_cancel_cutoff_hours ?? DEFAULT_CANCEL_WINDOW_HOURS;
}

/**
 * Minutes from now until a 'YYYY-MM-DD' + 'HH:MM' start, in Vietnam time. Negative once
 * it has passed.
 *
 * Both sides are read in the salon's own zone, not the container's: on a UTC host the
 * server clock is seven hours behind the customer's, and this is what decides whether a
 * cancellation still falls inside the salon's free window.
 */
function minutesUntilStart(date, time) {
  const days =
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${todayISO()}T00:00:00Z`)) / MS_PER_DAY;
  return days * MINUTES_PER_DAY + (toMinutes(time) ?? 0) - nowMinutes();
}

/**
 * The card for `userId`'s next appointment, or null when there is none to come.
 *
 * Exported for GET /api/auth/me, which carries it so that a signed-in page load asks the
 * server once instead of three times. It lives here rather than in auth.js because the card
 * shape and the columns behind it are this file's, and a second copy of either is a second
 * thing to drift.
 */
export async function nextBookingFor(userId) {
  // One reading of the clock, not two: todayISO() and nowMinutes() asked separately can
  // straddle midnight and answer with a moment that never happened.
  const { today, now } = vnNow();
  const row = await selectNextBooking.get(userId, today, today, fromMinutes(now));
  return row ? toBookingCard(row) : null;
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
    const today = todayISO();
    const params = filter.fromToday ? [req.user.id, today] : [req.user.id];

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

/**
 * Everything that has to be true before a booking row is written, asked on the pool.
 *
 * Lifted out of POST / whole, because moving an appointment asks exactly these questions
 * of the hour it is moving to: the salon still has to be listed, open, off nobody's day
 * off and given its lead time, and the technician still has to do that service and be
 * free. A reschedule that carried its own copy of the list would be a second list to
 * drift, and the one that drifted would be the one nobody looked at.
 *
 * Answers a plan rather than writing anything: the row itself is insertBookingIn()'s, on
 * the caller's transaction and under the lock the caller holds.
 *
 * The two options are the move's. `exceptBookingId` is the appointment being moved, which
 * must not be counted busy against the hour it is moving to; `knownTotal` is the price
 * already agreed, which stands in for a quote — the work is the same work, and the code
 * that bought a discount is not on the row to apply again.
 */
async function validateBookingRequest(
  user, body, { exceptBookingId = null, knownTotal = null } = {},
) {
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
  } = body;

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
  /* The same switch every public listing reads (routes/salons.js, routes/search.js,
     routes/services.js), asked here too because this route is reachable without any of
     them: a salon that has switched itself off — or been unpublished automatically when a
     write left it short — went on taking bookings from every link already handed out, and
     its owner would find them in a console they had deliberately taken off the market. */
  const listing = await selectSalonListing.get(salonId);
  if (listing.published !== 1 || listing.verified !== 1) {
    throw httpError(400, 'SALON_UNLISTED', 'Salon này hiện không nhận đặt lịch qua OAK.');
  }

  if (!isISODate(date) || date < todayISO()) {
    throw httpError(400, 'VALIDATION_ERROR', 'Ngày hẹn không hợp lệ hoặc đã qua.');
  }
  if (!isHHMM(time)) {
    throw httpError(400, 'VALIDATION_ERROR', 'Giờ hẹn không hợp lệ.');
  }
  // Today is a valid date but only the hours it has left: an hour that has already
  // started is as booked-in-the-past as yesterday is. Later days skip this entirely.
  if (date === todayISO() && toMinutes(time) <= nowMinutes()) {
    throw httpError(400, 'VALIDATION_ERROR', 'Giờ hẹn hôm nay đã qua, vui lòng chọn giờ khác.');
  }
  // Ahead of the technician block, so it covers the walk-in path too: a booking with
  // no technician reaches no slot check at all, and would otherwise take a day the
  // salon has declared closed. For a named technician the clamped slots already say
  // the same thing, but saying it here answers "the salon is shut" rather than the
  // SLOT_TAKEN below, which would claim somebody else just took the hour.
  if (!(await isSalonOpenFor(salonId, date, time, service.duration_min))) {
    throw httpError(400, 'VALIDATION_ERROR', 'Salon không mở cửa vào thời điểm này.');
  }
  // A declared day off is not a full calendar, so it answers 409 with its own reason
  // rather than the SLOT_TAKEN below, which would send the customer hunting for an hour.
  // Read once here and consulted again for the named technician further down.
  const off = await timeOffOn(salonId, date);
  if (off.salon) {
    throw httpError(409, 'SALON_CLOSED', 'Salon nghỉ vào ngày này, vui lòng chọn ngày khác.');
  }
  // The salon's lead time, asked here because a booking with no technician reaches no
  // slot list to have been filtered by it.
  if (!(await respectsLeadTime(salonId, date, time))) {
    throw httpError(
      400,
      'LEAD_TIME',
      'Salon cần được báo trước lâu hơn cho khung giờ này, vui lòng chọn giờ khác.',
    );
  }

  let staffId = null;
  if (staffIdInput != null) {
    staffId = toId(staffIdInput);
    // One answer for a technician at another salon and for one who no longer works at
    // this one: from out here both are simply not somebody this salon can be booked with,
    // and telling them apart would say who used to work where.
    if (staffId === null || !(await selectSalonStaff.get(staffId, salonId))) {
      throw httpError(
        400,
        'VALIDATION_ERROR',
        'Kỹ thuật viên này hiện không nhận lịch tại salon đã chọn.',
      );
    }

    // The rule, spelled once in lib/availability.js: no staff_services row, no booking.
    if (!(await staffCanDo(db, staffId, serviceId))) {
      throw httpError(
        400,
        'VALIDATION_ERROR',
        'Kỹ thuật viên này không thực hiện dịch vụ đã chọn.',
      );
    }

    // Their own day off gets its own answer for the same reason the salon's does: the
    // slot list below is empty for that whole day, and SLOT_TAKEN would claim somebody
    // just took the hour rather than that this technician is away.
    if (off.staff.has(staffId)) {
      throw httpError(
        409,
        'STAFF_OFF',
        'Kỹ thuật viên này nghỉ vào ngày đã chọn, vui lòng chọn ngày hoặc kỹ thuật viên khác.',
      );
    }

    /* That technician's OWN calendar. getServiceSlots ORs availability across every
       staff who performs the service, so it answers "is somebody free?" — using it
       here let two customers book the same person at the same time.

       Read WITHOUT the appointment being moved, and the wizard's grid is read the same way
       (`?except`, routes/services.js and routes/staff.js): an hour half an hour after the
       customer's own booking overlaps nobody but themselves, and a check that counted it
       would refuse the most ordinary move there is. */
    const slot = (await getStaffSlots(staffId, serviceId, date, null, null, exceptBookingId))
      .find((candidate) => candidate.time === time);
    if (!slot || !slot.available) {
      throw httpError(409, 'SLOT_TAKEN', 'Khung giờ này vừa có người đặt, vui lòng chọn giờ khác.');
    }
  }

  const paymentMethod = paymentMethodInput ?? 'at_salon';
  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    throw httpError(400, 'VALIDATION_ERROR', 'Hình thức thanh toán không hợp lệ.');
  }

  // Recomputed here rather than read from the body: the client is never the price authority.
  const total = knownTotal ?? (await buildQuote(service, staffId, promotionCode)).total;
  // A salon that takes bookings automatically has already agreed to the hour its own
  // calendar offered, so the booking is confirmed on the spot and never joins the
  // console's "Cần xử lý" queue. A salon that turned that off still decides by hand.
  const autoConfirm = (await selectSalonAutoConfirm.get(salonId))?.auto_confirm === 1;

  return {
    userId: user.id,
    salonId,
    serviceId,
    service,
    staffId,
    date,
    time,
    note: note ?? null,
    total,
    autoConfirm,
    status: autoConfirm ? 'confirmed' : 'pending',
    paymentMethod,
    customerName: customerName ?? user.name,
    customerPhone: customerPhone ?? user.phone,
  };
}

/**
 * The row itself: the one place in this file a customer's booking is INSERTed.
 *
 * Runs on the caller's transaction, and the caller has already taken lockSalonDay() over
 * the salon's day — the calendar reads in here are the second look that the lock is what
 * makes worth taking, and a caller that skipped it would be back to the check-then-act
 * the lock exists to replace.
 *
 * `exceptBookingId` is the appointment being moved, which is never in its own way.
 */
async function insertBookingIn(tx, plan, code, exceptBookingId = null) {
  // The overlap the unique index cannot see: 10:00 and 10:30 of a 60-minute service
  // are two different minutes and one technician in two places. Both kinds of clash
  // are one answer to a customer — she is not the one who gets to overrule either.
  if (
    plan.staffId !== null &&
    (await staffClashAt(
      tx, plan.staffId, plan.date, plan.time, plan.service.duration_min, exceptBookingId,
    )) !== null
  ) {
    throw httpError(409, 'SLOT_TAKEN', 'Khung giờ này vừa có người đặt, vui lòng chọn giờ khác.');
  }

  /* "Bất kỳ" is a choice of nobody in particular, not a booking against nobody: the hour
     has to be held on somebody's calendar or the grid keeps offering it. Chosen in here, on
     this transaction and under the caller's lock, so the pick and the row it is written
     into cannot drift apart — and with the same exception, or a move of the customer's own
     hour would find the one technician it should have kept busy against herself. */
  const assigned =
    plan.staffId ??
    (await pickAvailableStaff(
      tx, plan.salonId, plan.serviceId, plan.date, plan.time, plan.service.duration_min,
      exceptBookingId,
    ));
  if (assigned === null) {
    throw httpError(409, 'SLOT_TAKEN', 'Khung giờ này vừa có người đặt, vui lòng chọn giờ khác.');
  }

  const bookingId = Number(
    (
      await tx.run(
        INSERT_BOOKING,
        plan.userId,
        plan.salonId,
        plan.serviceId,
        assigned,
        code,
        plan.date,
        plan.time,
        plan.status,
        plan.note,
        plan.total,
        plan.customerName,
        plan.customerPhone,
        plan.paymentMethod,
        new Date().toISOString(),
      )
    ).lastInsertRowid,
  );
  return { bookingId, assigned };
}

/**
 * The two races a write that holds an hour can lose, said the way the customer's screen
 * expects. Anything else comes back as it was.
 */
function placementError(error) {
  // The idx_bookings_slot backstop: a second customer slipped past the availability
  // pre-check while this request awaited. Same answer as the pre-check. A duplicate
  // CODE (bookings_code_key) never reaches here — withBookingCode retries it.
  if (error.code === '23505' && error.constraint === 'idx_bookings_slot') {
    return httpError(409, 'SLOT_TAKEN', 'Khung giờ này vừa có người đặt, vui lòng chọn giờ khác.');
  }
  // The salon's day was held by somebody else for longer than lockSalonDay waits. Not
  // the same thing as a taken hour, and it must not be said as one: nothing is booked,
  // and the same request a moment later is expected to work.
  if (error.code === '55P03') {
    return httpError(409, 'SLOT_BUSY', 'Salon đang nhận một lịch khác, thử lại sau vài giây.');
  }
  return error;
}

router.post('/', async (req, res, next) => {
  try {
    const plan = await validateBookingRequest(req.user, req.body ?? {});

    // The transaction sits INSIDE the code retry: a duplicate code aborts the whole
    // Postgres transaction, so each attempt has to start a fresh one.
    let booking;
    try {
      await withBookingCode((generated) =>
        db.withTransaction(async (tx) => {
          /* Before anything in here reads a calendar. The slot check above ran on the pool
             and answered the customer quickly, which is what it is for; between it and this
             INSERT another request can have taken the hour, and on a cold-started instance
             that is the ordinary case rather than the rare one. So the day is held, and then
             read again — the second reader now sees the first one's booking.

             The salon's day and not the technician's, even when the customer named her: the
             "Bất kỳ" branch cannot know whose day it is about to fill until it has read the
             whole roster, so a second key would leave those two writers racing each other on
             exactly the overlap this exists to stop. */
          await lockSalonDay(tx, plan.salonId, plan.date);
          const { bookingId, assigned } = await insertBookingIn(tx, plan, generated);

          booking = await tx.get(SELECT_BOOKING, bookingId);
          await notifyUser(
            tx,
            req.user.id,
            plan.autoConfirm ? 'Lịch hẹn đã được xác nhận' : 'Đã ghi nhận yêu cầu đặt lịch',
            plan.autoConfirm
              ? `Lịch hẹn ${generated} tại ${booking.salon_name} ngày ${formatDate(plan.date)} lúc ${plan.time} đã được xác nhận.`
              : `Lịch hẹn ${generated} tại ${booking.salon_name} ngày ${formatDate(plan.date)} lúc ${plan.time} đã được ghi nhận.`,
            'booking',
            bookingId,
          );
          // And the salon owner. When the salon confirms by hand this is the only prompt
          // that the booking is sitting there; when it confirms itself the owner is still
          // told, because an hour just left their calendar. notifyUser no-ops on a salon
          // with no owner account.
          await notifyUser(
            tx,
            booking.salon_owner_id,
            plan.autoConfirm ? 'Lịch hẹn mới' : 'Lịch hẹn mới cần xác nhận',
            plan.autoConfirm
              ? `Khách đã đặt lịch hẹn ${generated} ngày ${formatDate(plan.date)} lúc ${plan.time}, đã tự động xác nhận.`
              : `Khách đã đặt lịch hẹn ${generated} ngày ${formatDate(plan.date)} lúc ${plan.time}, đang chờ bạn xác nhận.`,
            'booking',
            bookingId,
          );
          /* And the technician whose day this hour just came out of. `assigned` rather than
             `plan.staffId`, so the "Bất kỳ" auto-pick is covered too: the customer chose
             nobody in particular, but somebody is now expected at that hour and it is their
             calendar that says so. notifyStaff no-ops on a row nobody has claimed. */
          await notifyStaff(
            tx,
            assigned,
            'Lịch hẹn mới trên lịch của bạn',
            `Khách đã đặt lịch hẹn ${generated} tại ${booking.salon_name} ngày ${formatDate(plan.date)} lúc ${plan.time}.`,
            bookingId,
          );
        }),
      );
    } catch (error) {
      throw placementError(error);
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
      throw httpError(400, 'VALIDATION_ERROR', 'Lý do hủy phải là chuỗi ký tự.');
    }
    // The same ceiling the dialog's textarea carries, asked again here: the note it lands
    // in is rendered in the partner console, and only the client enforces maxlength.
    if (reason && reason.length > 200) {
      throw httpError(400, 'VALIDATION_ERROR', 'Lý do hủy tối đa 200 ký tự.');
    }

    if (booking.status !== 'pending' && booking.status !== 'confirmed') {
      throw httpError(400, 'INVALID_STATUS', 'Lịch hẹn này không thể hủy.');
    }
    const cutoffHours = cancelWindowHours(booking);
    if (minutesUntilStart(booking.date, booking.time) < cutoffHours * MINUTES_PER_HOUR) {
      throw httpError(
        409,
        'CANCEL_WINDOW',
        `Salon này nhận hủy online chậm nhất ${cutoffHours} tiếng trước giờ hẹn. Vui lòng liên hệ salon.`,
      );
    }

    // Appended, not replaced: the customer's original request stays readable for the salon.
    const cancelNote = reason ? `Lý do hủy: ${reason}` : null;
    const note = [booking.note, cancelNote].filter(Boolean).join('\n') || null;

    await db.withTransaction(async (tx) => {
      await tx.run(CANCEL_BOOKING, note, booking.id);
      await notifyUser(
        tx,
        req.user.id,
        'Đã hủy lịch hẹn',
        `Lịch hẹn ${booking.code} tại ${booking.salon_name} ngày ${formatDate(booking.date)} lúc ${booking.time} đã được hủy.`,
        'booking',
        booking.id,
      );
      await notifyUser(
        tx,
        booking.salon_owner_id,
        'Khách đã hủy lịch hẹn',
        `Khách đã hủy lịch hẹn ${booking.code} ngày ${formatDate(booking.date)} lúc ${booking.time}. Khung giờ này đã trống trở lại.`,
        'booking',
        booking.id,
      );
      // The technician loses the hour, so they are told as well as the salon: an appointment
      // that vanishes off a calendar without a word is one somebody turns up for.
      await notifyStaff(
        tx,
        booking.staff_id,
        'Một lịch hẹn đã bị hủy',
        `Khách đã hủy lịch hẹn ${booking.code} tại ${booking.salon_name} ngày ${formatDate(booking.date)} lúc ${booking.time}.`,
        booking.id,
      );
    });

    res.json({ success: true, data: toBookingDetail(await selectBooking.get(booking.id)) });
  } catch (error) {
    next(error);
  }
});

/**
 * Move an appointment: one act, and one transaction.
 *
 * This used to be two requests from the browser — book the new hour, then cancel the old
 * one — and the second of them could be refused on its own. A customer who moved an
 * appointment inside the salon's cancel window was left holding two live bookings and no
 * way to drop either from here, which is the worst of the three outcomes for everybody.
 *
 * So the cancel cutoff is not asked here. It is a rule about walking away, and a customer
 * who moves an appointment is not walking away: the salon keeps the visit, which is the
 * thing the window was protecting. What it must not become is a way to undo an hour that
 * is already happening, and that is asked instead.
 *
 * The new hour is validated exactly as a fresh booking is, lead time included — from out
 * here it IS a fresh booking. What comes along from the old one is what the customer is not
 * being asked again: the service, the number the salon was given, and the price already
 * agreed. The note comes along too unless the request sends one, because the wizard leaves
 * that box open — it is the one thing about a moved appointment a customer may want to say
 * differently.
 *
 * `staff_id` absent means "leave the technician alone" and an explicit null means "Bất kỳ".
 * The difference matters: a form that only meant to move the hour must not quietly re-chair
 * somebody, and a customer who really does want anyone has to be able to say so.
 *
 * Known and accepted: a move inside the cancel window followed by a cancel of the new
 * appointment — which starts far enough out to be cancellable — is a way around the salon's
 * cutoff. It costs two deliberate steps to reach what walking away reaches in one, and
 * closing it would take the honest reschedule down with it. Left open for now.
 */
router.patch('/:id/reschedule', async (req, res, next) => {
  try {
    const old = await ownedBooking(req);
    const body = req.body ?? {};
    const { date, time, note } = body;
    // Absent is not the same as null here — see the note above.
    const staffIdInput = Object.hasOwn(body, 'staff_id') ? body.staff_id : old.staff_id;

    if (old.status !== 'pending' && old.status !== 'confirmed') {
      throw httpError(400, 'INVALID_STATUS', 'Lịch hẹn này không thể đổi giờ.');
    }
    // The same line the customer's own list draws before it offers the button: an hour
    // that has begun is not one there is still a choice about.
    if (minutesUntilStart(old.date, old.time) <= 0) {
      throw httpError(
        400,
        'BOOKING_STARTED',
        'Lịch hẹn này đã bắt đầu, vui lòng liên hệ salon để thay đổi.',
      );
    }

    const plan = await validateBookingRequest(
      req.user,
      {
        salon_id: old.salon_id,
        service_id: old.service_id,
        staff_id: staffIdInput,
        date,
        time,
        note: note === undefined ? old.note : note,
        payment_method: old.payment_method,
        // The details the salon was given for this visit, not whatever the account says
        // today: a move is the same appointment, reached a different way.
        customer_name: old.customer_name,
        customer_phone: old.customer_phone,
      },
      { exceptBookingId: old.id, knownTotal: old.total_price },
    );

    let booking;
    try {
      await withBookingCode((generated) =>
        db.withTransaction(async (tx) => {
          /* The day being taken, and only that one — the same single key POST / and both
             counter doors take. The day being LEFT needs none: giving an hour back reads no
             calendar, and a second key here would be one more pair of writers to have to
             order against each other. What the old row does need is to still be the row
             this plan was built from, and that is asked directly instead. */
          await lockSalonDay(tx, plan.salonId, plan.date);

          /* So: the old appointment again, on this transaction. Everything above ran on the
             pool, and a salon console can have confirmed, moved, re-chaired or closed that
             appointment since. It matters more here than it would anywhere else, because
             the insert below excuses this row's hour from the calendar it reads — a row
             that has moved would have its hour excused from a day it is no longer on. */
          const current = await tx.get(SELECT_BOOKING, old.id);
          if (
            !current ||
            (current.status !== 'pending' && current.status !== 'confirmed') ||
            current.date !== old.date ||
            current.time !== old.time ||
            current.staff_id !== old.staff_id
          ) {
            throw httpError(409, 'BOOKING_CHANGED', BOOKING_CHANGED_MESSAGE);
          }

          // The row being moved is still live in here, and an appointment is never in its
          // own way — 10:00 to 10:30 on the same technician is a move, not a clash.
          const { bookingId, assigned } = await insertBookingIn(tx, plan, generated, old.id);
          /* And only now the old one goes, so nothing between these two lines can see the
             hour given back before the new one is held. Appended, not replaced: the
             customer's own words stay readable, and the salon looking at a cancelled row
             can see where the hour went rather than only that it left.

             Guarded on the status all the same, and a refusal takes the whole move down
             with it: the read above is a moment old, and a move that quietly cancelled a
             visit somebody had just completed would be worse than a move that never
             happened. */
          const { changes } = await tx.run(
            RETIRE_BOOKING,
            [old.note, `Đã đổi sang lịch hẹn ${generated}`].filter(Boolean).join('\n'),
            old.id,
          );
          if (changes === 0) {
            throw httpError(409, 'BOOKING_CHANGED', BOOKING_CHANGED_MESSAGE);
          }

          booking = await tx.get(SELECT_BOOKING, bookingId);
          const from = `ngày ${formatDate(old.date)} lúc ${old.time}`;
          const to = `ngày ${formatDate(plan.date)} lúc ${plan.time}`;
          await notifyUser(
            tx,
            req.user.id,
            'Lịch hẹn đã được dời',
            `Lịch hẹn ${old.code} ${from} đã được dời sang ${to}, mã mới ${generated}. ` +
              (plan.autoConfirm
                ? 'Lịch mới đã được xác nhận.'
                : 'Lịch mới đang chờ salon xác nhận.'),
            'booking',
            bookingId,
          );
          /* One notice to the salon, and not the cancellation's plus the new booking's: an
             owner told both reads two customers, one of whom walked — and would go looking
             for the hour to fill. What happened is that one appointment moved. */
          await notifyUser(
            tx,
            booking.salon_owner_id,
            'Khách đã dời lịch hẹn',
            `Khách đã dời lịch hẹn ${old.code} ${from} sang ${to}, mã mới ${generated}.`,
            'booking',
            bookingId,
          );
          /* And the calendars the hour came out of and went into. One sentence when the
             chair did not change and two when it did — the shape the console's own move
             draws (routes/partner.js), because a technician must hear about one event
             once. notifyStaff no-ops on a row nobody has claimed. */
          if (assigned === old.staff_id) {
            await notifyStaff(
              tx,
              assigned,
              'Một lịch hẹn đã đổi giờ',
              `Khách đã dời lịch hẹn ${old.code} tại ${booking.salon_name} ${from} sang ${to}, mã mới ${generated}.`,
              bookingId,
            );
          } else {
            await notifyStaff(
              tx,
              old.staff_id,
              'Lịch hẹn đã gỡ khỏi lịch của bạn',
              `Khách đã dời lịch hẹn ${old.code} tại ${booking.salon_name} ${from} sang một kỹ thuật viên khác.`,
              bookingId,
            );
            await notifyStaff(
              tx,
              assigned,
              'Lịch hẹn mới trên lịch của bạn',
              `Khách đã dời lịch hẹn ${generated} tại ${booking.salon_name} sang ${to}.`,
              bookingId,
            );
          }
        }),
      );
    } catch (error) {
      throw placementError(error);
    }

    // The appointment that no longer stands, named rather than left for the client to
    // work out: it asked to move one booking and is being handed a different id back.
    res.json({
      success: true,
      data: { ...toBookingDetail(booking), replaced_booking_id: old.id },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
