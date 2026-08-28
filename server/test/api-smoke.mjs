/*
 * OAK Beauty — API smoke suite (built-in fetch; pg for the test-database reset).
 *
 * Two run modes:
 *
 *   npm test
 *     Resets the Postgres test database named by OAK_TEST_DATABASE_URL (default
 *     postgres://postgres:postgres@localhost:5432/oak_test) — schema dropped and
 *     recreated, citext reinstalled — then spawns `node src/index.js` on port 3199
 *     with DATABASE_URL pointing at it, waits for /api/health, runs every group,
 *     then kills the child. The dev database is never touched.
 *
 *   OAK_TEST_BASE_URL=http://127.0.0.1:3000 node test/api-smoke.mjs
 *     Skips the reset and the spawn and runs against an already-running server. The
 *     database is that server's own, so a re-run reuses whatever the previous one wrote.
 *
 * Every date is derived from the SERVER's notion of today (probed through the
 * assistant parser), never hardcoded.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
// The one offer OAK runs, so the suite spells the code the same way the server does.
import { WELCOME_PERCENT, welcomeCode } from '../src/lib/welcome-promotion.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_PORT = 3199;
const EXTERNAL_URL = process.env.OAK_TEST_BASE_URL;
const BASE_URL = EXTERNAL_URL ?? `http://127.0.0.1:${TEST_PORT}`;
const TEST_DATABASE_URL =
  process.env.OAK_TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/oak_test';

const HEALTH_TIMEOUT_MS = 15000;
const HEALTH_INTERVAL_MS = 200;
const BODY_PREVIEW_CHARS = 300;
/* The account routes/posts.js is told to trust with moderation, handed to the server this
   suite spawns. In external mode the server was started by somebody else, so the blocks
   that need it say so and step around it. */
const ADMIN_EMAIL = 'hoangyen@oak.vn';
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/* ============================================================================
 * Tiny harness: sessions, assertions, groups
 * ========================================================================= */

/** One browser-ish client: keeps its own cookie jar, since fetch() has none. */
class Session {
  #cookies = new Map();

  #capture(response) {
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const separator = pair.indexOf('=');
      if (separator === -1) {
        continue;
      }
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      // clearCookie sends an empty value: dropping it is what makes logout real.
      if (value === '') {
        this.#cookies.delete(name);
      } else {
        this.#cookies.set(name, value);
      }
    }
  }

  /** `json` is serialised for you; anything else is passed straight to fetch. */
  async fetch(pathname, options = {}) {
    const { json, headers, ...rest } = options;
    const requestHeaders = { ...headers };
    if (this.#cookies.size > 0) {
      requestHeaders.Cookie = [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    if (json !== undefined) {
      requestHeaders['Content-Type'] = 'application/json';
      rest.body = JSON.stringify(json);
    }

    const response = await fetch(`${BASE_URL}${pathname}`, { ...rest, headers: requestHeaders });
    this.#capture(response);

    const text = await response.text();
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON (static file, empty body): keep the raw text for the failure preview.
    }
    return { status: response.status, body, contentType: response.headers.get('content-type') };
  }
}

class Failed extends Error {
  constructor(message, response) {
    super(message);
    this.response = response;
  }
}

let assertionCount = 0;
const groupResults = [];
const state = { sessions: {} };

function preview(response) {
  if (!response) {
    return '';
  }
  const body = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
  return `HTTP ${response.status} · ${String(body).slice(0, BODY_PREVIEW_CHARS)}`;
}

function assert(condition, message, response) {
  assertionCount += 1;
  if (!condition) {
    throw new Failed(message, response);
  }
}

/** Assert a success envelope and hand back `data`. */
function ok(response, label) {
  assert(response.status === 200, `${label}: expected HTTP 200`, response);
  assert(response.body?.success === true, `${label}: expected {success:true,data}`, response);
  return response.body.data;
}

/** Assert an error envelope, and its code when the spec names one. */
function expectError(response, status, code, label) {
  assert(response.status === status, `${label}: expected HTTP ${status}`, response);
  assert(response.body?.success === false, `${label}: expected {success:false,error}`, response);
  if (code) {
    assert(response.body?.error?.code === code, `${label}: expected error.code ${code}`, response);
  }
}

async function group(name, run) {
  const before = assertionCount;
  try {
    await run();
    groupResults.push({ name, passed: true });
    console.log(`PASS  ${name}  (${assertionCount - before} assertions)`);
  } catch (error) {
    groupResults.push({ name, passed: false });
    console.log(`FAIL  ${name}  (${assertionCount - before} assertions)`);
    console.log(`      ${error.message}`);
    if (error.response) {
      console.log(`      ${preview(error.response)}`);
    }
    if (!(error instanceof Failed)) {
      console.log(`      ${error.stack?.split('\n').slice(0, 4).join('\n      ')}`);
    }
  }
}

function skip(reason) {
  console.log(`      SKIP  ${reason}`);
}

/** A session established by the auth group; a clear message beats a TypeError. */
function session(key) {
  const found = state.sessions[key];
  if (!found) {
    throw new Error(`session "${key}" is unavailable — the auth group did not complete`);
  }
  return found;
}

/* ============================================================================
 * Date helpers — same local-time arithmetic the server uses
 * ========================================================================= */

function addDays(iso, days) {
  const [year, month, day] = iso.split('-').map(Number);
  const shifted = new Date(year, month - 1, day + days);
  return [
    String(shifted.getFullYear()).padStart(4, '0'),
    String(shifted.getMonth() + 1).padStart(2, '0'),
    String(shifted.getDate()).padStart(2, '0'),
  ].join('-');
}

/** 0 = Sunday .. 6 = Saturday, matching staff_schedule.weekday. */
function weekdayOf(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day).getDay();
}

function hhmm(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * A whole week of opening hours, every day round the clock, with one weekday closed —
 * pass -1 to close none. Round the clock so that whichever hour a test books at, the
 * salon's own hours are never the thing deciding the outcome.
 */
function weekClosedOn(offWeekday) {
  return [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    start: '00:00',
    end: '23:59',
    is_off: weekday === offWeekday ? 1 : 0,
  }));
}

/* ============================================================================
 * Server lifecycle
 * ========================================================================= */

/** Drop and recreate the public schema so the server boots into an empty database.
 * The CASCADE also takes the citext extension's objects with it, so it is reinstalled. */
async function resetDatabase() {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      'DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public;',
    );
    await client.query('CREATE EXTENSION IF NOT EXISTS citext SCHEMA public;');
  } finally {
    await client.end();
  }
}

const childOutput = [];

function spawnServer() {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: serverRoot,
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      DATABASE_URL: TEST_DATABASE_URL,
      // Who may hide a post. An address, not a role: hoangyen@oak.vn is an ordinary
      // customer account, which is what makes the check worth testing.
      ADMIN_EMAILS: ADMIN_EMAIL,
    },
  });
  child.stdout.on('data', (chunk) => childOutput.push(String(chunk)));
  child.stderr.on('data', (chunk) => childOutput.push(String(chunk)));
  return child;
}

async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_INTERVAL_MS));
  }
  throw new Error(
    `server did not answer GET /api/health within ${HEALTH_TIMEOUT_MS}ms\n${childOutput.join('')}`,
  );
}

/* ============================================================================
 * Shared lookups
 * ========================================================================= */

async function login(email) {
  const client = new Session();
  const response = await client.fetch('/api/auth/login', {
    method: 'POST',
    json: { email, password: 'Oak@1234' },
  });
  ok(response, `login ${email}`);
  return { client, user: response.body.data.user };
}

/**
 * The first free (date, time) for ONE service, scanning forward from tomorrow.
 *
 * Every booking now holds a technician, "Bất kỳ" included, so a hardcoded hour is only
 * bookable by luck — the roster and the day of the week decide. Anything in this suite
 * that needs a booking to succeed asks here for the hour to use.
 */
async function findServiceSlot(service, skip = []) {
  const guest = session('guest');
  for (let offset = 1; offset <= 7; offset += 1) {
    const date = addDays(state.today, offset);
    const response = await guest.fetch(`/api/services/${service.id}/availability?date=${date}`);
    for (const slot of response.body?.data?.slots ?? []) {
      const taken = skip.some((one) => one.date === date && one.time === slot.time);
      if (slot.available && !taken) {
        return { date, time: slot.time };
      }
    }
  }
  return null;
}

/** The first (service, date, time) triple that is genuinely bookable, scanning forward. */
async function findBookableSlot(salonId) {
  const guest = session('guest');
  const services = ok(
    await guest.fetch(`/api/services?salon_id=${salonId}&limit=50`),
    'services for slot scan',
  );
  for (const service of services) {
    for (let offset = 1; offset <= 7; offset += 1) {
      const date = addDays(state.today, offset);
      const response = await guest.fetch(`/api/services/${service.id}/availability?date=${date}`);
      const slot = (response.body?.data?.slots ?? []).find((candidate) => candidate.available);
      if (slot) {
        return { service, date, time: slot.time };
      }
    }
  }
  return null;
}

/**
 * The first (service, technician, date, time) that ONE named technician is free for,
 * scanning forward from tomorrow.
 *
 * The week grid is sized by that technician's longest service, so a slot free there is
 * also free for the shorter service returned beside it: the result is a booking that
 * must succeed on its own merits, which is what makes it usable as a control.
 */
async function findStaffBookableSlot(salonId) {
  const guest = session('guest');
  const services = ok(
    await guest.fetch(`/api/services?salon_id=${salonId}&limit=50`),
    'services for the technician slot scan',
  );
  for (const service of services) {
    const performers = (await guest.fetch(`/api/services/${service.id}/staff`)).body?.data ?? [];
    for (const performer of performers) {
      const grid = await guest.fetch(
        `/api/staff/${performer.id}/availability?from=${addDays(state.today, 1)}&days=7`,
      );
      for (const day of grid.body?.data?.week ?? []) {
        const slot = day.slots.find((candidate) => candidate.available);
        if (slot) {
          return { service, staffId: performer.id, date: day.date, time: slot.time };
        }
      }
    }
  }
  return null;
}

/**
 * The first (date, time) at which at least TWO of these staff week grids are free.
 *
 * `grids` is [{ performer, week }] for the performers of one service. A slot with a
 * single free performer is useless to the SLOT_TAKEN check below: there, "is this
 * technician free?" and "is anybody free?" are the same question, so both the correct
 * per-technician rule and the service-wide union answer it identically.
 */
function findSharedSlot(grids) {
  for (const day of grids[0].week) {
    for (const slot of day.slots) {
      const free = grids.filter(({ week }) =>
        week
          .find((entry) => entry.date === day.date)
          ?.slots.some((one) => one.time === slot.time && one.available),
      );
      if (free.length >= 2) {
        return { date: day.date, time: slot.time, performers: free.map((one) => one.performer) };
      }
    }
  }
  return null;
}

/* ============================================================================
 * 1 — health + auth
 * ========================================================================= */

async function groupHealthAuth() {
  const guest = new Session();
  state.sessions.guest = guest;

  const health = ok(await guest.fetch('/api/health'), 'GET /api/health');
  assert(health.status === 'ok', 'health: expected status "ok"');

  const customer = await login('khach@oak.vn');
  const customer2 = await login('hoangyen@oak.vn');
  const partnerA = await login('doitac@oak.vn');
  const partnerB = await login('minhchau@oak.vn');
  state.sessions.customer = customer.client;
  state.sessions.customer2 = customer2.client;
  state.sessions.partnerA = partnerA.client;
  state.sessions.partnerB = partnerB.client;
  state.customerId = customer.user.id;

  assert(customer.user.role === 'customer', 'login khach@oak.vn: expected role customer');
  assert(partnerA.user.role === 'partner', 'login doitac@oak.vn: expected role partner');
  assert(customer.user.password_hash === undefined, 'login: password_hash must never be returned');

  const me = ok(await customer.client.fetch('/api/auth/me'), 'GET /api/auth/me');
  assert(typeof me.user.city === 'string', '/api/auth/me: expected user.city');
  assert(typeof me.user.district === 'string', '/api/auth/me: expected user.district');

  const partnerMe = ok(await partnerA.client.fetch('/api/auth/me'), 'GET /api/auth/me (partner)');
  assert(partnerMe.user.role === 'partner', '/api/auth/me: expected partner role');

  // Logout on a throwaway session, so the shared customer session stays signed in.
  const temporary = (await login('khach@oak.vn')).client;
  ok(await temporary.fetch('/api/auth/logout', { method: 'POST' }), 'POST /api/auth/logout');
  // /api/auth/me is optional-auth: a signed-out probe is a normal 200 {user:null}, not a
  // 401 (which the browser would log as a red console error on every guest page load).
  const anon = ok(await temporary.fetch('/api/auth/me'), 'GET /api/auth/me after logout');
  assert(anon.user === null, 'GET /api/auth/me after logout: user must be null', anon);
}

/* ============================================================================
 * 2 — salons
 * ========================================================================= */

async function groupSalons() {
  const guest = session('guest');

  const listResponse = await guest.fetch('/api/salons?page=1&limit=2');
  const list = ok(listResponse, 'GET /api/salons');
  assert(list.length === 2, 'GET /api/salons?limit=2: expected 2 cards', listResponse);
  assert(listResponse.body.meta.page === 1, 'salons: expected meta.page 1', listResponse);
  assert(listResponse.body.meta.limit === 2, 'salons: expected meta.limit 2', listResponse);
  assert(listResponse.body.meta.total >= 6, 'salons: expected meta.total >= 6', listResponse);
  const [card] = list;
  for (const key of ['id', 'slug', 'name', 'address', 'district', 'image', 'rating', 'review_count', 'price_from']) {
    assert(key in card, `salon card: missing "${key}"`, listResponse);
  }
  assert(
    Array.isArray(card.tags) && card.tags.length > 0,
    'salon card: tags must be a non-empty array',
    listResponse,
  );
  assert(typeof card.verified === 'boolean', 'salon card: verified must be a boolean', listResponse);

  const all = await guest.fetch('/api/salons?limit=50');
  const totalSalons = all.body.meta.total;

  const byName = await guest.fetch('/api/salons?q=Lala');
  const named = ok(byName, 'GET /api/salons?q=Lala');
  assert(named.length > 0, 'salons?q=Lala: expected at least one match', byName);
  assert(
    named.every((item) => item.name.includes('Lala')),
    'salons?q=Lala: every name must contain the term',
    byName,
  );

  const byDistrict = await guest.fetch('/api/salons?district=Qu%E1%BA%ADn%203');
  const district = ok(byDistrict, 'GET /api/salons?district=');
  assert(district.length > 0, 'salons?district=Quận 3: expected a match', byDistrict);
  assert(
    district.every((item) => item.district === 'Quận 3'),
    'salons?district=: every card must be in that district',
    byDistrict,
  );

  const byCategory = await guest.fetch('/api/salons?category=hair');
  const hair = ok(byCategory, 'GET /api/salons?category=hair');
  assert(hair.length > 0, 'salons?category=hair: expected a match', byCategory);

  const featuredResponse = await guest.fetch('/api/salons?featured=1');
  const featured = ok(featuredResponse, 'GET /api/salons?featured=1');
  assert(featured.length > 0, 'salons?featured=1: expected a match', featuredResponse);
  assert(
    featuredResponse.body.meta.total < totalSalons,
    'salons?featured=1: the filter must narrow the list',
    featuredResponse,
  );
  const featuredDetail = ok(
    await guest.fetch(`/api/salons/${featured[0].id}`),
    'featured salon detail',
  );
  assert(featuredDetail.featured === true, 'salons?featured=1: returned a non-featured salon');

  const sortedResponse = await guest.fetch('/api/salons?sort=rating&limit=50');
  const sorted = ok(sortedResponse, 'GET /api/salons?sort=rating');
  // Without this the loop below never runs, and a broken sort would pass unnoticed.
  assert(sorted.length > 1, 'salons?sort=rating: need at least 2 cards to test the order', sortedResponse);
  for (let index = 1; index < sorted.length; index += 1) {
    assert(
      sorted[index - 1].rating >= sorted[index].rating,
      'salons?sort=rating: ratings must be descending',
      sortedResponse,
    );
  }

  const bySlug = ok(await guest.fetch('/api/salons/lala-nail-studio'), 'GET /api/salons/:slug');
  state.lalaId = bySlug.id;
  const byId = ok(await guest.fetch(`/api/salons/${bySlug.id}`), 'GET /api/salons/:id');
  assert(byId.slug === bySlug.slug, 'salon detail: id and slug lookups must agree');
  assert(
    Array.isArray(byId.amenities) && byId.amenities.length > 0,
    'salon detail: amenities must be a non-empty array',
  );
  // Straight off the boot-time backfill: a salon that only ever had the whole-week pair
  // still answers with a full week, every day open on those same hours.
  assert(byId.hours.length === 7, 'salon detail: expected one opening-hours row per weekday');
  assert(
    byId.hours.every((row) => row.is_off === 0 && row.start === byId.open_time && row.end === byId.close_time),
    'salon detail: the backfilled week must mirror the whole-week pair',
  );
  assert(typeof byId.tour_url === 'string', 'salon detail: expected a tour_url on the flagship');
  assert(typeof byId.description === 'string', 'salon detail: expected a description');

  const photosResponse = await guest.fetch(`/api/salons/${state.lalaId}/photos`);
  const photos = ok(photosResponse, 'GET /api/salons/:id/photos');
  assert(photos.length >= 4, 'salon photos: expected at least 4', photosResponse);
  assert('image' in photos[0] && 'caption' in photos[0], 'salon photos: expected image + caption');
  assert(photosResponse.body.meta.total === photos.length, 'salon photos: meta.total must match');

  const servicesResponse = await guest.fetch(`/api/salons/${state.lalaId}/services`);
  const services = ok(servicesResponse, 'GET /api/salons/:id/services');
  assert(services.length > 0, 'salon services: expected a menu', servicesResponse);
  assert(services[0].salon?.id === state.lalaId, 'salon services: expected nested salon block');
  const nailResponse = await guest.fetch(`/api/salons/${state.lalaId}/services?category=nail`);
  const nail = ok(nailResponse, 'GET /api/salons/:id/services?category=nail');
  assert(nail.length > 0, 'salon services?category=nail: expected a match', nailResponse);
  assert(
    nail.every((item) => item.category === 'nail'),
    'salon services?category=nail: every item must be nail',
    nailResponse,
  );

  const staffResponse = await guest.fetch(`/api/salons/${state.lalaId}/staff`);
  const staff = ok(staffResponse, 'GET /api/salons/:id/staff');
  assert(staff.length > 0, 'salon staff: expected active staff', staffResponse);
  assert('years_experience' in staff[0], 'salon staff: expected years_experience');
  state.staffId = staff[0].id;

  const reviewsResponse = await guest.fetch(`/api/salons/${state.lalaId}/reviews`);
  const reviews = ok(reviewsResponse, 'GET /api/salons/:id/reviews');
  const meta = reviewsResponse.body.meta;
  for (const rating of ['5', '4', '3', '2', '1']) {
    assert(rating in meta.breakdown, `salon reviews: meta.breakdown missing "${rating}"`, reviewsResponse);
  }
  assert(typeof meta.average === 'number', 'salon reviews: meta.average must be a number', reviewsResponse);
  assert(reviews.length > 0, 'salon reviews: expected at least one review', reviewsResponse);
  assert('name' in reviews[0].user, 'salon reviews: expected nested user.name');

  expectError(
    await guest.fetch('/api/salons/khong-co-that-999'),
    404,
    'NOT_FOUND',
    'GET /api/salons/:bogusSlug',
  );
}

/* ============================================================================
 * 3 — services
 * ========================================================================= */

async function groupServices() {
  const guest = session('guest');

  const listResponse = await guest.fetch('/api/services?limit=5');
  const list = ok(listResponse, 'GET /api/services');
  assert(list.length === 5, 'GET /api/services?limit=5: expected 5 items', listResponse);
  assert(listResponse.body.meta.total > 5, 'services: expected meta.total', listResponse);
  for (const key of ['id', 'name', 'price', 'price_is_from', 'duration_min', 'category', 'salon']) {
    assert(key in list[0], `service card: missing "${key}"`, listResponse);
  }

  const byCategory = await guest.fetch('/api/services?category=nail');
  const nail = ok(byCategory, 'GET /api/services?category=nail');
  assert(
    nail.length > 0 && nail.every((item) => item.category === 'nail'),
    'services?category=nail: every item must be nail',
    byCategory,
  );

  const bySub = await guest.fetch('/api/services?subcategory=S%C6%A1n%20gel');
  const sub = ok(bySub, 'GET /api/services?subcategory=');
  assert(
    sub.length > 0 && sub.every((item) => item.subcategory === 'Sơn gel'),
    'services?subcategory=: every item must match',
    bySub,
  );

  const bySalon = await guest.fetch(`/api/services?salon_id=${state.lalaId}`);
  const salonServices = ok(bySalon, 'GET /api/services?salon_id=');
  assert(
    salonServices.length > 0 && salonServices.every((item) => item.salon.id === state.lalaId),
    'services?salon_id=: every item must belong to that salon',
    bySalon,
  );

  const featured = ok(await guest.fetch('/api/services?featured=1'), 'GET /api/services?featured=1');
  assert(featured.length > 0, 'services?featured=1: expected a match');

  const packages = ok(await guest.fetch('/api/services?is_package=1'), 'GET /api/services?is_package=1');
  assert(packages.length > 0, 'services?is_package=1: expected a match');

  const priced = await guest.fetch('/api/services?price_min=300000&price_max=500000');
  const inRange = ok(priced, 'GET /api/services?price_min&price_max');
  assert(
    inRange.length > 0 && inRange.every((item) => item.price >= 300000 && item.price <= 500000),
    'services price range: every item must be inside the bounds',
    priced,
  );

  const ascending = await guest.fetch('/api/services?sort=price_asc&limit=50');
  const asc = ok(ascending, 'GET /api/services?sort=price_asc');
  // Without these guards an empty list would satisfy both ordering loops vacuously.
  assert(asc.length > 1, 'sort=price_asc: need at least 2 items to test the order', ascending);
  for (let index = 1; index < asc.length; index += 1) {
    assert(asc[index - 1].price <= asc[index].price, 'sort=price_asc: prices must ascend', ascending);
  }
  const descending = await guest.fetch('/api/services?sort=price_desc&limit=50');
  const desc = ok(descending, 'GET /api/services?sort=price_desc');
  assert(desc.length > 1, 'sort=price_desc: need at least 2 items to test the order', descending);
  for (let index = 1; index < desc.length; index += 1) {
    assert(desc[index - 1].price >= desc[index].price, 'sort=price_desc: prices must descend', descending);
  }
  ok(await guest.fetch('/api/services?sort=popular'), 'GET /api/services?sort=popular');
  ok(await guest.fetch('/api/services?sort=rating'), 'GET /api/services?sort=rating');

  const categoriesResponse = await guest.fetch('/api/services/categories');
  const categories = ok(categoriesResponse, 'GET /api/services/categories');
  assert(Array.isArray(categories), '/api/services/categories: must not be swallowed by /:id', categoriesResponse);
  assert(categories.length === 6, '/api/services/categories: expected 6 categories', categoriesResponse);
  assert(
    categories.every((item) => 'key' in item && 'label' in item && typeof item.count === 'number'),
    '/api/services/categories: expected {key,label,count}',
    categoriesResponse,
  );

  const detail = ok(await guest.fetch(`/api/services/${list[0].id}`), 'GET /api/services/:id');
  assert(detail.id === list[0].id, 'service detail: wrong id');
  assert(typeof detail.salon.rating === 'number', 'service detail: expected salon.rating');
  assert(typeof detail.salon.review_count === 'number', 'service detail: expected salon.review_count');

  const slot = await findBookableSlot(state.lalaId);
  assert(slot !== null, 'availability: no bookable slot found in the next 7 days');
  state.slot = slot;

  const availabilityResponse = await guest.fetch(
    `/api/services/${slot.service.id}/availability?date=${slot.date}`,
  );
  const availability = ok(availabilityResponse, 'GET /api/services/:id/availability');
  assert(availability.date === slot.date, 'availability: echoed date must match', availabilityResponse);
  assert(availability.slots.length > 0, 'availability: expected a non-empty slots array', availabilityResponse);
  assert(
    availability.slots.some((entry) => entry.available === true),
    'availability: expected at least one available slot',
    availabilityResponse,
  );

  expectError(
    await guest.fetch(`/api/services/${slot.service.id}/availability`),
    400,
    'VALIDATION_ERROR',
    'availability without ?date',
  );
  expectError(
    await guest.fetch(`/api/services/${slot.service.id}/availability?date=12-08-2026`),
    400,
    'VALIDATION_ERROR',
    'availability with a malformed ?date',
  );

  const serviceStaffResponse = await guest.fetch(`/api/services/${slot.service.id}/staff`);
  const serviceStaff = ok(serviceStaffResponse, 'GET /api/services/:id/staff');
  assert(serviceStaff.length > 0, 'service staff: expected performers', serviceStaffResponse);
}

/* ============================================================================
 * 4 — staff
 * ========================================================================= */

async function groupStaff() {
  const guest = session('guest');

  const profile = ok(await guest.fetch(`/api/staff/${state.staffId}`), 'GET /api/staff/:id');
  assert(
    Array.isArray(profile.portfolio) && profile.portfolio.length > 0,
    'staff profile: portfolio must be a non-empty array',
  );
  assert(profile.salon?.id === state.lalaId, 'staff profile: expected nested salon block');
  assert(typeof profile.years_experience === 'number', 'staff profile: expected years_experience');

  const weekResponse = await guest.fetch(
    `/api/staff/${state.staffId}/availability?from=${state.today}&days=7`,
  );
  const week = ok(weekResponse, 'GET /api/staff/:id/availability');
  assert(week.week.length === 7, 'staff availability: expected 7 day entries', weekResponse);
  assert(week.week[0].date === state.today, 'staff availability: first day must be `from`', weekResponse);
  assert(
    week.week.every((day) => Array.isArray(day.slots)),
    'staff availability: every day needs a slots array',
    weekResponse,
  );

  // Both directions, so a grid that is empty everywhere and one that is full
  // everywhere each fail: a working day must carry slots, and nobody in the seed
  // works Sunday (there is no weekday-0 schedule row at all).
  const working = week.week.filter((day) => day.slots.length > 0);
  assert(working.length > 0, 'staff availability: expected at least one day with slots', weekResponse);
  assert(
    working[0].slots.every(
      (slot) => /^\d{2}:\d{2}$/.test(slot.time) && typeof slot.available === 'boolean',
    ),
    'staff availability: every slot needs an HH:MM time and a boolean available',
    weekResponse,
  );
  const sunday = week.week.find((day) => weekdayOf(day.date) === 0);
  assert(sunday !== undefined, 'staff availability: a 7-day window must contain a Sunday', weekResponse);
  assert(
    sunday.slots.length === 0,
    'staff availability: nobody works Sunday, so it must have zero slots',
    weekResponse,
  );

  const reviewsResponse = await guest.fetch(`/api/staff/${state.staffId}/reviews`);
  ok(reviewsResponse, 'GET /api/staff/:id/reviews');
  assert(typeof reviewsResponse.body.meta.average === 'number', 'staff reviews: expected meta.average', reviewsResponse);
  assert(typeof reviewsResponse.body.meta.total === 'number', 'staff reviews: expected meta.total', reviewsResponse);

  // The specialist page's service chips resize the week grid, so they need this technician's
  // own menu — not the salon's — and every field the chip and the deep link are built from.
  const staffServicesResponse = await guest.fetch(`/api/staff/${state.staffId}/services`);
  const staffServices = ok(staffServicesResponse, 'GET /api/staff/:id/services');
  assert(staffServices.length > 0, 'staff services: expected a menu', staffServicesResponse);
  for (const key of ['id', 'name', 'price', 'price_is_from', 'duration_min', 'category']) {
    assert(key in staffServices[0], `staff services: item missing ${key}`, staffServicesResponse);
  }
  assert(
    typeof staffServices[0].price_is_from === 'boolean',
    'staff services: price_is_from must be a boolean',
    staffServicesResponse,
  );
  assert(
    staffServicesResponse.body.meta.total === staffServices.length,
    'staff services: meta.total must match the page',
    staffServicesResponse,
  );
  expectError(
    await guest.fetch('/api/staff/999999/services'),
    404,
    'NOT_FOUND',
    'GET /api/staff/:bogusId/services',
  );
}

