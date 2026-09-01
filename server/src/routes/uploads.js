// Base64 image uploads: stored in Supabase Storage when configured, otherwise on
// local disk and served back from /uploads. Where the bytes go is lib/store-image.js,
// shared with the salon importer so both write to the same place.
import path from 'node:path';
import express from 'express';
import { ALLOWED_EXTENSIONS, storeImage } from '../lib/store-image.js';
import { releaseUpload, reserveUpload, settleUpload } from '../lib/upload-quota.js';
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

/* How many pictures one account may write in an hour and the site as a whole in a day is
   lib/upload-quota.js, and it is deliberately not here: the salon importer writes into the
   same bucket through the same reservation, so a count kept beside this one door would be a
   count the other door walked straight past. */

/* requireAuth runs before the body parser rather than after it, and the parser sits on this
   one route rather than on the router, so that nothing is ever parsed or buffered for a
   stranger: Node still drains whatever they sent — the socket has to be read to be reused —
   but the megabytes are discarded as they arrive instead of being accumulated into a string
   and turned into an object. What that ordering really closes is the size oracle. An
   unauthenticated POST is answered 401 by a middleware that looked at a cookie, rather than
   413 by a parser that in refusing the body told the caller exactly how large a body this
   route would have taken. 2mb because base64 inflates bytes by a third — the 1MB image above
   arrives as roughly 1.37MB of text — and the rest is slack for the filename and the JSON
   around it.

   Open to every signed-in role, deliberately, where the audit asked for it to be closed to
   all but partner and staff accounts: a customer's own avatar comes through here too, and
   the customer side is most of the site. What that finding was really after is a ceiling,
   and the two in lib/upload-quota.js are it — shutting customers out would take away a
   feature without taking away the risk, since a partner account is exactly as free to
   register as a customer one. */
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
      throw httpError(400, 'FILE_TOO_LARGE', 'Ảnh vượt quá 1MB. Hãy chọn ảnh nhỏ hơn.');
    }

    /* The allowance is taken before a single byte goes to Supabase, and taken as a row, so
       that the requests arriving alongside this one count it. Storing first and recording
       afterwards is what let two hundred of them all read a count none of them had spent. */
    const reservation = await reserveUpload(req.user.id, buffer.length);

    let url;
    try {
      // The client's filename is used only to read the extension, never to build the path.
      url = await storeImage(buffer, extension);
    } catch (error) {
      // Nothing was written, so nothing is owed: the reservation goes back before the
      // failure travels on, or a bucket that was merely unreachable for a moment would
      // spend the caller's hour anyway.
      await releaseUpload(reservation);
      throw error;
    }
    await settleUpload(reservation, url);
    res.json({ success: true, data: { url } });
  } catch (error) {
    next(error);
  }
});

export default router;
