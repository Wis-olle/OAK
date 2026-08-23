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

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_PORT = 3199;
const EXTERNAL_URL = process.env.OAK_TEST_BASE_URL;
const BASE_URL = EXTERNAL_URL ?? `http://127.0.0.1:${TEST_PORT}`;
const TEST_DATABASE_URL =
  process.env.OAK_TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/oak_test';

const HEALTH_TIMEOUT_MS = 15000;
const HEALTH_INTERVAL_MS = 200;
const BODY_PREVIEW_CHARS = 300;
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
    env: { ...process.env, PORT: String(TEST_PORT), DATABASE_URL: TEST_DATABASE_URL },
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

  const promoResponse = await customer.fetch(
    `/api/bookings/quote?service_id=${service.id}&promotion_code=OAKNEW20`,
  );
  const promoQuote = ok(promoResponse, 'GET /api/bookings/quote?promotion_code=OAKNEW20');
  const discountLine = promoQuote.items.find((item) => item.amount < 0);
  assert(discountLine !== undefined, 'quote with promo: expected a negative discount line', promoResponse);
  const expectedDiscount = Math.floor((service.price * 20) / 100);
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
  assert(created.status === 'pending', 'booking create: expected status pending', createResponse);
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
  const now = new Date();
  const soon = hhmm(Math.min(now.getHours() * 60 + now.getMinutes() + 30, 23 * 60 + 59));
  const imminent = ok(
    await customer.fetch('/api/bookings', {
      method: 'POST',
      json: { salon_id: state.lalaId, service_id: service.id, date: state.today, time: soon },
    }),
    'POST /api/bookings for today (cancel-window case)',
  );
  expectError(
    await customer.fetch(`/api/bookings/${imminent.id}/cancel`, { method: 'PATCH' }),
    400,
    'CANCEL_WINDOW',
    'cancelling less than 2h before the start',
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

  // A booking that names no technician reaches no slot check at all, so the salon's own
  // opening hours are the only thing standing between a customer and a closed day.
  const hoursDate = addDays(state.today, 1);
  const hoursWeekday = weekdayOf(hoursDate);
  const walkIn = { salon_id: state.lalaId, service_id: service.id, date: hoursDate, time: '10:00' };

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
  const lastLegalStart = hhmm(14 * 60 - service.duration_min);
  expectError(
    await customer.fetch('/api/bookings', {
      method: 'POST',
      json: { ...walkIn, time: hhmm(14 * 60 - service.duration_min + 1) },
    }),
    400,
    'VALIDATION_ERROR',
    'POST /api/bookings that would run one minute past closing',
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
  const ownerBooking = ok(
    await customer.fetch('/api/bookings', {
      method: 'POST',
      json: { salon_id: state.lalaId, service_id: service.id, date: addDays(state.today, 3), time: '09:30' },
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
  for (const [kind, time] of [['confirmed', '08:15'], ['pending', '08:45']]) {
    const booking = ok(
      await customer.fetch('/api/bookings', {
        method: 'POST',
        json: { salon_id: state.lalaId, service_id: service.id, date: addDays(state.today, 2), time },
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
  assert(
    promotions.some((item) => item.salon === null),
    'promotions: expected a platform-wide offer',
    response,
  );

  const combo = promotions.find((item) => item.type === 'combo');
  assert(combo !== undefined, 'promotions: expected a combo offer', response);
  assert(combo.service_names.length > 0, 'promotions: a combo must resolve its service names', response);
  assert(combo.salon?.slug !== undefined, 'promotions: a salon offer must carry its salon block', response);

  // A combo is a service, not a code. It points at the one service that IS the bundle, so
  // uu-dai.html can deep-link the wizard at it, and that service is already priced at the
  // sale price — which is what makes the advertised price the price actually charged.
  assert(
    combo.service_ids.length === 1,
    'promotions: a combo must point at exactly one combo service',
    response,
  );
  const comboServiceId = combo.service_ids[0];

  const comboServiceResponse = await session('guest').fetch(`/api/services/${comboServiceId}`);
  const comboService = ok(comboServiceResponse, 'GET /api/services/:id for the combo service');
  assert(
    comboService.name === combo.service_names[0],
    'combo: the offer must name the service it books',
    comboServiceResponse,
  );
  assert(
    comboService.price === combo.sale_price,
    'combo: the combo service must be priced at the sale price',
    comboServiceResponse,
  );

  const customer = session('customer');
  const comboQuoteResponse = await customer.fetch(
    `/api/bookings/quote?service_id=${comboServiceId}`,
  );
  const comboQuote = ok(comboQuoteResponse, 'GET /api/bookings/quote for the combo service');
  assert(
    comboQuote.total === combo.sale_price,
    'combo: booking the combo service must total the sale price',
    comboQuoteResponse,
  );

  // And the code behind a combo is refused wherever somebody pastes it by hand, so nobody
  // takes the bundle saving twice on top of a price that already carries it.
  const pastedResponse = await customer.fetch(
    `/api/bookings/quote?service_id=${comboServiceId}&promotion_code=${combo.code}`,
  );
  expectError(pastedResponse, 400, 'INVALID_PROMOTION', 'GET /api/bookings/quote with a combo code');
  assert(
    pastedResponse.body?.error?.message ===
      'Combo được đặt như một dịch vụ, không dùng như mã giảm giá.',
    'combo: the refusal must say a combo is booked as a service, not applied as a code',
    pastedResponse,
  );
  expectError(
    await customer.fetch('/api/bookings', {
      method: 'POST',
      json: {
        salon_id: state.lalaId,
        service_id: state.slot.service.id,
        date: state.slot.date,
        time: state.slot.time,
        promotion_code: combo.code,
      },
    }),
    400,
    'INVALID_PROMOTION',
    'POST /api/bookings with a combo code',
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

  ok(await customer.fetch(`/api/posts/${first.id}`, { method: 'DELETE' }), 'customer DELETE own post with comments');
  expectError(await guest.fetch(`/api/posts/${first.slug}`), 404, 'NOT_FOUND', 'customer-deleted post public detail');
  ok(await customer.fetch(`/api/posts/${social.id}/comments`, { method: 'POST', json: { content: 'Sẽ bị xoá cùng bài.' } }), 'comment before owned post deletion');
  ok(await partnerA.fetch(`/api/posts/${social.id}`, { method: 'DELETE' }), 'DELETE /api/posts/:id as owner');
  expectError(await guest.fetch(`/api/posts/${social.slug}`), 404, 'NOT_FOUND', 'deleted post public detail');
  expectError(await partnerA.fetch(`/api/posts/${social.id}`, { method: 'DELETE' }), 404, 'NOT_FOUND', 'deleting an already deleted post');
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
  const lateWalkIn = ok(
    await partner.fetch('/api/partner/bookings', {
      method: 'POST',
      json: {
        customer_name: 'Khách khuya',
        customer_phone: '0900 000 555',
        service_id: longest.id,
        date: tomorrow,
        time: '23:30',
      },
    }),
    'POST /api/partner/bookings at 23:30',
  );
  assert(
    lateWalkIn.end_time === hhmm((23 * 60 + 30 + longest.duration_min) % (24 * 60)),
    `walk-in at 23:30: end_time must wrap past midnight, got ${lateWalkIn.end_time}`,
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
      json: { name: 'Dịch vụ kiểm thử (xoá được)', category: 'nail', price: 99000, duration_min: 20 },
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

  const searchResults = ok(await partner.fetch('/api/partner/search?q=Minh'), 'GET /api/partner/search?q=');
  assert(searchResults.length > 0, 'partner search: expected matches');
  assert(
    searchResults.every((item) => 'type' in item && 'id' in item && 'label' in item),
    'partner search: expected {type,id,label} entries',
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

  // On this demo a self-registered salon goes live immediately: it is verified on
  // creation and reachable from the public list and the public search right away.
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

  const publicList = await session('guest').fetch('/api/salons?limit=50');
  assert(
    ok(publicList, 'public salon list').some((item) => item.id === ownSalon.id),
    'a self-registered salon must appear in GET /api/salons',
    publicList,
  );
  const publicSearch = await session('guest').fetch(
    `/api/search/salons?q=${encodeURIComponent(salonName)}`,
  );
  assert(
    ok(publicSearch, 'public salon search').some((item) => item.id === ownSalon.id),
    'a self-registered salon must appear in GET /api/search/salons',
    publicSearch,
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
  await group('12 users', groupUsers);
  await group('13 uploads', groupUploads);
  await group('14 partner', groupPartner);
  await group('15 authz + scoping', groupAuthz);
  await group('16 one salon per partner', groupSalonOwnership);
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
