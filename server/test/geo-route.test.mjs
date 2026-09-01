/* The Nominatim proxy (routes/geo.js). It exists because openstreetmap.org is unreachable
   from a Vietnamese network, and what it promises is narrow: the caller's query reaches one
   fixed upstream carrying only the parameters the two pages send, the answer comes back in
   Nominatim's own shape, a failure upstream is a 502 rather than a page-breaking body, and
   however many pages ask at once Nominatim is asked no more than once every 1.1 seconds —
   the rate its usage policy allows. The rest of what is tested here is what keeps one
   caller from spending that rate on everyone else's behalf: a per-caller allowance, a
   ceiling on the queue, and a repeat answered from memory.

   The module imports middleware/auth.js, which opens a database connection the moment it is
   imported, so the router body is lifted and driven in a context of stubs instead — the same
   trick events-route.test.mjs and assistant-parser.test.mjs use. `fetch` in that context is a
   mock: the real Nominatim is never called from a test. */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readServer } from './lib/read-source.mjs';

const routeJs = readServer('routes/geo.js');

const USER_AGENT = 'OAKBeautyDemo/1.0 (hello@oakbeauty.vn)';

/**
 * The module body, with the imports and the default export cut away, wired to `fetchMock`.
 * Both markers are code rather than comments, so rewording a comment in geo.js cannot change
 * what is under test. Returns the GET /search handler, each lift starting from a fresh queue,
 * an empty allowance and an empty cache. `timer` stands in for setTimeout, so a test that
 * walks the queue need not wait out the 1.1s gap the module puts between rungs.
 */
function lift(fetchMock, timer) {
  const from = routeJs.indexOf('const router = express.Router();');
  const to = routeJs.indexOf('export default router');
  assert.ok(from !== -1 && to > from, 'geo.js no longer has a router body to lift');

  const routes = {};
  const context = {
    express: {
      Router: () => ({
        get(routePath, handler) {
          routes[routePath] = handler;
        },
      }),
    },
    httpError: (status, code, message) =>
      Object.assign(new Error(message), { status, code, isAppError: true }),
    fetch: fetchMock,
    URLSearchParams,
    AbortSignal,
    setTimeout: timer || setTimeout,
    Promise,
    Error,
    console: { error() {} },   /* The route logs every upstream failure; a test run need not. */
  };
  vm.runInNewContext(routeJs.slice(from, to), context);

  assert.ok(routes['/search'], 'geo.js no longer registers GET /search');
  return routes['/search'];
}

/** A response stub that records what the handler answered with. */
function recorder() {
  const answered = { body: undefined, error: undefined };
  return {
    answered,
    res: {
      json(value) {
        answered.body = value;
      },
    },
    next(error) {
      answered.error = error;
    },
  };
}

/** A setTimeout that fires as soon as it can: the 1.1s gap is under test in its own case. */
function immediate(callback) {
  return setTimeout(callback, 0);
}

/** One request through the lifted handler, resolving when it has answered. `req` overrides
    the caller's address and whether the connection is still open. */
function call(search, query, req) {
  const { answered, res, next } = recorder();
  return search({ query, ip: '203.0.113.7', ...req }, res, next).then(() => answered);
}

test('the caller’s query reaches Nominatim, and its array comes back untouched', async () => {
  const places = [{ lat: '10.7769', lon: '106.7009', display_name: 'Nguyễn Huệ, Quận 1' }];
  const fetchMock = mock.fn(async () => ({ ok: true, json: async () => places }));
  const search = lift(fetchMock);

  const answered = await call(search, {
    format: 'jsonv2',
    countrycodes: 'vn',
    'accept-language': 'vi',
    limit: '5',
    q: 'Nguyễn Huệ',
  });

  assert.equal(fetchMock.mock.callCount(), 1);
  const [url, init] = fetchMock.mock.calls[0].arguments;
  const asked = new URL(url);

  // The upstream is the constant in the module, never anything the caller sent.
  assert.equal(asked.origin + asked.pathname, 'https://nominatim.openstreetmap.org/search');
  assert.equal(asked.searchParams.get('q'), 'Nguyễn Huệ');
  assert.equal(asked.searchParams.get('format'), 'jsonv2');
  assert.equal(asked.searchParams.get('countrycodes'), 'vn');
  assert.equal(asked.searchParams.get('accept-language'), 'vi');
  assert.equal(asked.searchParams.get('limit'), '5');

  // Nominatim refuses a caller that does not name itself.
  assert.equal(init.headers['User-Agent'], USER_AGENT);

  // Nominatim's own shape, not the {success, data} envelope: both pages parse the array.
  assert.deepEqual(answered.body, places);
  assert.equal(answered.error, undefined);
});

