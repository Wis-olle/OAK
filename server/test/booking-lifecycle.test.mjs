/*
 * The salon's own booking rules, from the console side: how the settings form carries the
 * four new columns, how a day off is declared and read back, and how the calendar shows a
 * day nobody is working. The server half of the same rules is in api-smoke's group 17 —
 * except the cancellation window, whose whole point is the timezone the host runs in, and
 * which is therefore pinned at the bottom of this file instead.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { bookingStatus, BOOKING_STATUSES } from './booking-status.mjs';

import { toMinutes } from '../src/lib/time.js';
import { readServer, readUi } from './lib/read-source.mjs';

const settingsHtml = readUi('cai-dat-salon.html');
const staffHtml = readUi('quan-ly-nhan-vien.html');
const calendarHtml = readUi('quan-ly-lich-hen.html');

const source = readServer('routes/bookings.js');

/* The fixed "now" the cancel-window test measures from: 10:30 on 2026-08-23, Vietnam time. */
const TODAY = '2026-08-23';
const NOW_MIN = 10 * 60 + 30;

/**
 * Lift a page's inline factory out of its <script> and run it in a bare context.
 *
 * Each console page ends its script with a call that wires the real header up, so the
 * slice stops before that; `$nextTick` and the map picker are the only browser things the
 * factories below reach for, and both are stubbed rather than emulated.
 */
function factory(html, from, call, extras) {
  const tail = html.slice(html.indexOf(from));
  const stop = tail.includes('oakPartnerChrome();')
    ? tail.lastIndexOf('oakPartnerChrome();')
    : tail.lastIndexOf('</script>');
  const script = tail.slice(0, stop);
  const context = {
    document: { addEventListener() {} },
    window: { addEventListener() {} },
    ...extras,
  };
  vm.runInNewContext(`${script}\nresult = ${call};`, context);
  context.result.page = context;
  // Alpine supplies this; nothing is rendered here, so the callback it defers has nothing
  // to wait for and the map picker it flushes to is never built.
  context.result.$nextTick = () => {};
  return context.result;
}

function salonSettings(api) {
  return factory(settingsHtml, 'var HCMC_DISTRICTS', 'salonSettings()', {
    OAK: { api, toast: () => {}, me: async () => null, pendingBadge: () => {} },
  });
}

function staffConsole(api) {
  return factory(staffHtml, 'var OAK_WEEKDAY_LABELS', 'oakPartnerStaff()', {
    OAK: { api, toast: () => {}, qs: () => '', pendingBadge: () => {} },
  });
}

