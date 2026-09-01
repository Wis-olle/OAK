import jwt from 'jsonwebtoken';
import { db } from '../db.js';

export const COOKIE_NAME = 'oak_token';
export const JWT_SECRET = process.env.JWT_SECRET || 'oak-dev-secret';

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production');
}

export const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

/** Mint a session for `user` and put it in the auth cookie. */
export function issueCookie(res, user) {
  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
}

// How old a token may get before an authenticated request replaces it. Well inside the
// 7-day expiry, so somebody who keeps using OAK is never signed out mid-task; somebody who
// stops still loses the session seven days after they last used it.
const SLIDE_AFTER_SECONDS = 3 * 24 * 60 * 60;

/**
 * Build an error the central error handler turns into a JSON envelope.
 * The isAppError tag marks the code and message as safe to send to the client.
 *
 * `details` is optional and travels beside the sentence for the one kind of refusal a
 * sentence cannot carry: BOOKINGS_AFFECTED has to hand the console the appointments the
 * owner is about to have to ring, and a count in the message would leave the page counting
 * people it could not name. Whatever a caller puts there is sent to the client verbatim, so
 * it is held to the same rule the message is: nothing in it that the caller is not allowed
 * to read.
 */
export function httpError(status, code, message, details) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.isAppError = true;
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

// Never selects password_hash, so it can never leak into a response. password_changed_at
// rides along because requireAuth needs it on every authenticated request and this is
// already that request's one user lookup; it is the account holder's own metadata and is
// only ever returned to them.
export const selectPublicUser = db.prepare(
  'SELECT id, name, email, phone, role, avatar, city, district, marketing_opt_in, password_changed_at, created_at FROM users WHERE id = ?',
);

/**
 * True when `payload` was minted before the account last changed its password, which is
 * what makes a reset or a change log the other sessions out.
 *
 * Both sides are epoch seconds: `iat` is defined that way by JWT, and users.password_changed_at
 * is stored in the same unit for exactly this comparison. NULL means the password has never
 * changed, so nothing can predate it.
 */
export function sessionOutlivedPassword(payload, user) {
  return user.password_changed_at != null && payload.iat < user.password_changed_at;
}

/** Load the user named by the auth cookie onto req.user, or reject with 401. */
export async function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    return next(httpError(401, 'UNAUTHENTICATED', 'Bạn cần đăng nhập để tiếp tục.'));
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return next(httpError(401, 'UNAUTHENTICATED', 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.'));
  }

  const user = await selectPublicUser.get(payload.id);
  if (!user) {
    return next(httpError(401, 'UNAUTHENTICATED', 'Tài khoản không còn tồn tại.'));
  }
  if (sessionOutlivedPassword(payload, user)) {
    return next(
      httpError(401, 'UNAUTHENTICATED', 'Mật khẩu đã thay đổi, vui lòng đăng nhập lại.'),
    );
  }

  // Sliding session: the token this request arrived with is old enough that the reader
  // would be signed out mid-task in a few days, so it is replaced with a fresh one. Signed
  // from `user`, so a re-issue can never carry a role the account no longer has.
  if (Math.floor(Date.now() / 1000) - payload.iat > SLIDE_AFTER_SECONDS) {
    issueCookie(res, user);
  }

  req.user = user;
  return next();
}

/**
 * The user named by the auth cookie, or null. The same three checks requireAuth makes —
 * a readable token, an account still there, a session not outlived by a password change —
 * without the rejection and without the sliding re-issue.
 *
 * For a PUBLIC route that answers a little differently to the person the answer is about.
 * No cookie, an unreadable one or a deleted account is simply a stranger there, and a
 * stranger is allowed; a public route also has no business minting a fresh cookie, so the
 * slide stays with requireAuth.
 */
export async function sessionUser(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    return null;
  }
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
  const user = await selectPublicUser.get(payload.id);
  return user && !sessionOutlivedPassword(payload, user) ? user : null;
}

/** Allow only partner accounts. Expects requireAuth to have run first. */
export function requirePartner(req, res, next) {
  if (!req.user) {
    return next(httpError(401, 'UNAUTHENTICATED', 'Bạn cần đăng nhập để tiếp tục.'));
  }
  if (req.user.role !== 'partner') {
    return next(httpError(403, 'FORBIDDEN', 'Chức năng này chỉ dành cho tài khoản đối tác.'));
  }
  return next();
}

/** Allow only staff accounts. Expects requireAuth to have run first. */
export function requireStaff(req, res, next) {
  if (!req.user) {
    return next(httpError(401, 'UNAUTHENTICATED', 'Bạn cần đăng nhập để tiếp tục.'));
  }
  if (req.user.role !== 'staff') {
    return next(httpError(403, 'FORBIDDEN', 'Chức năng này chỉ dành cho tài khoản nhân viên.'));
  }
  return next();
}
