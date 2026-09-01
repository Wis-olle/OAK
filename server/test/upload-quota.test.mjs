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
/* The reconcile sweep's pure half. It is importable precisely because it is pure: the
   module opens no database and loads no driver until its main() runs, and main() runs
   only when the file was started from the command line. */
import { IMAGE_COLUMNS, objectNameOf, referencedNames } from '../../tools/uploads-reconcile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const clientJs = fs.readFileSync(path.join(root, 'ui', 'assets', 'js', 'oak-api.js'), 'utf8');
const quotaJs = fs.readFileSync(path.join(root, 'server', 'src', 'lib', 'upload-quota.js'), 'utf8');

/* The lib itself imports db.js, which opens a pool and applies the schema on load, so it
   cannot be imported into a file that is meant to run with no database in the room. The two
   lines that read the environment are lifted out and run on their own instead — code rather
   than a copy of it, so rewriting them in the lib is a test that fails here rather than a
   ceiling that quietly stops meaning what this file says it means. */
function ceilingsFor(value) {
  const from = quotaJs.indexOf('const MAX_UPLOAD_BYTES');
  const to = quotaJs.indexOf('const HOUR_MS');
  assert.ok(from !== -1 && to > from, 'upload-quota.js no longer sets its ceilings here');
  const context = {
    process: { env: value === undefined ? {} : { UPLOADS_DAILY_CAP: value } },
    Number,
    answer: null,
  };
  vm.runInNewContext(
    `${quotaJs.slice(from, to)}
answer = { cap: UPLOADS_DAILY_CAP, budget: DAILY_BYTE_BUDGET, unit: MAX_UPLOAD_BYTES };`,
    context,
  );
  return context.answer;
}

const MB = 1024 * 1024;


/* The site-wide refusal itself, run rather than restated. reserveUpload needs a database and
   a transaction; the one condition that decides needs neither, so it is read out of the lib
   and evaluated on its own — rewriting it there fails here rather than quietly changing what
   this file claims. The day spent arrives as the string a SUM comes back as. */
function refusesTheDay(budget, spent, bytes) {
  const from = quotaJs.indexOf('const { total: today } =');
  const start = quotaJs.indexOf('if (', from);
  const end = quotaJs.indexOf(') {', start);
  assert.ok(
    from !== -1 && start !== -1 && end > start,
    'upload-quota.js no longer decides the day in one condition',
  );
  return vm.runInNewContext(quotaJs.slice(start + 4, end), {
    Number,
    DAILY_BYTE_BUDGET: budget,
    today: String(spent),
    bytes,
  });
}

test('an unset UPLOADS_DAILY_CAP is the default five hundred', () => {
  assert.equal(ceilingsFor(undefined).cap, 500);
});

test('an operator who sets UPLOADS_DAILY_CAP gets the number they set', () => {
  assert.equal(ceilingsFor('2000').cap, 2000);
});

/* The one value `Number(x) || 500` got wrong, and the only one an operator would type on
   purpose: zero closes the doors while the bucket is being cleared out by hand. Read as
   "absent" it would have done the opposite of what was asked and raised the ceiling. */
test('UPLOADS_DAILY_CAP=0 closes uploads rather than falling back to the default', () => {
  const { cap, budget } = ceilingsFor('0');
  assert.equal(cap, 0);
  // And a budget of nothing refuses every picture, however small: reserveUpload asks whether
  // this one still fits, and nothing fits in nothing.
  assert.equal(budget, 0);
});

test('a cap that is not a number at all falls back to the default', () => {
  assert.equal(ceilingsFor('nhieu').cap, 500);
  assert.equal(ceilingsFor('').cap, 500);
});

/* The breaker guards a bucket, and a bucket fills with bytes. Counted in pictures it would
   have been blind to the door that matters most: the salon importer stores originals at up
   to 5MB, so five hundred of ITS pictures is two and a half gigabytes against a bucket that
   holds one — and the breaker would never once have tripped. The cap keeps its name and its
   feel; its unit is a one-megabyte picture. */
test('the daily cap is spent in bytes, one megabyte to the picture', () => {
  const { budget, unit } = ceilingsFor(undefined);
  assert.equal(unit, MB);
  assert.equal(budget, 500 * MB);
});