function calendar(api) {
  return factory(calendarHtml, 'var OAK_BOOKING_CLASSES', 'oakPartnerBookings()', {
    document: { addEventListener() {}, title: '', visibilityState: 'visible' },
    setInterval: () => {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    OAK: { api, toast: () => {}, qs: () => '', todayISO: () => '2026-08-21', fmtDate: (iso) => iso, bookingStatus, BOOKING_STATUSES },
  });
}

/** The salon shape GET /api/partner/salon answers with. */
function salonRow(overrides) {
  return {
    id: 1,
    slug: 'lala',
    name: 'Lala',
    hours: [],
    amenities: [],
    tags: [],
    social_links: {},
    auto_confirm: 1,
    lead_time_min: 0,
    cancel_cutoff_hours: 2,
    cancel_policy_text: null,
    ...overrides,
  };
}

/* ----------------------------------------------------- the settings form ---- */

test('the four booking settings survive the round trip through the form', async () => {
  const sent = [];
  const state = salonSettings(async (path, options) => {
    sent.push({ path, options });
    if (path === '/api/partner/time-off') {
      return [];
    }
    if (options && options.method === 'PATCH') {
      return salonRow(options.body);
    }
    return salonRow({ auto_confirm: 0, lead_time_min: 120, cancel_cutoff_hours: 24, cancel_policy_text: 'Gọi trước.' });
  });

  await state.loadSalon();
  // A meaningful zero must not come back as an empty control: `auto_confirm: 0` is "off",
  // not "unset", and that is what the plain value-or-empty-string fill would have made it.
  assert.equal(state.form.auto_confirm, false);
  assert.equal(state.form.lead_time_min, '120');
  assert.equal(state.form.cancel_cutoff_hours, '24');
  assert.equal(state.form.cancel_policy_text, 'Gọi trước.');

  state.form.auto_confirm = true;
  state.form.cancel_cutoff_hours = '48';
  await state.save();
  const patch = sent.find((call) => call.options && call.options.method === 'PATCH');
  assert.equal(patch.options.body.auto_confirm, 1);
  assert.equal(patch.options.body.lead_time_min, 120);
  assert.equal(patch.options.body.cancel_cutoff_hours, 48);
  assert.equal(patch.options.body.cancel_policy_text, 'Gọi trước.');
});

test('a salon whose settings never loaded still opens the form on the defaults', async () => {
  const state = salonSettings(async (path) =>
    path === '/api/partner/time-off' ? [] : salonRow({ auto_confirm: undefined, lead_time_min: null, cancel_cutoff_hours: null }),
  );
  await state.loadSalon();
  assert.equal(state.form.auto_confirm, true);
  assert.equal(state.form.lead_time_min, '0');
  assert.equal(state.form.cancel_cutoff_hours, '2');
});

test('the settings page offers exactly the choices the server accepts', () => {
  for (const value of ['0', '60', '120', '1440']) {
    assert.match(settingsHtml, new RegExp('<option value="' + value + '">'));
  }
  for (const value of ['2', '6', '12', '24', '48']) {
    assert.match(settingsHtml, new RegExp('<option value="' + value + '">'));
  }
  // The column takes 200 characters, and the box says so before the server has to.
  assert.match(settingsHtml, /id="salon-cancel-policy"[^>]*maxlength="200"/);
});

/* ---------------------------------------------------------- days off -------- */

test('a whole-salon closure is posted without a technician, and reports what it hits', async () => {
  const sent = [];
  let rows = [];
  const state = salonSettings(async (path, options) => {
    sent.push({ path, options });
    if (path === '/api/partner/time-off' && options && options.method === 'POST') {
      rows = [{ id: 3, staff_id: null, staff_name: null, date_from: '2026-09-02', date_to: '2026-09-03', reason: 'Nghỉ lễ' }];
      return { id: 3, staff_id: null, date_from: '2026-09-02', date_to: '2026-09-03', reason: 'Nghỉ lễ', affected_bookings: 4 };
    }
    if (path === '/api/partner/time-off') {
      return rows.slice();
    }
    return salonRow();
  });

  await state.loadSalon();
  state.timeOffForm.date_from = '2026-09-02';
  state.timeOffForm.date_to = '2026-09-03';
  state.timeOffForm.reason = 'Nghỉ lễ';
  await state.addTimeOff();

  const post = sent.find((call) => call.options && call.options.method === 'POST');
  assert.equal(post.path, '/api/partner/time-off');
  assert.equal(post.options.body.date_from, '2026-09-02');
  assert.equal(post.options.body.date_to, '2026-09-03');
  assert.equal(post.options.body.reason, 'Nghỉ lễ');
  assert.equal('staff_id' in post.options.body, false);
  // Nothing already booked is cancelled, so the count stays on the page as a to-do.
  assert.equal(state.timeOffAffected, 4);
  assert.equal(state.timeOff.length, 1);
  // And the add form is empty again, so the next holiday is not a copy of this one.
  assert.equal(state.timeOffForm.date_from, '');
});

test('a day off with no start date is refused before any request is made', async () => {
  let calls = 0;
  const state = salonSettings(async (path) => {
    calls += 1;
    return path === '/api/partner/time-off' ? [] : salonRow();
  });
  await state.loadSalon();
  const before = calls;
  await state.addTimeOff();
  assert.equal(calls, before);
  assert.match(state.timeOffError, /ngày bắt đầu/);
});

test('the day range reads as digits, so the English pass leaves it alone', async () => {
  const state = salonSettings(async (path) => (path === '/api/partner/time-off' ? [] : salonRow()));
  assert.equal(state.dayRange({ date_from: '2026-09-02', date_to: '2026-09-02' }), '02/09');
  assert.equal(state.dayRange({ date_from: '2026-09-02', date_to: '2026-09-05' }), '02/09 - 05/09');
});

test('the staff modal posts leave against that technician, and lists only theirs', async () => {
  const sent = [];
  const state = staffConsole(async (path, options) => {
    sent.push({ path, options });
    if (path === '/api/partner/time-off' && options && options.method === 'POST') {
      return { id: 9, staff_id: 5, staff_name: 'An', date_from: '2026-09-02', date_to: '2026-09-02', affected_bookings: 1 };
    }
    if (path === '/api/partner/time-off') {
      return [
        { id: 1, staff_id: null, staff_name: null, date_from: '2026-09-01', date_to: '2026-09-01', reason: 'Nghỉ lễ' },
        { id: 2, staff_id: 5, staff_name: 'An', date_from: '2026-09-02', date_to: '2026-09-02', reason: 'Nghỉ phép' },
        { id: 3, staff_id: 6, staff_name: 'Bình', date_from: '2026-09-02', date_to: '2026-09-02', reason: '' },
      ];
    }
    return [];
  });

  await state.loadTimeOff();
  state.form = { id: 5, name: 'An', schedule: [], service_ids: [] };
  // The salon's own closure belongs to the salon, not to this technician's card.
  assert.deepEqual(state.staffTimeOff().map((row) => row.id), [2]);

  state.timeOffForm.date_from = '2026-09-02';
  await state.addTimeOff();
  const post = sent.find((call) => call.options && call.options.method === 'POST');
  assert.equal(post.options.body.staff_id, 5);
  // A missing end date means the one day that was named.
  assert.equal(post.options.body.date_to, '2026-09-02');
  assert.equal(state.timeOffAffected, 1);
});

/* -------------------------------------------------- the calendar grid ------- */

test('the calendar greys a day the salon shut and a technician on leave', async () => {
  const state = calendar(async (path) => {
    if (path === '/api/partner/time-off') {
      return [
        { id: 1, staff_id: null, date_from: '2026-09-01', date_to: '2026-09-02' },
        { id: 2, staff_id: 5, date_from: '2026-08-21', date_to: '2026-08-21' },
      ];
    }
    return [];
  });
  await state.loadTimeOff();

  assert.equal(state.salonOff('2026-09-01'), true);
  assert.equal(state.salonOff('2026-09-02'), true);
  assert.equal(state.salonOff('2026-08-31'), false);
  // A technician is off on their own day, and on every day the salon is shut.
  assert.equal(state.staffOff(5, '2026-08-21'), true);
  assert.equal(state.staffOff(6, '2026-08-21'), false);
  assert.equal(state.staffOff(6, '2026-09-01'), true);

  // Greyed, not hidden: whatever was booked before the day closed still has to be visible.
  assert.match(calendarHtml, /:class="column\.off \? 'opacity-50' : ''"/);
  assert.match(calendarHtml, /x-show="column\.off">Nghỉ</);
});


/* --------------------------------------------------- the cancel window ------ */

/**
 * routes/bookings.js's minutesUntilStart, lifted and driven with a fixed "now".
 *
 * `tz` is the container's zone, which is exactly what is under test: Render runs in UTC
 * and the salons are in Vietnam, so an answer that moves when TZ moves is an answer that
 * gives a customer seven hours the salon never offered.
 */
function minutesUntil(tz, date, time) {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    const constants = source.match(/const MINUTES_PER_HOUR = [^\n]*\nconst MINUTES_PER_DAY = [^\n]*\nconst MS_PER_DAY = [^\n]*\n/);
    const body = source.match(/function minutesUntilStart[\s\S]*?\n}\n/);
    assert.ok(constants && body, 'routes/bookings.js no longer holds minutesUntilStart as written');
    const context = { toMinutes, todayISO: () => TODAY, nowMinutes: () => NOW_MIN };
    vm.runInNewContext(
      `${constants[0]}${body[0]}\nresult = minutesUntilStart(${JSON.stringify(date)}, ${JSON.stringify(time)});`,
      context,
    );
    return context.result;
  } finally {
    process.env.TZ = previous;
  }
}

