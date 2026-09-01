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

// The link itself, asked about one pair at a time by staffCanDo below.
const STAFF_SERVICE_SQL = 'SELECT 1 FROM staff_services WHERE staff_id = ? AND service_id = ?';
const selectStaffService = db.prepare(STAFF_SERVICE_SQL);

/**
 * THE RULE: a technician performs a service when a staff_services row links the two, and
 * never otherwise. An empty list of links means she performs NOTHING, not everything.
 *
 * Written down once here because it used to be answered two ways. The customer paths asked
 * for the row and the console's own walk-in create did not, so a technician nobody had
 * linked to anything was unbookable to a customer and bookable to everybody at the counter —
 * and the counter's answer was the dangerous one, since pickAvailableStaff and the departure
 * sweep both read candidates through SERVICE_SHIFTS_SQL above and would never hand her the
 * work back. One rule, and it is the strict one, because that is the one the slot arithmetic
 * has always been built on.
 *
 * The forgiving half of the bargain is at the other end, where a roster row is created:
 * POST /api/partner/staff links a new technician to the salon's whole menu unless the request
 * says otherwise, and POST /api/partner/services links a new service to the whole roster. So
 * strictness here refuses the mistake without ever stranding a salon that made none.
 *
 * `handle` is the pool (db) or a caller's transaction. The two expose different shapes, which
 * is why the SQL text is kept beside the prepared statement — the same seam pickAvailableStaff
 * below runs its three queries through. Every caller today is a pre-check on the pool: the
 * transaction branch has no production caller yet, and is here so that a call site that has
 * to read this under the same lock it writes with does not have to restate the rule.
 */
export async function staffCanDo(handle, staffId, serviceId) {
  const row =
    typeof handle.prepare === 'function'
      ? await selectStaffService.get(staffId, serviceId)
      : await handle.get(STAFF_SERVICE_SQL, staffId, serviceId);
  return Boolean(row);
}

