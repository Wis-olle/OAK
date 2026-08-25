import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../db.js';
import { sendResetMail } from '../lib/mailer.js';
import { notifyUser } from '../lib/notify.js';
// One rule for phone numbers, shared with the profile update and the console lookup:
// every path that attaches a number to an account folds it the same way.
import {
  isValidPhone,
  linkBookingsByPhone,
  normalisePhone,
  phoneHeldByAnother,
} from '../lib/phone.js';
import { slugify } from '../lib/text.js';
import { todayISO } from '../lib/time.js';
// The one offer OAK runs, spelled once for the seed, this route and the db.js backfill.
// Imported under a name of its own: createAccount already has a `welcomeCode` of its
// own — the code a new CUSTOMER is greeted with — and the two are different things.
import {
  WELCOME_DESCRIPTION,
  WELCOME_IMAGE,
  WELCOME_PERCENT,
  WELCOME_TITLE,
  welcomeCode as salonWelcomeCode,
  welcomeWindow,
} from '../lib/welcome-promotion.js';
import {
  COOKIE_NAME,
  COOKIE_OPTIONS,
  JWT_SECRET,
  httpError,
  issueCookie,
  requireAuth,
  selectPublicUser,
  sessionOutlivedPassword,
} from '../middleware/auth.js';

const router = express.Router();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
const ROLES = ['customer', 'partner'];
// Short on purpose: the link is the whole secret, so the window in which a leaked one is
// worth anything stays small.
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

/* Demo-grade throttle, shared by /forgot-password and /login. /forgot-password needs one
   because retiring the previous link before minting a new one means anyone able to spam it
   can keep killing the newest link a victim was sent, locking them out of their own reset;
   /login needs one because guessing a password is otherwise free. Fixed window, keyed on
   the address AND the caller, so one noisy client cannot deny every address and one address
   cannot be attacked from a single client.

   This is a mitigation, not a rate limiter: it lives in one process's memory, resets on
   deploy, and a botnet with many source addresses walks past it. Production wants a real
   limiter at the infrastructure layer or a shared store. */
const RATE_WINDOW_MS = 15 * 60 * 1000;
const FORGOT_MAX_ATTEMPTS = 3;
const forgotAttempts = new Map();
// Ten in a quarter of an hour: far above a person mistyping their own password, far below
// what guessing needs. Its own tally, so asking for a reset link never spends a sign-in.
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map();