test('the cancellation window is measured in Vietnam time, whatever the host runs in', () => {
  for (const tz of ['UTC', 'Asia/Ho_Chi_Minh']) {
    // 10:30 today, appointment at 13:00 today: two and a half hours left, in either zone.
    assert.equal(minutesUntil(tz, TODAY, '13:00'), 150, tz);
    assert.equal(minutesUntil(tz, '2026-08-24', '13:00'), 150 + 24 * 60, tz);
    assert.equal(minutesUntil(tz, TODAY, '09:00'), -90, tz);
  }
  // ...which is what decides the 409: a salon asking for 24 hours must refuse a booking
  // that is 2.5 hours away on a UTC host too, not grant it 31.
  assert.ok(minutesUntil('UTC', TODAY, '13:00') < 24 * 60);
});

/* ---------------------------------------------- who performs what, and when - */

const availabilitySource = readServer('lib/availability.js');

/**
 * One function lifted out of lib/availability.js and driven in a bare context — or several,
 * for a function that is built out of the private helpers beside it.
 */
function liftFromAvailability(pattern, call, context) {
  const lifted = (Array.isArray(pattern) ? pattern : [pattern]).map((one) => {
    const body = availabilitySource.match(one);
    assert.ok(body, `lib/availability.js no longer holds ${one} as written`);
    return body[0];
  });
  vm.runInNewContext(`${lifted.join('\n')}\nresult = ${call};`, context);
  return context.result;
}

