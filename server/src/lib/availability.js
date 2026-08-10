/*
 * Booking availability, computed the same way for every consumer: the service detail
 * page, the staff week grid, the search "còn lịch" flag and booking creation all call
 * in here.
 *
 * A slot is a start time. For a service it is available when at least one candidate
 * staff member is both on shift and free for the whole service duration; for a chosen
 * technician only that one person counts.
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

const selectStaffShift = db.prepare(
  'SELECT "start", "end" FROM staff_schedule WHERE staff_id = ? AND weekday = ? AND is_off = 0',
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
function busyRanges(staffId, date) {
  const ranges = [];
  for (const booking of selectStaffBookings.all(staffId, date)) {
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

/** Ordered slots for a service on a date, unioned across every staff who performs it. */
export function getServiceSlots(serviceId, date) {
  const service = selectService.get(serviceId);
  if (!service) {
    return [];
  }

  const duration = service.duration_min || FALLBACK_DURATION_MIN;
  const availability = new Map();

  for (const shift of selectServiceShifts.all(serviceId, weekdayOf(date))) {
    const ranges = busyRanges(shift.id, date);
    for (const minute of shiftStarts(shift, duration)) {
      // One free staff member is enough, so availability ORs across staff.
      availability.set(minute, (availability.get(minute) ?? false) || isFree(ranges, minute, duration));
    }
  }

  return [...availability.keys()]
    .sort((a, b) => a - b)
    .map((minute) => ({ time: fromMinutes(minute), available: availability.get(minute) }));
}

function staffDaySlots(staffId, date, duration) {
  const shift = selectStaffShift.get(staffId, weekdayOf(date));
  if (!shift) {
    return [];
  }
  const ranges = busyRanges(staffId, date);
  const slots = [];
  for (const minute of shiftStarts(shift, duration)) {
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
export function getStaffSlots(staffId, serviceId, date) {
  const service = selectService.get(serviceId);
  if (!service) {
    return [];
  }
  return staffDaySlots(staffId, date, service.duration_min || FALLBACK_DURATION_MIN);
}

/** One entry per day from fromDate, including days the staff member does not work. */
export function getStaffWeek(staffId, fromDate, days = 7) {
  const duration = selectStaffMaxDuration.get(staffId)?.duration_min || FALLBACK_DURATION_MIN;
  const week = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = addDaysISO(fromDate, offset);
    week.push({ date, slots: staffDaySlots(staffId, date, duration) });
  }
  return week;
}

/** Does any service of this salon still have a free slot starting inside the window? */
export function hasSlotsInRange(salonId, date, timeFrom, timeTo) {
  const from = toMinutes(timeFrom) ?? DAY_START_MIN;
  const to = toMinutes(timeTo) ?? DAY_END_MIN;

  for (const service of selectSalonServiceIds.all(salonId)) {
    for (const slot of getServiceSlots(service.id, date)) {
      const minute = toMinutes(slot.time);
      if (slot.available && minute >= from && minute <= to) {
        return true;
      }
    }
  }
  return false;
}
