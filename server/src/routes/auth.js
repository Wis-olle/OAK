import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../db.js';
import { slugify } from '../lib/text.js';
import { COOKIE_NAME, JWT_SECRET, httpError, selectPublicUser } from '../middleware/auth.js';

const router = express.Router();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
const ROLES = ['customer', 'partner'];

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
const selectSalonBySlug = db.prepare('SELECT 1 FROM salons WHERE slug = ?');
const insertUser = db.prepare(
  'INSERT INTO users (name, email, phone, password_hash, role, avatar, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)',
);
// verified = 0: a salon anyone can create by signing up has not been checked by OAK yet,
// so it must not wear the verified badge until a human approves it.
const insertSalon = db.prepare(
  'INSERT INTO salons (owner_id, name, slug, city, verified, created_at) VALUES (?, ?, ?, ?, 0, ?)',
);

/** Append -2, -3, ... until the slug is free. */
function uniqueSalonSlug(name) {
  const base = slugify(name) || 'salon';
  let slug = base;
  let suffix = 1;
  while (selectSalonBySlug.get(slug)) {
    suffix += 1;
    slug = `${base}-${suffix}`;
  }
  return slug;
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

    db.exec('BEGIN');
    let userId;
    try {
      userId = Number(
        insertUser.run(
          name,
          email.trim().toLowerCase(),
          phone ?? null,
          passwordHash,
          accountRole,
          createdAt,
        ).lastInsertRowid,
      );

      if (accountRole === 'partner') {
        const partnerSalonName = salonName || `${name} Salon`;
        insertSalon.run(
          userId,
          partnerSalonName,
          uniqueSalonSlug(partnerSalonName),
          'TP.HCM',
          createdAt,
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      // Let the UNIQUE constraint, not a pre-check, decide the duplicate case:
      // check-then-act straddling the ~90ms bcrypt hash was racy.
      if (String(error.message).includes('UNIQUE constraint failed: users.email')) {
        throw httpError(409, 'EMAIL_TAKEN', 'Email này đã được sử dụng.');
      }
      throw error;
    }

    const user = selectPublicUser.get(userId);
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

    const credentials = selectCredentials.get(email.trim().toLowerCase());
    const matches = await bcrypt.compare(
      password,
      credentials?.password_hash ?? DUMMY_PASSWORD_HASH,
    );
    if (!credentials || !matches) {
      throw httpError(401, 'INVALID_CREDENTIALS', 'Email hoặc mật khẩu không đúng.');
    }

    const user = selectPublicUser.get(credentials.id);
    issueCookie(res, user);
    res.json({ success: true, data: { user } });
  } catch (error) {
    next(error);
  }
});

router.post('/forgot-password', (req, res, next) => {
  try {
    const { email } = req.body ?? {};
    if (typeof email !== 'string' || !email.trim()) {
      throw httpError(400, 'VALIDATION_ERROR', 'Vui lòng nhập email.');
    }

    // Nothing is sent: this demo has no mail infrastructure. The reply is deliberately
    // identical for a registered and an unknown address — answering "no such account"
    // would turn this endpoint into an account-enumeration oracle.
    res.json({
      success: true,
      data: { message: 'Nếu email tồn tại, hướng dẫn đặt lại mật khẩu đã được gửi.' },
    });
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
router.get('/me', (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  let user = null;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
      user = selectPublicUser.get(payload.id) ?? null;
    } catch {
      user = null;
    }
  }
  res.json({ success: true, data: { user } });
});

export default router;