/* ============================================================================
 * 5 — search
 * ========================================================================= */

async function groupSearch() {
  const guest = session('guest');
  const tomorrow = addDays(state.today, 1);
  // Nobody works Sunday, so every salon would be "hết lịch" that day and the
  // availability assertion below could not tell a real signal from a broken one.
  const slotDate = weekdayOf(tomorrow) === 0 ? addDays(state.today, 2) : tomorrow;

  const locatedResponse = await guest.fetch(
    `/api/search/salons?lat=10.77&lng=106.70&date=${slotDate}&time_from=13:00&time_to=17:00`,
  );
  const located = ok(locatedResponse, 'GET /api/search/salons (with lat/lng)');
  assert(located.length > 0, 'search: expected results', locatedResponse);
  assert(typeof locatedResponse.body.meta.total === 'number', 'search: expected meta.total', locatedResponse);
  const [hit] = located;
  assert(typeof hit.distance_km === 'number', 'search: distance_km must be a number when lat/lng given', locatedResponse);
  assert(
    typeof hit.match_reason === 'string' && hit.match_reason.length > 0,
    'search: match_reason must be a non-empty string',
    locatedResponse,
  );
  assert('availability' in hit, 'search: availability must be present when a date is given', locatedResponse);
  // The key alone is satisfied by `false`, which is what a broken hasSlotsInRange
  // returns for every salon; at least one salon really does have an afternoon slot.
  assert(
    located.some((item) => item.availability === true),
    'search: expected at least one salon flagged as still having slots',
    locatedResponse,
  );

  const plainResponse = await guest.fetch('/api/search/salons?q=nail');
  const plain = ok(plainResponse, 'GET /api/search/salons (no lat/lng)');
  assert(plain.length > 0, 'search without coordinates: expected results', plainResponse);
  assert(plain[0].distance_km === null, 'search without coordinates: distance_km must be null', plainResponse);
  assert(
    typeof plain[0].match_reason === 'string' && plain[0].match_reason.length > 0,
    'search without coordinates: match_reason must still be non-empty',
    plainResponse,
  );

  /* Unaccented search. Vietnamese keyboards are the exception on a phone, so the plain
     ASCII spelling has to find the accented row — the whole point of matching in JS
     instead of leaving q to a diacritic-sensitive ILIKE. */
  const idsOf = (rows) => rows.map((row) => row.id).sort((a, b) => a - b);

  const bareResponse = await guest.fetch(`/api/search/salons?q=${encodeURIComponent('noi mi')}`);
  const bare = ok(bareResponse, "GET /api/search/salons?q=noi mi");
  assert(bare.length > 0, "search 'noi mi': expected at least one salon", bareResponse);

  const accentedResponse = await guest.fetch(`/api/search/salons?q=${encodeURIComponent('nối mi')}`);
  const accented = ok(accentedResponse, "GET /api/search/salons?q=nối mi");
  assert(
    JSON.stringify(idsOf(accented)) === JSON.stringify(idsOf(bare)),
    "search: 'nối mi' and 'noi mi' must return the same salons",
    accentedResponse,
  );

  // No salon and no service is called "làm", so this one survives on 'nail' alone —
  // the partial-match tier, without which the commonest phrasing returns nothing.
  const partialResponse = await guest.fetch(`/api/search/salons?q=${encodeURIComponent('lam nail')}`);
  const partial = ok(partialResponse, "GET /api/search/salons?q=lam nail");
  assert(partial.length > 0, "search 'lam nail': expected at least one salon", partialResponse);

  const districtResponse = await guest.fetch(`/api/search/salons?q=${encodeURIComponent('quan 1')}`);
  const byDistrict = ok(districtResponse, "GET /api/search/salons?q=quan 1");
  assert(byDistrict.length > 0, "search 'quan 1': expected at least one salon", districtResponse);
  // A digits-only word has to be a whole word: 'quan 1' is not Quận 10, 11 or 12.
  assert(
    byDistrict.every((item) => item.district === 'Quận 1'),
    "search 'quan 1': every result must be in Quận 1",
    districtResponse,
  );

  // Four words, and only the Quận 3 salons match all four: the weaker tier is dropped
  // rather than padding the page under the real answer.
  const tierResponse = await guest.fetch(
    `/api/search/salons?q=${encodeURIComponent('noi mi quan 3')}`,
  );
  const tier = ok(tierResponse, "GET /api/search/salons?q=noi mi quan 3");
  assert(tier.length > 0, "search 'noi mi quan 3': expected at least one salon", tierResponse);
  assert(
    tier.every((item) => item.district === 'Quận 3'),
    "search 'noi mi quan 3': the best tier matched the district too",
    tierResponse,
  );

  const junkSearchResponse = await guest.fetch('/api/search/salons?q=zzzz');
  const junkSearch = ok(junkSearchResponse, 'GET /api/search/salons?q=zzzz');
  assert(junkSearch.length === 0, 'search: nonsense must return no salons', junkSearchResponse);
  assert(
    junkSearchResponse.body.meta.total === 0,
    'search: nonsense must report meta.total 0',
    junkSearchResponse,
  );

  // style is free text over one service's subcategory and name, and reads unaccented too.
  const styleResponse = await guest.fetch(`/api/search/salons?style=${encodeURIComponent('noi mi')}`);
  const styled = ok(styleResponse, "GET /api/search/salons?style=noi mi");
  assert(styled.length > 0, "search style 'noi mi': expected at least one salon", styleResponse);

  // A style has to sit in one service: 'Sơn gel' plus 'Nối mi' is not a "sơn mi".
  const splitStyleResponse = await guest.fetch(
    `/api/search/salons?style=${encodeURIComponent('son mi')}`,
  );
  const splitStyle = ok(splitStyleResponse, "GET /api/search/salons?style=son mi");
  assert(
    splitStyle.length === 0,
    "search style 'son mi': a style pieced together from two services is not a match",
    splitStyleResponse,
  );

  // The wizard's salon picker answers the same way, over the salon name.
  const pickerResponse = await guest.fetch('/api/salons?q=lala');
  const picker = ok(pickerResponse, 'GET /api/salons?q=lala');
  assert(picker.length > 0, "salons 'lala': expected at least one salon", pickerResponse);

  const pickerJunkResponse = await guest.fetch('/api/salons?q=zzzz');
  const pickerJunk = ok(pickerJunkResponse, 'GET /api/salons?q=zzzz');
  assert(pickerJunk.length === 0, 'salons: nonsense must return no salons', pickerJunkResponse);
  assert(
    pickerJunkResponse.body.meta.total === 0,
    'salons: nonsense must report meta.total 0',
    pickerJunkResponse,
  );

  const assistantResponse = await guest.fetch('/api/search/assistant', {
    method: 'POST',
    json: { message: 'nail gel Quận 1 chiều mai dưới 500k' },
  });
  const assistant = ok(assistantResponse, 'POST /api/search/assistant');
  const criteria = assistant.criteria;
  assert(criteria.category === 'nail', 'assistant: expected category "nail"', assistantResponse);
  assert(criteria.district === 'Quận 1', 'assistant: expected district "Quận 1"', assistantResponse);
  assert(criteria.price_max === 500000, 'assistant: expected price_max 500000', assistantResponse);
  assert(criteria.budget === 500000, 'assistant: expected budget 500000', assistantResponse);
  assert(criteria.date === tomorrow, `assistant: expected date ${tomorrow}`, assistantResponse);
  assert(criteria.time_from === '13:00', 'assistant: expected time_from 13:00 (chiều)', assistantResponse);
  assert(criteria.time_to === '17:00', 'assistant: expected time_to 17:00 (chiều)', assistantResponse);
  assert(
    typeof assistant.reply === 'string' && assistant.reply.length > 0,
    'assistant: expected a natural-language reply',
    assistantResponse,
  );
  assert(
    Array.isArray(assistant.chips) && assistant.chips.length > 0 && assistant.chips.length <= 3,
    'assistant: expected 1-3 refinement chips',
    assistantResponse,
  );

  const mergedResponse = await guest.fetch('/api/search/assistant', {
    method: 'POST',
    json: { message: 'tối nay', criteria: { rating_min: 4.5, radius_km: 3 } },
  });
  const merged = ok(mergedResponse, 'POST /api/search/assistant (merge)');
  assert(merged.criteria.rating_min === 4.5, 'assistant merge: rating_min must survive', mergedResponse);
  assert(merged.criteria.radius_km === 3, 'assistant merge: radius_km must survive', mergedResponse);
  assert(merged.criteria.time_from === '17:00', 'assistant merge: expected the tối window', mergedResponse);

  // Criteria come straight back from the client, so a value of the wrong type must be
  // dropped rather than reaching the reply builder's date/time formatting.
  const junkResponse = await guest.fetch('/api/search/assistant', {
    method: 'POST',
    json: { message: 'nail', criteria: { date: 5, time_from: 7, price_max: 'nhiều', category: {} } },
  });
  const junk = ok(junkResponse, 'POST /api/search/assistant with malformed criteria');
  assert(
    typeof junk.reply === 'string' && junk.reply.length > 0,
    'assistant: malformed criteria must still produce a reply, never a 500',
    junkResponse,
  );
  assert(junk.criteria.date === undefined, 'assistant: a malformed date must not be echoed back', junkResponse);

  const suggestionsResponse = await guest.fetch('/api/search/suggestions');
  const suggestions = ok(suggestionsResponse, 'GET /api/search/suggestions');
  assert(
    suggestions.chips.length >= 3 && suggestions.chips.length <= 5,
    'suggestions: expected 3-5 chips',
    suggestionsResponse,
  );
  // Each chip carries what it filters by, not only what it reads as: the label
  // "Spa & Massage" matches no salon or service name, so as a keyword it lands on an
  // empty page and as a category it lands on every spa.
  assert(
    suggestions.chips.every(
      (chip) =>
        typeof chip.label === 'string' &&
        chip.label.length > 0 &&
        (chip.type === 'category' || chip.type === 'district') &&
        typeof chip.key === 'string' &&
        chip.key.length > 0,
    ),
    'suggestions: every chip must carry {label, type, key}',
    suggestionsResponse,
  );
  const categoryChip = suggestions.chips.find((chip) => chip.type === 'category');
  assert(categoryChip !== undefined, 'suggestions: expected at least one category chip', suggestionsResponse);
  const chipHitResponse = await guest.fetch(
    `/api/search/salons?category=${encodeURIComponent(categoryChip.key)}`,
  );
  const chipHit = ok(chipHitResponse, 'GET /api/search/salons?category=<chip>');
  assert(chipHit.length > 0, 'suggestions: a chip must lead to results, never an empty page', chipHitResponse);

  /* The card carries the service the search matched, so the booking link can open the
     wizard on it — and the "from" price is that service's price rather than the cheapest
     thing in the salon, which on a nail search used to quote a facial. */
  const BUDGET = 300000;
  const nailResponse = await guest.fetch(`/api/search/salons?category=nail&price_max=${BUDGET}`);
  const nails = ok(nailResponse, 'GET /api/search/salons?category=nail&price_max=300000');
  assert(nails.length > 0, 'category+price: expected at least one salon', nailResponse);
  for (const salon of nails) {
    assert(
      salon.matched_service !== null && salon.matched_service.category === 'nail',
      'category+price: every card must carry the nail service it matched',
      nailResponse,
    );
    assert(
      salon.matched_service.price <= BUDGET,
      'category+price: the matched nail service must be inside the budget',
      nailResponse,
    );
    assert(
      salon.price_from === salon.matched_service.price,
      'category+price: price_from must quote the matched service',
      nailResponse,
    );
    // The card and the map pin quote this number; without the label beside it they would
    // word it as the salon's opening price, which it no longer is.
    assert(
      salon.price_from_label ===
        `Nail từ ${String(salon.price_from).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}đ`,
      'category+price: price_from_label must name the category the price belongs to',
      nailResponse,
    );
    assert(
      Number.isInteger(salon.matched_service.id) && typeof salon.matched_service.name === 'string',
      'category+price: matched_service needs the id the wizard opens on',
      nailResponse,
    );
  }

  // The budget belongs to the category asked for: a salon whose facials are inside it and
  // whose nails are not is not an answer to "nail under 300.000đ".
  const everySalonResponse = await guest.fetch('/api/salons?limit=50');
  const everySalon = ok(everySalonResponse, 'GET /api/salons?limit=50');
  let missedByCategory = 0;
  for (const salon of everySalon) {
    const servicesResponse = await guest.fetch(`/api/services?salon_id=${salon.id}&limit=50`);
    const services = ok(servicesResponse, `GET /api/services?salon_id=${salon.id}`);
    const cheapest = (rows) => rows.reduce((low, row) => Math.min(low, row.price), Infinity);
    const cheapestNail = cheapest(services.filter((service) => service.category === 'nail'));
    const cheapestElse = cheapest(
      services.filter((service) => service.category !== 'nail' && service.category !== 'amenity'),
    );
    const listed = nails.some((item) => item.id === salon.id);
    assert(
      listed === (cheapestNail <= BUDGET),
      `category+price: salon ${salon.id} is ${listed ? '' : 'not '}listed but its cheapest nail is ${cheapestNail}`,
      nailResponse,
    );
    if (cheapestNail > BUDGET && cheapestElse <= BUDGET) {
      missedByCategory += 1;
    }
  }
  // Without one such salon the assertion above would hold on any implementation, including
  // the one that read the budget against every category at once.
  assert(
    missedByCategory > 0,
    'category+price: the seed must hold a salon that is inside the budget in another category',
    everySalonResponse,
  );

  // A bare keyword cannot narrow the budget in SQL — the EXISTS there asks whether the salon
  // sells anything cheap enough — so the JS pass has to hold it against the service the card
  // goes on to quote. Without it "nail dưới 200.000đ" answers with a 450.000đ nail art.
  const KEYWORD_BUDGET = 350000;
  const keywordResponse = await guest.fetch(`/api/search/salons?q=massage&price_max=${KEYWORD_BUDGET}`);
  const keyword = ok(keywordResponse, 'GET /api/search/salons?q=massage&price_max=350000');
  assert(keyword.length > 0, 'keyword+price: expected at least one salon', keywordResponse);
  for (const salon of keyword) {
    assert(
      salon.price_from <= KEYWORD_BUDGET,
      `keyword+price: salon ${salon.id} quotes ${salon.price_from}, above the budget asked for`,
      keywordResponse,
    );
  }
  // Without a salon the budget drops, the loop above would hold on any implementation —
  // including the one that read the budget against every category at once.
  const keywordAllResponse = await guest.fetch('/api/search/salons?q=massage');
  const keywordAll = ok(keywordAllResponse, 'GET /api/search/salons?q=massage');
  assert(
    keywordAll.length > keyword.length,
    'keyword+price: the budget must drop a salon whose matched massage is over it',
    keywordAllResponse,
  );

  // The second page of a search, which is what "Tải thêm" asks for.
  const firstPageResponse = await guest.fetch('/api/search/salons?limit=2&page=1');
  const firstPage = ok(firstPageResponse, 'GET /api/search/salons?limit=2&page=1');
  const secondPageResponse = await guest.fetch('/api/search/salons?limit=2&page=2');
  const secondPage = ok(secondPageResponse, 'GET /api/search/salons?limit=2&page=2');
  assert(
    firstPageResponse.body.meta.total === secondPageResponse.body.meta.total,
    'paging: the total must not move between pages',
    secondPageResponse,
  );
  assert(
    firstPage.every((salon) => !secondPage.some((item) => item.id === salon.id)),
    'paging: the second page must hold none of the first',
    secondPageResponse,
  );
}

/* ============================================================================
 * 6 — bookings
 * ========================================================================= */

