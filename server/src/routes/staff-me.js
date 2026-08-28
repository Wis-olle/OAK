/*
 * The technician's own side of OAK: taking a roster row over, and reading what that row
 * is booked for.
 *
 * Everything here is scoped to the signed-in person through staff.user_id, never through
 * an id in the path, so there is no roster row a technician can address that is not one
 * they hold.
 */
import express from 'express';
import { db } from '../db.js';
import { recordEvent } from '../lib/events.js';
import {
  CLAIM_STAFF_ROW,
  SPEND_STAFF_INVITE,
  findLiveInvite,
  inviteNotFound,
} from '../lib/staff-invite.js';
import { staffStats } from '../lib/staff-stats.js';
import { addDaysISO, isISODate, todayISO } from '../lib/time.js';
import { httpError, requireAuth, requireStaff } from '../middleware/auth.js';

const router = express.Router();

/* Signed in, but not necessarily staff. requireStaff is deliberately NOT applied to the
   whole router: /claim is the endpoint a CUSTOMER account calls, and it is the very thing
   that turns them into staff. The two reads below carry it themselves. */
router.use(requireAuth);

const BOOKING_STATUSES = ['pending', 'confirmed', 'completed', 'cancelled', 'no_show'];
const DEFAULT_RANGE_DAYS = 14;

// In place, keeping the same row: a technician who books appointments as a customer keeps
// that history when they step behind the counter. Every endpoint they already use reads
// the role out of the database on each request, so the cookie in their browser survives
// the change. Guarded on the role it is upgrading from, so nothing else can be overwritten.
const UPGRADE_TO_STAFF = "UPDATE users SET role = 'staff' WHERE id = ? AND role = 'customer'";

/**
 * Redeem a claim link as somebody who already holds an OAK account.
 *
 * The other half of this — a technician with no account at all — is
 * POST /api/auth/staff/register, which has to create the account first.
 */
router.post('/claim', async (req, res, next) => {
  try {
    const invite = await findLiveInvite((req.body ?? {}).token);
    if (!invite) {
      throw inviteNotFound();
    }

    // A salon owner is not upgraded into their own technician: the console derives its
    // salon from the signed-in owner, and an account that was both would have two
    // incompatible readings of "your salon". A second address costs nothing.
    if (req.user.role === 'partner') {
      throw httpError(
        409,
        'CONFLICT',
        'Tài khoản đối tác không thể nhận hồ sơ kỹ thuật viên. Vui lòng dùng một email khác.',
      );
    }

    const claimedAt = new Date().toISOString();
    try {
      await db.withTransaction(async (tx) => {
        if (req.user.role === 'customer') {
          await tx.run(UPGRADE_TO_STAFF, req.user.id);
        }
        // Guarded, and re-read here rather than trusted from findLiveInvite above: two
        // people opening one link both get past that read, and only one of them can
        // change these rows.
        const claimed = await tx.run(CLAIM_STAFF_ROW, req.user.id, claimedAt, invite.staff_id);
        if (claimed.changes !== 1) {
          throw httpError(409, 'CONFLICT', 'Hồ sơ này đã có người nhận.');
        }
        const spent = await tx.run(SPEND_STAFF_INVITE, invite.token);
        if (spent.changes !== 1) {
          throw httpError(409, 'CONFLICT', 'Hồ sơ này đã có người nhận.');
        }
      });
    } catch (error) {
      // idx_staff_user_salon: one live claimed row per person per salon. A technician who
      // already works here holding two rows would leave the salon unable to say which of
      // them a booking is for. Somebody working at three salons still claims three rows.
      if (error.code === '23505' && error.constraint === 'idx_staff_user_salon') {
        throw httpError(409, 'CONFLICT', 'Bạn đã có hồ sơ kỹ thuật viên tại salon này.');
      }
      throw error;
    }

    await recordEvent('staff_claimed', '/api/staff-me/claim');
    res.json({ success: true, data: { ok: true } });
  } catch (error) {
    next(error);
  }
});

// Ordered by staff id, which is the order the rows were opened: somebody working at two
// salons sees the older stint first.
const selectClaimedStaff = db.prepare(`
  SELECT st.id, st.name, st.title, st.specialty, st.image, st.active, st.claimed_at,
         s.id AS salon_id, s.name AS salon_name, s.slug AS salon_slug
  FROM staff st
  JOIN salons s ON s.id = st.salon_id
  WHERE st.user_id = ?
  ORDER BY st.id
`);

