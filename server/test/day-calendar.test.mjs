/*
 * The set-based half of lib/availability.js: the calendar object a whole run of dates is
 * read into, and the arithmetic that turns it into slots.
 *
 * This is the half that answers the dated search and the week strip, so a mistake in it is
 * a salon that quietly stops appearing on the front page — nothing throws, the list is just
 * shorter. The computation is pure once the reading is done, which is exactly what is driven
 * here: synthetic calendars, no database, and one assertion per rule the day obeys.
 *
 * lib/availability.js opens a connection at import time (it prepares its statements against
 * the pool), so it cannot simply be imported. The body below the imports is lifted into a
 * context whose `db` is a stub and whose time helpers are the real lib/time.js — the same
 * trick assistant-parser.test.mjs and events-route.test.mjs use, for the same reason.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  addDaysISO,
  fromMinutes,
  nowMinutes,
  todayISO,
  toMinutes,
  weekdayOf,
} from '../src/lib/time.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const availabilityJs = fs.readFileSync(
  path.join(root, 'src', 'lib', 'availability.js'),
  'utf8',
);

/* Everything the module declares, from the first constant to the end of the file — the
   imports above it are what the context replaces. `export` is stripped because a vm script
   is not a module; the marker is a declaration rather than a comment, so rewording the file
   header cannot change what is under test. */
function lift() {
  const from = availabilityJs.indexOf('const SLOT_STEP_MIN');
  assert.ok(from !== -1, 'availability.js no longer opens with its slot constants');

  const statement = { all: async () => [], get: async () => undefined, run: async () => ({}) };
  const context = {
    db: { prepare: () => statement },
    addDaysISO,
    fromMinutes,
    nowMinutes,
    todayISO,
    toMinutes,
    weekdayOf,
  };
  vm.runInNewContext(
    `${availabilityJs.slice(from).replace(/^export /gm, '')}
     globalThis.lifted = { calendarServiceSlots, calendarSalonHasSlots, unionSlots };`,
    context,
  );
  return context.lifted;
}

const { calendarServiceSlots, calendarSalonHasSlots, unionSlots } = lift();

/* Far enough ahead that the salon's lead time cannot reach it, so every assertion below is
   about the roster rather than about what time this suite happens to run at. */
const DATE = addDaysISO(todayISO(), 30);
const WEEKDAY = weekdayOf(DATE);

/**
 * A calendar holding one salon, one 60-minute service and whichever technicians are named,
 * each on a 09:00–12:00 shift inside 09:00–18:00 opening hours. Every keyed collection is
 * built the way loadDayCalendar builds it, so a change to a key shape fails here too.
 */
function calendarOf({ staff = [1], hours = { start: '09:00', end: '18:00', is_off: 0 },
  duration = 60, offSalon = false, offStaff = [], busy = {} } = {}) {
  const service = { id: 10, salon_id: 1, duration_min: duration };
  return {
    dates: [DATE],
    services: new Map([[service.id, service]]),
    salonServiceIds: new Map([[1, [service.id]]]),
    leadMin: new Map([[1, 0]]),
    hours: hours === null ? new Map() : new Map([[`1:${WEEKDAY}`, hours]]),
    offSalonDays: new Set(offSalon ? [`1:${DATE}`] : []),
    offStaffDays: new Set(offStaff.map((id) => `${id}:${DATE}`)),
    shifts: new Map([
      [
        `${service.id}:${WEEKDAY}`,
        staff.map((id) => ({ service_id: service.id, id, weekday: WEEKDAY, start: '09:00', end: '12:00' })),
      ],
    ]),
    busy: new Map(Object.entries(busy).map(([id, ranges]) => [`${id}:${DATE}`, ranges])),
  };
}

/* The lifted code runs in a realm of its own, so its arrays and objects fail a strict deep
   compare on their prototype alone. Copying the values brings them back into this one. */