async function groupBookings() {
  const customer = session('customer');
  const guest = session('guest');
  const partner = session('partnerA');
  const { service, date, time } = state.slot;

  // POST /api/bookings now refuses an hour the salon is shut, and the cancel-window case
  // below books 30 minutes from now — whatever time of day the suite runs at. Lala's own
  // 09:00-21:00 would make that clock-dependent, so the week is opened round the clock
  // for this group and put back at the end. The hours rule gets its own tests below.
  const salonHours = ok(
    await partner.fetch('/api/partner/salon'),
    'the salon hours the booking group starts from',
  ).hours;
  ok(
    await partner.fetch('/api/partner/salon', { method: 'PATCH', json: { hours: weekClosedOn(-1) } }),
    'PATCH /api/partner/salon (round the clock for the booking group)',
  );

  const quoteResponse = await customer.fetch(`/api/bookings/quote?service_id=${service.id}`);
  const quote = ok(quoteResponse, 'GET /api/bookings/quote');
  assert(quote.items.length > 0, 'quote: expected line items', quoteResponse);
  assert(quote.total === service.price, 'quote: total must equal the service price', quoteResponse);

  // The salon's own welcome code — the only offer on the platform — spent at that salon.
  const welcome = welcomeCode(state.lalaId);
  const promoResponse = await customer.fetch(
    `/api/bookings/quote?service_id=${service.id}&promotion_code=${welcome}`,
  );
  const promoQuote = ok(promoResponse, `GET /api/bookings/quote?promotion_code=${welcome}`);
  const discountLine = promoQuote.items.find((item) => item.amount < 0);
  assert(discountLine !== undefined, 'quote with promo: expected a negative discount line', promoResponse);
  const expectedDiscount = Math.floor((service.price * WELCOME_PERCENT) / 100);
  assert(discountLine.amount === -expectedDiscount, 'quote with promo: discount must be 20% of the price', promoResponse);
  assert(promoQuote.total === service.price - expectedDiscount, 'quote with promo: total must be base - 20%', promoResponse);

  const createResponse = await customer.fetch('/api/bookings', {
    method: 'POST',
    json: {
      salon_id: state.lalaId,
      service_id: service.id,
      date,
      time,
      note: 'Smoke test booking',
      // Deliberately bogus: the server must price the booking itself.
      total_price: 1,
    },
  });
  const created = ok(createResponse, 'POST /api/bookings');
  assert(/^OAK-[A-Z0-9]{6}$/.test(created.code), 'booking create: code must match OAK-XXXXXX', createResponse);
  assert(created.total_price === service.price, 'booking create: client total_price must be ignored', createResponse);
  // Lala takes bookings automatically (salons.auto_confirm defaults to 1), so the hour its
  // own calendar offered is confirmed on the spot. The salon that turned that off is
  // covered in the online-booking-settings block below.
  assert(created.status === 'confirmed', 'booking create: expected status confirmed', createResponse);
  state.bookingId = created.id;

  const detail = ok(await customer.fetch(`/api/bookings/${created.id}`), 'GET /api/bookings/:id');
  assert(detail.note === 'Smoke test booking', 'booking detail: expected the note back');
  assert(detail.payment_method === 'at_salon', 'booking detail: expected payment_method');
  assert('lat' in detail.salon && 'lng' in detail.salon, 'booking detail: expected salon lat/lng');

  const mineResponse = await customer.fetch('/api/bookings/mine?status=upcoming');
  const mine = ok(mineResponse, 'GET /api/bookings/mine?status=upcoming');
  assert(
    mine.some((item) => item.id === created.id),
    'bookings/mine?status=upcoming: must contain the new booking',
    mineResponse,
  );
  assert(
    mine.every((item) => item.date >= state.today && ['pending', 'confirmed'].includes(item.status)),
    'bookings/mine?status=upcoming: every item must be a future pending/confirmed booking',
    mineResponse,
  );

  // "constructor" is an inherited Object member, not a filter: it must fall back to the
  // unfiltered list instead of putting `undefined` into the WHERE clause.
  const inherited = await customer.fetch('/api/bookings/mine?status=constructor');
  const inheritedList = ok(inherited, 'GET /api/bookings/mine?status=constructor');
  assert(Array.isArray(inheritedList), 'bookings/mine: an unknown status must list everything', inherited);

  // A repeated query parameter arrives as an array; .trim() on it used to throw a 500.
  expectError(
    await customer.fetch(`/api/bookings/quote?service_id=${service.id}&promotion_code=a&promotion_code=b`),
    400,
    'VALIDATION_ERROR',
    'GET /api/bookings/quote with a repeated promotion_code',
  );

  expectError(
    await session('customer2').fetch(`/api/bookings/${created.id}`),
    403,
    'FORBIDDEN',
    'another customer fetching this booking',
  );
  expectError(await guest.fetch('/api/bookings/mine'), 401, 'UNAUTHENTICATED', 'guest GET /api/bookings/mine');

  expectError(
    await customer.fetch('/api/bookings', {
      method: 'POST',
      json: { salon_id: state.lalaId, service_id: service.id, date: addDays(state.today, -1), time: '10:00' },
    }),
    400,
    'VALIDATION_ERROR',
    'POST /api/bookings with a past date',
  );

  expectError(
    await customer.fetch(`/api/bookings/${created.id}/cancel`, {
      method: 'PATCH',
      json: { reason: 'x'.repeat(201) },
    }),
    400,
    'VALIDATION_ERROR',
    'PATCH /api/bookings/:id/cancel with a reason past the 200-character ceiling',
  );

  const beforeCancel = ok(
    await customer.fetch('/api/notifications?count_only=true'),
    'unread count before cancel',
  ).unread_count;
  const cancelled = ok(
    await customer.fetch(`/api/bookings/${created.id}/cancel`, {
      method: 'PATCH',
      json: { reason: 'Bận việc đột xuất' },
    }),
    'PATCH /api/bookings/:id/cancel',
  );
  assert(cancelled.status === 'cancelled', 'cancel: expected status cancelled');
  const afterCancel = ok(
    await customer.fetch('/api/notifications?count_only=true'),
    'unread count after cancel',
  ).unread_count;
  assert(afterCancel === beforeCancel + 1, 'cancel: expected one new notification');

  // Clamped to 23:59 so the booking is always less than the 2h window away, whatever
  // time of day the suite runs at — no clock-dependent SKIP is needed here.
  //
  // Booked on a slot that is genuinely free and MOVED onto that hour by the salon, not
  // created on it: a customer booking now reserves a technician even when it names none,
  // so an arbitrary minute of today — an hour nobody is rostered for, or a Sunday — is
  // exactly what POST refuses. Only the salon may put a booking on such an hour.
  const now = new Date();
  const soon = hhmm(Math.min(now.getHours() * 60 + now.getMinutes() + 30, 23 * 60 + 59));
  const imminentSlot = await findServiceSlot(service);
  assert(imminentSlot !== null, 'cancel-window case: needed a free slot to book first');
  const imminent = ok(
    await customer.fetch('/api/bookings', {
      method: 'POST',
      json: {
        salon_id: state.lalaId,
        service_id: service.id,
        date: imminentSlot.date,
        time: imminentSlot.time,
      },
    }),
    'POST /api/bookings (cancel-window case)',
  );
  ok(
    await partner.fetch(`/api/partner/bookings/${imminent.id}`, {
      method: 'PATCH',
      json: { date: state.today, time: soon },
    }),
    'PATCH /api/partner/bookings/:id (move it inside the cancel window)',
  );
  const windowResponse = await customer.fetch(`/api/bookings/${imminent.id}/cancel`, {
    method: 'PATCH',
  });
  expectError(windowResponse, 409, 'CANCEL_WINDOW', 'cancelling less than 2h before the start');
  assert(
    windowResponse.body?.error?.message.includes('2 tiếng'),
    'cancel window: the message must name the cutoff this salon set',
    windowResponse,
  );

  // A booking that names a technician must be checked against THAT technician's own
  // calendar. Availability for a service ORs across everyone who performs it, so it
  // answers "is somebody free?" — using it here let two customers take the same person.
  //
  // The slot is chosen at run time so that TWO performers of the service are free at the
  // same moment, because that is the only shape of slot where the two rules disagree.
  // Both directions are then asserted: taking X again must be refused, and taking the
  // still-free Y must be allowed — the second half is what stops an over-eager fix that
  // blocks the whole slot for everybody from passing.
  const roster = ok(
    await guest.fetch(`/api/salons/${state.lalaId}/staff`),
    'salon roster for the technician checks',
  );
  const salonServices = ok(
    await guest.fetch(`/api/services?salon_id=${state.lalaId}&limit=50`),
    'salon menu for the technician checks',
  );

  let chosen = null;
  for (const candidate of salonServices) {
    const performers = ok(
      await guest.fetch(`/api/services/${candidate.id}/staff`),
      `GET /api/services/${candidate.id}/staff`,
    );
    const outsider = roster.find((member) => !performers.some((one) => one.id === member.id));
    if (performers.length < 2 || !outsider) {
      continue;
    }

    // The week grid is sized by each technician's LONGEST service, so a slot free there
    // is certainly free for this one — a safe way to pick a genuinely bookable time.
    const grids = [];
    for (const performer of performers) {
      const week = ok(
        await guest.fetch(`/api/staff/${performer.id}/availability?from=${addDays(state.today, 1)}&days=7`),
        `week grid for ${performer.name}`,
      ).week;
      grids.push({ performer, week });
    }

    const shared = findSharedSlot(grids);
    if (shared) {
      chosen = { service: candidate, outsider, ...shared };
      break;
    }
  }
  assert(
    chosen !== null,
    'technician booking: needed a (date, time) where two performers of one salon service are BOTH free — without one, SLOT_TAKEN cannot tell the per-technician rule from the service-wide union and this check proves nothing',
  );

  const [performerX, performerY] = chosen.performers;
  const withStaff = {
    salon_id: state.lalaId,
    service_id: chosen.service.id,
    staff_id: performerX.id,
    date: chosen.date,
    time: chosen.time,
  };
  const staffBooking = ok(
    await customer.fetch('/api/bookings', { method: 'POST', json: withStaff }),
    'POST /api/bookings naming a technician',
  );
  assert(
    staffBooking.staff?.id === performerX.id,
    'booking with a technician: expected them echoed back',
  );

  // Under-blocking: the service still has a free performer (Y), so a service-wide
  // availability check would wave this through and hand X to two customers at once.
  expectError(
    await session('customer2').fetch('/api/bookings', { method: 'POST', json: withStaff }),
    409,
    'SLOT_TAKEN',
    'a second customer taking the same technician, service, date and time',
  );

  // Over-blocking, the opposite failure: X being busy must not close the slot for Y.
  const otherStaffBooking = ok(
    await session('customer2').fetch('/api/bookings', {
      method: 'POST',
      json: { ...withStaff, staff_id: performerY.id },
    }),
    'a second customer taking a different, still-free technician at that same date and time',
  );
  assert(
    otherStaffBooking.staff?.id === performerY.id,
    'booking a free technician at a taken slot: expected them echoed back',
  );

  // The same slot, but a technician of this salon who does not perform the service:
  // rejected on the staff_services rule, before the calendar is consulted.
  expectError(
    await customer.fetch('/api/bookings', {
      method: 'POST',
      json: { ...withStaff, staff_id: chosen.outsider.id },
    }),
    400,
    'VALIDATION_ERROR',
    'booking a technician who does not perform the chosen service',
  );

  // "Bất kỳ" — a booking that names no technician — still holds one. The slot is one
  // where a known set of performers is free, so the number of anonymous bookings it can
  // absorb is exactly the size of that set: each must land on a different person, the
  // one past the set is refused, and naming somebody already assigned is refused too.
  const anonGrids = [];
  for (const performer of ok(
    await guest.fetch(`/api/services/${chosen.service.id}/staff`),
    'performers for the auto-assign check',
  )) {
    anonGrids.push({
      performer,
      week: ok(
        await guest.fetch(
          // Sized by the service actually being booked, not by the technician's longest
          // one, so the free set here is the set pickAvailableStaff() chooses from.
          `/api/staff/${performer.id}/availability?from=${addDays(state.today, 1)}&days=7` +
            `&service_id=${chosen.service.id}`,
        ),
        `week grid for ${performer.name} (auto-assign)`,
      ).week,
    });
  }
  const anonSlot = findSharedSlot(anonGrids);
  assert(
    anonSlot !== null,
    'auto-assign: needed an hour where at least two performers of one service are free',
  );
  const anonBody = {
    salon_id: state.lalaId,
    service_id: chosen.service.id,
    date: anonSlot.date,
    time: anonSlot.time,
  };

  const assigned = [];
  for (const performer of anonSlot.performers) {
    const response = await customer.fetch('/api/bookings', { method: 'POST', json: anonBody });
    const anonymous = ok(response, `POST /api/bookings without a technician (${performer.name}'s turn)`);
    assert(
      anonymous.staff?.name,
      'booking without a technician: the assigned technician must be named back',
      response,
    );
    assert(
      !assigned.includes(anonymous.staff.id),
      'two "Bất kỳ" bookings at the same hour must land on different technicians',
      response,
    );
    assigned.push(anonymous.staff.id);
  }

  expectError(
    await customer.fetch('/api/bookings', { method: 'POST', json: anonBody }),
    409,
    'SLOT_TAKEN',
    'a "Bất kỳ" booking once every free technician of that hour has been assigned',
  );
  expectError(
    await customer.fetch('/api/bookings', {
      method: 'POST',
      json: { ...anonBody, staff_id: assigned[0] },
    }),
    409,
    'SLOT_TAKEN',
    'naming the technician a "Bất kỳ" booking was assigned to, at that same hour',
  );

  // A day the salon declared closed is refused before any calendar is consulted, and the
  // message must say the salon is shut rather than that somebody took the hour. The slot
  // is read off the grid while the day is still open, so the only thing that changes
  // between the refusal and the control below it is the salon's own hours.
  const openSlot = await findServiceSlot(service);
  assert(openSlot !== null, 'opening-hours check: needed a free slot to close the day on');
  const hoursDate = openSlot.date;
  const hoursWeekday = weekdayOf(hoursDate);
  const walkIn = {
    salon_id: state.lalaId,
    service_id: service.id,
    date: hoursDate,
    time: openSlot.time,
  };

  ok(
    await partner.fetch('/api/partner/salon', {
      method: 'PATCH',
      json: { hours: weekClosedOn(hoursWeekday) },
    }),
    'PATCH /api/partner/salon (closing that weekday)',
  );
  expectError(
    await customer.fetch('/api/bookings', { method: 'POST', json: walkIn }),
    400,
    'VALIDATION_ERROR',
    'POST /api/bookings without a technician on a day the salon declared closed',
  );
  ok(
    await partner.fetch('/api/partner/salon', { method: 'PATCH', json: { hours: weekClosedOn(-1) } }),
    'PATCH /api/partner/salon (reopening that weekday)',
  );
  ok(
    await customer.fetch('/api/bookings', { method: 'POST', json: walkIn }),
    'POST /api/bookings without a technician once that day is open',
  );

  // The far edge of the window: the service has to FINISH by closing time, not merely
  // start before it. One minute past the last legal start is the whole difference.
  assert(
    service.duration_min <= 6 * 60,
    'closing-time check: needed a service that fits inside the 08:00-14:00 window',
  );
  ok(
    await partner.fetch('/api/partner/salon', {
      method: 'PATCH',
      json: {
        hours: weekClosedOn(-1).map((day) =>
          day.weekday === hoursWeekday ? { ...day, start: '08:00', end: '14:00' } : day,
        ),
      },
    }),
    'PATCH /api/partner/salon (an 08:00-14:00 window on that day)',
  );
  expectError(
    await customer.fetch('/api/bookings', {
      method: 'POST',
      json: { ...walkIn, time: hhmm(14 * 60 - service.duration_min + 1) },
    }),
    400,
    'VALIDATION_ERROR',
    'POST /api/bookings that would run one minute past closing',
  );
  // The last START the narrowed window offers, read off the grid rather than computed:
  // a booking holds a technician even when it names none, so the hour has to be one the
  // roster actually starts on. That it finishes by closing time is asserted here.
  const closingGrid = ok(
    await guest.fetch(`/api/services/${service.id}/availability?date=${hoursDate}`),
    'GET /api/services/:id/availability inside the 08:00-14:00 window',
  ).slots.filter((slot) => slot.available);
  assert(
    closingGrid.length > 0,
    'closing-time check: the narrowed window must still offer a bookable slot',
  );
  const lastLegalStart = closingGrid[closingGrid.length - 1].time;
  assert(
    Number(lastLegalStart.slice(0, 2)) * 60 + Number(lastLegalStart.slice(3)) +
      service.duration_min <= 14 * 60,
    'closing-time check: the last slot offered must still finish by closing time',
  );
  const untilClosing = ok(
    await customer.fetch('/api/bookings', {
      method: 'POST',
      json: { ...walkIn, time: lastLegalStart },
    }),
    'POST /api/bookings that finishes exactly at closing time',
  );
  assert(
    untilClosing.time === lastLegalStart,
    'closing-time check: a service ending exactly at closing must still be accepted',
  );

  // The salon owner is told about what the customer does, because nothing moves a booking
  // off 'pending' until somebody there looks at it.
  const ownerSlot = await findServiceSlot(service);
  assert(ownerSlot !== null, 'owner-notification case: needed a free slot');
  const ownerBooking = ok(
    await customer.fetch('/api/bookings', {
      method: 'POST',
      json: { salon_id: state.lalaId, service_id: service.id, ...ownerSlot },
    }),
    'POST /api/bookings (the owner-notification case)',
  );
  const ownerFeed = ok(await partner.fetch('/api/notifications'), 'the owner feed after a new booking');
  const announced = ownerFeed.filter((item) => item.booking_id === ownerBooking.id);
  assert(
    announced.length === 1 && announced[0].type === 'booking',
    'new booking: the salon owner must get exactly one booking notification naming it',
  );

  ok(
    await customer.fetch(`/api/bookings/${ownerBooking.id}/cancel`, { method: 'PATCH' }),
    'PATCH /api/bookings/:id/cancel (the owner-notification case)',
  );
  const ownerAfterCancel = ok(await partner.fetch('/api/notifications'), 'the owner feed after the cancel');
  assert(
    ownerAfterCancel.filter((item) => item.booking_id === ownerBooking.id).length === 2,
    'cancel: the salon owner must be told the hour is free again',
  );

  // A day that has gone by closes itself out the next time the customer opens their list:
  // a confirmed booking happened, a pending one was never taken up. Only the salon may
  // move a booking, so that is how the day gets put behind these two.
  const yesterday = addDays(state.today, -1);
  const stranded = {};
  const strandedSlots = [];
  // Both halves of the sweep need a booking the salon never touched, and one of them has
  // to still be waiting: Lala confirms automatically, so that is switched off here and
  // back on below. The settings themselves are exercised in group 17.
  ok(
    await partner.fetch('/api/partner/salon', { method: 'PATCH', json: { auto_confirm: 0 } }),
    'PATCH /api/partner/salon (manual confirmation for the sweep case)',
  );
  for (const kind of ['confirmed', 'pending']) {
    const slot = await findServiceSlot(service, strandedSlots);
    assert(slot !== null, `stranded-${kind} case: needed a free slot`);
    strandedSlots.push(slot);
    const booking = ok(
      await customer.fetch('/api/bookings', {
        method: 'POST',
        json: { salon_id: state.lalaId, service_id: service.id, ...slot },
      }),
      `POST /api/bookings for the stranded-${kind} case`,
    );
    if (kind === 'confirmed') {
      ok(
        await partner.fetch(`/api/partner/bookings/${booking.id}`, {
          method: 'PATCH',
          json: { status: 'confirmed' },
        }),
        'PATCH /api/partner/bookings/:id (confirm it before its day goes by)',
      );
    }
    ok(
      await partner.fetch(`/api/partner/bookings/${booking.id}`, {
        method: 'PATCH',
        json: { date: yesterday },
      }),
      `PATCH /api/partner/bookings/:id (move the ${kind} one into yesterday)`,
    );
    stranded[kind] = booking.id;
  }
  ok(
    await partner.fetch('/api/partner/salon', { method: 'PATCH', json: { auto_confirm: 1 } }),
    'PATCH /api/partner/salon (automatic confirmation again)',
  );

  const sweptResponse = await customer.fetch('/api/bookings/mine?status=completed&limit=50');
  const swept = ok(sweptResponse, 'GET /api/bookings/mine?status=completed (after the sweep)');
  const closed = swept.find((item) => item.id === stranded.confirmed);
  assert(closed !== undefined, "auto-close: yesterday's confirmed booking must land in the completed tab", sweptResponse);
  assert(closed.auto === true, 'auto-close: a card the sweep closed must say so', sweptResponse);

  const droppedResponse = await customer.fetch('/api/bookings/mine?status=cancelled&limit=50');
  const droppedList = ok(droppedResponse, 'GET /api/bookings/mine?status=cancelled (after the sweep)');
  const dropped = droppedList.find((item) => item.id === stranded.pending);
  assert(dropped !== undefined, "auto-close: yesterday's pending booking must land in the cancelled tab", droppedResponse);
  assert(dropped.auto === true, 'auto-close: a cancelled card the sweep closed must say so', droppedResponse);

  const invitedResponse = await customer.fetch('/api/notifications');
  const invited = ok(invitedResponse, 'GET /api/notifications after the sweep');
  const invitations = invited.filter(
    (item) => item.type === 'review' && item.booking_id === stranded.confirmed,
  );
  assert(invitations.length === 1, 'auto-close: expected one invitation to review the closed booking', invitedResponse);

  // A second look sweeps nothing: those rows are no longer pending or confirmed.
  ok(
    await customer.fetch('/api/bookings/mine?status=completed&limit=50'),
    'GET /api/bookings/mine?status=completed (the second look)',
  );
  const repeated = ok(await customer.fetch('/api/notifications'), 'GET /api/notifications after the second look');
  assert(
    repeated.filter((item) => item.type === 'review' && item.booking_id === stranded.confirmed).length === 1,
    'auto-close: a second list must not queue a second invitation',
  );

  ok(
    await partner.fetch('/api/partner/salon', { method: 'PATCH', json: { hours: salonHours } }),
    'PATCH /api/partner/salon (restore the hours the booking group started from)',
  );
}

/* ============================================================================
 * 7 — reviews
 * ========================================================================= */

async function groupReviews() {
  const customer = session('customer');

  const completedResponse = await customer.fetch('/api/bookings/mine?status=completed');
  const completed = ok(completedResponse, 'GET /api/bookings/mine?status=completed');
  const target = completed.find((item) => item.code === 'OAK-7TJ5ZA');
  assert(target !== undefined, 'reviews: seeded un-reviewed booking OAK-7TJ5ZA not found', completedResponse);

  const createdReview = ok(
    await customer.fetch('/api/reviews', {
      method: 'POST',
      json: { booking_id: target.id, rating: 5, comment: 'Kỹ thuật viên rất tỉ mỉ, sẽ quay lại.' },
    }),
    'POST /api/reviews',
  );
  assert(createdReview.booking_id === target.id, 'review create: wrong booking_id');

  expectError(
    await customer.fetch('/api/reviews', {
      method: 'POST',
      json: { booking_id: target.id, rating: 4, comment: 'Lần hai.' },
    }),
    409,
    'ALREADY_REVIEWED',
    'POST /api/reviews twice for the same booking',
  );

  expectError(
    await customer.fetch('/api/reviews', {
      method: 'POST',
      json: { booking_id: state.bookingId, rating: 5, comment: 'Chưa xong mà.' },
    }),
    400,
    null,
    'POST /api/reviews on a booking that is not completed',
  );

  const mineResponse = await customer.fetch('/api/reviews/mine');
  const mine = ok(mineResponse, 'GET /api/reviews/mine');
  assert(
    mine.some((item) => item.booking_id === target.id),
    'reviews/mine: must contain the new review',
    mineResponse,
  );
  assert('name' in mine[0].salon, 'reviews/mine: expected a nested salon block', mineResponse);

  // The salon page draws its distribution bars against every review of the salon while the
  // list below them is filtered, so the scale (all_total, average, breakdown) must not move
  // when a star is pressed — only meta.total and the rows do.
  const salonId = target.salon.id;
  const allResponse = await customer.fetch(`/api/salons/${salonId}/reviews`);
  const all = ok(allResponse, 'GET /api/salons/:id/reviews (unfiltered)');
  const allMeta = allResponse.body.meta;
  assert(typeof allMeta.all_total === 'number', 'salon reviews: expected meta.all_total', allResponse);
  assert(allMeta.all_total === allMeta.total, 'salon reviews: unfiltered all_total must equal total', allResponse);
  assert(
    all.every((review) => 'service_name' in review),
    'salon reviews: every row must carry service_name',
    allResponse,
  );

  const fiveResponse = await customer.fetch(`/api/salons/${salonId}/reviews?rating=5`);
  const five = ok(fiveResponse, 'GET /api/salons/:id/reviews?rating=5');
  const fiveMeta = fiveResponse.body.meta;
  assert(five.length > 0, 'salon reviews?rating=5: expected the review just created', fiveResponse);
  assert(five.every((review) => review.rating === 5), 'salon reviews?rating=5: expected only 5s', fiveResponse);
  assert(
    fiveMeta.total === allMeta.breakdown['5'],
    'salon reviews?rating=5: meta.total must equal breakdown["5"]',
    fiveResponse,
  );
  assert(fiveMeta.all_total === allMeta.all_total, 'salon reviews?rating=5: all_total must not move', fiveResponse);
  assert(fiveMeta.average === allMeta.average, 'salon reviews?rating=5: average must not move', fiveResponse);
  assert(
    JSON.stringify(fiveMeta.breakdown) === JSON.stringify(allMeta.breakdown),
    'salon reviews?rating=5: breakdown must not move',
    fiveResponse,
  );

  const lowestResponse = await customer.fetch(`/api/salons/${salonId}/reviews?sort=lowest`);
  const lowest = ok(lowestResponse, 'GET /api/salons/:id/reviews?sort=lowest');
  assert(
    lowest.every((review, index) => index === 0 || lowest[index - 1].rating <= review.rating),
    'salon reviews?sort=lowest: ratings must not decrease',
    lowestResponse,
  );

  // A value the <select> never offers is ignored rather than obeyed or refused.
  const bogusResponse = await customer.fetch(`/api/salons/${salonId}/reviews?rating=abc&sort=bogus`);
  const bogus = ok(bogusResponse, 'GET /api/salons/:id/reviews?rating=abc&sort=bogus');
  assert(bogus.length === all.length, 'salon reviews: rubbish parameters must be ignored', bogusResponse);
  assert(
    bogusResponse.body.meta.total === allMeta.total,
    'salon reviews: rubbish parameters must not narrow meta.total',
    bogusResponse,
  );

  /* ---- the salon reads its own reviews, and answers them in public ---- */

  const partnerA = session('partnerA');
  const consoleResponse = await partnerA.fetch('/api/partner/reviews');
  const consoleReviews = ok(consoleResponse, 'GET /api/partner/reviews');
  assert(consoleReviews.length > 0, 'partner reviews: expected the salon\'s own reviews', consoleResponse);
  assert(
    typeof consoleResponse.body.meta.unanswered === 'number',
    'partner reviews: expected meta.unanswered for the dashboard badge',
    consoleResponse,
  );
  // The demo customer's own review, so the notification it raises lands in the session
  // this group already holds.
  const ownReview = consoleReviews.find((item) => item.user.name === 'Ngọc Anh');
  assert(ownReview !== undefined, 'partner reviews: expected a review written by the demo customer', consoleResponse);
  for (const key of ['reply_text', 'reply_at', 'user', 'service', 'booking']) {
    assert(key in ownReview, `partner review: missing "${key}"`, consoleResponse);
  }

  const oneStar = await partnerA.fetch('/api/partner/reviews?rating=1');
  const filtered = ok(oneStar, 'GET /api/partner/reviews?rating=1');
  assert(
    filtered.every((item) => item.rating === 1),
    'partner reviews?rating=1: every row must be a one-star',
    oneStar,
  );

  // Another partner's review is not theirs to answer, and the id being real must not be
  // what the answer tells them.
  expectError(
    await session('partnerB').fetch(`/api/partner/reviews/${ownReview.id}/reply`, {
      method: 'PATCH',
      json: { reply_text: 'Cảm ơn bạn!' },
    }),
    404,
    'NOT_FOUND',
    'PATCH /api/partner/reviews/:id/reply on another salon\'s review',
  );

  const beforeReply = ok(
    await customer.fetch('/api/notifications?limit=50'),
    'GET /api/notifications (before the reply)',
  ).length;

  const replied = ok(
    await partnerA.fetch(`/api/partner/reviews/${ownReview.id}/reply`, {
      method: 'PATCH',
      json: { reply_text: 'Cảm ơn bạn đã tin tưởng, hẹn gặp lại!' },
    }),
    'PATCH /api/partner/reviews/:id/reply',
  );
  assert(replied.reply_text === 'Cảm ơn bạn đã tin tưởng, hẹn gặp lại!', 'review reply: expected the text back');
  assert(typeof replied.reply_at === 'string', 'review reply: expected a timestamp');

  // The public list is where the answer has to appear, under the review it answers.
  const ownSalon = ok(await partnerA.fetch('/api/partner/salon'), 'GET /api/partner/salon');
  const publicResponse = await customer.fetch(`/api/salons/${ownSalon.id}/reviews?limit=50`);
  const publicReviews = ok(publicResponse, 'GET /api/salons/:id/reviews (with a reply)');
  const answered = publicReviews.find((item) => item.id === ownReview.id);
  assert(answered !== undefined, 'salon reviews: expected the answered review in the list', publicResponse);
  assert(
    answered.reply && answered.reply.text === 'Cảm ơn bạn đã tin tưởng, hẹn gặp lại!',
    'salon reviews: expected the salon reply on the row',
    publicResponse,
  );

  const afterReply = ok(
    await customer.fetch('/api/notifications?limit=50'),
    'GET /api/notifications (after the reply)',
  );
  assert(
    afterReply.length === beforeReply + 1 && afterReply.some((item) => item.type === 'review'),
    'review reply: the author must be told about it',
  );

  // Taking it back down is the same request with nothing in it.
  const cleared = ok(
    await partnerA.fetch(`/api/partner/reviews/${ownReview.id}/reply`, {
      method: 'PATCH',
      json: { reply_text: '' },
    }),
    'PATCH /api/partner/reviews/:id/reply (cleared)',
  );
  assert(cleared.reply_text === null && cleared.reply_at === null, 'review reply: expected both columns cleared');
}

/* ============================================================================
 * 8 — favorites
 * ========================================================================= */

async function groupFavorites() {
  // The second customer starts with an empty list, so "GET empty" at the end is real.
  const customer = session('customer2');
  const serviceId = state.slot.service.id;

  ok(
    await customer.fetch('/api/favorites', { method: 'POST', json: { salon_id: state.lalaId } }),
    'POST /api/favorites {salon_id}',
  );
  ok(
    await customer.fetch('/api/favorites', { method: 'POST', json: { service_id: serviceId } }),
    'POST /api/favorites {service_id}',
  );
  ok(
    await customer.fetch('/api/favorites', { method: 'POST', json: { salon_id: state.lalaId } }),
    'POST /api/favorites {salon_id} again (idempotent)',
  );

  const listResponse = await customer.fetch('/api/favorites');
  const list = ok(listResponse, 'GET /api/favorites');
  assert(list.salons.length === 1, 'favorites: expected exactly one salon', listResponse);
  assert(list.services.length === 1, 'favorites: expected exactly one service', listResponse);
  assert(Array.isArray(list.salons[0].tags), 'favorites: salon card must carry a tags array', listResponse);
  assert('price_from' in list.salons[0], 'favorites: salon card must carry price_from', listResponse);
  assert(list.services[0].salon?.id === state.lalaId, 'favorites: service card must nest its salon', listResponse);

  ok(
    await customer.fetch(`/api/favorites?salon_id=${state.lalaId}`, { method: 'DELETE' }),
    'DELETE /api/favorites?salon_id=',
  );
  ok(
    await customer.fetch(`/api/favorites?service_id=${serviceId}`, { method: 'DELETE' }),
    'DELETE /api/favorites?service_id=',
  );

  const emptyResponse = await customer.fetch('/api/favorites');
  const empty = ok(emptyResponse, 'GET /api/favorites after delete');
  assert(empty.salons.length === 0 && empty.services.length === 0, 'favorites: expected an empty list', emptyResponse);
}

/* ============================================================================
 * 9 — notifications
 * ========================================================================= */

async function groupNotifications() {
  const customer = session('customer');

  const listResponse = await customer.fetch('/api/notifications');
  const list = ok(listResponse, 'GET /api/notifications');
  assert(list.length > 0, 'notifications: expected a feed', listResponse);
  assert('read' in list[0] && typeof list[0].read === 'boolean', 'notifications: expected a boolean read flag', listResponse);

  const countResponse = await customer.fetch('/api/notifications?count_only=true');
  const count = ok(countResponse, 'GET /api/notifications?count_only=true');
  assert(typeof count.unread_count === 'number', 'notifications: expected unread_count', countResponse);
  assert(count.unread_count > 0, 'notifications: expected unread notifications to exist', countResponse);

  const unread = list.find((item) => item.read === false);
  assert(unread !== undefined, 'notifications: expected at least one unread item', listResponse);
  ok(
    await customer.fetch(`/api/notifications/${unread.id}/read`, { method: 'PATCH' }),
    'PATCH /api/notifications/:id/read',
  );
  const afterOne = ok(
    await customer.fetch('/api/notifications?count_only=true'),
    'unread count after marking one',
  );
  assert(afterOne.unread_count === count.unread_count - 1, 'notifications: unread count must drop by one');

  ok(await customer.fetch('/api/notifications/read-all', { method: 'POST' }), 'POST /api/notifications/read-all');
  const afterAll = ok(
    await customer.fetch('/api/notifications?count_only=true'),
    'unread count after read-all',
  );
  assert(afterAll.unread_count === 0, 'notifications: expected 0 unread after read-all');
}

/* ============================================================================
 * 10 — promotions
 * ========================================================================= */

async function groupPromotions() {
  const response = await session('guest').fetch('/api/promotions');
  const promotions = ok(response, 'GET /api/promotions');
  assert(promotions.length > 0, 'promotions: expected active offers', response);
  assert(
    promotions.every((item) => item.starts_at <= state.today && item.ends_at >= state.today),
    'promotions: only offers active today may be listed',
    response,
  );
  // One offer runs on OAK: the 20% code a salon joins with. Nothing platform-wide, and
  // nothing a salon did not get simply by signing up.
  assert(
    promotions.every(
      (item) => item.salon?.slug !== undefined && item.discount_percent === WELCOME_PERCENT,
    ),
    'promotions: every listed offer must be a salon welcome offer',
    response,
  );

  // The code is derived from the salon id, which is what lets registration, the seed and
  // the boot-time backfill all write the same one exactly once.
  const lala = promotions.find((item) => item.code === welcomeCode(state.lalaId));
  assert(lala !== undefined, "promotions: the salon's welcome offer must be listed", response);
  assert(
    lala.salon.slug === 'lala-nail-studio',
    'promotions: a salon offer must carry its salon block',
    response,
  );
}

/* ============================================================================
 * 11 — posts
 * ========================================================================= */

