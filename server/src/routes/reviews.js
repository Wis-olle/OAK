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
const selectReview = db.prepare('SELECT id, user_id FROM reviews WHERE id = ?');
const updateReview = db.prepare(
  'UPDATE reviews SET rating = ?, comment = ? WHERE id = ? AND user_id = ?',
);
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

/** The rating/comment checks POST and PATCH share, so an edit can never widen them. */
function validateReviewBody(rating, comment) {
  if (!Number.isInteger(rating) || rating < MIN_RATING || rating > MAX_RATING) {
    throw httpError(400, 'VALIDATION_ERROR', 'Điểm đánh giá phải là số nguyên từ 1 đến 5.');
  }
  if (comment != null && typeof comment !== 'string') {
    throw httpError(400, 'VALIDATION_ERROR', 'Nội dung đánh giá phải là chuỗi ký tự.');
  }
}

router.post('/', async (req, res, next) => {
  try {
    const { booking_id: bookingIdInput, rating, comment } = req.body ?? {};

    const bookingId = Number.parseInt(bookingIdInput, 10);
    const booking = Number.isInteger(bookingId) ? await selectBooking.get(bookingId) : undefined;
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

    validateReviewBody(rating, comment);

    // Friendly 409 for the common case; the unique index idx_reviews_booking_id is the
    // real guard should two requests race past this check.
    if (await selectReviewOfBooking.get(booking.id)) {
      throw httpError(409, 'ALREADY_REVIEWED', 'Bạn đã đánh giá lịch hẹn này rồi.');
    }

    // salon/service/staff come from the booking, never from the body: otherwise a customer
    // could aim a review at a salon they never visited.
    let id;
    try {
      id = Number(
        (
          await insertReview.run(
            req.user.id,
            booking.salon_id,
            booking.service_id,
            booking.staff_id,
            booking.id,
            rating,
            comment ?? null,
            new Date().toISOString(),
          )
        ).lastInsertRowid,
      );
    } catch (error) {
      // Two requests raced past the pre-check above; the unique index answers for both.
      if (error.code === '23505' && error.constraint === 'idx_reviews_booking_id') {
        throw httpError(409, 'ALREADY_REVIEWED', 'Bạn đã đánh giá lịch hẹn này rồi.');
      }
      throw error;
    }

    res.json({ success: true, data: { id, booking_id: booking.id, rating } });
  } catch (error) {
    next(error);
  }
});

// Only the rating and the comment can change: salon/service/staff/booking come from the
// booking the review was written against and stay as they were.
router.patch('/:id', async (req, res, next) => {
  try {
    const { rating, comment } = req.body ?? {};

    const id = Number.parseInt(req.params.id, 10);
    const review = Number.isInteger(id) ? await selectReview.get(id) : undefined;
    if (!review) {
      throw httpError(404, 'NOT_FOUND', 'Không tìm thấy đánh giá.');
    }
    // 403, not 404: the id is real, the caller simply did not write it.
    if (review.user_id !== req.user.id) {
      throw httpError(403, 'FORBIDDEN', 'Bạn không có quyền sửa đánh giá này.');
    }

    validateReviewBody(rating, comment);

    await updateReview.run(rating, comment ?? null, review.id, req.user.id);

    res.json({ success: true, data: { id: review.id, rating, comment: comment ?? null } });
  } catch (error) {
    next(error);
  }
});

router.get('/mine', async (req, res, next) => {
  try {
    const reviews = (await selectMyReviews.all(req.user.id)).map((row) => ({
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
