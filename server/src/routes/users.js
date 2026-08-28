// Authenticated profile updates.
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import express from 'express';
import { db } from '../db.js';
import { isDistrictInCity } from '../lib/locations.js';
import {
  isValidPhone,
  linkBookingsByPhone,
  normalisePhone,
  phoneHeldByAnother,
} from '../lib/phone.js';
import { fromMinutes, nowMinutes, todayISO } from '../lib/time.js';
import { isSafeMediaUrl } from '../lib/urls.js';
import {
  COOKIE_NAME,
  COOKIE_OPTIONS,
  httpError,
  requireAuth,
  selectPublicUser,
} from '../middleware/auth.js';

const router = express.Router();

// Columns a customer may change about themselves. Email, role and password_hash are
// deliberately absent: changing those is not a profile edit.
const EDITABLE_COLUMNS = ['name', 'phone', 'avatar', 'city', 'district'];

router.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const assignments = [];
    const values = [];

    // The SET list is assembled from the whitelist above, so only the values ever come
    // from the request; a key the client invented can never reach the SQL.
    for (const column of EDITABLE_COLUMNS) {
      if (!(column in body)) {
        continue;
      }
      if (typeof body[column] !== 'string') {
        throw httpError(400, 'VALIDATION_ERROR', 'Thông tin cá nhân phải là chuỗi ký tự.');
      }
      if (column === 'avatar' && !isSafeMediaUrl(body[column])) {
        throw httpError(400, 'VALIDATION_ERROR', 'Đường dẫn ảnh đại diện không hợp lệ.');
      }
      // Same rule the sign-up form applies, applied here too: this field decides which
      // bookings the account claims, so it may not be swept through arbitrary strings.
      if (column === 'phone' && body[column] && !isValidPhone(body[column])) {
        throw httpError(400, 'VALIDATION_ERROR', 'Số điện thoại không hợp lệ.');
      }
      assignments.push(`${column} = ?`);
      // Stored in the shape every lookup compares against, so '+84 903 555 111' and
      // '0903555111' are one number rather than two that never match each other.
      values.push(column === 'phone' ? normalisePhone(body[column]) || null : body[column]);
    }

    // Its own branch because it is the one editable field that is not text: a permission is
    // on or off, and anything that is not an explicit true reads as off.
    if ('marketing_opt_in' in body) {
      if (typeof body.marketing_opt_in !== 'boolean') {
        throw httpError(400, 'VALIDATION_ERROR', 'Tuỳ chọn nhận ưu đãi phải là true hoặc false.');
      }
      assignments.push('marketing_opt_in = ?');
      values.push(body.marketing_opt_in ? 1 : 0);
    }

    // Validate the resulting pair (an unchanged field falls back to what is stored) so a
    // direct PATCH cannot save a district that does not belong to the city.
    const city = 'city' in body ? body.city : req.user.city;
    const district = 'district' in body ? body.district : req.user.district;
    if (city && district && !isDistrictInCity(city, district)) {
      throw httpError(400, 'VALIDATION_ERROR', 'Quận/Huyện không thuộc Tỉnh/Thành phố đã chọn.');
    }

    if (assignments.length === 0) {
      throw httpError(400, 'VALIDATION_ERROR', 'Không có thông tin nào để cập nhật.');
    }

    // One transaction: the number is claimed by the same write that stores it, so a
    // profile can never end up holding a phone whose bookings were left behind.
    await db.withTransaction(async (tx) => {
      // Refused before the write, not after it: storing a number a live account already
      // answers to would leave two rows folding to one number — the console could no
      // longer tell whose walk-in is whose, and the rightful holder would be refused
      // every later claim of their own.
      const claimedPhone = 'phone' in body && body.phone ? body.phone : null;
      if (claimedPhone && (await phoneHeldByAnother(tx, req.user.id, claimedPhone))) {
        throw httpError(
          409,
          'PHONE_IN_USE',
          'Số điện thoại này đang gắn với một tài khoản khác.',
        );
      }
      await tx.run(
        `UPDATE users SET ${assignments.join(', ')} WHERE id = ?`,
        ...values,
        req.user.id,
      );
      // Customers only, as at sign-up: counter bookings belong in a customer's history,
      // and a salon owner typing their own number would otherwise claim their own walk-ins.
      if (claimedPhone && req.user.role === 'customer') {
        await linkBookingsByPhone(tx, req.user.id, claimedPhone);
      }
    });

    res.json({ success: true, data: { user: await selectPublicUser.get(req.user.id) } });
  } catch (error) {
    next(error);
  }
});