/** Record one attempt for `key` in `attempts`; true once `max` in the window is spent. */
function rateLimited(attempts, key, max) {
  const now = Date.now();
  // Swept here rather than on a timer: the Map is only ever walked on a call, so an idle
  // process holds nothing and there is no interval keeping it awake. Whatever survives the
  // sweep is in-window by definition.
  for (const [seen, entry] of attempts) {
    if (now - entry.windowStart >= RATE_WINDOW_MS) {
      attempts.delete(seen);
    }
  }

  const entry = attempts.get(key);
  if (!entry) {
    attempts.set(key, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > max;
}

// Comparing against this on the miss path keeps a failed login as slow as a
// successful one, so response time cannot be used to enumerate accounts.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('oak-timing-guard', 10);

const selectCredentials = db.prepare('SELECT id, password_hash FROM users WHERE email = ?');
const selectPasswordHash = db.prepare('SELECT password_hash FROM users WHERE id = ?');
const selectUserIdByEmail = db.prepare('SELECT id FROM users WHERE email = ?');
// RETURNING spelled out: db.prepare appends ` RETURNING id` to any INSERT that lacks one,
// and this is the only table whose primary key is not called id.
const insertPasswordReset = db.prepare(
  'INSERT INTO password_resets (token, user_id, expires_at) VALUES (?, ?, ?) RETURNING token',
);
const selectPasswordReset = db.prepare(
  'SELECT user_id, expires_at, used FROM password_resets WHERE token = ?',
);
// Conditional on used = 0 so redeeming a token is the same statement that spends it.
const SPEND_PASSWORD_RESET = 'UPDATE password_resets SET used = 1 WHERE token = ? AND used = 0';
// One live link per account: asking for a new one, redeeming one, or changing the password
// from a session all retire whatever was still outstanding. A link the account holder has
// stopped waiting for is a link an attacker holding the mailbox can still spend.
const RETIRE_USER_RESETS = 'UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0';
const retireUserResets = db.prepare(RETIRE_USER_RESETS);
// password_changed_at is written by the same statement that writes the hash, so a changed
// password can never leave the session cut-off behind. Epoch seconds, to match a JWT's iat.
const UPDATE_PASSWORD =
  'UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?';
const SELECT_SALON_BY_SLUG = 'SELECT 1 FROM salons WHERE slug = ?';
const INSERT_USER =
  'INSERT INTO users (name, email, phone, password_hash, role, avatar, created_at, consent_at, marketing_opt_in) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)';
// verified = 1: there is no manual approval step to wait for. The salon is still unlisted
// at this point — salons.published defaults to 0 — because all it holds is a name; its owner
// turns it on from the console once the profile has an address, hours, a service and a photo.
const INSERT_SALON =
  'INSERT INTO salons (owner_id, name, slug, city, verified, created_at) VALUES (?, ?, ?, ?, 1, ?)';
// The welcome offer the salon joins with, written in the same transaction as the salon:
// there is no state in which a salon exists without it. service_ids stays NULL — the
// offer is on everything the salon does, and requireUsablePromotion reads the salon
// scope, not a service list.
const INSERT_WELCOME_PROMOTION = `
  INSERT INTO promotions
    (salon_id, code, type, title, description, discount_percent, image, starts_at, ends_at, active)
  VALUES (?, ?, 'discount', ?, ?, ?, ?, ?, ?, 1)
`;
// The welcome offer a brand-new customer is greeted with: whichever platform-wide code is
// closest to running out, so the one being wound down is the one that gets handed out.
// A salon's own code is not offered — it would send a first-time visitor to one salon.
// The same window bookings.js requireUsablePromotion checks at checkout, so a code named
// here is never one that would be refused there: a promotion that has not started yet is
// not offered, an open-ended one (no ends_at) is, and a combo is not — requireUsablePromotion
// refuses type 'combo' at checkout, so offering one would be a code that cannot be spent.
const SELECT_WELCOME_PROMOTION = `
  SELECT code, discount_percent FROM promotions
  WHERE salon_id IS NULL AND active = 1
    AND type <> 'combo'
    AND (starts_at IS NULL OR starts_at <= ?)
    AND (ends_at IS NULL OR ends_at >= ?)
    AND discount_percent IS NOT NULL
  ORDER BY ends_at LIMIT 1
`;

/** Append -2, -3, ... until the slug is free. Runs inside the register transaction. */
async function uniqueSalonSlug(tx, name) {
  const base = slugify(name) || 'salon';
  let slug = base;
  let suffix = 1;
  while (await tx.get(SELECT_SALON_BY_SLUG, slug)) {
    suffix += 1;
    slug = `${base}-${suffix}`;
  }
  return slug;
}

/** Now, in the unit JWT stamps `iat` with, which is what users.password_changed_at holds. */
function epochSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Create an account and, for partners, the salon that comes with it.
 *
 * Shared by POST /register and POST /partner/register: the partner alias is the same flow
 * with the role fixed, so forcedRole overrides whatever the body claims.
 */
async function createAccount(req, res, next, forcedRole) {
  try {
    const {
      name,
      email,
      phone,
      password,
      role,
      salon_name: salonName,
      consent,
      marketing_opt_in: marketingOptIn,
    } = req.body ?? {};

    if (!name || !email || !password) {
      throw httpError(400, 'VALIDATION_ERROR', 'Vui lòng nhập họ tên, email và mật khẩu.');
    }
    if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
      throw httpError(400, 'VALIDATION_ERROR', 'Họ tên, email và mật khẩu phải là chuỗi ký tự.');
    }
    if (phone != null && typeof phone !== 'string') {
      throw httpError(400, 'VALIDATION_ERROR', 'Số điện thoại phải là chuỗi ký tự.');
    }
    // Same rule the form applies: the number decides which counter bookings this account
    // claims, so a string that is not a number never gets to try.
    if (phone && !isValidPhone(phone)) {
      throw httpError(400, 'VALIDATION_ERROR', 'Số điện thoại không hợp lệ.');
    }
    if (salonName != null && typeof salonName !== 'string') {
      throw httpError(400, 'VALIDATION_ERROR', 'Tên salon phải là chuỗi ký tự.');
    }
    if (!EMAIL_PATTERN.test(email)) {
      throw httpError(400, 'VALIDATION_ERROR', 'Địa chỉ email không hợp lệ.');
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw httpError(400, 'VALIDATION_ERROR', 'Mật khẩu phải có ít nhất 8 ký tự.');
    }
    // An affirmative act, checked here and not only in the form: consent that a caller can
    // leave out is not consent at all. Marketing is asked separately and defaults to off,
    // so silence on it is a no.
    if (consent !== true) {
      throw httpError(
        400,
        'CONSENT_REQUIRED',
        'Vui lòng đồng ý với Điều khoản sử dụng và Chính sách bảo mật để tiếp tục.',
      );
    }

    const accountRole = forcedRole ?? role ?? 'customer';
    if (!ROLES.includes(accountRole)) {
      throw httpError(400, 'VALIDATION_ERROR', 'Loại tài khoản không hợp lệ.');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const createdAt = new Date().toISOString();

    let userId;
    // Reported back so dang-ky.html only promises a code when one was actually written.
    let welcomeCode = null;
    try {
      await db.withTransaction(async (tx) => {
        // A number a live account already answers to is refused here rather than stored
        // beside it: two rows folding to one number leave the console unable to tell
        // whose walk-in is whose, and lock the rightful holder out of their own claims.
        if (phone && (await phoneHeldByAnother(tx, null, phone))) {
          throw httpError(
            409,
            'PHONE_IN_USE',
            'Số điện thoại này đang gắn với một tài khoản khác.',
          );
        }
        userId = Number(
          (
            await tx.run(
              INSERT_USER,
              name,
              email.trim().toLowerCase(),
              // Stored folded, so the number is comparable to the one a console lookup or
              // a later profile edit brings in rather than only to itself.
              phone ? normalisePhone(phone) : null,
              passwordHash,
              accountRole,
              createdAt,
              createdAt,
              marketingOptIn === true ? 1 : 0,
            )
          ).lastInsertRowid,
        );

        // Whatever was booked over the counter under this number is this person's history,
        // so it is theirs from the first sign-in rather than from their next visit. Customers
        // only: a salon owner's number is a business line, not a claim on those bookings.
        if (phone && accountRole === 'customer') {
          await linkBookingsByPhone(tx, userId, phone);
        }

        if (accountRole === 'customer') {
          // Something in the bell on the first visit: an account whose Thông báo reads
          // "chưa có thông báo nào" has nothing to come back for. dang-ky.html says so with
          // a toast on arrival, so the two are one message.
          // Not gated on marketing_opt_in: this is the one transactional hello that comes
          // with signing up, not a campaign. That box governs the promotions sent later.
          const today = todayISO();
          const promotion = await tx.get(SELECT_WELCOME_PROMOTION, today, today);
          welcomeCode = promotion ? promotion.code : null;
          await notifyUser(
            tx,
            userId,
            'Chào mừng bạn đến với OAK',
            promotion
              ? `Chào mừng ${name}! Nhập mã ${promotion.code} khi đặt lịch để giảm ${promotion.discount_percent}% cho buổi hẹn đầu tiên.`
              : `Chào mừng ${name} — đặt lịch đầu tiên của bạn tại OAK.`,
            promotion ? 'promotion' : 'general',
          );
        }

        if (accountRole === 'partner') {
          const partnerSalonName = salonName || `${name} Salon`;
          const salonId = Number(
            (
              await tx.run(
                INSERT_SALON,
                userId,
                partnerSalonName,
                await uniqueSalonSlug(tx, partnerSalonName),
                'TP.HCM',
                createdAt,
              )
            ).lastInsertRowid,
          );
          // Joining IS the offer: the salon's own 20% code is live from the day it signs
          // up. Inside the transaction, so a code that could not be written takes the
          // salon and the account down with it rather than leaving a salon without one.
          const { starts_at: startsAt, ends_at: endsAt } = welcomeWindow(todayISO());
          await tx.run(
            INSERT_WELCOME_PROMOTION,
            salonId,
            salonWelcomeCode(salonId),
            WELCOME_TITLE,
            WELCOME_DESCRIPTION,
            WELCOME_PERCENT,
            WELCOME_IMAGE,
            startsAt,
            endsAt,
          );
        }
      });
    } catch (error) {
      // Let the UNIQUE constraint, not a pre-check, decide the duplicate case:
      // check-then-act straddling the ~90ms bcrypt hash was racy.
      if (error.code === '23505' && error.constraint === 'users_email_key') {
        throw httpError(409, 'EMAIL_TAKEN', 'Email này đã được sử dụng.');
      }
      throw error;
    }

    const user = await selectPublicUser.get(userId);
    issueCookie(res, user);
    res.json({ success: true, data: { user, welcome_code: welcomeCode } });
  } catch (error) {
    next(error);
  }
}

router.post('/register', (req, res, next) => createAccount(req, res, next, null));

// Same flow as /register, with the role fixed so a partner sign-up form cannot be
// replayed to create a customer (or the reverse).
router.post('/partner/register', (req, res, next) => createAccount(req, res, next, 'partner'));

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      throw httpError(400, 'VALIDATION_ERROR', 'Vui lòng nhập email và mật khẩu.');
    }
    if (typeof email !== 'string' || typeof password !== 'string') {
      throw httpError(401, 'INVALID_CREDENTIALS', 'Email hoặc mật khẩu không đúng.');
    }

    // Keyed on the address AND the caller, so a shared office address cannot lock out
    // every account behind it and one account cannot be walked through from one machine.
    // Checked before the hash is compared: guessing should not get the server's work for
    // free either.
    const normalised = email.trim().toLowerCase();
    const attemptKey = `${normalised}|${req.ip}`;
    if (rateLimited(loginAttempts, attemptKey, LOGIN_MAX_ATTEMPTS)) {
      console.warn(`login: too many attempts for ${req.ip}`);
      throw httpError(
        429,
        'TOO_MANY_ATTEMPTS',
        'Bạn đã thử đăng nhập quá nhiều lần. Vui lòng đợi 15 phút rồi thử lại.',
      );
    }

    const credentials = await selectCredentials.get(normalised);
    const matches = await bcrypt.compare(
      password,
      credentials?.password_hash ?? DUMMY_PASSWORD_HASH,
    );
    if (!credentials || !matches) {
      throw httpError(401, 'INVALID_CREDENTIALS', 'Email hoặc mật khẩu không đúng.');
    }

    // Whoever proved they own the account owes the window nothing: only failed guessing
    // accumulates, so signing in and out repeatedly can never lock a person out.
    loginAttempts.delete(attemptKey);

    const user = await selectPublicUser.get(credentials.id);
    issueCookie(res, user);
    res.json({ success: true, data: { user } });
  } catch (error) {
    next(error);
  }
});

