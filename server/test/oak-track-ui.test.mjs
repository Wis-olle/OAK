/* OAK.track() is the one call a page makes for nobody's benefit but ours: it measures.
   So the bar it has to clear is that it can never cost the visitor anything — not a
   thrown error in a click handler, not an unhandled rejection, not a page that stops
   working because a browser lacks sendBeacon or because /api/events is down. These tests
   run the shipped function against browsers that have the pieces, and browsers that do
   not. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const clientJs = fs.readFileSync(path.join(root, 'ui', 'assets', 'js', 'oak-api.js'), 'utf8');

/* track() lives inside the oak-api.js IIFE, which builds a header on load, so it is
   lifted out and driven against the smallest browser it touches. `browser` says which
   pieces that browser has; `beacons` and `fetches` collect what left. */
function harness(browser = {}) {
  const from = clientJs.indexOf('function track(name, meta) {');
  const to = clientJs.indexOf('var TRUST = {');
  assert.ok(from !== -1 && to > from, 'oak-api.js no longer contains track()');
  const script = clientJs.slice(from, to);

  const beacons = [];
  const fetches = [];

  const context = {
    JSON,
    String,
    location: { pathname: browser.pathname ?? '/blog-chi-tiet.html' },
    document: { referrer: browser.referrer ?? '' },
    navigator: {},
    Blob: function Blob(parts, options) {
      this.text = parts.join('');
      this.type = options && options.type;
    },
  };
  if (browser.sendBeacon !== false) {
    context.navigator.sendBeacon = (url, blob) => {
      beacons.push({ url, blob });
      return browser.sendBeacon !== 'refuses';
    };
  }
  if (browser.fetch !== false) {
    context.fetch = (url, init) => {
      fetches.push({ url, init });
      return browser.fetch === 'fails' ? Promise.reject(new Error('offline')) : Promise.resolve();
    };
  }
  if (browser.blob === false) {
    delete context.Blob;
  }

  vm.runInNewContext(`${script}\ntrackFn = track;`, context);
  return { track: context.trackFn, beacons, fetches };
}

test('an event leaves as a beacon, so it survives the page being left', () => {
  const browser = harness({ referrer: 'https://oak.vn/ket-qua-tim-kiem.html?q=noi+mi' });
  browser.track('blog_cta_click', { category: 'nail' });

  assert.equal(browser.beacons.length, 1);
  assert.equal(browser.fetches.length, 0);

  const [beacon] = browser.beacons;
  assert.equal(beacon.url, '/api/events');
  // As JSON, or express.json() would never parse it.
  assert.equal(beacon.blob.type, 'application/json');
  assert.deepEqual(JSON.parse(beacon.blob.text), {
    name: 'blog_cta_click',
    page: 'blog-chi-tiet.html',
    // The referring page, without the search terms its query string was carrying.
    ref: 'https://oak.vn/ket-qua-tim-kiem.html',
    meta: { category: 'nail' },
  });
});

test('a browser without sendBeacon still reports, and never throws for it', () => {
  const browser = harness({ sendBeacon: false });
  assert.doesNotThrow(() => browser.track('wizard_start'));

  assert.equal(browser.beacons.length, 0);
  assert.equal(browser.fetches.length, 1);

  const [call] = browser.fetches;
  assert.equal(call.url, '/api/events');
  assert.equal(call.init.method, 'POST');
  // keepalive, for the same reason sendBeacon is tried first: the last event of a visit
  // is sent by a page that is on its way out.
  assert.equal(call.init.keepalive, true);
  assert.equal(JSON.parse(call.init.body).name, 'wizard_start');
});

test('a beacon the browser refuses to queue falls through to the fetch', () => {
  const browser = harness({ sendBeacon: 'refuses' });
  browser.track('lang_switch');

  assert.equal(browser.beacons.length, 1);
  assert.equal(browser.fetches.length, 1);
});

test('a browser with neither way of sending is not an error the visitor sees', () => {
  const browser = harness({ sendBeacon: false, fetch: false });
  assert.doesNotThrow(() => browser.track('promo_use', { code: 'OAK10' }));
  assert.equal(browser.beacons.length, 0);

  // Nor is a browser that has sendBeacon but no Blob to hand it.
  const older = harness({ blob: false, fetch: false });
  assert.doesNotThrow(() => older.track('contact_submit'));
});

test('/api/events being down is nobody else’s problem', async () => {
  const browser = harness({ sendBeacon: false, fetch: 'fails' });
  assert.doesNotThrow(() => browser.track('assistant_message'));
  // The rejection is handled inside track(); nothing here is left for the process to
  // report as unhandled.
  await new Promise((resolve) => setImmediate(resolve));
});

test('an event with nothing to say carries no meta at all', () => {
  const browser = harness();
  browser.track('search_submit');
  assert.equal(JSON.parse(browser.beacons[0].blob.text).meta, undefined);
});
