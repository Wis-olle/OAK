/*
 * The 24-hour appointment reminder.
 *
 * Written by the tick (lib/tick.js), on the transaction and under the advisory lock the tick
 * holds. It used to be lazy — GET /api/notifications ran it before answering — which meant
 * the reminder was only ever written when somebody opened the bell, and at today's traffic
 * nobody opens the bell inside any given window, so it was simply missed.
 *
 * Idempotency is the NOT EXISTS below rather than a column on bookings: one notification
 * of type 'reminder' per booking is the whole rule, and the notifications table already
 * knows which booking each row is about.
 *
 * When a Zalo OA account exists, the same function is where the ZNS message goes out.
 */
import { notifyUser } from './notify.js';
import { addDaysISO, fromMinutes, toMinutes } from './time.js';

const MINUTES_PER_DAY = 24 * 60;
/* Everything starting between this moment and a day and an hour from now.
 *
 * There is no lower bound, and there used to be one — an hour either side of the 24-hour
 * mark. A window with a floor only works for a sweep that never misses a beat, and this one
 * can: the free tier sleeps, a deploy restarts the process, an instance is asleep for hours.
 * Anything that fell through such a gap was never reminded about at all. A reminder that
 * arrives eight hours before the appointment instead of twenty-four is late; it is not
 * useless, and it is worth far more than none. The hour past the day is what keeps the
 * upper edge from being stepped over between two runs of a ten-minute tick.
 */
const WINDOW_TO_MIN = 25 * 60;
// Only for a salon that never set one of its own: bookings.js DEFAULT_CANCEL_WINDOW_HOURS is
// the same fallback, and PATCH /api/bookings/:id/cancel enforces the salon's column. The two
// have to agree, or the reminder names a deadline the cancel route refuses.
const DEFAULT_CANCEL_WINDOW_HOURS = 2;

const REMINDER_TITLE = 'Nhắc lịch hẹn sắp tới';

// user_id IS NOT NULL: a walk-in the salon typed in has no account to remind.
const SELECT_DUE = `
  SELECT b.id, b.user_id, b.code, b.date, b.time, s.cancel_cutoff_hours,
         sv.name AS service_name, s.name AS salon_name, st.name AS staff_name
  FROM bookings b
  JOIN services sv ON sv.id = b.service_id
  JOIN salons s ON s.id = b.salon_id
  LEFT JOIN staff st ON st.id = b.staff_id
  WHERE b.user_id IS NOT NULL
    AND b.status IN ('pending', 'confirmed')
    AND (b.date > ? OR (b.date = ? AND b.time > ?))
    AND (b.date < ? OR (b.date = ? AND b.time <= ?))
    AND NOT EXISTS (
      SELECT 1 FROM notifications n WHERE n.booking_id = b.id AND n.type = 'reminder'
    )
`;
const SELECT_REMINDED = `SELECT 1 FROM notifications WHERE booking_id = ? AND type = 'reminder'`;

/** `minutes` past midnight on `date`, as the ('YYYY-MM-DD', 'HH:MM') pair the schema stores. */
function shift(date, minutes) {
  // Floored, not the remainder operator: a cut-off of a day or more puts the deadline
  // before midnight of `date`, where JS % would answer with a negative time of day.
  const days = Math.floor(minutes / MINUTES_PER_DAY);
  return [addDaysISO(date, days), fromMinutes(minutes - days * MINUTES_PER_DAY)];
}

/** '2026-08-24' -> '24/08'. The year is never in doubt a day ahead. */
function dayMonth(iso) {
  const [, month, day] = iso.split('-');
  return `${day}/${month}`;
}

/** When free cancellation closes, in the same 'HH:MM dd/mm' shape as the appointment. */
function deadlineOf(date, time, cutoffHours) {
  const cutoffMin = (cutoffHours ?? DEFAULT_CANCEL_WINDOW_HOURS) * 60;
  const [day, at] = shift(date, toMinutes(time) - cutoffMin);
  return `${at} ${dayMonth(day)}`;
}

function reminderBody(row) {
  const staff = row.staff_name ? ` (KTV ${row.staff_name})` : '';
  return (
    `Bạn có lịch ${row.service_name} lúc ${row.time} ${dayMonth(row.date)} ` +
    `tại ${row.salon_name}${staff} — mã ${row.code}. ` +
    `Hủy miễn phí trước ${deadlineOf(row.date, row.time, row.cancel_cutoff_hours)}.`
  );
}

/**
 * Write one 'reminder' notification for every appointment starting between `now` (minutes
 * past midnight on `today`) and a day and an hour later that has not been reminded about
 * yet. Returns how many were written.
 *
 * Runs on the caller's transaction: lib/tick.js opens it and holds the lock that keeps two
 * instances out of the same window.
 */
export async function sweepReminders(tx, today, now) {
  const [fromDate, fromTime] = shift(today, now);
  const [toDate, toTime] = shift(today, now + WINDOW_TO_MIN);

  const due = await tx.all(SELECT_DUE, fromDate, fromDate, fromTime, toDate, toDate, toTime);

  let written = 0;
  for (const row of due) {
    // Asked a second time, per booking. The advisory lock already makes this impossible to
    // need; it stays because "one reminder per booking, ever" is the promise, and a promise
    // that rests on a lock held somewhere else is one refactor from being broken quietly.
    if (await tx.get(SELECT_REMINDED, row.id)) {
      continue;
    }
    await notifyUser(tx, row.user_id, REMINDER_TITLE, reminderBody(row), 'reminder', row.id);
    written += 1;
  }
  return written;
}