test('an importer picture at five megabytes costs the day five of the five hundred', () => {
  const { budget, unit } = ceilingsFor(undefined);
  // What store-image.js lets the importer through at, which is the whole reason for this.
  const importerPicture = 5 * MB;
  assert.equal(importerPicture / unit, 5);
  assert.equal(Math.floor(budget / importerPicture), 100);
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

/* A reservation is allowed to weigh nothing: store-image.js hands the importer whatever a
   partner server answered with, and an empty 200 is a picture of zero bytes. Asked only
   whether this one still fits, the breaker waved those through on a day that was already
   full — and waved every one of them through when UPLOADS_DAILY_CAP=0, the setting whose
   entire purpose is to shut the doors. So the day being spent is now its own refusal. */
test('a day already spent refuses a reservation that weighs nothing', () => {
  const { budget } = ceilingsFor(undefined);
  assert.equal(refusesTheDay(budget, 0, MB), false);
  assert.equal(refusesTheDay(budget, budget - 1, 0), false);
  assert.equal(refusesTheDay(budget, budget, 0), true);
  assert.equal(refusesTheDay(budget, budget + MB, 0), true);
});

test('UPLOADS_DAILY_CAP=0 refuses a zero-byte reservation too', () => {
  assert.equal(refusesTheDay(ceilingsFor('0').budget, 0, 0), true);
});

/* Every upload screen posts what this returns and falls back to the raw file only when it
   answers null, so a page that could not find it on OAK would silently go back to sending
   phone-camera originals at the server's 1MB ceiling. */
/* And it names what comes back from what came back: toDataURL may answer a type it was not
   asked for, store-image.js reads nothing but the extension, and a row missing from the map
   would post one type under another's name. */
test('oak-api.js names a compressed picture after its own mime type', () => {
  for (const [mime, filename] of [
    ['image/webp', 'anh-oak.webp'],
    ['image/jpeg', 'anh-oak.jpg'],
    ['image/png', 'anh-oak.png'],
  ]) {
    assert.ok(
      clientJs.includes(`'${mime}': '${filename}',`),
      `oak-api.js no longer names ${mime} as ${filename}`,
    );
  }
});

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

/* ------------------------------------------- what the reconcile sweep may not delete ----
 *
 * Nothing has ever deleted a stored picture, so a replaced cover, a swapped portfolio piece
 * and an import the partner then edited away are all still in the bucket. tools/uploads-
 * reconcile.mjs finds them by asking which object names the database still holds; everything
 * that decides a picture's life hangs off that one answer, so it is the half worth pinning.
 */

test('an address is reduced to the object name under it, whichever shape it arrives in', () => {
  // The two shapes this platform hands out, and they must reduce to the same name.
  assert.equal(
    objectNameOf('https://abc.supabase.co/storage/v1/object/public/uploads/9f2c-4a.jpg'),
    '9f2c-4a.jpg',
  );
  assert.equal(objectNameOf('/uploads/9f2c-4a.jpg'), '9f2c-4a.jpg');
  // A cache-buster or a fragment belongs to the address, not to the object.
  assert.equal(objectNameOf('/uploads/9f2c-4a.jpg?v=2'), '9f2c-4a.jpg');
  assert.equal(objectNameOf('/uploads/a%20b.jpg'), 'a b.jpg');
  // And nothing at all is not a name, which is what keeps an empty column out of the set.
  for (const nothing of [null, undefined, '', '/uploads/', 42]) {
    assert.equal(objectNameOf(nothing), null, String(nothing));
  }
});

test('the referenced set reads a single address and a portfolio array alike', () => {
  const fixture = [
    // users.avatar, salons.image, salon_photos.image — one address each.
    'https://abc.supabase.co/storage/v1/object/public/uploads/avatar-1.jpg',
    '/uploads/cover-2.webp',
    null,
    '',
    // staff.portfolio / staff_profiles.portfolio — a JSON array in one TEXT column.
    '["/uploads/work-3.jpg","/uploads/work-4.jpg"]',
    // A column holding something that is not JSON at all names nothing, and throws nothing.
    '[this is not json',
    // A seeded picture on somebody else's host. Its last segment is read like any other,
    // which is safe: no bucket object is called this, so at worst it keeps nothing alive.
    'https://images.unsplash.com/photo-153.jpg',
  ];

  const names = referencedNames(fixture);
  assert.deepEqual(
    [...names].sort(),
    ['avatar-1.jpg', 'cover-2.webp', 'photo-153.jpg', 'work-3.jpg', 'work-4.jpg'],
  );
  // The same address twice is one object; the set is what the sweep compares the bucket to.
  assert.equal(referencedNames(['/uploads/a.jpg', '/uploads/a.jpg']).size, 1);
});

test('every column of the schema that can hold a picture is on the list', () => {
  /* A column added to db.js and forgotten here is a column whose pictures the sweep deletes,
     so this reads the schema rather than trusting the list. Every TEXT column named image,
     avatar or portfolio has to appear, together with the table it belongs to. */
  const schema = fs.readFileSync(path.join(root, 'server', 'src', 'db.js'), 'utf8');
  const declared = new Set(IMAGE_COLUMNS.map(([table, column]) => `${table}.${column}`));
  let table = null;
  for (const line of schema.split('\n')) {
    const created = /CREATE TABLE IF NOT EXISTS (\w+) \(/.exec(line);
    if (created) {
      table = created[1];
    }
    const column = /^\s{2}(image|avatar|portfolio) TEXT/.exec(line);
    if (table && column) {
      assert.ok(declared.has(`${table}.${column[1]}`), `${table}.${column[1]} is not swept`);
    }
  }
  // And uploads.url, which is not called any of those and is the record of every write.
  assert.ok(declared.has('uploads.url'));
});
