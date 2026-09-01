/*
 * The clock this platform keeps for itself.
 *
 * Two jobs used to be done lazily, on whichever request happened to arrive: the customer's
 * own booking list closed out the days that had gone by, and the notification bell swept for
 * appointments a day away. Both were wrong for the same reason — they waited for a reader.
 * Nobody opens the bell inside any given two-hour window at today's traffic, so the 24-hour
 * reminder was simply missed; and a walk-in the salon typed in has no account to open a list
 * at all, so it stayed 'confirmed' for ever and the salon's own figures undercounted it.
 * Doing the work on a GET was also a side effect on a read: two tabs raced each other, and a
 * request that only wanted to look paid for a sweep of everybody's rows.
 *
 * So it runs on a clock instead — src/index.js on an interval, and GET|POST
 * /api/internal/tick for an external cron — and it runs for EVERYONE, not for the caller.
 *
 * `db` is a parameter rather than an import: db.js opens a pool the moment it is loaded, and
 * a scheduler worth testing has to be reachable without one.
 *
 * Everything happens inside one transaction, and the first thing that transaction does is
 * take pg_try_advisory_xact_lock. Render can run two instances during a deploy, and both
 * would otherwise sweep the same window at the same moment; the loser simply returns having
 * done nothing, because the winner is already doing it. The lock is held for the transaction
 * and released by COMMIT or ROLLBACK, so there is nothing to clean up after a crash.
 */
import { notifyUser } from './notify.js';
import { sweepReminders } from './reminders.js';
import { nowMinutes, todayISO } from './time.js';

// hashtext turns the name into the int4 the lock function takes. One name, one lock: every
// instance of this app contends for it, and nothing else in the database uses it.
const TRY_LOCK = "SELECT pg_try_advisory_xact_lock(hashtext('oak:tick')) AS locked";

// What the sweep appends to the note so the salon can read why the booking closed. The card
// does not read these back: bookings.auto_closed carries that fact instead, because `note`
// also holds the customer's own words and a customer may write anything into it.
const AUTO_COMPLETED_NOTE = 'Tự động hoàn tất';
const AUTO_CANCELLED_NOTE = 'Quá giờ chưa xác nhận';

// Every appointment whose day is over and which the salon never touched — every account's
// and every counter's alike. There is no user_id here on purpose: a walk-in is the case that
// has nobody to come and look for it.
const SELECT_STALE_BOOKINGS = `
  SELECT b.id, b.user_id, b.code, b.note, b.status, s.name AS salon_name
  FROM bookings b
  JOIN salons s ON s.id = b.salon_id
  WHERE b.date < ? AND b.status IN ('pending', 'confirmed')
`;
// Guarded on the status the row was read with. Redundant while the advisory lock holds, and
// kept anyway: it is the guard that still means something if a booking is ever closed out
// from somewhere other than this transaction.
const CLOSE_STALE_BOOKING =
  'UPDATE bookings SET status = ?, note = ?, auto_closed = 1 WHERE id = ? AND status = ?';

const REVIEW_INVITE_TITLE = 'Buổi hẹn đã hoàn tất';

/**
 * Close out every appointment whose day is over: a confirmed one happened, a pending one
 * was never taken up. Returns how many went each way.
 *
 * An auto-completed booking is what opens the review loop, so each one gets the same
 * invitation partner.js sends when the salon closes it by hand — and notifyUser is a no-op
 * for the walk-in that has no account behind it, which is exactly the right answer.
 */
async function closeStaleBookings(tx, today) {
  const stale = await tx.all(SELECT_STALE_BOOKINGS, today);
  let closed = 0;
  let cancelled = 0;

  for (const booking of stale) {
    const completed = booking.status === 'confirmed';
    // Appended, not replaced: the customer's own request stays readable for the salon.
    const note = [booking.note, completed ? AUTO_COMPLETED_NOTE : AUTO_CANCELLED_NOTE]
      .filter(Boolean)
      .join('\n');
    const { changes } = await tx.run(
      CLOSE_STALE_BOOKING,
      completed ? 'completed' : 'cancelled',
      note,
      booking.id,
      booking.status,
    );
    if (changes === 0) {
      continue;
    }
    if (completed) {
      closed += 1;
      await notifyUser(
        tx,
        booking.user_id,
        REVIEW_INVITE_TITLE,
        `Cảm ơn bạn đã sử dụng dịch vụ tại ${booking.salon_name}. Hãy dành một phút đánh giá lịch hẹn ${booking.code} nhé!`,
        'review',
        booking.id,
      );
    } else {
      cancelled += 1;
    }
  }

  return { closed, cancelled };
}

/**
 * One pass of the clock: close out yesterday, then remind about tomorrow.
 *
 * `today` and `now` are overridable so a caller — a test, mostly — can put the clock
 * somewhere of its own choosing; both default to Vietnam time, like everything else here.
 *
 * Answers {skipped, closed, cancelled, reminded}. `skipped` means another instance held the
 * lock: nothing was done and nothing was wrong.
 */
export async function runTick(db, { today = todayISO(), now = nowMinutes() } = {}) {
  const counts = await db.withTransaction(async (tx) => {
    const { locked } = await tx.get(TRY_LOCK);
    if (!locked) {
      return { skipped: true, closed: 0, cancelled: 0, reminded: 0 };
    }

    const { closed, cancelled } = await closeStaleBookings(tx, today);
    const reminded = await sweepReminders(tx, today, now);
    return { skipped: false, closed, cancelled, reminded };
  });

  // Logged after the COMMIT, so the line is a record of what was written rather than of what
  // was attempted — and only when there was something, or the log becomes a heartbeat nobody
  // reads and the one interesting line hides in it.
  if (counts.closed || counts.cancelled || counts.reminded) {
    console.log(
      `[${new Date().toISOString()}] tick: ${counts.closed} completed, ` +
        `${counts.cancelled} cancelled, ${counts.reminded} reminded`,
    );
  }
  return counts;
}
