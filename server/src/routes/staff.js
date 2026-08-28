// Public staff profiles: detail, week availability, reviews.
import express from 'express';
import { db } from '../db.js';
import { getStaffSlots, getStaffWeek, timeOffOn } from '../lib/availability.js';
import { parseJsonArray, parsePagination } from '../lib/query.js';
import { staffStats } from '../lib/staff-stats.js';
import { addDaysISO, isISODate, todayISO } from '../lib/time.js';
import { httpError } from '../middleware/auth.js';

const router = express.Router();

const REVIEW_LIMIT = 10;
const DEFAULT_DAYS = 7;
const MIN_DAYS = 1;
const MAX_DAYS = 14;

/* The technician's withdrawal, in the one clause every page-shaped read in this file is
   gated on. COALESCE because the column was added to a table that already had rows, so an
   unwritten one is 0 rather than a reason to disappear; user_id IS NULL because a row nobody
   stands behind has nobody to have withdrawn it — the predicate is "claimed AND hidden"
   everywhere it appears, and a bare hidden test would let a stray column value take a salon's
   own roster entry off the site. */
const VISIBLE_PROFILE = '(st.user_id IS NULL OR COALESCE(st.profile_hidden, 0) = 0)';

// THIS IS the public profile page, so the withdrawal lands here first: a hidden row answers
// 404 in the same words as an id that names nobody. Not "no longer exists" and not "hidden" —
// a reply that told those apart would put the page back up in the negative.
const selectStaffProfile = db.prepare(`
  SELECT st.id, st.name, st.title, st.specialty, st.bio, st.image, st.rating,
         st.years_experience, st.portfolio,
         s.id AS salon_id, s.slug AS salon_slug, s.name AS salon_name
  FROM staff st
  JOIN salons s ON s.id = st.salon_id
  WHERE st.id = ? AND st.active = 1 AND ${VISIBLE_PROFILE}
`);

/* Deliberately NOT gated on the withdrawal: this is what /:id/availability and /:id/services
   resolve their path through, and both of those are operational. Once the booking wizard has
   a technician, those two size the day strip and list what that person performs — and a
   technician who has taken their page down is still at work today, still on the calendar, and
   still owed the appointments the salon has already put on it. Hiding a page is not calling
   in sick. The review list below asks the visible question instead, on its own statement. */
const selectStaffExists = db.prepare('SELECT 1 FROM staff WHERE id = ? AND active = 1');

const selectVisibleStaffExists = db.prepare(
  `SELECT 1 FROM staff st WHERE st.id = ? AND st.active = 1 AND ${VISIBLE_PROFILE}`,
);

const selectStaffSalon = db.prepare('SELECT salon_id FROM staff WHERE id = ?');

const selectStaffReviews = db.prepare(`
  SELECT r.id, r.rating, r.comment, r.created_at,
         u.name AS user_name, u.avatar AS user_avatar
  FROM reviews r
  LEFT JOIN users u ON u.id = r.user_id
  WHERE r.staff_id = ?
  ORDER BY r.created_at DESC, r.id DESC
  LIMIT ? OFFSET ?
`);

// What this one technician is booked for: the staff-profile week grid is sized by their
// longest service until one of these is chosen, and then by that one.
const selectStaffServices = db.prepare(`
  SELECT sv.id, sv.name, sv.price, sv.price_is_from, sv.duration_min, sv.category
  FROM services sv
  JOIN staff_services ss ON ss.service_id = sv.id
  WHERE ss.staff_id = ? AND sv.active = 1
  ORDER BY sv.featured DESC, sv.category, sv.price
`);

// Computed over every review of this staff member, not just the page being served.
const selectStaffReviewSummary = db.prepare(
  'SELECT COUNT(*) AS total, ROUND(AVG(rating), 1) AS average FROM reviews WHERE staff_id = ?',
);

/** Resolve a :id path segment to an existing active staff id, or 404. */
async function staffIdOrThrow(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || !(await selectStaffExists.get(id))) {
    throw httpError(404, 'NOT_FOUND', 'Không tìm thấy kỹ thuật viên này.');
  }
  return id;
}

/** The same resolution for the reads that ARE the public profile, in the same words. */
async function visibleStaffIdOrThrow(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || !(await selectVisibleStaffExists.get(id))) {
    throw httpError(404, 'NOT_FOUND', 'Không tìm thấy kỹ thuật viên này.');
  }
  return id;
}

