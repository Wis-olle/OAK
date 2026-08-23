/* The events table is the one table in the schema that must not be able to name a person,
   and the promise that it cannot is kept by four small functions in routes/events.js: a
   name pattern, a text clamp, a meta filter and a per-IP counter. None of them touch the
   database, so they are lifted out and driven directly — a later edit to a regex has to
   fail here rather than quietly widen what a row can hold. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routeJs = fs.readFileSync(path.join(root, 'src', 'routes', 'events.js'), 'utf8');

/* One contiguous run of source, from the name pattern down to the last pure helper. Both
   markers are declarations, so rewording a comment in events.js cannot change what is
   under test — but moving a function out of the run will fail loudly here. */
function lift() {
  const from = routeJs.indexOf('const NAME_PATTERN');
  const to = routeJs.indexOf('/* Minted at boot');
  assert.ok(from !== -1 && to > from, 'events.js no longer contains the sanitising helpers');

  const context = { Map, Date, Object, JSON, Number, Array };
  vm.runInNewContext(
    `${routeJs.slice(from, to)}
     lifted = { NAME_PATTERN, rateLimited, text, sanitiseMeta };`,
    context,
  );
  return context.lifted;
}

const { NAME_PATTERN, rateLimited, text, sanitiseMeta } = lift();

/** sanitiseMeta returns JSON or null; the tests care about the object it stands for. */
function meta(value) {
  const stored = sanitiseMeta(value);
  return stored === null ? null : JSON.parse(stored);
}

test('the eight instrumented events are accepted, and prose is not', () => {
  for (const name of [
    'search_submit',
    'wizard_start',
    'booking_submit',
    'assistant_message',
    'blog_cta_click',
    'contact_submit',
    'lang_switch',
    'promo_use',
  ]) {
    assert.ok(NAME_PATTERN.test(name), `${name} should be a valid event name`);
  }

  // Anything that reads like a label rather than an identifier is a mis-instrumented
  // call site, and a table of free text is a table nobody can group by.
  assert.equal(NAME_PATTERN.test('Search Submit'), false);
  assert.equal(NAME_PATTERN.test('Search'), false);
  assert.equal(NAME_PATTERN.test('ab'), false, 'too short to mean anything');
  assert.equal(NAME_PATTERN.test('search submit'), false);
  assert.equal(NAME_PATTERN.test('9_lives'), false);
});

test('a value that could reach a person never reaches the table', () => {
  // An email address, or a run of digits long enough to be a phone number.
  assert.equal(meta({ note: 'chi.mai@gmail.com' }), null);
  assert.equal(meta({ note: '0912345678' }), null);
  assert.equal(meta({ note: 'goi 0912345678 nhe' }), null);

  // Shorter numbers inside a string are fine: they are counts and codes.
  assert.deepEqual(meta({ code: 'OAK10' }), { code: 'OAK10' });
});

test('a key that names a person or an account is dropped whatever it holds', () => {
  for (const key of ['user_id', 'userId', 'account', 'email', 'phone', 'token', 'ten_khach']) {
    assert.equal(meta({ [key]: 12 }), null, `${key} should never be stored`);
    assert.equal(meta({ [key]: 'nail' }), null, `${key} should never be stored`);
    assert.equal(meta({ [key]: true }), null, `${key} should never be stored`);
  }
});

test('what meta is actually for survives: counts, flags and short labels', () => {
  assert.deepEqual(meta({ total: 12, category: 'nail', empty: false }), {
    total: 12,
    category: 'nail',
    empty: false,
  });

  // And nothing else does: no nesting, no arrays, no NaN, no meta at all when nothing is
  // left worth writing.
  assert.equal(meta({ nested: { total: 1 } }), null);
  assert.equal(meta({ list: [1, 2] }), null);
  assert.equal(meta({ total: Number.NaN }), null);
  assert.equal(meta({}), null);
  assert.equal(meta('search'), null);
  assert.equal(meta([{ total: 1 }]), null);
  assert.equal(meta(null), null);
});

test('a page cannot fill a row with its own shape of data', () => {
  const wide = {};
  for (let index = 0; index < 20; index += 1) {
    wide[`k${index}`] = index;
  }
  assert.equal(Object.keys(meta(wide)).length, 8, 'at most eight keys are kept');

  // A long key or a long value is a payload, not a label.
  assert.equal(meta({ ['k'.repeat(41)]: 1 }), null);
  assert.equal(meta({ note: 'a'.repeat(41) }), null);
  assert.deepEqual(meta({ note: 'a'.repeat(40) }), { note: 'a'.repeat(40) });
});

test('page and ref are trimmed to something a row can hold', () => {
  assert.equal(text('  blog-chi-tiet.html  '), 'blog-chi-tiet.html');
  assert.equal(text('a'.repeat(300)).length, 200);
  assert.equal(text('   '), null);
  assert.equal(text(''), null);
  assert.equal(text(12), null);
  assert.equal(text(null), null);
});

test('one caller gets sixty events a minute and no more', () => {
  const key = '203.0.113.7';
  for (let call = 1; call <= 60; call += 1) {
    assert.equal(rateLimited(key), false, `call ${call} is within the allowance`);
  }
  assert.equal(rateLimited(key), true, 'the sixty-first is refused');

  // Per caller, not globally: a busy visitor must not silence the rest of the site.
  assert.equal(rateLimited('198.51.100.4'), false);
});
