/*
 * The salon's own booking rules, from the console side: how the settings form carries the
 * four new columns, how a day off is declared and read back, and how the calendar shows a
 * day nobody is working. The server half of the same rules is in api-smoke's group 17 —
 * except the cancellation window, whose whole point is the timezone the host runs in, and
 * which is therefore pinned at the bottom of this file instead.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { bookingStatus, BOOKING_STATUSES } from './booking-status.mjs';

import { toMinutes } from '../src/lib/time.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readUi = (name) => fs.readFileSync(path.join(root, 'ui', name), 'utf8');

const settingsHtml = readUi('cai-dat-salon.html');
const staffHtml = readUi('quan-ly-nhan-vien.html');
const calendarHtml = readUi('quan-ly-lich-hen.html');

const source = fs.readFileSync(path.join(root, 'server', 'src', 'routes', 'bookings.js'), 'utf8');

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
