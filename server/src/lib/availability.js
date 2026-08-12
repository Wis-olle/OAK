/*
 * Booking availability, computed the same way for every consumer: the service detail
 * page, the staff week grid, the search "còn lịch" flag and booking creation all call
 * in here.
 *
 * A slot is a start time. For a service it is available when at least one candidate
 * staff member is both on shift and free for the whole service duration; for a chosen
 * technician only that one person counts. Every shift is first clamped to the salon's
 * opening hours for that weekday, so a day the salon declared closed offers nothing
 * however the roster reads.
 */

import { db } from '../db.js';
import { addDaysISO, fromMinutes, toMinutes, weekdayOf } from './time.js';

const SLOT_STEP_MIN = 30;
const FALLBACK_DURATION_MIN = 60;
const DAY_START_MIN = 0;
const DAY_END_MIN = 23 * 60 + 59;

const selectService = db.prepare('SELECT id, salon_id, duration_min FROM services WHERE id = ?');

// Candidate staff for a service on one weekday, already filtered to working days.
const selectServiceShifts = db.prepare(`
  SELECT st.id, sch."start", sch."end"
  FROM staff st
  JOIN staff_services ss ON ss.staff_id = st.id
  JOIN staff_schedule sch ON sch.staff_id = st.id
  WHERE ss.service_id = ? AND st.active = 1 AND sch.weekday = ? AND sch.is_off = 0
`);

// Joined to staff so one round trip yields both the shift and the salon whose opening
// hours it has to fit inside; staffDaySlots is only ever handed a staff id.
const selectStaffShift = db.prepare(`
  SELECT sch."start", sch."end", st.salon_id
  FROM staff_schedule sch
  JOIN staff st ON st.id = sch.staff_id
  WHERE sch.staff_id = ? AND sch.weekday = ? AND sch.is_off = 0
`);

// The salon's own opening hours for one weekday. Every shift is clamped to these: the
// roster says who is rostered, the salon says whether its doors are open at all.
const selectSalonHours = db.prepare(
  'SELECT "start", "end", is_off FROM salon_hours WHERE salon_id = ? AND weekday = ?',
);

const selectStaffMaxDuration = db.prepare(`
  SELECT MAX(sv.duration_min) AS duration_min
  FROM staff_services ss
  JOIN services sv ON sv.id = ss.service_id
  WHERE ss.staff_id = ?
`);

// Joined so one round trip yields both the start time and the length to block out.
// Bookings with staff_id NULL never match, which is intended: they block nobody.
const selectStaffBookings = db.prepare(`
  SELECT b.time, sv.duration_min
  FROM bookings b
  JOIN services sv ON sv.id = b.service_id
  WHERE b.staff_id = ? AND b.date = ? AND b.status IN ('pending', 'confirmed')
`);

const selectSalonServiceIds = db.prepare(
  "SELECT id FROM services WHERE salon_id = ? AND active = 1 AND category <> 'amenity'",
);

/** Busy [start, end) minute ranges for one staff member on one date. */
async function busyRanges(staffId, date) {
  const ranges = [];
  for (const booking of await selectStaffBookings.all(staffId, date)) {
    const start = toMinutes(booking.time);
    if (start === null) {
      continue;
    }
    ranges.push([start, start + (booking.duration_min ?? FALLBACK_DURATION_MIN)]);
  }
  return ranges;
}

function isFree(ranges, start, duration) {
  return ranges.every(([busyStart, busyEnd]) => !(start < busyEnd && busyStart < start + duration));
}

/**
 * A shift narrowed to the salon's opening window, or null when the salon is closed.
 *
 * `hours` is undefined when the salon has no row for that weekday. That leaves the
 * shift untouched, which is the old behaviour: the boot-time backfill gave every salon
 * that ever published opening times a full week of rows, and a salon with none is a
 * brand-new one that has no staff rostered either, so nothing is lost.
 *
 * 'HH:MM' strings compare correctly as plain text, so the narrowing is a pair of
 * min/max. An empty or inverted window simply yields no starts.
 */
function clampToHours(shift, hours) {
  if (!hours) {
    return shift;
  }
  if (hours.is_off === 1) {
    return null;
  }
  return {
    start: shift.start > hours.start ? shift.start : hours.start,
    end: shift.end < hours.end ? shift.end : hours.end,
  };
}

