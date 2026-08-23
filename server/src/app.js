import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import authRoutes from './routes/auth.js';
import bookingRoutes from './routes/bookings.js';
import eventRoutes from './routes/events.js';
import favoriteRoutes from './routes/favorites.js';
import notificationRoutes from './routes/notifications.js';
import partnerRoutes from './routes/partner.js';
import postRoutes from './routes/posts.js';
import promotionRoutes from './routes/promotions.js';
import reviewRoutes from './routes/reviews.js';
import salonRoutes from './routes/salons.js';
import searchRoutes from './routes/search.js';
import serviceRoutes from './routes/services.js';
import staffRoutes from './routes/staff.js';
import uploadRoutes from './routes/uploads.js';
import userRoutes from './routes/users.js';

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.resolve(srcDir, '../../ui');
const uploadsDir = path.resolve(srcDir, '../uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const app = express();

// One hop: in production the app is served from behind Render's edge proxy, so without
// this every request reports the proxy's own address as req.ip. Anything keyed on the
// caller then keys on a single value for the whole site — the /api/events and
// /forgot-password throttles become one global bucket, and the per-visit hash in
// routes/events.js collapses to one value per browser per day.
// Only in production, because the setting is a statement about what is in front of the
// app: trusting one hop where nothing is in front means any caller can send its own
// X-Forwarded-For and pick its own req.ip, which hands them both throttles.
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// Defence in depth: confine framed content to same-origin (the phone-test preview) and
// the YouTube embed used by blog videos, and block plugins. script-src/style-src are left
// unset on purpose — the pages run the Tailwind CDN and Alpine inline, and a strict
// script policy would break every x-data page.
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "frame-src 'self' https://www.youtube.com; object-src 'none'",
  );
  next();
});

app.use(cookieParser());

// Mounted BEFORE express.json() on purpose: the global parser's default 100kb limit
// would reject a 5MB base64 upload before the uploads router's own 8mb parser ran.
app.use('/api/uploads', uploadRoutes);

app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ success: true, data: { status: 'ok' } });
});

app.use('/api/auth', authRoutes);
app.use('/api/salons', salonRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/favorites', favoriteRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/promotions', promotionRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/users', userRoutes);
app.use('/api/partner', partnerRoutes);
app.use('/api/events', eventRoutes);

// Unknown API routes get a JSON 404. Other paths fall through to the static handler.
app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: 'Không tìm thấy tài nguyên yêu cầu.' },
  });
});

// Mounted after the API so a file in ui/ can never shadow a real route.
// Uploaded bytes are caller-supplied, so the browser must never second-guess the
// Content-Type we serve them with.
app.use(
  '/uploads',
  express.static(uploadsDir, {
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
  }),
);
app.use(express.static(uiDir));

// Bad request bodies are client problems, not internal faults.
const BODY_ERRORS = {
  'entity.parse.failed': 'Dữ liệu gửi lên không phải JSON hợp lệ.',
  'entity.too.large': 'Dữ liệu gửi lên vượt quá giới hạn cho phép.',
};

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
app.use((err, req, res, next) => {
  // Only errors we built carry a code and message that are safe to expose.
  if (err.isAppError) {
    return res.status(err.status).json({
      success: false,
      error: { code: err.code, message: err.message },
    });
  }

  if (BODY_ERRORS[err.type]) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: BODY_ERRORS[err.type] },
    });
  }

  // Anything else is unexpected: log it, tell the client nothing about it.
  console.error(err);
  return res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'Đã có lỗi xảy ra, vui lòng thử lại sau.' },
  });
});

export default app;
