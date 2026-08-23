/* The cold-start handling in oak-api.js exists because the API sleeps and takes half a
   minute to wake. Everything it does is visible to the visitor and none of it is
   recoverable by them, so the failure modes matter more than the happy path: a notice that
   is never taken down promises a server that is never coming, and a reload loop is a page
   nobody can leave. These tests drive the shipped functions against a stopped clock. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const clientJs = fs.readFileSync(path.join(root, 'ui', 'assets', 'js', 'oak-api.js'), 'utf8');

const COLD_START = 'OAK đang khởi động, vui lòng đợi khoảng 30 giây…';
const READY = 'Máy chủ đã sẵn sàng. Vui lòng tải lại trang để xem nội dung.';

/* api(), the banner and the wake loop are one another's callers, so they are lifted as one
   run of source. Both markers are declarations: rewording a comment in oak-api.js cannot
   quietly change what is under test here. */
const from = clientJs.indexOf('function apiError(code, message) {');
const to = clientJs.indexOf('// One request per page load');
assert.ok(from !== -1 && to > from, 'oak-api.js no longer contains apiError() .. api()');
const script = clientJs.slice(from, to);

/** A clock the test winds by hand, so an eighty-second retry loop runs in no time. */
function clock() {
  const pending = new Map();
  let nextId = 1;
  let now = 0;
  return {
    setTimeout(fn, delay) {
      pending.set(nextId, { fn, at: now + (delay || 0) });
      return nextId++;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        // Before every tick, not only after: a real timer never fires ahead of the
        // promise callbacks that were already queued when it was set, and a fake one that
        // does will abort a request the stub has not answered yet.
        await new Promise((resolve) => setImmediate(resolve));
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) {
          break;
        }
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
  };
}

/** The smallest browser these functions touch: one body, one clock, one tab's storage. */
function harness(options = {}) {
  const timers = clock();
  const nodes = new Map();
  const calls = [];
  const store = options.store || new Map();
  const respond = options.respond || (() => ({ success: true, data: { user: null } }));
  const fields = options.fields || [];
  const listeners = new Map();
  let reloads = 0;

  const context = {
    Error,
    Object,
    Promise,
    JSON,
    String,
    Math,
    AbortController,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    LOGIN_PAGE: 'dang-nhap-nguoi-dung.html',
    PARTNER_LOGIN_PAGE: 'dang-nhap-doi-tac.html',
    sessionSeen: false,
    partnerPage: false,
    redirectToLogin: () => new Promise(() => {}),
    location: {
      reload() {
        reloads += 1;
      },
    },
    sessionStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => {
        if (options.storageBlocked) {
          throw new Error('storage disabled');
        }
        store.set(key, String(value));
      },
      removeItem: (key) => {
        if (options.storageBlocked) {
          throw new Error('storage disabled');
        }
        store.delete(key);
      },
    },
    document: {
      body: {
        appendChild(node) {
          nodes.set(node.id, node);
        },
      },
      getElementById: (id) => nodes.get(id) || null,
      querySelectorAll: () => fields,
      addEventListener(type, handler) {
        listeners.set(type, handler);
      },
      createElement() {
        const node = {
          attributes: {},
          setAttribute(name, value) {
            node.attributes[name] = value;
          },
          remove() {
            nodes.delete(node.id);
          },
        };
        return node;
      },
    },
    fetch(url, init) {
      calls.push({ url, init });
      return Promise.resolve()
        .then(() => respond(url, init))
        .then((payload) => ({ json: () => Promise.resolve(payload) }));
    },
  };

  vm.runInNewContext(`${script}\nlifted = { api, startWake, watchColdStart };`, context);
  return {
    ...context.lifted,
    advance: timers.advance,
    calls,
    banner: () => nodes.get('oak-server-down') || null,
    reloads: () => reloads,
    // The visitor puts something into the page: what the reload has to protect is this
    // act, not the contents of any field.
    interact: (type) => listeners.get(type)(),
  };
}

test('the waiting notice goes up after three seconds and comes down on an answer', async () => {
  const page = harness();
  let answer;
  const guarded = page.watchColdStart(
    new Promise((resolve) => {
      answer = resolve;
    }),
  );

  await page.advance(2999);
  assert.equal(page.banner(), null, 'a request that is merely quick says nothing');

  await page.advance(1);
  assert.equal(page.banner().textContent, COLD_START);
  // Waiting is progress: it must not interrupt a screen reader mid-sentence.
  assert.equal(page.banner().attributes.role, 'status');

  answer('data');
  await guarded;
  assert.equal(page.banner(), null);
});

test('a slow failure that is not a cold start does not leave the notice behind', async () => {
  const page = harness();
  let fail;
  const guarded = page.watchColdStart(
    new Promise((resolve, reject) => {
      fail = reject;
    }),
  );

  await page.advance(3000);
  assert.ok(page.banner(), 'the notice is up, because the answer took longer than three seconds');

  // A waking database answering with a 500 after four seconds: an error, but not the kind
  // that means "asleep", so nothing else is going to take this banner down.
  const error = new Error('Đã có lỗi xảy ra, vui lòng thử lại sau.');
  error.code = 'INTERNAL_ERROR';
  fail(error);

  await assert.rejects(guarded, (thrown) => thrown.code === 'INTERNAL_ERROR');
  assert.equal(page.banner(), null, 'the page renders; it must not do so under a false promise');
});