const plain = (slots) => [...slots].map((slot) => ({ time: slot.time, available: slot.available }));
const times = (slots) => plain(slots).map((slot) => slot.time);
const freeTimes = (slots) => plain(slots).filter((slot) => slot.available).map((slot) => slot.time);

test('a shift becomes half-hourly starts that leave room for the whole service', () => {
  const slots = calendarServiceSlots(calendarOf(), 10, DATE);
  // 09:00–12:00 with a 60-minute service: the last start that still finishes by noon is 11:00.
  assert.deepEqual(times(slots), ['09:00', '09:30', '10:00', '10:30', '11:00']);
  assert.deepEqual(freeTimes(slots), times(slots));
});

test('one free technician is enough, and a booking only blocks the one who took it', () => {
  // Both work 09:00–12:00; technician 1 is booked 10:00–11:00. Every start stays offered,
  // because technician 2 can take all of them.
  const slots = calendarServiceSlots(
    calendarOf({ staff: [1, 2], busy: { 1: [[600, 660]] } }), 10, DATE,
  );
  assert.deepEqual(freeTimes(slots), ['09:00', '09:30', '10:00', '10:30', '11:00']);
});

test('a booking blocks every start it runs through, not only the minute it begins on', () => {
  // The one technician is booked 10:00–11:00, so 09:30 (which would run into it) and 10:30
  // go with 10:00. This is the half the unique index cannot express.
  const slots = calendarServiceSlots(calendarOf({ busy: { 1: [[600, 660]] } }), 10, DATE);
  assert.deepEqual(freeTimes(slots), ['09:00', '11:00']);
  assert.deepEqual(times(slots), ['09:00', '09:30', '10:00', '10:30', '11:00']);
});

test('the salon narrows the roster: a shift is clamped to the hours the doors are open', () => {
  const slots = calendarServiceSlots(
    calendarOf({ hours: { start: '10:00', end: '11:30', is_off: 0 } }), 10, DATE,
  );
  assert.deepEqual(times(slots), ['10:00', '10:30']);
});

test('a day the salon declared off offers nothing, however the roster reads', () => {
  assert.deepEqual(
    plain(calendarServiceSlots(calendarOf({ hours: { start: '09:00', end: '18:00', is_off: 1 } }), 10, DATE)),
    [],
  );
  assert.deepEqual(plain(calendarServiceSlots(calendarOf({ offSalon: true }), 10, DATE)), []);
});

test('a weekday the salon has never described is closed, not unrestricted', () => {
  assert.deepEqual(plain(calendarServiceSlots(calendarOf({ hours: null }), 10, DATE)), []);
});

test('a technician on leave takes only her own column out', () => {
  assert.deepEqual(plain(calendarServiceSlots(calendarOf({ offStaff: [1] }), 10, DATE)), []);
  assert.deepEqual(
    times(calendarServiceSlots(calendarOf({ staff: [1, 2], offStaff: [1] }), 10, DATE)),
    ['09:00', '09:30', '10:00', '10:30', '11:00'],
  );
});

test('a service the calendar was never loaded for has no slots rather than all of them', () => {
  assert.deepEqual(plain(calendarServiceSlots(calendarOf(), 999, DATE)), []);
  assert.deepEqual(plain(calendarServiceSlots(calendarOf(), 10, addDaysISO(DATE, 1))), []);
});

test('a salon has slots only when a free one falls inside the window asked about', () => {
  const calendar = calendarOf({ busy: { 1: [[600, 660]] } });
  // Free at 09:00 and 11:00; 10:00–10:59 holds nothing.
  assert.equal(calendarSalonHasSlots(calendar, 1, DATE, 0, 24 * 60), true);
  assert.equal(calendarSalonHasSlots(calendar, 1, DATE, toMinutes('11:00'), 24 * 60), true);
  assert.equal(calendarSalonHasSlots(calendar, 1, DATE, toMinutes('10:00'), toMinutes('10:59')), false);
  assert.equal(calendarSalonHasSlots(calendar, 2, DATE, 0, 24 * 60), false);
});

