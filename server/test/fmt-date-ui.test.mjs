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

/* fmtDate lives inside the oak-api.js IIFE, which builds a header on load; it, fmtRange
   and the weekday names they read are lifted out and run on their own. */
const script =
  between('var WEEKDAYS =', 'function currentUrl(') +
  between('function fmtDate(iso, mode) {', 'function fmtTime(');

const context = { Date, String, Number, isNaN };
vm.runInNewContext(`${script}\nfmtDateFn = fmtDate; fmtRangeFn = fmtRange;`, context);
const fmtDate = context.fmtDateFn;
const fmtRange = context.fmtRangeFn;

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

/* The three named shapes. Each one replaced a formula a page had written out by hand, and
   each one is a pattern in the RULES list of oak-i18n.js — the English site can only
   translate a weekday or a month it was told to expect. */

test('the default shape is what every existing caller already reads', () => {
  // Passing no mode and passing an unknown one land on the same line: this is the fallback,
  // so a typo at a call site cannot silently produce a fifth format.
  assert.equal(fmtDate('2026-08-10'), 'Thứ Hai, 10/08/2026');
  assert.equal(fmtDate('2026-08-10', 'full'), 'Thứ Hai, 10/08/2026');
});

test("'long' is the shape the two booking pages used to spell out by hand", () => {
  assert.equal(fmtDate('2026-08-10', 'long'), '10 Tháng 8, 2026');
  // Unpadded, exactly as dateLabel() built it: "12 Tháng 8, 2026" is the catalogued input
  // of the rule that turns it into "August 12, 2026".
  assert.equal(fmtDate('2026-08-12', 'long'), '12 Tháng 8, 2026');
  assert.equal(fmtDate('2026-01-04', 'long'), '4 Tháng 1, 2026');
});

test("'short' is the date alone, padded, as one end of a range", () => {
  assert.equal(fmtDate('2026-08-10', 'short'), '10/08/2026');
  assert.equal(fmtDate('2026-01-04', 'short'), '04/01/2026');
});

test("'weekday' is the day name the confirmation page used to cut out of a longer line", () => {
  assert.equal(fmtDate('2026-08-10', 'weekday'), 'Thứ Hai');
  assert.equal(fmtDate('2026-01-04', 'weekday'), 'Chủ Nhật');
});

test('a mode reads a timestamp by the same clock the default does', () => {
  assert.equal(fmtDate('2026-08-09T18:00:00.000Z', 'long'), '10 Tháng 8, 2026');
  assert.equal(fmtDate('2026-08-09T18:00:00.000Z', 'weekday'), 'Thứ Hai');
});

test('nothing and nonsense keep coming back as themselves in every mode', () => {
  for (const mode of ['long', 'short', 'weekday']) {
    assert.equal(fmtDate('', mode), '');
    assert.equal(fmtDate(null, mode), '');
    assert.equal(fmtDate('sắp có', mode), 'sắp có');
  }
});

test('fmtRange spans two dates with one dash', () => {
  // The week heading of the partner calendar, whose "Tuần …" wrapper is page copy.
  assert.equal(fmtRange('2026-08-10', '2026-08-16'), '10/08/2026 – 16/08/2026');
});
