// Customer reviews: create from a completed booking, list own.
import express from 'express';
import { db } from '../db.js';
import { httpError, requireAuth } from '../middleware/auth.js';

const router = express.Router();

const MIN_RATING = 1;
const MAX_RATING = 5;

// Reviews are always written and read as the signed-in customer.
router.use(requireAuth);

const selectBooking = db.prepare(
  'SELECT id, user_id, salon_id, service_id, staff_id, status FROM bookings WHERE id = ?',
);
const selectReviewOfBooking = db.prepare('SELECT id FROM reviews WHERE booking_id = ?');
const insertReview = db.prepare(`
  INSERT INTO reviews (user_id, salon_id, service_id, staff_id, booking_id, rating, comment, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const selectMyReviews = db.prepare(`
  SELECT r.id, r.booking_id, r.rating, r.comment, r.created_at,
         s.id AS salon_id, s.slug AS salon_slug, s.name AS salon_name,
         sv.id AS service_id, sv.name AS service_name
  FROM reviews r
  JOIN salons s ON s.id = r.salon_id
  LEFT JOIN services sv ON sv.id = r.service_id
  WHERE r.user_id = ?
  ORDER BY r.created_at DESC, r.id DESC
`);

router.post('/', (req, res, next) => {
  try {
    const { booking_id: bookingIdInput, rating, comment } = req.body ?? {};

    const bookingId = Number.parseInt(bookingIdInput, 10);
    const booking = Number.isInteger(bookingId) ? selectBooking.get(bookingId) : undefined;
    if (!booking) {
      throw httpError(404, 'NOT_FOUND', 'Không tìm thấy lịch hẹn.');
    }
    if (booking.user_id !== req.user.id) {
      throw httpError(403, 'FORBIDDEN', 'Bạn không có quyền đánh giá lịch hẹn này.');
    }
    if (booking.status !== 'completed') {
      throw httpError(
        400,
        'BOOKING_NOT_COMPLETED',
        'Chỉ có thể đánh giá sau khi lịch hẹn đã hoàn tất.',
      );
    }

    if (!Number.isInteger(rating) || rating < MIN_RATING || rating > MAX_RATING) {
      throw httpError(400, 'VALIDATION_ERROR', 'Điểm đánh giá phải là số nguyên từ 1 đến 5.');
    }
    if (comment != null && typeof comment !== 'string') {
      throw httpError(400, 'VALIDATION_ERROR', 'Nội dung đánh giá phải là chuỗi ký tự.');
    }

    // Safe as a check-then-act: node:sqlite is synchronous and there is no await between
    // the lookup and the insert, so no second request can slip in between them.
    if (selectReviewOfBooking.get(booking.id)) {
      throw httpError(409, 'ALREADY_REVIEWED', 'Bạn đã đánh giá lịch hẹn này rồi.');
    }

    // salon/service/staff come from the booking, never from the body: otherwise a customer
    // could aim a review at a salon they never visited.
    const id = Number(
      insertReview.run(
        req.user.id,
        booking.salon_id,
        booking.service_id,
        booking.staff_id,
        booking.id,
        rating,
        comment ?? null,
        new Date().toISOString(),
      ).lastInsertRowid,
    );

    res.json({ success: true, data: { id, booking_id: booking.id, rating } });
  } catch (error) {
    next(error);
  }
});

router.get('/mine', (req, res, next) => {
  try {
    const reviews = selectMyReviews.all(req.user.id).map((row) => ({
      id: row.id,
      booking_id: row.booking_id,
      rating: row.rating,
      comment: row.comment,
      created_at: row.created_at,
      salon: { id: row.salon_id, slug: row.salon_slug, name: row.salon_name },
      service: row.service_id ? { id: row.service_id, name: row.service_name } : null,
    }));

    res.json({ success: true, data: reviews });
  } catch (error) {
    next(error);
  }
});

export default router;
