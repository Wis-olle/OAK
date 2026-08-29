/*
 * Ending a stint, from whichever side ends it.
 *
 * A departure is one transaction with three parts: the roster row is closed with a date on
 * it, the other side is told, and the appointments the salon has already sold on that
 * technician's calendar are dealt with. The two doors into it — the console's
 * POST /api/partner/staff/:id/departure and the technician's POST /api/staff-me/leave —
 * differ only in who they scope the row by and who hears about it, so everything else lives
 * in here rather than in two spellings that would drift apart on the first change.
 */
import { httpError } from '../middleware/auth.js';
import { pickAvailableStaff } from './availability.js';
import { notifyStaff, notifyUser } from './notify.js';
import { formatDateVN, isISODate, todayISO } from './time.js';

/**
 * The day a stint ended, as either side enters it, refused in one set of words for both.
 *
 * The past is wide open: a salon writing down a departure weeks after the fact is the
 * ordinary case, and refusing it would only teach owners to enter today's date instead,
 * which puts a wrong day on somebody's public record forever.
 *
 * The future is closed, and today is the ceiling. Recording a departure is not scheduling
 * one: active = 0 is written the moment the button is pressed, and nothing in this codebase
 * runs later to do it on the day. A date a month out would therefore take a technician off
 * the roster, out of the picker and off the salon's page for the whole notice period she is
 * still working. A notice period is served by recording the departure on the last day
 * actually worked — which is also the day both sides can finally agree it was. ISO strings
 * compare in the order the days happened, so the ceiling is a plain string comparison.
 */
export function departureDateOrThrow(value) {
  if (!isISODate(value)) {
    throw httpError(400, 'VALIDATION_ERROR', 'Ngày kết thúc phải theo định dạng YYYY-MM-DD.');
  }
  if (value > todayISO()) {
    throw httpError(400, 'VALIDATION_ERROR', 'Ngày kết thúc không được ở tương lai.');
  }
  return value;
}

/*
 * The one statement that ends a stint, with each caller's own ownership clause appended:
 * ' AND salon_id = ?' from the console, ' AND user_id = ?' from the technician's own page.
 *
 * left_at and active = 0 are set together and only ever together — see idx_staff_user_salon
 * in db.js, whose "open stint" predicate is active = 1 and is only true to its name while
 * that pairing holds. The confirmation of the old leaving date goes with the new one,
 * because a technician confirmed a date rather than the idea of a date.
 *
 * tenure_disputed is deliberately NOT cleared. It is one flag over the whole stint and the
 * date most often under dispute is started_at, which nothing here touches: clearing it would
 * let a salon answer "this start date is wrong" by recording a departure, and the ✓ the
 * technician had refused would come back on a date she never agreed to. A dispute outlives
 * the stint it was raised on, and only the owner changing the date settles it.
 *
 * Guarded on active = 1 so a second departure changes no row and the caller finds out rather
 * than silently re-dating a stint that already ended.
 */
export const END_STINT = `
  UPDATE staff
  SET left_at = ?, left_by = ?, active = 0, left_confirmed_at = NULL
  WHERE id = ? AND user_id IS NOT NULL AND active = 1
`;

/*
 * The audit of a booking moved between two technicians, written by everything that moves
 * one: the console's own PATCH (routes/partner.js) and the sweep below. Kept here, in the
 * file both of them can reach, so there is one spelling of the row and one set of columns.
 */
export const INSERT_BOOKING_STAFF_CHANGE = `
  INSERT INTO booking_staff_changes
    (booking_id, old_staff_id, new_staff_id, changed_by, created_at)
  VALUES (?, ?, ?, ?, ?)
`;

/**
 * What a customer is told when their appointment changes hands.
 *
 * One sentence for both ways it happens — the console swapping a chair by hand, and a
 * departure sweeping the calendar — because from where the customer sits they are the same
 * fact, and telling them one thing on Monday and another on Tuesday about the same event is
 * how a notification channel stops being read. routes/partner.js serves it as
 * BOOKING_NOTIFICATIONS.restaffed.
 */
export const restaffedNotice = (salon, booking) => ({
  title: 'Lịch hẹn đổi kỹ thuật viên',
  body: `${salon.name} đã đổi kỹ thuật viên cho lịch hẹn ${booking.code} ngày ${formatDateVN(booking.date)} lúc ${booking.time}.`,
  type: 'booking',
});

/* Everything still to happen on the departing technician's calendar. Pending and confirmed
   only: a completed or cancelled row is a record of a day that is over, and moving one is
   the forgery routes/partner.js refuses on a claimed row. Strictly after the last day
   worked, so an appointment ON the leaving date is one they are still there for. */
