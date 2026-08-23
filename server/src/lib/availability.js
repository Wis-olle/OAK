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
import { addDaysISO, fromMinutes, nowMinutes, todayISO, toMinutes, weekdayOf } from './time.js';

const SLOT_STEP_MIN = 30;
const MINUTES_PER_DAY = 24 * 60;
const FALLBACK_DURATION_MIN = 60;
const DAY_START_MIN = 0;
const DAY_END_MIN = 23 * 60 + 59;

const selectService = db.prepare('SELECT id, salon_id, duration_min FROM services WHERE id = ?');

// Candidate staff for a service on one weekday, already filtered to working days.
// The text is kept apart from the statement because pickAvailableStaff below runs the
// same three queries on the caller's transaction rather than on the pool.
const SERVICE_SHIFTS_SQL = `
  SELECT st.id, sch."start", sch."end"
  FROM staff st
  JOIN staff_services ss ON ss.staff_id = st.id
  JOIN staff_schedule sch ON sch.staff_id = st.id
  WHERE ss.service_id = ? AND st.active = 1 AND sch.weekday = ? AND sch.is_off = 0
  ORDER BY st.id
`;
const selectServiceShifts = db.prepare(SERVICE_SHIFTS_SQL);

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
const SALON_HOURS_SQL =
  'SELECT "start", "end", is_off FROM salon_hours WHERE salon_id = ? AND weekday = ?';
const selectSalonHours = db.prepare(SALON_HOURS_SQL);

const selectStaffSalon = db.prepare('SELECT salon_id FROM staff WHERE id = ?');

const selectStaffMaxDuration = db.prepare(`
  SELECT MAX(sv.duration_min) AS duration_min
  FROM staff_services ss
  JOIN services sv ON sv.id = ss.service_id
  WHERE ss.staff_id = ?
`);

// Joined so one round trip yields both the start time and the length to block out.
// Bookings with staff_id NULL never match, which is intended: they block nobody.
const STAFF_BOOKINGS_SQL = `
  SELECT b.time, sv.duration_min
  FROM bookings b
  JOIN services sv ON sv.id = b.service_id
  WHERE b.staff_id = ? AND b.date = ? AND b.status IN ('pending', 'confirmed')
`;
const selectStaffBookings = db.prepare(STAFF_BOOKINGS_SQL);

// The salon's own online-booking settings. Only lead_time_min matters in here; the
// cancel cutoff is a rule about undoing a booking, not about offering an hour.
const SALON_SETTINGS_SQL = 'SELECT lead_time_min FROM salons WHERE id = ?';
const selectSalonSettings = db.prepare(SALON_SETTINGS_SQL);

// Every day-off row of one salon that covers one date, both ends inclusive. staff_id NULL
// is the whole salon; a named technician takes only their own column out.
const TIME_OFF_SQL = `
  SELECT staff_id
  FROM time_off
  WHERE salon_id = ? AND date_from <= ? AND date_to >= ?
`;
const selectTimeOff = db.prepare(TIME_OFF_SQL);

/**
 * Who is off at this salon on this date: the salon itself, and which technicians.
 *
 * One query per date rather than per staff member, because a day is asked about as a
 * whole everywhere it is asked about at all.
 */
export async function timeOffOn(salonId, date) {
  const rows = await selectTimeOff.all(salonId, date, date);
  return {
    salon: rows.some((row) => row.staff_id === null),
    staff: new Set(rows.map((row) => row.staff_id).filter((id) => id !== null)),
  };
}

/** The salon a service belongs to, and that salon's lead time, in one read. */
export async function salonSettingsForService(serviceId) {
  const service = await selectService.get(serviceId);
  if (!service) {
    return null;
  }
  return {
    salon_id: service.salon_id,
    lead_time_min: (await selectSalonSettings.get(service.salon_id))?.lead_time_min ?? 0,
  };
}

/** Whole days from today to `date`, in Vietnam time. Negative for a date already past. */
function daysAhead(date) {
  const [thisYear, thisMonth, thisDay] = todayISO().split('-').map(Number);
  const [year, month, day] = String(date).split('-').map(Number);
  return Math.round(
    (Date.UTC(year, month - 1, day) - Date.UTC(thisYear, thisMonth - 1, thisDay)) / 86400000,
  );
}