const selectPasswordHash = db.prepare('SELECT password_hash FROM users WHERE id = ?');
// Anything still to come that the salon is holding a chair for. Read in Vietnam time,
// like every other "is this in the past" question in this codebase.
const selectLiveBooking = db.prepare(`
  SELECT 1 FROM bookings
  WHERE user_id = ? AND status IN ('pending','confirmed')
    AND (date > ? OR (date = ? AND time >= ?))
  LIMIT 1
`);
// What is left of an account after its holder erases it: a row with an author's shape and
// nobody's details. The bookings and reviews stay — a salon's history of its own chair and
// the ratings other customers read are not this person's alone to withdraw — so the row
// cannot simply be deleted. email keeps the UNIQUE constraint satisfied and cannot collide
// (an id is unique and @oak.invalid can never be a real mailbox); password_changed_at is
// bumped so every session minted before now, this caller's included, stops validating —
// to the second *after* now, because middleware/auth.js compares whole seconds with a
// strict `<` and the caller's own token was minted inside this very second.
const ANONYMISE_BOOKING_CONTACT = `
  UPDATE bookings SET customer_name = 'Người dùng đã xóa', customer_phone = NULL
  WHERE user_id = ?
`;
// And the roster rows the account stood behind. The row itself stays — it is the salon's
// record of who worked the chair, and its bookings and reviews hang off it — but nobody
// stands behind it any more, so the console shows it unclaimed and the owner can hand out
// a fresh claim link. Leaving user_id set would point the roster, and every recovery mail
// the owner triggers from it, at an address that can never be read again.
// idx_staff_user_salon is partial (WHERE user_id IS NOT NULL AND active = 1), so clearing
// the column simply takes the row out of the index.
//
// And the personal half of the row goes with the person. bio, portfolio and image are what
// routes/staff-me.js lets a technician write about themselves, and handing the row back with
// those still on it is not handing back a chair — it is leaving somebody's page up with
// nobody left who can take it down. Worse than left up: PUT BACK up. The public gates read
// (user_id IS NULL OR COALESCE(profile_hidden, 0) = 0), so an unclaimed row is always
// visible, and a technician who had WITHDRAWN their profile before erasing the account would
// find it live again the moment they did — their own words and their own face, on a page no
// account of theirs exists to reach any more. profile_hidden is reset for the same reason
// rather than kept: it is a switch only a claim can reach, so leaving it thrown would be a
// withdrawal she can no longer undo, sitting on the salon's row and waiting to darken the
// page of whoever claims the chair next without their ever having thrown it.
//
// What is NOT cleared, and deliberately: the row goes on saying what the SALON says about
// that chair. The name the owner typed into the roster, the title, the rating its customers
// wrote — none of that was hers to withdraw, so the chair comes back published under the
// same name, with the same reviews behind it, waiting for whoever sits in it next. This
// statement takes back what the person wrote about herself, not what the salon wrote about
// the job. The chair is handed back; it is not made anonymous.
//
// image is cleared knowing what it costs. Post-claim the photo in that column may be one the
// salon supplied rather than one the technician uploaded — the two are indistinguishable once
// stored — so an owner can lose a headshot that was theirs and have to put it back. That is
// the accepted price: a face is the most identifying thing on the row, and re-uploading a
// photo you own is a far smaller harm than leaving a departed person's face on a public page.
const RELEASE_STAFF_ROWS = `
  UPDATE staff
  SET user_id = NULL, claimed_at = NULL,
      bio = NULL, portfolio = NULL, image = NULL, profile_hidden = 0
  WHERE user_id = ?
`;
const ANONYMISE_USER = `
  UPDATE users
  SET name = 'Người dùng đã xóa',
      email = ?,
      phone = NULL,
      avatar = NULL,
      marketing_opt_in = 0,
      password_hash = ?,
      password_changed_at = ?,
      deleted_at = ?
  WHERE id = ?
`;

router.delete('/me', requireAuth, async (req, res, next) => {
  try {
    // A partner account is the operator of a salon: erasing it would leave that salon
    // verified, listed and bookable with an owner nobody can ever sign in as. Closing one
    // is a conversation about the salon first, so it is not self-service. cai-dat.html
    // hides the block from a partner, but the header offers that page to every signed-in
    // account regardless of role, so this guard is the only thing that actually holds.
    if (req.user.role === 'partner') {
      throw httpError(
        409,
        'PARTNER_ACCOUNT',
        'Tài khoản đối tác không thể tự xóa. Vui lòng liên hệ hello@oakbeauty.vn để đóng salon.',
      );
    }

    const { password } = req.body ?? {};
    if (typeof password !== 'string' || !password) {
      throw httpError(400, 'VALIDATION_ERROR', 'Vui lòng nhập mật khẩu để xác nhận.');
    }

    const credentials = await selectPasswordHash.get(req.user.id);
    if (!(await bcrypt.compare(password, credentials.password_hash))) {
      throw httpError(401, 'INVALID_CREDENTIALS', 'Mật khẩu không đúng.');
    }

    // A salon holding a chair for tomorrow has to be told, and this is not the way to tell
    // it: cancel first, then the account can go.
    const today = todayISO();
    if (await selectLiveBooking.get(req.user.id, today, today, fromMinutes(nowMinutes()))) {
      throw httpError(
        409,
        'BOOKING_PENDING',
        'Bạn còn lịch hẹn sắp tới. Vui lòng hủy lịch trước khi xóa tài khoản.',
      );
    }

    // Nobody can sign in as this account again: the address it answered to is gone and the
    // stored hash is of a secret that was never anybody's.
    const deadPasswordHash = await bcrypt.hash(randomBytes(32).toString('hex'), 10);
    await db.withTransaction(async (tx) => {
      await tx.run('DELETE FROM favorites WHERE user_id = ?', req.user.id);
      await tx.run('DELETE FROM notifications WHERE user_id = ?', req.user.id);
      await tx.run('DELETE FROM password_resets WHERE user_id = ?', req.user.id);
      // The bookings stay — they are the salon's record of its own chair — but the
      // contact details copied onto them at booking time are this person's, and the
      // console falls back to them whenever the joined account column is null. Erasing
      // the profile without erasing these would leave the number on every card.
      await tx.run(ANONYMISE_BOOKING_CONTACT, req.user.id);
      await tx.run(RELEASE_STAFF_ROWS, req.user.id);
      await tx.run(
        ANONYMISE_USER,
        `deleted+${req.user.id}@oak.invalid`,
        deadPasswordHash,
        Math.floor(Date.now() / 1000) + 1,
        new Date().toISOString(),
        req.user.id,
      );
    });

    // Derived from COOKIE_OPTIONS so the two can never drift apart.
    const { maxAge, ...clearOptions } = COOKIE_OPTIONS;
    res.clearCookie(COOKIE_NAME, clearOptions);
    res.json({ success: true, data: { ok: true } });
  } catch (error) {
    next(error);
  }
});

export default router;