/** Slot start times inside a shift that still leave room for the full duration. */
function* shiftStarts(shift, duration) {
  const from = toMinutes(shift.start);
  const to = toMinutes(shift.end);
  if (from === null || to === null) {
    return;
  }
  for (let minute = from; minute + duration <= to; minute += SLOT_STEP_MIN) {
    yield minute;
  }
}

/**
 * Is the salon open for the WHOLE of one service starting at that time?
 *
 * The write-side counterpart of clampToHours, which is the read side: a booking that
 * names no technician generates no slots to be clamped, so the rule has to be asked
 * directly. Same conventions — no row for that weekday means unrestricted, an off day
 * means closed, and the service may finish exactly at closing time but not after.
 * A duration that runs past midnight formats above every 'HH:MM' and so is refused.
 */
export async function isSalonOpenFor(salonId, date, time, durationMin) {
  const hours = await selectSalonHours.get(salonId, weekdayOf(date));
  if (!hours) {
    return true;
  }
  if (hours.is_off === 1) {
    return false;
  }
  const end = fromMinutes(toMinutes(time) + (durationMin || FALLBACK_DURATION_MIN));
  return time >= hours.start && end <= hours.end;
}

/** Ordered slots for a service on a date, unioned across every staff who performs it. */
export async function getServiceSlots(serviceId, date) {
  const service = await selectService.get(serviceId);
  if (!service) {
    return [];
  }

  const weekday = weekdayOf(date);
  const hours = await selectSalonHours.get(service.salon_id, weekday);
  const duration = service.duration_min || FALLBACK_DURATION_MIN;
  const availability = new Map();

  for (const shift of await selectServiceShifts.all(serviceId, weekday)) {
    const open = clampToHours(shift, hours);
    if (!open) {
      continue;
    }
    const ranges = await busyRanges(shift.id, date);
    for (const minute of shiftStarts(open, duration)) {
      // One free staff member is enough, so availability ORs across staff.
      availability.set(minute, (availability.get(minute) ?? false) || isFree(ranges, minute, duration));
    }
  }

  return [...availability.keys()]
    .sort((a, b) => a - b)
    .map((minute) => ({ time: fromMinutes(minute), available: availability.get(minute) }));
}

async function staffDaySlots(staffId, date, duration) {
  const weekday = weekdayOf(date);
  const shift = await selectStaffShift.get(staffId, weekday);
  if (!shift) {
    return [];
  }
  const open = clampToHours(shift, await selectSalonHours.get(shift.salon_id, weekday));
  if (!open) {
    return [];
  }
  const ranges = await busyRanges(staffId, date);
  const slots = [];
  for (const minute of shiftStarts(open, duration)) {
    slots.push({ time: fromMinutes(minute), available: isFree(ranges, minute, duration) });
  }
  return slots;
}

/**
 * Ordered slots for ONE technician performing ONE service on a date.
 *
 * Sized by the booked service's duration, not the technician's longest service, which
 * is why getStaffWeek is the wrong tool for a booking check. A staff member with no
 * schedule row for that weekday, or one marked is_off, has no slots at all — and since
 * staff_schedule.staff_id is a foreign key, that also covers an id that does not exist.
 */
export async function getStaffSlots(staffId, serviceId, date) {
  const service = await selectService.get(serviceId);
  if (!service) {
    return [];
  }
  return staffDaySlots(staffId, date, service.duration_min || FALLBACK_DURATION_MIN);
}

/** One entry per day from fromDate, including days the staff member does not work. */
export async function getStaffWeek(staffId, fromDate, days = 7) {
  const duration =
    (await selectStaffMaxDuration.get(staffId))?.duration_min || FALLBACK_DURATION_MIN;
  const week = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = addDaysISO(fromDate, offset);
    week.push({ date, slots: await staffDaySlots(staffId, date, duration) });
  }
  return week;
}

/** Does any service of this salon still have a free slot starting inside the window? */
export async function hasSlotsInRange(salonId, date, timeFrom, timeTo) {
  const from = toMinutes(timeFrom) ?? DAY_START_MIN;
  const to = toMinutes(timeTo) ?? DAY_END_MIN;

  for (const service of await selectSalonServiceIds.all(salonId)) {
    for (const slot of await getServiceSlots(service.id, date)) {
      const minute = toMinutes(slot.time);
      if (slot.available && minute >= from && minute <= to) {
        return true;
      }
    }
  }
  return false;
}
