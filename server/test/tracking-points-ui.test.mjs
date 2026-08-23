/* The eight things OAK measures are only worth the endpoint behind them if they fire at
   the moment they claim to, carry nothing that could name a person, and — above all —
   never cost the visitor the thing they came to do. dat-lich-ui.test.mjs and
   search-results-ui.test.mjs cover the wizard and the results page; this covers the rest
   of the call sites, each driven through the page's own inline factory.

   Every one of them runs twice: once against a browser whose oak-api.js has track(), and
   once against one that has not — a page served from cache meeting an older script, which
   is exactly the case a bare `OAK.track(...)` would turn into a broken page. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const read = (file) => fs.readFileSync(path.join(root, 'ui', file), 'utf8');

/**
 * Lift one inline factory out of its page and run it.
 *
 * `factory` is the function to call; the slice starts at its declaration and ends at the
 * next one. `extras` fills in whatever else that page's script touches.
 * `events` collects what OAK.track() was asked to report — but only when `tracking` says
 * this browser has one.
 */
function page(file, factory, { tracking = true, extras = {} } = {}) {
  const html = read(file);
  const tail = html.slice(html.indexOf(`function ${factory}()`));
  /* Stop at the next top-level declaration, or at the end of the script: a page's later
     factories reach for a document this has no need to build. */
  const next = tail.indexOf('\n    function oak', 1);
  const end = tail.indexOf('</script>');
  const script = tail.slice(0, next === -1 ? end : Math.min(next, end));

  const events = [];
  const context = {
    URLSearchParams,
    encodeURIComponent,
    location: { search: '', href: '', pathname: '/' + file },
    OAK: { toast: () => {} },
    ...extras,
  };
  if (tracking) {
    context.OAK.track = (name, meta) => events.push([name, meta]);
  }

  vm.runInNewContext(`${script}\nresult = ${factory}();`, context);
  return { state: context.result, events, context };
}

test('a search asked for from the home page is counted, and the keyword never is', () => {
  const { state, events, context } = page('kham-pha.html', 'oakSearchBox');
  state.q = ' noi mi ';
  state.district = 'Quận 1';

  state.submit();

  assert.deepEqual(events, [['search_submit', undefined]]);
  // The search still happens, and the keyword goes where it belongs: the address bar.
  assert.equal(context.location.href, 'ket-qua-tim-kiem.html?q=noi+mi&district=Qu%E1%BA%ADn+1');
});

test('a home page whose oak-api.js has no track() still searches', () => {
  const { state, context } = page('kham-pha.html', 'oakSearchBox', { tracking: false });
  state.q = 'nail';

  assert.doesNotThrow(() => state.submit());
  assert.equal(context.location.href, 'ket-qua-tim-kiem.html?q=nail');
});

test('every turn taken with the assistant is counted, and none of it is quoted', async () => {
  const { state, events } = page('tim-kiem-thong-minh.html', 'oakSearchAssistant', {
    extras: { OAK: { api: async () => ({ criteria: {}, chips: [], reply: 'Vâng' }) } },
  });

  await state.send('nối mi ở quận 1');
  await state.send('rẻ hơn');

  assert.deepEqual(events, [['assistant_message', undefined], ['assistant_message', undefined]]);
  // An empty box is not a turn.
  await state.send('   ');
  assert.equal(events.length, 2);
});

test('an assistant page whose oak-api.js has no track() still answers', async () => {
  const { state } = page('tim-kiem-thong-minh.html', 'oakSearchAssistant', {
    tracking: false,
    extras: { OAK: { api: async () => ({ criteria: {}, chips: [], reply: 'Vâng' }) } },
  });

  await assert.doesNotReject(() => state.send('nối mi'));
  assert.equal(state.messages.length, 2);
});

test('the blog CTA reports which topic sent the reader towards a booking', () => {
  const { state, events } = page('blog-chi-tiet.html', 'oakPostDetail');
  state.post = { id: 3, category: 'nail' };

  state.trackCta();
  // An article filed under nothing is still a click worth counting, under a label the
  // weekly query can group on.
  state.post = { id: 4, category: null };
  state.trackCta();

  assert.deepEqual(events.map(([name]) => name), ['blog_cta_click', 'blog_cta_click']);
  assert.equal(events[0][1].category, 'nail');
  assert.equal(events[1][1].category, 'khac');
});

