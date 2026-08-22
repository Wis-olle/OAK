import jwt from 'jsonwebtoken';
import { db } from '../db.js';

export const COOKIE_NAME = 'oak_token';
export const JWT_SECRET = process.env.JWT_SECRET || 'oak-dev-secret';

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production');
}

/**
 * Build an error the central error handler turns into a JSON envelope.
 * The isAppError tag marks the code and message as safe to send to the client.
 */
export function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.isAppError = true;
  return error;
}

// Never selects password_hash, so it can never leak into a response. password_changed_at
// rides along because requireAuth needs it on every authenticated request and this is
// already that request's one user lookup; it is the account holder's own metadata and is
// only ever returned to them.
export const selectPublicUser = db.prepare(
  'SELECT id, name, email, phone, role, avatar, city, district, password_changed_at, created_at FROM users WHERE id = ?',
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

  req.user = user;
  return next();
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