router.get('/profile', requireStaff, async (req, res, next) => {
  try {
    const rows = await selectClaimedStaff.all(req.user.id);

    /* The same block lib/staff-stats.js serves the public profile, from the same query: a
       technician has to be able to read their own numbers exactly as a customer reads them,
       or the two pages become an argument. One call per roster row rather than one query
       over all of them — a person holds one stint, two if they work at a second salon. */
    const data = [];
    for (const row of rows) {
      data.push({
        staff_id: row.id,
        salon: { id: row.salon_id, name: row.salon_name, slug: row.salon_slug },
        name: row.name,
        title: row.title,
        specialty: row.specialty,
        image: row.image,
        active: row.active,
        claimed_at: row.claimed_at,
        stats: await staffStats(row.id),
      });
    }

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

/* The same join routes/bookings.js reads a booking through, and deliberately a much
   narrower list of columns, because privacy is the whole point of this endpoint. It is
   the one read in the codebase where the person asking is neither the customer nor the
   salon owner, so what a technician gets is what they need to work a shift and nothing
   else: NEVER customer_phone, NEVER b.note — the customer's own words, written to the
   salon and sometimes about the technician — and never the customer's full name.
   customer_name is selected only so the given name can be cut out of it below. */
const STAFF_BOOKING_COLUMNS = `
  b.id, b.date, b.time, b.status, b.total_price, b.customer_name,
  sv.id AS service_id, sv.name AS service_name,
  s.id AS salon_id, s.name AS salon_name
`;
// The staff join is inner, not left: this list IS "the rows my roster row is booked for",
// so a booking with no technician on it has nothing to do with anybody here.
const STAFF_BOOKING_FROM = `
  FROM bookings b
  JOIN services sv ON sv.id = b.service_id
  JOIN salons s ON s.id = b.salon_id
  JOIN staff st ON st.id = b.staff_id
`;

/**
 * The given name out of a Vietnamese full name: 'Nguyễn Thị Mai Lan' -> 'Lan'.
 *
 * Vietnamese name order puts the family name first and the given name last, and the given
 * name is what one greets somebody with — it is also the half that identifies nobody on
 * its own, which is why it is the half a technician gets. A booking taken without a name
 * has none to give.
 */
export function givenName(fullName) {
  if (typeof fullName !== 'string') {
    return null;
  }
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  return parts.length === 0 ? null : parts[parts.length - 1];
}

/** An ISO date from the query string, or the fallback when it was not asked for. */
function rangeDate(value, fallback, label) {
  if (value === undefined || value === '') {
    return fallback;
  }
  if (!isISODate(value)) {
    throw httpError(400, 'VALIDATION_ERROR', `${label} không hợp lệ.`);
  }
  return value;
}

router.get('/bookings', requireStaff, async (req, res, next) => {
  try {
    const today = todayISO();
    const from = rangeDate(req.query.from, today, 'Ngày bắt đầu');
    const to = rangeDate(req.query.to, addDaysISO(today, DEFAULT_RANGE_DAYS), 'Ngày kết thúc');

    // active = 1, not user_id alone: taking somebody off the roster is a soft delete that
    // deliberately keeps user_id, so their past work stays attributed to a person. It must
    // not also leave them reading the salon's calendar — a stint that has ended is not a
    // licence to keep seeing who is coming in next week. GET /profile still shows the row,
    // flagged inactive: that one is their own history rather than the salon's diary.
    const conditions = ['st.user_id = ?', 'st.active = 1', 'b.date >= ?', 'b.date <= ?'];
    const params = [req.user.id, from, to];
    if (req.query.status !== undefined && req.query.status !== '') {
      if (!BOOKING_STATUSES.includes(req.query.status)) {
        throw httpError(400, 'VALIDATION_ERROR', 'Trạng thái lịch hẹn không hợp lệ.');
      }
      conditions.push('b.status = ?');
      params.push(req.query.status);
    }

    const rows = await db
      .prepare(
        `SELECT ${STAFF_BOOKING_COLUMNS} ${STAFF_BOOKING_FROM}
         WHERE ${conditions.join(' AND ')}
         ORDER BY b.date DESC, b.time DESC`,
      )
      .all(...params);

    res.json({
      success: true,
      data: rows.map((row) => ({
        id: row.id,
        date: row.date,
        time: row.time,
        status: row.status,
        total_price: row.total_price,
        service: { id: row.service_id, name: row.service_name },
        salon: { id: row.salon_id, name: row.salon_name },
        customer: { given_name: givenName(row.customer_name) },
      })),
    });
  } catch (error) {
    next(error);
  }
});

export default router;