async function groupPosts() {
  const guest = session('guest');
  const customer = session('customer');
  const partnerA = session('partnerA');
  const partnerB = session('partnerB');

  const listResponse = await guest.fetch('/api/posts');
  const list = ok(listResponse, 'GET /api/posts');
  assert(list.length > 0, 'posts: expected a feed', listResponse);
  assert('comment_count' in list[0] && 'author' in list[0], 'posts: expected comment_count and author', listResponse);
  assert(list.every((post) => post.can_manage !== true), 'public posts: must never expose a true management capability', listResponse);

  const videoResponse = await guest.fetch('/api/posts?type=video');
  const videos = ok(videoResponse, 'GET /api/posts?type=video');
  assert(
    videos.length > 0 && videos.every((item) => item.type === 'video'),
    'posts?type=video: every item must be a video',
    videoResponse,
  );

  const detailResponse = await guest.fetch('/api/posts/xu-huong-nail-han-quoc-2026');
  const detail = ok(detailResponse, 'GET /api/posts/:slug');
  assert(typeof detail.content === 'string', 'post detail: expected full content', detailResponse);
  assert(detail.comments.length >= 2, 'post detail: expected the seeded comments', detailResponse);
  assert(detail.source === null && detail.salon === null, 'legacy post: social attribution must be null', detailResponse);

  const title = 'Bài viết trùng tên từ bộ kiểm thử';
  const first = ok(
    await customer.fetch('/api/posts', { method: 'POST', json: { type: 'article', title, content: 'Nội dung một.' } }),
    'POST /api/posts (first)',
  );
  const second = ok(
    await customer.fetch('/api/posts', { method: 'POST', json: { type: 'article', title, content: 'Nội dung hai.' } }),
    'POST /api/posts (same title)',
  );
  assert(first.slug !== second.slug, 'posts: two posts sharing a title must get distinct slugs');
  assert(first.source === null && first.salon === null, 'normal post: social attribution must stay optional');

  const socialUrl = 'https://www.instagram.com/p/oak-smoke-test/';
  expectError(
    await customer.fetch('/api/posts', {
      method: 'POST',
      json: {
        type: 'article',
        title: 'Nguồn xã hội từ tài khoản khách',
        content: 'Không được phép.',
        source_platform: 'instagram',
        source_url: socialUrl,
      },
    }),
    403,
    'FORBIDDEN',
    'POST /api/posts social source as customer',
  );

  for (const [label, source_platform, source_url] of [
    ['an unsupported platform', 'threads', 'https://threads.net/@oak/post/123'],
    ['an insecure URL', 'facebook', 'http://facebook.com/oak/posts/123'],
    ['a mismatched domain', 'instagram', 'https://facebook.com/oak/posts/123'],
    ['a deceptive domain', 'facebook', 'https://facebook.com.evil.example/oak/posts/123'],
    ['a Facebook redirector', 'facebook', 'https://l.facebook.com/l.php?u=https%3A%2F%2Fevil.example'],
    ['a platform homepage', 'youtube', 'https://www.youtube.com/'],
    ['a profile instead of a post', 'instagram', 'https://www.instagram.com/oak'],
  ]) {
    expectError(
      await partnerA.fetch('/api/posts', {
        method: 'POST',
        json: {
          type: 'article',
          title: `Bài nguồn ${label}`,
          content: 'Nội dung kiểm thử.',
          source_platform,
          source_url,
        },
      }),
      400,
      'VALIDATION_ERROR',
      `POST /api/posts social source with ${label}`,
    );
  }

  expectError(
    await partnerA.fetch('/api/posts', {
      method: 'POST',
      json: {
        type: 'article',
        title: 'Sai nền tảng khai báo',
        content: 'Nội dung kiểm thử.',
        source_platform: 'facebook',
        source_url: 'https://www.instagram.com/p/mismatch',
      },
    }),
    400,
    'VALIDATION_ERROR',
    'POST /api/posts with a mismatched optional platform claim',
  );

  const social = ok(
    await partnerA.fetch('/api/posts', {
      method: 'POST',
      json: {
        type: 'article',
        title: 'Mẫu nail mới từ Instagram',
        content: 'Nội dung do salon biên tập cho OAK.',
        excerpt: 'Xu hướng mới từ trang Instagram của salon.',
        source_url: socialUrl,
      },
    }),
    'POST /api/posts with social source as partner',
  );
  assert(
    social.source?.platform === 'instagram' && social.source?.url === 'https://www.instagram.com/p/oak-smoke-test',
    'social post: source must be normalized and returned',
  );
  assert(social.salon?.id && social.salon?.name && social.salon?.slug, 'social post: salon attribution is required');

  const socialDetail = ok(
    await guest.fetch(`/api/posts/${encodeURIComponent(social.slug)}`),
    'GET /api/posts/:slug for social post',
  );
  assert(
    socialDetail.source?.url === social.source.url && socialDetail.salon?.id === social.salon.id,
    'social post detail: source and salon must survive reload',
  );
  const socialList = ok(await guest.fetch('/api/posts?limit=50'), 'GET /api/posts after social post');
  const listedSocial = socialList.find((item) => item.id === social.id);
  assert(
    listedSocial?.source?.platform === 'instagram' && listedSocial?.salon?.id === social.salon.id,
    'social post list: source and salon attribution must be public',
  );

  expectError(
    await partnerA.fetch('/api/posts', {
      method: 'POST',
      json: {
        type: 'article',
        title: 'Bản nhập trùng',
        content: 'Nội dung trùng nguồn.',
        source_platform: 'instagram',
        source_url: `${socialUrl}?foo=one#comments`,
      },
    }),
    409,
    'DUPLICATE_SOURCE',
    'POST /api/posts with a duplicate source in the same salon',
  );

  expectError(
    await partnerB.fetch('/api/posts', {
      method: 'POST',
      json: {
        type: 'article',
        title: 'Cùng nguồn từ salon khác',
        content: 'Nguồn đã tồn tại trên toàn blog.',
        source_url: 'https://instagram.com/p/oak-smoke-test?foo=another-value#comments',
      },
    }),
    409,
    'DUPLICATE_SOURCE',
    'POST /api/posts with a duplicate canonical source in another salon',
  );

  if (!EXTERNAL_URL) {
    const otherSalon = ok(await partnerB.fetch('/api/partner/salon'), 'partner B salon for DB constraints');
    const directClient = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await directClient.connect();
    try {
      let uniqueError = null;
      try {
        await directClient.query(
          `INSERT INTO posts
             (author_id, salon_id, type, title, slug, content, source_platform, source_url, created_at)
           SELECT owner_id, id, 'article', $1, $2, $3, 'instagram', $4, $5
           FROM salons WHERE id = $6`,
          [
            'Race-safe duplicate',
            `race-safe-duplicate-${Date.now()}`,
            'The database index must reject this even without the route pre-check.',
            social.source.url,
            new Date().toISOString(),
            otherSalon.id,
          ],
        );
      } catch (error) {
        uniqueError = error;
      }
      assert(
        uniqueError?.code === '23505' && uniqueError?.constraint === 'idx_posts_source_url',
        'posts DB: the global partial unique index must close the duplicate race',
      );

      let shapeError = null;
      try {
        await directClient.query(
          `INSERT INTO posts (author_id, type, title, slug, content, source_platform, created_at)
           SELECT owner_id, 'article', $1, $2, $3, 'instagram', $4
           FROM salons WHERE id = $5`,
          [
            'Incomplete social fields',
            `incomplete-social-fields-${Date.now()}`,
            'The all-or-none constraint must reject this row.',
            new Date().toISOString(),
            otherSalon.id,
          ],
        );
      } catch (error) {
        shapeError = error;
      }
      assert(
        shapeError?.code === '23514' && shapeError?.constraint === 'posts_social_fields_all_or_none',
        'posts DB: source platform and URL must be paired and require salon attribution',
      );
      const constraintDefinition = await directClient.query(`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conname = 'posts_social_fields_all_or_none' AND conrelid = 'posts'::regclass
      `);
      assert(
        constraintDefinition.rows[0]?.definition.includes('source_platform IS NULL')
          && !constraintDefinition.rows[0]?.definition.includes('salon_id IS NULL'),
        'posts DB: native salon posts must be allowed without social source fields',
      );

      let platformError = null;
      try {
        await directClient.query(
          `INSERT INTO posts
             (author_id, salon_id, type, title, slug, content, source_platform, source_url, created_at)
           SELECT owner_id, id, 'article', $1, $2, $3, 'threads', $4, $5
           FROM salons WHERE id = $6`,
          [
            'Unsupported DB platform',
            `unsupported-db-platform-${Date.now()}`,
            'The platform check must reject this row.',
            `https://threads.net/oak/${Date.now()}`,
            new Date().toISOString(),
            otherSalon.id,
          ],
        );
      } catch (error) {
        platformError = error;
      }
      assert(
        platformError?.code === '23514' && platformError?.constraint === 'posts_source_platform_allowed',
        'posts DB: source platform must stay inside the supported allowlist',
      );
    } finally {
      await directClient.end();
    }
  }

  const comment = ok(
    await customer.fetch(`/api/posts/${first.id}/comments`, {
      method: 'POST',
      json: { content: 'Bình luận từ bộ kiểm thử.' },
    }),
    'POST /api/posts/:id/comments',
  );
  assert(comment.content === 'Bình luận từ bộ kiểm thử.', 'post comment: expected the content back');

  expectError(await guest.fetch('/api/posts/mine'), 401, 'UNAUTHENTICATED', 'guest GET /api/posts/mine');
  const customerMineResponse = await customer.fetch('/api/posts/mine?limit=50');
  const customerMine = ok(customerMineResponse, 'customer GET /api/posts/mine');
  assert(
    customerMine.some((post) => post.id === first.id) && customerMine.some((post) => post.id === second.id),
    'posts mine: a customer must see their own posts',
  );
  assert(customerMine.every((post) => post.can_manage === true), 'posts mine: every owned row must carry a server-issued management capability');
  assert(
    customerMine.every((post) => post.author?.name && post.id !== social.id),
    'posts mine: editable rows include author data and never leak another author',
  );
  const otherPost = ok(
    await partnerB.fetch('/api/posts', {
      method: 'POST',
      json: { type: 'video', title: 'Video riêng của salon B', video_url: 'https://www.youtube.com/embed/dQw4w9WgXcQ' },
    }),
    'partner B creates a post for ownership tests',
  );
  assert(otherPost.salon?.id, 'partner native post: salon attribution must be derived by the server');
  const mineResponse = await partnerA.fetch('/api/posts/mine?limit=1');
  const mine = ok(mineResponse, 'GET /api/posts/mine with pagination');
  assert(mineResponse.body.meta.page === 1 && mineResponse.body.meta.limit === 1, 'posts mine: pagination meta must be returned');
  assert(mine.every((post) => post.can_manage === true), 'partner posts mine: every row must be explicitly manageable');
  assert(mine.every((post) => post.id !== otherPost.id), 'posts mine: another author must never leak into the list');
  const mineArticlesResponse = await partnerA.fetch('/api/posts/mine?type=article&limit=50');
  const mineArticles = ok(mineArticlesResponse, 'GET /api/posts/mine?type=article');
  assert(mineArticles.some((post) => post.id === social.id) && mineArticles.every((post) => post.type === 'article'), 'posts mine: type filter and author scope must both apply');

  const customerPatched = ok(
    await customer.fetch(`/api/posts/${first.id}`, {
      method: 'PATCH',
      json: { title: 'Bài của tôi đã cập nhật', content: 'Nội dung của khách đã cập nhật.' },
    }),
    'customer PATCH own post',
  );
  assert(customerPatched.slug === first.slug && customerPatched.type === first.type, 'customer patch: slug and type stay immutable');
  const customerPersisted = ok(await guest.fetch(`/api/posts/${first.slug}`), 'GET customer patched post publicly');
  assert(customerPersisted.title === customerPatched.title, 'customer patch: public detail must persist edits');
  expectError(
    await customer.fetch(`/api/posts/${first.id}`, { method: 'PATCH', json: { source_url: socialUrl } }),
    403,
    'FORBIDDEN',
    'customer PATCH own social source',
  );
  expectError(await guest.fetch(`/api/posts/${social.id}`, { method: 'DELETE' }), 401, 'UNAUTHENTICATED', 'guest DELETE /api/posts/:id');
  expectError(await partnerB.fetch(`/api/posts/${social.id}`, { method: 'PATCH', json: { title: 'No' } }), 404, 'NOT_FOUND', 'other owner PATCH /api/posts/:id');
  expectError(await partnerB.fetch(`/api/posts/${first.id}`, { method: 'DELETE' }), 404, 'NOT_FOUND', 'other owner DELETE /api/posts/:id');
  expectError(await partnerA.fetch(`/api/posts/${social.id}`, { method: 'PATCH', json: { type: 'video' } }), 400, 'VALIDATION_ERROR', 'PATCH /api/posts/:id attempting to mutate type');
  expectError(await partnerA.fetch(`/api/posts/${social.id}`, { method: 'PATCH', json: { content: '' } }), 400, 'VALIDATION_ERROR', 'PATCH /api/posts/:id with invalid article content');

  const changedSource = 'https://www.facebook.com/oak/posts/partner-management-smoke';
  const patchedPost = ok(
    await partnerA.fetch(`/api/posts/${social.id}`, {
      method: 'PATCH',
      json: { title: 'Mẫu nail đã cập nhật', content: 'Nội dung mới.', source_url: changedSource },
    }),
    'PATCH /api/posts/:id as owner',
  );
  assert(patchedPost.slug === social.slug, 'post patch: slug must remain stable');
  assert(patchedPost.source?.platform === 'facebook', 'post patch: platform must be derived from the source URL');
  const persisted = ok(await guest.fetch(`/api/posts/${social.slug}`), 'GET patched post publicly');
  assert(persisted.title === 'Mẫu nail đã cập nhật' && persisted.source.url === changedSource, 'post patch: public detail must persist edits');
  const ordinaryPartnerEdit = ok(
    await partnerA.fetch(`/api/posts/${social.id}`, { method: 'PATCH', json: { excerpt: 'Chỉ đổi mô tả.' } }),
    'PATCH partner post without touching attribution',
  );
  assert(
    ordinaryPartnerEdit.source?.url === changedSource && ordinaryPartnerEdit.salon?.id === social.salon.id,
    'post patch: an ordinary edit must preserve source and salon attribution',
  );

  const duplicateTarget = ok(
    await partnerB.fetch('/api/posts', { method: 'POST', json: { type: 'article', title: 'Nguồn khác', content: 'Nguồn khác.', source_url: 'https://www.instagram.com/p/oak-other-source' } }),
    'create another source for patch duplicate test',
  );
  expectError(
    await partnerA.fetch(`/api/posts/${social.id}`, { method: 'PATCH', json: { source_url: duplicateTarget.source.url } }),
    409,
    'DUPLICATE_SOURCE',
    'PATCH /api/posts/:id with a duplicate source',
  );
  const selfSource = ok(
    await partnerA.fetch(`/api/posts/${social.id}`, { method: 'PATCH', json: { source_url: changedSource } }),
    'PATCH /api/posts/:id retaining its own source URL',
  );
  assert(selfSource.source.url === changedSource, 'post patch: duplicate check must exclude the current id');
  const clearedSource = ok(
    await partnerA.fetch(`/api/posts/${social.id}`, { method: 'PATCH', json: { source_url: '' } }),
    'PATCH /api/posts/:id clearing its social source',
  );
  assert(
    clearedSource.source === null && clearedSource.salon?.id === social.salon.id,
    'post patch: clearing source must retain immutable salon attribution',
  );
  expectError(
    await partnerA.fetch(`/api/posts/${social.id}`, {
      method: 'PATCH',
      json: { source_url: '', source_platform: 'threads' },
    }),
    400,
    'VALIDATION_ERROR',
    'PATCH /api/posts/:id clearing source with a non-empty platform claim',
  );

  if (!EXTERNAL_URL) {
    const directClient = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await directClient.connect();
    try {
      const legacy = await directClient.query(
        `INSERT INTO posts (author_id, type, title, slug, content, created_at)
         SELECT owner_id, 'article', $1, $2, $3, $4 FROM salons WHERE id = $5 RETURNING id, slug`,
        ['Legacy partner post', `legacy-partner-post-${Date.now()}`, 'Legacy content.', new Date().toISOString(), social.salon.id],
      );
      const legacyPost = legacy.rows[0];
      const attributed = ok(
        await partnerA.fetch(`/api/posts/${legacyPost.id}`, {
          method: 'PATCH',
          json: { source_url: `https://www.facebook.com/oak/posts/legacy-${Date.now()}` },
        }),
        'PATCH a legacy partner post to add social source',
      );
      assert(
        attributed.salon?.id === social.salon.id && attributed.source?.platform === 'facebook',
        'post patch: adding a source to a legacy partner row derives its owned salon',
      );
      ok(await partnerA.fetch(`/api/posts/${legacyPost.id}`, { method: 'DELETE' }), 'delete legacy partner smoke post');
    } finally {
      await directClient.end();
    }
  }

  /* Writing to the public feed is throttled per account, and only a post that actually
     lands spends the allowance: everything above this line was either refused or one of
     the two the customer has already published. */
  const throttled = [];
  for (let n = 3; n <= 5; n += 1) {
    throttled.push(ok(
      await customer.fetch('/api/posts', {
        method: 'POST',
        json: { type: 'article', title: `Bài chạm hạn mức ${n}`, content: 'Nội dung kiểm thử.' },
      }),
      `POST /api/posts (${n} of five in the hour)`,
    ));
  }
  expectError(
    await customer.fetch('/api/posts', {
      method: 'POST',
      json: { type: 'article', title: 'Bài thứ sáu trong giờ', content: 'Vượt hạn mức.' },
    }),
    429,
    'RATE_LIMITED',
    'POST /api/posts beyond five in one hour',
  );

  /* Moderation: a post leaves the public feed without anybody's words being deleted, and
     only an account named in ADMIN_EMAILS can do it. */
  const moderated = throttled[0];
  expectError(
    await customer.fetch(`/api/posts/${moderated.id}/status`, { method: 'PATCH', json: { status: 'hidden' } }),
    403,
    'FORBIDDEN',
    'PATCH /api/posts/:id/status as the post\'s own author',
  );
  if (EXTERNAL_URL) {
    skip('hiding a post: the running server declares its own ADMIN_EMAILS');
  } else {
    const admin = session('customer2');
    ok(
      await admin.fetch(`/api/posts/${moderated.id}/status`, { method: 'PATCH', json: { status: 'hidden' } }),
      'PATCH /api/posts/:id/status as an admin',
    );
    const feed = ok(await guest.fetch('/api/posts?limit=50'), 'GET /api/posts after hiding one');
    assert(feed.every((post) => post.id !== moderated.id), 'moderation: a hidden post must leave the public feed');
    expectError(
      await guest.fetch(`/api/posts/${moderated.slug}`),
      404,
      'NOT_FOUND',
      'hidden post at its own address',
    );
    expectError(
      await admin.fetch(`/api/posts/${moderated.id}/status`, { method: 'PATCH', json: { status: 'draft' } }),
      400,
      'VALIDATION_ERROR',
      'PATCH /api/posts/:id/status with a status nobody defined',
    );
    ok(
      await admin.fetch(`/api/posts/${moderated.id}/status`, { method: 'PATCH', json: { status: 'published' } }),
      'PATCH /api/posts/:id/status back to published',
    );
    const restored = ok(await guest.fetch('/api/posts?limit=50'), 'GET /api/posts after publishing it again');
    assert(restored.some((post) => post.id === moderated.id), 'moderation: publishing must put it back');
  }

  ok(await customer.fetch(`/api/posts/${first.id}`, { method: 'DELETE' }), 'customer DELETE own post with comments');
  expectError(await guest.fetch(`/api/posts/${first.slug}`), 404, 'NOT_FOUND', 'customer-deleted post public detail');
  ok(await customer.fetch(`/api/posts/${social.id}/comments`, { method: 'POST', json: { content: 'Sẽ bị xóa cùng bài.' } }), 'comment before owned post deletion');
  ok(await partnerA.fetch(`/api/posts/${social.id}`, { method: 'DELETE' }), 'DELETE /api/posts/:id as owner');
  expectError(await guest.fetch(`/api/posts/${social.slug}`), 404, 'NOT_FOUND', 'deleted post public detail');
  expectError(await partnerA.fetch(`/api/posts/${social.id}`, { method: 'DELETE' }), 404, 'NOT_FOUND', 'deleting an already deleted post');
}

/* ============================================================================
 * 11b — sitemap
 * ========================================================================= */

/* The map a crawler reads. The pages half is the committed ui/sitemap.xml (pinned by
   server/test/seo-ui.test.mjs); what is asserted here is the half that can only come from
   the database — one entry per listed salon and per published post, in place of the four
   query-driven shells that render "not found" without a ?slug. */
async function groupSitemap() {
  const guest = session('guest');

  const response = await guest.fetch('/sitemap.xml');
  assert(response.status === 200, 'GET /sitemap.xml: expected HTTP 200', response);
  assert(String(response.contentType).includes('xml'), 'sitemap: expected an XML content type', response);
  const xml = String(response.body);
  const locations = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);

  const origin = locations[0].replace(/\/$/, '');
  assert(
    locations.every((loc) => loc.startsWith(`${origin}/`)),
    'sitemap: every URL must be on the one origin the site declares for itself',
    response,
  );

  const salonsResponse = await guest.fetch('/api/salons?limit=50');
  const salons = ok(salonsResponse, 'GET /api/salons for the sitemap');
  const listed = locations.filter((loc) => loc.includes('salon-profile.html?salon='));
  assert(
    listed.length === salonsResponse.body.meta.total,
    `sitemap: ${listed.length} salon URLs for ${salonsResponse.body.meta.total} listed salons`,
    response,
  );
  for (const salon of salons) {
    assert(
      locations.includes(`${origin}/salon-profile.html?salon=${salon.slug}`),
      `sitemap: ${salon.slug} is on the public list but not in the map`,
      response,
    );
  }

  const posts = ok(await guest.fetch('/api/posts?limit=50'), 'GET /api/posts for the sitemap');
  for (const post of posts) {
    assert(
      locations.includes(`${origin}/blog-chi-tiet.html?slug=${encodeURIComponent(post.slug)}`),
      `sitemap: the published post ${post.slug} is missing from the map`,
      response,
    );
  }

  // The shells themselves are replaced, not added to: a bare salon-profile.html or a
  // service page with no ?id is a "không tìm thấy" panel with a brand's name on it.
  for (const shell of ['salon-profile.html', 'blog-chi-tiet.html', 'chi-tiet-dich-vu.html', 'ho-so-chuyen-gia.html']) {
    assert(
      !locations.includes(`${origin}/${shell}`),
      `sitemap: ${shell} is listed without the query that gives it something to show`,
      response,
    );
  }
  assert(
    locations.includes(`${origin}/`) && locations.includes(`${origin}/blog.html`),
    'sitemap: the ordinary pages must still be in it',
    response,
  );
}

/* ============================================================================
 * 12 — users
 * ========================================================================= */

async function groupUsers() {
  const customer = session('customer');

  const patched = ok(
    await customer.fetch('/api/users/me', { method: 'PATCH', json: { district: 'Quận 7', city: 'TP.HCM' } }),
    'PATCH /api/users/me',
  );
  assert(patched.user.district === 'Quận 7', 'users/me: expected the patched district back');

  const me = ok(await customer.fetch('/api/auth/me'), 'GET /api/auth/me after patch');
  assert(me.user.district === 'Quận 7', 'users/me: the change must persist');

  expectError(
    await customer.fetch('/api/users/me', { method: 'PATCH', json: {} }),
    400,
    'VALIDATION_ERROR',
    'PATCH /api/users/me with an empty body',
  );
}

/* ============================================================================
 * 13 — uploads
 * ========================================================================= */

async function groupUploads() {
  const customer = session('customer');

  const uploaded = ok(
    await customer.fetch('/api/uploads', {
      method: 'POST',
      json: { filename: 'smoke.png', data: PNG_1X1 },
    }),
    'POST /api/uploads',
  );
  assert(uploaded.url.startsWith('/uploads/'), 'uploads: expected a /uploads/... url');
  state.uploadedFiles.push(path.basename(uploaded.url));

  const fetched = await fetch(`${BASE_URL}${uploaded.url}`);
  assert(fetched.status === 200, `uploads: the returned url must be fetchable (got ${fetched.status})`);
  assert(
    (fetched.headers.get('content-type') ?? '').includes('image/png'),
    'uploads: the served file must be a png',
  );
  assert(
    fetched.headers.get('x-content-type-options') === 'nosniff',
    'uploads: caller-supplied bytes must be served with X-Content-Type-Options: nosniff',
  );

  expectError(
    await customer.fetch('/api/uploads', { method: 'POST', json: { filename: 'virus.exe', data: PNG_1X1 } }),
    400,
    null,
    'POST /api/uploads with a .exe filename',
  );
}

/* ============================================================================
 * 14 — partner console
 * ========================================================================= */