test('the one rule about who performs what is asked in exactly one place', async () => {
  // Both branches: the pool goes through the prepared statement, a caller's transaction
  // through the SQL text. Nothing in the codebase may keep a second spelling of the rule.
  const asked = [];
  const canDo = (handle, staffId, serviceId) =>
    liftFromAvailability(
      /async function staffCanDo[\s\S]*?\n}\n/,
      `staffCanDo(handle, ${staffId}, ${serviceId})`,
      {
        handle,
        STAFF_SERVICE_SQL: 'SQL',
        selectStaffService: {
          get: async (...params) => {
            asked.push(['pool', ...params]);
            return params[0] === 1 ? { '?column?': 1 } : undefined;
          },
        },
      },
    );

  const pool = { prepare: () => {} };
  assert.equal(await canDo(pool, 1, 4), true);
  // The link is the whole of the rule: no row means she performs nothing, not everything.
  assert.equal(await canDo(pool, 2, 4), false);
  assert.deepEqual(asked, [['pool', 1, 4], ['pool', 2, 4]]);

  const tx = { get: async (sql, ...params) => (sql === 'SQL' && params[0] === 3 ? {} : null) };
  assert.equal(await canDo(tx, 3, 4), true);
  assert.equal(await canDo(tx, 9, 4), false);

  // And the two routes that ask it hold no staff_services SELECT of their own.
  const partnerSource = readServer('routes/partner.js');
  for (const [name, text] of [['bookings.js', source], ['partner.js', partnerSource]]) {
    assert.ok(text.includes('staffCanDo'), `${name} must ask the rule rather than restate it`);
    assert.ok(
      !/SELECT 1 FROM staff_services WHERE staff_id = \? AND service_id = \?/.test(text),
      `${name} must not keep a second spelling of the staff_services rule`,
    );
  }
});

