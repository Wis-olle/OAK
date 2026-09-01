// Partner console: overview, bookings, services, staff, promotions, revenue, salon.
import { randomBytes } from 'node:crypto';
import express from 'express';
import { db } from '../db.js';
import { getServiceSlots, getStaffSlots, isSalonOpenFor } from '../lib/availability.js';
import { withBookingCode } from '../lib/booking-code.js';
import { recordEvent } from '../lib/events.js';
import { notifyStaff, notifyUser } from '../lib/notify.js';
import { normalisePhone, normalisedPhoneSql } from '../lib/phone.js';
import { parseJsonArray, parsePagination } from '../lib/query.js';
import {
  SOCIAL_PROFILE_PLATFORMS,
  SocialProfileError,
  validateSocialProfile,
} from '../lib/social-profile.js';
import {
  END_STINT,
  INSERT_BOOKING_STAFF_CHANGE,
  departureDateOrThrow,
  restaffedNotice,
  sweepFutureBookings,
} from '../lib/staff-departure.js';
import {
  INSERT_STAFF_INVITE,
  INVITE_TTL_MS,
  RETIRE_STAFF_INVITES,
  inviteUrl,
} from '../lib/staff-invite.js';
import { RECOMPUTE_STAFF_RATING, tenureVerified } from '../lib/staff-stats.js';
import {
  addDaysISO,
  formatDateVN,
  fromMinutes,
  isHHMM,
  isISODate,
  nowMinutes,
  toMinutes,
  todayISO,
  weekdayOf,
} from '../lib/time.js';
import { isSafeMediaUrl } from '../lib/urls.js';
import { WELCOME_CODE_PREFIX } from '../lib/welcome-promotion.js';
import { httpError, requireAuth, requirePartner } from '../middleware/auth.js';
// The recovery hatch for a technician who has lost their password is auth.js's machinery —
// its table, its TTL, its origin rule, its mailer — so it is imported rather than rebuilt.
import { deliverResetLink, mintResetIn } from './auth.js';

const router = express.Router();

// One gate for the whole file: nothing below is reachable by a customer or a guest.
router.use(requireAuth, requirePartner);

const BOOKING_STATUSES = ['pending', 'confirmed', 'completed', 'cancelled', 'no_show'];
const SERVICE_CATEGORIES = ['hair', 'nail', 'skincare', 'spa', 'eyelash', 'amenity'];
const PROMOTION_TYPES = ['discount', 'combo', 'flash_sale'];

// The only transitions a partner may drive. completed/cancelled list nothing, so those
// two can never be reopened. 'no_show' is the exception on purpose: marking a customer
// absent is a judgement made at the counter and sometimes made too early, so the way back
// to 'confirmed' stays open as an Undo for as long as the salon needs it.
const STATUS_TRANSITIONS = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['completed', 'cancelled', 'no_show'],
  completed: [],
  cancelled: [],
  no_show: ['confirmed'],
};

