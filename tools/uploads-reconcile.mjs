/*
 * Take back the space nothing points at any more.
 *
 * Every picture on this platform is written once and never overwritten — a stored name is a
 * fresh randomUUID (lib/store-image.js) — and nothing has ever deleted one. A salon replaces
 * its cover, a technician swaps a portfolio piece, an import re-hosts a gallery the partner
 * then edits away: in each case the row stops naming the object and the object stays in the
 * bucket for ever. On the Supabase free plan the bucket is a gigabyte, which is about a
 * thousand pictures, and the abandoned ones are indistinguishable from the live ones from
 * inside the bucket. This is the sweep that tells them apart, from the outside: a bucket
 * object nothing in the database names is not a picture, it is a leak.
 *
 * Run it MONTHLY (DEPLOY.md §6).
 *
 *   node tools/uploads-reconcile.mjs            # counts only, deletes nothing
 *   node tools/uploads-reconcile.mjs --apply    # actually delete
 *
 * Two safety rails, and both matter:
 *
 *   - Nothing younger than a day is ever touched. An upload lands in the bucket BEFORE the
 *     form that will name it is saved, so a picture a partner is halfway through attaching
 *     is unreferenced and perfectly alive. A day is far longer than any such gap.
 *   - A name is "referenced" if a CONTENT column names it. Reading one column too many costs
 *     a picture nobody will ever see again; reading one too few deletes a live one. So when
 *     in doubt this errs at keeping, and the list below is deliberately generous.
 *
 * `uploads.url` is the one address column deliberately NOT on that list, and it is worth
 * saying why: it is the ledger of what this platform WROTE, not evidence that anything still
 * points at it. A settled row is never deleted (lib/upload-quota.js only deletes the ones
 * whose bytes never arrived), so every object that ever landed in the bucket is named there
 * for ever — including the cover photo a salon replaced this morning, which is exactly the
 * kind of object this sweep exists to reclaim. Read it and the answer is always zero.
 *
 * It also clears abandoned RESERVATIONS: `uploads` rows still carrying url = '' more than an
 * hour after they were written are a process that died between taking the day's allowance
 * and storing its bytes, and they hold budget against a picture nobody will ever find.
 *
 * Where it looks depends on the environment, exactly as lib/store-image.js decides where to
 * write: the Supabase bucket when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set, and
 * server/uploads on disk when they are not. DATABASE_URL has to name the database that
 * belongs to whichever of the two — see main() for why there is no default.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* pg and the storage client are dependencies of the SERVER, not of a tools/ folder with no
   package.json of its own, so they are resolved from there. Required lazily inside main(),
   so that importing this file for its pure half costs nothing. */
const require = createRequire(new URL('../server/', import.meta.url));

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server');

const KEEP_YOUNGER_THAN_MS = 24 * 60 * 60 * 1000;
const ABANDONED_RESERVATION_MS = 60 * 60 * 1000;

/* Every column in the schema that can hold the address of a stored picture. Grepped out of
   server/src/db.js rather than remembered: a column added later and forgotten here is a
   column whose pictures this sweep deletes. `json` columns hold a JSON array of addresses in
   one TEXT field (the portfolio editor writes them that way); the rest hold one address.
   promotions.image and posts.image are in the list even though today they are only ever
   seeded or written by hand — the cost of reading a column that names nothing is nothing.
   uploads.url is not a content column and does not belong here: see the header. */
export const IMAGE_COLUMNS = [
  ['users', 'avatar', 'url'],
  ['salons', 'image', 'url'],
  ['salon_photos', 'image', 'url'],
  ['services', 'image', 'url'],
  ['staff', 'image', 'url'],
  ['staff', 'portfolio', 'json'],
  ['staff_profiles', 'image', 'url'],
  ['staff_profiles', 'portfolio', 'json'],
  ['promotions', 'image', 'url'],
  ['posts', 'image', 'url'],
];

/**
 * The stored object name inside an address, or null when the address names no object of ours.
 *
 * Both shapes this platform hands out end in the name Storage (or the /uploads mount) knows
 * the object by: `https://x.supabase.co/storage/v1/object/public/uploads/<name>` and
 * `/uploads/<name>`. So the last path segment is the answer for both, with the query string
 * off it and percent-escapes undone.
 *
 * A seeded image points at somebody else's host, and its last segment is a name no bucket
 * object has — the names in the bucket are UUIDs. Reading one is therefore harmless: the
 * worst it could do is mark an object as referenced, and an object wrongly kept is a byte
 * spent, while an object wrongly deleted is a picture gone.
 */
export function objectNameOf(address) {
  if (typeof address !== 'string' || address === '') {
    return null;
  }
  const withoutQuery = address.split('?')[0].split('#')[0];
  const last = withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1);
  if (last === '') {
    return null;
  }
  try {
    return decodeURIComponent(last);
  } catch {
    // A name that is not valid percent-encoding is still a name; take it as it is written.
    return last;
  }
}

/**
 * Every object name the database names, out of the raw column values it holds.
 *
 * The pure half of this tool, and the only part with a test: a value is either one address
 * or a JSON array of them, and an array is recognised by its own first character rather than
 * by the caller having to say which column it came from — no address this platform writes
 * begins with '['.
 */