/**
 * Per-day slots for one technician performing one service, in getStaffWeek's shape —
 * `closed` included, because this is the endpoint the wizard's day strip calls once a
 * technician has been chosen, and without the flag it strikes a declared day off through
 * as "full". The salon is read once for the whole week, the day-off rows once per date.
 *
 * Sized by the chosen service's duration — the same calculation POST /api/bookings
 * validates against — so the picker never hides a start time the API would accept.
 */
async function getServiceWeek(staffId, serviceId, from, days) {
  const salonId = (await selectStaffSalon.get(staffId))?.salon_id ?? null;
  const week = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = addDaysISO(from, offset);
    const off = salonId === null ? { salon: false, staff: new Set() } : await timeOffOn(salonId, date);
    week.push({
      date,
      closed: off.salon || off.staff.has(staffId),
      // The day-off rows this loop just read are the ones getStaffSlots would go and read
      // again, once per day of the week.
      slots: await getStaffSlots(staffId, serviceId, date, off),
    });
  }
  return week;
}

router.get('/:id/availability', async (req, res, next) => {
  try {
    const staffId = await staffIdOrThrow(req.params.id);

    const from = req.query.from === undefined ? todayISO() : req.query.from;
    if (!isISODate(from)) {
      throw httpError(400, 'VALIDATION_ERROR', 'Ngày bắt đầu phải theo định dạng YYYY-MM-DD.');
    }

    const days = Math.min(
      MAX_DAYS,
      Math.max(MIN_DAYS, Number.parseInt(req.query.days, 10) || DEFAULT_DAYS),
    );

    // With ?service_id the grid is sized for that one service; without it, the week
    // grid keeps its max-duration sizing for the staff-profile view.
    let serviceId = null;
    if (req.query.service_id !== undefined) {
      serviceId = Number.parseInt(req.query.service_id, 10);
      if (!Number.isInteger(serviceId) || serviceId <= 0) {
        throw httpError(400, 'VALIDATION_ERROR', 'Mã dịch vụ không hợp lệ.');
      }
    }

    const week =
      serviceId === null
        ? await getStaffWeek(staffId, from, days)
        : await getServiceWeek(staffId, serviceId, from, days);

    res.json({ success: true, data: { from, week } });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/services', async (req, res, next) => {
  try {
    const rows = await selectStaffServices.all(await staffIdOrThrow(req.params.id));
    res.json({
      success: true,
      data: rows.map((row) => ({ ...row, price_is_from: Boolean(row.price_is_from) })),
      meta: { total: rows.length },
    });
  } catch (error) {
    next(error);
  }
});

/* Hidden with the page, because it IS the page: this is the review list the public profile
   renders under itself, and leaving it open would serve the contents of a page that is no
   longer there — the same words, the same faces, one endpoint further in.

   What is deliberately NOT touched is the salon's own list. GET /api/salons/:id/reviews joins
   staff_name and goes on naming this technician in the reviews of visits they worked: that is
   the salon's record of its own work, written by its own customers, and gutting it to honour
   one person's withdrawal would take the salon's history down with the technician's page. */
router.get('/:id/reviews', async (req, res, next) => {
  try {
    const staffId = await visibleStaffIdOrThrow(req.params.id);
    const { page, limit, offset } = parsePagination(req.query, REVIEW_LIMIT);
    const summary = await selectStaffReviewSummary.get(staffId);
    const rows = await selectStaffReviews.all(staffId, limit, offset);

    res.json({
      success: true,
      data: rows.map((row) => ({
        id: row.id,
        rating: row.rating,
        comment: row.comment,
        created_at: row.created_at,
        user: { name: row.user_name, avatar: row.user_avatar },
      })),
      meta: { page, limit, total: summary.total, average: summary.average ?? 0 },
    });
  } catch (error) {
    next(error);
  }
});

/* The CV: every stint the person behind this row has held on OAK, newest first.
 *
 * Deliberately NOT gated on active = 1, and it is the only read in this file that is not: a
 * stint that ended is exactly what a career is made of, and the row it is being asked about
 * may itself be a closed one — a technician between salons has no open row anywhere, and
 * answering 404 would delete her working life the day she left. The withdrawal is honoured
 * as it is on the profile itself: claimed AND hidden is 404, in the same words, and a stint
 * whose page is down is left out of the list rather than reappearing inside another one.
 *
 * By staff id in DESCENDING order, which is the order the stints were opened, newest first:
 * a row is opened when somebody joins a salon, so the ids ARE the sequence. Sorting by
 * started_at instead would sort by a column that is empty on most rows and puts a stint the
 * salon back-dated above the one the technician is working today.
 */
const selectStaffStints = db.prepare(`
  SELECT st.id, st.user_id, st.active, st.started_at, st.left_at, st.left_by,
         st.started_confirmed_at, st.left_confirmed_at, st.tenure_disputed,
         s.id AS salon_id, s.slug AS salon_slug, s.name AS salon_name
  FROM staff st
  JOIN salons s ON s.id = st.salon_id
  WHERE st.user_id = ? AND ${VISIBLE_PROFILE}
  ORDER BY st.id DESC
`);
const selectVisibleStaffRow = db.prepare(`
  SELECT st.id, st.user_id, st.active, st.started_at, st.left_at, st.left_by,
         st.started_confirmed_at, st.left_confirmed_at, st.tenure_disputed,
         s.id AS salon_id, s.slug AS salon_slug, s.name AS salon_name
  FROM staff st
  JOIN salons s ON s.id = st.salon_id
  WHERE st.id = ? AND ${VISIBLE_PROFILE}
`);

/** One stint, in the shape the CV renders: where, when, and what is behind it. */
async function stintShape(row) {
  const stats = await staffStats(row.id);
  return {
    staff_id: row.id,
    salon: { id: row.salon_id, slug: row.salon_slug, name: row.salon_name },
    started_at: stats.started_at,
    left_at: row.left_at,
    left_by: row.left_by,
    started_confirmed: Boolean(row.started_confirmed_at),
    left_confirmed: Boolean(row.left_confirmed_at),
    tenure_disputed: row.tenure_disputed ?? 0,
    // Open stints only, and both halves of it: a row is open while it carries no leaving date
    // AND is still on the roster, which is the pairing idx_staff_user_salon rests on.
    is_current: row.left_at === null && row.active === 1,
    // The badge rule, decided in lib/staff-stats.js so this page and the console cannot come
    // to different conclusions about the same two columns.
    tenure_verified: stats.tenure_verified,
    verified_count: stats.verified_count,
    review_count: stats.review_count,
    rating_avg: stats.rating_avg,
  };
}

router.get('/:id/history', async (req, res, next) => {
  try {
    const row = /^\d+$/.test(req.params.id)
      ? await selectVisibleStaffRow.get(Number(req.params.id))
      : null;
    if (!row) {
      throw httpError(404, 'NOT_FOUND', 'Không tìm thấy kỹ thuật viên này.');
    }

    /* A row nobody stands behind is a CV of one: it describes a chair at one salon, and there
       is no person tying it to any other row. Same answer after an account is erased, which
       clears user_id off every row it held (RELEASE_STAFF_ROWS in routes/users.js) — the
       stints stop being one person's history, because there is no longer a person. */
    const stints = row.user_id === null ? [row] : await selectStaffStints.all(row.user_id);

    const data = [];
    for (const stint of stints) {
      data.push(await stintShape(stint));
    }
    res.json({ success: true, data, meta: { total: data.length } });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const row = /^\d+$/.test(req.params.id)
      ? await selectStaffProfile.get(Number(req.params.id))
      : null;
    if (!row) {
      throw httpError(404, 'NOT_FOUND', 'Không tìm thấy kỹ thuật viên này.');
    }

    res.json({
      success: true,
      data: {
        id: row.id,
        name: row.name,
        title: row.title,
        specialty: row.specialty,
        bio: row.bio,
        image: row.image,
        // The cache of this technician's real review average (staff.rating), maintained by
        // every write in routes/reviews.js — not a figure anybody typed. stats.rating_avg
        // below is the same average computed live from the reviews table, so a reader of
        // this reply can see for themselves whether the two still agree.
        rating: row.rating ?? 0,
        years_experience: row.years_experience,
        portfolio: parseJsonArray(row.portfolio),
        salon: { id: row.salon_id, slug: row.salon_slug, name: row.salon_name },
        // What this technician has actually done here, split by who attested to it. The
        // profile used to show a seeded number; this is the work, counted.
        stats: await staffStats(row.id),
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
