/*
 * Date and clock helpers. Everything here works on server LOCAL time and on plain
 * 'YYYY-MM-DD' / 'HH:MM' strings, which is what the schema stores.
 */

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

export function todayISO() {
  return toISO(new Date());
}

export function nowMinutes() {
  const now = new Date();
  return now.getHours() * MINUTES_PER_HOUR + now.getMinutes();
}

/** Shift an ISO date by n days. Built from local parts so DST can never shift the day. */
export function addDaysISO(iso, n) {
  const [year, month, day] = String(iso).split('-').map(Number);
  return toISO(new Date(year, month - 1, day + n));
}

/** 0 = Sunday .. 6 = Saturday, matching staff_schedule.weekday. */
export function weekdayOf(iso) {
  const [year, month, day] = String(iso).split('-').map(Number);
  return new Date(year, month - 1, day).getDay();
}
