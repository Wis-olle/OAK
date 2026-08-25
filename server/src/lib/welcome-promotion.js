/*
 * The one offer OAK runs: a salon that joins is handed its own 20% code, good for its
 * first 30 days. Three places write it — the seed (the demo cohort), registration (every
 * salon created from now on) and the db.js backfill (salons that predate the policy) — so
 * the numbers, the wording and the code itself live here once rather than three times.
 */
import { addDaysISO } from './time.js';

export const WELCOME_PERCENT = 20;
export const WELCOME_DAYS = 30;
export const WELCOME_TITLE = 'Chào mừng salon mới - Giảm 20%';
export const WELCOME_DESCRIPTION = `Giảm ${WELCOME_PERCENT}% cho mọi dịch vụ tại salon, trong ${WELCOME_DAYS} ngày đầu salon tham gia OAK.`;
// promotions.code is UNIQUE across the whole table, so a per-salon code needs something
// per-salon in it: the salon's own id, which is also what makes the code derivable rather
// than stored — every path that has to ask "does this salon already have its offer?"
// asks it by rebuilding the code, not by guessing at a title.
export const WELCOME_CODE_PREFIX = 'MOI20-';
// The offer cards bind :src straight into an <img>, so the column cannot be left NULL.
// One shared picture: uu-dai.html already preloads this file for its own header, so the
// listing pays nothing for it.
export const WELCOME_IMAGE = 'assets/images/img-064bab706d.jpg';

// What the bell says about the offer. Here rather than inline in the seed because the
// db.js sweep has to rewrite the notice the old platform-wide code left behind, and the
// two sentences drifting apart would leave a fresh database and a live one saying
// different things about the same policy.
export const WELCOME_NOTICE_TITLE = 'Ưu đãi 20% từ các salon mới';
export const WELCOME_NOTICE_BODY =
  'Các salon vừa gia nhập OAK đang giảm 20% cho mọi dịch vụ trong 30 ngày đầu. Xem mã của từng salon tại trang Ưu đãi.';

/* The day the policy went live. The db.js backfill only reaches salons older than this:
   everything created from here on gets its offer inside the registration transaction, so
   a salon can never exist without one, and a salon that deleted its offer on purpose
   stays deleted instead of having it handed back on the next deploy. Compared against
   salons.created_at, which both seed.js and registration write as a full ISO timestamp
   ('2026-08-25T10:00:00.000Z'): text comparison against a bare date is then exactly
   "created before this day", since every timestamp on the day itself sorts after it. */
export const WELCOME_BACKFILL_CUTOFF = '2026-08-26';

/** The code for one salon. Deterministic: the same salon always yields the same code. */
export function welcomeCode(salonId) {
  return `${WELCOME_CODE_PREFIX}${salonId}`;
}

/** The window the offer runs for, from the day it is handed out. */
export function welcomeWindow(startISO) {
  return { starts_at: startISO, ends_at: addDaysISO(startISO, WELCOME_DAYS) };
}