/** Retire whatever the account had outstanding, then store the new link. */
async function mintReset(token, userId, expiresAt) {
  // Before the insert, never after: the new row must not retire itself.
  await retireUserResets.run(userId);
  await insertPasswordReset.run(token, userId, expiresAt);
}

router.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = req.body ?? {};
    if (typeof email !== 'string' || !email.trim()) {
      throw httpError(400, 'VALIDATION_ERROR', 'Vui lòng nhập email.');
    }

    // 200 either way, and the same message either way: answering "no such account" would
    // turn this endpoint into an account-enumeration oracle.
    const normalised = email.trim().toLowerCase();
    const account = await selectUserIdByEmail.get(normalised);
    const data = { message: 'Nếu email tồn tại, chúng tôi đã gửi liên kết đặt lại — kiểm tra hộp thư, kể cả mục Spam.' };

    // Over the allowance: the reply is the ordinary one, so the throttle does not become a
    // new oracle of its own — but nothing is retired and nothing is minted, which is the
    // whole point of having it.
    if (!account || rateLimited(forgotAttempts, `${normalised}|${req.ip}`, FORGOT_MAX_ATTEMPTS)) {
      return res.json({ success: true, data });
    }

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();

    // DEMO ONLY — a checkout with no mail channel has nowhere to send the link, so it comes
    // back in the response instead. Two things make that unacceptable anywhere real: the
    // field IS the reset secret, and its mere presence tells the caller the address is
    // registered, which is the enumeration oracle the message above avoids.
    //
    // Hence both halves of the gate. RESEND_API_KEY answers "is there a way to send this?"
    // — wherever there is one, the link is mailed and never written to a response — and the
    // NODE_ENV half keeps a production deploy that forgot the key from falling back to the
    // demo instead of failing quietly, which is the only direction worth failing in.
    if (!process.env.RESEND_API_KEY && process.env.NODE_ENV !== 'production') {
      // This branch must write before it replies, because the token it just minted is what
      // the reply carries. The timing side channel that creates only matters where the
      // field is emitted at all, i.e. never in production.
      await mintReset(token, account.id, expiresAt);
      data.demo_reset_url = `dat-lai-mat-khau.html?token=${token}`;
      return res.json({ success: true, data });
    }

    // The link leaves the browser, so it has to be absolute — and what it carries is a live
    // reset token, so the address must never come from anything the caller controls. Render
    // publishes the service's own origin as RENDER_EXTERNAL_URL; PUBLIC_BASE_URL is the same
    // declaration for a host that does not. A forged Host header would otherwise be enough to
    // have OAK mail a victim a genuine link pointing at the attacker's server, so a production
    // deploy that declared neither sends nothing at all rather than trusting the request.
    const declaredOrigin = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_BASE_URL;
    if (!declaredOrigin && process.env.NODE_ENV === 'production') {
      console.error(
        'forgot-password: no RENDER_EXTERNAL_URL or PUBLIC_BASE_URL configured, not mailing',
      );
      return res.json({ success: true, data });
    }
    const origin = (declaredOrigin || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

    // Reply first, work after: a known address would otherwise take two round trips
    // longer to answer than an unknown one, and response time would say what the message
    // deliberately does not. Nothing after this line may throw into `next` — the reply is
    // already on the wire — so the write reports failure to the log instead. The mail is
    // sent only once the token is stored, or the link would arrive dead; sendResetMail
    // logs its own failures and never rejects.
    res.json({ success: true, data });
    return mintReset(token, account.id, expiresAt)
      .then(() => sendResetMail(normalised, `${origin}/dat-lai-mat-khau.html?token=${token}`))
      .catch((error) => {
        console.error('forgot-password: could not store the reset token:', error);
      });
  } catch (error) {
    next(error);
  }
});