test('a blog page whose oak-api.js has no track() still follows its own CTA', () => {
  const { state } = page('blog-chi-tiet.html', 'oakPostDetail', { tracking: false });
  state.post = { id: 3, category: 'nail' };

  assert.doesNotThrow(() => state.trackCta());
});

test('a contact message is counted by its topic, and only once it passes validation', () => {
  const { state, events, context } = page('lien-he.html', 'oakContactForm', {
    extras: { document: { getElementById: () => ({ focus: () => {} }) } },
  });

  // Nothing typed: no message left, so nothing to count.
  state.compose();
  assert.deepEqual(events, []);

  state.name = 'Ngọc Anh';
  state.message = 'Tôi cần đổi lịch hẹn.';
  state.compose();

  assert.equal(events.length, 1);
  assert.equal(events[0][0], 'contact_submit');
  // One of four fixed choices — not a word of what was typed, and no way to reach anyone.
  assert.equal(events[0][1].topic, 'Hỗ trợ đặt lịch');
  assert.match(context.location.href, /^mailto:hello@oakbeauty\.vn\?subject=/);
});

test('a contact page whose oak-api.js has no track() still composes', () => {
  const { state, context } = page('lien-he.html', 'oakContactForm', {
    tracking: false,
    extras: { document: { getElementById: () => ({ focus: () => {} }) } },
  });
  state.name = 'Ngọc Anh';
  state.message = 'Tôi cần đổi lịch hẹn.';

  assert.doesNotThrow(() => state.compose());
  assert.match(context.location.href, /^mailto:hello@oakbeauty\.vn\?subject=/);
});

/**
 * Lift OAKI18N.set() out of oak-i18n.js. Every VI/EN control on the site ends there — the
 * header pair, the partner-console pair, the standalone pill and the settings page — so
 * that is the single place the switch can be counted without counting some of them twice.
 */
function langSwitch({ tracking = true } = {}) {
  const source = fs.readFileSync(path.join(root, 'ui', 'assets', 'js', 'oak-i18n.js'), 'utf8');
  const from = source.indexOf('function set(next) {');
  const to = source.indexOf('function start() {');
  assert.ok(from !== -1 && to > from, 'oak-i18n.js no longer contains set()');

  const events = [];
  const stored = [];
  const reloads = [];
  const context = {
    store: (code) => stored.push(code),
    location: { reload: () => reloads.push(1) },
    window: { OAK: { toast: () => {} } },
  };
  if (tracking) {
    context.window.OAK.track = (name, meta) => events.push([name, meta]);
  }

  vm.runInNewContext(`${source.slice(from, to)}
lifted = set;`, context);
  return { set: context.lifted, events, stored, reloads };
}

test('switching language is counted before the reload that ends the page', () => {
  const { set, events, stored, reloads } = langSwitch();

  set('en');
  assert.equal(events.length, 1);
  assert.equal(events[0][0], 'lang_switch');
  /* Read a field at a time: the meta object is built in the lifted realm. */
  assert.equal(events[0][1].to, 'en');
  // Counted first, then stored, then the page goes: a beacon survives the unload.
  assert.deepEqual(stored, ['en']);
  assert.equal(reloads.length, 1);

  // Anything that is not 'en' is Vietnamese, and it is reported as what it stored.
  set('vi');
  assert.equal(events[1][1].to, 'vi');
});

test('a page whose oak-api.js has no track() still switches language', () => {
  const { set, stored, reloads } = langSwitch({ tracking: false });

  assert.doesNotThrow(() => set('en'));
  assert.deepEqual(stored, ['en']);
  assert.equal(reloads.length, 1);
});

test('the settings page delegates instead of counting the same switch twice', () => {
  const switched = [];
  const { state, events } = page('cai-dat.html', 'oakSettings', {
    extras: { window: { OAKI18N: { lang: 'vi', set: (code) => switched.push(code) } } },
  });

  state.setLang('en');
  assert.deepEqual(switched, ['en']);
  assert.deepEqual(events, [], 'OAKI18N.set() is what counts this one');

  // Picking the language already in use changes nothing, so it is not a switch.
  state.setLang('vi');
  assert.deepEqual(switched, ['en']);
});
