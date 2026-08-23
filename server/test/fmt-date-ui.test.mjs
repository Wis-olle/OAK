import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

/* OAK.fmtDate turns two different kinds of thing into the same Vietnamese date line, and
   they have to be read differently. A booking's 'YYYY-MM-DD' is a calendar day and means
   itself. A created_at is an instant, stored in UTC, and the day it fell on is the day on
   the reader's own clock — a post written at 01:00 in Vietnam is stamped 18:00 the day
   before in UTC, so cutting the string at the 'T' dated a third of the blog yesterday.

   The reader's clock is what decides here, so these tests set one. */
process.env.TZ = 'Asia/Ho_Chi_Minh';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const clientJs = fs.readFileSync(path.join(root, 'ui', 'assets', 'js', 'oak-api.js'), 'utf8');

/** The source between two markers, so a test drives the shipped function itself.
    Both markers are declarations rather than prose, so rewording a neighbouring comment
    in oak-api.js cannot quietly change what these tests are running. */
function between(start, end) {
  const from = clientJs.indexOf(start);
  const to = clientJs.indexOf(end);
  assert.ok(from !== -1 && to > from, `oak-api.js no longer contains ${start}`);
  return clientJs.slice(from, to);
}

/* fmtDate lives inside the oak-api.js IIFE, which builds a header on load; it and the
   weekday names it reads are lifted out and run on their own. */
const script =
  between('var WEEKDAYS =', 'function currentUrl(') +
  between('function fmtDate(iso) {', 'function fmtTime(');

const context = { Date, String, Number, isNaN };
vm.runInNewContext(`${script}\nfmtDateFn = fmtDate;`, context);
const fmtDate = context.fmtDateFn;

test('a booking date is the calendar day it says it is', () => {
  assert.equal(fmtDate('2026-08-10'), 'Thứ Hai, 10/08/2026');
  // Single-digit parts are padded, and the weekday comes from the date itself.
  assert.equal(fmtDate('2026-01-04'), 'Chủ Nhật, 04/01/2026');
});

test('a timestamp is dated by the reader clock, not by the UTC string it arrived as', () => {
  // 18:00 UTC on the 9th is 01:00 on the 10th in Vietnam: this is the case the old
  // split-on-'T' got wrong, and it got it wrong for every post written before 07:00.
  assert.equal(fmtDate('2026-08-09T18:00:00.000Z'), 'Thứ Hai, 10/08/2026');
  // An instant that lands on the same day either way is unchanged.
  assert.equal(fmtDate('2026-08-10T04:30:00.000Z'), 'Thứ Hai, 10/08/2026');
});

test('a reader in another timezone gets their own day for the same instant', () => {
  process.env.TZ = 'UTC';
  try {
    assert.equal(fmtDate('2026-08-09T18:00:00.000Z'), 'Chủ Nhật, 09/08/2026');
  } finally {
    process.env.TZ = 'Asia/Ho_Chi_Minh';
  }
});

test('nothing, and nonsense, come back as themselves rather than as a fake date', () => {
  assert.equal(fmtDate(''), '');
  assert.equal(fmtDate(null), '');
  assert.equal(fmtDate(undefined), '');
  assert.equal(fmtDate('sắp có'), 'sắp có');
  assert.equal(fmtDate('không-phải-ngàyT00:00'), 'không-phải-ngàyT00:00');
});
