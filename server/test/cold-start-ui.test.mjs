/* The cold-start handling in oak-api.js exists because the API sleeps and takes half a
   minute to wake. Everything it does is visible to the visitor and none of it is
   recoverable by them, so the failure modes matter more than the happy path: a notice that
   is never taken down promises a server that is never coming, and a reload loop is a page
   nobody can leave. These tests drive the shipped functions against a stopped clock. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readUi } from './lib/read-source.mjs';

const clientJs = readUi('assets/js/oak-api.js');

const COLD_START = 'OAK đang khởi động, vui lòng đợi khoảng 30 giây…';
const READY = 'Máy chủ đã sẵn sàng. Vui lòng tải lại trang để xem nội dung.';

/* api(), the banner and the wake loop are one another's callers, so they are lifted as one
   run of source. Both markers are declarations: rewording a comment in oak-api.js cannot
   quietly change what is under test here. */
const from = clientJs.indexOf('function apiError(code, message, details) {');
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
  const redirects = [];
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
    // Both of these live outside the lifted slice, so they are supplied here — and both
    // are read by api()'s expired-session branch, which is what the last test drives.
    // `loginPage` is the page whose guard ran; a page with no guard keeps the default.
    sessionSeen: Boolean(options.sessionSeen),
    loginPage: options.loginPage || 'dang-nhap-nguoi-dung.html',
    redirectToLogin: (page) => {
      redirects.push(page);
      return new Promise(() => {});
    },
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
    redirects,
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
  // cai-dat-salon.html holds checkboxes; an untouched one reads 'on' by
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
  assert.match(page.banner().textContent, /OAK chưa phản hồi/);
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

/* A session that expired while the page was open is sent back to a login page — and to the
   right one of the three. api() reads that target from `loginPage`, a module-level variable
   the guards set and this slice does not declare, so the stub above is the only thing
   standing in for it: before this case existed, renaming that variable left the harness
   supplying a name nothing read and the branch threw a ReferenceError nobody was driving. */
test('an expired session goes back to the login page the page belongs to', async () => {
  const expired = () => ({ success: false, error: { code: 'UNAUTHENTICATED', message: 'hết hạn' } });

  const customer = harness({ sessionSeen: true, respond: expired });
  // Never settles, the way a redirect does not: what is asserted is where it went.
  customer.api('/api/bookings/mine');
  await customer.advance(0);
  assert.deepEqual(customer.redirects, ['dang-nhap-nguoi-dung.html']);

  const console_ = harness({
    sessionSeen: true,
    loginPage: 'dang-nhap-doi-tac.html',
    respond: expired,
  });
  console_.api('/api/partner/staff');
  await console_.advance(0);
  assert.deepEqual(console_.redirects, ['dang-nhap-doi-tac.html']);

  const staff = harness({
    sessionSeen: true,
    loginPage: 'dang-nhap-nhan-vien.html',
    respond: expired,
  });
  staff.api('/api/staff-me/bookings');
  await staff.advance(0);
  assert.deepEqual(staff.redirects, ['dang-nhap-nhan-vien.html']);

  // An anonymous visitor on a public page has no session to have lost, so the same
  // envelope is an ordinary error there rather than a bounce.
  const guest = harness({ respond: expired });
  await assert.rejects(guest.api('/api/salons'), (error) => error.code === 'UNAUTHENTICATED');
  assert.deepEqual(guest.redirects, []);
});