async function groupPartner() {
  const partner = session('partnerA');
  const tomorrow = addDays(state.today, 1);

  const overviewResponse = await partner.fetch('/api/partner/overview');
  const overview = ok(overviewResponse, 'GET /api/partner/overview');
  for (const key of [
    'revenue_today',
    'revenue_delta_pct',
    'bookings_today',
    'upcoming_count',
    'new_customers',
    'rating_avg',
    'review_count',
    'staff_status',
  ]) {
    assert(key in overview, `partner overview: missing "${key}"`, overviewResponse);
  }
  assert(overview.staff_status.length > 0, 'partner overview: expected staff in staff_status', overviewResponse);
  assert(
    overview.staff_status.every((member) => ['busy', 'free'].includes(member.state)),
    'partner overview: every staff entry needs a busy/free state',
    overviewResponse,
  );

  const bookingsResponse = await partner.fetch('/api/partner/bookings');
  const bookings = ok(bookingsResponse, 'GET /api/partner/bookings');
  assert(bookings.length > 0, 'partner bookings: expected the seeded bookings', bookingsResponse);
  const sample = bookings[0];
  for (const key of ['code', 'end_time', 'customer', 'service', 'staff']) {
    assert(key in sample, `partner booking: missing "${key}"`, bookingsResponse);
  }
  assert(typeof sample.customer.vip === 'boolean', 'partner booking: customer.vip must be a boolean', bookingsResponse);

  const byStatus = await partner.fetch('/api/partner/bookings?status=completed');
  const completed = ok(byStatus, 'GET /api/partner/bookings?status=completed');
  assert(
    completed.length > 0 && completed.every((item) => item.status === 'completed'),
    'partner bookings?status=: expected matches, and every item must match',
    byStatus,
  );
  const byDate = await partner.fetch(`/api/partner/bookings?date=${sample.date}`);
  const dated = ok(byDate, 'GET /api/partner/bookings?date=');
  assert(
    dated.length > 0 && dated.every((item) => item.date === sample.date),
    'partner bookings?date=: every item must match',
    byDate,
  );
  const byQuery = await partner.fetch(`/api/partner/bookings?q=${sample.code}`);
  const searched = ok(byQuery, 'GET /api/partner/bookings?q=');
  assert(
    searched.some((item) => item.id === sample.id),
    'partner bookings?q=<code>: must find that booking',
    byQuery,
  );
  const byService = await partner.fetch(`/api/partner/bookings?service_id=${sample.service.id}`);
  const serviceFiltered = ok(byService, 'GET /api/partner/bookings?service_id=');
  assert(
    serviceFiltered.length > 0 && serviceFiltered.every((item) => item.service?.id === sample.service.id),
    'partner bookings?service_id=: expected matches, and every item must match',
    byService,
  );

  const bookingDetail = ok(
    await partner.fetch(`/api/partner/bookings/${sample.id}`),
    'GET /api/partner/bookings/:id',
  );
  assert('payment_method' in bookingDetail && 'created_at' in bookingDetail, 'partner booking detail: missing fields');

  const services = ok(await partner.fetch('/api/partner/services'), 'GET /api/partner/services');
  assert(services.length > 0, 'partner services: expected a menu');
  const servicesResponse = await partner.fetch('/api/partner/services?category=nail');
  ok(servicesResponse, 'GET /api/partner/services?category=nail');
  assert(
    typeof servicesResponse.body.meta.categories === 'object',
    'partner services: expected meta.categories counts',
    servicesResponse,
  );

  const walkIn = ok(
    await partner.fetch('/api/partner/bookings', {
      method: 'POST',
      json: {
        customer_name: 'Khách vãng lai',
        customer_phone: '0900 000 111',
        service_id: services[0].id,
        date: tomorrow,
        time: '09:00',
      },
    }),
    'POST /api/partner/bookings (walk-in)',
  );
  assert(/^OAK-[A-Z0-9]{6}$/.test(walkIn.code), 'walk-in: code must match OAK-XXXXXX');
  assert(walkIn.status === 'confirmed', 'walk-in: expected status confirmed');
  assert(walkIn.total_price === services[0].price, 'walk-in: total must come from the service price');
  assert(walkIn.customer.name === 'Khách vãng lai', 'walk-in: expected the counter name');

  const completedWalkIn = ok(
    await partner.fetch(`/api/partner/bookings/${walkIn.id}`, { method: 'PATCH', json: { status: 'completed' } }),
    'PATCH /api/partner/bookings/:id confirmed -> completed',
  );
  assert(completedWalkIn.status === 'completed', 'transition: expected status completed');
  expectError(
    await partner.fetch(`/api/partner/bookings/${walkIn.id}`, { method: 'PATCH', json: { status: 'pending' } }),
    400,
    'INVALID_TRANSITION',
    'PATCH completed -> pending',
  );

  // end_time is a formatted sum of the start and the duration, so a late booking has to
  // wrap past midnight instead of rendering an hour like "25:00" that no clock has.
  const longest = services.reduce((best, item) => (item.duration_min > best.duration_min ? item : best));
  assert(
    23 * 60 + 30 + longest.duration_min > 24 * 60,
    'end_time wraparound: needed a service long enough to run past midnight from 23:30',
  );
  const lateResponse = await partner.fetch('/api/partner/bookings', {
    method: 'POST',
    json: {
      customer_name: 'Khách khuya',
      customer_phone: '0900 000 555',
      service_id: longest.id,
      date: tomorrow,
      time: '23:30',
    },
  });
  const lateWalkIn = ok(lateResponse, 'POST /api/partner/bookings at 23:30');
  // Long past closing time: the counter is warned and the booking is still made, because
  // a salon staying late for one customer is doing its job, not making a mistake.
  assert(
    typeof lateResponse.body.meta?.warning === 'string',
    'walk-in at 23:30: expected a warning about the opening hours',
    lateResponse,
  );
  assert(
    lateWalkIn.end_time === hhmm((23 * 60 + 30 + longest.duration_min) % (24 * 60)),
    `walk-in at 23:30: end_time must wrap past midnight, got ${lateWalkIn.end_time}`,
  );


  /* ---- walk-ins: optional identity, and the account behind the number ---- */

  // Nothing but a service and an hour: the counter must be able to record a seat it has
  // no time to ask questions about.
  const anonymous = ok(
    await partner.fetch('/api/partner/bookings', {
      method: 'POST',
      json: { service_id: services[0].id, date: tomorrow, time: '08:30' },
    }),
    'POST /api/partner/bookings (no name, no phone)',
  );
  assert(anonymous.customer.name === 'Khách vãng lai', 'walk-in: expected the default name');
  assert(anonymous.customer.phone === null, 'walk-in: no number given means no number stored');

  // The seeded customer's own number, written the way somebody would say it abroad. The
  // booking has to land in that account, which is what the account's name coming back says.
  const linked = ok(
    await partner.fetch('/api/partner/bookings', {
      method: 'POST',
      json: {
        customer_phone: '+84 901 234 567',
        service_id: services[0].id,
        date: tomorrow,
        time: '08:00',
      },
    }),
    'POST /api/partner/bookings (phone of an existing account)',
  );
  assert(linked.customer.name === 'Ngọc Anh', 'walk-in: expected the matched account name');

  /* ---- the customer file behind those bookings ---- */

  const customersResponse = await partner.fetch('/api/partner/customers?q=0901');
  const customers = ok(customersResponse, 'GET /api/partner/customers?q=');
  const known = customers.find((row) => row.name === 'Ngọc Anh');
  assert(known !== undefined, 'partner customers: expected the account found by number', customersResponse);
  for (const key of ['visits', 'last_visit', 'total_spent', 'no_show_count', 'bookings_count']) {
    assert(key in known, `partner customers: missing "${key}"`, customersResponse);
  }
  assert(known.visits >= 1, 'partner customers: expected at least one completed visit', customersResponse);
  assert(known.total_spent > 0, 'partner customers: expected money against those visits', customersResponse);

  const historyResponse = await partner.fetch(`/api/partner/bookings/${linked.id}/history`);
  const history = ok(historyResponse, 'GET /api/partner/bookings/:id/history');
  assert(history.length > 0, 'booking history: expected the customer\'s earlier bookings', historyResponse);
  assert(
    history.every((item) => item.id !== linked.id),
    'booking history: the booking being looked at is not part of its own history',
    historyResponse,
  );

  /* ---- an edit is not a move, and a move is not a price change ---- */

  const customerSession = session('customer');
  const movedNotices = async () =>
    ok(
      await customerSession.fetch('/api/notifications?limit=50'),
      'GET /api/notifications while editing a linked booking',
    ).filter((item) => item.booking_id === linked.id && /dời lịch hẹn/.test(item.body ?? '')).length;

  const noticesBefore = await movedNotices();
  // The edit form posts every field every time, so the same hour arrives on a note-only
  // edit. Telling the customer their appointment moved to the hour it already had is how
  // a notification channel stops being believed.
  ok(
    await partner.fetch(`/api/partner/bookings/${linked.id}`, {
      method: 'PATCH',
      json: { date: linked.date, time: linked.time, staff_id: linked.staff?.id ?? null, note: 'Khách xin ngồi gần cửa sổ' },
    }),
    'PATCH /api/partner/bookings/:id (a note, with the hour it already had)',
  );
  assert(
    (await movedNotices()) === noticesBefore,
    'reschedule: an edit that moved nothing must not tell the customer it moved',
  );

  ok(
    await partner.fetch(`/api/partner/bookings/${linked.id}`, { method: 'PATCH', json: { time: '08:45' } }),
    'PATCH /api/partner/bookings/:id (a real move)',
  );
  assert(
    (await movedNotices()) === noticesBefore + 1,
    'reschedule: a real move must reach the customer',
  );

  // Swapping the technician is not a move: "đã dời ... sang {giờ}" naming the hour the
  // customer already had reads as a mistake, so it gets its own sentence.
  const restaffedNotices = async () =>
    ok(
      await customerSession.fetch('/api/notifications?limit=50'),
      'GET /api/notifications after a technician swap',
    ).filter((item) => item.booking_id === linked.id && /đổi kỹ thuật viên/.test(item.body ?? '')).length;
  const staffNoticesBefore = await restaffedNotices();
  const movedBeforeSwap = await movedNotices();
  const roster = ok(
    await partner.fetch('/api/partner/staff?limit=50'),
    'partner staff for the technician swap',
  );
  const otherStaff = roster.find((member) => member.id !== (linked.staff?.id ?? null));
  if (otherStaff !== undefined) {
    const swapAttempt = await partner.fetch(`/api/partner/bookings/${linked.id}`, {
      method: 'PATCH',
      json: { staff_id: otherStaff.id },
    });
    // The other technician may not be free at that hour; only assert when the swap landed.
    if (swapAttempt.status === 200) {
      assert(
        (await restaffedNotices()) === staffNoticesBefore + 1,
        'technician swap: the customer is told, in its own words',
      );
      assert(
        (await movedNotices()) === movedBeforeSwap,
        'technician swap: it must not be announced as a move to a new hour',
      );
    }
  }

  // The price belongs to the service, exactly as it does when a booking is created — a
  // PATCH that left the old total behind would be wrong in every revenue figure after it.
  const others = services.filter((item) => item.id !== linked.service.id);
  assert(others.length > 0, 'service change: needed a second service to move the booking onto');
  const dearer = others.reduce((best, item) => (item.price > best.price ? item : best));
  assert(dearer.price !== linked.total_price, 'service change: needed a service at a different price');
  const swapped = ok(
    await partner.fetch(`/api/partner/bookings/${linked.id}`, {
      method: 'PATCH',
      json: { service_id: dearer.id },
    }),
    'PATCH /api/partner/bookings/:id (onto another service)',
  );
  assert(
    swapped.total_price === dearer.price,
    `service change: expected the new service's price, got ${swapped.total_price}`,
  );

  // Cancelling from the console: the reason the counter chose is the whole point of
  // asking for one, so it has to reach the customer along with the way back in.
  const reason = 'Nhân viên nghỉ — KTV ốm đột xuất';
  ok(
    await partner.fetch(`/api/partner/bookings/${linked.id}`, {
      method: 'PATCH',
      json: { status: 'cancelled', note: `Khách xin ngồi gần cửa sổ\nLý do hủy: ${reason}` },
    }),
    'PATCH /api/partner/bookings/:id (cancel with a reason)',
  );
  const cancelNoticesResponse = await customerSession.fetch('/api/notifications?limit=50');
  const cancelNotice = ok(cancelNoticesResponse, 'GET /api/notifications after the console cancel')
    .find((item) => item.booking_id === linked.id && /đã hủy lịch hẹn/.test(item.body ?? ''));
  assert(cancelNotice !== undefined, 'cancel: expected the customer to be told', cancelNoticesResponse);
  assert(
    cancelNotice.body.includes(reason),
    `cancel: the notification must carry the reason, got "${cancelNotice.body}"`,
  );
  assert(
    cancelNotice.body.includes('Bạn có thể đặt lại tại'),
    `cancel: the notification must offer the way back in, got "${cancelNotice.body}"`,
  );
  // Only the reason line, never the rest of the note: the customer's own request read
  // back as "why we cancelled" would be a lie.
  assert(
    !cancelNotice.body.includes('ngồi gần cửa sổ'),
    `cancel: only the reason line belongs in the notification, got "${cancelNotice.body}"`,
  );

  /* ---- the free hours the console offers instead of a free-text time ---- */

  const slotsResponse = await partner.fetch(
    `/api/partner/availability?service_id=${services[0].id}&date=${tomorrow}`,
  );
  const availability = ok(slotsResponse, 'GET /api/partner/availability');
  assert(availability.date === tomorrow, 'partner availability: expected the date asked for', slotsResponse);
  assert(Array.isArray(availability.slots), 'partner availability: expected a slots array', slotsResponse);
  assert(
    availability.slots.every((slot) => 'time' in slot && 'available' in slot),
    'partner availability: every slot needs a time and a flag',
    slotsResponse,
  );
  // Services CRUD, including the delete that must be refused.
  const blocked = ok(
    await partner.fetch('/api/partner/services', {
      method: 'POST',
      json: { name: 'Dịch vụ kiểm thử (có lịch)', category: 'nail', price: 199000, duration_min: 30 },
    }),
    'POST /api/partner/services',
  );
  assert(blocked.active === 1, 'partner service create: expected active = 1');
  ok(await partner.fetch(`/api/partner/services/${blocked.id}`), 'GET /api/partner/services/:id');
  // Favourited while it is still on sale, so hiding it below can be shown to take it
  // out of the customer's list.
  ok(
    await session('customer').fetch('/api/favorites', {
      method: 'POST',
      json: { service_id: blocked.id },
    }),
    'POST /api/favorites on the service that is about to be hidden',
  );
  const toggled = ok(
    await partner.fetch(`/api/partner/services/${blocked.id}`, { method: 'PATCH', json: { active: 0, price: 210000 } }),
    'PATCH /api/partner/services/:id',
  );
  assert(toggled.active === 0 && toggled.price === 210000, 'partner service patch: expected the new values');

  /* A service picture is rendered into an <img> on the menu and the service page, so the
     same rule as the salon cover holds here. */
  for (const value of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>']) {
    expectError(
      await partner.fetch(`/api/partner/services/${blocked.id}`, { method: 'PATCH', json: { image: value } }),
      400,
      'VALIDATION_ERROR',
      `PATCH /api/partner/services/:id with ${value.slice(0, 16)}…`,
    );
  }
  const imaged = ok(
    await partner.fetch(`/api/partner/services/${blocked.id}`, { method: 'PATCH', json: { image: '/uploads/ok.webp' } }),
    'PATCH /api/partner/services/:id with an uploaded path',
  );
  assert(imaged.image === '/uploads/ok.webp', 'partner service: a safe image path must be stored');

  // "Tạm ẩn dịch vụ" must actually hide it: gone from the customer side, still there
  // for the owner who hid it.
  expectError(
    await session('guest').fetch(`/api/services/${blocked.id}`),
    404,
    'NOT_FOUND',
    'GET /api/services/:id for a hidden service',
  );
  ok(
    await partner.fetch(`/api/partner/services/${blocked.id}`),
    'the partner console still sees the hidden service',
  );

  // Favourites follow the same rule as every other customer-facing listing.
  const favoritesResponse = await session('customer').fetch('/api/favorites');
  const favorites = ok(favoritesResponse, 'GET /api/favorites after the service was hidden');
  assert(
    !favorites.services.some((item) => item.id === blocked.id),
    'favorites: a hidden service must drop out of the list',
    favoritesResponse,
  );
  expectError(
    await session('customer').fetch('/api/favorites', {
      method: 'POST',
      json: { service_id: blocked.id },
    }),
    404,
    'NOT_FOUND',
    'POST /api/favorites with a hidden service',
  );
  const ownSalonId = ok(await partner.fetch('/api/partner/salon'), 'own salon id').id;
  expectError(
    await session('customer').fetch('/api/bookings', {
      method: 'POST',
      json: { salon_id: ownSalonId, service_id: blocked.id, date: tomorrow, time: '09:00' },
    }),
    400,
    'VALIDATION_ERROR',
    'POST /api/bookings on a hidden service',
  );

  // A walk-in dated into the past would silently rewrite the revenue history.
  expectError(
    await partner.fetch('/api/partner/bookings', {
      method: 'POST',
      json: {
        customer_name: 'Khách hôm qua',
        customer_phone: '0900 000 444',
        service_id: services[0].id,
        date: addDays(state.today, -1),
        time: '10:00',
      },
    }),
    400,
    'VALIDATION_ERROR',
    'POST /api/partner/bookings with a past date',
  );

  ok(
    await partner.fetch('/api/partner/bookings', {
      method: 'POST',
      json: {
        customer_name: 'Khách giữ chỗ',
        customer_phone: '0900 000 222',
        service_id: blocked.id,
        date: addDays(state.today, 2),
        time: '11:00',
      },
    }),
    'POST /api/partner/bookings on the test service',
  );
  expectError(
    await partner.fetch(`/api/partner/services/${blocked.id}`, { method: 'DELETE' }),
    409,
    'HAS_BOOKINGS',
    'DELETE a service with a future booking',
  );

  const disposable = ok(
    await partner.fetch('/api/partner/services', {
      method: 'POST',
      json: { name: 'Dịch vụ kiểm thử (xóa được)', category: 'nail', price: 99000, duration_min: 20 },
    }),
    'POST /api/partner/services (disposable)',
  );
  ok(await partner.fetch(`/api/partner/services/${disposable.id}`, { method: 'DELETE' }), 'DELETE a free service');
  expectError(
    await partner.fetch(`/api/partner/services/${disposable.id}`),
    404,
    'NOT_FOUND',
    'GET the deleted service',
  );

  // Staff CRUD.
  const staffListResponse = await partner.fetch('/api/partner/staff');
  const staffList = ok(staffListResponse, 'GET /api/partner/staff');
  assert(staffList.length > 0, 'partner staff: expected a roster', staffListResponse);
  assert('next_shift' in staffList[0] && 'shift' in staffList[0], 'partner staff: expected shift info', staffListResponse);
  for (const key of ['total', 'on_shift', 'rating_avg']) {
    assert(key in staffListResponse.body.meta, `partner staff: meta missing "${key}"`, staffListResponse);
  }

  const newStaff = ok(
    await partner.fetch('/api/partner/staff', {
      method: 'POST',
      json: {
        name: 'KTV Kiểm Thử',
        title: 'Nail Technician',
        schedule: [{ weekday: 1, start: '09:00', end: '17:00', is_off: 0 }],
        service_ids: [services[0].id],
      },
    }),
    'POST /api/partner/staff',
  );
  assert(newStaff.schedule.length === 1, 'partner staff create: expected the schedule to be stored');
  assert(newStaff.service_ids.includes(services[0].id), 'partner staff create: expected the service link');

  const renamed = ok(
    await partner.fetch(`/api/partner/staff/${newStaff.id}`, { method: 'PATCH', json: { name: 'KTV Đã Đổi Tên' } }),
    'PATCH /api/partner/staff/:id',
  );
  assert(renamed.name === 'KTV Đã Đổi Tên', 'partner staff patch: expected the new name');

  /* A technician's photo ends up in an <img> on the salon profile, like the cover and the
     service picture, so the whole router holds stored images to one rule. */
  for (const value of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>']) {
    expectError(
      await partner.fetch(`/api/partner/staff/${newStaff.id}`, { method: 'PATCH', json: { image: value } }),
      400,
      'VALIDATION_ERROR',
      `PATCH /api/partner/staff/:id with ${value.slice(0, 16)}…`,
    );
  }
  const pictured = ok(
    await partner.fetch(`/api/partner/staff/${newStaff.id}`, { method: 'PATCH', json: { image: '/uploads/ok.webp' } }),
    'PATCH /api/partner/staff/:id with an uploaded path',
  );
  assert(pictured.image === '/uploads/ok.webp', 'partner staff: a safe image path must be stored');

  const rescheduled = ok(
    await partner.fetch(`/api/partner/staff/${newStaff.id}/schedule`, {
      method: 'PUT',
      json: {
        schedule: [
          { weekday: 2, start: '10:00', end: '18:00', is_off: 0 },
          { weekday: 3, start: '10:00', end: '18:00', is_off: 1 },
        ],
      },
    }),
    'PUT /api/partner/staff/:id/schedule',
  );
  assert(rescheduled.schedule.length === 2, 'partner staff schedule: full replace must leave exactly 2 rows');
  assert(
    rescheduled.schedule.every((row) => row.weekday === 2 || row.weekday === 3),
    'partner staff schedule: the old weekday must be gone',
  );

  const foreignServices = ok(
    await session('guest').fetch(`/api/services?salon_id=${state.maisonId}&limit=1`),
    'a service from another salon',
  );
  expectError(
    await partner.fetch(`/api/partner/staff/${newStaff.id}/services`, {
      method: 'PUT',
      json: { service_ids: [foreignServices[0].id] },
    }),
    400,
    'VALIDATION_ERROR',
    'PUT staff services with a foreign-salon service id',
  );
  const relinked = ok(
    await partner.fetch(`/api/partner/staff/${newStaff.id}/services`, {
      method: 'PUT',
      json: { service_ids: [services[0].id, services[1].id] },
    }),
    'PUT /api/partner/staff/:id/services',
  );
  assert(relinked.service_ids.length === 2, 'partner staff services: full replace must leave exactly 2 links');

  ok(await partner.fetch(`/api/partner/staff/${newStaff.id}`, { method: 'DELETE' }), 'DELETE /api/partner/staff/:id');
  const softDeleted = ok(
    await partner.fetch(`/api/partner/staff/${newStaff.id}`),
    'GET /api/partner/staff/:id after delete',
  );
  assert(softDeleted.active === 0, 'partner staff delete: must be a soft delete (active = 0)');

  // The roster keeps showing a soft-deleted technician with their flag, but the headcount
  // counts working staff only — the same population meta.rating_avg averages over.
  const afterDeleteResponse = await partner.fetch('/api/partner/staff');
  const afterDelete = ok(afterDeleteResponse, 'GET /api/partner/staff after the soft delete');
  assert(
    afterDelete.some((member) => member.id === newStaff.id && member.active === 0),
    'partner staff: a soft-deleted technician must stay in the roster',
    afterDeleteResponse,
  );
  assert(
    afterDeleteResponse.body.meta.total === afterDelete.filter((member) => member.active === 1).length,
    'partner staff: meta.total must exclude soft-deleted staff',
    afterDeleteResponse,
  );

  // Promotions CRUD.
  const promotion = ok(
    await partner.fetch('/api/partner/promotions', {
      method: 'POST',
      json: {
        title: 'Ưu đãi kiểm thử',
        type: 'discount',
        discount_percent: 10,
        starts_at: state.today,
        ends_at: addDays(state.today, 30),
      },
    }),
    'POST /api/partner/promotions',
  );
  const promotionList = ok(await partner.fetch('/api/partner/promotions'), 'GET /api/partner/promotions');
  assert(
    promotionList.some((item) => item.id === promotion.id),
    'partner promotions: the new offer must be listed',
  );
  const deactivated = ok(
    await partner.fetch(`/api/partner/promotions/${promotion.id}`, { method: 'PATCH', json: { active: 0 } }),
    'PATCH /api/partner/promotions/:id',
  );
  assert(deactivated.active === 0, 'partner promotion patch: expected active = 0');
  ok(
    await partner.fetch(`/api/partner/promotions/${promotion.id}`, { method: 'DELETE' }),
    'DELETE /api/partner/promotions/:id',
  );

  // Revenue.
  for (const query of ['', '?group=week', '?group=month']) {
    const revenueResponse = await partner.fetch(`/api/partner/revenue${query}`);
    const revenue = ok(revenueResponse, `GET /api/partner/revenue${query}`);
    assert(Array.isArray(revenue.series), `revenue${query}: series must be an array`, revenueResponse);
    assert(Array.isArray(revenue.by_service), `revenue${query}: by_service must be an array`, revenueResponse);
    assert(Array.isArray(revenue.by_staff), `revenue${query}: by_staff must be an array`, revenueResponse);
    assert(
      Number.isFinite(revenue.totals.avg_ticket),
      `revenue${query}: totals.avg_ticket must be a finite number`,
      revenueResponse,
    );
  }

  // Salon profile round-trip.
  const salon = ok(await partner.fetch('/api/partner/salon'), 'GET /api/partner/salon');
  assert(Array.isArray(salon.tags) && Array.isArray(salon.amenities), 'partner salon: tags/amenities must be arrays');
  const newTags = [...salon.tags, 'Kiểm thử'];
  const updated = ok(
    await partner.fetch('/api/partner/salon', {
      method: 'PATCH',
      json: { tags: newTags, amenities: salon.amenities },
    }),
    'PATCH /api/partner/salon',
  );
  assert(
    Array.isArray(updated.tags) && updated.tags.join('|') === newTags.join('|'),
    'partner salon: tags must round-trip as a real array',
  );
  assert(
    Array.isArray(updated.amenities) && updated.amenities.join('|') === salon.amenities.join('|'),
    'partner salon: amenities must round-trip as a real array',
  );
  ok(
    await partner.fetch('/api/partner/salon', { method: 'PATCH', json: { tags: salon.tags } }),
    'PATCH /api/partner/salon (restore)',
  );

  /* The salon image is rendered straight into an <img> on the public profile, so it is
     held to the same rule as the gallery, the avatar and a post image: a path or an http(s)
     URL, never a scheme a browser would execute. */
  for (const value of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>']) {
    expectError(
      await partner.fetch('/api/partner/salon', { method: 'PATCH', json: { image: value } }),
      400,
      'VALIDATION_ERROR',
      `PATCH /api/partner/salon with ${value.slice(0, 16)}…`,
    );
  }
  const restoredImage = ok(
    await partner.fetch('/api/partner/salon', { method: 'PATCH', json: { image: '/uploads/ok.webp' } }),
    'PATCH /api/partner/salon with an uploaded path',
  );
  assert(restoredImage.image === '/uploads/ok.webp', 'partner salon: a safe image path must be stored');
  ok(
    await partner.fetch('/api/partner/salon', { method: 'PATCH', json: { image: salon.image } }),
    'PATCH /api/partner/salon (restore the cover image)',
  );

  const socialLinks = {
    facebook: 'https://m.facebook.com/LalaNail/?utm_source=smoke#about',
    instagram: 'https://instagram.com/lala.nail/?igsh=smoke',
    tiktok: 'https://m.tiktok.com/@lalanail/?lang=vi',
    youtube: 'https://m.youtube.com/@LalaNail/videos?si=smoke',
    zalo: 'https://zalo.me/lalanail/?utm_campaign=smoke',
  };
  const withSocial = ok(
    await partner.fetch('/api/partner/salon', { method: 'PATCH', json: { social_links: socialLinks } }),
    'PATCH /api/partner/salon (social links)',
  );
  assert(
    JSON.stringify(withSocial.social_links) === JSON.stringify({
      facebook: 'https://www.facebook.com/LalaNail',
      instagram: 'https://www.instagram.com/lala.nail',
      tiktok: 'https://www.tiktok.com/@lalanail',
      youtube: 'https://www.youtube.com/@LalaNail/videos',
      zalo: 'https://zalo.me/lalanail',
    }),
    'partner salon social links: all five links must normalize and round-trip',
  );
  const publicWithSocial = ok(await session('guest').fetch(`/api/salons/${salon.slug}`), 'public salon with social links');
  assert(publicWithSocial.social_links.instagram === withSocial.social_links.instagram, 'public salon: social links must be exposed');
  for (const [label, json] of [
    ['unknown platform', { social_links: { linkedin: 'https://linkedin.com/company/oak' } }],
    ['non-string link', { social_links: { facebook: 42 } }],
    ['wrong platform', { social_links: { facebook: 'https://instagram.com/lalanail' } }],
    ['homepage', { social_links: { youtube: 'https://www.youtube.com/' } }],
  ]) {
    expectError(await partner.fetch('/api/partner/salon', { method: 'PATCH', json }), 400, 'VALIDATION_ERROR', `PATCH partner salon social links: ${label}`);
  }
  expectError(
    await partner.fetch('/api/partner/salon', {
      method: 'PATCH',
      json: { name: salon.name, owner_id: 999999 },
    }),
    400,
    'VALIDATION_ERROR',
    'PATCH partner salon with a valid field plus an unknown top-level field',
  );
  expectError(await session('customer').fetch('/api/partner/salon', { method: 'PATCH', json: { social_links: {} } }), 403, 'FORBIDDEN', 'customer PATCH partner salon social links');
  expectError(await session('guest').fetch('/api/partner/salon', { method: 'PATCH', json: { social_links: {} } }), 401, 'UNAUTHENTICATED', 'guest PATCH partner salon social links');
  const clearedSocial = ok(await partner.fetch('/api/partner/salon', { method: 'PATCH', json: { social_links: {} } }), 'clear partner salon social links');
  assert(Object.values(clearedSocial.social_links).every((value) => value === null), 'partner salon social links: empty full replacement must clear every platform');
  ok(await partner.fetch('/api/partner/salon', {
    method: 'PATCH',
    json: { social_links: Object.fromEntries(Object.entries(salon.social_links).map(([platform, url]) => [platform, url || ''])) },
  }), 'restore partner salon social links');

  // Map coordinates: without these two columns the salon never gets a pin on the search map.
  const located = ok(
    await partner.fetch('/api/partner/salon', {
      method: 'PATCH',
      json: { lat: 10.7758, lng: 106.7009 },
    }),
    'PATCH /api/partner/salon (coordinates)',
  );
  assert(
    located.lat === 10.7758 && located.lng === 106.7009,
    'partner salon: coordinates must round-trip as numbers',
  );
  const reloaded = ok(
    await partner.fetch('/api/partner/salon'),
    'GET /api/partner/salon after the coordinate patch',
  );
  assert(
    reloaded.lat === 10.7758 && reloaded.lng === 106.7009,
    'partner salon: stored coordinates must survive a reload',
  );
  // Clearing is the other half of the round-trip: both columns go back to null together.
  const cleared = ok(
    await partner.fetch('/api/partner/salon', { method: 'PATCH', json: { lat: null, lng: null } }),
    'PATCH /api/partner/salon (clearing the coordinates)',
  );
  assert(
    cleared.lat === null && cleared.lng === null,
    'partner salon: clearing must null both coordinate columns',
  );
  const recleared = ok(
    await partner.fetch('/api/partner/salon'),
    'GET /api/partner/salon after the coordinates were cleared',
  );
  assert(
    recleared.lat === null && recleared.lng === null,
    'partner salon: cleared coordinates must stay null after a reload',
  );
  for (const [label, json] of [
    ['a latitude past the pole', { lat: 91, lng: 106.7 }],
    ['a longitude past the meridian', { lat: 10.7, lng: 181 }],
    ['a latitude that is not a number', { lat: 'abc', lng: 106.7 }],
    ['a latitude without its longitude', { lat: 10.7 }],
    ['a longitude without its latitude', { lng: 106.7 }],
    // Both keys present, but one parses to null: still half a coordinate.
    ['a latitude whose longitude is null', { lat: 10.7, lng: null }],
    ['a longitude whose latitude is null', { lat: null, lng: 106.7 }],
    ['a latitude whose longitude is blank', { lat: 10.7, lng: '' }],
  ]) {
    expectError(
      await partner.fetch('/api/partner/salon', { method: 'PATCH', json }),
      400,
      'VALIDATION_ERROR',
      `PATCH /api/partner/salon with ${label}`,
    );
  }
  ok(
    await partner.fetch('/api/partner/salon', {
      method: 'PATCH',
      json: { lat: salon.lat, lng: salon.lng },
    }),
    'PATCH /api/partner/salon (restore coordinates)',
  );

  // Opening hours: one row per weekday, replaced as a whole week.
  const workweek = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    start: '09:00',
    end: '21:00',
    is_off: weekday === 0 || weekday === 6 ? 1 : 0,
  }));
  const withHours = ok(
    await partner.fetch('/api/partner/salon', { method: 'PATCH', json: { hours: workweek } }),
    'PATCH /api/partner/salon (hours)',
  );
  assert(withHours.hours.length === 7, 'partner salon hours: expected one row per weekday');
  assert(
    withHours.hours.every((row, index) => row.weekday === index),
    'partner salon hours: rows must come back ordered by weekday',
  );
  assert(
    withHours.hours[1].start === '09:00' && withHours.hours[1].end === '21:00' && withHours.hours[1].is_off === 0,
    'partner salon hours: an open day must keep its times',
  );
  assert(
    withHours.hours[0].is_off === 1 && withHours.hours[6].is_off === 1,
    'partner salon hours: Sunday and Saturday must be stored closed',
  );
  assert(
    withHours.hours[0].start === null && withHours.hours[0].end === null,
    'partner salon hours: a day off carries no times',
  );
  assert(
    withHours.open_time === '09:00' && withHours.close_time === '21:00',
    'partner salon hours: the whole-week summary must span the open days',
  );
  const rereadHours = ok(
    await partner.fetch('/api/partner/salon'),
    'GET /api/partner/salon after the hours patch',
  );
  assert(
    JSON.stringify(rereadHours.hours) === JSON.stringify(withHours.hours),
    'partner salon hours: a re-read must echo the same week',
  );

  // A payload that is not exactly the seven distinct weekdays would silently close a day.
  expectError(
    await partner.fetch('/api/partner/salon', { method: 'PATCH', json: { hours: workweek.slice(0, 6) } }),
    400,
    'VALIDATION_ERROR',
    'PATCH /api/partner/salon with only six days',
  );
  expectError(
    await partner.fetch('/api/partner/salon', {
      method: 'PATCH',
      json: { hours: workweek.map((day) => ({ ...day, weekday: 1 })) },
    }),
    400,
    'VALIDATION_ERROR',
    'PATCH /api/partner/salon with a duplicated weekday',
  );
  expectError(
    await partner.fetch('/api/partner/salon', {
      method: 'PATCH',
      json: { hours: workweek.map((day) => ({ ...day, is_off: 0, start: '21:00', end: '09:00' })) },
    }),
    400,
    'VALIDATION_ERROR',
    'PATCH /api/partner/salon with an open day that closes before it opens',
  );
  // The pair is derived from the week now, so it is no longer a patchable column and a
  // body naming nothing else has nothing left to update.
  expectError(
    await partner.fetch('/api/partner/salon', { method: 'PATCH', json: { open_time: '07:00' } }),
    400,
    'VALIDATION_ERROR',
    'PATCH /api/partner/salon with open_time alone',
  );

  const publicSalon = ok(
    await session('guest').fetch(`/api/salons/${salon.slug}`),
    'GET /api/salons/:slug after the hours patch',
  );
  assert(publicSalon.hours.length === 7, 'public salon profile: expected the seven hours rows');
  assert(
    publicSalon.hours[6].is_off === 1 && publicSalon.hours[1].start === '09:00',
    'public salon profile: the week must match what the console stored',
  );

  // open_now is answered against today's own row. Open days run 00:00-23:59 so the
  // result never depends on the clock the suite happens to run at.
  ok(
    await partner.fetch('/api/partner/salon', {
      method: 'PATCH',
      json: { hours: weekClosedOn(weekdayOf(state.today)) },
    }),
    'PATCH /api/partner/salon (closed today)',
  );
  const whileClosed = await session('guest').fetch('/api/search/salons?open_now=1&limit=50');
  assert(
    !ok(whileClosed, 'GET /api/search/salons?open_now=1 (closed today)').some(
      (item) => item.id === salon.id,
    ),
    'search open_now=1: a salon closed today must drop out',
    whileClosed,
  );
  ok(
    await partner.fetch('/api/partner/salon', { method: 'PATCH', json: { hours: weekClosedOn(-1) } }),
    'PATCH /api/partner/salon (open every day)',
  );
  const whileOpen = await session('guest').fetch('/api/search/salons?open_now=1&limit=50');
  assert(
    ok(whileOpen, 'GET /api/search/salons?open_now=1 (open today)').some(
      (item) => item.id === salon.id,
    ),
    'search open_now=1: the salon must come back once today is open again',
    whileOpen,
  );
  // Booking availability is gated by the salon's hours too, not by the roster alone:
  // the seeded technicians work Monday to Saturday whatever the salon has declared.
  const bookable = await findStaffBookableSlot(salon.id);
  assert(bookable !== null, 'salon hours: needed a free technician slot to test against');
  const bookingBody = {
    salon_id: salon.id,
    service_id: bookable.service.id,
    staff_id: bookable.staffId,
    date: bookable.date,
    time: bookable.time,
  };

  ok(
    await partner.fetch('/api/partner/salon', {
      method: 'PATCH',
      json: { hours: weekClosedOn(weekdayOf(bookable.date)) },
    }),
    'PATCH /api/partner/salon (closing a day that had slots)',
  );
  const closedDay = await session('guest').fetch(
    `/api/services/${bookable.service.id}/availability?date=${bookable.date}`,
  );
  assert(
    ok(closedDay, 'GET /api/services/:id/availability on a closed day').slots.length === 0,
    'availability: a day the salon declared closed must offer no slot at all',
    closedDay,
  );
  // Rejected on the salon's hours, ahead of the technician's calendar: a closed day is
  // not somebody else having taken the slot, and the message must not say it was.
  expectError(
    await session('customer').fetch('/api/bookings', { method: 'POST', json: bookingBody }),
    400,
    'VALIDATION_ERROR',
    'POST /api/bookings naming a technician on a day the salon declared closed',
  );

  // A window narrower than the shift behind it, so the clamp alone decides the first and
  // the last slot: nothing may start before opening, and the service must end by closing.
  assert(
    bookable.service.duration_min <= 4 * 60,
    'clamp check: needed a service that fits inside the 10:00-14:00 window',
  );
  ok(
    await partner.fetch('/api/partner/salon', {
      method: 'PATCH',
      json: {
        hours: weekClosedOn(-1).map((day) =>
          day.weekday === weekdayOf(bookable.date) ? { ...day, start: '10:00', end: '14:00' } : day,
        ),
      },
    }),
    'PATCH /api/partner/salon (a narrow window on that day)',
  );
  const narrowedResponse = await session('guest').fetch(
    `/api/services/${bookable.service.id}/availability?date=${bookable.date}`,
  );
  const narrowed = ok(narrowedResponse, 'GET /api/services/:id/availability in a narrow window').slots;
  assert(narrowed.length > 0, 'availability: a narrowed window must still offer slots', narrowedResponse);
  assert(
    narrowed.every((slot) => slot.time >= '10:00'),
    'availability: no slot may start before the salon opens',
    narrowedResponse,
  );
  assert(
    narrowed[narrowed.length - 1].time <= hhmm(14 * 60 - bookable.service.duration_min),
    'availability: the last slot must leave room to finish by closing time',
    narrowedResponse,
  );

  // The control for the rejection above: the very same booking goes through once the
  // salon is open at that hour, so only the closure could have refused it.
  ok(
    await partner.fetch('/api/partner/salon', { method: 'PATCH', json: { hours: weekClosedOn(-1) } }),
    'PATCH /api/partner/salon (reopening every day)',
  );
  const nowAllowed = ok(
    await session('customer').fetch('/api/bookings', { method: 'POST', json: bookingBody }),
    'POST /api/bookings once the salon is open again',
  );
  assert(
    nowAllowed.date === bookable.date && nowAllowed.time === bookable.time,
    'availability: the booking the closed day refused must succeed when the salon is open',
  );

  // Back to the week this salon was carrying before the group touched it, read from the
  // API rather than rebuilt from the seed's own hours.
  const restoredHours = ok(
    await partner.fetch('/api/partner/salon', { method: 'PATCH', json: { hours: salon.hours } }),
    'PATCH /api/partner/salon (restore hours)',
  );
  assert(
    restoredHours.open_time === salon.open_time && restoredHours.close_time === salon.close_time,
    'partner salon hours: the restore must put the summary back',
  );

  // The gallery the public profile reads, managed from the console. Positions are stored,
  // not implied, so a swap is two writes and the read order has to follow them.
  const photosBefore = ok(await partner.fetch('/api/partner/photos'), 'GET /api/partner/photos');
  const addedPhoto = ok(
    await partner.fetch('/api/partner/photos', {
      method: 'POST',
      json: { image: '/uploads/smoke-gallery.png', caption: 'Ảnh kiểm thử' },
    }),
    'POST /api/partner/photos',
  );
  assert(
    addedPhoto.sort === photosBefore.length + 1,
    'partner photos: a new picture joins the end of the gallery',
  );
  const publicPhotos = ok(
    await session('guest').fetch(`/api/salons/${ownSalonId}/photos`),
    'GET /api/salons/:id/photos after adding one',
  );
  assert(
    publicPhotos.some((item) => item.id === addedPhoto.id),
    'partner photos: the public gallery must show what the console added',
  );
  ok(
    await partner.fetch(`/api/partner/photos/${addedPhoto.id}`, {
      method: 'PATCH',
      json: { sort: 0 },
    }),
    'PATCH /api/partner/photos/:id (move it to the front)',
  );
  const reordered = ok(
    await session('guest').fetch(`/api/salons/${ownSalonId}/photos`),
    'GET /api/salons/:id/photos after the move',
  );
  assert(
    reordered[0].id === addedPhoto.id,
    'partner photos: the public gallery must follow the stored order',
  );
  ok(
    await partner.fetch(`/api/partner/photos/${addedPhoto.id}`, { method: 'DELETE' }),
    'DELETE /api/partner/photos/:id',
  );
  assert(
    ok(await partner.fetch('/api/partner/photos'), 'GET /api/partner/photos after the delete')
      .length === photosBefore.length,
    'partner photos: the gallery must be back where it started',
  );

  // Menu order: two services trade positions and the public menu reads the new one.
  const menu = ok(await partner.fetch('/api/partner/services?limit=50'), 'the whole menu');
  assert(menu.length > 1, 'menu order: needed at least two services');
  const [first, second] = menu;
  ok(
    await partner.fetch(`/api/partner/services/${first.id}`, {
      method: 'PATCH',
      json: { sort_order: second.sort_order },
    }),
    'PATCH /api/partner/services/:id (sort_order)',
  );
  ok(
    await partner.fetch(`/api/partner/services/${second.id}`, {
      method: 'PATCH',
      json: { sort_order: first.sort_order },
    }),
    'PATCH /api/partner/services/:id (the other half of the swap)',
  );
  const reorderedMenu = ok(
    await partner.fetch('/api/partner/services?limit=50'),
    'the reordered menu',
  );
  assert(
    reorderedMenu[0].id === second.id,
    'menu order: the console list must follow sort_order',
  );
  const publicSwapped = ok(
    await session('guest').fetch(`/api/salons/${ownSalonId}/services`),
    'GET /api/salons/:id/services after the swap',
  );
  const activeIds = publicSwapped.map((item) => item.id);
  assert(
    activeIds.indexOf(second.id) < activeIds.indexOf(first.id) || !activeIds.includes(first.id),
    'menu order: the public menu must follow the same order',
    publicSwapped,
  );

  const searchResults = ok(await partner.fetch('/api/partner/search?q=Minh'), 'GET /api/partner/search?q=');
  assert(searchResults.length > 0, 'partner search: expected matches');
  assert(
    searchResults.every((item) => 'type' in item && 'id' in item && 'label' in item),
    'partner search: expected {type,id,label} entries',
  );

  // The receptionist reads the number off a caller ID, without the spaces it was saved
  // with. Both spellings have to find the same bookings, or the box looks broken in the
  // one moment it exists for.
  const byDigits = ok(
    await partner.fetch('/api/partner/search?q=0901234567'),
    'GET /api/partner/search?q=<digits only>',
  );
  const bySpaced = ok(
    await partner.fetch(`/api/partner/search?q=${encodeURIComponent('0901 234 567')}`),
    'GET /api/partner/search?q=<number with spaces>',
  );
  const bookingIds = (rows) => rows.filter((item) => item.type === 'booking').map((item) => item.id).sort();
  assert(bookingIds(byDigits).length > 0, 'partner search: a phone number must find its bookings');
  assert(
    JSON.stringify(bookingIds(byDigits)) === JSON.stringify(bookingIds(bySpaced)),
    'partner search: the spacing of a number must not change what it finds',
  );
}