test('and the reading side asks it too, so no picker offers what the booking refuses', async () => {
  /* The rule used to be enforced on the way IN and nowhere else: POST /api/bookings refused
     the pair, while the day strip behind it (GET /api/staff/:id/availability?service_id=),
     the console's GET /api/partner/availability and the wizard all read their hours out of
     getStaffSlots, which never asked. So a technician nobody had linked to the service was
     offered with a full calendar and refused at the end of it. */
  const asked = [];
  const slotsFor = (canDo, call = "getStaffSlots(7, 4, '2026-09-01')") =>
    liftFromAvailability(
      /async function getStaffSlots\([\s\S]*?\n}\n/,
      call,
      {
        db: { prepare: () => {} },
        selectService: { get: async () => ({ id: 4, salon_id: 1, duration_min: 60 }) },
        staffCanDo: async (handle, staffId, serviceId) => {
          asked.push([staffId, serviceId]);
          return canDo;
        },
        staffDaySlots: async () => [{ time: '10:00', available: true }],
        FALLBACK_DURATION_MIN: 60,
      },
    );

  /* Spread before comparing: the arrays come back from the vm realm, so a strict deep-equal
     against a host literal fails on the prototype rather than on the contents. */
  assert.deepEqual([...(await slotsFor(false))], [], 'a service she is not linked to has no hours');
  assert.deepEqual([...(await slotsFor(true))], [{ time: '10:00', available: true }]);
  // Asked about the pair the caller named, and asked through the shared rule rather than a
  // staff_services SELECT of its own — the same thing the writes were already doing.
  assert.deepEqual(asked, [[7, 4], [7, 4]]);
  /* And the week strip's seam. The link is one answer for all seven days, so getServiceWeek
     resolves it once above its loop and hands it down; a day that already holds the answer
     asks nothing, which is seven round trips off every named-technician day strip. */
  asked.length = 0;
  assert.deepEqual(
    [...(await slotsFor(true, "getStaffSlots(7, 4, '2026-09-01', null, null, null, false)"))],
    [],
    'a handed-down "no" is the same no',
  );
  assert.deepEqual(asked, [], 'and it is not asked for a second time');
  assert.ok(
    !/SELECT 1 FROM staff_services/.test(
      availabilitySource.slice(availabilitySource.indexOf('async function getStaffSlots(')),
    ),
  );
});

test('a weekday the salon never described is closed, not unrestricted', () => {
  const clamp = (shift, hours) =>
    liftFromAvailability(
      /function clampToHours[\s\S]*?\n}\n/,
      `clampToHours(${JSON.stringify(shift)}, ${JSON.stringify(hours)})`,
      {},
    );
  const shift = { start: '08:00', end: '20:00' };

  /* The whole of the bug: a missing row used to leave the shift untouched, so a salon with
     a half-described week was bookable round the clock on the days it had never mentioned.
     Nothing writes a partial week, so a missing row was never an open day. */
  assert.equal(clamp(shift, undefined), null);
  assert.equal(clamp(shift, { is_off: 1, start: null, end: null }), null);
  // Read field by field: the lifted function builds its object in the vm's own realm, so a
  // deep-equal against one of ours compares prototypes and not opening hours.
  const narrowed = clamp(shift, { is_off: 0, start: '09:00', end: '18:00' });
  assert.equal(`${narrowed.start}-${narrowed.end}`, '09:00-18:00');
  // The narrowing is a plain min/max over 'HH:MM' text, so the tighter end of each pair wins.
  const wider = clamp(shift, { is_off: 0, start: '07:00', end: '23:00' });
  assert.equal(`${wider.start}-${wider.end}`, '08:00-20:00');
});

/* ------------------------------------------- one hour, one technician, one writer - */