test('the wake loop asks for the call that failed, not for a health check', async () => {
  const page = harness();
  page.startWake();
  assert.equal(page.banner().textContent, COLD_START);

  await page.advance(3000);
  // The page's own call, through api(), so the probe carries the same eight-second
  // ceiling and the same auth path as the request that failed.
  assert.deepEqual(
    page.calls.map((call) => call.url),
    ['/api/auth/me'],
  );
  assert.equal(page.reloads(), 1);
  assert.equal(page.banner(), null);
});

test('a failed load gets one automatic reload, never a loop of them', async () => {
  const tab = new Map();
  const first = harness({ store: tab });
  first.startWake();
  await first.advance(3000);
  assert.equal(first.reloads(), 1);

  // The reload lands on a page whose own request fails again — the loop this counter is
  // for. Nothing loaded in between, so the counter is still spent and the reloading stops.
  const second = harness({ store: tab });
  second.startWake();
  await second.advance(3000);
  assert.equal(second.reloads(), 0);
  // The server answered a moment ago, so blaming the visitor's network would be the
  // opposite of what just happened: say it is ready and let them reload.
  assert.equal(second.banner().attributes.role, 'status');
  assert.equal(second.banner().textContent, READY);
});

test('a page the visitor has typed into is never reloaded under them', async () => {
  // ui/lien-he.html renders entirely from static markup: it is usable, and fillable,
  // while the API is still asleep.
  const page = harness();
  page.interact('input');
  page.startWake();
  await page.advance(3000);

  assert.equal(page.reloads(), 0, 'a reload here would silently delete the message');
  assert.equal(page.banner().textContent, READY);
});

test('a page that ticked a box under the visitor is not reloaded under them either', async () => {
  const page = harness();
  page.interact('change');
  page.startWake();
  await page.advance(3000);

  assert.equal(page.reloads(), 0);
  assert.equal(page.banner().textContent, READY);
});

test('a field the page filled in itself does not block the automatic reload', async () => {
  // ket-qua-tim-kiem.html copies ?q= into the search box in init(), before its first
  // await — so the box holds text milliseconds into the load, long before the wake loop
  // ends. Reading values here would cancel the automatic reload on the very page a cold
  // start is most likely to land on.
  const page = harness({ fields: [{ type: 'text', value: 'nail' }] });
  page.startWake();
  await page.advance(3000);

  assert.equal(page.reloads(), 1);
});

test('an untouched checkbox does not block the automatic reload', async () => {
  // blog.html and cai-dat-salon.html hold checkboxes; an untouched one reads 'on' by
  // spec, never ''.
  const page = harness({ fields: [{ type: 'checkbox', value: 'on', checked: false }] });
  page.startWake();
  await page.advance(3000);

  assert.equal(page.reloads(), 1);
});

test('with storage blocked the reload is treated as already spent', async () => {
  // Private browsing: there is nowhere to keep the counter, and an uncapped automatic
  // reload is a tab nobody can leave.
  const page = harness({ storageBlocked: true });
  page.startWake();
  await page.advance(3000);

  assert.equal(page.reloads(), 0);
  assert.equal(page.banner().textContent, READY);
});

test('a load that succeeds hands the tab its automatic reload back', async () => {
  const tab = new Map();
  const first = harness({ store: tab });
  first.startWake();
  await first.advance(3000);
  assert.equal(first.reloads(), 1);

  // The reloaded page gets its data. That reload did its job and is done with.
  const reloaded = harness({ store: tab });
  await reloaded.watchColdStart(Promise.resolve({ user: null }));

  // Render sleeps again a quarter of an hour later, and the visitor clicks through to
  // another page in the same tab. This is a new cold start, not the loop above: it has to
  // end with the page loading, not with a banner blaming the visitor's network for a
  // server that just answered.
  const later = harness({ store: tab });
  later.startWake();
  await later.advance(3000);
  assert.equal(later.reloads(), 1);
  assert.equal(later.banner(), null);
});

test('past the longest cold start it stops claiming the server is coming back', async () => {
  const page = harness({
    respond: () => {
      throw new Error('offline');
    },
  });
  page.startWake();

  await page.advance(200000);
  assert.equal(page.reloads(), 0);
  assert.equal(page.banner().attributes.role, 'alert');
  assert.match(page.banner().textContent, /Không kết nối được máy chủ/);
  // It really did keep asking rather than give up on the first refusal.
  assert.ok(page.calls.length >= 8);
});

test('a read is abandoned after eight seconds; a write is left to finish', async () => {
  const page = harness({
    respond: (url, init) =>
      new Promise((resolve, reject) => {
        if (init.signal) {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }
      }),
  });

  // Watched before the clock moves: the read is meant to fail, and a rejection nobody is
  // holding yet takes the whole test process down with it.
  const read = assert.rejects(
    page.api('/api/salons?district=1'),
    (error) => error.code === 'NETWORK_ERROR',
  );
  const write = page.api('/api/bookings', { method: 'POST', body: { salon_id: 1 } });
  await page.advance(8000);
  await read;
  // Giving up on a write is not the same act as giving up on a read: the server may still
  // commit it, and a booking reported as failed is retried into its own slot conflict.
  assert.equal(page.calls[1].init.signal, undefined);
  assert.equal(
    await Promise.race([write.then(() => 'settled'), Promise.resolve('pending')]),
    'pending',
  );
});
