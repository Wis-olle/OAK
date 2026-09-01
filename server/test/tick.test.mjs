/* The clock (src/lib/tick.js). It takes its database as an argument rather than importing
   one, so the whole of it is drivable here: what is pinned is that a second instance holding
   the lock does nothing at all, that a day gone by closes out for a walk-in exactly as it
   does for an account, and that the counts it answers with are the counts it wrote. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runTick } from '../src/lib/tick.js';

const TODAY = '2026-08-23';
const NOW_MIN = 10 * 60;

/**
 * A database of one transaction over `bookings`, with the advisory lock either taken or
 * already held by somebody else. Every statement it was asked is recorded.
 */
function database({ bookings = [], locked = true } = {}) {
  const rows = bookings.map((booking) => ({ ...booking }));
  const notifications = [];
  const statements = [];

  const tx = {
    get: async (sql, ...params) => {
      statements.push(sql);
      if (sql.includes('pg_try_advisory_xact_lock')) {
        return { locked };
      }
      // The reminder sweep's per-booking re-check.
      return notifications.some((row) => row.bookingId === params[0] && row.type === 'reminder')
        ? {}
        : undefined;
    },
    all: async (sql) => {
      statements.push(sql);
      if (sql.includes('b.date < ?')) {
        return rows.filter(
          (row) => row.date < TODAY && (row.status === 'pending' || row.status === 'confirmed'),
        );
      }
      // The reminder window: nothing in these fixtures is ever in it.
      return [];
    },
    run: async (sql, ...params) => {
      statements.push(sql);
      if (sql.startsWith('UPDATE bookings')) {
        const [status, note, id, expected] = params;
        const row = rows.find((one) => one.id === id && one.status === expected);
        if (!row) {
          return { changes: 0 };
        }
        Object.assign(row, { status, note, auto_closed: 1 });
        return { changes: 1 };
      }
      // notify.js's INSERT: (user_id, title, body, type, booking_id, created_at).
      notifications.push({ userId: params[0], type: params[3], bookingId: params[4] });
      return { changes: 1 };
    },
  };

  return {
    rows,
    notifications,
    statements,
    db: { withTransaction: (work) => work(tx) },
  };
}

const YESTERDAY = '2026-08-22';

test('a tick that cannot take the lock does nothing and says so', async () => {
  const store = database({
    locked: false,
    bookings: [{ id: 1, user_id: 4, code: 'OAK-1', date: YESTERDAY, status: 'confirmed', salon_name: 'Lala' }],
  });

  const counts = await runTick(store.db, { today: TODAY, now: NOW_MIN });

  assert.deepEqual(counts, { skipped: true, closed: 0, cancelled: 0, reminded: 0 });
  // The lock was asked for and nothing else was: a second instance mid-deploy must not sweep
  // the same rows the first one is sweeping.
  assert.equal(store.statements.length, 1);
  assert.equal(store.rows[0].status, 'confirmed');
});

test('a day gone by closes out, and the walk-in closes out with it', async () => {
  const store = database({
    bookings: [
      { id: 1, user_id: 4, code: 'OAK-1', note: 'Tone pastel', date: YESTERDAY, status: 'confirmed', salon_name: 'Lala' },
      // The counter typed this one in: there is no account behind it, and nobody who could
      // ever have opened a list to close it out. It is the whole reason this runs on a clock.
      { id: 2, user_id: null, code: 'OAK-2', note: null, date: YESTERDAY, status: 'confirmed', salon_name: 'Lala' },
      { id: 3, user_id: 5, code: 'OAK-3', note: null, date: YESTERDAY, status: 'pending', salon_name: 'Lala' },
      { id: 4, user_id: 4, code: 'OAK-4', note: null, date: '2026-08-30', status: 'confirmed', salon_name: 'Lala' },
    ],
  });

  const counts = await runTick(store.db, { today: TODAY, now: NOW_MIN });

  assert.deepEqual(counts, { skipped: false, closed: 2, cancelled: 1, reminded: 0 });
  assert.deepEqual(
    store.rows.map((row) => row.status),
    ['completed', 'completed', 'cancelled', 'confirmed'],
  );
  // Appended, so the customer's own words survive the sweep that closed their booking.
  assert.equal(store.rows[0].note, 'Tone pastel\nTự động hoàn tất');
  assert.equal(store.rows[2].note, 'Quá giờ chưa xác nhận');

  // One invitation to review, for the one closed booking that has somebody to invite. The
  // walk-in has no account, and a cancelled booking is not a visit to review.
  assert.deepEqual(
    store.notifications.map((row) => [row.userId, row.type, row.bookingId]),
    [[4, 'review', 1]],
  );
});

test('a second tick over the same rows writes nothing more', async () => {
  const store = database({
    bookings: [{ id: 1, user_id: 4, code: 'OAK-1', date: YESTERDAY, status: 'confirmed', salon_name: 'Lala' }],
  });

  await runTick(store.db, { today: TODAY, now: NOW_MIN });
  const second = await runTick(store.db, { today: TODAY, now: NOW_MIN });

  assert.deepEqual(second, { skipped: false, closed: 0, cancelled: 0, reminded: 0 });
  assert.equal(store.notifications.length, 1);
});