/**
 * The earliest minute of `date` a booking may start at, given the salon's lead time.
 *
 * Expressed in that date's own minutes so it can be compared with a slot directly: a lead
 * time of two hours at 15:00 makes 17:00 the floor today, and nothing at all tomorrow.
 * A date already behind us yields a floor no slot can clear.
 */
function leadFloor(date, leadMin) {
  const offset = daysAhead(date);
  if (offset < 0) {
    return Number.POSITIVE_INFINITY;
  }
  return nowMinutes() + (leadMin || 0) - offset * MINUTES_PER_DAY;
}

async function leadFloorFor(salonId, date) {
  return leadFloor(date, (await selectSalonSettings.get(salonId))?.lead_time_min ?? 0);
}

const selectSalonServiceIds = db.prepare(
  "SELECT id FROM services WHERE salon_id = ? AND active = 1 AND category <> 'amenity'",
);

/** Busy [start, end) minute ranges from rows of {time, duration_min}. */
function toRanges(bookings) {
  const ranges = [];
  for (const booking of bookings) {
    const start = toMinutes(booking.time);
    if (start === null) {
      continue;
    }
    ranges.push([start, start + (booking.duration_min ?? FALLBACK_DURATION_MIN)]);
  }
  return ranges;
}

/** Busy [start, end) minute ranges for one staff member on one date. */
async function busyRanges(staffId, date) {
  return toRanges(await selectStaffBookings.all(staffId, date));
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

/**
 * Slot start times inside a shift that still leave room for the full duration.
 *
 * `floor` is the salon's lead time expressed in this date's minutes: an hour before it has
 * either already passed or is nearer than the salon accepts, and is not a start time at all.
 */
function* shiftStarts(shift, duration, floor) {
  const from = toMinutes(shift.start);
  const to = toMinutes(shift.end);
  if (from === null || to === null) {
    return;
  }
  for (let minute = from; minute + duration <= to; minute += SLOT_STEP_MIN) {
    if (minute >= floor) {
      yield minute;
    }
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

/**
 * Is `time` far enough ahead for this salon's lead time?
 *
 * The write-side counterpart of the floor the slot lists are built with: a booking that
 * names no technician generates no slots to be filtered, so the rule has to be asked
 * directly, exactly as isSalonOpenFor asks about the opening hours.
 */
export async function respectsLeadTime(salonId, date, time) {
  return toMinutes(time) >= (await leadFloorFor(salonId, date));
}

/**
 * Ordered slots for a service on a date, unioned across every staff who performs it.
 *
 * `knownOff` and `leadMin` are the same seam staffDaySlots has, for the same reason: a
 * caller looping over a week already holds the day-off rows (it needs them for its own
 * `closed` flag) and the salon's lead time cannot change between the days of one request.
 */
export async function getServiceSlots(serviceId, date, knownOff = null, leadMin = null) {
  const service = await selectService.get(serviceId);
  if (!service) {
    return [];
  }

  const weekday = weekdayOf(date);
  const off = knownOff ?? (await timeOffOn(service.salon_id, date));
  if (off.salon) {
    return [];
  }
  const hours = await selectSalonHours.get(service.salon_id, weekday);
  const duration = service.duration_min || FALLBACK_DURATION_MIN;
  const floor =
    leadMin === null ? await leadFloorFor(service.salon_id, date) : leadFloor(date, leadMin);
  const availability = new Map();

  for (const shift of await selectServiceShifts.all(serviceId, weekday)) {
    const open = off.staff.has(shift.id) ? null : clampToHours(shift, hours);
    if (!open) {
      continue;
    }
    const ranges = await busyRanges(shift.id, date);
    for (const minute of shiftStarts(open, duration, floor)) {
      // One free staff member is enough, so availability ORs across staff.
      availability.set(minute, (availability.get(minute) ?? false) || isFree(ranges, minute, duration));
    }
  }

  return [...availability.keys()]
    .sort((a, b) => a - b)
    .map((minute) => ({ time: fromMinutes(minute), available: availability.get(minute) }));
}

/**
 * `off` and `leadMin` are the two facts about the day that a caller looping over dates
 * already holds: getStaffWeek reads the day-off rows for its own `closed` flag, and the
 * salon's lead time cannot change between the days of one request. Passing them in keeps
 * a seven-day grid from asking the same two questions fourteen times over.
 */
async function staffDaySlots(staffId, date, duration, knownOff = null, leadMin = null) {
  const weekday = weekdayOf(date);
  const shift = await selectStaffShift.get(staffId, weekday);
  if (!shift) {
    return [];
  }
  const off = knownOff ?? (await timeOffOn(shift.salon_id, date));
  if (off.salon || off.staff.has(staffId)) {
    return [];
  }
  const open = clampToHours(shift, await selectSalonHours.get(shift.salon_id, weekday));
  if (!open) {
    return [];
  }
  const floor =
    leadMin === null ? await leadFloorFor(shift.salon_id, date) : leadFloor(date, leadMin);
  const ranges = await busyRanges(staffId, date);
  const slots = [];
  for (const minute of shiftStarts(open, duration, floor)) {
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

/**
 * Which technician takes a booking that named none — "Bất kỳ" as a real reservation.
 *
 * Runs on `tx`, the caller's own transaction, so what it reads and what the INSERT
 * writes cannot drift apart. Candidates are the staff assigned to the service and on
 * shift that weekday, clamped to the salon's hours like every other read here. Among
 * those free for the whole duration at `time`, the one with the most of the day still
 * open wins, so repeat "Bất kỳ" bookings spread across the roster instead of piling
 * onto whoever comes first. Null when nobody is free, which the caller answers as
 * SLOT_TAKEN — the same answer a named technician gets.
 *
 * What the transaction does NOT give is isolation between two of them:
 * idx_bookings_slot is UNIQUE(staff_id, date, time), so it rejects a second booking at the
 * SAME start time and nothing else. Two READ COMMITTED transactions booking 10:00 and 10:30
 * of the same 60-minute service can each read the roster before the other commits, pick the
 * same technician and both insert — an overlap no index covers, and the named-technician
 * path has the same hole because getStaffSlots is read outside the transaction. Closing it
 * needs a SELECT … FOR UPDATE over the candidate's bookings in here, or an exclusion
 * constraint over a tsrange; ticketed, not done.
 */
export async function pickAvailableStaff(tx, salonId, serviceId, date, time, durationMin) {
  const duration = durationMin || FALLBACK_DURATION_MIN;
  const weekday = weekdayOf(date);
  const offRows = await tx.all(TIME_OFF_SQL, salonId, date, date);
  if (offRows.some((row) => row.staff_id === null)) {
    return null;
  }
  const offStaff = new Set(offRows.map((row) => row.staff_id));
  const hours = await tx.get(SALON_HOURS_SQL, salonId, weekday);
  const floor = leadFloor(date, (await tx.get(SALON_SETTINGS_SQL, salonId))?.lead_time_min ?? 0);
  let chosen = null;

  for (const shift of await tx.all(SERVICE_SHIFTS_SQL, serviceId, weekday)) {
    const open = offStaff.has(shift.id) ? null : clampToHours(shift, hours);
    if (!open) {
      continue;
    }
    const ranges = toRanges(await tx.all(STAFF_BOOKINGS_SQL, shift.id, date));
    let free = 0;
    let freeAtTime = false;
    for (const minute of shiftStarts(open, duration, floor)) {
      if (!isFree(ranges, minute, duration)) {
        continue;
      }
      free += 1;
      freeAtTime = freeAtTime || fromMinutes(minute) === time;
    }
    if (freeAtTime && (chosen === null || free > chosen.free)) {
      chosen = { id: shift.id, free };
    }
  }

  return chosen === null ? null : chosen.id;
}

/**
 * One entry per day from fromDate, including days the staff member does not work.
 *
 * `closed` separates the two ways a day can have no hours: the salon or the technician
 * declared it off, versus a full calendar. A day strip strikes through the second and
 * labels the first, and only the day-off rows can tell them apart.
 */
export async function getStaffWeek(staffId, fromDate, days = 7) {
  const duration =
    (await selectStaffMaxDuration.get(staffId))?.duration_min || FALLBACK_DURATION_MIN;
  const salonId = (await selectStaffSalon.get(staffId))?.salon_id ?? null;
  // One read for the whole week: the lead time is a salon setting, not a property of a day.
  const leadMin =
    salonId === null ? 0 : (await selectSalonSettings.get(salonId))?.lead_time_min ?? 0;
  const week = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = addDaysISO(fromDate, offset);
    const off = salonId === null ? { salon: false, staff: new Set() } : await timeOffOn(salonId, date);
    week.push({
      date,
      closed: off.salon || off.staff.has(staffId),
      slots: await staffDaySlots(staffId, date, duration, off, leadMin),
    });
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
