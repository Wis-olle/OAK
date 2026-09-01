/*
 * How many pictures may be written, and the one place that decides it.
 *
 * Every door that writes into the storage bucket comes through here: POST /api/uploads,
 * where a signed-in person posts a picture their browser just shrank, and the salon
 * importer, which fetches a partner's own gallery off their website and re-hosts it. Two
 * doors into one bucket is exactly the shape a ceiling gets walked around, so neither one
 * holds a count of its own — they both charge this.
 *
 * An account costs an email address and nothing else, so the bucket is only as safe as the
 * slowest attacker, and 1GB of Supabase Storage is about a thousand pictures at the size
 * POST /api/uploads accepts.
 *
 * Twenty an hour per account is well past anything a real screen asks for — the largest
 * single act on the site is filling a twelve-picture salon gallery — and low enough that
 * one account working without pause needs months to fill the bucket by itself.
 *
 * The daily number is not a quota but a circuit breaker: it does not care who is uploading,
 * it simply stops the site as a whole from writing more than this many pictures in one
 * Vietnamese calendar day, so a run spread across a hundred fresh accounts costs a day
 * rather than the bucket. UPLOADS_DAILY_CAP raises it from the environment for the day a
 * real campaign needs the room, and setting it to 0 shuts the doors entirely, which is what
 * an operator wants while they are clearing the bucket out by hand. Number.parseInt and an
 * explicit finite check rather than `Number(x) || 500`, because that idiom reads 0 as
 * absent and hands back the default — the one value an operator would only ever type on
 * purpose.
 *
 * Both are counted out of the `uploads` table rather than a counter in memory: Render runs
 * two instances and restarts them whenever it pleases, so anything kept in a process would
 * be half-blind to begin with and reset on every deploy.
 */
import { db } from '../db.js';
import { httpError } from '../middleware/auth.js';
import { startOfDayUTC, todayISO } from './time.js';

const UPLOADS_PER_HOUR = 20;
const parsedDailyCap = Number.parseInt(process.env.UPLOADS_DAILY_CAP ?? '', 10);
const UPLOADS_DAILY_CAP = Number.isFinite(parsedDailyCap) ? parsedDailyCap : 500;
const HOUR_MS = 60 * 60 * 1000;

/* created_at is written as new Date().toISOString() rather than in Vietnam time on purpose:
   ISO-8601 UTC strings sort lexicographically, so both windows are plain text comparisons
   on a TEXT column and idx_uploads_user_created_at serves the per-account one directly.
   idx_uploads_created_at serves the site-wide one, which has no user to narrow it by. */
const COUNT_SINCE = 'SELECT COUNT(*) AS total FROM uploads WHERE user_id = ? AND created_at > ?';
const COUNT_TODAY = 'SELECT COUNT(*) AS total FROM uploads WHERE created_at >= ?';
const INSERT_UPLOAD = 'INSERT INTO uploads (user_id, url, bytes, created_at) VALUES (?, ?, ?, ?)';
const settleStatement = db.prepare('UPDATE uploads SET url = ? WHERE id = ?');
const releaseStatement = db.prepare('DELETE FROM uploads WHERE id = ?');

/**
 * Take one picture's worth of allowance for `userId`, or throw the 429 that refuses it.
 * Returns the id of the row now standing for that picture.
 *
 * Counting and then storing and then writing the row is check-then-act with a round trip to
 * Supabase sitting in the middle of it, and two hundred requests arriving together all read
 * the same count and all pass. So the row is written FIRST, inside the same transaction that
 * counted, and it is written with an empty url: a reservation. It counts against both
 * ceilings from the moment it exists, which is what makes the numbers hold under a burst
 * instead of being a suggestion. settleUpload writes the real address onto it once the bytes
 * are in the bucket; releaseUpload takes it back out again if they never got there.
 *
 * The serialisation is one advisory lock over the whole table rather than a lock per
 * account, and that is acceptable precisely because of what these numbers are: the site as a
 * whole accepts a few hundred pictures a day, so the uploads that ever contend for this lock
 * could be run one after another all day and never notice. A per-account lock would let two
 * accounts race the site-wide breaker past its own ceiling, which is the one number this has
 * to be exact about. The lock is held to the transaction (pg_advisory_xact_lock), so a
 * process that dies mid-upload releases it with its connection rather than wedging the door.
 */
async function reserveUpload(userId, bytes) {
  return db.withTransaction(async (tx) => {
    await tx.get("SELECT pg_advisory_xact_lock(hashtext('uploads'))");

    const anHourAgo = new Date(Date.now() - HOUR_MS).toISOString();
    const { total: recent } = await tx.get(COUNT_SINCE, userId, anHourAgo);
    if (Number(recent) >= UPLOADS_PER_HOUR) {
      throw httpError(429, 'TOO_MANY_UPLOADS', 'Bạn đã tải quá nhiều ảnh, thử lại sau một giờ.');
    }

    const { total: today } = await tx.get(COUNT_TODAY, startOfDayUTC(todayISO()));
    if (Number(today) >= UPLOADS_DAILY_CAP) {
      throw httpError(429, 'UPLOADS_PAUSED', 'OAK tạm ngưng nhận ảnh hôm nay, thử lại ngày mai.');
    }

    const written = await tx.run(INSERT_UPLOAD, userId, '', bytes, new Date().toISOString());
    return written.lastInsertRowid;
  });
}

/** The bytes are in the bucket: point the reserved row at where they landed. */
async function settleUpload(id, url) {
  await settleStatement.run(url, id);
}

/* The bytes never got there, so the allowance goes back. Deleted rather than left with its
   empty url, because the row's whole job from here on is to be reconciled against the bucket
   listing, and a row naming an object that was never written would send that sweep looking
   for a file nobody stored. */
async function releaseUpload(id) {
  await releaseStatement.run(id);
}

export { UPLOADS_DAILY_CAP, UPLOADS_PER_HOUR, releaseUpload, reserveUpload, settleUpload };