/* ============================================================================
 * 15 — authz and scoping negatives
 * ========================================================================= */

async function groupAuthz() {
  const partnerA = session('partnerA');
  const partnerB = session('partnerB');

  expectError(
    await session('customer').fetch('/api/partner/overview'),
    403,
    'FORBIDDEN',
    'customer hitting /api/partner/overview',
  );
  expectError(
    await session('guest').fetch('/api/bookings/mine'),
    401,
    'UNAUTHENTICATED',
    'guest hitting /api/bookings/mine',
  );

  const otherServices = ok(await partnerB.fetch('/api/partner/services'), "partner B's own services");
  const otherBooking = ok(
    await partnerB.fetch('/api/partner/bookings', {
      method: 'POST',
      json: {
        customer_name: 'Khách của salon khác',
        customer_phone: '0900 000 333',
        service_id: otherServices[0].id,
        date: addDays(state.today, 1),
        time: '10:00',
      },
    }),
    "a booking inside partner B's salon",
  );
  // 404, never 403: a 403 would confirm the id exists.
  expectError(
    await partnerA.fetch(`/api/partner/bookings/${otherBooking.id}`),
    404,
    'NOT_FOUND',
    "partner A fetching partner B's booking",
  );

  const unknown = await session('guest').fetch('/api/khong-ton-tai');
  expectError(unknown, 404, 'NOT_FOUND', 'unknown /api/* path');
  assert(
    (unknown.contentType ?? '').includes('application/json'),
    'unknown /api/* path: must answer with JSON, not the static index.html',
    unknown,
  );

  // A self-registered salon starts as a draft: verified on creation, but unlisted until
  // its owner has given it an address, a week, a service and a picture and switched it on.
  const stamp = Date.now();
  const salonName = `Salon Tự Đăng Ký ${stamp}`;
  const applicant = new Session();
  const registered = ok(
    await applicant.fetch('/api/auth/register', {
      method: 'POST',
      json: {
        name: 'Đối tác tự đăng ký',
        email: `smoke-partner-${stamp}@oak.vn`,
        password: 'Oak@1234',
        role: 'partner',
        salon_name: salonName,
        // Registration takes an affirmative consent, so a caller that leaves it out is
        // refused — the form ticks it, and so does this.
        consent: true,
      },
    }),
    'POST /api/auth/register (partner)',
  );
  assert(registered.user.role === 'partner', 'self-registration: expected a partner account');

  const ownSalon = ok(await applicant.fetch('/api/partner/salon'), 'the self-registered salon');
  assert(ownSalon.name === salonName, 'self-registration: the salon must exist for its owner');
  assert(ownSalon.verified === 1, 'self-registration: a new salon is verified on creation');

  // Group 16 sweeps the public list for salons without a demo owner; this one is a
  // deliberate artifact of the test run, so record it there for exclusion.
  state.selfRegisteredSalonIds = [...(state.selfRegisteredSalonIds ?? []), ownSalon.id];

  assert(ownSalon.published === 0, 'self-registration: a new salon starts unlisted');

  // The welcome offer is created in the same transaction as the salon, so it has to be
  // just as invisible while the salon is a draft: GET /api/promotions gates on the salon
  // being published, or a sign-up would put a name of the applicant's choosing on
  // uu-dai.html the moment the account existed.
  const draftOffers = await session('guest').fetch('/api/promotions');
  assert(
    !ok(draftOffers, 'GET /api/promotions (with a draft salon around)').some(
      (item) => item.code === welcomeCode(ownSalon.id) || item.salon?.name === salonName,
    ),
    "GET /api/promotions: a draft salon's welcome offer must not be listed",
    draftOffers,
  );

  for (const [route, label] of [
    ['/api/salons?limit=50', 'GET /api/salons'],
    ['/api/salons?sort=newest&limit=50', 'GET /api/salons?sort=newest'],
    [`/api/search/salons?q=${encodeURIComponent(salonName)}`, 'GET /api/search/salons'],
  ]) {
    const hidden = await session('guest').fetch(route);
    assert(
      !ok(hidden, label).some((item) => item.id === ownSalon.id),
      `${label}: a draft salon must not be listed`,
      hidden,
    );
  }
  // Its owner still has somewhere to preview it: the profile route answers by slug.
  const draftProfile = await session('guest').fetch(`/api/salons/${ownSalon.slug}`);
  assert(
    ok(draftProfile, 'GET /api/salons/:slug for a draft').id === ownSalon.id,
    'a draft salon must stay reachable by its own slug',
    draftProfile,
  );

  // Nothing set up yet, so the refusal has to name all four conditions.
  const notReady = await applicant.fetch('/api/partner/salon', {
    method: 'PATCH',
    json: { published: 1 },
  });
  expectError(notReady, 409, 'SALON_NOT_READY', 'PATCH published=1 on an empty profile');
  for (const wanted of ['địa chỉ', 'giờ mở cửa', 'dịch vụ', 'ảnh']) {
    assert(
      String(notReady.body?.error?.message ?? '').includes(wanted),
      `PATCH published=1: the refusal must name the missing "${wanted}"`,
      notReady,
    );
  }

  ok(
    await applicant.fetch('/api/partner/salon', {
      method: 'PATCH',
      json: { address: '1 Thủ Khoa Huân, Quận 1', image: 'assets/images/img-d469cbe2a5.jpg' },
    }),
    'PATCH /api/partner/salon (address and cover for the draft)',
  );
  const draftService = ok(
    await applicant.fetch('/api/partner/services', {
      method: 'POST',
      json: {
        name: 'Nhuộm tóc theo độ dài',
        category: 'hair',
        price: 250000,
        duration_min: 60,
        price_is_from: 1,
      },
    }),
    'POST /api/partner/services (the draft menu)',
  );
  assert(draftService.price_is_from === 1, 'services: the "from" price flag must be stored');
  assert(draftService.sort_order === 1, 'services: the first service takes position 1');

  // Only the week is still missing, so the refusal must have narrowed to it alone.
  const stillNotReady = await applicant.fetch('/api/partner/salon', {
    method: 'PATCH',
    json: { published: 1 },
  });
  expectError(stillNotReady, 409, 'SALON_NOT_READY', 'PATCH published=1 without opening hours');
  assert(
    !String(stillNotReady.body?.error?.message ?? '').includes('địa chỉ'),
    'PATCH published=1: a condition that is met must not be named as missing',
    stillNotReady,
  );

  ok(
    await applicant.fetch('/api/partner/salon', {
      method: 'PATCH',
      json: { hours: weekClosedOn(-1) },
    }),
    'PATCH /api/partner/salon (the draft week)',
  );
  const published = ok(
    await applicant.fetch('/api/partner/salon', { method: 'PATCH', json: { published: 1 } }),
    'PATCH /api/partner/salon (going live)',
  );
  assert(published.published === 1, 'going live: expected published = 1');

  const publicList = await session('guest').fetch('/api/salons?limit=50');
  assert(
    ok(publicList, 'public salon list').some((item) => item.id === ownSalon.id),
    'a published salon must appear in GET /api/salons',
    publicList,
  );
  const publicSearch = await session('guest').fetch(
    `/api/search/salons?q=${encodeURIComponent(salonName)}`,
  );
  assert(
    ok(publicSearch, 'public salon search').some((item) => item.id === ownSalon.id),
    'a published salon must appear in GET /api/search/salons',
    publicSearch,
  );
  // And the offer the salon joined with comes into view with it — 20% off, under the
  // salon's own code. The gate above is a gate, not a blanket hide.
  const liveOffers = await session('guest').fetch('/api/promotions');
  const ownOffer = ok(liveOffers, 'GET /api/promotions (once the salon is live)').find(
    (item) => item.code === welcomeCode(ownSalon.id),
  );
  assert(ownOffer !== undefined, "a published salon's welcome offer must be listed", liveOffers);
  assert(
    ownOffer.discount_percent === WELCOME_PERCENT && ownOffer.salon?.name === salonName,
    'the welcome offer must carry its salon and its 20%',
    liveOffers,
  );

  // The public menu carries the flag the console set, so the profile can print "từ ...".
  const publicMenu = await session('guest').fetch(`/api/salons/${ownSalon.id}/services`);
  assert(
    ok(publicMenu, 'GET /api/salons/:id/services').some(
      (item) => item.id === draftService.id && item.price_is_from === true,
    ),
    'the public menu must carry price_is_from',
    publicMenu,
  );

  // The console's publish gate reads meta.active_total, so the count it ticks the
  // "one visible service" row from has to be the count the server refuses on.
  const countsListed = await applicant.fetch('/api/partner/services?limit=1');
  ok(countsListed, 'GET /api/partner/services (counts)');
  assert(
    countsListed.body.meta.total === 1 && countsListed.body.meta.active_total === 1,
    'partner services: meta must carry both counts',
    countsListed,
  );
  ok(
    await applicant.fetch(`/api/partner/services/${draftService.id}`, {
      method: 'PATCH',
      json: { active: 0 },
    }),
    'PATCH /api/partner/services/:id (hiding the only service)',
  );
  const countsHidden = await applicant.fetch('/api/partner/services?limit=1');
  ok(countsHidden, 'GET /api/partner/services (counts after hiding)');
  assert(
    countsHidden.body.meta.total === 1 && countsHidden.body.meta.active_total === 0,
    'partner services: a hidden service counts in total but not in active_total',
    countsHidden,
  );

  // Hiding the last visible service is allowed, but a listed salon with an empty menu is
  // not: the salon drops back to draft instead, and its owner is told why.
  const demoted = ok(
    await applicant.fetch('/api/partner/salon'),
    'GET /api/partner/salon after hiding the only service',
  );
  assert(
    demoted.published === 0,
    'hiding the last visible service must take the salon off the public list',
    demoted,
  );
  const demotionNotice = ok(
    await applicant.fetch('/api/notifications?limit=5'),
    'GET /api/notifications after the demotion',
  );
  assert(
    demotionNotice.some((item) => item.title === 'Salon đã tạm ẩn khỏi OAK'),
    'the demotion must leave the owner a notification saying so',
    demotionNotice,
  );

  ok(
    await applicant.fetch(`/api/partner/services/${draftService.id}`, {
      method: 'PATCH',
      json: { active: 1 },
    }),
    'PATCH /api/partner/services/:id (showing it again)',
  );
  ok(
    await applicant.fetch('/api/partner/salon', { method: 'PATCH', json: { published: 1 } }),
    'PATCH /api/partner/salon (going live again)',
  );

  // A save that touches nothing publishing depends on is none of the gate's business:
  // an owner must be able to write a phone number without the salon's whole checklist
  // being re-run against them.
  const unrelatedSave = ok(
    await applicant.fetch('/api/partner/salon', {
      method: 'PATCH',
      json: { phone: '0900000001' },
    }),
    'a listed salon can save a field publishing does not depend on',
  );
  assert(
    unrelatedSave.phone === '0900000001' && unrelatedSave.published === 1,
    'the unrelated save must go through and leave the salon listed',
    unrelatedSave,
  );

  // Readiness is judged on the row a save writes, not the one it read: a save that takes
  // away what listing requires is refused, and one request cannot both list a salon and
  // remove a condition of listing.
  const blankedAddress = await applicant.fetch('/api/partner/salon', {
    method: 'PATCH',
    json: { address: '' },
  });
  expectError(
    blankedAddress,
    409,
    'SALON_NOT_READY',
    'a listed salon cannot blank the address it is listed with',
  );

  const selfContradicting = await applicant.fetch('/api/partner/salon', {
    method: 'PATCH',
    json: { published: 1, address: '' },
  });
  expectError(
    selfContradicting,
    409,
    'SALON_NOT_READY',
    'PATCH published=1 that blanks the address',
  );
  const intact = ok(
    await applicant.fetch('/api/partner/salon'),
    'GET /api/partner/salon after a refused save',
  );
  assert(
    intact.address === '1 Thủ Khoa Huân, Quận 1' && intact.published === 1,
    'a refused save must leave the salon exactly as it was',
  );

  skip('PARTNER_NO_SALON is unreachable: /api/auth/partner/register always creates a salon');
}

/* ============================================================================
 * 16 — one salon per partner
 * ========================================================================= */

// The console derives its salon from the signed-in owner and shows exactly one, so a
// salon whose owner also owns another one has no reachable partner console at all.
const DEMO_SALON_OWNERS = {
  'lala-nail-studio': 'doitac@oak.vn',
  'maison-de-beaute': 'minhchau@oak.vn',
  'the-hair-studio': 'diemquynh@oak.vn',
  'glow-skincare-clinic': 'tuyetnhung@oak.vn',
  'the-muse-beauty-bar': 'hamy@oak.vn',
  'the-bare-studio': 'quochuy@oak.vn',
};