export function referencedNames(values) {
  const names = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || value === '') {
      continue;
    }
    const addresses = value.startsWith('[') ? safeJsonArray(value) : [value];
    for (const address of addresses) {
      const name = objectNameOf(address);
      if (name !== null) {
        names.add(name);
      }
    }
  }
  return names;
}

/** A JSON array of strings, or nothing at all — a column this cannot read names nothing. */
function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

/* ============================================================================
 * The half that talks to the database and the bucket
 * ========================================================================= */

/** Every value of every column above, skipping tables this database does not have. */
async function readReferences(client) {
  const values = [];
  for (const [table, column] of IMAGE_COLUMNS) {
    const { rows: exists } = await client.query('SELECT to_regclass($1) AS oid', [`public.${table}`]);
    if (exists[0].oid === null) {
      console.log(`skipping ${table}.${column}: no such table here`);
      continue;
    }
    const { rows } = await client.query(
      `SELECT "${column}" AS value FROM "${table}" WHERE "${column}" IS NOT NULL AND "${column}" <> ''`,
    );
    for (const row of rows) {
      values.push(row.value);
    }
  }
  return values;
}

/**
 * Where the pictures actually are, as {objects: [{name, createdAt}], storage}.
 *
 * `storage` is the bucket handle when there is one and null when the bytes are on disk, so
 * the deletion below writes back to whichever of the two this read from — reading one and
 * deleting from the other is the one mistake this tool must not be able to make.
 */
async function listStoredObjects() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const dir = path.join(serverRoot, 'uploads');
    console.log(`no Supabase credentials — reading ${dir}`);
    const objects = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== '.gitkeep')
      .map((entry) => ({
        name: entry.name,
        createdAt: fs.statSync(path.join(dir, entry.name)).mtimeMs,
      }));
    return { objects, storage: null };
  }

  const { createClient } = require('@supabase/supabase-js');
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'uploads';
  const storage = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  ).storage.from(bucket);
  console.log(`reading bucket ${bucket}`);

  const objects = [];
  const pageSize = 100;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await storage.list('', {
      limit: pageSize,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) {
      throw new Error(`listing the bucket failed: ${error.message}`);
    }
    for (const object of data) {
      objects.push({ name: object.name, createdAt: Date.parse(object.created_at) });
    }
    if (data.length < pageSize) {
      return { objects, storage };
    }
  }
}

/** Delete the named objects, wherever they live. */
async function deleteObjects(names, storage) {
  if (!storage) {
    for (const name of names) {
      fs.rmSync(path.join(serverRoot, 'uploads', name), { force: true });
    }
    return;
  }
  // remove() takes a list; batched so one very long sweep is not one very long request.
  for (let from = 0; from < names.length; from += 100) {
    const { error } = await storage.remove(names.slice(from, from + 100));
    if (error) {
      throw new Error(`deleting failed: ${error.message}`);
    }
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const { Client } = require('pg');
  /* Named outright, never defaulted. The list of what to KEEP comes from the database and
     the list of what EXISTS comes from the bucket, so the two have to describe the same
     deployment — and a default would silently pair the dev machine's database, where the
     production objects are referenced by nothing at all, with the production bucket. Every
     picture on the site is then an orphan older than a day, and --apply deletes all of them.
     Storage has no undo. So: say which database, and refuse the pairing that cannot be right. */
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set — name the database whose rows describe this bucket.');
    process.exit(1);
  }
  const host = new URL(connectionString).hostname;
  const local = host === 'localhost' || host === '127.0.0.1';
  if (local && process.env.SUPABASE_URL) {
    console.error(
      `refusing: DATABASE_URL points at ${host} while SUPABASE_URL names a remote bucket. ` +
        'A local database knows nothing about those objects and every one of them would ' +
        'look orphaned. Point both at the same deployment.',
    );
    process.exit(1);
  }
  const client = new Client({
    connectionString,
    ssl: local ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const referenced = referencedNames(await readReferences(client));
    const { objects, storage } = await listStoredObjects();

    const cutoff = Date.now() - KEEP_YOUNGER_THAN_MS;
    const orphans = objects.filter(
      (object) => !referenced.has(object.name) && object.createdAt < cutoff,
    );
    const young = objects.filter(
      (object) => !referenced.has(object.name) && !(object.createdAt < cutoff),
    );

    const anHourAgo = new Date(Date.now() - ABANDONED_RESERVATION_MS).toISOString();
    const { rows: abandoned } = await client.query(
      "SELECT id FROM uploads WHERE url = '' AND created_at < $1",
      [anHourAgo],
    );

    console.log(
      `${objects.length} stored, ${referenced.size} names referenced, ` +
        `${orphans.length} orphaned and older than a day, ${young.length} too young to judge, ` +
        `${abandoned.length} abandoned reservations`,
    );

    if (!apply) {
      console.log('dry run — pass --apply to delete');
      return;
    }

    await deleteObjects(orphans.map((object) => object.name), storage);
    const { rowCount } = await client.query(
      "DELETE FROM uploads WHERE url = '' AND created_at < $1",
      [anHourAgo],
    );
    console.log(`deleted ${orphans.length} objects and ${rowCount} abandoned reservations`);
  } finally {
    await client.end();
  }
}

// Importable for its pure half without any of the above running.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