test('one key holds a salon day, it is taken first, and it does not wait for ever', () => {
  /* The whole fix in one statement. pg_advisory_xact_lock over a hashtext() of the key,
     taken on the transaction that is about to write, released by its COMMIT or ROLLBACK.
     Pinned as text because there is nothing else to assert against: a lock that is not
     taken behaves exactly like one that is, right up until two customers arrive at once. */
  assert.match(
    availabilitySource,
    /const ADVISORY_LOCK_SQL = 'SELECT pg_advisory_xact_lock\(hashtext\(\?\)\)';/,
    'the day lock must still be an xact advisory lock over hashtext of the key',
  );

  /* ONE key shape, and it is the salon's day. A key per technician reads as the tighter
     choice and is the broken one: "Bất kỳ" cannot know whose day it is about to fill until
     it has read the whole roster, so it can only hold the salon — and a named booking
     holding some other key does not exclude it. The two would then race each other onto
     overlapping minutes of one technician, which is the bug this file exists for. */
  assert.match(availabilitySource, /`salon:\$\{salonId\}:\$\{date\}`/);
  assert.ok(
    !/lockStaffDay/.test(availabilitySource),
    'a second key per technician must not come back: it excludes nobody',
  );
  assert.equal(
    (availabilitySource.match(/export async function lock/g) || []).length,
    1,
    'and there is exactly one lock to take',
  );

  /* Bounded. An advisory wait holds one of five pool connections while it waits, so an
     unbounded one turns a single stuck transaction into a dead instance. SET LOCAL, so the
     transaction that took it also gives it back. */
  assert.match(availabilitySource, /const LOCK_TIMEOUT = '3s';/);
  assert.match(availabilitySource, /SET LOCAL lock_timeout = '\$\{LOCK_TIMEOUT\}'/);
  const lock = availabilitySource.slice(
    availabilitySource.indexOf('export async function lockSalonDay'),
  );
  assert.ok(
    lock.indexOf('LOCK_TIMEOUT_SQL') < lock.indexOf('ADVISORY_LOCK_SQL'),
    'the ceiling has to be set before the wait it is a ceiling on',
  );

  /* And the lock is taken FIRST. A lock after the read it was meant to protect is
     decoration: both transactions would have already decided the hour was free.

     The calendar reads live in insertBookingIn(), the one place a customer's booking is
     written — a create and a move ask the same questions of an hour, so they ask them in
     the same function. What each caller has to be holding when it calls in there is
     therefore the thing to pin, and it is pinned per route: a second door that skipped the
     lock would be the whole bug back, on the route nobody was looking at. */
  const placement = source.slice(source.indexOf('async function insertBookingIn'));
  assert.ok(
    placement.indexOf('staffClashAt(tx') < placement.indexOf('lastInsertRowid'),
    'the named-technician path must re-read her calendar before the row is written',
  );
  assert.ok(
    placement.indexOf('pickAvailableStaff(tx') < placement.indexOf('lastInsertRowid'),
    'and "Bất kỳ" must pick from the roster before it',
  );
  for (const door of ["router.post('/'", "router.patch('/:id/reschedule'"]) {
    const route = source.slice(source.indexOf(door));
    assert.ok(
      route.indexOf('lockSalonDay(tx') < route.indexOf('insertBookingIn(tx'),
      `${door} must hold the salon's day before it writes into it`,
    );
  }
  /* ONE key per writer, and the move takes no second one. It holds the day it is TAKING,
     like every other writer; the day it is leaving has nothing to hold still, because giving
     an hour back reads no calendar. What the move does need of the row it is retiring is
     that this is still the row the plan was built from, and it asks that directly — under
     this lock, on this transaction, and again in the WHERE of the write itself. */
  const move = source.slice(source.indexOf("router.patch('/:id/reschedule'"));
  assert.equal((move.match(/await lockSalonDay\(/g) || []).length, 1);
  assert.match(move, /const current = await tx\.get\(SELECT_BOOKING, old\.id\);/);
  assert.match(move, /'BOOKING_CHANGED', BOOKING_CHANGED_MESSAGE/);
  assert.match(source, /AND status IN \('pending', 'confirmed'\)`;/);
  assert.match(move, /if \(changes === 0\) \{/);
});

test('the four routes that hold an hour all answer a lost lock as SLOT_BUSY', () => {
  /* 55P03 is lock_not_available: the day was held by somebody else for longer than
     LOCK_TIMEOUT. Nothing is booked and the same request a moment later is expected to
     work, so it must not be said as a taken hour — a customer told "that hour has gone"
     goes and picks another one for no reason. */
  const partnerSource = readServer('routes/partner.js');
  for (const [name, text] of [['bookings.js', source], ['partner.js', partnerSource]]) {
    assert.match(text, /error\.code === '55P03'/, `${name} must answer a lock it could not get`);
    assert.match(
      text,
      /'SLOT_BUSY', 'Salon đang nhận một lịch khác, thử lại sau vài giây\.'/,
      `${name} must say so as SLOT_BUSY`,
    );
  }
  // Both customer doors read that answer out of the one function, so a create and a move
  // cannot come to describe the same lost race in two different ways.
  assert.equal(
    (source.match(/throw placementError\(error\);/g) || []).length,
    2,
    'the create and the move must both go through the one mapper',
  );
  // withBookingCode retries a duplicate CODE and nothing else, so a timed-out lock is not
  // silently attempted five times over — it comes straight back out.
  const codeSource = readServer('lib/booking-code.js');
  assert.match(codeSource, /if \(!\(error\.code === '23505' && error\.constraint === 'bookings_code_key'\)\) \{\s*throw error;/);
});

test('an overlap and the very same minute are two different answers', async () => {
  const asked = [];
  const busy = [{ time: '10:00', duration_min: 60 }];
  const clash = (time, duration, exceptBookingId = null) =>
    liftFromAvailability(
      [
        /function toRanges[\s\S]*?\n}\n/,
        /function isFree[\s\S]*?\n}\n/,
        /async function staffClashAt[\s\S]*?\n}\n/,
      ],
      `staffClashAt(tx, 7, '2026-09-10', ${JSON.stringify(time)}, ${duration}, ${JSON.stringify(
        exceptBookingId,
      )})`,
      {
        toMinutes,
        FALLBACK_DURATION_MIN: 60,
        OTHER_STAFF_BOOKINGS_SQL: 'SQL',
        tx: {
          all: async (sql, ...params) => {
            asked.push([sql, ...params]);
            return busy;
          },
        },
      },
    );

  /* idx_bookings_slot is UNIQUE(staff_id, date, time) and would have accepted every one of
     the refusals below except the last: they are different minutes. The ranges are
     half-open, so an hour that starts exactly where the last one ended is free. */
  assert.equal(await clash('10:30', 60), 'overlap', '10:30 is half way through the 10:00 hour');
  assert.equal(await clash('09:30', 60), 'overlap', 'and 09:30 runs into it from the other side');
  assert.equal(await clash('11:00', 60), null, 'but 11:00 starts where 10:00 finished');
  assert.equal(await clash('09:00', 60), null, 'and 09:00 finishes where it starts');

  /* The one the counter may not overrule, told apart from the rest: the index will refuse
     this row however anybody feels about it, so it is not a judgement to be overruled. */
  assert.equal(await clash('10:00', 60), 'exact', 'the very same minute is its own answer');
  // Even at a length that would not overlap anything: it is the minute that is taken, not
  // the hour around it.
  assert.equal(await clash('10:00', 1), 'exact');

  // An hour nobody can parse is not free, and not forceable either. It cannot arrive here —
  // every route validates the time first — and answering "free" if it ever did would write it.
  assert.equal(await clash('không phải giờ', 60), 'exact');

  /* The row being moved is taken out in SQL rather than filtered afterwards, so a booking
     is never found clashing with the hour it is already sitting on. */
  assert.ok(
    availabilitySource.includes('AND b.id IS DISTINCT FROM ?'),
    'the moved booking must be excluded by the statement, not by the caller',
  );
  await clash('10:30', 60, 41);
  assert.deepEqual(asked.at(-1), ['SQL', 7, '2026-09-10', 41]);
  // IS DISTINCT FROM, so a create — which has no row yet — excludes nothing.
  assert.deepEqual(asked[0], ['SQL', 7, '2026-09-10', null]);
});

test('the counter is told before it books over her, and may still say yes', () => {
  const partnerSource = readServer('routes/partner.js');

  /* Both counter doors — the walk-in create and the edit — take the same lock, ask the same
     question and accept the same override. Counted, because a rule enforced on one of them
     is a rule the other one is the way around. */
  assert.equal(
    (partnerSource.match(/await lockSalonDay\(tx, salon\.id, /g) || []).length,
    2,
    'both POST and PATCH must hold the salon’s day before they write to it',
  );
  assert.equal(
    (partnerSource.match(/refuseUnlessForced\(/g) || []).length,
    3,
    'and both must go through the one gate that decides what force may clear',
  );
  /* Five, not the two booking doors alone: the same literal is how three MORE saves take an
     override. A day off, a re-written week and a shift taken away each refuse to strand an
     appointment that already stands inside them (BOOKINGS_AFFECTED) unless the request says
     the customers are in hand. Counted for the reason the two were: an override that can be
     spelled a second way is a second door nobody reviewed. */
  assert.equal(
    (partnerSource.match(/force === true/g) || []).length,
    5,
    'force is the request saying so, and nothing else counts as saying so',
  );

  /* The gate itself: force clears a SLOT_TAKEN and never a SLOT_OCCUPIED. Offering to save
     a row idx_bookings_slot will refuse would be the console promising what it cannot do —
     the counter answers "Vẫn lưu?" and gets an error for its trouble. */
  assert.match(
    partnerSource,
    /if \(conflict !== null && \(!force \|\| conflict\.code === 'SLOT_OCCUPIED'\)\) \{/,
  );

  /* The exact-minute wall is reached two ways — the check saw the row, or a request that
     slipped past it lost the race to the index — and both must answer in the same words, or
     the console learns two names for one wall. */
  assert.match(partnerSource, /const SLOT_OCCUPIED = \{/);
  assert.match(partnerSource, /'Kỹ thuật viên đã có lịch đúng giờ này; chọn phút khác\.'/);
  assert.match(partnerSource, /return httpError\(409, SLOT_OCCUPIED\.code, SLOT_OCCUPIED\.message\);/);
  assert.ok(
    !/'SLOT_TAKEN',\s*'Khung giờ này đã có lịch hẹn khác của kỹ thuật viên/.test(partnerSource),
    'the old index answer must be gone: it called an unforceable wall by the forceable name',
  );

  /* The three refusals force CAN clear, each in its own words, because they have different
     ways out: another day, another technician, another hour. */
  assert.match(partnerSource, /'Salon nghỉ ngày này, vui lòng chọn ngày khác\.'/);
  assert.match(
    partnerSource,
    /'Kỹ thuật viên nghỉ ngày này, vui lòng chọn ngày hoặc kỹ thuật viên khác\.'/,
  );
  assert.match(partnerSource, /'Kỹ thuật viên đã có lịch chồng giờ, vui lòng chọn giờ khác\.'/);

  const conflict = partnerSource.slice(
    partnerSource.indexOf('async function bookingConflict'),
    partnerSource.indexOf('/** Nobody has declared anything off'),
  );
  /* A technician's own day off is asked at the counter now: it is exactly as much of a
     "she cannot serve this hour" as the salon's own, and it used to be asked of customers
     and of nobody else. */
  assert.match(conflict, /off\.staff\.has\(staffId\)/);
  /* And what is deliberately NOT asked: the counter may book outside its own opening hours
     and inside its own lead time, which are warnings on this route and always were. */
  assert.ok(
    !/isSalonOpenFor|respectsLeadTime|lead_time/.test(conflict),
    'the counter’s clash check must not quietly start enforcing opening hours',
  );

  /* A booking's LENGTH comes off the service, so a save that swaps the service can run it
     into the next appointment without touching the hour at all. */
  assert.match(
    partnerSource,
    /Object\.hasOwn\(patch, 'staff_id'\) \|\|\n[\s\S]{0,400}?Object\.hasOwn\(patch, 'service_id'\)\)/,
  );
});
