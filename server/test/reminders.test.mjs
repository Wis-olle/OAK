/* The 24-hour reminder sweep (src/lib/reminders.js). It runs on a transaction the tick hands
   it and imports no database of its own, so it is driven here directly, against a stand-in
   transaction that behaves the way Postgres does. What is worth pinning is exactly what the
   sweep promises: the window it asks for, the sentence it writes, and that asking twice never
   writes twice. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { sweepReminders } from '../src/lib/reminders.js';

/* A morning that puts the window on the day ahead: 10:30 today reminds about everything
   starting between now and 11:30 tomorrow. */
const TODAY = '2026-08-23';
const NOW_MIN = 10 * 60 + 30;

/**
 * A transaction over `bookings`: the SELECT hides whatever already has a reminder, and the
 * INSERT notify.js writes puts one there. Returns what was asked and what was written.
 */
function sweeper(bookings) {
  const written = [];
  const asked = [];
  const reminded = (id) => written.some((row) => row.bookingId === id);

  const tx = {
    all: async (sql, ...params) => {
      asked.push(params);
      /* The SQL's own NOT EXISTS, in JavaScript: a booking already reminded about is not
         returned at all, which is what makes a second sweep find nothing. */
      return bookings.filter((row) => !reminded(row.id));
    },
    get: async (sql, id) => (reminded(id) ? {} : undefined),
    /* notify.js is the real one, so what lands here is the row it would insert:
       (user_id, title, body, type, booking_id, created_at). */
    run: async (sql, userId, title, body, type, bookingId) => {
      written.push({ userId, title, body, type, bookingId });
      return { changes: 1 };
    },
  };

  return { run: () => sweepReminders(tx, TODAY, NOW_MIN), written, asked };
}

const BOOKING = {
  id: 7,
  user_id: 3,
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
  const { run, written } = sweeper([{ ...BOOKING, cancel_cutoff_hours: 24 }]);
  await run();

  assert.match(written[0].body, /Hủy miễn phí trước 10:00 23\/08\./);
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
