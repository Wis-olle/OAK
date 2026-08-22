import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../db.js';
import { slugify } from '../lib/text.js';
import {
  COOKIE_NAME,
  JWT_SECRET,
  httpError,
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

/* Demo-grade throttle for /forgot-password. It needs one because retiring the previous
   link before minting a new one means anyone able to spam this endpoint can keep killing
   the newest link a victim was sent, locking them out of their own reset. Fixed window,
   keyed on the address AND the caller, so one noisy client cannot deny every address and
   one address cannot be attacked from a single client.

   This is a mitigation, not a rate limiter: it lives in one process's memory, resets on
   deploy, and a botnet with many source addresses walks past it. Production wants a real
   limiter at the infrastructure layer or a shared store. */
const FORGOT_WINDOW_MS = 15 * 60 * 1000;
const FORGOT_MAX_ATTEMPTS = 3;
const forgotAttempts = new Map();

/** Record one attempt for `key`; true once the window's allowance is spent. */
function forgotRateLimited(key) {
  const now = Date.now();
  // Swept here rather than on a timer: the Map is only ever walked on a call, so an idle
  // process holds nothing and there is no interval keeping it awake. Whatever survives the
  // sweep is in-window by definition.
  for (const [seen, entry] of forgotAttempts) {
    if (now - entry.windowStart >= FORGOT_WINDOW_MS) {
      forgotAttempts.delete(seen);
    }
  }

  const entry = forgotAttempts.get(key);
  if (!entry) {
    forgotAttempts.set(key, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > FORGOT_MAX_ATTEMPTS;
}

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

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
  'INSERT INTO users (name, email, phone, password_hash, role, avatar, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)';
// verified = 1: on this demo a partner salon goes live the moment it signs up, so it is
// browsable straight away. There is no manual approval step to wait for.
const INSERT_SALON =
  'INSERT INTO salons (owner_id, name, slug, city, verified, created_at) VALUES (?, ?, ?, ?, 1, ?)';

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

function issueCookie(res, user) {
  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
}

/**
 * Create an account and, for partners, the salon that comes with it.
 *
 * Shared by POST /register and POST /partner/register: the partner alias is the same flow
 * with the role fixed, so forcedRole overrides whatever the body claims.
 */
async function createAccount(req, res, next, forcedRole) {
  try {
    const { name, email, phone, password, role, salon_name: salonName } = req.body ?? {};

    if (!name || !email || !password) {
      throw httpError(400, 'VALIDATION_ERROR', 'Vui lòng nhập họ tên, email và mật khẩu.');
    }
    if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
      throw httpError(400, 'VALIDATION_ERROR', 'Họ tên, email và mật khẩu phải là chuỗi ký tự.');
    }
    if (phone != null && typeof phone !== 'string') {
      throw httpError(400, 'VALIDATION_ERROR', 'Số điện thoại phải là chuỗi ký tự.');
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

    const accountRole = forcedRole ?? role ?? 'customer';
    if (!ROLES.includes(accountRole)) {
      throw httpError(400, 'VALIDATION_ERROR', 'Loại tài khoản không hợp lệ.');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const createdAt = new Date().toISOString();

    let userId;
    try {
      await db.withTransaction(async (tx) => {
        userId = Number(
          (
            await tx.run(
              INSERT_USER,
              name,
              email.trim().toLowerCase(),
              phone ?? null,
              passwordHash,
              accountRole,
              createdAt,
            )
          ).lastInsertRowid,
        );

        if (accountRole === 'partner') {
          const partnerSalonName = salonName || `${name} Salon`;
          await tx.run(
            INSERT_SALON,
            userId,
            partnerSalonName,
            await uniqueSalonSlug(tx, partnerSalonName),
            'TP.HCM',
            createdAt,
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
    res.json({ success: true, data: { user } });
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

    const credentials = await selectCredentials.get(email.trim().toLowerCase());
    const matches = await bcrypt.compare(
      password,
      credentials?.password_hash ?? DUMMY_PASSWORD_HASH,
    );
    if (!credentials || !matches) {
      throw httpError(401, 'INVALID_CREDENTIALS', 'Email hoặc mật khẩu không đúng.');
    }

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
    const data = { message: 'Nếu email tồn tại, liên kết đặt lại mật khẩu đã được tạo.' };

    // Over the allowance: the reply is the ordinary one, so the throttle does not become a
    // new oracle of its own — but nothing is retired and nothing is minted, which is the
    // whole point of having it.
    if (!account || forgotRateLimited(`${normalised}|${req.ip}`)) {
      return res.json({ success: true, data });
    }

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();

    // DEMO ONLY — there is no mail infrastructure here, so the link comes back in the
    // response instead of being emailed. Two things make that unacceptable in production:
    // the field IS the reset secret, and its mere presence tells the caller the address is
    // registered, which is the enumeration oracle the message above avoids. Wiring real
    // mail means sending the link from here and deleting this branch.
    //
    // The gate fails open — an unset NODE_ENV emits the field — which is the weaker
    // direction. It is deliberate: render.yaml pins NODE_ENV=production on the deployed
    // service, and an opt-in flag would break the demo for every local reader instead.
    if (process.env.NODE_ENV !== 'production') {
      // This branch must write before it replies, because the token it just minted is what
      // the reply carries. The timing side channel that creates only matters where the
      // field is emitted at all, i.e. never in production.
      await mintReset(token, account.id, expiresAt);
      data.demo_reset_url = `dat-lai-mat-khau.html?token=${token}`;
      return res.json({ success: true, data });
    }

    // Reply first, write after: a known address would otherwise take two round trips
    // longer to answer than an unknown one, and response time would say what the message
    // deliberately does not. Nothing after this line may throw into `next` — the reply is
    // already on the wire — so the write reports failure to the log instead.
    res.json({ success: true, data });
    return mintReset(token, account.id, expiresAt).catch((error) => {
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

    res.json({ success: true, data: { ok: true } });
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
