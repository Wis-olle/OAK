// Base64 image uploads: stored in Supabase Storage when configured, otherwise on
// local disk and served back from /uploads.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import express from 'express';
import { httpError, requireAuth } from '../middleware/auth.js';

const router = express.Router();

const uploadsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../uploads');
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const MAX_BYTES = 5 * 1024 * 1024;
// The extension is already whitelisted, so this map is total for anything that gets here.
const CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

// Local disk is fine in dev, but Render's filesystem is ephemeral: files written there
// vanish on every restart. With Supabase credentials present, bytes go to Storage instead.
const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;
const SUPABASE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'uploads';

async function uploadToSupabase(storedName, buffer, contentType) {
  const storage = supabase.storage.from(SUPABASE_BUCKET);
  let { error } = await storage.upload(storedName, buffer, { contentType });

  // A missing bucket is a one-time setup gap, not a real failure: create it public
  // (the URLs we hand out are unauthenticated) and retry once. createBucket's own
  // outcome is deliberately ignored — a "resource already exists" failure just means
  // a concurrent upload created the bucket first, and the retry settles it either way.
  if (error && (error.status === 404 || /bucket not found/i.test(error.message ?? ''))) {
    await supabase.storage.createBucket(SUPABASE_BUCKET, { public: true });
    ({ error } = await storage.upload(storedName, buffer, { contentType }));
  }

  if (error) {
    // The global handler answers with a generic 500 and hides details from the
    // client; log the real Supabase error here so the failure is diagnosable.
    console.error('Supabase upload failed:', error);
    throw new Error(`Supabase upload failed: ${error.message}`);
  }

  return storage.getPublicUrl(storedName).data.publicUrl;
}
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
    if (buffer.length > MAX_BYTES) {
      throw httpError(400, 'FILE_TOO_LARGE', 'Ảnh vượt quá dung lượng tối đa 5MB.');
    }

    // The client's filename is used only to read the extension, never to build the path:
    // a name like "../../ui/index.html" would otherwise write outside the uploads folder.
    const storedName = `${randomUUID()}${extension}`;

    if (supabase) {
      const url = await uploadToSupabase(storedName, buffer, CONTENT_TYPES[extension]);
      return res.json({ success: true, data: { url } });
    }

    fs.writeFileSync(path.join(uploadsDir, storedName), buffer);
    res.json({ success: true, data: { url: `/uploads/${storedName}` } });
  } catch (error) {
    next(error);
  }
});

export default router;
