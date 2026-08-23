// "Now" must be Vietnam time on a UTC host: this file forces TZ=UTC and mocks the clock,
// so a green run proves the answers come from the timezone, not from the env.
import assert from 'node:assert/strict';
import test from 'node:test';

import { addDaysISO, nowMinutes, todayISO, weekdayOf } from '../src/lib/time.js';

// Pinned here rather than left to the runner: `node --test` gives this file its own
// process, and on a UTC+7 dev machine every assertion below would also pass against a
// todayISO() built from the process clock — the regression this file exists to catch.
process.env.TZ = 'UTC';

/** Pin the wall clock to a UTC instant for the duration of one test. */
function freeze(t, utcISO) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(utcISO).getTime() });
}

test('19:30 UTC is already the next day in Vietnam', (t) => {
  freeze(t, '2026-08-23T19:30:00Z');
  assert.equal(todayISO(), '2026-08-24');
  assert.equal(nowMinutes(), 2 * 60 + 30);
});

test('16:59 UTC is still the same day, one minute before midnight', (t) => {
  freeze(t, '2026-08-23T16:59:00Z');
  assert.equal(todayISO(), '2026-08-23');
  assert.equal(nowMinutes(), 23 * 60 + 59);
});

test('17:00 UTC rolls over to 00:00 of the next Vietnam day', (t) => {
  freeze(t, '2026-08-23T17:00:00Z');
  assert.equal(todayISO(), '2026-08-24');
  assert.equal(nowMinutes(), 0);
});

test('a mid-afternoon UTC instant stays on the same Vietnam day', (t) => {
  freeze(t, '2026-08-23T05:00:00Z');
  assert.equal(todayISO(), '2026-08-23');
  assert.equal(nowMinutes(), 12 * 60);
});

test('the ISO string helpers still read the date they are given', () => {
  assert.equal(addDaysISO('2026-08-31', 1), '2026-09-01');
  assert.equal(weekdayOf('2026-08-23'), 0); // Sunday
});
