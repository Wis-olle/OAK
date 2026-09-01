/*
 * Put a year's Cache-Control on every object already in the Supabase bucket.
 *
 * lib/store-image.js asks for `cacheControl: '31536000'` on every upload, and has since the
 * commit that added it. Storage writes that header ONCE, at upload time, into the object's
 * own metadata — there is no bucket-wide setting and nothing rewrites it later — so every
 * picture uploaded before that commit is still served with Supabase's default of one hour.
 * Those are the oldest pictures on the site, which means they are the ones on the salon
 * pages that have been up longest, and every view of one spends the small egress allowance
 * instead of the large one. A stored name is a fresh randomUUID and the bytes under it never
 * change, so a year is the honest number and there is nothing a shorter life could correct.
 *
 * This is a ONE-TIME sweep (DEPLOY.md §6). Running it again is harmless and does nothing but
 * rewrite the same bytes with the same header.
 *
 *   node tools/supabase-cache-control.mjs             # counts only, writes nothing
 *   node tools/supabase-cache-control.mjs --apply     # download, re-upload with the header
 *
 * Reads SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_STORAGE_BUCKET from the
 * environment, exactly as the server does. Point them at production deliberately — this
 * writes to whichever bucket the shell is carrying.
 */
import { createRequire } from 'node:module';

/* The client is a dependency of the SERVER, not of a tools/ folder that has no package.json
   of its own, so it is resolved from there rather than from beside this file. A relative
   import into server/node_modules would work and would also be a path that breaks the first
   time anybody moves a folder; this asks Node the same question `import` asks, from a
   directory where the answer exists. */
const require = createRequire(new URL('../server/', import.meta.url));

// The same year lib/store-image.js asks for on a new upload, and for the same reason.
const CACHE_CONTROL_SECONDS = '31536000';

// Storage caps a listing page; walk it until a short page says there is no more.
const PAGE_SIZE = 100;

function env(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (!value) {
    console.error(`${name} is not set — point this at the project whose bucket you mean.`);
    process.exit(1);
  }
  return value;
}

/** Every object in the bucket, one page at a time. */
async function listAll(storage) {
  const objects = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await storage.list('', {
      limit: PAGE_SIZE,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) {
      throw new Error(`listing the bucket failed: ${error.message}`);
    }
    objects.push(...data);
    if (data.length < PAGE_SIZE) {
      return objects;
    }
  }
}

/** Read one object's bytes and write them back with the long cache header. */
async function rewrite(storage, object) {
  const { data, error } = await storage.download(object.name);
  if (error) {
    throw new Error(`download failed: ${error.message}`);
  }
  const buffer = Buffer.from(await data.arrayBuffer());
  /* upsert, because the object is already there under this name and that is the whole point:
     the bytes are identical and only the metadata beside them changes. contentType is carried
     over from what the object already declares — losing it would leave every picture served
     as an octet-stream, which is a worse problem than the one being fixed. */
  const { error: uploadError } = await storage.upload(object.name, buffer, {
    contentType: object.metadata?.mimetype || 'application/octet-stream',
    cacheControl: CACHE_CONTROL_SECONDS,
    upsert: true,
  });
  if (uploadError) {
    throw new Error(`re-upload failed: ${uploadError.message}`);
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const { createClient } = require('@supabase/supabase-js');
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'uploads';
  const storage = createClient(
    env('SUPABASE_URL'),
    env('SUPABASE_SERVICE_ROLE_KEY'),
  ).storage.from(bucket);

  const objects = await listAll(storage);
  /* What Storage reports is the header the object was WRITTEN with, so the ones already
     carrying the year are the ones uploaded since store-image.js started asking for it, and
     they need nothing. Compared as a number: the field comes back as 'max-age=3600'. */
  const stale = objects.filter(
    (object) => Number(/\d+/.exec(object.metadata?.cacheControl ?? '')?.[0] ?? 0) < Number(CACHE_CONTROL_SECONDS),
  );

  console.log(`bucket ${bucket}: ${objects.length} objects, ${stale.length} without a year of cache`);
  if (!apply) {
    console.log('dry run — pass --apply to download and re-upload each of them');
    return;
  }

  let done = 0;
  let failed = 0;
  for (const object of stale) {
    try {
      await rewrite(storage, object);
      done += 1;
    } catch (error) {
      // One unreadable object is not a reason to leave the other nine hundred uncorrected.
      failed += 1;
      console.error(`${object.name}: ${error.message}`);
    }
  }
  console.log(`rewritten ${done}, failed ${failed}`);
}

await main();
