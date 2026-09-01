import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import express from 'express';
import { db, queries } from './db.js';
import authRoutes from './routes/auth.js';
import bookingRoutes from './routes/bookings.js';
import eventRoutes from './routes/events.js';
import favoriteRoutes from './routes/favorites.js';
import geoRoutes from './routes/geo.js';
import importSalonRoutes from './routes/import-salon.js';
import internalRoutes from './routes/internal.js';
import notificationRoutes from './routes/notifications.js';
import partnerRoutes from './routes/partner.js';
import promotionRoutes from './routes/promotions.js';
import reviewRoutes from './routes/reviews.js';
import salonRoutes from './routes/salons.js';
import searchRoutes from './routes/search.js';
import serviceRoutes from './routes/services.js';
import staffMeRoutes from './routes/staff-me.js';
import staffRoutes from './routes/staff.js';
import technicianRoutes from './routes/technicians.js';
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
// block plugins. script-src/style-src are left
// unset on purpose — the pages run the Tailwind CDN and Alpine inline, and a strict
// script policy would break every x-data page.
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "frame-src 'self'; object-src 'none'",
  );
  next();
});

// Compress here rather than assume something upstream does. Without this middleware the app
// answers `Accept-Encoding: br, gzip` with the bytes raw and no Content-Encoding at all —
// 65KB of oak-tailwind.css and 62KB of kham-pha.html on a first visit. Whether the edge in
// front of a given deploy makes up for that is not something this repository can promise, and
// the cost of being wrong is paid by every first-time reader, so the app owns it.
// Mounted above every route and both static mounts so it covers pages, bundles and API JSON
// alike. It is inert where it should be: the default filter skips content types that are
// already compressed (images, woff2), and a response that already carries a Content-Encoding
// is left alone — so putting a compressing CDN in front later costs nothing here.
app.use(compression());

app.use(cookieParser());

/* What this request cost the database, as `x-oak-queries`, when OAK_QUERY_COUNT=1 says to
   measure. Not on by default and never in production: the header is a measurement the smoke
   suite asks for, not a fact about the product, and it would tell a stranger how the server
   is built. Written from inside a wrapped res.end because that is the last moment before the
   headers go out — the count is not final until the handler is. */
if (queries.enabled) {
  app.use((req, res, next) => {
    queries.run(() => {
      const finish = res.end;
      res.end = function countedEnd(...args) {
        if (!res.headersSent) {
          res.setHeader('x-oak-queries', String(queries.spent()));
        }
        return finish.apply(this, args);
      };
      next();
    });
  });
}

// An API answer is either personal — a booking, a favourite, a notification — or a moment's
// truth about a shared list. Neither is safe to keep: a shared device would let the next
// account's Back button redraw the previous one's page, and a cached list would offer a slot
// somebody else has since taken. Mounted above every /api mount so /api/uploads and the JSON
// 404 are covered with the rest.
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Mounted BEFORE express.json() on purpose: the global parser's default 100kb limit
// would reject a base64 image before the uploads route's own 2mb parser ran — and that
// route puts requireAuth ahead of its parser, so a stranger's body is never parsed or
// buffered. Node still drains the bytes off the socket, which it must to reuse the
// connection; what the ordering closes is the 413 that would have told them the size.
app.use('/api/uploads', uploadRoutes);

app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ success: true, data: { status: 'ok' } });
});

app.use('/api/auth', authRoutes);
app.use('/api/salons', salonRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/staff-me', staffMeRoutes);
// One chair on a roster is /api/staff/:id; the person who has sat in several is this one.
app.use('/api/technicians', technicianRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/favorites', favoriteRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/promotions', promotionRoutes);
app.use('/api/users', userRoutes);
// Mounted BEFORE the partner console: partnerRoutes has no /import of its own, and a
// specific mount ahead of the general one keeps it that way whatever is added there later.
app.use('/api/partner/import', importSalonRoutes);
app.use('/api/partner', partnerRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/geo', geoRoutes);
// Not part of the product's API: the scheduler's own door, behind TICK_SECRET.
app.use('/api/internal', internalRoutes);

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
    setHeaders: (res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // routes/uploads.js stores every file under a fresh randomUUID(), so one name is never
      // reused for different bytes — the same promise a content hash makes, and the same year.
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  }),
);

// The home page, served as itself rather than as a redirect to itself. ui/index.html used
// to bounce '/' to kham-pha.html with a meta refresh AND a location.replace, which cost every
// first-time visitor a second round trip and left the brand's most important URL as a stub
// with no title, no description and nothing for a crawler to read. Registered before the
// static handler, which would otherwise answer '/' with that stub. Every existing link to
// kham-pha.html keeps working — the file is still served under its own name.
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(uiDir, 'kham-pha.html'));
});