async function groupSalonOwnership() {
  const listResponse = await session('guest').fetch('/api/salons?limit=50');
  const listed = ok(listResponse, 'GET /api/salons for the ownership sweep');

  // Salons the suite itself registered in group 15 are expected to have no demo owner.
  const selfRegistered = new Set(state.selfRegisteredSalonIds ?? []);
  const salons = listed.filter((salon) => !selfRegistered.has(salon.id));

  // The sweep runs over the public list, not over DEMO_SALON_OWNERS: a seeded salon
  // without an owner of its own must fail here rather than quietly ship without a
  // console, and only a list-driven sweep can catch one that was never expected.
  for (const salon of salons) {
    const email = DEMO_SALON_OWNERS[salon.slug];
    assert(email !== undefined, `salon ownership: "${salon.slug}" has no demo partner account`, listResponse);

    const { client } = await login(email);
    const ownResponse = await client.fetch('/api/partner/salon');
    const own = ok(ownResponse, `GET /api/partner/salon as ${email}`);
    assert(
      own.id === salon.id,
      `salon ownership: ${email} must reach "${salon.slug}", got "${own.slug}"`,
      ownResponse,
    );
  }

  // Against meta.total, not the page: ?limit=50 is already at MAX_LIMIT, and the public
  // list grows by one for every test that registers a partner.
  // Assumes a fresh database, which the default run gets. Under OAK_TEST_BASE_URL the
  // salons registered here survive the run and are not in state.selfRegisteredSalonIds
  // next time, so repeated external-mode runs accumulate them and fail this count.
  assert(
    listResponse.body.meta.total - selfRegistered.size === Object.keys(DEMO_SALON_OWNERS).length,
    `salon ownership: expected all ${Object.keys(DEMO_SALON_OWNERS).length} seeded salons in the public list`,
    listResponse,
  );
}

/* ============================================================================
 * 17 — booking lifecycle: online-booking settings, no-show, days off
 * ========================================================================= */

