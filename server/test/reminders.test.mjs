/* The lazy 24-hour reminder sweep (src/lib/reminders.js). The module opens a database
   connection the moment it is imported, so its body is lifted and driven against a stand-in
   store instead — the same trick events-route.test.mjs and assistant-parser.test.mjs use.
   What is worth pinning here is exactly what the sweep promises: the window it asks for,
   the sentence it writes, and that asking twice never writes twice. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { addDaysISO, fromMinutes, toMinutes } from '../src/lib/time.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'src', 'lib', 'reminders.js'), 'utf8');

/* A morning that puts the window squarely on tomorrow: 10:30 today reminds about the
   appointments starting between 09:30 and 11:30 tomorrow. */
const TODAY = '2026-08-23';
const NOW_MIN = 10 * 60 + 30;

/**
 * Run the sweep over `bookings`, with a store that behaves the way Postgres does: the
 * SELECT hides whatever already has a reminder, and the write puts one there.
 * Returns what was asked and what was written.
 */
function sweeper(bookings) {
  const written = [];
  const asked = [];
  const reminded = (id) => written.some((row) => row.bookingId === id);

  const from = source.indexOf('const MINUTES_PER_DAY');
  assert.ok(from !== -1, 'reminders.js no longer starts with its constants');
  const body = source.slice(from).replace('export async function', 'async function');

  const context = {
    addDaysISO,
    fromMinutes,
    toMinutes,
    todayISO: () => TODAY,
    nowMinutes: () => NOW_MIN,
    db: {
      prepare: () => ({
        all: async (...params) => {
          asked.push(params);
          /* The SQL's own NOT EXISTS, in JavaScript: a booking already reminded about is
             not returned at all, which is what makes a second sweep find nothing. */
          return bookings.filter((row) => !reminded(row.id));
        },
      }),
      withTransaction: async (work) => work({ get: async (sql, id) => (reminded(id) ? {} : null) }),
    },
    notifyUser: async (tx, userId, title, bodyText, type, bookingId) => {
      written.push({ userId, title, body: bodyText, type, bookingId });
    },
  };
  vm.runInNewContext(`${body}\nglobalThis.sweep = runReminderSweep;`, context);
  return { run: context.sweep, written, asked };
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

test('the sweep asks for the appointments starting about a day from now', async () => {
  const { run, asked } = sweeper([]);
  await run();

  /* date >= 24/08 09:30 and date <= 24/08 11:30, each bound spelled as (date, date, time). */
  assert.deepEqual(asked, [['2026-08-24', '2026-08-24', '09:30', '2026-08-24', '2026-08-24', '11:30']]);
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

test('nothing due is not a transaction', async () => {
  const { run, written } = sweeper([]);

  assert.equal(await run(), 0);
  assert.equal(written.length, 0);
});
