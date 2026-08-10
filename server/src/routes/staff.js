// Public staff profiles: detail, week availability, reviews.
import express from 'express';
import { db } from '../db.js';
import { getStaffSlots, getStaffWeek } from '../lib/availability.js';
import { parseJsonArray, parsePagination } from '../lib/query.js';
import { addDaysISO, isISODate, todayISO } from '../lib/time.js';
import { httpError } from '../middleware/auth.js';

const router = express.Router();

const REVIEW_LIMIT = 10;
const DEFAULT_DAYS = 7;
const MIN_DAYS = 1;
const MAX_DAYS = 14;

const selectStaffProfile = db.prepare(`
  SELECT st.id, st.name, st.title, st.specialty, st.bio, st.image, st.rating,
         st.years_experience, st.portfolio,
         s.id AS salon_id, s.slug AS salon_slug, s.name AS salon_name
  FROM staff st
  JOIN salons s ON s.id = st.salon_id
  WHERE st.id = ? AND st.active = 1
`);

const selectStaffExists = db.prepare('SELECT 1 FROM staff WHERE id = ? AND active = 1');

const selectStaffReviews = db.prepare(`
  SELECT r.id, r.rating, r.comment, r.created_at,
         u.name AS user_name, u.avatar AS user_avatar
  FROM reviews r
  LEFT JOIN users u ON u.id = r.user_id
  WHERE r.staff_id = ?
  ORDER BY r.created_at DESC, r.id DESC
  LIMIT ? OFFSET ?
`);

// Computed over every review of this staff member, not just the page being served.
const selectStaffReviewSummary = db.prepare(
  'SELECT COUNT(*) AS total, ROUND(AVG(rating), 1) AS average FROM reviews WHERE staff_id = ?',
);

/** Resolve a :id path segment to an existing active staff id, or 404. */
function staffIdOrThrow(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || !selectStaffExists.get(id)) {
    throw httpError(404, 'NOT_FOUND', 'Không tìm thấy kỹ thuật viên này.');
  }
  return id;
}

/**
 * Per-day slots for one technician performing one service, in getStaffWeek's shape.
 * Sized by the chosen service's duration — the same calculation POST /api/bookings
 * validates against — so the picker never hides a start time the API would accept.
 */
function getServiceWeek(staffId, serviceId, from, days) {
  const week = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = addDaysISO(from, offset);
    week.push({ date, slots: getStaffSlots(staffId, serviceId, date) });
  }
  return week;
}

router.get('/:id/availability', (req, res, next) => {
  try {
    const staffId = staffIdOrThrow(req.params.id);

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
        ? getStaffWeek(staffId, from, days)
        : getServiceWeek(staffId, serviceId, from, days);

    res.json({ success: true, data: { from, week } });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/reviews', (req, res, next) => {
  try {
    const staffId = staffIdOrThrow(req.params.id);
    const { page, limit, offset } = parsePagination(req.query, REVIEW_LIMIT);
    const summary = selectStaffReviewSummary.get(staffId);
    const rows = selectStaffReviews.all(staffId, limit, offset);

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

router.get('/:id', (req, res, next) => {
  try {
    const row = /^\d+$/.test(req.params.id) ? selectStaffProfile.get(Number(req.params.id)) : null;
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
        rating: row.rating ?? 0,
        years_experience: row.years_experience,
        portfolio: parseJsonArray(row.portfolio),
        salon: { id: row.salon_id, slug: row.salon_slug, name: row.salon_name },
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