/** 'HH:MM' -> minutes since midnight; the reverse of hhmm() above. */
function minutesOf(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

async function groupBookingLifecycle() {
  const partner = session('partnerA');
  const customer = session('customer');
  const guest = session('guest');
  const yesterday = addDays(state.today, -1);

  /* -- the settings themselves ------------------------------------------------ */

  const before = ok(await partner.fetch('/api/partner/salon'), 'salon before the lifecycle block');
  for (const [key, value] of [
    ['auto_confirm', 1],
    ['lead_time_min', 0],
    ['cancel_cutoff_hours', 2],
  ]) {
    assert(before[key] === value, `salon settings: ${key} must default to ${value}`);
  }
  assert('cancel_policy_text' in before, 'salon settings: cancel_policy_text must be exposed');

  // null is in here because Number(null) is 0 — a legal lead time — so a client sending it
  // to mean "leave this alone" used to silently reset the setting.
  for (const [field, bad] of [
    ['lead_time_min', 45],
    ['lead_time_min', null],
    ['lead_time_min', ''],
    ['cancel_cutoff_hours', 3],
  ]) {
    expectError(
      await partner.fetch('/api/partner/salon', { method: 'PATCH', json: { [field]: bad } }),
      400,
      'VALIDATION_ERROR',
      `PATCH /api/partner/salon with an unlisted ${field}`,
    );
  }
  expectError(
    await partner.fetch('/api/partner/salon', {
      method: 'PATCH',
      json: { cancel_policy_text: 'x'.repeat(201) },
    }),
    400,
    'VALIDATION_ERROR',
    'PATCH /api/partner/salon with an over-long cancel policy',
  );

  // Round the clock for this whole group, so nothing below depends on the hour the suite
  // runs at; the hours the salon started with go back at the end.
  ok(
    await partner.fetch('/api/partner/salon', { method: 'PATCH', json: { hours: weekClosedOn(-1) } }),
    'PATCH /api/partner/salon (round the clock for the lifecycle group)',
  );

  /* -- auto_confirm off: the booking waits, and carries the salon's policy ----- */

  const policy = 'Báo trước 24 tiếng giúp salon xếp lại lịch.';
  ok(
    await partner.fetch('/api/partner/salon', {
      method: 'PATCH',
      json: { auto_confirm: 0, cancel_cutoff_hours: 24, cancel_policy_text: policy },
    }),
    'PATCH /api/partner/salon (manual confirmation, 24h cutoff)',
  );

  const manualSlot = await findBookableSlot(state.lalaId);
  assert(manualSlot !== null, 'auto_confirm: needed a free slot to book');
  const waiting = ok(
    await customer.fetch('/api/bookings', {
      method: 'POST',
      json: {
        salon_id: state.lalaId,
        service_id: manualSlot.service.id,
        date: manualSlot.date,
        time: manualSlot.time,
      },
    }),
    'POST /api/bookings with auto_confirm off',
  );
  assert(waiting.status === 'pending', 'auto_confirm off: expected status pending');
  assert(
    waiting.salon.cancel_cutoff_hours === 24 && waiting.salon.cancel_policy_text === policy,
    'booking payload: expected the salon own cancel policy',
  );

  /* -- the cutoff the salon set, not the platform default --------------------- */

  // Half an hour from now: always still ahead, always well inside 24 hours, and it rolls
  // into tomorrow by itself near midnight — "today at 23:45" had already started when the
  // suite ran in the last quarter of an hour of a day. Only the salon may move a booking
  // onto an hour that close.
  const soon = new Date(Date.now() + 30 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  const soonDate = `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}`;
  const soonTime = `${pad(soon.getHours())}:${pad(soon.getMinutes())}`;
  ok(
    await partner.fetch(`/api/partner/bookings/${waiting.id}`, {
      method: 'PATCH',
      json: { date: soonDate, time: soonTime },
    }),
    'PATCH /api/partner/bookings/:id (inside the 24h cutoff)',
  );
  const refused = await customer.fetch(`/api/bookings/${waiting.id}/cancel`, { method: 'PATCH' });
  expectError(refused, 409, 'CANCEL_WINDOW', 'cancelling inside the salon-set 24h cutoff');
  assert(
    refused.body?.error?.message.includes('24 tiếng'),
    'cancel window: the message must name the 24 hours this salon asked for',
    refused,
  );

  /* -- lead time -------------------------------------------------------------- */

  ok(
    await partner.fetch('/api/partner/salon', { method: 'PATCH', json: { lead_time_min: 120 } }),
    'PATCH /api/partner/salon (two hours of lead time)',
  );
  const clock = new Date();
  const floor = clock.getHours() * 60 + clock.getMinutes() + 120;
  const leadDay = ok(
    await guest.fetch(`/api/services/${manualSlot.service.id}/availability?date=${state.today}`),
    'GET /api/services/:id/availability?date=today with a two-hour lead time',
  );
  assert(
    leadDay.slots.every((slot) => minutesOf(slot.time) >= floor),
    'lead time: no slot inside the next two hours may be offered',
  );

  ok(
    await partner.fetch('/api/partner/salon', { method: 'PATCH', json: { lead_time_min: 1440 } }),
    'PATCH /api/partner/salon (a full day of lead time)',
  );
  const shutToday = ok(
    await guest.fetch(`/api/services/${manualSlot.service.id}/availability?date=${state.today}`),
    'GET /api/services/:id/availability?date=today with a day of lead time',
  );
  assert(shutToday.slots.length === 0, 'lead time: a full day of it leaves today with nothing');
  ok(
    await partner.fetch('/api/partner/salon', { method: 'PATCH', json: { lead_time_min: 0 } }),
    'PATCH /api/partner/salon (lead time back to none)',
  );

  /* -- no-show, and the Undo out of it ---------------------------------------- */

  const revenueBefore = ok(
    await partner.fetch(`/api/partner/revenue?from=${yesterday}&to=${yesterday}`),
    'GET /api/partner/revenue before the no-show',
  ).totals;

  ok(
    await partner.fetch(`/api/partner/bookings/${waiting.id}`, {
      method: 'PATCH',
      json: { status: 'confirmed' },
    }),
    'PATCH /api/partner/bookings/:id pending -> confirmed',
  );
  expectError(
    await partner.fetch(`/api/partner/bookings/${waiting.id}`, {
      method: 'PATCH',
      json: { status: 'no_show' },
    }),
    409,
    'BOOKING_NOT_STARTED',
    'marking a booking no-show before its start time',
  );

  ok(
    await partner.fetch(`/api/partner/bookings/${waiting.id}`, {
      method: 'PATCH',
      json: { date: yesterday },
    }),
    'PATCH /api/partner/bookings/:id (move it into yesterday)',
  );
  const absent = ok(
    await partner.fetch(`/api/partner/bookings/${waiting.id}`, {
      method: 'PATCH',
      json: { status: 'no_show' },
    }),
    'PATCH /api/partner/bookings/:id confirmed -> no_show',
  );
  assert(absent.status === 'no_show', 'no-show: expected status no_show');
  assert(
    absent.customer.no_show_count >= 1,
    'no-show: the customer shape must count it beside completed_count',
  );

  const toldResponse = await customer.fetch('/api/notifications');
  const told = ok(toldResponse, 'GET /api/notifications after the no-show');
  assert(
    told.some((item) => item.booking_id === waiting.id && /không đến/.test(item.body ?? '')),
    'no-show: the customer must be told',
    toldResponse,
  );

  // The customer's own "Đã qua" tab is the only place an absence is visible to them, and
  // it is a filter of its own: the review gates elsewhere ask for 'completed' and must not
  // offer a review for a visit that never happened.
  const pastTab = ok(
    await customer.fetch('/api/bookings/mine?status=past&limit=50'),
    'GET /api/bookings/mine?status=past after the no-show',
  );
  assert(
    pastTab.some((item) => item.id === waiting.id && item.status === 'no_show'),
    'no-show: the customer must find it in the past tab',
  );
  assert(
    !ok(
      await customer.fetch('/api/bookings/mine?status=completed&limit=50'),
      'GET /api/bookings/mine?status=completed after the no-show',
    ).some((item) => item.id === waiting.id),
    'no-show: it is not a completed visit',
  );

  const revenueAfter = ok(
    await partner.fetch(`/api/partner/revenue?from=${yesterday}&to=${yesterday}`),
    'GET /api/partner/revenue after the no-show',
  ).totals;
  assert(
    revenueAfter.revenue === revenueBefore.revenue && revenueAfter.bookings === revenueBefore.bookings,
    'no-show: revenue counts completed bookings only',
  );

  const undone = ok(
    await partner.fetch(`/api/partner/bookings/${waiting.id}`, {
      method: 'PATCH',
      json: { status: 'confirmed' },
    }),
    'PATCH /api/partner/bookings/:id no_show -> confirmed (Undo)',
  );
  assert(undone.status === 'confirmed', 'no-show Undo: expected status confirmed');

  /* -- days off --------------------------------------------------------------- */

  /* Five days out — unless that lands on a Sunday, which offers nothing to close: every
     seeded technician is expanded over weekdays 1-6 only (seed.js), so getServiceSlots
     finds no shift at all on a weekday 0 and returns an empty list for every service.
     The round-the-clock week this group opens with cannot help, because that patches
     salon_hours, not staff_schedule. Same dodge as group 5 makes for the same reason.
     The replacement is +6 rather than +7: the week shapes below are read from today, so
     the day being closed has to be one of their seven. */
  const wantedOff = addDays(state.today, 5);
  const offDate = weekdayOf(wantedOff) === 0 ? addDays(state.today, 6) : wantedOff;
  const openBefore = ok(
    await guest.fetch(`/api/services/${manualSlot.service.id}/availability?date=${offDate}`),
    'GET /api/services/:id/availability before the salon closes that day',
  ).slots;
  assert(openBefore.length > 0, 'time off: needed a day that offers slots to close');
  const openTime = openBefore.find((slot) => slot.available)?.time;
  assert(openTime !== undefined, 'time off: needed a free slot on the day being closed');
  const performers = ok(
    await guest.fetch(`/api/services/${manualSlot.service.id}/staff`),
    'performers of the service used for the staff day off',
  );
  assert(performers.length > 0, 'time off: needed a performer to send on leave');

  expectError(
    await partner.fetch('/api/partner/time-off', {
      method: 'POST',
      json: { date_from: offDate, date_to: addDays(offDate, -1) },
    }),
    400,
    'VALIDATION_ERROR',
    'POST /api/partner/time-off ending before it starts',
  );
  expectError(
    await partner.fetch('/api/partner/time-off', {
      method: 'POST',
      json: { date_from: offDate, date_to: addDays(offDate, 120) },
    }),
    400,
    'VALIDATION_ERROR',
    'POST /api/partner/time-off over the maximum length',
  );

  const closure = ok(
    await partner.fetch('/api/partner/time-off', {
      method: 'POST',
      json: { date_from: offDate, date_to: offDate, reason: 'Nghỉ lễ' },
    }),
    'POST /api/partner/time-off (whole salon)',
  );
  assert(closure.staff_id === null, 'time off: a whole-salon closure carries no staff_id');
  const liveThatDay = ok(
    await partner.fetch(`/api/partner/bookings?date=${offDate}&limit=50`),
    'partner bookings on the day being closed',
  ).filter((item) => ['pending', 'confirmed'].includes(item.status)).length;
  assert(
    closure.affected_bookings === liveThatDay,
    'time off: affected_bookings must count the live bookings inside the range',
  );

  assert(
    ok(
      await guest.fetch(`/api/services/${manualSlot.service.id}/availability?date=${offDate}`),
      'GET /api/services/:id/availability on a closed day',
    ).slots.length === 0,
    'time off: a closed day offers no slot at all',
  );
  // ...and the week shape says WHY it is empty, or the wizard's day strip would strike a
  // declared day off through as "full" instead of labelling it "Nghỉ".
  const closedWeek = ok(
    await guest.fetch(`/api/services/${manualSlot.service.id}/availability?days=7&from=${state.today}`),
    'GET /api/services/:id/availability?days=7 around a closed day',
  ).week;
  assert(
    closedWeek.find((day) => day.date === offDate)?.closed === true,
    'time off: the week shape must mark the closed day closed:true',
  );
  assert(
    closedWeek.every((day) => typeof day.closed === 'boolean'),
    'time off: every day of the week shape carries a closed flag',
  );
  // The wizard calls the staff endpoint instead the moment a technician is chosen, so the
  // flag has to be on that shape too — without it the strip strikes the declared day off
  // through as "full", which is the confusion the flag exists to remove.
  const closedStaffWeek = ok(
    await guest.fetch(
      `/api/staff/${performers[0].id}/availability?days=7&from=${state.today}&service_id=${manualSlot.service.id}`,
    ),
    'GET /api/staff/:id/availability?days=7&service_id= around a closed day',
  ).week;
  assert(
    closedStaffWeek.find((day) => day.date === offDate)?.closed === true,
    'time off: the staff week shape must mark the salon closure closed:true',
  );
  assert(
    closedStaffWeek.every((day) => typeof day.closed === 'boolean'),
    'time off: every day of the staff week shape carries a closed flag',
  );
  expectError(
    await customer.fetch('/api/bookings', {
      method: 'POST',
      json: {
        salon_id: state.lalaId,
        service_id: manualSlot.service.id,
        date: offDate,
        time: openTime,
      },
    }),
    409,
    'SALON_CLOSED',
    'POST /api/bookings on a day the salon declared off',
  );

  const listed = ok(await partner.fetch('/api/partner/time-off'), 'GET /api/partner/time-off');
  assert(
    listed.some((row) => row.id === closure.id && row.reason === 'Nghỉ lễ'),
    'time off: the new row must be listed',
  );

  ok(
    await partner.fetch(`/api/partner/time-off/${closure.id}`, { method: 'DELETE' }),
    'DELETE /api/partner/time-off/:id',
  );
  assert(
    ok(
      await guest.fetch(`/api/services/${manualSlot.service.id}/availability?date=${offDate}`),
      'GET /api/services/:id/availability after the closure is dropped',
    ).slots.length === openBefore.length,
    'time off: dropping the closure gives the day back',
  );

  // One technician off is not the salon being shut: the service keeps the hours its other
  // performers cover, and only that one week grid reports itself closed.
  const leave = ok(
    await partner.fetch('/api/partner/time-off', {
      method: 'POST',
      json: { staff_id: performers[0].id, date_from: offDate, reason: 'Nghỉ phép' },
    }),
    'POST /api/partner/time-off (one technician)',
  );
  assert(leave.date_to === offDate, 'time off: a missing date_to means a single day');
  assert(leave.staff_name === performers[0].name, 'time off: expected the technician named back');

  // Its own 409: SLOT_TAKEN would claim somebody just took the hour and send the customer
  // hunting through a day that has none.
  expectError(
    await customer.fetch('/api/bookings', {
      method: 'POST',
      json: {
        salon_id: state.lalaId,
        service_id: manualSlot.service.id,
        staff_id: performers[0].id,
        date: offDate,
        time: openTime,
      },
    }),
    409,
    'STAFF_OFF',
    'POST /api/bookings naming a technician who is on leave that day',
  );

  const grid = ok(
    await guest.fetch(`/api/staff/${performers[0].id}/availability?from=${offDate}&days=1`),
    'GET /api/staff/:id/availability on the technician day off',
  ).week[0];
  assert(grid.closed === true, 'time off: the week grid must mark the day closed');
  assert(grid.slots.length === 0, 'time off: a technician on leave offers no slot');
  const serviceGrid = ok(
    await guest.fetch(
      `/api/staff/${performers[0].id}/availability?from=${offDate}&days=1&service_id=${manualSlot.service.id}`,
    ),
    'GET /api/staff/:id/availability?service_id= on the technician day off',
  ).week[0];
  assert(
    serviceGrid.closed === true,
    'time off: the service-sized staff grid must mark the technician day off too',
  );

  ok(
    await partner.fetch(`/api/partner/time-off/${leave.id}`, { method: 'DELETE' }),
    'DELETE /api/partner/time-off/:id (the technician leave)',
  );

  /* -- put the salon back the way the group found it -------------------------- */
  ok(
    await partner.fetch('/api/partner/salon', {
      method: 'PATCH',
      json: {
        hours: before.hours,
        auto_confirm: before.auto_confirm,
        lead_time_min: before.lead_time_min,
        cancel_cutoff_hours: before.cancel_cutoff_hours,
        cancel_policy_text: before.cancel_policy_text,
      },
    }),
    'PATCH /api/partner/salon (restore what the lifecycle group started from)',
  );
}

/* ============================================================================
 * 18 — the account lifecycle: consent, the welcome greeting, the login throttle,
 *      the lazy 24h reminder, and erasing an account
 * ========================================================================= */

async function groupAccountLifecycle() {
  const guest = session('guest');
  const stamp = Date.now();

  /* -- consent is affirmative, and refused when it is missing ------------------ */

  expectError(
    await guest.fetch('/api/auth/register', {
      method: 'POST',
      json: {
        name: 'Khong Dong Y',
        email: `noconsent${stamp}@oak.invalid`,
        password: 'Oak@1234',
      },
    }),
    400,
    'CONSENT_REQUIRED',
    'POST /api/auth/register without consent',
  );

  /* -- a new customer is greeted once, with a code that can actually be spent -- */

  const fresh = new Session();
  const created = ok(
    await fresh.fetch('/api/auth/register', {
      method: 'POST',
      json: {
        name: 'Khach Moi',
        email: `welcome${stamp}@oak.invalid`,
        password: 'Oak@1234',
        consent: true,
      },
    }),
    'POST /api/auth/register (consenting customer)',
  );
  assert('welcome_code' in created, 'register: the reply must report welcome_code');

  const bell = ok(await fresh.fetch('/api/notifications'), 'GET /api/notifications (new account)');
  const greetings = bell.filter((item) => item.type === 'promotion' || item.type === 'general');
  assert(greetings.length === 1, 'a new customer gets exactly one greeting', bell);
  // The offers box was never ticked, and the greeting arrives anyway: it is the one
  // transactional hello that comes with signing up, not a campaign.
  assert(
    created.welcome_code === null || greetings[0].type === 'promotion',
    'a live platform-wide code makes the greeting a promotion',
    bell,
  );
  if (created.welcome_code !== null) {
    assert(
      greetings[0].body.includes(created.welcome_code),
      'the greeting names the code the reply reported',
      bell,
    );
  }

  /* -- the login throttle: ten tries in the window, and the eleventh is refused - */

  const throttled = new Session();
  const badLogin = () =>
    throttled.fetch('/api/auth/login', {
      method: 'POST',
      json: { email: `throttle${stamp}@oak.invalid`, password: 'wrong-password' },
    });
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    expectError(await badLogin(), 401, 'INVALID_CREDENTIALS', `bad login ${attempt} of 10`);
  }
  expectError(await badLogin(), 429, 'TOO_MANY_ATTEMPTS', 'the eleventh bad login in the window');

  /* -- the lazy 24h reminder: exactly one, however often the bell is read ------ */

  const customer = session('customer');
  const service = ok(await guest.fetch('/api/services/1'), 'GET /api/services/1 (for a reminder)');
  const slot = await findServiceSlot(service);
  assert(slot !== null, 'no free hour in the next week to hang a reminder on');
  const booked = ok(
    await customer.fetch('/api/bookings', {
      method: 'POST',
      json: {
        salon_id: service.salon.id,
        service_id: service.id,
        date: slot.date,
        time: slot.time,
        customer_name: 'Ngoc Anh',
        customer_phone: '0901234567',
      },
    }),
    'POST /api/bookings (a booking for the reminder sweep to find)',
  );

  // The sweep is gated to once per ten minutes per PROCESS, and this suite shares one with
  // every group before it — so what is asserted is the count, not that the first read
  // creates it. Reading four times may legitimately sweep zero times; it may never leave
  // two reminders behind for one booking.
  for (let read = 0; read < 4; read += 1) {
    const inbox = ok(
      await customer.fetch('/api/notifications?limit=50'),
      `GET /api/notifications (${read + 1})`,
    );
    const reminders = inbox.filter(
      (item) => item.type === 'reminder' && item.booking_id === booked.id,
    );
    assert(reminders.length <= 1, 'the sweep never writes a second reminder for one booking', inbox);
  }
  /* -- erasing an account ----------------------------------------------------- */

  expectError(
    await fresh.fetch('/api/users/me', { method: 'DELETE', json: {} }),
    400,
    'VALIDATION_ERROR',
    'DELETE /api/users/me with no password',
  );
  expectError(
    await fresh.fetch('/api/users/me', { method: 'DELETE', json: { password: 'not-it' } }),
    401,
    'INVALID_CREDENTIALS',
    'DELETE /api/users/me with the wrong password',
  );
  expectError(
    await session('partnerA').fetch('/api/users/me', {
      method: 'DELETE',
      json: { password: 'Oak@1234' },
    }),
    409,
    'PARTNER_ACCOUNT',
    'DELETE /api/users/me as a partner',
  );
  // 200 with an envelope, not 204: assets/js/oak-api.js parses every reply as JSON, so an
  // empty body would surface in the page as a network error after a successful deletion.
  ok(
    await fresh.fetch('/api/users/me', { method: 'DELETE', json: { password: 'Oak@1234' } }),
    'DELETE /api/users/me',
  );
  expectError(
    await fresh.fetch('/api/auth/login', {
      method: 'POST',
      json: { email: `welcome${stamp}@oak.invalid`, password: 'Oak@1234' },
    }),
    401,
    'INVALID_CREDENTIALS',
    'signing back into an erased account',
  );

  /* -- one number, one account ------------------------------------------------ */

  const digits = `09${String(stamp).slice(-8)}`;
  ok(
    await new Session().fetch('/api/auth/register', {
      method: 'POST',
      json: {
        name: 'Chu So Dien Thoai',
        email: `phone${stamp}@oak.invalid`,
        phone: digits,
        password: 'Oak@1234',
        consent: true,
      },
    }),
    'POST /api/auth/register (with a phone number)',
  );
  // Written another way entirely — every separator folds, so this is the same number.
  const spaced = `+84 ${digits.slice(1, 4)}.${digits.slice(4, 7)}-${digits.slice(7)}`;
  expectError(
    await guest.fetch('/api/auth/register', {
      method: 'POST',
      json: {
        name: 'Nguoi Khac',
        email: `phonedup${stamp}@oak.invalid`,
        phone: spaced,
        password: 'Oak@1234',
        consent: true,
      },
    }),
    409,
    'PHONE_IN_USE',
    'POST /api/auth/register with a number another live account answers to',
  );
}

/* ============================================================================
 * 19 — the staff persona: the claim link a salon owner hands a technician, the
 *      account behind it, and what that account may read
 * ========================================================================= */

async function groupStaffPersona() {
  const partner = session('partnerA');
  const partnerB = session('partnerB');
  const stamp = Date.now();

  /* The preview is throttled at ten per fifteen minutes per IP, and every group in this
     file arrives from one IP. So every preview this group makes goes through here and is
     counted, and whatever is left of the allowance is deliberately burnt at the very END
     of the group. Nothing below that block may preview a link. */
  let previewsSpent = 0;
  const previewInvite = async (token) => {
    previewsSpent += 1;
    return new Session().fetch(`/api/auth/staff/invite/${token}`);
  };
  /** The token out of the link the console hands the owner. */
  const tokenOf = (url) => url.split('invite=')[1];

  /* -- the roster says who stands behind a row, and never who they are -------- */

  const rosterResponse = await partner.fetch('/api/partner/staff');
  const roster = ok(rosterResponse, 'GET /api/partner/staff (staff persona)');
  const named = (name) => roster.find((member) => member.name === name);
  const lanKhue = named('Lan Khuê');
  const phuongVy = named('Phương Vy');
  const minhHang = named('Minh Hằng');
  const minhAnh = named('Minh Anh');
  assert(
    lanKhue && phuongVy && minhHang && minhAnh,
    'staff persona: expected the seeded Lala roster',
    rosterResponse,
  );

  assert(lanKhue.claimed === true, 'roster: the seeded claimed row must report claimed');
  assert(lanKhue.invite_pending === false, 'roster: a claimed row has no link outstanding');
  assert(phuongVy.claimed === false, 'roster: an unclaimed row must report claimed false');
  assert(phuongVy.invite_pending === true, 'roster: the seeded live link must show as pending');
  // The account behind a row is the technician's, and the token IS the secret: the console
  // gets two booleans and neither of those two things.
  assert(
    !JSON.stringify(roster).includes('user_id'),
    'roster: the account behind a row must never be named',
    rosterResponse,
  );

  /* -- a row nobody works behind any more cannot be invited ------------------- */

  const retired = ok(
    await partner.fetch('/api/partner/staff', { method: 'POST', json: { name: 'KTV Đã Nghỉ' } }),
    'POST /api/partner/staff (a row to retire)',
  );
  ok(
    await partner.fetch(`/api/partner/staff/${retired.id}`, { method: 'DELETE' }),
    'DELETE /api/partner/staff/:id (retire it)',
  );
  expectError(
    await partner.fetch(`/api/partner/staff/${retired.id}/invite`, { method: 'POST' }),
    409,
    'STAFF_INACTIVE',
    'POST invite on a retired roster row',
  );

  /* -- another salon's roster row is not addressable at all ------------------- */

  expectError(
    await partnerB.fetch(`/api/partner/staff/${minhAnh.id}/invite`, { method: 'POST' }),
    404,
    'NOT_FOUND',
    "POST invite on another salon's technician",
  );
  expectError(
    await partnerB.fetch(`/api/partner/staff/${minhAnh.id}/invite`, { method: 'DELETE' }),
    404,
    'NOT_FOUND',
    "DELETE invite on another salon's technician",
  );

  /* -- minting rotates the old link out, revoking kills the live one ---------- */

  const firstInvite = ok(
    await partner.fetch(`/api/partner/staff/${minhAnh.id}/invite`, { method: 'POST' }),
    'POST /api/partner/staff/:id/invite',
  );
  assert(
    typeof firstInvite.url === 'string' && firstInvite.url.includes('invite='),
    'invite: expected a link carrying the token',
  );
  assert(typeof firstInvite.expires_at === 'string', 'invite: expected expires_at');

  const secondInvite = ok(
    await partner.fetch(`/api/partner/staff/${minhAnh.id}/invite`, { method: 'POST' }),
    'POST /api/partner/staff/:id/invite (mint again)',
  );
  assert(secondInvite.url !== firstInvite.url, 'invite: minting again must mint a new link');

  const rotatedOut = await previewInvite(tokenOf(firstInvite.url));
  expectError(rotatedOut, 404, 'NOT_FOUND', 'preview the rotated-out link');
  const current = ok(await previewInvite(tokenOf(secondInvite.url)), 'preview the current link');
  assert(current.staff_name === 'Minh Anh', 'preview: expected the technician name');
  assert(current.salon_name === 'Lala Nail Studio', 'preview: expected the salon name');
  assert(typeof current.expires_at === 'string', 'preview: expected expires_at');
  // Three fields and no more: a claim link only ever exists for a row nobody holds, so
  // there is nothing about the account behind one for a preview to give away.
  assert(
    Object.keys(current).sort().join(',') === 'expires_at,salon_name,staff_name',
    'preview: expected exactly staff_name, salon_name and expires_at',
    current,
  );

  ok(
    await partner.fetch(`/api/partner/staff/${minhAnh.id}/invite`, { method: 'DELETE' }),
    'DELETE /api/partner/staff/:id/invite',
  );
  const revoked = await previewInvite(tokenOf(secondInvite.url));
  expectError(revoked, 404, 'NOT_FOUND', 'preview a revoked link');
  const garbage = await previewInvite(`nosuchtoken${stamp}`);
  expectError(garbage, 404, 'NOT_FOUND', 'preview a token that was never issued');

  /* And a live token on a roster row that is no longer active, which findLiveInvite
     refuses on the join rather than on the token. Parked with PATCH rather than DELETE on
     purpose: the soft delete retires the row's links, so it kills this token a different
     way — that path is staged further down. */
  const parked = ok(
    await partner.fetch('/api/partner/staff', { method: 'POST', json: { name: 'KTV Tạm Nghỉ' } }),
    'POST /api/partner/staff (a row to park)',
  );
  const parkedInvite = ok(
    await partner.fetch(`/api/partner/staff/${parked.id}/invite`, { method: 'POST' }),
    'POST invite before the row is parked',
  );
  ok(
    await partner.fetch(`/api/partner/staff/${parked.id}`, {
      method: 'PATCH',
      json: { active: 0 },
    }),
    'PATCH /api/partner/staff/:id inactive',
  );
  const parkedPreview = await previewInvite(tokenOf(parkedInvite.url));
  expectError(parkedPreview, 404, 'NOT_FOUND', 'preview a link on a row that is not active');

  /* Byte-identical, all four of them. A reply that told a rotated-out link from one that
     never existed — or from one whose technician no longer works here — would say whether
     a token is real, which is the whole thing a preview must not say. The expired case
     cannot be staged from out here: this suite has no database handle inside a group and
     nothing waits seven days, so findLiveInvite's expiry clause is pinned at source level
     in test/staff-persona.test.mjs instead. */
  for (const other of [revoked, garbage, parkedPreview]) {
    assert(
      other.body?.error?.code === rotatedOut.body?.error?.code,
      'every dead link must answer with the same error code',
      other,
    );
    assert(
      other.body?.error?.message === rotatedOut.body?.error?.message,
      'every dead link must answer with the same message',
      other,
    );
  }

  /* -- a technician with no account redeems the link and gets one ------------- */

  const claimInvite = ok(
    await partner.fetch(`/api/partner/staff/${minhHang.id}/invite`, { method: 'POST' }),
    'POST invite for the first claim',
  );
  const claimToken = tokenOf(claimInvite.url);
  const claimPreview = ok(await previewInvite(claimToken), 'preview the first-claim link');
  assert(claimPreview.staff_name === 'Minh Hằng', 'preview: expected the technician name');

  const technician = new Session();
  const registered = ok(
    await technician.fetch('/api/auth/staff/register', {
      method: 'POST',
      json: {
        token: claimToken,
        name: 'Kỹ Thuật Viên Mới',
        email: `ktv${stamp}@oak.invalid`,
        password: 'Oak@1234',
        consent: true,
      },
    }),
    'POST /api/auth/staff/register',
  );
  assert(registered.user.role === 'staff', 'staff register: expected role staff');

  const technicianMe = ok(await technician.fetch('/api/auth/me'), 'GET /api/auth/me (technician)');
  assert(
    technicianMe.user.role === 'staff',
    'staff register: the reply must have set a session cookie',
  );

  const profileResponse = await technician.fetch('/api/staff-me/profile');
  const profile = ok(profileResponse, 'GET /api/staff-me/profile');
  assert(profile.length === 1, 'staff profile: expected exactly the claimed row', profileResponse);
  assert(profile[0].staff_id === minhHang.id, 'staff profile: expected the row that was claimed');
  assert(profile[0].salon.slug === 'lala-nail-studio', 'staff profile: expected the salon');
  assert(typeof profile[0].claimed_at === 'string', 'staff profile: expected claimed_at');

  const afterClaimResponse = await partner.fetch('/api/partner/staff');
  const afterClaim = ok(afterClaimResponse, 'GET /api/partner/staff after the claim');
  const claimedRow = afterClaim.find((member) => member.id === minhHang.id);
  assert(claimedRow.claimed === true, 'roster: the claimed row must report claimed');
  assert(claimedRow.invite_pending === false, 'roster: the spent link is no longer outstanding');

  expectError(await previewInvite(claimToken), 404, 'NOT_FOUND', 'preview a spent link');
  expectError(
    await new Session().fetch('/api/auth/staff/register', {
      method: 'POST',
      json: {
        token: claimToken,
        name: 'Ai Đó Khác',
        email: `ktvlate${stamp}@oak.invalid`,
        password: 'Oak@1234',
        consent: true,
      },
    }),
    404,
    'NOT_FOUND',
    'redeem a spent link a second time',
  );

  /* -- two people, one profile: whoever holds it keeps it --------------------- */

  /* A second person arriving with the link that has already been redeemed. The claim
     endpoint refuses it with the same uniform 404 the preview gave, and the account it
     refused is left exactly as it was.

     The other two ways a token dies against a claimed row cannot be staged from out here:
     a token minted while the row was free and then overtaken by /api/staff-me/claim would
     have to be spent by that very claim, and nothing in this suite can reach the database
     to arrange otherwise. That case falls out of findLiveInvite's `st.user_id IS NULL`
     clause, pinned in test/staff-persona.test.mjs, and so does the in-transaction 409 that
     settles two genuinely concurrent redemptions. */
  const interloper = new Session();
  ok(
    await interloper.fetch('/api/auth/register', {
      method: 'POST',
      json: {
        name: 'Người Khác',
        email: `interloper${stamp}@oak.invalid`,
        password: 'Oak@1234',
        consent: true,
      },
    }),
    'register the second claimant',
  );
  const refusedClaim = await interloper.fetch('/api/staff-me/claim', {
    method: 'POST',
    json: { token: claimToken },
  });
  expectError(refusedClaim, 404, 'NOT_FOUND', 'claim a profile with a spent link');
  assert(
    refusedClaim.body?.error?.message === rotatedOut.body?.error?.message,
    'the claim endpoint refuses a dead token in the same words the preview does',
    refusedClaim,
  );
  const interloperMe = ok(
    await interloper.fetch('/api/auth/me'),
    'GET /api/auth/me after the refused claim',
  );
  assert(
    interloperMe.user.role === 'customer',
    'a refused claim leaves the account exactly as it was',
  );

  /* -- and the public register still cannot be asked for a staff account ------ */

  expectError(
    await new Session().fetch('/api/auth/register', {
      method: 'POST',
      json: {
        name: 'Tự Phong',
        email: `selfstaff${stamp}@oak.invalid`,
        password: 'Oak@1234',
        consent: true,
        role: 'staff',
      },
    }),
    400,
    'VALIDATION_ERROR',
    'POST /api/auth/register with role staff',
  );
  const ordinary = ok(
    await new Session().fetch('/api/auth/register', {
      method: 'POST',
      json: {
        name: 'Khách Thường',
        email: `ordinary${stamp}@oak.invalid`,
        password: 'Oak@1234',
        consent: true,
      },
    }),
    'POST /api/auth/register (ordinary account)',
  );
  assert(ordinary.user.role === 'customer', 'the public register still mints customers');

  /* -- a customer who steps behind the counter keeps what they already had ---- */

  const services = ok(
    await partner.fetch('/api/partner/services?limit=1'),
    'a Lala service for the walk-ins',
  );
  const service = services[0];
  const bookingDate = addDays(state.today, 3);

  const upgradeRow = ok(
    await partner.fetch('/api/partner/staff', {
      method: 'POST',
      json: { name: 'KTV Nâng Cấp' },
    }),
    'POST /api/partner/staff (a row for the upgrade)',
  );
  const upgradingPhone = '0988 100 200';
  const upgrading = new Session();
  ok(
    await upgrading.fetch('/api/auth/register', {
      method: 'POST',
      json: {
        name: 'Khách Lên Nhân Viên',
        email: `upgrade${stamp}@oak.invalid`,
        phone: upgradingPhone,
        password: 'Oak@1234',
        consent: true,
      },
    }),
    'register the customer who will claim a profile',
  );
  ok(
    await partner.fetch('/api/partner/bookings', {
      method: 'POST',
      json: {
        service_id: service.id,
        staff_id: minhAnh.id,
        date: bookingDate,
        time: '08:05',
        customer_name: 'Khách Lên Nhân Viên',
        customer_phone: upgradingPhone,
      },
    }),
    'POST /api/partner/bookings (history for the upgrading account)',
  );
  const beforeUpgrade = ok(
    await upgrading.fetch('/api/bookings/mine?status=upcoming'),
    'GET /api/bookings/mine before the claim',
  );
  assert(beforeUpgrade.length >= 1, 'the walk-in must have landed in the customer list');

  const upgradeInvite = ok(
    await partner.fetch(`/api/partner/staff/${upgradeRow.id}/invite`, { method: 'POST' }),
    'POST invite for the upgrading account',
  );
  ok(
    await upgrading.fetch('/api/staff-me/claim', {
      method: 'POST',
      json: { token: tokenOf(upgradeInvite.url) },
    }),
    'POST /api/staff-me/claim (as a customer)',
  );
  const upgradedMe = ok(await upgrading.fetch('/api/auth/me'), 'GET /api/auth/me after the claim');
  assert(upgradedMe.user.role === 'staff', 'claim: a customer becomes staff in place');
  const afterUpgrade = ok(
    await upgrading.fetch('/api/bookings/mine?status=upcoming'),
    'GET /api/bookings/mine after the claim',
  );
  assert(
    afterUpgrade.length === beforeUpgrade.length,
    'claim: the history the account already had survives the upgrade',
  );

  /* -- a salon owner is not upgraded into their own technician ---------------- */

  const partnerInvite = ok(
    await partner.fetch(`/api/partner/staff/${phuongVy.id}/invite`, { method: 'POST' }),
    'POST invite for the partner refusal',
  );
  expectError(
    await partnerB.fetch('/api/staff-me/claim', {
      method: 'POST',
      json: { token: tokenOf(partnerInvite.url) },
    }),
    409,
    'CONFLICT',
    'a partner account claiming a technician profile',
  );

  /* -- the two reads are staff-only, and not reachable as a guest ------------- */

  for (const pathname of ['/api/staff-me/profile', '/api/staff-me/bookings']) {
    expectError(
      await session('customer').fetch(pathname),
      403,
      'FORBIDDEN',
      `GET ${pathname} as a customer`,
    );
    expectError(await partnerB.fetch(pathname), 403, 'FORBIDDEN', `GET ${pathname} as a partner`);
    expectError(
      await new Session().fetch(pathname),
      401,
      'UNAUTHENTICATED',
      `GET ${pathname} as a guest`,
    );
  }

  /* -- what a technician may read of their own day ---------------------------- */

  const seeded = await login('nhanvien@oak.vn');
  assert(seeded.user.role === 'staff', 'nhanvien@oak.vn must be a staff account');
  const staffClient = seeded.client;

  ok(
    await partner.fetch('/api/partner/bookings', {
      method: 'POST',
      json: {
        service_id: service.id,
        staff_id: lanKhue.id,
        date: bookingDate,
        time: '08:15',
        customer_name: 'Trần Thị Bích Ngọc',
        customer_phone: '0977 100 200',
        note: 'Khách dặn làm nhẹ tay.',
      },
    }),
    "POST /api/partner/bookings (on the technician's own row)",
  );
  ok(
    await partner.fetch('/api/partner/bookings', {
      method: 'POST',
      json: {
        service_id: service.id,
        staff_id: minhAnh.id,
        date: bookingDate,
        time: '08:25',
        customer_name: 'Lê Văn Tuấn',
        customer_phone: '0977 300 400',
      },
    }),
    "POST /api/partner/bookings (on somebody else's row)",
  );

  const dayResponse = await staffClient.fetch(
    `/api/staff-me/bookings?from=${bookingDate}&to=${bookingDate}`,
  );
  const day = ok(dayResponse, 'GET /api/staff-me/bookings');
  assert(day.length === 1, "staff bookings: only the caller's own roster rows", dayResponse);
  assert(day[0].date === bookingDate, 'staff bookings: expected the booked date');
  assert(day[0].salon.name === 'Lala Nail Studio', 'staff bookings: expected the salon');
  assert(day[0].service.id === service.id, 'staff bookings: expected the service');
  // Vietnamese name order puts the given name last, and the given name is all a technician
  // gets: the rest of it identifies somebody.
  assert(day[0].customer.given_name === 'Ngọc', 'staff bookings: expected the given name only');
  const payload = JSON.stringify(day);
  for (const leak of ['customer_phone', '0977', 'note', 'Trần Thị Bích', 'Lê Văn']) {
    assert(!payload.includes(leak), `staff bookings: "${leak}" must never reach a technician`, dayResponse);
  }

  const sameStatus = ok(
    await staffClient.fetch(
      `/api/staff-me/bookings?from=${bookingDate}&to=${bookingDate}&status=${day[0].status}`,
    ),
    'GET /api/staff-me/bookings filtered to the booking status',
  );
  assert(sameStatus.length === 1, 'staff bookings: the status filter keeps a matching row');
  const otherStatus = day[0].status === 'completed' ? 'cancelled' : 'completed';
  const filteredOut = ok(
    await staffClient.fetch(
      `/api/staff-me/bookings?from=${bookingDate}&to=${bookingDate}&status=${otherStatus}`,
    ),
    'GET /api/staff-me/bookings filtered to another status',
  );
  assert(filteredOut.length === 0, 'staff bookings: the status filter excludes the rest');

  const outsideRange = ok(
    await staffClient.fetch(
      `/api/staff-me/bookings?from=${addDays(bookingDate, 1)}&to=${addDays(bookingDate, 2)}`,
    ),
    'GET /api/staff-me/bookings outside the booked day',
  );
  assert(
    !outsideRange.some((booking) => booking.id === day[0].id),
    'staff bookings: from/to must bound the list',
  );
  const defaulted = ok(
    await staffClient.fetch('/api/staff-me/bookings'),
    'GET /api/staff-me/bookings (default range)',
  );
  assert(
    defaulted.some((booking) => booking.id === day[0].id),
    'staff bookings: the default range covers the fortnight ahead',
  );

  expectError(
    await staffClient.fetch('/api/staff-me/bookings?from=2026-13-40'),
    400,
    'VALIDATION_ERROR',
    'GET /api/staff-me/bookings with a date that does not exist',
  );
  expectError(
    await staffClient.fetch('/api/staff-me/bookings?status=whatever'),
    400,
    'VALIDATION_ERROR',
    'GET /api/staff-me/bookings with an invented status',
  );

  /* -- the way back in when a technician has lost their password -------------- */

  /* The same button on a row somebody already holds is not an invite: no claim link is
     minted, and the technician gets an ordinary reset at their own email address. An
     owner-held link that sets a password would be account takeover, so the owner is told
     only that it went.

     What is assertable from out here is the observable contract; the rest — that the write
     lands in password_resets rather than staff_invites, and that a deploy with no mail key
     logs the url instead of returning it — is pinned at source level in
     test/staff-persona.test.mjs, this suite having no database handle and no mailbox. */
  const bellBefore = ok(
    await staffClient.fetch('/api/notifications'),
    'GET /api/notifications before the recovery',
  );
  const recoveryResponse = await partner.fetch(`/api/partner/staff/${lanKhue.id}/invite`, {
    method: 'POST',
  });
  const recovery = ok(recoveryResponse, 'POST invite on a claimed row (recovery)');
  assert(
    Object.keys(recovery).join(',') === 'recovery' && recovery.recovery === 'sent',
    "recovery: the reply is exactly {recovery:'sent'}",
    recoveryResponse,
  );
  // Nothing anywhere in the body may look like a link or a token: the owner must not be
  // able to read one, whatever shape it arrived in.
  const recoveryBody = JSON.stringify(recoveryResponse.body);
  for (const leak of ['token', 'url', 'dat-lai-mat-khau', 'expires']) {
    assert(!recoveryBody.includes(leak), `recovery: "${leak}" must never reach the owner`, recoveryResponse);
  }
  // No staff_invites row was written, which is what the roster reports by still showing
  // nothing outstanding on that technician.
  const afterRecovery = ok(
    await partner.fetch('/api/partner/staff'),
    'GET /api/partner/staff after the recovery',
  );
  assert(
    afterRecovery.find((member) => member.id === lanKhue.id).invite_pending === false,
    'recovery: a claimed row never gains a pending claim link',
    afterRecovery,
  );

  const bellAfterResponse = await staffClient.fetch('/api/notifications');
  const bellAfter = ok(bellAfterResponse, 'GET /api/notifications after the recovery');
  assert(
    bellAfter.length === bellBefore.length + 1,
    'the account holder is told when their owner triggers a recovery',
    bellAfterResponse,
  );
  assert(
    bellAfter[0].body ===
      'Chủ salon đã yêu cầu một liên kết đăng nhập lại cho bạn. Liên kết đã được gửi tới email của bạn.',
    'expected the recovery notice, saying where the link went',
    bellAfterResponse,
  );

  /* -- taking somebody off the roster ends their read of the calendar --------- */

  const departingRow = ok(
    await partner.fetch('/api/partner/staff', { method: 'POST', json: { name: 'KTV Sắp Nghỉ' } }),
    'POST /api/partner/staff (a stint about to end)',
  );
  const departingInvite = ok(
    await partner.fetch(`/api/partner/staff/${departingRow.id}/invite`, { method: 'POST' }),
    'POST invite for the departing technician',
  );
  const departing = new Session();
  ok(
    await departing.fetch('/api/auth/staff/register', {
      method: 'POST',
      json: {
        token: tokenOf(departingInvite.url),
        name: 'KTV Sắp Nghỉ',
        email: `departing${stamp}@oak.invalid`,
        password: 'Oak@1234',
        consent: true,
      },
    }),
    'POST /api/auth/staff/register (the departing technician)',
  );
  ok(
    await partner.fetch('/api/partner/bookings', {
      method: 'POST',
      json: {
        service_id: service.id,
        staff_id: departingRow.id,
        date: bookingDate,
        time: '08:35',
        customer_name: 'Phạm Thu Hà',
        customer_phone: '0977 500 600',
      },
    }),
    'POST /api/partner/bookings (on the departing row)',
  );
  const whileEmployed = ok(
    await departing.fetch(`/api/staff-me/bookings?from=${bookingDate}&to=${bookingDate}`),
    'GET /api/staff-me/bookings while the stint is open',
  );
  assert(whileEmployed.length === 1, 'the departing technician reads their own day');

  ok(
    await partner.fetch(`/api/partner/staff/${departingRow.id}`, { method: 'DELETE' }),
    'DELETE /api/partner/staff/:id (end the stint)',
  );

  const afterDeparture = ok(
    await departing.fetch(`/api/staff-me/bookings?from=${bookingDate}&to=${bookingDate}`),
    'GET /api/staff-me/bookings after the stint ended',
  );
  assert(
    afterDeparture.length === 0,
    'a stint that has ended is not a licence to keep reading the salon calendar',
    afterDeparture,
  );
  // The stint itself is still theirs to see, flagged inactive: their own history, not the
  // salon's diary.
  const departedProfile = ok(
    await departing.fetch('/api/staff-me/profile'),
    'GET /api/staff-me/profile after the stint ended',
  );
  assert(
    departedProfile.some((row) => row.staff_id === departingRow.id && row.active === 0),
    'the ended stint stays on the profile, flagged inactive',
    departedProfile,
  );

  /* -- and ending a stint takes the link that was waiting on it -------------- */

  /* A separate row, because the two halves cannot live on one: a claimed row can never
     hold a live claim link (minting on one triggers the recovery above instead), so the
     link that a departure has to kill is by definition on a row nobody claimed. Left
     unclaimed here on purpose. */
  const abandonedRow = ok(
    await partner.fetch('/api/partner/staff', { method: 'POST', json: { name: 'KTV Chưa Nhận' } }),
    'POST /api/partner/staff (a row whose link is never redeemed)',
  );
  ok(
    await partner.fetch(`/api/partner/staff/${abandonedRow.id}/invite`, { method: 'POST' }),
    'POST invite that will be outlived by the row',
  );
  const withPending = ok(
    await partner.fetch('/api/partner/staff'),
    'GET /api/partner/staff with a link outstanding',
  );
  assert(
    withPending.find((member) => member.id === abandonedRow.id).invite_pending === true,
    'roster: the outstanding link shows before the row is retired',
    withPending,
  );

  ok(
    await partner.fetch(`/api/partner/staff/${abandonedRow.id}`, { method: 'DELETE' }),
    'DELETE /api/partner/staff/:id (with a link still outstanding)',
  );
  const afterRetiring = ok(
    await partner.fetch('/api/partner/staff'),
    'GET /api/partner/staff after retiring the row',
  );
  // used = 1, not merely unreachable: the row is patchable back to active, and a link that
  // only died of the inactive flag would come back to life with it.
  assert(
    afterRetiring.find((member) => member.id === abandonedRow.id).invite_pending === false,
    'retiring a row retires the claim link that was waiting on it',
    afterRetiring,
  );
  ok(
    await partner.fetch(`/api/partner/staff/${abandonedRow.id}`, {
      method: 'PATCH',
      json: { active: 1 },
    }),
    'PATCH the retired row back to active',
  );
  const afterRestoring = ok(
    await partner.fetch('/api/partner/staff'),
    'GET /api/partner/staff after restoring the row',
  );
  assert(
    afterRestoring.find((member) => member.id === abandonedRow.id).invite_pending === false,
    'restoring a row must not bring its old claim link back with it',
    afterRestoring,
  );

  /* -- the preview allowance, spent deliberately and last --------------------- */

  // Ten per fifteen minutes per IP, and seven of them are spent above: the rotated-out
  // link, the current one, the revoked one, garbage, the parked row, and the first-claim
  // link before and after it was redeemed. The loop burns whatever is left so the refusal
  // lands on the eleventh wherever the count above ends up — the number in this sentence
  // is a reader's aid, not the thing keeping the test honest.
  // NO PREVIEW MAY FOLLOW THIS BLOCK.
  while (previewsSpent < 10) {
    await previewInvite(`spend${previewsSpent}${stamp}`);
  }
  expectError(
    await previewInvite(`overflow${stamp}`),
    429,
    'TOO_MANY_ATTEMPTS',
    'preview past the allowance',
  );
}

/* ============================================================================
 * Runner
 * ========================================================================= */

async function main() {
  const guest = new Session();

  // The server's own notion of today, straight from the date parser it ships with.
  const probe = await guest.fetch('/api/search/assistant', { method: 'POST', json: { message: 'hôm nay' } });
  state.today = probe.body?.data?.criteria?.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(state.today ?? '')) {
    throw new Error(`could not resolve the server's today: ${preview(probe)}`);
  }
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Server today: ${state.today}\n`);

  const maison = await guest.fetch('/api/salons/maison-de-beaute');
  state.maisonId = maison.body?.data?.id;
  state.uploadedFiles = [];

  await group('01 health + auth', groupHealthAuth);
  await group('02 salons', groupSalons);
  await group('03 services', groupServices);
  await group('04 staff', groupStaff);
  await group('05 search', groupSearch);
  await group('06 bookings', groupBookings);
  await group('07 reviews', groupReviews);
  await group('08 favorites', groupFavorites);
  await group('09 notifications', groupNotifications);
  await group('10 promotions', groupPromotions);
  await group('11 posts', groupPosts);
  await group('11b sitemap', groupSitemap);
  await group('12 users', groupUsers);
  await group('13 uploads', groupUploads);
  await group('14 partner', groupPartner);
  await group('15 authz + scoping', groupAuthz);
  await group('16 one salon per partner', groupSalonOwnership);
  await group('17 booking lifecycle', groupBookingLifecycle);
  await group('18 account lifecycle', groupAccountLifecycle);
  await group('19 staff persona', groupStaffPersona);
}

let child = null;
let exitCode = 0;

try {
  if (!EXTERNAL_URL) {
    await resetDatabase();
    child = spawnServer();
  }
  await waitForHealth();
  await main();

  const failed = groupResults.filter((result) => !result.passed);
  console.log(
    `\n${groupResults.length - failed.length}/${groupResults.length} groups passed · ${assertionCount} assertions`,
  );
  if (failed.length > 0) {
    console.log(`Failed groups: ${failed.map((result) => result.name).join(', ')}`);
    exitCode = 1;
  }
} catch (error) {
  console.error(`\nSUITE ABORTED: ${error.message}`);
  exitCode = 1;
} finally {
  for (const file of state.uploadedFiles ?? []) {
    fs.rmSync(path.join(serverRoot, 'uploads', file), { force: true });
  }
  if (child) {
    const stopped = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await stopped;
  }
}

process.exit(exitCode);
