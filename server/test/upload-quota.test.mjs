/* The two halves of the upload ceilings that can be read without a database or a browser:
   the boundary the site-wide daily breaker counts from, and the fact that every screen
   which uploads now has one function to shrink a picture with. */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { startOfDayUTC } from '../src/lib/time.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const clientJs = fs.readFileSync(path.join(root, 'ui', 'assets', 'js', 'oak-api.js'), 'utf8');
const quotaJs = fs.readFileSync(path.join(root, 'server', 'src', 'lib', 'upload-quota.js'), 'utf8');

/* The lib itself imports db.js, which opens a pool and applies the schema on load, so it
   cannot be imported into a file that is meant to run with no database in the room. The two
   lines that read the environment are lifted out and run on their own instead — code rather
   than a copy of it, so rewriting them in the lib is a test that fails here rather than a
   ceiling that quietly stops meaning what this file says it means. */
function dailyCapFor(value) {
  const from = quotaJs.indexOf('const parsedDailyCap');
  const to = quotaJs.indexOf('const HOUR_MS');
  assert.ok(from !== -1 && to > from, 'upload-quota.js no longer parses UPLOADS_DAILY_CAP here');
  const context = {
    process: { env: value === undefined ? {} : { UPLOADS_DAILY_CAP: value } },
    Number,
    answer: null,
  };
  vm.runInNewContext(`${quotaJs.slice(from, to)}
answer = UPLOADS_DAILY_CAP;`, context);
  return context.answer;
}

test('an unset UPLOADS_DAILY_CAP is the default five hundred', () => {
  assert.equal(dailyCapFor(undefined), 500);
});

test('an operator who sets UPLOADS_DAILY_CAP gets the number they set', () => {
  assert.equal(dailyCapFor('2000'), 2000);
});

/* The one value `Number(x) || 500` got wrong, and the only one an operator would type on
   purpose: zero closes the doors while the bucket is being cleared out by hand. Read as
   "absent" it would have done the opposite of what was asked and raised the ceiling. */
test('UPLOADS_DAILY_CAP=0 closes uploads rather than falling back to the default', () => {
  assert.equal(dailyCapFor('0'), 0);
});

test('a cap that is not a number at all falls back to the default', () => {
  assert.equal(dailyCapFor('nhieu'), 500);
  assert.equal(dailyCapFor(''), 500);
});

/* uploads.created_at is a UTC ISO string and the cap is a Vietnamese calendar day, so the
   two are seven hours apart and the boundary has to be converted rather than matched as a
   prefix. Counting rows whose text began with the Vietnamese date would have missed every
   picture uploaded between midnight and 07:00 — seven hours a day in which the breaker
   counted nothing at all. */
test('a Vietnamese day starts at 17:00 UTC the day before', () => {
  assert.equal(startOfDayUTC('2026-09-02'), '2026-09-01T17:00:00.000Z');
});

test('the first minute of the Vietnamese day is inside the window it opens', () => {
  const dayStart = startOfDayUTC('2026-09-02');
  // 00:01 in Vietnam on the 2nd, written the way the rows are written.
  assert.ok('2026-09-01T17:01:00.000Z' > dayStart);
  // And the last minute of the 1st is not.
  assert.ok('2026-09-01T16:59:00.000Z' < dayStart);
});

/* Every upload screen posts what this returns and falls back to the raw file only when it
   answers null, so a page that could not find it on OAK would silently go back to sending
   phone-camera originals at the server's 1MB ceiling. */
test('oak-api.js hands OAK.compressImage to the pages', () => {
  assert.ok(
    /function compressImage\(file, options\)/.test(clientJs),
    'oak-api.js no longer defines compressImage(file, options)',
  );
  assert.ok(
    /compressImage: compressImage,/.test(clientJs),
    'compressImage is defined but not exported on window.OAK',
  );
});
