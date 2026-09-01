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
const MINUTES_PER_HOUR = 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/* The far edge of the window: a day and an hour out.
 *
 * The hour past the day is what keeps that edge from being stepped over between two runs of
 * a ten-minute tick. There is no matching floor on the window as a whole, and there used to
 * be one — an hour short of the 24-hour mark. A floor on the WINDOW only works for a sweep
 * that never misses a beat, and this one misses them: the free tier sleeps, a deploy
 * restarts the process, an instance is away for hours. Anything that fell through such a gap
 * was never reminded about at all, and a reminder eight hours ahead instead of twenty-four
 * is late rather than useless.
 */
const WINDOW_TO_MIN = 25 * 60;
/* The floor is per BOOKING instead, and it is not about lateness — it is about whether the
 * reminder still has a point. What this notice says is "your appointment is at X, and you
 * can cancel free until Y". Once Y has passed there is nothing left to act on, and the
 * sentence becomes an instruction the cancel route would refuse: a booking made at 13:00 for
 * 15:00 was being reminded about five minutes after it was confirmed, quoting a deadline
 * already gone. So a booking is due only while more than the salon's own free-cancellation
 * window still stands between now and its start.
 *
 * Never less than two hours of it, whatever the salon's column says: a salon that has set a
 * cutoff of zero has not thereby asked for a reminder to arrive on top of the appointment.
 */
const MIN_LEAD_MIN = 2 * MINUTES_PER_HOUR;
// Only for a salon that never set one of its own: bookings.js DEFAULT_CANCEL_WINDOW_HOURS is
// the same fallback, and PATCH /api/bookings/:id/cancel enforces the salon's column. The two
// have to agree, or the reminder names a deadline the cancel route refuses.
const DEFAULT_CANCEL_WINDOW_HOURS = 2;

const REMINDER_TITLE = 'Nhắc lịch hẹn sắp tới';

// user_id IS NOT NULL: a walk-in the salon typed in has no account to remind.
const SELECT_DUE = `
  SELECT b.id, b.user_id, b.salon_id, b.staff_id, b.code, b.date, b.time, s.cancel_cutoff_hours,
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

/* Every closure that touches the day or two this sweep can reach. A salon may declare a
   holiday, or a technician a day of leave, AFTER the appointments inside it were made —
   nothing cancels them, and the console asks the owner to ring those customers instead. So
   the reminder must not go out in the meantime: "your appointment is at 10:00 tomorrow,
   cancel free until 08:00" is a promise about an hour the salon has since closed, and it is
   worse than silence because the customer then turns up.
   staff_id NULL is the whole salon; a row naming a technician only reaches her own. */
const SELECT_CLOSURES = `
  SELECT salon_id, staff_id, date_from, date_to FROM time_off
  WHERE date_to >= ? AND date_from <= ?
`;

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

/** How long the reminder has to have left to be worth sending, for this salon's booking. */
function leadRequired(cutoffHours) {
  return Math.max((cutoffHours ?? DEFAULT_CANCEL_WINDOW_HOURS) * MINUTES_PER_HOUR, MIN_LEAD_MIN);
}

/** Minutes from `now` on `today` until a booking's ('YYYY-MM-DD', 'HH:MM') start. */
function minutesUntil(today, now, date, time) {
  // Both dates read as UTC midnight, so the subtraction is a whole number of days whatever
  // the host's zone — the same arithmetic bookings.js minutesUntilStart does.
  const days =
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / MS_PER_DAY;
  return days * MINUTES_PER_DAY + toMinutes(time) - now;
}

/**
 * Write one 'reminder' notification for every appointment starting within a day and an hour
 * of `now` (minutes past midnight on `today`) that is still far enough off to be worth
 * warning about and has not been reminded about yet. Returns how many were written.
 *
 * The ceiling is the query's; the floor is asked per row, because it is the salon's own
 * free-cancellation window and every salon has a different one. The rows in between the two
 * are few, so reading them and dropping some is cheaper than teaching the SQL to do interval
 * arithmetic over a joined column.
 *
 * Runs on the caller's transaction: lib/tick.js opens it and holds the lock that keeps two
 * instances out of the same window.
 */
export async function sweepReminders(tx, today, now) {
  const [fromDate, fromTime] = shift(today, now);
  const [toDate, toTime] = shift(today, now + WINDOW_TO_MIN);

  const inWindow = await tx.all(SELECT_DUE, fromDate, fromDate, fromTime, toDate, toDate, toTime);
  /* Read once for the window rather than asked per booking: at most two days of closures
     across the whole platform, against a handful of rows. */
  const closures = await tx.all(SELECT_CLOSURES, fromDate, toDate);
  const closed = (row) =>
    closures.some(
      (off) =>
        off.salon_id === row.salon_id &&
        (off.staff_id === null || off.staff_id === row.staff_id) &&
        off.date_from <= row.date &&
        row.date <= off.date_to,
    );
  const due = inWindow.filter(
    (row) =>
      minutesUntil(today, now, row.date, row.time) > leadRequired(row.cancel_cutoff_hours) &&
      !closed(row),
  );

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
