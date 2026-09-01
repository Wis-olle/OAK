/*
 * Date and clock helpers. "Now" is always read in Vietnam time — Render runs the
 * container in UTC — and everything else works on plain 'YYYY-MM-DD' / 'HH:MM'
 * strings, which is what the schema stores.
 */

const APP_TZ = 'Asia/Ho_Chi_Minh';
// The same zone written as the fixed offset it is: Vietnam has kept no daylight saving
// since 1975, so a wall-clock day there can be turned into an instant with plain text.
const APP_UTC_OFFSET = '+07:00';
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const MINUTES_PER_HOUR = 60;

/** 'YYYY-MM-DD' and a date that actually exists (rejects 2026-02-30). */
export function isISODate(value) {
  if (typeof value !== 'string' || !ISO_PATTERN.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
  );
}

export function isHHMM(value) {
  return typeof value === 'string' && HHMM_PATTERN.test(value);
}

/** 'HH:MM' -> minutes since midnight, or null when the input is malformed. */
export function toMinutes(value) {
  if (!isHHMM(value)) {
    return null;
  }
  const [hours, minutes] = value.split(':').map(Number);
  return hours * MINUTES_PER_HOUR + minutes;
}

/** Minutes since midnight -> zero-padded 'HH:MM'. */
export function fromMinutes(value) {
  const hours = Math.floor(value / MINUTES_PER_HOUR);
  const minutes = value % MINUTES_PER_HOUR;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function toISO(date) {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/*
 * Today and now in APP_TZ, whatever the process TZ is: 'en-CA' renders the date as
 * 'YYYY-MM-DD' and hour12:false keeps the hour 00-23, so the parts are read straight.
 */
const VN_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TZ,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function vnParts() {
  return Object.fromEntries(
    VN_FORMAT.formatToParts(new Date()).map((part) => [part.type, part.value]),
  );
}

/**
 * Today and the minute of it, in Vietnam time, from ONE reading of the clock.
 *
 * todayISO() and nowMinutes() each look at the clock themselves, so a caller that wants both
 * can be handed 23:59 of one day and the date of the next — a sweep would then ask for a
 * window that never existed. Anything comparing a date against a time of day should read the
 * pair here instead of the two separately.
 */
export function vnNow() {
  const { year, month, day, hour, minute } = vnParts();
  return {
    today: `${year}-${month}-${day}`,
    now: Number(hour) * MINUTES_PER_HOUR + Number(minute),
  };
}

export function todayISO() {
  const { year, month, day } = vnParts();
  return `${year}-${month}-${day}`;
}

/**
 * The instant a Vietnamese calendar day begins, written the way a UTC timestamp column is
 * written: '2026-09-02' -> '2026-09-01T17:00:00.000Z'.
 *
 * A row stamped with new Date().toISOString() cannot be dated by its own text — one written
 * at 01:00 in Vietnam carries the previous day in UTC — so a query counting "everything from
 * today" has to compare against this boundary rather than match a date prefix, which would
 * silently see nothing at all between midnight and 07:00.
 */
export function startOfDayUTC(iso) {
  return new Date(`${iso}T00:00:00${APP_UTC_OFFSET}`).toISOString();
}

export function nowMinutes() {
  const { hour, minute } = vnParts();
  return Number(hour) * MINUTES_PER_HOUR + Number(minute);
}

/** Shift an ISO date by n days. Built from local parts so DST can never shift the day. */
export function addDaysISO(iso, n) {
  const [year, month, day] = String(iso).split('-').map(Number);
  return toISO(new Date(year, month - 1, day + n));
}

/** 'YYYY-MM-DD' -> 'DD/MM/YYYY', the way a Vietnamese notification body reads a date. */
export function formatDateVN(iso) {
  const [year, month, day] = String(iso).split('-');
  return `${day}/${month}/${year}`;
}

/** 0 = Sunday .. 6 = Saturday, matching staff_schedule.weekday. */
export function weekdayOf(iso) {
  const [year, month, day] = String(iso).split('-').map(Number);
  return new Date(year, month - 1, day).getDay();
}
