// Base64 image uploads: stored in Supabase Storage when configured, otherwise on
// local disk and served back from /uploads. Where the bytes go is lib/store-image.js,
// shared with the salon importer so both write to the same place.
import path from 'node:path';
import express from 'express';
import { ALLOWED_EXTENSIONS, MAX_IMAGE_BYTES, storeImage } from '../lib/store-image.js';
import { httpError, requireAuth } from '../middleware/auth.js';

const router = express.Router();

// Browsers hand out images as data URLs; accepting the prefix saves every caller a slice().
const DATA_URL_PREFIX = /^data:image\/[a-z.+-]+;base64,/i;

// This router is mounted ahead of the global express.json() precisely so it can raise the
// body limit for itself: 5MB of image is ~6.7MB of base64, far past the global 100kb.
router.use(express.json({ limit: '8mb' }));

router.post('/', requireAuth, async (req, res, next) => {
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
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw httpError(400, 'FILE_TOO_LARGE', 'Ảnh vượt quá dung lượng tối đa 5MB.');
    }

    // The client's filename is used only to read the extension, never to build the path.
    res.json({ success: true, data: { url: await storeImage(buffer, extension) } });
  } catch (error) {
    next(error);
  }
});

export default router;
