/* The 24-hour reminder sweep (src/lib/reminders.js). It runs on a transaction the tick hands
   it and imports no database of its own, so it is driven here directly, against a stand-in
   transaction that behaves the way Postgres does. What is worth pinning is exactly what the
   sweep promises: the window it asks for, the sentence it writes, and that asking twice never
   writes twice. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { addDaysISO, fromMinutes } from '../src/lib/time.js';
import { sweepReminders } from '../src/lib/reminders.js';

/* A morning that puts the window on the day ahead: 10:30 today reminds about everything
   starting between now and 11:30 tomorrow. */
const TODAY = '2026-08-23';
const NOW_MIN = 10 * 60 + 30;

/**
 * A transaction over `bookings`: the SELECT hides whatever already has a reminder, and the
 * INSERT notify.js writes puts one there. Returns what was asked and what was written.
 */
function sweeper(bookings, closures = []) {
  const written = [];
  const asked = [];
  const closuresAsked = [];
  const reminded = (id) => written.some((row) => row.bookingId === id);

  const tx = {
    all: async (sql, ...params) => {
      /* The second statement the sweep runs: the closures overlapping its window, at the
         salons the window's bookings are at. Filtered the way the SQL filters, so a row
         outside the window — or at a salon the sweep never asked about — is invisible here
         too. */
      if (sql.includes('time_off')) {
        closuresAsked.push(params);
        const [salonIds, from, to] = params;
        return closures.filter(
          (off) => salonIds.includes(off.salon_id) && off.date_to >= from && off.date_from <= to,
        );
      }
      asked.push(params);
      const [fromDate, , fromTime, toDate, , toTime] = params;
      /* The statement's own clauses, in JavaScript: the window it asked for, and its
         NOT EXISTS — a booking already reminded about is not returned at all, which is what
         makes a second sweep find nothing. The per-booking floor INSIDE that window is the
         sweep's own, and is deliberately not applied here so the cases below can see it. */
      return bookings.filter(
        (row) =>
          !reminded(row.id) &&
          (row.date > fromDate || (row.date === fromDate && row.time > fromTime)) &&
          (row.date < toDate || (row.date === toDate && row.time <= toTime)),
      );
    },
    get: async (sql, id) => (reminded(id) ? {} : undefined),
    /* notify.js is the real one, so what lands here is the row it would insert:
       (user_id, title, body, type, booking_id, created_at). */
    run: async (sql, userId, title, body, type, bookingId) => {
      written.push({ userId, title, body, type, bookingId });
      return { changes: 1 };
    },
  };

  return { run: () => sweepReminders(tx, TODAY, NOW_MIN), written, asked, closuresAsked };
}

const BOOKING = {
  id: 7,
  user_id: 3,
  // Which salon and whose calendar, so a declared day off can be matched against it.
  salon_id: 1,
  staff_id: 5,
  code: 'OAK-4K7P2M',
  date: '2026-08-24',
  time: '10:00',
  service_name: 'Sơn gel cơ bản',
  salon_name: 'Lala Nail Studio',
  staff_name: 'Minh Anh',
};

/* The lower bound is now, not an hour short of a day from now. A sweep that skipped what was
   already inside the day left it unreminded for ever, because the next sweep finds it later
   still — and this deployment sleeps, restarts and misses beats. */
test('the sweep asks for everything from this moment to a day and an hour out', async () => {
  const { run, asked } = sweeper([]);
  await run();

  /* Later than 23/08 10:30 and no later than 24/08 11:30, each bound spelled (date, date, time). */
  assert.deepEqual(asked, [['2026-08-23', '2026-08-23', '10:30', '2026-08-24', '2026-08-24', '11:30']]);
});

test('the reminder names the service, the hour, the salon, the technician and the code', async () => {
  const { run, written } = sweeper([BOOKING]);
  assert.equal(await run(), 1);

  assert.equal(written.length, 1);
  assert.equal(written[0].userId, 3);
  assert.equal(written[0].type, 'reminder');
  assert.equal(written[0].bookingId, 7);
  assert.equal(
    written[0].body,
    'Bạn có lịch Sơn gel cơ bản lúc 10:00 24/08 tại Lala Nail Studio (KTV Minh Anh) — mã OAK-4K7P2M. Hủy miễn phí trước 08:00 24/08.',
  );
});

test('a booking nobody was assigned to says nothing about a technician', async () => {
  const { run, written } = sweeper([{ ...BOOKING, staff_name: null }]);
  await run();

  assert.ok(!written[0].body.includes('KTV'));
  assert.match(written[0].body, /tại Lala Nail Studio — mã OAK-4K7P2M/);
});

test('an early appointment puts the free-cancellation deadline on the evening before', async () => {
  const { run, written } = sweeper([{ ...BOOKING, date: '2026-08-24', time: '01:00' }]);
  await run();

  assert.match(written[0].body, /Hủy miễn phí trước 23:00 23\/08\./);
});

/* salons.cancel_cutoff_hours, which PATCH /api/bookings/:id/cancel is the one that enforces
   (bookings.js cancelWindowHours). A salon asking for a day's notice must not be told about
   two hours' — the reminder would name a deadline the cancel route answers 409 to. */
test('the deadline comes from the salon, not from a platform constant', async () => {
  const { run, written } = sweeper([{ ...BOOKING, time: '11:00', cancel_cutoff_hours: 24 }]);
  await run();

  assert.match(written[0].body, /Hủy miễn phí trước 11:00 23\/08\./);
});