test('a salon whose every hour is taken is not a match on a dated search', () => {
  const calendar = calendarOf({ busy: { 1: [[0, 24 * 60]] } });
  assert.equal(calendarSalonHasSlots(calendar, 1, DATE, 0, 24 * 60), false);
  assert.deepEqual(freeTimes(calendarServiceSlots(calendar, 10, DATE)), []);
});

test('the lead time is a floor on the minute, and a date already past clears nothing', () => {
  const soon = { ...calendarOf(), leadMin: new Map([[1, 0]]) };
  const yesterday = addDaysISO(todayISO(), -1);
  const past = {
    ...soon,
    hours: new Map([[`1:${weekdayOf(yesterday)}`, { start: '09:00', end: '18:00', is_off: 0 }]]),
    shifts: new Map([
      [
        `10:${weekdayOf(yesterday)}`,
        [{ service_id: 10, id: 1, weekday: weekdayOf(yesterday), start: '09:00', end: '12:00' }],
      ],
    ]),
  };
  assert.deepEqual(plain(calendarServiceSlots(past, 10, yesterday)), []);
});

test('a single shift and a union across two run through the same arithmetic', () => {
  const one = [{ start: '09:00', end: '11:00', ranges: [] }];
  assert.deepEqual(
    plain(unionSlots(one, 60, Number.NEGATIVE_INFINITY)),
    [
      { time: '09:00', available: true },
      { time: '09:30', available: true },
      { time: '10:00', available: true },
    ],
  );
  // Two shifts covering the same minute: busy on one, free on the other, offered once.
  const two = [
    { start: '09:00', end: '11:00', ranges: [[540, 600]] },
    { start: '09:00', end: '11:00', ranges: [] },
  ];
  assert.equal(plain(unionSlots(two, 60, Number.NEGATIVE_INFINITY)).length, 3);
  assert.ok(plain(unionSlots(two, 60, Number.NEGATIVE_INFINITY)).every((slot) => slot.available));
});

/* ============================================================================
 * The shape of the reading, pinned in the source
 * ========================================================================= */

test('the dated search and the week strip read their calendars in one go', () => {
  const search = fs.readFileSync(path.join(root, 'src', 'routes', 'search.js'), 'utf8');
  const services = fs.readFileSync(path.join(root, 'src', 'routes', 'services.js'), 'utf8');

  /* The whole point: one call for every salon the search matched, and one for every day of
     the strip. A `for` loop with an `await` inside it is the shape that was costing a round
     trip per chair, and it is the shape that must not come back. */
  assert.match(search, /await salonsWithSlotsInRange\(\s*filtered\.map\(/);
  assert.doesNotMatch(search, /for \(const item of filtered\) \{\s*\n\s*if \(await /);
  assert.match(services, /await loadDayCalendar\(\{/);
  assert.doesNotMatch(services, /for \(let offset = 0; offset < days;/);

  /* The statements the calendar is read through, and the promise each of them makes: it is
     asked about a LIST. One that took a single id would be the walk growing back inside the
     thing that replaced it, and nothing else would notice. */
  for (const name of [
    'CALENDAR_SERVICES_BY_SALON_SQL', 'CALENDAR_SERVICES_BY_ID_SQL', 'CALENDAR_HOURS_SQL',
    'CALENDAR_LEAD_SQL', 'CALENDAR_TIME_OFF_SQL', 'CALENDAR_SHIFTS_SQL', 'CALENDAR_BOOKINGS_SQL',
  ]) {
    assert.match(availabilityJs, new RegExp(`db\\.prepare\\(${name}\\)`), name);
    const sql = availabilityJs.slice(availabilityJs.indexOf(`const ${name}`));
    assert.match(sql.slice(0, sql.indexOf(';')), /= ANY\(\?\)/, name);
  }
});
