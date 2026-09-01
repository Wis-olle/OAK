// Base64 image uploads: stored in Supabase Storage when configured, otherwise on
// local disk and served back from /uploads. Where the bytes go is lib/store-image.js,
// shared with the salon importer so both write to the same place.
import path from 'node:path';
import express from 'express';
import { db } from '../db.js';
import { ALLOWED_EXTENSIONS, storeImage } from '../lib/store-image.js';
import { startOfDayUTC, todayISO } from '../lib/time.js';
import { httpError, requireAuth } from '../middleware/auth.js';

const router = express.Router();

// Browsers hand out images as data URLs; accepting the prefix saves every caller a slice().
const DATA_URL_PREFIX = /^data:image\/[a-z.+-]+;base64,/i;

/* What one picture may weigh once it is decoded. Every screen that uploads now re-draws the
   file to a few hundred pixels and re-encodes it in the browser first (OAK.compressImage in
   oak-api.js), so a megabyte is far more room than what actually arrives; a caller that
   posts a phone camera's original is turned away here with a message that says so.
   Deliberately not store-image.js's MAX_IMAGE_BYTES, which stays at 5MB: that ceiling also
   governs the salon importer re-hosting pictures off a salon's own website, where no
   browser of ours compressed anything first. */
const MAX_UPLOAD_BYTES = 1024 * 1024;

/* Two ceilings above that one, because an account costs an email address and nothing else:
   the bucket is only as safe as the slowest attacker, and 1GB of Supabase Storage is about
   a thousand pictures at the size above.

   Twenty an hour per account is well past anything a real screen asks for — the largest
   single act on the site is filling a twelve-picture salon gallery — and low enough that
   one account working without pause needs months to fill the bucket by itself.

   The daily number is not a quota but a circuit breaker: it does not care who is uploading,
   it simply stops the site as a whole from writing more than this many pictures in one
   Vietnamese calendar day, so a run spread across a hundred fresh accounts costs a day
   rather than the bucket. UPLOADS_DAILY_CAP raises it from the environment for the day a
   real campaign needs the room.

   Both are counted out of the `uploads` table rather than a counter in memory: Render runs
   two instances and restarts them whenever it pleases, so anything kept in a process would
   be half-blind to begin with and reset on every deploy. */
const UPLOADS_PER_HOUR = 20;
const UPLOADS_DAILY_CAP = Number(process.env.UPLOADS_DAILY_CAP) || 500;
const HOUR_MS = 60 * 60 * 1000;

/* created_at is written as new Date().toISOString() rather than in Vietnam time on purpose:
   ISO-8601 UTC strings sort lexicographically, so both windows are plain text comparisons
   on a TEXT column and idx_uploads_user_created_at serves the per-account one directly. */
const countUploadsSince = db.prepare(
  'SELECT COUNT(*) AS total FROM uploads WHERE user_id = ? AND created_at > ?',
);
const countUploadsToday = db.prepare(
  'SELECT COUNT(*) AS total FROM uploads WHERE created_at >= ?',
);
const insertUpload = db.prepare(
  'INSERT INTO uploads (user_id, url, bytes, created_at) VALUES (?, ?, ?, ?)',
);

/* requireAuth runs before the body parser rather than after it, and the parser sits on this
   one route rather than on the router, so that a stranger's megabytes are never read into
   memory at all: an unauthenticated POST is answered 401 by a middleware that looked at a
   cookie, not 413 by a parser that first swallowed the body and in doing so told the caller
   how large a body the route would have taken. 2mb because base64 inflates bytes by a
   third — the 1MB image above arrives as roughly 1.37MB of text — and the rest is slack for
   the filename and the JSON around it.

   Open to every signed-in role, deliberately, where the audit asked for it to be closed to
   all but partner and staff accounts: a customer's own avatar comes through here too, and
   the customer side is most of the site. What that finding was really after is a ceiling,
   and the two above are it — shutting customers out would take away a feature without
   taking away the risk, since a partner account is exactly as free to register as a
   customer one. */
router.post('/', requireAuth, express.json({ limit: '2mb' }), async (req, res, next) => {
  try {
    const { filename, data } = req.body ?? {};
    if (typeof filename !== 'string' || typeof data !== 'string') {
      throw httpError(400, 'VALIDATION_ERROR', 'Vui lòng gửi tên tệp và dữ liệu ảnh.');
    }

    const extension = path.extname(filename).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(extension)) {
      throw httpError(400, 'INVALID_FILE_TYPE', 'Chỉ chấp nhận ảnh .jpg, .jpeg, .png hoặc .webp.');
    }

    const buffer = Buffer.from(data.replace(DATA_URL_PREFIX, ''), 'base64');
    if (buffer.length === 0) {
      throw httpError(400, 'VALIDATION_ERROR', 'Dữ liệu ảnh không hợp lệ.');
    }
    // Checked after decoding, because base64 inflates the payload by a third and the
    // limit the product promises is on the real file.
    if (buffer.length > MAX_UPLOAD_BYTES) {
      throw httpError(
        400,
        'FILE_TOO_LARGE',
        'Ảnh vượt quá 1MB. Hãy chọn ảnh nhỏ hơn hoặc để trang tự nén.',
      );
    }

    const anHourAgo = new Date(Date.now() - HOUR_MS).toISOString();
    const { total: recent } = await countUploadsSince.get(req.user.id, anHourAgo);
    if (Number(recent) >= UPLOADS_PER_HOUR) {
      throw httpError(429, 'TOO_MANY_UPLOADS', 'Bạn đã tải quá nhiều ảnh, thử lại sau một giờ.');
    }
    const { total: today } = await countUploadsToday.get(startOfDayUTC(todayISO()));
    if (Number(today) >= UPLOADS_DAILY_CAP) {
      throw httpError(429, 'UPLOADS_PAUSED', 'OAK tạm ngưng nhận ảnh hôm nay, thử lại ngày mai.');
    }

    // The client's filename is used only to read the extension, never to build the path.
    const url = await storeImage(buffer, extension);
    await insertUpload.run(req.user.id, url, buffer.length, new Date().toISOString());
    res.json({ success: true, data: { url } });
  } catch (error) {
    next(error);
  }
});

export default router;
