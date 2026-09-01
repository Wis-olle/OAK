/*
 * The one offer OAK runs: a salon may hand out its own 20% code, good for 30 days from the
 * day it asks for one. Asking is the whole of it — the discount comes out of the salon's
 * own till, so it is minted for an owner who ticked the box on the registration form or in
 * the console and for nobody else. mintWelcomePromotion below is the one place that writes
 * it; the seed writes the demo cohort's directly, and the numbers, the wording and the code
 * itself live here once rather than in each of them.
 */
import { notifyUser } from './notify.js';
import { addDaysISO, todayISO } from './time.js';

export const WELCOME_PERCENT = 20;
export const WELCOME_DAYS = 30;
export const WELCOME_TITLE = 'Chào mừng salon mới - Giảm 20%';
export const WELCOME_DESCRIPTION = `Giảm ${WELCOME_PERCENT}% cho mọi dịch vụ tại salon, trong ${WELCOME_DAYS} ngày đầu salon tham gia OAK.`;
// promotions.code is UNIQUE per salon rather than across the table, so the salon's id in
// here is not what keeps this code clear of another salon's. It is what makes the code
// derivable rather than stored — every path that has to ask "does this salon already have
// its offer?" asks it by rebuilding the code, not by guessing at a title.
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

/** The code for one salon. Deterministic: the same salon always yields the same code. */
export function welcomeCode(salonId) {
  return `${WELCOME_CODE_PREFIX}${salonId}`;
}

/** The window the offer runs for, from the day it is handed out. */
export function welcomeWindow(startISO) {
  return { starts_at: startISO, ends_at: addDaysISO(startISO, WELCOME_DAYS) };
}

// What the owner is told the moment the code exists. Deliberately says nothing about a
// first appointment: bookings.js applies the code to any booking at this salon for as long
// as the window is open, so promising less than that would misdescribe what was agreed to.
export const WELCOME_OWNER_NOTICE_TITLE = 'Mã ưu đãi chào mừng đã được tạo';

/** The sentence under that title, naming the code this salon actually got. */
export function welcomeOwnerNotice(code) {
  return `Mã ${code} đã được tạo, giảm ${WELCOME_PERCENT}% cho mọi dịch vụ tại salon của bạn trong ${WELCOME_DAYS} ngày. Chi phí ưu đãi do salon chịu — bạn có thể tắt mã bất cứ lúc nào ở mục Ưu đãi.`;
}

// The row itself. Salon-scoped, active, and a discount, which is the only shape the till
// accepts; service_ids stays out of it because the offer is on everything the salon does.
const INSERT_WELCOME_PROMOTION = `
  INSERT INTO promotions
    (salon_id, code, type, title, description, discount_percent, image, starts_at, ends_at, active)
  VALUES (?, ?, 'discount', ?, ?, ?, ?, ?, ?, 1)
`;
const SELECT_SALON_OPT_IN = 'SELECT owner_id, welcome_promo_opt_in FROM salons WHERE id = ?';
const UPDATE_WELCOME_OFF = 'UPDATE promotions SET active = 0 WHERE salon_id = ? AND code = ?';
// Switching it back on re-opens the 30 days with it: the window runs from the day the
// salon asks, and a row switched on inside a window that closed months ago is an offer
// the listing hides and the till refuses, under a box the console shows as ticked.
const UPDATE_WELCOME_ON = `
  UPDATE promotions SET active = 1, starts_at = ?, ends_at = ?
  WHERE salon_id = ? AND code = ?
`;
// Keyed on the derived code rather than on a title, so "has this salon got one?" is a
// lookup and running this twice writes once.
const SELECT_EXISTING_WELCOME = 'SELECT 1 FROM promotions WHERE salon_id = ? AND code = ?';

/**
 * Give this salon its welcome code, if it asked for one and has not got one yet, and tell
 * the owner it exists. Hands back the code it wrote, or null when it wrote nothing.
 *
 * Runs on the caller's transaction, because both call sites are already inside one: the
 * registration that creates the salon, and the console save that ticks the box later. The
 * two guards are what let either of them call it unconditionally — an owner who did not
 * ask gets nothing, and an owner who asks twice is not given a second notice.
 */
export async function mintWelcomePromotion(tx, salonId) {
  const salon = await tx.get(SELECT_SALON_OPT_IN, salonId);
  if (!salon || Number(salon.welcome_promo_opt_in) !== 1) {
    return null;
  }
  const code = welcomeCode(salonId);
  if (await tx.get(SELECT_EXISTING_WELCOME, salonId, code)) {
    return null;
  }
  const { starts_at: startsAt, ends_at: endsAt } = welcomeWindow(todayISO());
  await tx.run(
    INSERT_WELCOME_PROMOTION,
    salonId,
    code,
    WELCOME_TITLE,
    WELCOME_DESCRIPTION,
    WELCOME_PERCENT,
    WELCOME_IMAGE,
    startsAt,
    endsAt,
  );
  await notifyUser(
    tx,
    salon.owner_id,
    WELCOME_OWNER_NOTICE_TITLE,
    welcomeOwnerNotice(code),
    'promotion',
  );
  return code;
}

/**
 * Switch this salon's welcome code on or off, if it has one.
 *
 * The box in the console is the switch the Terms promise it is, so unticking it has to
 * stop the discount rather than merely stop a future one being issued, and ticking it has
 * to start one the customer can actually spend — hence the fresh window on the way back
 * on. The row is left where it is either way: a customer may be holding the code, and the
 * salon is owed the history of an offer it once ran. Keyed on the derived code, so it
 * reaches that salon's welcome offer and none of the offers the salon wrote itself.
 */
export async function setWelcomePromotionActive(tx, salonId, active) {
  const code = welcomeCode(salonId);
  if (Number(active) !== 1) {
    await tx.run(UPDATE_WELCOME_OFF, salonId, code);
    return;
  }
  const { starts_at: startsAt, ends_at: endsAt } = welcomeWindow(todayISO());
  await tx.run(UPDATE_WELCOME_ON, startsAt, endsAt, salonId, code);
}