/*
 * The site map, answered from the database rather than from the committed file.
 *
 * The pages half of it IS that file: ui/sitemap.xml lists the public pages and
 * server/test/seo-ui.test.mjs pins the list, so there is one place to add a page. Three of
 * its entries are query-driven shells — a salon profile, a service and a staff profile each
 * render "not found" without their ?slug — and this replaces those with the addresses that
 * actually hold something: every listed salon.
 * Registered above express.static, which would otherwise answer with the file itself.
 */
const SITEMAP_SHELL = /\/(chi-tiet-dich-vu|ho-so-chuyen-gia|salon-profile)\.html/;
// Newlines normalised on the way in: the repo checks out with core.autocrlf=true, so on
// Windows this file arrives with CRLF and the \n the entry pattern ends on would match
// nothing — every page would silently drop out of the map the server answers with.
const sitemapSource = fs
  .readFileSync(path.join(uiDir, 'sitemap.xml'), 'utf8')
  .replace(/\r\n/g, '\n');
const SITEMAP_PAGES = [...sitemapSource.matchAll(/ {2}<url>[\s\S]*?<\/url>\n/g)]
  .map((match) => match[0])
  .filter((entry) => !SITEMAP_SHELL.test(entry));
// The one origin the site declares for itself, taken from the same file so the two can
// never name different hosts. robots.txt points crawlers at it under that name.
const SITEMAP_ORIGIN = sitemapSource.match(/<loc>(https?:\/\/[^/<]+)/)[1];

const sitemapEntry = (page, priority) =>
  `  <url>\n    <loc>${SITEMAP_ORIGIN}/${page}</loc>\n` +
  `    <changefreq>weekly</changefreq>\n    <priority>${priority}</priority>\n  </url>\n`;

const selectSitemapSalons = db.prepare(
  'SELECT slug FROM salons WHERE verified = 1 AND published = 1 AND slug IS NOT NULL ORDER BY id',
);

app.get('/sitemap.xml', async (req, res) => {
  res.type('application/xml');
  try {
    const salons = await selectSitemapSalons.all();
    res.send(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        SITEMAP_PAGES.join('') +
        salons
          .map((row) => sitemapEntry(`salon-profile.html?salon=${encodeURIComponent(row.slug)}`, '0.8'))
          .join('') +
        '</urlset>\n',
    );
  } catch (error) {
    // A database that cannot be read is no reason to answer a crawler with a 500: the
    // committed file is the same map minus the per-salon addresses.
    console.error(error);
    res.send(sitemapSource);
  }
});

// A file whose name carries its own content hash — alpine-<hash>.js, font-<hash>.woff2,
// img-<hash>.jpg — can be kept forever, because a new build gives it a new name and nobody
// ever asks for the stale one again.
// A page is the opposite case: its URL never changes, so it has to be revalidated every visit.
// 'no-cache' does not forbid storing it — the browser still sends the ETag and still gets a 304
// for bytes it already holds; it only forbids using that copy without asking first.
// Everything else is what the pages ask for by a bare name — oak-api.js, oak-i18n.js,
// oak-tailwind.css, hero-banner.webp, and font-material-subset.woff2, which tools/icons
// rewrites in place under that same name every time icon-names.txt grows (DEPLOY.md §5). A
// name that is reused for new bytes must never be frozen: a reader holding last year's subset
// would draw a newly added glyph as a blank, and nothing in the URL could tell them otherwise.
// Five minutes is long enough to carry a reader across a few pages of one visit, short enough
// that a deploy — or a regenerated subset — reaches everybody within five minutes.
const HASHED_ASSET = /-[0-9a-f]{8,}\.[a-z0-9]+$/;

app.use(
  express.static(uiDir, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      } else if (HASHED_ASSET.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=300');
      }
    },
  }),
);

// Anything still unmatched is a page that does not exist. A browser asking for HTML gets the
// branded 404 with a way back; everything else (an image, a fetch) gets a bare status, because
// a page of markup in place of an asset only confuses the caller.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  // Preference, not acceptability: an image request sends 'image/avif,image/webp,*/*;q=0.8',
  // whose '*/*' makes accepts('html') true even though HTML is the last thing it wants. Asking
  // which of the two types it prefers ties on that header and falls to the first listed one,
  // while a navigation ('text/html,...;q=0.9') still scores text/html highest and gets the page.
  // A caller that omits the header entirely states no preference, so it gets the page too —
  // the tie-break only makes sense against a header that actually ranked the types. Note that
  // curl's default is '*/*', which ties and therefore gets the plain body.
  if (req.headers.accept && req.accepts(['text/plain', 'text/html']) !== 'text/html') {
    return res.status(404).type('txt').send('Not Found');
  }
  return res.status(404).sendFile(path.join(uiDir, '404.html'));
});

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
      // `details` only when the refusal built one: see httpError in middleware/auth.js.
      error: {
        code: err.code,
        message: err.message,
        ...(err.details === undefined ? {} : { details: err.details }),
      },
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