test('a salon that never set a window of its own keeps the two-hour default', async () => {
  const { run, written } = sweeper([{ ...BOOKING, cancel_cutoff_hours: null }]);
  await run();

  assert.match(written[0].body, /Hủy miễn phí trước 08:00 24\/08\./);
});

test('sweeping again writes nothing more — one reminder per booking, ever', async () => {
  const { run, written } = sweeper([BOOKING]);

  assert.equal(await run(), 1);
  assert.equal(await run(), 0);
  assert.equal(await run(), 0);
  assert.equal(await run(), 0);
  assert.equal(written.length, 1);
});

test('nothing due writes nothing', async () => {
  const { run, written } = sweeper([]);

  assert.equal(await run(), 0);
  assert.equal(written.length, 0);
});

/* The floor, per booking. What the reminder says is "your appointment is at X, and you can
   cancel free until Y", so once Y has gone by it is an instruction the cancel route would
   refuse — a booking made at 13:00 for 15:00 was being reminded about minutes after it was
   confirmed, quoting a deadline already passed. The bound is the salon's own cancellation
   window, never under two hours, and the ceiling above it is still a day and an hour. */
function startingIn(minutes, extra = {}) {
  const total = NOW_MIN + minutes;
  const days = Math.floor(total / (24 * 60));
  return {
    ...BOOKING,
    ...extra,
    date: addDaysISO(TODAY, days),
    time: fromMinutes(total - days * 24 * 60),
  };
}

test('an appointment closer than the salon’s cancellation window is past reminding', async () => {
  const { run, written } = sweeper([startingIn(120 - 1)]);

  assert.equal(await run(), 0);
  assert.equal(written.length, 0);
});

test('a minute the other side of that window is worth a reminder', async () => {
  const { run, written } = sweeper([startingIn(120 + 1)]);

  assert.equal(await run(), 1);
  assert.equal(written[0].bookingId, BOOKING.id);
});

test('the ordinary case — a day ahead — is squarely inside both bounds', async () => {
  const { run } = sweeper([startingIn(24 * 60)]);

  assert.equal(await run(), 1);
});

test('a minute past the ceiling is nobody’s business yet', async () => {
  const { run, written } = sweeper([startingIn(25 * 60 + 1)]);

  assert.equal(await run(), 0);
  assert.equal(written.length, 0);
});

/* The floor is the salon's column, not a constant: a salon asking for a day's notice is
   asking for the reminder to arrive before that day starts. And a salon that has set no
   window at all — or a zero — has not thereby asked to be reminded on top of the hour. */
test('a salon with a day’s notice is not reminded twenty hours out', async () => {
  const { run } = sweeper([startingIn(20 * 60, { cancel_cutoff_hours: 24 })]);

  assert.equal(await run(), 0);
});

test('a salon that takes cancellations up to the hour still gets the two-hour floor', async () => {
  const closeNotice = sweeper([startingIn(60, { cancel_cutoff_hours: 0 })]);
  assert.equal(await closeNotice.run(), 0);

  const roomToAct = sweeper([startingIn(3 * 60, { cancel_cutoff_hours: 0 })]);
  assert.equal(await roomToAct.run(), 1);
});

/* ------------------------------------------------------- days the salon is shut ---- */

/* A holiday or a leave declared AFTER the appointments inside it were made cancels nothing:
   the console asks the owner to ring those customers instead. Until then the reminder must
   stay in: "your appointment is at 10:00 tomorrow, cancel free until 08:00" is a promise
   about an hour that no longer exists, and it is worse than silence — the customer acts on
   it and turns up at a closed door. */
const CLOSURE = { salon_id: 1, staff_id: null, date_from: '2026-08-24', date_to: '2026-08-24' };

test('a booking inside a salon closure is not reminded about', async () => {
  const { run, written } = sweeper([BOOKING], [CLOSURE]);

  assert.equal(await run(), 0);
  assert.equal(written.length, 0);
});

test('a technician’s own day off silences her bookings and nobody else’s', async () => {
  const hers = { ...CLOSURE, staff_id: 5 };
  assert.equal(await sweeper([BOOKING], [hers]).run(), 0);
  assert.equal(await sweeper([{ ...BOOKING, staff_id: 9 }], [hers]).run(), 1);
});

test('a closure at another salon, or on another day, changes nothing here', async () => {
  assert.equal(await sweeper([BOOKING], [{ ...CLOSURE, salon_id: 2 }]).run(), 1);
  assert.equal(
    await sweeper([BOOKING], [{ ...CLOSURE, date_from: '2026-08-25', date_to: '2026-08-25' }]).run(),
    1,
  );
});

/* time_off is never pruned, so the read has to lead with the salons the sweep is actually
   about — the index does, and the table grows for ever. A window with nothing in it asks
   nothing. */
test('the closure read names only the salons the window’s bookings are at', async () => {
  const one = sweeper([BOOKING], [CLOSURE]);
  await one.run();
  assert.deepEqual(one.closuresAsked, [[[1], '2026-08-23', '2026-08-24']]);

  const none = sweeper([], [CLOSURE]);
  await none.run();
  assert.deepEqual(none.closuresAsked, []);
});

test('a closure spanning the day covers it, edges included', async () => {
  const week = { ...CLOSURE, date_from: '2026-08-24', date_to: '2026-08-30' };
  assert.equal(await sweeper([BOOKING], [week]).run(), 0);
});