test('an upstream refusal is a 502, not a body the page would try to read', async () => {
  const search = lift(mock.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })));

  const answered = await call(search, { q: 'Nguyễn Huệ' });

  assert.equal(answered.body, undefined);
  assert.equal(answered.error.status, 502);
  assert.equal(answered.error.code, 'UPSTREAM_ERROR');
});

test('an upstream that cannot be reached at all is the same 502', async () => {
  const search = lift(mock.fn(async () => {
    throw new Error('The operation was aborted due to timeout');
  }));

  const answered = await call(search, { q: 'Nguyễn Huệ' });

  assert.equal(answered.body, undefined);
  assert.equal(answered.error.status, 502);
});

test('two pages asking at once still reach Nominatim one request at a time', async () => {
  const at = [];
  const search = lift(mock.fn(async () => {
    at.push(Date.now());
    return { ok: true, json: async () => [] };
  }));

  await Promise.all([call(search, { q: 'Quận 1' }), call(search, { q: 'Quận 3' })]);

  assert.equal(at.length, 2);
  // 1100ms is what the route waits; the assertion allows for a timer that fires a little
  // early on a coarse clock, and would still fail loudly if the gap were dropped.
  const gap = at[1] - at[0];
  assert.ok(gap >= 1000, `the second call came ${gap}ms after the first, expected ~1100ms`);
});

test('only what the two pages send crosses to Nominatim, and limit is clamped', async () => {
  const fetchMock = mock.fn(async () => ({ ok: true, json: async () => [] }));
  const search = lift(fetchMock);

  await call(search, {
    q: 'Việt Nam',
    format: 'jsonv2',
    polygon_geojson: '1',   /* Boundaries this route would read into memory whole. */
    limit: '40',
  });

  const asked = new URL(fetchMock.mock.calls[0].arguments[0]);
  assert.equal(asked.searchParams.get('q'), 'Việt Nam');
  assert.equal(asked.searchParams.get('format'), 'jsonv2');
  assert.equal(asked.searchParams.get('polygon_geojson'), null);
  assert.equal(asked.searchParams.get('limit'), '5');
});

test('the queue has a ceiling, and comes back down once it drains', async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const fetchMock = mock.fn(async () => {
    await held;
    return { ok: true, json: async () => [] };
  });
  const search = lift(fetchMock, immediate);

  /* MAX_WAITING of them, none of which can settle: one fetching, nine behind it. A caller
     of its own each, so the refusal below can only be the queue ceiling — from one address
     the per-IP counter would refuse with the same status and code, proving nothing. */
  const inFlight = [];
  for (let n = 0; n < 10; n += 1) {
    inFlight.push(call(search, { q: `Quận ${n}` }, { ip: `10.1.0.${n}` }));
  }

  const refused = await call(search, { q: 'Quận 11' }, { ip: '10.1.1.1' });
  assert.equal(refused.body, undefined);
  assert.equal(refused.error.status, 429);
  assert.equal(refused.error.code, 'RATE_LIMITED');

  release();
  await Promise.all(inFlight);

  /* The counter came back down with them, or this reader would be refused forever. */
  const answered = await call(search, { q: 'Quận 12' }, { ip: '10.1.1.2' });
  assert.equal(answered.error, undefined);
  assert.deepEqual(answered.body, []);
});

test('one caller cannot spend the whole minute’s lookups, and does not spend another’s', async () => {
  const search = lift(mock.fn(async () => ({ ok: true, json: async () => [] })), immediate);

  let last;
  for (let n = 0; n <= 10; n += 1) {
    last = await call(search, { q: `Quận ${n}` }, { ip: '10.0.0.1' });
    /* Every call within the allowance must pass, or the ceiling is not where it claims. */
    if (n < 10) {
      assert.equal(last.error, undefined);
    }
  }
  assert.equal(last.body, undefined);
  assert.equal(last.error.status, 429);
  assert.equal(last.error.code, 'RATE_LIMITED');

  const other = await call(search, { q: 'Bến Nghé' }, { ip: '10.0.0.2' });
  assert.equal(other.error, undefined);
});

test('the same lookup twice asks Nominatim once', async () => {
  const places = [{ lat: '10.7769', lon: '106.7009', display_name: 'Quận 1' }];
  const fetchMock = mock.fn(async () => ({ ok: true, json: async () => places }));
  const search = lift(fetchMock, immediate);

  const first = await call(search, { q: 'Quận 1', limit: '5' });
  const second = await call(search, { q: 'Quận 1', limit: '5' });

  assert.equal(fetchMock.mock.callCount(), 1);
  assert.deepEqual(first.body, places);
  assert.deepEqual(second.body, places);
});

test('a reader who closed the page while queued spends no Nominatim call', async () => {
  const fetchMock = mock.fn(async () => ({ ok: true, json: async () => [] }));
  const search = lift(fetchMock, immediate);

  const answered = await call(search, { q: 'Quận 1' }, { destroyed: true });

  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(answered.body, undefined);
  assert.equal(answered.error, undefined);
});