const REVENUE_DEFAULT_DAYS = 30;
// What the settings form offers, and the only values the column accepts: an open list here
// would let a salon close its own calendar with a lead time of a year.
const LEAD_TIME_CHOICES = [0, 60, 120, 1440];
const CANCEL_CUTOFF_CHOICES = [2, 6, 12, 24, 48];
const CANCEL_POLICY_MAX = 200;
const PHOTO_CAPTION_MAX = 200;
const TIME_OFF_REASON_MAX = 200;
// A day-off row is a holiday or a sick leave, not a schedule: a long enough range is a
// roster change, and an unbounded one would quietly take the salon off OAK for good.
const TIME_OFF_MAX_DAYS = 90;
const VIP_COMPLETED_BOOKINGS = 3;
// The counter should be able to hold a seat before it knows who is sitting in it, so the
// name is what the console shows when nobody typed one.
const WALK_IN_NAME = 'Khách vãng lai';
const REPLY_TEXT_MAX = 1000;
const CUSTOMER_LIMIT = 50;
const CUSTOMER_HISTORY_LIMIT = 5;
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
async function ownedSalon(req) {
  const salon = await selectOwnedSalon.get(req.user.id);
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
async function ownedRow(statement, id, salonId, message) {
  const row = await statement.get(id, salonId);
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

/**
 * An optional image path that will be rendered back into a public <img>/:src binding.
 * Same guard, same message as the gallery-photo sink below and the avatar and post-image
 * sinks elsewhere: text is not enough, because 'javascript:…' is text too.
 */
function optionalMediaUrl(value, label) {
  const url = optionalText(value, label);
  if (!isSafeMediaUrl(url)) {
    throw httpError(400, 'VALIDATION_ERROR', 'Đường dẫn ảnh không hợp lệ.');
  }
  return url;
}

/** Optional free text with a ceiling, so a textarea cannot become an essay in the column. */
function optionalLimitedText(value, label, max) {
  const text = optionalText(value, label);
  if (text !== null && text.length > max) {
    throw httpError(400, 'VALIDATION_ERROR', `${label} tối đa ${max} ký tự.`);
  }
  return text;
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

/** Optional map coordinate. null and '' clear the column; out of range is a client error. */
function optionalCoordinate(value, label, limit) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < -limit || number > limit) {
    throw httpError(
      400,
      'VALIDATION_ERROR',
      `${label} phải là số trong khoảng -${limit} đến ${limit}.`,
    );
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

/** Optional ISO date. null and '' clear the column; anything else must be a real date. */
function optionalDate(value, label) {
  const text = optionalText(value, label);
  if (text !== null && !isISODate(text)) {
    throw httpError(400, 'VALIDATION_ERROR', `${label} phải theo định dạng YYYY-MM-DD.`);
  }
  return text;
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
 * Async because some parsers (booking service/staff) verify ownership in the database.
 *
 * `patch` is the same values keyed by column, for callers that have to compare what was
 * asked for against what the row already holds — the raw body cannot answer that, because
 * only the parsed value is in the shape the column is stored in.
 */
async function buildPatch(body, columns) {
  const assignments = [];
  const values = [];
  const patch = {};
  for (const [column, parse] of Object.entries(columns)) {
    if (Object.hasOwn(body, column)) {
      assignments.push(`"${column}" = ?`);
      patch[column] = await parse(body[column]);
      values.push(patch[column]);
    }
  }
  if (assignments.length === 0) {
    throw httpError(400, 'VALIDATION_ERROR', 'Không có thông tin nào để cập nhật.');
  }
  return { assignments, values, patch };
}

/** AVG() over an empty set is null; the dashboards want a number. */
function roundRating(value) {
  return value === null || value === undefined ? 0 : Math.round(value * 10) / 10;
}

/** Has this appointment's start time passed, in Vietnam time? */
function hasStarted(date, time) {
  const today = todayISO();
  return date < today || (date === today && toMinutes(time) <= nowMinutes());
}

// What the cancel dialog writes into the note, and the only line of it the customer is
// shown. Matched by its prefix rather than by position: the note also holds the customer's
// own request, and quoting that back as "the reason we cancelled" would be a lie.
//
// Both spellings of the word are accepted. Vietnamese puts the dấu on either vowel, the
// dialogs write 'Lý do hủy:' since Phase 4, and the rows written before that carry the
// other one. Matching only the settled spelling would not fail anywhere — it would quietly
// stop showing the customer the reason their appointment was cancelled.
const CANCEL_REASON_MATCH = /^Lý do h(?:ủy|uỷ):/;

function cancelReasonLine(note) {
  const line = String(note ?? '')
    .split('\n')
    .map((entry) => entry.trim())
    .reverse()
    .find((entry) => CANCEL_REASON_MATCH.test(entry));
  if (!line) {
    return null;
  }
  // The reason is a sentence in the middle of others, and a free-text note rarely ends in
  // a full stop — without one it runs straight into "Bạn có thể đặt lại…".
  return /[.!?]$/.test(line) ? line : `${line}.`;
}

/**
 * One phone number, one spelling — the same one lib/phone.js applies to sign-up and to
 * the profile, so a number typed at the counter and the same number typed into an account
 * are provably comparable. Empty stays null: a walk-in nobody named is not a customer to
 * be looked up later.
 */
function storedPhone(value) {
  const normalised = normalisePhone(value);
  return normalised === '' ? null : normalised;
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
    (SELECT COUNT(*) FROM bookings nb
      WHERE nb.user_id = b.user_id AND nb.salon_id = b.salon_id AND nb.status = 'no_show'
    ) AS no_show_count,
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
      // Walk-ins carry no account, so nothing groups their history: the count is about
      // this salon's own record of one signed-in customer.
      no_show_count: row.no_show_count ?? 0,
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
    sort_order: row.sort_order,
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

async function salonShape(row) {
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
    // The pair is the whole-week summary of `hours`, kept for the calendar grid and
    // the older consumers that never learned about per-weekday opening times.
    open_time: row.open_time,
    close_time: row.close_time,
    hours: await selectSalonHours.all(row.id),
    lat: row.lat,
    lng: row.lng,
    verified: row.verified,
    featured: row.featured,
    flagship: row.flagship,
    tags: parseJsonArray(row.tags),
    amenities: parseJsonArray(row.amenities),
    tour_url: row.tour_url,
    // Whether the public side of the platform lists this salon at all.
    published: row.published,
    // How this salon takes online bookings. The customer-facing pages read the last two
    // as well, so the wording a visitor sees is the salon's own rather than the platform's.
    auto_confirm: row.auto_confirm,
    lead_time_min: row.lead_time_min,
    cancel_cutoff_hours: row.cancel_cutoff_hours,
    cancel_policy_text: row.cancel_policy_text,
    social_links: await socialLinksForSalon(row.id),
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
async function bookingWindowsByStaff(salonId, date) {
  const windows = new Map();
  for (const row of await selectDayBookingWindows.all(salonId, date)) {
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
// Postgres requires the derived table to carry an alias.
const selectNewCustomerCount = db.prepare(`
  SELECT COUNT(*) AS count FROM (
    SELECT user_id, MIN(date) AS first_date
    FROM bookings
    WHERE salon_id = ? AND user_id IS NOT NULL
    GROUP BY user_id
  ) AS first_bookings
  WHERE first_date = ?
`);
const selectSalonRating = db.prepare(
  'SELECT AVG(rating) AS average, COUNT(*) AS count FROM reviews WHERE salon_id = ?',
);
const selectActiveStaff = db.prepare(
  'SELECT id, name, image FROM staff WHERE salon_id = ? AND active = 1 ORDER BY id',
);

router.get('/overview', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const date = req.query.date ? requireDate(req.query.date, 'Ngày') : todayISO();
    const previousDate = addDaysISO(date, -1);

    const revenueToday = (await selectDayRevenue.get(salon.id, date)).revenue;
    const revenueYesterday = (await selectDayRevenue.get(salon.id, previousDate)).revenue;
    const rating = await selectSalonRating.get(salon.id);

    const windows = await bookingWindowsByStaff(salon.id, date);
    const minutes = nowMinutes();
    const staffStatus = (await selectActiveStaff.all(salon.id)).map((member) => ({
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
        bookings_today: (await selectDayBookingCount.get(salon.id, date)).count,
        // Counted from the requested day, so the whole card stays about that day.
        upcoming_count: (await selectUpcomingCount.get(salon.id, date)).count,
        new_customers: (await selectNewCustomerCount.get(salon.id, date)).count,
        rating_avg: roundRating(rating.average),
        review_count: rating.count,
        // What the rating card links into: how many of those reviews still owe an answer.
        unanswered_reviews: (await selectUnansweredReviews.get(salon.id)).count,
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
// Also read inside the status-change transaction, so the text is kept alongside.
const SELECT_OWNED_BOOKING_ROW = 'SELECT * FROM bookings WHERE id = ? AND salon_id = ?';
const selectOwnedBookingRow = db.prepare(SELECT_OWNED_BOOKING_ROW);
const selectOwnedService = db.prepare('SELECT * FROM services WHERE id = ? AND salon_id = ?');
const selectOwnedStaff = db.prepare('SELECT * FROM staff WHERE id = ? AND salon_id = ?');
// Whether a person stands behind the roster row a completed booking currently sits on.
// Not scoped to the salon: the booking has already been proved to be this owner's.
const selectClaimedStaffRow = db.prepare(
  'SELECT 1 FROM staff WHERE id = ? AND user_id IS NOT NULL',
);
// Runs inside the same transaction as the move it follows. A booking carries at most one
// review (idx_reviews_booking_id), and only a completed booking can have one at all. The
// audit row written beside it is INSERT_BOOKING_STAFF_CHANGE, imported from
// lib/staff-departure.js: a departure hands whole calendars on, so the same row is written
// from there too and one file holds its shape.
const MOVE_BOOKING_REVIEW = 'UPDATE reviews SET staff_id = ? WHERE booking_id = ?';
// Run inside the create transaction, alongside the notice the linked customer gets. source
// 'partner' is a literal beside the other two: a seat typed at the counter is attested to by
// the salon and by nobody else, and that stays true even when the phone number ties the row
// to a customer's account.
const INSERT_WALK_IN_BOOKING = `
  INSERT INTO bookings
    (user_id, salon_id, service_id, staff_id, code, date, time, status, note,
     total_price, customer_name, customer_phone, payment_method, source, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, 'at_salon', 'partner', ?)
`;

/**
 * The account behind a phone number typed at the counter, when there is exactly one.
 *
 * Stored numbers carry whatever spacing the person who typed them used ('0901 234 567'),
 * so the column is folded by the same rule the counter's input is — lib/phone.js, the one
 * lib/phone.js's own PHONE_HELD_BY_ANOTHER uses, so the two can never disagree about which
 * account a number belongs to. Two accounts sharing a number is not a match: guessing
 * which of them sat in the chair would put one customer's appointment in another's list.
 *
 * This is now the ONLY place a phone number attaches a booking to an account, and it is the
 * one place it can be trusted: the number was read off the customer standing at the counter
 * by the salon serving them, not typed into a public form by whoever knew it. Nothing on the
 * customer's own side claims a booking by phone any more — see lib/phone.js.
 *
 * Customers only, and only live ones. A walk-in typed with the owner's own number would
 * otherwise land in the owner's appointment list and raise a customer notification on it.
 */
const selectUsersByPhone = db.prepare(`
  SELECT id FROM users
  WHERE role = 'customer' AND deleted_at IS NULL AND ${normalisedPhoneSql('phone')} = ?
`);

async function accountForPhone(phone) {
  if (!phone) {
    return null;
  }
  const matches = await selectUsersByPhone.all(phone);
  return matches.length === 1 ? matches[0].id : null;
}

const BOOKING_NOTIFICATIONS = {
  confirmed: (salon, booking) => ({
    title: 'Lịch hẹn đã được xác nhận',
    body: `${salon.name} đã xác nhận lịch hẹn ${booking.code} ngày ${formatDateVN(booking.date)} lúc ${booking.time}.`,
    type: 'booking',
  }),
  // A customer told only "cancelled" cannot tell whether to wait, to call, or to book
  // elsewhere — so the reason the console just wrote into the note travels with the
  // message, and so does the way back in.
  cancelled: (salon, booking) => ({
    title: 'Lịch hẹn đã bị hủy',
    body: [
      `${salon.name} đã hủy lịch hẹn ${booking.code} ngày ${formatDateVN(booking.date)} lúc ${booking.time}.`,
      cancelReasonLine(booking.note),
      `Bạn có thể đặt lại tại ${salon.name}.`,
    ]
      .filter(Boolean)
      .join(' '),
    type: 'booking',
  }),
  // Not a status at all: the booking stays where it was and only its hour moved, which is
  // the one thing the customer has to be told before they turn up at the old one.
  rescheduled: (salon, booking) => ({
    title: 'Lịch hẹn đã được dời',
    body: `${salon.name} đã dời lịch hẹn ${booking.code} sang ${booking.time} ngày ${formatDateVN(booking.date)}.`,
    type: 'booking',
  }),
  // Its own sentence, because "đã dời … sang {giờ}" naming the hour the customer already
  // had reads as a mistake. The console posts staff_id on every save, so this is the
  // common case: a technician swapped, the appointment itself untouched. Written in
  // lib/staff-departure.js because a departure sweep sends the same sentence, and the
  // customer must not be told two different things about one kind of event.
  restaffed: restaffedNotice,
  no_show: (salon, booking) => ({
    title: 'Lịch hẹn được ghi nhận vắng mặt',
    body: `${salon.name} ghi nhận bạn không đến lịch hẹn ${booking.code} ngày ${formatDateVN(booking.date)} lúc ${booking.time}. Nếu có nhầm lẫn, vui lòng liên hệ salon.`,
    type: 'booking',
  }),
  completed: (salon, booking) => ({
    title: 'Buổi hẹn đã hoàn tất',
    body: `Cảm ơn bạn đã sử dụng dịch vụ tại ${salon.name}. Hãy dành một phút đánh giá lịch hẹn ${booking.code} nhé!`,
    type: 'review',
  }),
};

router.get('/bookings', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
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
      conditions.push('(b.code ILIKE ? OR b.customer_name ILIKE ?)');
      params.push(term, term);
    }

    // Newest first by default, as every list in the console reads. The dashboard's
    // "needs attention" queue asks for the opposite: it shows the first page of the
    // upcoming pending bookings, and those have to be the SOONEST ones, not the last
    // ones of the furthest week. Two literals, never the raw query value.
    const direction = req.query.order === 'asc' ? 'ASC' : 'DESC';

    const where = `WHERE ${conditions.join(' AND ')}`;
    const { total } = await db
      .prepare(`SELECT COUNT(*) AS total FROM bookings b ${where}`)
      .get(...params);
    const rows = await db
      .prepare(
        `SELECT ${BOOKING_COLUMNS} ${BOOKING_SOURCE} ${where}
         ORDER BY b.date ${direction}, b.time ${direction}, b.id ${direction}
         LIMIT ? OFFSET ?`,
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
async function activeStaffIdForBooking(value, salonId) {
  const staff = await ownedRow(
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

router.post('/bookings', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const body = req.body ?? {};

    // Both optional: a walk-in is a seat taken now, and demanding a full customer record
    // before the counter may hold it is how bookings end up never being recorded at all.
    const customerName = optionalText(body.customer_name, 'Tên khách hàng') ?? WALK_IN_NAME;
    const customerPhone = storedPhone(optionalText(body.customer_phone, 'Số điện thoại'));
    const date = requireDate(body.date, 'Ngày hẹn');
    // A walk-in booked into the past would silently rewrite the revenue history that
    // GET /api/partner/revenue reads.
    if (date < todayISO()) {
      throw httpError(400, 'VALIDATION_ERROR', 'Không thể tạo lịch hẹn cho ngày đã qua.');
    }
    const time = requireTime(body.time, 'Giờ hẹn');
    const note = optionalText(body.note, 'Ghi chú');

    const service = await ownedRow(
      selectOwnedService,
      requireId(body.service_id, 'Mã dịch vụ không hợp lệ.'),
      salon.id,
      'Không tìm thấy dịch vụ này tại salon của bạn.',
    );
    const staffId =
      body.staff_id === null || body.staff_id === undefined
        ? null
        : await activeStaffIdForBooking(body.staff_id, salon.id);

    // A booking made over the phone belongs in that customer's own list, with the
    // notifications and the "đặt lại" that come with it — the number is what ties the
    // two together, and until now every booking taken at the counter lost the link.
    const userId = await accountForPhone(customerPhone);

    // Price comes from the service row, never from the request: the counter must not
    // be able to post an arbitrary total.
    //
    // The transaction sits INSIDE the code retry, the way POST /api/bookings does it: a
    // duplicate code aborts the whole Postgres transaction, so each attempt needs a fresh
    // one. The customer's notice is written in there too — a booking the customer is
    // never told about is worse than no booking at all.
    let bookingId;
    try {
      await withBookingCode((code) =>
        db.withTransaction(async (tx) => {
          bookingId = Number(
            (
              await tx.run(
                INSERT_WALK_IN_BOOKING,
                userId,
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
              )
            ).lastInsertRowid,
          );

          if (userId !== null) {
            await notifyUser(
              tx,
              userId,
              'Salon đã đặt lịch giúp bạn',
              `${salon.name} đã tạo lịch hẹn ${code} ngày ${formatDateVN(date)} lúc ${time} cho bạn.`,
              'booking',
              bookingId,
            );
          }
          // The seat was typed at the counter onto somebody's calendar, and that somebody is
          // not standing at the counter reading it. Unguarded: a walk-in taken without a
          // technician passes staffId null and a row nobody claimed has no account behind it,
          // and notifyStaff answers for both so no call site has to.
          await notifyStaff(
            tx,
            staffId,
            'Lịch hẹn mới trên lịch của bạn',
            `${salon.name} đã xếp lịch hẹn ${code} ngày ${formatDateVN(date)} lúc ${time} cho bạn.`,
            bookingId,
          );
        }),
      );
    } catch (error) {
      // idx_bookings_slot: the named technician already has a live booking at this
      // slot. This route has no availability pre-check, so the index is the only gate.
      if (error.code === '23505' && error.constraint === 'idx_bookings_slot') {
        throw httpError(
          409,
          'SLOT_TAKEN',
          'Khung giờ này đã có lịch hẹn khác của kỹ thuật viên, vui lòng chọn giờ khác.',
        );
      }
      throw error;
    }

    const booking = await selectOwnedBooking.get(bookingId, salon.id);

    // A warning, never a refusal: a salon that stays open late for one customer is not
    // making a mistake, it is doing its job. The console says so and saves it anyway.
    const outsideHours = !(await isSalonOpenFor(salon.id, date, time, service.duration_min));

    res.json({
      success: true,
      data: bookingShape(booking),
      ...(outsideHours
        ? { meta: { warning: 'Giờ hẹn nằm ngoài giờ mở cửa của salon.' } }
        : {}),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/bookings/:id', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const booking = await ownedRow(
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

router.patch('/bookings/:id', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const body = req.body ?? {};
    const bookingId = requireId(req.params.id, 'Mã lịch hẹn không hợp lệ.');
    const booking = await ownedRow(
      selectOwnedBookingRow,
      bookingId,
      salon.id,
      'Không tìm thấy lịch hẹn này.',
    );

    /* The hour this save is actually leaving the appointment at, which is the one the two
       clock guards below have to be asked about: a body that moves the date AND sets the
       status is one request, and a guard that consulted only the stored date would wave
       through a booking completed into next month.

       Read off `body` rather than off `patch`, and deliberately: buildPatch fills `patch` as
       it walks its column map, so the status parser is only guaranteed to see a parsed date
       while `date` happens to sit above `status` in that map. Reading the body means the
       guard cannot be broken by reordering it. Same validators the date and time parsers
       use, so a malformed value is still refused in the same words. */
    const startsAt = () => ({
      date: Object.hasOwn(body, 'date') ? requireDate(body.date, 'Ngày hẹn') : booking.date,
      time: Object.hasOwn(body, 'time') ? requireTime(body.time, 'Giờ hẹn') : booking.time,
    });

    // Built per request because the parsers need the owner's salon and the current
    // status, but the column names are still a fixed whitelist.
    let newService = null;
    const { assignments, values, patch } = await buildPatch(body, {
      service_id: async (value) => {
        newService = await ownedRow(
          selectOwnedService,
          requireId(value, 'Mã dịch vụ không hợp lệ.'),
          salon.id,
          'Không tìm thấy dịch vụ này tại salon của bạn.',
        );
        return newService.id;
      },
      staff_id: (value) => (value === null ? null : activeStaffIdForBooking(value, salon.id)),
      date: (value) => requireDate(value, 'Ngày hẹn'),
      time: (value) => requireTime(value, 'Giờ hẹn'),
      note: (value) => optionalText(value, 'Ghi chú'),
      status: (value) => {
        requireOneOf(value, BOOKING_STATUSES, 'Trạng thái lịch hẹn không hợp lệ.');
        // Both guards ask about the hour this save leaves behind, not the one the row came
        // in with, so a single body carrying a date and a status cannot step around them.
        const start = startsAt();
        // Nobody is absent from an appointment that has not started yet, and a mis-tap on
        // tomorrow's card would otherwise notify the customer they missed it.
        if (value === 'no_show' && !hasStarted(start.date, start.time)) {
          throw httpError(
            409,
            'BOOKING_NOT_STARTED',
            'Chỉ có thể đánh dấu không đến sau giờ hẹn.',
          );
        }
        // And nothing is finished before it has begun. The same guard for the same reason:
        // a completed booking is work the technician's profile counts, so a console that
        // could close out next week's calendar could mint a career in an afternoon.
        if (value === 'completed' && !hasStarted(start.date, start.time)) {
          throw httpError(
            409,
            'BOOKING_NOT_STARTED',
            'Chỉ có thể hoàn tất lịch hẹn sau giờ hẹn.',
          );
        }
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

    // The price is the service's, never the request's — the same rule POST /bookings
    // follows. Without this the console could move a booking onto a cheaper service and
    // leave the old total on the row, quietly wrong in every revenue figure afterwards.
    if (newService !== null && newService.id !== booking.service_id) {
      assignments.push('"total_price" = ?');
      values.push(newService.price);
    }

    // A move is not a status change: the booking stays exactly as confirmed as it was and
    // only its hour changed, so the customer hears about it under its own message. What
    // counts is that a field actually CHANGED, not that the form posted it: the edit modal
    // sends every field every time, and telling a customer their appointment moved to the
    // hour it already had is how a notification channel stops being believed.
    // And only a booking that is still going to happen can be moved: re-dating a
    // cancelled or completed row is a correction to the record, not an appointment the
    // customer has to be told about.
    const movable = booking.status === 'pending' || booking.status === 'confirmed';
    const moved =
      movable &&
      ((Object.hasOwn(patch, 'date') && patch.date !== booking.date) ||
        (Object.hasOwn(patch, 'time') && patch.time !== booking.time));
    // Told apart from a move: the two say different things, and only one of them is about
    // when to turn up. A save that changes both is a move, which is the bigger news.
    const restaffed =
      movable &&
      Object.hasOwn(patch, 'staff_id') &&
      Number(patch.staff_id ?? 0) !== Number(booking.staff_id ?? 0);
    /* The technician side of a status change, and 'cancelled' is the whole of it: an hour has
       come off somebody's day and the console is the only thing that knows. Deliberately NOT
       'completed' and NOT 'no_show' — both of those are the counter writing down what the
       technician was standing there for, and ringing their bell for every appointment they
       finished is how a notification channel stops being read at all. */
    const staffCancelled = Object.hasOwn(patch, 'status') && patch.status === 'cancelled';

    /* The audit's own flag, and deliberately not `restaffed`: that one is gated on `movable`
       because it drives a customer notification, and the reassignments worth writing down
       are precisely the ones it leaves out — a completed or closed row moved onto somebody
       else's name, after the work it describes was already done. */
    const staffChanged =
      Object.hasOwn(patch, 'staff_id') &&
      Number(patch.staff_id ?? 0) !== Number(booking.staff_id ?? 0);

    /* A completed booking sitting on a roster row somebody stands behind is part of that
       person's verified record, and the console may not move it — in either direction. Off a
       claimed row, the technician who did the work silently loses a visit; onto one, a
       technician silently gains a visit they may never have performed, which inflates the
       same verified figure by the same forgery and is if anything the easier of the two to
       run at scale. Hence both ends are asked, and both answer the same way, so the reply
       says a completed booking is not movable rather than which end objected.

       Rows nobody has claimed stay editable — there is no profile to falsify yet — and every
       such move is written into booking_staff_changes below, so a technician claiming the
       row later can still see what was done under their name. */
    if (staffChanged && booking.status === 'completed') {
      const claimedEnd =
        (await selectClaimedStaffRow.get(booking.staff_id)) ??
        (await selectClaimedStaffRow.get(patch.staff_id));
      if (claimedEnd) {
        throw httpError(
          409,
          'CONFLICT',
          'Không thể đổi kỹ thuật viên của lịch hẹn đã hoàn tất: việc này ảnh hưởng hồ sơ đã xác thực của kỹ thuật viên.',
        );
      }
    }

    const notification = body.status
      ? BOOKING_NOTIFICATIONS[body.status]
      : moved
        ? BOOKING_NOTIFICATIONS.rescheduled
        : restaffed
          ? BOOKING_NOTIFICATIONS.restaffed
          : undefined;

    try {
      await db.withTransaction(async (tx) => {
        await tx.run(
          `UPDATE bookings SET ${assignments.join(', ')} WHERE id = ? AND salon_id = ?`,
          ...values,
          bookingId,
          salon.id,
        );

        /* Written in the same transaction as the move, so the record and the row it
           describes can never come apart. Pending rows are left out: nothing has happened on
           one yet, so a swap there is a cheap correction to a plan rather than a change to
           anybody's history. */
        if (staffChanged && booking.status !== 'pending') {
          await tx.run(
            INSERT_BOOKING_STAFF_CHANGE,
            bookingId,
            booking.staff_id,
            patch.staff_id,
            req.user.id,
            new Date().toISOString(),
          );

          /* And the customer's review of that visit goes with it. A review is about the
             person who did the work, so a correction that moved the booking and left the
             review behind would leave one technician holding a rating for a visit they no
             longer have and the other holding the visit with nothing said about it. Both
             caches are then recomputed off the reviews as they now stand — the same
             statement routes/reviews.js runs, from the same file, so the two cannot drift.
             A move that carried no review recomputes both to what they already were. */
          await tx.run(MOVE_BOOKING_REVIEW, patch.staff_id, bookingId);
          for (const staffId of [booking.staff_id, patch.staff_id]) {
            if (staffId !== null) {
              await tx.run(RECOMPUTE_STAFF_RATING, staffId, staffId);
            }
          }
        }

        if (notification || staffCancelled || restaffed || moved) {
          const updated = await tx.get(SELECT_OWNED_BOOKING_ROW, bookingId, salon.id);
          if (notification) {
            const { title, body: message, type } = notification(salon, updated);
            // No-op for walk-ins (user_id NULL), so this needs no guard of its own.
            await notifyUser(tx, booking.user_id, title, message, type, bookingId);
          }

          /* The people whose day this save changed, on the same read of the row the customer's
             notice is written from, so every sentence names the same hour.

             `restaffed` and `moved` are the customer's own flags and both are gated on
             `movable`, which is exactly the gate this wants too: a cancelled or completed
             booking re-dated or moved between two names is a correction to the record — the
             work is done or the hour is gone — and no technician has anything to do about it
             today.

             The three branches are exclusive, and in this order, because one save can trip
             more than one of them and a technician must hear about it once. A save that
             cancels while reassigning has ended the hour for everybody: the person holding it
             is told that, and the name it passed through on the way out is not news. A save
             that moves the hour AND swaps the chair is already fully told by the reassignment
             pair — both of those sentences carry `when`, which is the NEW hour, so the
             departing technician learns the hour left her calendar and the arriving one learns
             what she is now expected at. Adding "and it moved" on top of either would be the
             console ringing twice for one save. So the move rings on its own only when the
             chair did not change: the technician who is staying, told once, that her hour is
             not the hour she had. */
          const when = `ngày ${formatDateVN(updated.date)} lúc ${updated.time}`;
          if (staffCancelled) {
            await notifyStaff(
              tx,
              booking.staff_id,
              'Một lịch hẹn đã bị hủy',
              `${salon.name} đã hủy lịch hẹn ${updated.code} ${when}.`,
              bookingId,
            );
          } else if (restaffed) {
            /* One loses an hour and one gains it, so they get different sentences: a single
               wording covering both would leave each of them working out which half is theirs.

               And the departing side has two cases, because staff_id is nullable: the console
               can clear a booking back to "Bất kỳ", which takes the hour off this technician
               without giving it to anybody. Told that it went "sang một kỹ thuật viên khác"
               they would go looking for a colleague who does not exist — and nothing would
               correct it, since the arriving call below no-ops on a null. */
            await notifyStaff(
              tx,
              booking.staff_id,
              patch.staff_id === null
                ? 'Lịch hẹn đã gỡ khỏi lịch của bạn'
                : 'Lịch hẹn đã chuyển sang người khác',
              patch.staff_id === null
                ? `${salon.name} đã gỡ lịch hẹn ${updated.code} ${when} khỏi lịch của bạn.`
                : `${salon.name} đã chuyển lịch hẹn ${updated.code} ${when} sang một kỹ thuật viên khác.`,
              bookingId,
            );
            await notifyStaff(
              tx,
              patch.staff_id,
              'Lịch hẹn mới trên lịch của bạn',
              `${salon.name} đã chuyển lịch hẹn ${updated.code} ${when} sang cho bạn.`,
              bookingId,
            );
          } else if (moved) {
            await notifyStaff(
              tx,
              booking.staff_id,
              'Một lịch hẹn đã được dời',
              `${salon.name} đã dời lịch hẹn ${updated.code} sang ${when}.`,
              bookingId,
            );
          }
        }
      });
    } catch (error) {
      // idx_bookings_slot: rescheduling (time/date/technician) landed on a slot where
      // the technician already has a live booking.
      if (error.code === '23505' && error.constraint === 'idx_bookings_slot') {
        throw httpError(
          409,
          'SLOT_TAKEN',
          'Khung giờ này đã có lịch hẹn khác của kỹ thuật viên, vui lòng chọn giờ khác.',
        );
      }
      throw error;
    }

    res.json({
      success: true,
      data: bookingShape(await selectOwnedBooking.get(bookingId, salon.id)),
    });
  } catch (error) {
    next(error);
  }
});

/* ============================================================================
 * Free hours, and the customer behind the phone number
 * ========================================================================= */

/**
 * The hours a service can still start at on one date, as the customer wizard computes
 * them — with a technician when one is named, across everyone who performs it when not.
 *
 * The counter used to type a free-text time and find out about the clash only when the
 * unique index answered 409. Same library, same rules (roster, opening hours, days off,
 * lead time), so the console and the public calendar never disagree.
 *
 * Deliberately including the salon's own lead time: a walk-in starting sooner than the
 * salon lets customers book is an exception, and "Nhập giờ khác" is where exceptions are
 * typed. Giving the console a lead-time-free list would make the chips disagree with the
 * calendar the customer sees, which is the disagreement this endpoint exists to end.
 */
router.get('/availability', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const date = requireDate(req.query.date, 'Ngày hẹn');
    const service = await ownedRow(
      selectOwnedService,
      requireId(req.query.service_id, 'Mã dịch vụ không hợp lệ.'),
      salon.id,
      'Không tìm thấy dịch vụ này tại salon của bạn.',
    );
    const staffId =
      req.query.staff_id === undefined || req.query.staff_id === ''
        ? null
        : (
            await ownedRow(
              selectOwnedStaff,
              requireId(req.query.staff_id, 'Mã kỹ thuật viên không hợp lệ.'),
              salon.id,
              'Không tìm thấy kỹ thuật viên này tại salon của bạn.',
            )
          ).id;

    const slots =
      staffId === null
        ? await getServiceSlots(service.id, date)
        : await getStaffSlots(staffId, service.id, date);

    res.json({ success: true, data: { date, slots } });
  } catch (error) {
    next(error);
  }
});

/* ============================================================================
 * Customers
 * ========================================================================= */

// One customer of this salon is every booking that shares an account, or — for the ones
// taken at the counter — a phone number. Rows with neither are a walk-in nobody named,
// which is a seat that was filled, not a person to be looked up later.
//
// The number is folded in the query, not trusted to be folded in the column: rows written
// before lib/phone.js existed (and every seeded one) still hold '0901 234 567', and
// grouping on the raw text would split one person into a customer per spelling.
const CUSTOMER_KEY = `COALESCE(CAST(b.user_id AS TEXT), NULLIF(${normalisedPhoneSql('b.customer_phone')}, ''))`;
const CUSTOMER_NAME = 'COALESCE(u.name, b.customer_name)';
const CUSTOMER_PHONE = 'COALESCE(u.phone, b.customer_phone)';

// Newest booking first inside each group, so the name and number shown are the ones the
// customer gave last rather than whatever they were first written as.
const CUSTOMER_COLUMNS = `
    ${CUSTOMER_KEY} AS key,
    MAX(b.user_id) AS user_id,
    (ARRAY_AGG(${CUSTOMER_NAME} ORDER BY b.date DESC, b.id DESC))[1] AS name,
    (ARRAY_AGG(${CUSTOMER_PHONE} ORDER BY b.date DESC, b.id DESC))[1] AS phone,
    COUNT(*) AS bookings_count,
    COUNT(*) FILTER (WHERE b.status = 'completed') AS visits,
    COUNT(*) FILTER (WHERE b.status = 'no_show') AS no_show_count,
    MAX(b.date) FILTER (WHERE b.status = 'completed') AS last_visit,
    COALESCE(SUM(b.total_price) FILTER (WHERE b.status = 'completed'), 0) AS total_spent`;

function customerShape(row) {
  return {
    key: row.key,
    user_id: row.user_id,
    name: row.name,
    phone: row.phone,
    bookings_count: row.bookings_count,
    visits: row.visits,
    no_show_count: row.no_show_count,
    last_visit: row.last_visit,
    total_spent: row.total_spent,
    vip: row.visits >= VIP_COMPLETED_BOOKINGS,
  };
}

router.get('/customers', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const conditions = ['b.salon_id = ?', `${CUSTOMER_KEY} IS NOT NULL`];
    const params = [salon.id];

    const query = req.query.q ? String(req.query.q).trim() : '';
    if (query !== '') {
      // A number is searched for as digits on both sides: nobody types the spaces back
      // in the same places they were saved.
      const digits = query.replace(/[^0-9]/g, '');
      const clauses = [`${CUSTOMER_NAME} ILIKE ?`];
      params.push(`%${query}%`);
      if (digits !== '') {
        clauses.push(`regexp_replace(COALESCE(${CUSTOMER_PHONE}, ''), '[^0-9]', '', 'g') ILIKE ?`);
        params.push(`%${digits}%`);
      }
      conditions.push(`(${clauses.join(' OR ')})`);
    }

    const rows = await db
      .prepare(
        `SELECT ${CUSTOMER_COLUMNS}
         FROM bookings b
         LEFT JOIN users u ON u.id = b.user_id
         WHERE ${conditions.join(' AND ')}
         GROUP BY ${CUSTOMER_KEY}
         ORDER BY MAX(b.date) DESC, MIN(${CUSTOMER_NAME})
         LIMIT ?`,
      )
      .all(...params, CUSTOMER_LIMIT);

    res.json({
      success: true,
      data: rows.map(customerShape),
      // `returned`, not `total`: this is one page of the list, and a salon with more
      // customers than the limit must not be told it has exactly the limit.
      meta: { returned: rows.length, limit: CUSTOMER_LIMIT },
    });
  } catch (error) {
    next(error);
  }
});

// Everything else this customer has booked here, newest first: "what did they have last
// time" is the question asked over the counter while they are still standing at it.
const selectCustomerHistory = db.prepare(`
  SELECT ${BOOKING_COLUMNS} ${BOOKING_SOURCE}
  WHERE b.salon_id = ? AND b.id <> ? AND ${CUSTOMER_KEY} = ?
  ORDER BY b.date DESC, b.time DESC, b.id DESC
  LIMIT ?
`);

router.get('/bookings/:id/history', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const booking = await ownedRow(
      selectOwnedBookingRow,
      requireId(req.params.id, 'Mã lịch hẹn không hợp lệ.'),
      salon.id,
      'Không tìm thấy lịch hẹn này.',
    );
    // Folded exactly as CUSTOMER_KEY folds the column, or a booking taken under
    // '0901 234 567' would never match one taken under '0901234567'.
    const key =
      booking.user_id === null ? storedPhone(booking.customer_phone) : String(booking.user_id);
    const rows = key
      ? await selectCustomerHistory.all(salon.id, booking.id, key, CUSTOMER_HISTORY_LIMIT)
      : [];

    res.json({ success: true, data: rows.map(bookingShape), meta: { total: rows.length } });
  } catch (error) {
    next(error);
  }
});

/* ============================================================================
 * Reviews
 * ========================================================================= */

const PARTNER_REVIEW_SOURCE = `
  FROM reviews r
  LEFT JOIN users u ON u.id = r.user_id
  LEFT JOIN services sv ON sv.id = r.service_id
  LEFT JOIN staff st ON st.id = r.staff_id
  LEFT JOIN bookings b ON b.id = r.booking_id`;

const selectOwnedReview = db.prepare('SELECT * FROM reviews WHERE id = ? AND salon_id = ?');
// The number the dashboard badge and this list both carry: reviews nobody has answered
// yet. One statement, so the badge and the filter can never come to mean two things.
const selectUnansweredReviews = db.prepare(
  'SELECT COUNT(*) AS count FROM reviews WHERE salon_id = ? AND reply_text IS NULL',
);
const UPDATE_REVIEW_REPLY = 'UPDATE reviews SET reply_text = ?, reply_at = ? WHERE id = ?';

function partnerReviewShape(row) {
  return {
    id: row.id,
    rating: row.rating,
    comment: row.comment,
    created_at: row.created_at,
    reply_text: row.reply_text,
    reply_at: row.reply_at,
    user: { name: row.user_name, avatar: row.user_avatar },
    service: row.service_id ? { id: row.service_id, name: row.service_name } : null,
    staff: row.staff_id ? { id: row.staff_id, name: row.staff_name } : null,
    booking: row.booking_id
      ? { id: row.booking_id, code: row.booking_code, date: row.booking_date }
      : null,
  };
}

router.get('/reviews', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const { page, limit, offset } = parsePagination(req.query, 20);

    const conditions = ['r.salon_id = ?'];
    const params = [salon.id];
    if (req.query.rating) {
      const rating = Number.parseInt(req.query.rating, 10);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        throw httpError(400, 'VALIDATION_ERROR', 'Điểm đánh giá phải là số nguyên từ 1 đến 5.');
      }
      conditions.push('r.rating = ?');
      params.push(rating);
    }
    // The one filter a salon actually works from: what still owes an answer.
    if (req.query.unanswered === '1') {
      conditions.push('r.reply_text IS NULL');
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const { total } = await db
      .prepare(`SELECT COUNT(*) AS total ${PARTNER_REVIEW_SOURCE} ${where}`)
      .get(...params);
    const rows = await db
      .prepare(
        `SELECT r.id, r.rating, r.comment, r.created_at, r.reply_text, r.reply_at,
                u.name AS user_name, u.avatar AS user_avatar,
                sv.id AS service_id, sv.name AS service_name,
                st.id AS staff_id, st.name AS staff_name,
                b.id AS booking_id, b.code AS booking_code, b.date AS booking_date
         ${PARTNER_REVIEW_SOURCE} ${where}
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);

    res.json({
      success: true,
      data: rows.map(partnerReviewShape),
      // The unanswered count is over every review of the salon, not the page or the
      // filter, so the badge it feeds does not change meaning when a star is pressed.
      meta: { page, limit, total, unanswered: (await selectUnansweredReviews.get(salon.id)).count },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * The salon's public answer to one review of its own.
 *
 * Ownership is the review's salon_id against the owner's salon, so a partner can neither
 * answer nor overwrite an answer under somebody else's name. An empty body takes the
 * reply down again, which is the only way back out of one posted in anger.
 */
router.patch('/reviews/:id/reply', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const review = await ownedRow(
      selectOwnedReview,
      requireId(req.params.id, 'Mã đánh giá không hợp lệ.'),
      salon.id,
      'Không tìm thấy đánh giá này tại salon của bạn.',
    );
    const reply = optionalLimitedText((req.body ?? {}).reply_text, 'Phản hồi', REPLY_TEXT_MAX);
    const replyAt = reply === null ? null : new Date().toISOString();

    await db.withTransaction(async (tx) => {
      await tx.run(UPDATE_REVIEW_REPLY, reply, replyAt, review.id);
      // Only the first answer is news. A salon polishing a typo out of one it already
      // posted must not send the customer the same notice a second and third time.
      if (reply !== null && review.reply_text === null) {
        await notifyUser(
          tx,
          review.user_id,
          'Salon đã phản hồi đánh giá của bạn',
          `${salon.name} vừa trả lời đánh giá của bạn: "${reply}"`,
          'review',
        );
      }
    });

    res.json({ success: true, data: { id: review.id, reply_text: reply, reply_at: replyAt } });
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
    (salon_id, category, subcategory, name, description, price, duration_min, image,
     price_is_from, sort_order, active)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
`);
// A new service joins the end of the menu, never the middle: every existing position keeps
// the meaning the salon gave it. COALESCE covers the very first service of a salon.
const selectNextServicePosition = db.prepare(
  'SELECT COALESCE(MAX(sort_order), 0) + 1 AS position FROM services WHERE salon_id = ?',
);
// Every booking, not just the upcoming ones: the foreign key blocks the delete as soon
// as any row references the service, so a narrower pre-check would make the 409 arrive
// from the pre-check or from the FK depending on the data.
const selectServiceBookingCount = db.prepare(
  'SELECT COUNT(*) AS count FROM bookings WHERE salon_id = ? AND service_id = ?',
);
// Run only inside the delete transaction.
const DELETE_SERVICE_LINKS = 'DELETE FROM staff_services WHERE service_id = ?';
const DELETE_SERVICE = 'DELETE FROM services WHERE id = ? AND salon_id = ?';

const SERVICE_COLUMNS = {
  name: (value) => requireText(value, 'tên dịch vụ'),
  category: (value) => requireOneOf(value, SERVICE_CATEGORIES, 'Danh mục dịch vụ không hợp lệ.'),
  subcategory: (value) => optionalText(value, 'Danh mục phụ'),
  description: (value) => optionalText(value, 'Mô tả'),
  price: (value) => requireCount(value, 'Giá dịch vụ'),
  duration_min: (value) => requireCount(value, 'Thời lượng'),
  image: (value) => optionalMediaUrl(value, 'Ảnh dịch vụ'),
  // A service whose price depends on hair length or nail set is quoted as a floor, not a
  // figure: the customer pages read this and print "từ 250.000đ" instead of the price.
  price_is_from: (value) => requireFlag(value, 'Giá từ'),
  sort_order: (value) => requireCount(value, 'Thứ tự hiển thị'),
  active: (value) => requireFlag(value, 'Trạng thái hiển thị'),
};

router.get('/services', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
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
      conditions.push('name ILIKE ?');
      params.push(`%${String(req.query.q).trim()}%`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    // Two counts, because the console asks two questions of them: how many services the
    // salon has, and how many the public side can see — the second is what going live
    // requires, so the checklist and the server's refusal have to read the same number.
    const totals = await db
      .prepare(
        `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE active = 1) AS active_total
         FROM services ${where}`,
      )
      .get(...params);
    const rows = await db
      .prepare(`SELECT * FROM services ${where} ORDER BY sort_order, name LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);

    // Counts cover the whole salon, not the filtered page, so the category tabs keep
    // their numbers while a filter is applied. Zero-filled for a stable shape.
    const categories = Object.fromEntries(SERVICE_CATEGORIES.map((key) => [key, 0]));
    for (const row of await selectServiceCategoryCounts.all(salon.id)) {
      categories[row.category] = row.count;
    }

    res.json({
      success: true,
      data: rows.map(serviceShape),
      meta: { page, limit, total: totals.total, active_total: totals.active_total, categories },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/services', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const body = req.body ?? {};

    const serviceId = Number(
      (
        await insertService.run(
          salon.id,
          SERVICE_COLUMNS.category(body.category),
          SERVICE_COLUMNS.subcategory(body.subcategory),
          SERVICE_COLUMNS.name(body.name),
          SERVICE_COLUMNS.description(body.description),
          SERVICE_COLUMNS.price(body.price),
          SERVICE_COLUMNS.duration_min(body.duration_min),
          SERVICE_COLUMNS.image(body.image),
          body.price_is_from === undefined ? 0 : SERVICE_COLUMNS.price_is_from(body.price_is_from),
          (await selectNextServicePosition.get(salon.id)).position,
        )
      ).lastInsertRowid,
    );

    res.json({
      success: true,
      data: serviceShape(await selectOwnedService.get(serviceId, salon.id)),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/services/:id', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const service = await ownedRow(
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

router.patch('/services/:id', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const serviceId = requireId(req.params.id, 'Mã dịch vụ không hợp lệ.');
    await ownedRow(selectOwnedService, serviceId, salon.id, 'Không tìm thấy dịch vụ này.');

    const { assignments, values } = await buildPatch(req.body ?? {}, SERVICE_COLUMNS);
    await db.withTransaction(async (tx) => {
      await tx.run(
        `UPDATE services SET ${assignments.join(', ')} WHERE id = ? AND salon_id = ?`,
        ...values,
        serviceId,
        salon.id,
      );
      // Hiding a service is allowed even when it is the last visible one; what is not
      // allowed is a listed salon with an empty menu, so the salon drops to draft.
      await unpublishIfNotReady(tx, salon, req.user.id);
    });

    res.json({
      success: true,
      data: serviceShape(await selectOwnedService.get(serviceId, salon.id)),
    });
  } catch (error) {
    next(error);
  }
});

router.delete('/services/:id', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const serviceId = requireId(req.params.id, 'Mã dịch vụ không hợp lệ.');
    await ownedRow(selectOwnedService, serviceId, salon.id, 'Không tìm thấy dịch vụ này.');

    const { count } = await selectServiceBookingCount.get(salon.id, serviceId);
    if (count > 0) {
      throw httpError(
        409,
        'HAS_BOOKINGS',
        'Dịch vụ đã phát sinh lịch hẹn nên không thể xóa. Bạn có thể tạm ẩn dịch vụ.',
      );
    }

    try {
      await db.withTransaction(async (tx) => {
        // The staff links belong to this service, so they go with it; bookings and
        // reviews do not, and their foreign keys are what stops the delete below.
        await tx.run(DELETE_SERVICE_LINKS, serviceId);
        await tx.run(DELETE_SERVICE, serviceId, salon.id);
        await unpublishIfNotReady(tx, salon, req.user.id);
      });
    } catch (error) {
      if (error.code === '23503') {
        throw httpError(
          409,
          'HAS_BOOKINGS',
          'Dịch vụ đã phát sinh lịch hẹn hoặc đánh giá nên không thể xóa. Bạn có thể tạm ẩn dịch vụ.',
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
// The same links for the whole roster in one round trip: the booking form filters the
// technician list by the service that was picked, and asking per technician would be a
// query per row of a list that is already on screen.
const selectSalonStaffServices = db.prepare(`
  SELECT ss.staff_id, ss.service_id
  FROM staff_services ss
  JOIN staff st ON st.id = ss.staff_id
  WHERE st.salon_id = ?
  ORDER BY ss.service_id
`);
// Which roster rows have a claim link outstanding, for the whole salon in one round trip.
// Same shape as the two maps above and for the same reason: "is there a link waiting on
// this row?" is a column of a list that is already on screen, not a query per row.
const selectSalonPendingInvites = db.prepare(`
  SELECT i.staff_id
  FROM staff_invites i
  JOIN staff st ON st.id = i.staff_id
  WHERE st.salon_id = ? AND i.used = 0 AND i.expires_at > ?
`);
// rating > 0 so an unrated new hire (rating defaults to 0) does not drag the average
// down: the roster figure should reflect technicians who actually have reviews.
const selectActiveStaffRating = db.prepare(
  'SELECT AVG(rating) AS average FROM staff WHERE salon_id = ? AND active = 1 AND rating > 0',
);
// The staff writes all happen inside transactions, so these are kept as SQL text.
const INSERT_STAFF =
  'INSERT INTO staff (salon_id, name, title, specialty, image, started_at, active) VALUES (?, ?, ?, ?, ?, ?, 1)';
const INSERT_STAFF_SCHEDULE =
  'INSERT INTO staff_schedule (staff_id, weekday, "start", "end", is_off) VALUES (?, ?, ?, ?, ?)';
const DELETE_STAFF_SCHEDULE = 'DELETE FROM staff_schedule WHERE staff_id = ?';
const INSERT_STAFF_SERVICE = 'INSERT INTO staff_services (staff_id, service_id) VALUES (?, ?)';
const DELETE_STAFF_SERVICES = 'DELETE FROM staff_services WHERE staff_id = ?';
const DEACTIVATE_STAFF = 'UPDATE staff SET active = 0 WHERE id = ? AND salon_id = ?';
/* Appended to the SET clause of any save that carries a new started_at. What the technician
   confirmed was a date, not the idea of one, so the ✓ does not survive the salon replacing
   it — and neither does a dispute, which was about the value that has just gone. */
const RESET_STARTED_ATTESTATION = 'started_confirmed_at = NULL, tenure_disputed = 0';
/* Cleared alongside left_at when a recorded departure is undone below: both ✓ on the stint
   were answers about a pair of dates, and one of them has just stopped existing. */
const RESET_DEPARTURE = 'left_at = NULL, left_by = NULL, left_confirmed_at = NULL';
const retireStaffInvites = db.prepare(RETIRE_STAFF_INVITES);

/**
 * How far ahead a start date may be entered.
 *
 * Unlike a departure, a hire ahead of time is real and harmless: the row is created active
 * either way, so a date next week says when the stint began and takes nothing away in the
 * meantime. It is bounded all the same, because past that horizon the value is a typo — 2027
 * for 2026 — far more often than a plan, and a typo here sits on somebody's public profile as
 * the day they joined and as the ✓ they are asked to sign.
 */
const START_MAX_LEAD_DAYS = 30;

/** The salon's own date for the start of a stint: any past day, or a hire soon to come. */
function startDateOrNull(value) {
  const date = optionalDate(value, 'Ngày bắt đầu');
  if (date !== null && date > addDaysISO(todayISO(), START_MAX_LEAD_DAYS)) {
    throw httpError(
      400,
      'VALIDATION_ERROR',
      `Ngày bắt đầu không được quá ${START_MAX_LEAD_DAYS} ngày kể từ hôm nay.`,
    );
  }
  return date;
}

const STAFF_COLUMNS = {
  name: (value) => requireText(value, 'tên kỹ thuật viên'),
  title: (value) => optionalText(value, 'Chức danh'),
  specialty: (value) => optionalText(value, 'Chuyên môn'),
  image: (value) => optionalMediaUrl(value, 'Ảnh đại diện'),
  /* The day this stint began, as the salon knows it and no query can. It outranks the
     earliest completed booking wherever it is set (lib/staff-stats.js), which is why it is
     the salon's to enter and the technician's to confirm rather than either one's alone. */
  started_at: (value) => startDateOrNull(value),
  /* Patchable so a soft-deleted technician (DELETE sets active = 0) can be restored — and,
     on a CLAIMED row that carries a leaving date, so a departure recorded on the wrong day
     can be UNDONE. See the PATCH itself: that is the only correction there is. */
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
async function parseStaffServiceIds(value, salonId) {
  const ids = [
    ...new Set(
      requireArray(value, 'Danh sách dịch vụ').map((id) =>
        requireId(id, 'Mã dịch vụ không hợp lệ.'),
      ),
    ),
  ];
  for (const id of ids) {
    if (!(await selectOwnedService.get(id, salonId))) {
      throw httpError(400, 'VALIDATION_ERROR', 'Dịch vụ được chọn không thuộc salon của bạn.');
    }
  }
  return ids;
}

/**
 * The stint half of a roster row: the two dates, who ended it, and what the technician has
 * answered about them.
 *
 * Shared by the grid and the editor rather than served only by staffDetail below, because the
 * console draws the "đã nghỉ" state and the ✓ on the LIST — and a list that had to fan out one
 * detail request per row to know them would ask the server thirty questions to draw thirty
 * chips. tenure_verified is the badge rule computed server-side in lib/staff-stats.js and
 * never re-derived from these columns by a page: a console, a grid and a public profile
 * disagreeing about whether a date is attested to is exactly the argument one rule in one
 * place exists to prevent.
 */
function stintFields(staff) {
  return {
    started_at: staff.started_at ?? null,
    left_at: staff.left_at ?? null,
    left_by: staff.left_by ?? null,
    tenure_disputed: staff.tenure_disputed ?? 0,
    tenure_verified: tenureVerified(staff),
  };
}

async function staffDetail(staff) {
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
    // The stint itself, so the console can read back the date it just entered and show what
    // the technician has answered about it — the same block the grid is served.
    ...stintFields(staff),
    schedule: await selectStaffSchedule.all(staff.id),
    service_ids: (await selectStaffServiceIds.all(staff.id)).map((row) => row.service_id),
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

router.get('/staff', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const term = req.query.q ? `%${String(req.query.q).trim()}%` : null;
    const rows = term
      ? await db
          .prepare('SELECT * FROM staff WHERE salon_id = ? AND name ILIKE ? ORDER BY id')
          .all(salon.id, term)
      : await selectSalonStaff.all(salon.id);

    const today = todayISO();
    const weekday = weekdayOf(today);
    const minutes = nowMinutes();
    const windows = await bookingWindowsByStaff(salon.id, today);

    const schedules = new Map();
    for (const row of await selectSalonSchedules.all(salon.id)) {
      if (!schedules.has(row.staff_id)) {
        schedules.set(row.staff_id, new Map());
      }
      schedules.get(row.staff_id).set(row.weekday, row);
    }

    const serviceIds = new Map();
    for (const row of await selectSalonStaffServices.all(salon.id)) {
      if (!serviceIds.has(row.staff_id)) {
        serviceIds.set(row.staff_id, []);
      }
      serviceIds.get(row.staff_id).push(row.service_id);
    }

    const pendingInvites = new Set(
      (await selectSalonPendingInvites.all(salon.id, new Date().toISOString())).map(
        (row) => row.staff_id,
      ),
    );

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
        // What this technician actually does, so the booking form can stop offering a
        // nail artist for a haircut.
        service_ids: serviceIds.get(member.id) ?? [],
        // Whether a person stands behind this row, and whether a link to become that
        // person is still outstanding. Booleans and nothing else: user_id names an
        // account and the token IS the secret, so neither leaves the server.
        claimed: Boolean(member.user_id),
        invite_pending: pendingInvites.has(member.id),
        // Every row already carries its stint, so the grid can say "đã nghỉ từ ngày" and
        // draw its ✓ without asking a second question per row.
        ...stintFields(member),
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
        rating_avg: roundRating((await selectActiveStaffRating.get(salon.id)).average),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/staff', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const body = req.body ?? {};

    const name = STAFF_COLUMNS.name(body.name);
    const title = STAFF_COLUMNS.title(body.title);
    const specialty = STAFF_COLUMNS.specialty(body.specialty);
    const image = STAFF_COLUMNS.image(body.image);
    // Optional, and nothing is inferred when it is left out: a row with no date of its own
    // answers from its first completed visit, which is a truer silence than today's date.
    const startedAt = STAFF_COLUMNS.started_at(body.started_at);
    const schedule = body.schedule === undefined ? [] : parseSchedule(body.schedule);
    const serviceIds =
      body.service_ids === undefined
        ? []
        : await parseStaffServiceIds(body.service_ids, salon.id);

    let staffId;
    await db.withTransaction(async (tx) => {
      staffId = Number(
        (await tx.run(INSERT_STAFF, salon.id, name, title, specialty, image, startedAt))
          .lastInsertRowid,
      );
      for (const shift of schedule) {
        await tx.run(INSERT_STAFF_SCHEDULE, staffId, shift.weekday, shift.start, shift.end, shift.is_off);
      }
      for (const serviceId of serviceIds) {
        await tx.run(INSERT_STAFF_SERVICE, staffId, serviceId);
      }
    });

    res.json({
      success: true,
      data: await staffDetail(await selectOwnedStaff.get(staffId, salon.id)),
    });
  } catch (error) {
    next(error);
  }
});

// Registered before /staff/:id so the literal sub-paths always win the match.
router.put('/staff/:id/schedule', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const staffId = requireId(req.params.id, 'Mã kỹ thuật viên không hợp lệ.');
    await ownedRow(selectOwnedStaff, staffId, salon.id, 'Không tìm thấy kỹ thuật viên này.');
    const schedule = parseSchedule(listPayload(req.body, 'schedule'));

    // Full replace: the payload is the whole week, so the old rows go first.
    await db.withTransaction(async (tx) => {
      await tx.run(DELETE_STAFF_SCHEDULE, staffId);
      for (const shift of schedule) {
        await tx.run(INSERT_STAFF_SCHEDULE, staffId, shift.weekday, shift.start, shift.end, shift.is_off);
      }
    });

    res.json({
      success: true,
      data: await staffDetail(await selectOwnedStaff.get(staffId, salon.id)),
    });
  } catch (error) {
    next(error);
  }
});

router.put('/staff/:id/services', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const staffId = requireId(req.params.id, 'Mã kỹ thuật viên không hợp lệ.');
    await ownedRow(selectOwnedStaff, staffId, salon.id, 'Không tìm thấy kỹ thuật viên này.');
    const serviceIds = await parseStaffServiceIds(listPayload(req.body, 'service_ids'), salon.id);

    await db.withTransaction(async (tx) => {
      await tx.run(DELETE_STAFF_SERVICES, staffId);
      for (const serviceId of serviceIds) {
        await tx.run(INSERT_STAFF_SERVICE, staffId, serviceId);
      }
    });

    res.json({
      success: true,
      data: await staffDetail(await selectOwnedStaff.get(staffId, salon.id)),
    });
  } catch (error) {
    next(error);
  }
});

/* When each roster row last had a recovery mailed for it. Same shape and same caveats as
   the tallies in routes/auth.js: one process's memory, gone on deploy, swept on the way
   past rather than on a timer so an idle process holds nothing. */
const RECOVERY_COOLDOWN_MS = 60 * 1000;
const recoverySentAt = new Map();

/** True while the row's last recovery is less than a minute old. */
function recoveryOnCooldown(staffId) {
  const now = Date.now();
  for (const [seen, sentAt] of recoverySentAt) {
    if (now - sentAt >= RECOVERY_COOLDOWN_MS) {
      recoverySentAt.delete(seen);
    }
  }
  return recoverySentAt.has(staffId);
}

/*
 * The claim link: how a roster row stops being a description of somebody and becomes an
 * account they hold. The owner mints it here and hands it over in person or over Zalo —
 * there is no address on a roster row to mail it to, and the person is standing in the
 * salon anyway.
 *
 * On a row somebody ALREADY holds, this is a different act with the same button: the
 * technician has lost their password, and what they get is an ordinary reset link at their
 * own email address. Registered before /staff/:id so the literal sub-paths always win the
 * match.
 */
router.post('/staff/:id/invite', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const staffId = requireId(req.params.id, 'Mã kỹ thuật viên không hợp lệ.');
    const staff = await ownedRow(
      selectOwnedStaff,
      staffId,
      salon.id,
      'Không tìm thấy kỹ thuật viên này.',
    );
    // A row taken off the roster describes a stint that has ended, so there is nobody
    // left to invite. 409 rather than 404: the row is the owner's and they can see it.
    if (staff.active !== 1) {
      throw httpError(
        409,
        'STAFF_INACTIVE',
        'Kỹ thuật viên này đã ngừng hoạt động, không thể tạo liên kết.',
      );
    }

    /* A row somebody already stands behind. No claim link is minted here, and deliberately
       so: a link the OWNER holds that sets a password on their technician's account is
       account takeover with a friendly name on it. What the technician gets instead is the
       ordinary forgot-password link, at their own email address, and what the owner gets
       back is the fact that it went out and nothing else — no token, no url, no expiry.

       One a minute per roster row, and not because there is a stranger to keep out — the
       owner is authenticated and scoped to their own roster. Minting retires whatever
       reset the account had outstanding, so an owner leaning on the button would keep
       killing the link their technician had just asked for themselves. Inside the cooldown
       the owner is told exactly what the first press told them: from where they stand the
       mail went, and a second one on the way is not a fact they can act on.

       On a production deploy with no mail key configured this sends nothing at all.
       Configuring RESEND is a stated precondition of inviting real people. */
    if (staff.user_id != null) {
      if (recoveryOnCooldown(staffId)) {
        res.json({ success: true, data: { recovery: 'sent' } });
        return;
      }
      let resetToken;
      await db.withTransaction(async (tx) => {
        resetToken = await mintResetIn(tx, staff.user_id);
        await notifyUser(
          tx,
          staff.user_id,
          'Liên kết đăng nhập lại',
          'Chủ salon đã yêu cầu một liên kết đăng nhập lại cho bạn. Liên kết đã được gửi tới email của bạn.',
          'general',
        );
      });
      // After the commit, never inside it: a mail sent for a transaction that rolled back
      // would point at a token that does not exist.
      await deliverResetLink(req, staff.user_id, resetToken);
      recoverySentAt.set(staffId, Date.now());
      res.json({ success: true, data: { recovery: 'sent' } });
      return;
    }

    // The same entropy the password reset in routes/auth.js mints, because the link does
    // the same job: holding it is the whole proof.
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
    await db.withTransaction(async (tx) => {
      // Before the insert, never after: the new row must not retire itself.
      await tx.run(RETIRE_STAFF_INVITES, staffId);
      await tx.run(
        INSERT_STAFF_INVITE,
        token,
        staffId,
        req.user.id,
        expiresAt,
        new Date().toISOString(),
      );
    });

    await recordEvent('staff_invite_created', '/api/partner/staff/:id/invite');
    res.json({ success: true, data: { url: inviteUrl(token), expires_at: expiresAt } });
  } catch (error) {
    next(error);
  }
});

// The owner changed their mind, or the phone the link was shown on went missing.
router.delete('/staff/:id/invite', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const staffId = requireId(req.params.id, 'Mã kỹ thuật viên không hợp lệ.');
    await ownedRow(selectOwnedStaff, staffId, salon.id, 'Không tìm thấy kỹ thuật viên này.');

    await retireStaffInvites.run(staffId);
    res.json({ success: true, data: { ok: true } });
  } catch (error) {
    next(error);
  }
});

router.get('/staff/:id', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const staff = await ownedRow(
      selectOwnedStaff,
      requireId(req.params.id, 'Mã kỹ thuật viên không hợp lệ.'),
      salon.id,
      'Không tìm thấy kỹ thuật viên này.',
    );
    res.json({ success: true, data: await staffDetail(staff) });
  } catch (error) {
    next(error);
  }
});

router.patch('/staff/:id', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const staffId = requireId(req.params.id, 'Mã kỹ thuật viên không hợp lệ.');
    const staff = await ownedRow(
      selectOwnedStaff,
      staffId,
      salon.id,
      'Không tìm thấy kỹ thuật viên này.',
    );

    /* Nothing here guards `image`, and something used to. A claimed roster row was read as a
       shared object — the salon running the operational half, the technician owning how she
       appeared — so an owner who changed the photo on a claimed row was answered with a 409
       saying the avatar was hers to manage. That was true for exactly as long as she had a way
       to manage it, and she has not had one since her own words and her own face moved onto the
       table behind her own page: routes/staff-me.js writes that one, and nothing anywhere writes
       staff.image on her behalf any more. So the guard stopped being a boundary and became a
       freeze — the owner refused with a 409, the technician refused with a 400, and the team
       strip and the booking picker serving a face for the whole life of the stint that nobody
       left on either side could correct.

       The split is clean now rather than negotiated. Her photo is on her own page, and this
       column is the salon's operational record of who sits in that chair, edited like the name
       and the title beside it. Correcting it cannot reach her: routes/staff.js lays whatever
       she has published over the row wherever she has written something, so an owner tidying
       the roster changes the chair and never the person. */
    const { assignments, values, patch } = await buildPatch(req.body ?? {}, STAFF_COLUMNS);
    /* A new start date arrives unattested, whatever the old one had earned. Appended to the
       same statement rather than run beside it: a date that landed while its ✓ stayed would
       be a profile claiming the technician confirmed a day she has never seen. */
    if (Object.hasOwn(patch, 'started_at')) {
      assignments.push(RESET_STARTED_ATTESTATION);
    }

    /* Putting a departed technician back on the roster is the ONE correction there is for a
       departure recorded on the wrong day: undo it, then record it again with the right date.
       There is no PATCH for left_at, deliberately — a leaving date is a dated event both sides
       answer for, and letting an owner quietly re-write it would make the ✓ beside it a mark
       on whatever the owner last typed.

       So active = 1 on a claimed row that carries a leaving date clears the whole departure in
       the same statement. It has to: left_at and active = 0 are written together and are only
       ever true together — idx_staff_user_salon's "open stint" predicate is active = 1 — and a
       row re-opened with a date still on it would be bookable, public and closed at once, and
       would block the re-hire the date says already happened. The ✓ on the leaving date goes
       with the date; a DISPUTE does not, because the flag covers the whole stint and the date
       under argument is as often started_at, which nothing here touches.

       What does not come back is the calendar: the appointments the departure handed to
       colleagues stay handed on. Re-opening a row says the person is working here again, not
       that the last hour was never given away. */
    const reopening = staff.user_id != null && staff.left_at != null && patch.active === 1;
    if (reopening) {
      assignments.push(RESET_DEPARTURE);
    }

    const update = `UPDATE staff SET ${assignments.join(', ')} WHERE id = ? AND salon_id = ?`;
    try {
      await db.withTransaction(async (tx) => {
        await tx.run(update, ...values, staffId, salon.id);
        /* She was told the day her stint was closed, so she is told the day it is opened again:
           a page that went from "đã nghỉ" back to a working stint without a word would leave
           her to find it out from her own profile. */
        if (reopening) {
          await notifyStaff(
            tx,
            staffId,
            'Ghi nhận nghỉ việc đã được hủy',
            `${salon.name} đã hủy ghi nhận nghỉ việc của bạn. Hồ sơ của bạn trở lại trạng thái đang làm việc.`,
          );
        }
      });
    } catch (error) {
      /* idx_staff_user_salon: one live claimed row per person per salon. The undo above is the
         only thing here that can ask for a second one, and the console leaves its button on
         every claimed card that carries a leaving date — including one the salon has already
         moved past by re-hiring the same technician onto a new row. Pressed there it is asking
         to re-open a stint the next stint replaced, which is a roster that is already right:
         the person is back, and an undo that is genuinely needed belongs on the row still open.
         Said plainly, because an owner reading INTERNAL_ERROR has no way to learn any of it. */
      if (error.code === '23505' && error.constraint === 'idx_staff_user_salon') {
        throw httpError(
          409,
          'CONFLICT',
          'Kỹ thuật viên này đã có hồ sơ đang làm việc tại salon — không thể hủy ghi nhận trên hồ sơ cũ.',
        );
      }
      throw error;
    }

    res.json({
      success: true,
      data: await staffDetail(await selectOwnedStaff.get(staffId, salon.id)),
    });
  } catch (error) {
    next(error);
  }
});

/*
 * Ending a collaboration, from the salon's side.
 *
 * A row somebody stands behind cannot be deleted, only ended, and ending it is dated: the
 * technician's public page reads their stints as a career, and one that merely stopped being
 * active can say nothing but "trước đây". So this is a POST with a date in it rather than a
 * DELETE — the console's own delete refuses a claimed row and points here.
 *
 * The whole of it is one transaction: the stint closes, the technician is told, and the
 * appointments already sold on her calendar are handed on or counted. Half of that committing
 * is a salon whose customers are booked with somebody who no longer works there.
 */
router.post('/staff/:id/departure', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const staffId = requireId(req.params.id, 'Mã kỹ thuật viên không hợp lệ.');
    const staff = await ownedRow(
      selectOwnedStaff,
      staffId,
      salon.id,
      'Không tìm thấy kỹ thuật viên này.',
    );
    /* A chair nobody stands behind has no collaboration to end and nobody to confirm a date:
       it is the salon's own description of a seat, and DELETE takes it off the roster. 409
       rather than 404, in the mirror of what DELETE says about a claimed row — the owner can
       see this row and is being told which door it goes through. */
    if (staff.user_id == null) {
      throw httpError(
        409,
        'CONFLICT',
        'Hồ sơ này chưa có người nhận. Hãy xóa khỏi danh sách thay vì kết thúc hợp tác.',
      );
    }
    if (staff.active !== 1) {
      throw httpError(409, 'CONFLICT', 'Hợp tác với kỹ thuật viên này đã kết thúc.');
    }
    const leftAt = departureDateOrThrow((req.body ?? {}).left_at);

    const swept = await db.withTransaction(async (tx) => {
      // Guarded and re-read here rather than trusted from the row above: two presses of the
      // button, or a technician ending it from her own page at the same moment, both get past
      // that read and only one of them may date the stint.
      const ended = await tx.run(
        `${END_STINT} AND salon_id = ?`, leftAt, 'partner', staffId, salon.id,
      );
      if (ended.changes !== 1) {
        throw httpError(409, 'CONFLICT', 'Hợp tác với kỹ thuật viên này đã kết thúc.');
      }
      /* The row keeps user_id, so notifyStaff still reaches her — a stint that ended is still
         hers, and the date on it is the thing she is being asked to answer for. */
      await notifyStaff(
        tx,
        staffId,
        'Hợp tác đã kết thúc',
        `${salon.name} ghi nhận ngày bạn kết thúc làm việc là ${formatDateVN(leftAt)}. Bạn có thể xác nhận hoặc báo sai ngày này trong hồ sơ của mình.`,
      );
      return sweepFutureBookings(tx, { staffId, salon, leftAt, actorUserId: req.user.id });
    });

    res.json({ success: true, data: { left_at: leftAt, ...swept } });
  } catch (error) {
    next(error);
  }
});

router.delete('/staff/:id', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const staffId = requireId(req.params.id, 'Mã kỹ thuật viên không hợp lệ.');
    const staff = await ownedRow(
      selectOwnedStaff,
      staffId,
      salon.id,
      'Không tìm thấy kỹ thuật viên này.',
    );

    /* A row somebody holds is not a line in a list any more. Ending the collaboration is an
       act with a date on it and two sides to it — her page has to be able to say when she
       worked here, and she has to be able to answer for the date — and none of that survives
       being spelled as a deletion. The unclaimed case below is unchanged: that row is the
       salon's own description of a chair, and taking it off the roster is all it ever was. */
    if (staff.user_id != null) {
      throw httpError(
        409,
        'CONFLICT',
        'Kỹ thuật viên này có tài khoản riêng. Hãy kết thúc hợp tác kèm ngày nghỉ thay vì xóa khỏi danh sách.',
      );
    }

    // Soft delete: past bookings and reviews still point at this row. Whatever claim link
    // was waiting on it goes in the same transaction, because an inactive row can no
    // longer be invited — POST /staff/:id/invite refuses one — so a link left live would
    // be one the owner has no way to replace. And `active` is patchable, so a row restored
    // inside the seven days would otherwise come back with the old token still live: the
    // link the owner thought ending the stint had killed.
    await db.withTransaction(async (tx) => {
      await tx.run(DEACTIVATE_STAFF, staffId, salon.id);
      await tx.run(RETIRE_STAFF_INVITES, staffId);
    });
    res.json({ success: true, data: { ok: true } });
  } catch (error) {
    next(error);
  }
});

/* ============================================================================
 * Time off — holidays, closures and staff leave
 * ========================================================================= */

// Only what is still ahead: a holiday that has been and gone is history, and the console
// panel is a list of what the calendar will refuse next.
const selectTimeOff = db.prepare(`
  SELECT t.id, t.staff_id, t.date_from, t.date_to, t.reason, st.name AS staff_name
  FROM time_off t
  LEFT JOIN staff st ON st.id = t.staff_id
  WHERE t.salon_id = ? AND t.date_to >= ?
  ORDER BY t.date_from, t.id
`);
const insertTimeOff = db.prepare(`
  INSERT INTO time_off (salon_id, staff_id, date_from, date_to, reason, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const selectOwnedTimeOff = db.prepare('SELECT * FROM time_off WHERE id = ? AND salon_id = ?');
const deleteTimeOff = db.prepare('DELETE FROM time_off WHERE id = ? AND salon_id = ?');
// Nothing is cancelled here: the count is what tells the owner how many customers they are
// about to have to call, so they can drop the range again before anyone is stranded.
const countAffectedBookings = db.prepare(`
  SELECT COUNT(*) AS count FROM bookings
  WHERE salon_id = ? AND date >= ? AND date <= ? AND status IN ('pending','confirmed')
    AND (?::int IS NULL OR staff_id = ?::int)
`);

function timeOffShape(row) {
  return {
    id: row.id,
    staff_id: row.staff_id,
    staff_name: row.staff_name ?? null,
    date_from: row.date_from,
    date_to: row.date_to,
    reason: row.reason,
  };
}

router.get('/time-off', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const rows = await selectTimeOff.all(salon.id, todayISO());
    res.json({ success: true, data: rows.map(timeOffShape) });
  } catch (error) {
    next(error);
  }
});

router.post('/time-off', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const body = req.body ?? {};
    // NULL staff_id is the whole salon closing, which is a different thing from a
    // technician's leave and the only way to say "we are shut that day".
    const staffId =
      body.staff_id === null || body.staff_id === undefined
        ? null
        : (
            await ownedRow(
              selectOwnedStaff,
              requireId(body.staff_id, 'Mã kỹ thuật viên không hợp lệ.'),
              salon.id,
              'Không tìm thấy kỹ thuật viên này tại salon của bạn.',
            )
          ).id;
    const dateFrom = requireDate(body.date_from, 'Ngày bắt đầu');
    const dateTo = body.date_to === undefined ? dateFrom : requireDate(body.date_to, 'Ngày kết thúc');
    if (dateTo < dateFrom) {
      throw httpError(400, 'VALIDATION_ERROR', 'Ngày kết thúc phải sau hoặc bằng ngày bắt đầu.');
    }
    if (dateTo > addDaysISO(dateFrom, TIME_OFF_MAX_DAYS - 1)) {
      throw httpError(
        400,
        'VALIDATION_ERROR',
        `Mỗi đợt nghỉ tối đa ${TIME_OFF_MAX_DAYS} ngày.`,
      );
    }
    const reason = optionalLimitedText(body.reason, 'Lý do', TIME_OFF_REASON_MAX);

    const id = Number(
      (
        await insertTimeOff.run(
          salon.id,
          staffId,
          dateFrom,
          dateTo,
          reason,
          new Date().toISOString(),
        )
      ).lastInsertRowid,
    );
    const affected = (
      await countAffectedBookings.get(salon.id, dateFrom, dateTo, staffId, staffId)
    ).count;

    res.json({
      success: true,
      data: {
        id,
        staff_id: staffId,
        staff_name: staffId === null ? null : (await selectOwnedStaff.get(staffId, salon.id)).name,
        date_from: dateFrom,
        date_to: dateTo,
        reason,
        affected_bookings: affected,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.delete('/time-off/:id', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const id = requireId(req.params.id, 'Mã ngày nghỉ không hợp lệ.');
    await ownedRow(selectOwnedTimeOff, id, salon.id, 'Không tìm thấy ngày nghỉ này.');
    await deleteTimeOff.run(id, salon.id);
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

/**
 * A code of the salon's own choosing, minus the one shape it may not choose: the welcome
 * offer every salon joins with is keyed on `MOI20-<salon id>`, and promotions.code is
 * UNIQUE, so a console-made code in that family would be one a future registration cannot
 * write — the salon that took it would break somebody else's sign-up. Refused whatever the
 * case it is typed in, since a lower-case twin would read as the reserved one to a person.
 */
function requirePromotionCode(value) {
  const code = optionalText(value, 'Mã ưu đãi');
  if (code !== null && code.toUpperCase().startsWith(WELCOME_CODE_PREFIX)) {
    throw httpError(
      400,
      'VALIDATION_ERROR',
      `Mã ưu đãi không được bắt đầu bằng "${WELCOME_CODE_PREFIX}" — tiền tố này dành riêng cho ưu đãi chào mừng salon mới.`,
    );
  }
  return code;
}

const PROMOTION_COLUMNS = {
  title: (value) => requireText(value, 'tên ưu đãi'),
  type: (value) => requireOneOf(value, PROMOTION_TYPES, 'Loại ưu đãi không hợp lệ.'),
  description: (value) => optionalText(value, 'Mô tả'),
  code: (value) => requirePromotionCode(value),
  discount_percent: (value) => optionalCount(value, 'Phần trăm giảm giá'),
  discount_amount: (value) => optionalCount(value, 'Số tiền giảm'),
  original_price: (value) => optionalCount(value, 'Giá gốc'),
  sale_price: (value) => optionalCount(value, 'Giá ưu đãi'),
  service_ids: (value) => requireServiceIdList(value, 'Danh sách dịch vụ'),
  image: (value) => optionalMediaUrl(value, 'Ảnh ưu đãi'),
  starts_at: (value) => requireDate(value, 'Ngày bắt đầu'),
  ends_at: (value) => requireDate(value, 'Ngày kết thúc'),
  active: (value) => requireFlag(value, 'Trạng thái hiển thị'),
};

/** Both columns are ISO date text, so a plain comparison orders them. */
function requirePromotionRange(startsAt, endsAt) {
  if (endsAt < startsAt) {
    throw httpError(400, 'VALIDATION_ERROR', 'Ngày kết thúc phải sau ngày bắt đầu.');
  }
}

/**
 * Let the UNIQUE index decide the duplicate case rather than a pre-check, the same
 * way registration does — a SELECT-then-INSERT would still lose the race.
 */
function asCodeTaken(error) {
  if (error.code === '23505' && error.constraint === 'promotions_code_key') {
    return httpError(409, 'CODE_TAKEN', 'Mã ưu đãi này đã được sử dụng.');
  }
  return error;
}

router.get('/promotions', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    // Inactive and expired ones included: this is the owner's own management list.
    res.json({
      success: true,
      data: (await selectSalonPromotions.all(salon.id)).map(promotionShape),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/promotions', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const body = req.body ?? {};
    const startsAt = PROMOTION_COLUMNS.starts_at(body.starts_at);
    const endsAt = PROMOTION_COLUMNS.ends_at(body.ends_at);
    requirePromotionRange(startsAt, endsAt);

    let promotionId;
    try {
      promotionId = Number(
        (
          await insertPromotion.run(
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
            startsAt,
            endsAt,
          )
        ).lastInsertRowid,
      );
    } catch (error) {
      throw asCodeTaken(error);
    }

    res.json({
      success: true,
      data: promotionShape(await selectOwnedPromotion.get(promotionId, salon.id)),
    });
  } catch (error) {
    next(error);
  }
});

router.patch('/promotions/:id', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const promotionId = requireId(req.params.id, 'Mã ưu đãi không hợp lệ.');
    const current = await ownedRow(
      selectOwnedPromotion,
      promotionId,
      salon.id,
      'Không tìm thấy ưu đãi này.',
    );

    const body = req.body ?? {};
    const { assignments, values } = await buildPatch(body, PROMOTION_COLUMNS);
    // A patch may carry one date or neither, so the stored row supplies the other half.
    requirePromotionRange(
      Object.hasOwn(body, 'starts_at')
        ? PROMOTION_COLUMNS.starts_at(body.starts_at)
        : current.starts_at,
      Object.hasOwn(body, 'ends_at') ? PROMOTION_COLUMNS.ends_at(body.ends_at) : current.ends_at,
    );
    try {
      await db
        .prepare(`UPDATE promotions SET ${assignments.join(', ')} WHERE id = ? AND salon_id = ?`)
        .run(...values, promotionId, salon.id);
    } catch (error) {
      throw asCodeTaken(error);
    }

    res.json({
      success: true,
      data: promotionShape(await selectOwnedPromotion.get(promotionId, salon.id)),
    });
  } catch (error) {
    next(error);
  }
});

router.delete('/promotions/:id', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const promotionId = requireId(req.params.id, 'Mã ưu đãi không hợp lệ.');
    await ownedRow(selectOwnedPromotion, promotionId, salon.id, 'Không tìm thấy ưu đãi này.');

    await deletePromotion.run(promotionId, salon.id);
    res.json({ success: true, data: { ok: true } });
  } catch (error) {
    next(error);
  }
});

/* ============================================================================
 * Revenue
 * ========================================================================= */

// The group key is a to_char format, never raw input: the request may only pick a
// key of this map, and the format itself is bound as a parameter. Weeks follow ISO
// numbering (IYYY/IW), which differs marginally from SQLite's %W — accepted.
const REVENUE_GROUPS = {
  day: 'YYYY-MM-DD',
  week: 'IYYY-"W"IW',
  month: 'YYYY-MM',
};

const selectRevenueSeries = db.prepare(`
  SELECT to_char(date::date, ?) AS period,
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

router.get('/revenue', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const group = req.query.group
      ? requireOneOf(req.query.group, Object.keys(REVENUE_GROUPS), 'Cách nhóm dữ liệu không hợp lệ.')
      : 'day';
    const to = req.query.to ? requireDate(req.query.to, 'Ngày kết thúc') : todayISO();
    const from = req.query.from
      ? requireDate(req.query.from, 'Ngày bắt đầu')
      : addDaysISO(to, -(REVENUE_DEFAULT_DAYS - 1));

    const totals = await selectRevenueTotals.get(salon.id, from, to);

    res.json({
      success: true,
      data: {
        from,
        to,
        group,
        series: await selectRevenueSeries.all(REVENUE_GROUPS[group], salon.id, from, to),
        totals: {
          revenue: totals.revenue,
          bookings: totals.bookings,
          // No bookings means no average, not a division by zero.
          avg_ticket: totals.bookings === 0 ? 0 : Math.round(totals.revenue / totals.bookings),
        },
        by_service: await selectRevenueByService.all(salon.id, from, to, TOP_BREAKDOWN_LIMIT),
        by_staff: await selectRevenueByStaff.all(salon.id, from, to, TOP_BREAKDOWN_LIMIT),
      },
    });
  } catch (error) {
    next(error);
  }
});

/* ============================================================================
 * Photo gallery
 * ========================================================================= */

// The public profile reads the same table through GET /api/salons/:id/photos, in the same
// order, so what the console arranges here is what a visitor sees.
const selectSalonPhotos = db.prepare(
  'SELECT id, image, caption, sort FROM salon_photos WHERE salon_id = ? ORDER BY sort, id',
);
const selectOwnedPhoto = db.prepare(
  'SELECT id, image, caption, sort FROM salon_photos WHERE id = ? AND salon_id = ?',
);
const selectNextPhotoPosition = db.prepare(
  'SELECT COALESCE(MAX(sort), 0) + 1 AS position FROM salon_photos WHERE salon_id = ?',
);
const insertSalonPhoto = db.prepare(
  'INSERT INTO salon_photos (salon_id, image, caption, sort) VALUES (?, ?, ?, ?)',
);
const updatePhotoSort = db.prepare(
  'UPDATE salon_photos SET sort = ? WHERE id = ? AND salon_id = ?',
);
// Deleted inside a transaction with the publication re-check below, so it is SQL text.
const DELETE_SALON_PHOTO = 'DELETE FROM salon_photos WHERE id = ? AND salon_id = ?';

router.get('/photos', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const rows = await selectSalonPhotos.all(salon.id);
    res.json({ success: true, data: rows, meta: { total: rows.length } });
  } catch (error) {
    next(error);
  }
});

// The bytes went to POST /api/uploads first; what arrives here is the url that call gave back.
router.post('/photos', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const body = req.body ?? {};
    const image = requireText(body.image, 'ảnh');
    // Same guard the avatar and post-image sinks use: this url is rendered on the public
    // salon gallery, so it may not carry a scheme of its own.
    if (!isSafeMediaUrl(image)) {
      throw httpError(400, 'VALIDATION_ERROR', 'Đường dẫn ảnh không hợp lệ.');
    }
    const caption = optionalLimitedText(body.caption, 'Chú thích ảnh', PHOTO_CAPTION_MAX);
    const { position } = await selectNextPhotoPosition.get(salon.id);
    const photoId = Number(
      (await insertSalonPhoto.run(salon.id, image, caption, position)).lastInsertRowid,
    );
    res.json({ success: true, data: await selectOwnedPhoto.get(photoId, salon.id) });
  } catch (error) {
    next(error);
  }
});

// Only the position: the caption and the image are what the upload put there, and a photo
// moves in the gallery by swapping this number with its neighbour's.
router.patch('/photos/:id', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const photoId = requireId(req.params.id, 'Mã ảnh không hợp lệ.');
    await ownedRow(selectOwnedPhoto, photoId, salon.id, 'Không tìm thấy ảnh này.');
    await updatePhotoSort.run(
      requireCount((req.body ?? {}).sort, 'Thứ tự ảnh'),
      photoId,
      salon.id,
    );
    res.json({ success: true, data: await selectOwnedPhoto.get(photoId, salon.id) });
  } catch (error) {
    next(error);
  }
});

router.delete('/photos/:id', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const photoId = requireId(req.params.id, 'Mã ảnh không hợp lệ.');
    await ownedRow(selectOwnedPhoto, photoId, salon.id, 'Không tìm thấy ảnh này.');
    await db.withTransaction(async (tx) => {
      await tx.run(DELETE_SALON_PHOTO, photoId, salon.id);
      await unpublishIfNotReady(tx, salon, req.user.id);
    });
    res.json({ success: true, data: { ok: true } });
  } catch (error) {
    next(error);
  }
});

/* ============================================================================
 * Salon profile
 * ========================================================================= */

const selectSalonById = db.prepare('SELECT * FROM salons WHERE id = ?');
// The hours writes all happen inside one transaction, so these are kept as SQL text.
const INSERT_SALON_HOURS =
  'INSERT INTO salon_hours (salon_id, weekday, "start", "end", is_off) VALUES (?, ?, ?, ?, ?)';
const DELETE_SALON_HOURS = 'DELETE FROM salon_hours WHERE salon_id = ?';
const UPDATE_SALON_SUMMARY = 'UPDATE salons SET open_time = ?, close_time = ? WHERE id = ?';
const DELETE_SALON_SOCIAL_LINKS = 'DELETE FROM salon_social_links WHERE salon_id = ?';
const INSERT_SALON_SOCIAL_LINK =
  'INSERT INTO salon_social_links (salon_id, platform, url) VALUES (?, ?, ?) RETURNING platform';

/**
 * A whitelisted numeric setting, without Number()'s blind spots.
 *
 * Number(null), Number('') and Number([]) are all 0 — a legal lead time — so a client
 * that meant "leave this one alone" would silently reset it. Only a number or the digits
 * of a string qualify; everything else becomes NaN and fails the whitelist.
 */
function toChoice(value) {
  if (typeof value === 'number') {
    return value;
  }
  return typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
}

// What a salon must hold before the public side may list it: somewhere to go, a week that
// says when, something to book, and one picture. Read in one query so a refusal can name
// what is still missing instead of only saying no.
const PUBLISH_READINESS_SQL = `
  SELECT
    (COALESCE(s.address, '') <> '') AS has_address,
    EXISTS (SELECT 1 FROM salon_hours h WHERE h.salon_id = s.id AND h.is_off = 0) AS has_hours,
    EXISTS (SELECT 1 FROM services sv WHERE sv.salon_id = s.id AND sv.active = 1) AS has_service,
    (COALESCE(s.image, '') <> ''
      OR EXISTS (SELECT 1 FROM salon_photos p WHERE p.salon_id = s.id)) AS has_photo
  FROM salons s WHERE s.id = ?
`;

const PUBLISH_REQUIREMENTS = [
  ['has_address', 'địa chỉ'],
  ['has_hours', 'giờ mở cửa'],
  ['has_service', 'ít nhất một dịch vụ đang hiển thị'],
  ['has_photo', 'ít nhất một ảnh'],
];

/**
 * Refuse to go live with a message that names the gaps, in the order the console lists them.
 *
 * Read through the caller's transaction, after its writes: the answer has to be about the
 * salon as the request leaves it, not as it was before the update ran.
 */
async function assertPublishable(salonId, tx) {
  const row = await tx.get(PUBLISH_READINESS_SQL, salonId);
  const missing = PUBLISH_REQUIREMENTS.filter(([key]) => !row[key]).map(([, label]) => label);
  if (missing.length > 0) {
    throw httpError(
      409,
      'SALON_NOT_READY',
      `Salon chưa đủ điều kiện hiển thị trên OAK: còn thiếu ${missing.join(', ')}.`,
    );
  }
}

/**
 * Take a listed salon back off the public list once a write has left it short.
 *
 * Hiding or deleting the last visible service — or the last photo of a salon with no
 * cover — is allowed, but it would otherwise leave a listed profile a customer can open
 * with nothing to book. The salon drops to draft instead, and its owner is told why so
 * the switch does not simply appear to have flipped itself.
 */
async function unpublishIfNotReady(tx, salon, ownerId) {
  if (salon.published !== 1) {
    return;
  }
  const row = await tx.get(PUBLISH_READINESS_SQL, salon.id);
  const missing = PUBLISH_REQUIREMENTS.filter(([key]) => !row[key]).map(([, label]) => label);
  if (missing.length === 0) {
    return;
  }
  await tx.run('UPDATE salons SET published = 0 WHERE id = ?', salon.id);
  await notifyUser(
    tx,
    ownerId,
    'Salon đã tạm ẩn khỏi OAK',
    `${salon.name} không còn đủ điều kiện hiển thị: còn thiếu ${missing.join(', ')}. Bổ sung rồi bật lại công tắc “Hiển thị trên OAK”.`,
    'general',
  );
}

const SALON_COLUMNS = {
  name: (value) => requireText(value, 'tên salon'),
  description: (value) => optionalText(value, 'Mô tả'),
  address: (value) => optionalText(value, 'Địa chỉ'),
  district: (value) => optionalText(value, 'Quận/Huyện'),
  city: (value) => optionalText(value, 'Tỉnh/Thành phố'),
  phone: (value) => optionalText(value, 'Số điện thoại'),
  image: (value) => optionalMediaUrl(value, 'Ảnh đại diện'),
  lat: (value) => optionalCoordinate(value, 'Vĩ độ', 90),
  lng: (value) => optionalCoordinate(value, 'Kinh độ', 180),
  amenities: (value) => requireJsonStringArray(value, 'Tiện ích'),
  tags: (value) => requireJsonStringArray(value, 'Thẻ phân loại'),
  tour_url: (value) => optionalHttpsUrl(value, 'Đường dẫn tour 360'),
  auto_confirm: (value) => requireFlag(value, 'Tự động xác nhận'),
  lead_time_min: (value) =>
    requireOneOf(toChoice(value), LEAD_TIME_CHOICES, 'Thời gian báo trước không hợp lệ.'),
  cancel_cutoff_hours: (value) =>
    requireOneOf(toChoice(value), CANCEL_CUTOFF_CHOICES, 'Hạn hủy không hợp lệ.'),
  cancel_policy_text: (value) => optionalLimitedText(value, 'Chính sách hủy', CANCEL_POLICY_MAX),
  published: (value) => requireFlag(value, 'Hiển thị trên OAK'),
};

function parseSocialLinks(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(400, 'VALIDATION_ERROR', 'Mạng xã hội phải là một đối tượng.');
  }
  const unknown = Object.keys(value).filter(
    (platform) => !SOCIAL_PROFILE_PLATFORMS.includes(platform),
  );
  if (unknown.length > 0) {
    throw httpError(400, 'VALIDATION_ERROR', `Mạng xã hội không được hỗ trợ: ${unknown[0]}.`);
  }
  return SOCIAL_PROFILE_PLATFORMS.flatMap((platform) => {
    const raw = Object.hasOwn(value, platform) ? value[platform] : '';
    if (typeof raw !== 'string') {
      throw httpError(400, 'VALIDATION_ERROR', `Link ${platform} phải là chuỗi ký tự.`);
    }
    if (raw.trim() === '') {
      return [];
    }
    try {
      return [{ platform, url: validateSocialProfile(raw, platform) }];
    } catch (error) {
      if (error instanceof SocialProfileError) {
        throw httpError(400, 'VALIDATION_ERROR', error.message);
      }
      throw error;
    }
  });
}

/**
 * Validate a full-replace opening-hours payload: the whole week, one row per weekday.
 *
 * A day off carries no times, so whatever the form left in its inputs is dropped.
 * open_time/close_time are no longer patchable columns — they are derived from here.
 */
function parseSalonHours(value) {
  const rows = requireArray(value, 'Giờ mở cửa').map((entry) => {
    if (entry === null || typeof entry !== 'object') {
      throw httpError(400, 'VALIDATION_ERROR', 'Mỗi ngày trong tuần phải là một đối tượng.');
    }
    const weekday = Number(entry.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw httpError(400, 'VALIDATION_ERROR', 'Thứ trong tuần phải là số từ 0 đến 6.');
    }
    const isOff = entry.is_off === undefined ? 0 : requireFlag(entry.is_off, 'Ngày nghỉ');
    if (isOff === 1) {
      return { weekday, start: null, end: null, is_off: 1 };
    }
    const start = requireTime(entry.start, 'Giờ mở cửa');
    const end = requireTime(entry.end, 'Giờ đóng cửa');
    if (toMinutes(start) >= toMinutes(end)) {
      throw httpError(400, 'VALIDATION_ERROR', 'Giờ mở cửa phải sớm hơn giờ đóng cửa.');
    }
    return { weekday, start, end, is_off: 0 };
  });

  // The whole week or nothing: a partial payload would silently close the missing days,
  // and a repeated weekday would fail on UNIQUE(salon_id, weekday) mid-transaction.
  const weekdays = new Set(rows.map((row) => row.weekday));
  if (rows.length !== DAYS_IN_WEEK || weekdays.size !== DAYS_IN_WEEK) {
    throw httpError(
      400,
      'VALIDATION_ERROR',
      'Vui lòng khai báo đủ 7 ngày trong tuần, mỗi thứ một lần.',
    );
  }
  return rows;
}

/** The whole-week summary written back to salons: earliest opening, latest closing. */
function hoursSummary(hours) {
  const open = hours.filter((day) => day.is_off === 0);
  const starts = open.map((day) => day.start).sort();
  const ends = open.map((day) => day.end).sort();
  return [starts[0] ?? null, ends[ends.length - 1] ?? null];
}

router.get('/salon', async (req, res, next) => {
  try {
    res.json({ success: true, data: await salonShape(await ownedSalon(req)) });
  } catch (error) {
    next(error);
  }
});

router.patch('/salon', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const body = req.body ?? {};
    const allowedFields = new Set([...Object.keys(SALON_COLUMNS), 'hours', 'social_links']);
    const unknownFields = Object.keys(body).filter((field) => !allowedFields.has(field));
    if (unknownFields.length > 0) {
      throw httpError(400, 'VALIDATION_ERROR', `Trường không được hỗ trợ: ${unknownFields[0]}.`);
    }
    // A coordinate is a pair. Letting half of one through would leave the salon pinned
    // on a meridian somewhere, so both columns move together or neither does.
    if (Object.hasOwn(body, 'lat') !== Object.hasOwn(body, 'lng')) {
      throw httpError(400, 'VALIDATION_ERROR', 'Vĩ độ và kinh độ phải được cập nhật cùng nhau.');
    }
    // Naming both keys is not enough: one of them may still parse to null, which would
    // store half a coordinate. Cheaper to parse twice here than to special-case buildPatch.
    if (Object.hasOwn(body, 'lat')) {
      const lat = optionalCoordinate(body.lat, 'Vĩ độ', 90);
      const lng = optionalCoordinate(body.lng, 'Kinh độ', 180);
      if ((lat === null) !== (lng === null)) {
        throw httpError(400, 'VALIDATION_ERROR', 'Vĩ độ và kinh độ phải được cập nhật cùng nhau.');
      }
    }
    // Whether this save leaves the salon listed — checked below against the row it writes,
    // not the one it read, so no single request can both publish a salon and remove what
    // publishing requires.
    const staysPublished = Object.hasOwn(body, 'published')
      ? SALON_COLUMNS.published(body.published) === 1
      : salon.published === 1;
    const hours = body.hours === undefined ? null : parseSalonHours(body.hours);
    const socialLinks = body.social_links === undefined ? null : parseSocialLinks(body.social_links);
    // buildPatch refuses an empty SET clause, so it only runs when the body really
    // names a column — `hours` alone is a valid update, and so is a column alone.
    const patch = Object.keys(SALON_COLUMNS).some((column) => Object.hasOwn(body, column))
      ? await buildPatch(body, SALON_COLUMNS)
      : null;
    if (!patch && !hours && !socialLinks) {
      throw httpError(400, 'VALIDATION_ERROR', 'Không có thông tin nào để cập nhật.');
    }

    // Keyed by the derived id, so no body field can redirect the update elsewhere.
    await db.withTransaction(async (tx) => {
      if (patch) {
        await tx.run(
          `UPDATE salons SET ${patch.assignments.join(', ')} WHERE id = ?`,
          ...patch.values,
          salon.id,
        );
      }
      if (hours) {
        // Full replace: the payload is the whole week, so the old rows go first.
        await tx.run(DELETE_SALON_HOURS, salon.id);
        for (const day of hours) {
          await tx.run(INSERT_SALON_HOURS, salon.id, day.weekday, day.start, day.end, day.is_off);
        }
        await tx.run(UPDATE_SALON_SUMMARY, ...hoursSummary(hours), salon.id);
      }
      if (socialLinks) {
        await tx.run(DELETE_SALON_SOCIAL_LINKS, salon.id);
        for (const link of socialLinks) {
          await tx.run(INSERT_SALON_SOCIAL_LINK, salon.id, link.platform, link.url);
        }
      }
      // Only the fields publishing depends on are worth re-checking. A listed salon
      // saving its phone number or its cancellation policy takes nothing away, and
      // refusing that save would strand the owner behind an error about services.
      const touchesReadiness =
        Object.hasOwn(body, 'published') ||
        Object.hasOwn(body, 'address') ||
        Object.hasOwn(body, 'image') ||
        Boolean(hours);
      if (staysPublished && touchesReadiness) {
        await assertPublishable(salon.id, tx);
      }
    });

    res.json({ success: true, data: await salonShape(await selectSalonById.get(salon.id)) });
  } catch (error) {
    next(error);
  }
});

/* ============================================================================
 * Search
 * ========================================================================= */

// The phone number is how a salon looks a customer up when they ring: the code is on a
// screen they cannot see and the name is spelled three different ways. The number is
// matched on digits alone, on both sides — the receptionist reads it off a caller ID
// without the spaces it was saved with, and either shape has to find the other.
const searchBookings = db.prepare(`
  SELECT id, code, customer_name FROM bookings
  WHERE salon_id = ? AND (
    code ILIKE ? OR customer_name ILIKE ?
    OR (? <> '' AND regexp_replace(COALESCE(customer_phone, ''), '[^0-9]', '', 'g') LIKE ?)
  )
  ORDER BY date DESC, id DESC LIMIT ?
`);
const searchServices = db.prepare(
  'SELECT id, name FROM services WHERE salon_id = ? AND name ILIKE ? ORDER BY name LIMIT ?',
);
const searchStaff = db.prepare(
  'SELECT id, name FROM staff WHERE salon_id = ? AND name ILIKE ? ORDER BY name LIMIT ?',
);

router.get('/search', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const query = req.query.q ? String(req.query.q).trim() : '';
    // An empty box is not an error, it simply has nothing to show yet.
    if (query === '') {
      res.json({ success: true, data: [] });
      return;
    }

    const term = `%${query}%`;
    const digits = query.replace(/[^0-9]/g, '');
    const results = [
      ...(
        await searchBookings.all(salon.id, term, term, digits, `%${digits}%`, SEARCH_LIMIT)
      ).map((row) => ({
        type: 'booking',
        id: row.id,
        label: [row.code, row.customer_name].filter(Boolean).join(' · '),
      })),
      ...(await searchServices.all(salon.id, term, SEARCH_LIMIT)).map((row) => ({
        type: 'service',
        id: row.id,
        label: row.name,
      })),
      ...(await searchStaff.all(salon.id, term, SEARCH_LIMIT)).map((row) => ({
        type: 'staff',
        id: row.id,
        label: row.name,
      })),
    ];

    res.json({ success: true, data: results });
  } catch (error) {
    next(error);
  }
});

export default router;
