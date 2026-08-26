/*
 * Where an image ends up, whoever brought it.
 *
 * Lifted out of routes/uploads.js unchanged when POST /api/partner/import started re-hosting
 * pictures off a salon's own website: two routes writing image bytes must write them to the
 * same place, or a deploy with Supabase configured would keep half its images on a disk
 * Render throws away on every restart.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const uploadsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../uploads');

export const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// The extension is already whitelisted, so this map is total for anything that gets here.
export const CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
// The other direction, for bytes that arrived over the wire announcing what they are.
const EXTENSIONS_BY_CONTENT_TYPE = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

/** The extension to store a remote image under, or null when it is not one of the four. */
export function extensionForContentType(contentType) {
  const declared = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  return EXTENSIONS_BY_CONTENT_TYPE[declared] ?? null;
}

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

/**
 * Store `buffer` as an image and answer with the URL it is served from.
 *
 * `extension` must be one of ALLOWED_EXTENSIONS — callers decide it from a filename they
 * checked (uploads) or from the content type the remote host declared (import), never from
 * a path a caller sent: a name like "../../ui/index.html" would otherwise write outside the
 * uploads folder. Every file is stored under a fresh randomUUID, so one name is never reused
 * for different bytes.
 */
export async function storeImage(buffer, extension) {
  const storedName = `${randomUUID()}${extension}`;

  if (supabase) {
    return uploadToSupabase(storedName, buffer, CONTENT_TYPES[extension]);
  }

  fs.writeFileSync(path.join(uploadsDir, storedName), buffer);
  return `/uploads/${storedName}`;
}