router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, password } = req.body ?? {};
    if (typeof token !== 'string' || !token || typeof password !== 'string') {
      throw httpError(400, 'VALIDATION_ERROR', 'Vui lòng nhập mật khẩu mới.');
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw httpError(400, 'VALIDATION_ERROR', 'Mật khẩu phải có ít nhất 8 ký tự.');
    }

    // Read first so an unusable link is refused before ~90ms of hashing is spent on it.
    const reset = await selectPasswordReset.get(token);
    if (!reset || reset.used === 1 || new Date(reset.expires_at).getTime() <= Date.now()) {
      throw httpError(
        400,
        'INVALID_RESET_TOKEN',
        'Liên kết đặt lại không hợp lệ hoặc đã hết hạn. Vui lòng yêu cầu liên kết mới.',
      );
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await db.withTransaction(async (tx) => {
      // Re-checked here, not above: the read straddles the hash, so two concurrent
      // redemptions of one link can both pass it. Whoever spends the row wins; the loser
      // changes nothing, because the password update rides in the same transaction.
      const spent = await tx.run(SPEND_PASSWORD_RESET, token);
      if (spent.changes !== 1) {
        throw httpError(
          400,
          'INVALID_RESET_TOKEN',
          'Liên kết đặt lại không hợp lệ hoặc đã hết hạn. Vui lòng yêu cầu liên kết mới.',
        );
      }
      // The spend above covers this link; this covers every other one the account still
      // had outstanding, so one completed reset closes them all.
      await tx.run(RETIRE_USER_RESETS, reset.user_id);
      // Whoever was signed in on the old password is signed out by this: the reset path is
      // exactly the case where that other session may be the attacker's.
      await tx.run(UPDATE_PASSWORD, passwordHash, epochSeconds(), reset.user_id);
    });

    // Signed in on the way out: whoever just proved they hold the mailbox and chose the
    // new password has no reason to be asked for it again on the next screen (WCAG 3.3.7).
    // Minted after the write, so its iat cannot fall before the cut-off it must survive.
    const user = await selectPublicUser.get(reset.user_id);
    issueCookie(res, user);
    res.json({ success: true, data: { user } });
  } catch (error) {
    next(error);
  }
});

