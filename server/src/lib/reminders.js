/*
 * The 24-hour appointment reminder.
 *
 * There is no scheduler on this deployment — the free tier sleeps whenever nobody is
 * looking — so the sweep is lazy: GET /api/notifications runs it before it answers, at
 * most once every ten minutes. The reminder is therefore written the first time anyone
 * opens the bell inside the window, which is also the only moment it could be read.
 *
 * Idempotency is the NOT EXISTS below rather than a column on bookings: one notification
 * of type 'reminder' per booking is the whole rule, and the notifications table already
 * knows which booking each row is about.
 *
 * When a Zalo OA account exists, the same function is where the ZNS message goes out.
 */
import { db } from '../db.js';
import { notifyUser } from './notify.js';
import { addDaysISO, fromMinutes, nowMinutes, todayISO, toMinutes } from './time.js';

const MINUTES_PER_DAY = 24 * 60;
// A day ahead, give or take an hour either side: the sweep runs at most every ten minutes,
// so a window this wide cannot be stepped over, and a booking can only fall in it once.
const WINDOW_FROM_MIN = 23 * 60;
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
    AND (b.date > ? OR (b.date = ? AND b.time >= ?))
    AND (b.date < ? OR (b.date = ? AND b.time <= ?))
    AND NOT EXISTS (
      SELECT 1 FROM notifications n WHERE n.booking_id = b.id AND n.type = 'reminder'
    )
`;
const selectDue = db.prepare(SELECT_DUE);
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
 * Write one 'reminder' notification for every appointment starting about a day from now
 * that has not been reminded about yet. Returns how many were written.
 */
export async function runReminderSweep() {
  const today = todayISO();
  const now = nowMinutes();
  const [fromDate, fromTime] = shift(today, now + WINDOW_FROM_MIN);
  const [toDate, toTime] = shift(today, now + WINDOW_TO_MIN);

  const due = await selectDue.all(fromDate, fromDate, fromTime, toDate, toDate, toTime);
  if (due.length === 0) {
    return 0;
  }

  let written = 0;
  await db.withTransaction(async (tx) => {
    for (const row of due) {
      // Asked again inside the transaction: the NOT EXISTS above ran before it opened, so a
      // second sweep that started in between would otherwise write the same reminder twice.
      if (await tx.get(SELECT_REMINDED, row.id)) {
        continue;
      }
      await notifyUser(tx, row.user_id, REMINDER_TITLE, reminderBody(row), 'reminder', row.id);
      written += 1;
    }
  });
  return written;
}