// Joined to staff so one round trip yields both the shift and the salon whose opening
// hours it has to fit inside; staffDaySlots is only ever handed a staff id. st.active = 1
// for the same reason SERVICE_SHIFTS_SQL above carries it: a technician who has left keeps
// her schedule rows, and a day strip built from them would go on selling her hours.
const selectStaffShift = db.prepare(`
  SELECT sch."start", sch."end", st.salon_id
  FROM staff_schedule sch
  JOIN staff st ON st.id = sch.staff_id
  WHERE sch.staff_id = ? AND st.active = 1 AND sch.weekday = ? AND sch.is_off = 0
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
// The same rows with one taken out, for a booking that is being MOVED: an appointment must
// not be found clashing with the hour it is already sitting on. IS DISTINCT FROM rather than
// <>, so a null id — a create, which has no row yet — simply excludes nothing.
//
// Every read of a technician's day goes through this one, exception or none. A grid that
// counted the appointment being moved as busy would refuse the customer the half-hour next
// to their own booking — an overlap with nobody but themselves — and the write side would
// then have to disagree with the grid to be right.
const OTHER_STAFF_BOOKINGS_SQL = `${STAFF_BOOKINGS_SQL} AND b.id IS DISTINCT FROM ?`;
const selectOtherStaffBookings = db.prepare(OTHER_STAFF_BOOKINGS_SQL);

/*
 * The one lock every write that holds an hour takes first.
 *
 * Postgres reads at READ COMMITTED here, so two transactions checking the same calendar
 * before either commits both see it empty and both write into it — and idx_bookings_slot,
 * UNIQUE(staff_id, date, time), only catches the pair that chose the SAME minute. 10:00 and
 * 10:30 of a 60-minute service are two different minutes and one double-booked technician.
 * Render's cold start makes that the ordinary case rather than the rare one: requests queue
 * while the instance wakes and are released together.
 *
 * An advisory lock rather than SELECT ... FOR UPDATE because the thing being reserved is a
 * DAY, not a row — a booking that does not exist yet cannot be locked, and the free hour it
 * is about to take is exactly what has to be held. hashtext() turns the key into the bigint
 * the lock is really on; two unrelated days that collide there cost each other one wait and
 * never a wrong answer. xact, so it is released by COMMIT or ROLLBACK with nothing to unlock
 * by hand.
 *
 * ONE key shape, the salon's day, and every writer takes it — the customer naming a
 * technician, the customer naming nobody, and both counter doors. A key per technician looks
 * tighter and is not: "Bất kỳ" has to read the whole roster before it knows whose day it is
 * about to fill, so it can only hold the salon, and a named booking holding some other key
 * does not exclude it. Two such writers racing for overlapping minutes on one technician
 * would then both commit, which is the entire bug. A salon's bookings are therefore
 * serialised per day; a day is a small enough unit that this costs a busy salon one short
 * wait, and lockDayTimeout below puts a ceiling on even that.
 */
const ADVISORY_LOCK_SQL = 'SELECT pg_advisory_xact_lock(hashtext(?))';

/* How long a writer will queue behind the salon's day before giving the customer an answer
   instead. An advisory wait holds a pool connection while it waits, and the pool is five
   deep: unbounded, one wedged transaction takes the whole instance down with it rather than
   one booking. Postgres raises 55P03 (lock_not_available) on expiry, which the routes answer
   as SLOT_BUSY — "try again in a moment", which is true, rather than "the hour is taken",
   which is not. SET LOCAL, so it is undone by the same COMMIT or ROLLBACK as the lock. */
const LOCK_TIMEOUT = '3s';
const LOCK_TIMEOUT_SQL = `SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`;

/** Hold one salon's whole day for the rest of `tx`, or throw 55P03 after LOCK_TIMEOUT. */
export async function lockSalonDay(tx, salonId, date) {
  await tx.run(LOCK_TIMEOUT_SQL);
  await tx.get(ADVISORY_LOCK_SQL, `salon:${salonId}:${date}`);
}

/**
 * What this technician's day says about starting that service at that time, on `tx`'s view:
 * null when she is free, 'exact' when another booking starts on that very minute, 'overlap'
 * when one merely runs through it.
 *
 * The question the unique index cannot ask, and the two answers are not the same answer.
 * 'overlap' is a judgement about hours the counter may know better than this table does, so
 * it may be overruled; 'exact' is a row idx_bookings_slot will refuse whatever anyone says,
 * so offering to save it anyway would be the console promising something it cannot do.
 *
 * Read on the caller's transaction and meant to be called under lockSalonDay above — on its
 * own it is the same check-then-act the index was standing in for. `exceptBookingId` is the
 * row being moved, which is never in its own way.
 */
export async function staffClashAt(tx, staffId, date, time, durationMin, exceptBookingId = null) {
  const start = toMinutes(time);
  // An hour nobody can parse is not free, and not something the counter may overrule into
  // the table either. It cannot arrive here — every route validates the time first — and
  // answering "free" if it ever did would write it.
  if (start === null) {
    return 'exact';
  }
  const rows = await tx.all(OTHER_STAFF_BOOKINGS_SQL, staffId, date, exceptBookingId);
  if (rows.some((row) => row.time === time)) {
    return 'exact';
  }
  return isFree(toRanges(rows), start, durationMin || FALLBACK_DURATION_MIN) ? null : 'overlap';
}

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

/**
 * Busy [start, end) minute ranges for one staff member on one date.
 *
 * `exceptBookingId` is the appointment being moved, which is never in its own way: the
 * hour it is sitting on is about to be given back, so counting it would hide exactly the
 * hours a reschedule is most likely to want.
 */
async function busyRanges(staffId, date, exceptBookingId = null) {
  return toRanges(await selectOtherStaffBookings.all(staffId, date, exceptBookingId));
}

function isFree(ranges, start, duration) {
  return ranges.every(([busyStart, busyEnd]) => !(start < busyEnd && busyStart < start + duration));
}

/**
 * A shift narrowed to the salon's opening window, or null when the salon is closed.
 *
 * `hours` is undefined when the salon has no row for that weekday, and that reads as closed.
 * It used to leave the shift untouched — "no row means no restriction" — which made a salon
 * with a partial week bookable around the clock on every day it had never described. Nothing
 * writes a partial week: the console replaces all seven rows at once, the importer writes all
 * seven (closed for the days the source never named) and the boot backfill fans the legacy
 * open/close pair across the week. So a missing row is not an unrestricted day, it is a salon
 * that has not said when it opens — and one of those is not ready to be listed either
 * (has_hours, routes/partner.js).
 *
 * 'HH:MM' strings compare correctly as plain text, so the narrowing is a pair of
 * min/max. An empty or inverted window simply yields no starts.
 */
function clampToHours(shift, hours) {
  if (!hours) {
    return null;
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
 * The slot arithmetic itself, over shifts whose calendars are already in hand.
 *
 * Every shift is a window already clamped to the salon's hours, carrying the busy ranges
 * of the technician who works it. One free technician is enough, so availability ORs
 * across them; a minute nobody is rostered for is not a slot at all and never enters the
 * map. A single shift in the list is the one-technician answer, which is why the staff
 * grid comes through here too.
 *
 * Kept as the one place this is computed because there are now two ways to reach it: a
 * caller asking about one service on one day and reading its calendars as it goes, and a
 * caller that loaded a whole week of salons in one go (loadDayCalendar below). The two
 * read differently and must answer identically, and the only way to promise that is for
 * there to be one arithmetic underneath both.
 */
function unionSlots(shifts, duration, floor) {
  const availability = new Map();
  for (const shift of shifts) {
    for (const minute of shiftStarts(shift, duration, floor)) {
      availability.set(
        minute,
        (availability.get(minute) ?? false) || isFree(shift.ranges, minute, duration),
      );
    }
  }
  return [...availability.keys()]
    .sort((a, b) => a - b)
    .map((minute) => ({ time: fromMinutes(minute), available: availability.get(minute) }));
}

/**
 * Is the salon open for the WHOLE of one service starting at that time?
 *
 * The write-side counterpart of clampToHours, which is the read side: a booking that
 * names no technician generates no slots to be clamped, so the rule has to be asked
 * directly. Same conventions as clampToHours — no row for that weekday means closed, an off
 * day means closed, and the service may finish exactly at closing time but not after.
 * A duration that runs past midnight formats above every 'HH:MM' and so is refused.
 */
export async function isSalonOpenFor(salonId, date, time, durationMin) {
  const hours = await selectSalonHours.get(salonId, weekdayOf(date));
  if (!hours) {
    return false;
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
 * `exceptBookingId` is busyRanges's, passed straight down.
 */
export async function getServiceSlots(
  serviceId, date, knownOff = null, leadMin = null, exceptBookingId = null,
) {
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
  const shifts = [];

  for (const shift of await selectServiceShifts.all(serviceId, weekday)) {
    const open = off.staff.has(shift.id) ? null : clampToHours(shift, hours);
    if (!open) {
      continue;
    }
    shifts.push({ ...open, ranges: await busyRanges(shift.id, date, exceptBookingId) });
  }

  return unionSlots(shifts, duration, floor);
}

/**
 * `off` and `leadMin` are the two facts about the day that a caller looping over dates
 * already holds: getStaffWeek reads the day-off rows for its own `closed` flag, and the
 * salon's lead time cannot change between the days of one request. Passing them in keeps
 * a seven-day grid from asking the same two questions fourteen times over.
 */
async function staffDaySlots(
  staffId, date, duration, knownOff = null, leadMin = null, exceptBookingId = null,
) {
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
  // One shift, so the union across technicians unions across exactly one — the same
  // arithmetic the service-wide answer is built from, which is the point of sharing it.
  const ranges = await busyRanges(staffId, date, exceptBookingId);
  return unionSlots([{ ...open, ranges }], duration, floor);
}

/**
 * Ordered slots for ONE technician performing ONE service on a date.
 *
 * Sized by the booked service's duration, not the technician's longest service, which
 * is why getStaffWeek is the wrong tool for a booking check. A staff member with no
 * schedule row for that weekday, or one marked is_off, has no slots at all — and since
 * staff_schedule.staff_id is a foreign key, that also covers an id that does not exist.
 *
 * `knownOff` and `leadMin` are staffDaySlots's own seam, passed straight through for the
 * caller that walks a week and already holds both (routes/staff.js getServiceWeek), and so
 * is `exceptBookingId`, the appointment being moved.
 */
export async function getStaffSlots(
  staffId, serviceId, date, knownOff = null, leadMin = null, exceptBookingId = null,
) {
  const service = await selectService.get(serviceId);
  if (!service) {
    return [];
  }
  return staffDaySlots(
    staffId, date, service.duration_min || FALLBACK_DURATION_MIN, knownOff, leadMin,
    exceptBookingId,
  );
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
 * What the transaction does not give on its own is isolation between two of them, which is
 * why every caller takes lockSalonDay() above before calling in here: at READ COMMITTED two
 * of these can each read the roster before the other commits, pick the same technician for
 * 10:00 and 10:30 of a 60-minute service, and both insert — two different minutes, so
 * idx_bookings_slot never sees them. Under the salon's day key they queue instead, and the
 * second one reads the first one's booking. It is the same key a booking that NAMES a
 * technician takes, which is the point of there being only one: this function cannot know
 * whose day it is about to fill until it has read them all. Nothing in here takes the lock
 * itself — the INSERT that follows has to be inside the same transaction as the pick, so the
 * lock belongs to whoever owns both.
 *
 * `exceptBookingId` is the appointment being moved. Without it a "Bất kỳ" move onto an hour
 * that overlaps the customer's own booking finds its own technician busy and either refuses
 * the move or quietly hands the customer somebody else — and the person they had asked for
 * by having been given her is the one candidate the arithmetic would rule out.
 */
export async function pickAvailableStaff(
  tx, salonId, serviceId, date, time, durationMin, exceptBookingId = null,
) {
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
    const ranges = toRanges(
      await tx.all(OTHER_STAFF_BOOKINGS_SQL, shift.id, date, exceptBookingId),
    );
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

/*
 * ============================================================================
 * The set-based half: a run of dates, read in a handful of queries
 * ==========================================================================
 *
 * Everything above answers about one service or one technician, reading the calendars it
 * needs as it goes. That is the right shape for a booking wizard and the wrong one for a
 * page that asks about a whole city: the dated search used to walk every candidate salon,
 * every service on its menu and every technician who performs it, one round trip per row.
 * Six salons of demo seed cost 88 of them; a real city costs thousands, on a pool five
 * deep, from an endpoint nobody has to sign in to reach — and with the database an ocean
 * away from the instance that is half a minute of waiting and "kiểm tra mạng" on the phone.
 *
 * So the same facts are read for every salon and every date at once — six queries, whatever
 * the size of the question — and the answer is computed from that. The arithmetic is not a
 * second copy of the one above: it clamps with clampToHours, steps with shiftStarts and
 * unions with unionSlots, exactly as getServiceSlots does. The two cannot disagree because
 * there is only one of them, and the smoke suite pins that by asking both.
 */

// Services to answer about. By salon it is the public menu — what a customer could book —
// which is the rule the old per-salon walk used; by id it is whatever was named.
const CALENDAR_SERVICES_BY_SALON_SQL = `
  SELECT id, salon_id, duration_min
  FROM services
  WHERE salon_id = ANY(?) AND active = 1 AND category <> 'amenity'
  ORDER BY id
`;
const CALENDAR_SERVICES_BY_ID_SQL =
  'SELECT id, salon_id, duration_min FROM services WHERE id = ANY(?) ORDER BY id';

// Only the weekdays the window covers: a two-day search has no use for the other five
// rows of every salon's week.
const CALENDAR_HOURS_SQL = `
  SELECT salon_id, weekday, "start", "end", is_off
  FROM salon_hours
  WHERE salon_id = ANY(?) AND weekday = ANY(?)
`;

const CALENDAR_LEAD_SQL = 'SELECT id, lead_time_min FROM salons WHERE id = ANY(?)';

// Rows are ranges, so they are read as ranges and expanded per date below — the same
// inclusive-at-both-ends rule timeOffOn applies one date at a time.
const CALENDAR_TIME_OFF_SQL = `
  SELECT salon_id, staff_id, date_from, date_to
  FROM time_off
  WHERE salon_id = ANY(?) AND date_from <= ? AND date_to >= ?
`;

// SERVICE_SHIFTS_SQL for many services and many weekdays at once, carrying the service and
// the weekday back so the rows can be filed. Same three joins and the same st.active = 1:
// a technician who has left keeps her schedule rows and must sell nothing.
const CALENDAR_SHIFTS_SQL = `
  SELECT ss.service_id, st.id, sch.weekday, sch."start", sch."end"
  FROM staff st
  JOIN staff_services ss ON ss.staff_id = st.id
  JOIN staff_schedule sch ON sch.staff_id = st.id
  WHERE ss.service_id = ANY(?) AND st.active = 1 AND sch.weekday = ANY(?) AND sch.is_off = 0
  ORDER BY st.id
`;

// OTHER_STAFF_BOOKINGS_SQL for every technician the shifts above turned up, across the
// whole window. IS DISTINCT FROM for the reason it carries it there: the appointment being
// moved is never in its own way, and a null id excludes nothing.
const CALENDAR_BOOKINGS_SQL = `
  SELECT b.staff_id, b.date, b.time, sv.duration_min
  FROM bookings b
  JOIN services sv ON sv.id = b.service_id
  WHERE b.staff_id = ANY(?) AND b.date >= ? AND b.date <= ?
    AND b.status IN ('pending', 'confirmed') AND b.id IS DISTINCT FROM ?
`;

const selectCalendarServicesBySalon = db.prepare(CALENDAR_SERVICES_BY_SALON_SQL);
const selectCalendarServicesById = db.prepare(CALENDAR_SERVICES_BY_ID_SQL);
const selectCalendarHours = db.prepare(CALENDAR_HOURS_SQL);
const selectCalendarLead = db.prepare(CALENDAR_LEAD_SQL);
const selectCalendarTimeOff = db.prepare(CALENDAR_TIME_OFF_SQL);
const selectCalendarShifts = db.prepare(CALENDAR_SHIFTS_SQL);
const selectCalendarBookings = db.prepare(CALENDAR_BOOKINGS_SQL);

const NOTHING = [];

/** The dates from `from` to `to`, both ends included. */
function datesBetween(from, to) {
  const dates = [];
  for (let date = from; date <= to; date = addDaysISO(date, 1)) {
    dates.push(date);
  }
  return dates;
}

/** map.get(key).push(value), creating the list on first use. */
function fileUnder(map, key, value) {
  const found = map.get(key);
  if (found) {
    found.push(value);
  } else {
    map.set(key, [value]);
  }
}

/**
 * Every calendar a run of dates touches, in six queries however many salons it covers.
 *
 * Name the services either way round — `salonIds` for everything those salons sell,
 * `serviceIds` for a named few — and the dates as an inclusive `dateFrom`..`dateTo`.
 * `exceptBookingId` is the appointment being moved, taken out of the busy ranges exactly
 * as busyRanges takes it out of a single day.
 *
 * What comes back is a photograph of the calendars at the moment they were read, so it
 * belongs to the request that asked for it and is never held across two.
 */
export async function loadDayCalendar({
  salonIds = null, serviceIds = null, dateFrom, dateTo, exceptBookingId = null,
}) {
  const dates = datesBetween(dateFrom, dateTo);
  const weekdays = [...new Set(dates.map((date) => weekdayOf(date)))];
  const calendar = {
    dates,
    services: new Map(),
    salonServiceIds: new Map(),
    leadMin: new Map(),
    hours: new Map(),
    offSalonDays: new Set(),
    offStaffDays: new Set(),
    shifts: new Map(),
    busy: new Map(),
  };

  // = ANY('{}') can match nothing, and an empty array is one Postgres cannot infer a type
  // for. Two reasons to answer an empty question here rather than ask it.
  const named = serviceIds ?? salonIds ?? NOTHING;
  if (dates.length === 0 || named.length === 0) {
    return calendar;
  }

  const serviceRows = serviceIds
    ? await selectCalendarServicesById.all(serviceIds)
    : await selectCalendarServicesBySalon.all(salonIds);
  if (serviceRows.length === 0) {
    return calendar;
  }
  for (const service of serviceRows) {
    calendar.services.set(service.id, service);
    fileUnder(calendar.salonServiceIds, service.salon_id, service.id);
  }
  const salons = [...calendar.salonServiceIds.keys()];
  const ids = serviceRows.map((service) => service.id);

  for (const row of await selectCalendarLead.all(salons)) {
    calendar.leadMin.set(row.id, row.lead_time_min ?? 0);
  }
  for (const row of await selectCalendarHours.all(salons, weekdays)) {
    calendar.hours.set(`${row.salon_id}:${row.weekday}`, row);
  }
  for (const row of await selectCalendarTimeOff.all(salons, dateTo, dateFrom)) {
    for (const date of dates) {
      if (date < row.date_from || date > row.date_to) {
        continue;
      }
      if (row.staff_id === null) {
        calendar.offSalonDays.add(`${row.salon_id}:${date}`);
      } else {
        calendar.offStaffDays.add(`${row.staff_id}:${date}`);
      }
    }
  }

  const shiftRows = await selectCalendarShifts.all(ids, weekdays);
  for (const row of shiftRows) {
    fileUnder(calendar.shifts, `${row.service_id}:${row.weekday}`, row);
  }

  // Nobody rostered is nobody to read a day for, and the sixth query is skipped rather
  // than asked with an empty list.
  const staffIds = [...new Set(shiftRows.map((row) => row.id))];
  if (staffIds.length > 0) {
    const booked = new Map();
    for (const booking of await selectCalendarBookings.all(
      staffIds, dateFrom, dateTo, exceptBookingId,
    )) {
      fileUnder(booked, `${booking.staff_id}:${booking.date}`, booking);
    }
    for (const [key, rows] of booked) {
      calendar.busy.set(key, toRanges(rows));
    }
  }

  return calendar;
}

/**
 * Ordered slots for one service on one date, out of an already-loaded calendar.
 *
 * The same five steps getServiceSlots takes — the salon's day off, that weekday's opening
 * hours, the duration, the lead-time floor, then every rostered shift clamped and unioned —
 * with each read replaced by a lookup. A service the calendar was not loaded for has no
 * slots, which is the honest answer to a question this object was never asked to hold.
 */
export function calendarServiceSlots(calendar, serviceId, date) {
  const service = calendar.services.get(serviceId);
  if (!service) {
    return [];
  }
  if (calendar.offSalonDays.has(`${service.salon_id}:${date}`)) {
    return [];
  }
  const weekday = weekdayOf(date);
  const hours = calendar.hours.get(`${service.salon_id}:${weekday}`);
  const duration = service.duration_min || FALLBACK_DURATION_MIN;
  const floor = leadFloor(date, calendar.leadMin.get(service.salon_id) ?? 0);

  const shifts = [];
  for (const shift of calendar.shifts.get(`${serviceId}:${weekday}`) ?? NOTHING) {
    const open = calendar.offStaffDays.has(`${shift.id}:${date}`)
      ? null
      : clampToHours(shift, hours);
    if (!open) {
      continue;
    }
    shifts.push({ ...open, ranges: calendar.busy.get(`${shift.id}:${date}`) ?? NOTHING });
  }

  return unionSlots(shifts, duration, floor);
}

/** Whether any service of this salon has a free slot on `date` inside `[from, to]`. */
export function calendarSalonHasSlots(calendar, salonId, date, from, to) {
  for (const serviceId of calendar.salonServiceIds.get(salonId) ?? NOTHING) {
    for (const slot of calendarServiceSlots(calendar, serviceId, date)) {
      const minute = toMinutes(slot.time);
      if (slot.available && minute >= from && minute <= to) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Which of these salons still have a free slot on `date` inside the window.
 *
 * Asked about every salon a search matched at once, because the answer for fifty of them
 * is the same six queries as the answer for one. An absent bound is the whole day at that
 * end, the way an unset time filter reads.
 */
export async function salonsWithSlotsInRange(salonIds, date, timeFrom, timeTo) {
  const from = toMinutes(timeFrom) ?? DAY_START_MIN;
  const to = toMinutes(timeTo) ?? DAY_END_MIN;
  const calendar = await loadDayCalendar({ salonIds, dateFrom: date, dateTo: date });
  const found = new Set();
  for (const salonId of calendar.salonServiceIds.keys()) {
    if (calendarSalonHasSlots(calendar, salonId, date, from, to)) {
      found.add(salonId);
    }
  }
  return found;
}