// Changing a password from inside a session, which is a different act from resetting a
// forgotten one: the current password is the proof, not a mailed link.
router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const { current_password: currentPassword, new_password: newPassword } = req.body ?? {};
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      throw httpError(400, 'VALIDATION_ERROR', 'Vui lòng nhập mật khẩu hiện tại và mật khẩu mới.');
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      throw httpError(400, 'VALIDATION_ERROR', 'Mật khẩu mới phải có ít nhất 8 ký tự.');
    }

    const credentials = await selectPasswordHash.get(req.user.id);
    if (!(await bcrypt.compare(currentPassword, credentials.password_hash))) {
      throw httpError(400, 'INVALID_CREDENTIALS', 'Mật khẩu hiện tại không đúng.');
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    const changedAt = epochSeconds();
    // One transaction: a password that changed while an old reset link stayed live would
    // leave that link able to change it straight back.
    await db.withTransaction(async (tx) => {
      await tx.run(UPDATE_PASSWORD, passwordHash, changedAt, req.user.id);
      await tx.run(RETIRE_USER_RESETS, req.user.id);
    });

    // Every session minted before changedAt is now dead, this caller's included — so it is
    // handed a fresh one. Signed after the write, so its iat cannot predate the cut-off;
    // the other devices, holding older tokens, still get logged out.
    issueCookie(res, req.user);
    res.json({ success: true, data: { ok: true } });
  } catch (error) {
    next(error);
  }
});

router.post('/logout', (req, res) => {
  // Derived from COOKIE_OPTIONS so the two can never drift apart.
  const { maxAge, ...clearOptions } = COOKIE_OPTIONS;
  res.clearCookie(COOKIE_NAME, clearOptions);
  res.json({ success: true, data: { ok: true } });
});

// Optional auth: a guest is a normal outcome here, not a 401. Every page probes this on
// load, so an anonymous visitor gets 200 {user:null} and the browser console stays clean;
// the endpoints that genuinely need a session keep using requireAuth.
router.get('/me', async (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  let user = null;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
      user = (await selectPublicUser.get(payload.id)) ?? null;
      // Same cut-off requireAuth applies. Without it the header would keep showing a
      // signed-in reader whose every action already 401s.
      if (user && sessionOutlivedPassword(payload, user)) {
        user = null;
      }
    } catch {
      user = null;
    }
  }
  res.json({ success: true, data: { user } });
});

export default router;