const FUTURE_BOOKINGS_SQL = `
  SELECT b.id, b.code, b.date, b.time, b.user_id, b.service_id,
         COALESCE(sv.duration_min, 0) AS duration_min
  FROM bookings b
  LEFT JOIN services sv ON sv.id = b.service_id
  WHERE b.staff_id = ? AND b.status IN ('pending','confirmed') AND b.date > ?
  ORDER BY b.date, b.time, b.id
`;

/* The same two statuses the read above selects on, asked again at the moment of writing: the
   sweep reads its list once and then moves the rows one at a time, and on READ COMMITTED a
   customer cancelling their appointment halfway through that loop is a row the list still
   names and the calendar no longer holds. Re-stating the predicate here is what makes the
   move refuse it instead of quietly re-staffing a cancelled hour. */
const MOVE_BOOKING_STAFF = `
  UPDATE bookings SET staff_id = ? WHERE id = ? AND status IN ('pending','confirmed')
`;

/**
 * Hand on what the departing technician cannot work any more, and count what nobody can.
 *
 * Runs inside the departure's own transaction, AFTER the row has been closed, which is what
 * keeps the departing technician out of her own replacements: pickAvailableStaff reads
 * candidates through st.active = 1. It is the booking wizard's own machinery, so a
 * replacement is somebody who performs that service, is on shift, is not on a day off and is
 * free for the whole duration — the same rules the customer's calendar was sized by.
 *
 * One booking at a time and never in parallel: each reassignment is visible to the next
 * pick, so two appointments an hour apart cannot both be handed to the one colleague who was
 * only free for one of them. The unique slot index moves with the booking, so a reassignment
 * needs nothing else to keep the calendar honest.
 *
 * A booking with nobody free is LEFT ALONE — still on the departed row, still holding that
 * row's slot — and the owner is told how many there are. Cancelling for the customer is not
 * this function's decision to make, and clearing the technician off the booking would drop
 * it out of every list the salon runs its day from. It sits on a closed row until the owner
 * moves it or cancels it, which is what the count is for.
 */
export async function sweepFutureBookings(tx, { staffId, salon, leftAt, actorUserId }) {
  const rows = await tx.all(FUTURE_BOOKINGS_SQL, staffId, leftAt);
  const changedAt = new Date().toISOString();
  let reassigned = 0;
  let needsAttention = 0;

  for (const booking of rows) {
    const replacement = await pickAvailableStaff(
      tx, salon.id, booking.service_id, booking.date, booking.time, booking.duration_min,
    );
    if (replacement === null) {
      needsAttention += 1;
      continue;
    }

    const moved = await tx.run(MOVE_BOOKING_STAFF, replacement, booking.id);
    /* Nothing changed hands, so nobody is told and nothing is audited: the appointment was
       cancelled between the read and this write. Not counted as needing attention either —
       an hour nobody is coming to is not an hour the owner has to find cover for. */
    if (moved.changes !== 1) {
      continue;
    }
    /* Written for every one of these, pending rows included — unlike the console's own PATCH,
       which leaves pending swaps out as corrections to a plan. This is not a correction: a
       whole calendar changed hands because somebody left, and "why is this appointment on my
       name" has to have an answer months later whatever state the booking was in. No review
       travels with it and no rating is recomputed: only a completed booking can carry one,
       and none of these are completed. */
    await tx.run(
      INSERT_BOOKING_STAFF_CHANGE, booking.id, staffId, replacement, actorUserId, changedAt,
    );

    const notice = restaffedNotice(salon, booking);
    await notifyUser(tx, booking.user_id, notice.title, notice.body, notice.type, booking.id);
    // And the colleague who now has the hour. Its own sentence rather than the console's
    // "đã chuyển … sang cho bạn": nobody chose this, a stint ended and the calendar was
    // shared out, and a technician reading it has to know that is what happened.
    await notifyStaff(
      tx,
      replacement,
      'Lịch hẹn mới trên lịch của bạn',
      `${salon.name} đã chuyển lịch hẹn ${booking.code} ngày ${formatDateVN(booking.date)} lúc ${booking.time} sang cho bạn sau khi một đồng nghiệp nghỉ.`,
      booking.id,
    );
    reassigned += 1;
  }

  /* One notice for the whole sweep, not one per booking: an owner who has just lost a
     technician does not need their bell filled with the consequences one at a time. The
     console lists which ones. */
  if (needsAttention > 0) {
    await notifyUser(
      tx,
      salon.owner_id,
      'Lịch hẹn cần bạn xử lý',
      `${needsAttention} lịch hẹn tương lai cần bạn xử lý: không còn kỹ thuật viên nào trống để nhận thay.`,
      'general',
    );
  }

  return { reassigned, needs_attention: needsAttention };
}
