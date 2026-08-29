/*
 * The row behind a technician's own page: how it is addressed, and how it comes into being.
 *
 * staff_profiles is keyed by the person rather than by a chair, so there is exactly one of
 * these per account and it outlives every stint the account ever holds. Both halves of that
 * live here — the slug the page will one day be reachable at, and the single idempotent insert
 * every endpoint that touches the profile calls before it reads.
 */
import { randomBytes } from 'node:crypto';
import { db } from '../db.js';
import { slugify } from './text.js';

/* A name is not unique and was never meant to be: two Nguyễn Thị Mai are two people, and a
   third arriving must not find her address taken. So the slug is the name plus four random
   characters — short enough to read out loud, long enough that the retry below almost never
   runs. */
const SUFFIX_LENGTH = 4;
const SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
/* What is left when a name slugifies to nothing at all. slugify strips diacritics and then
   everything that is not [a-z0-9], so a name written entirely in a script it does not know —
   or an empty one — comes back empty, and 'ky-thuat-vien-8f2a' is a readable address where
   '-8f2a' would be a broken one. */
const FALLBACK_BASE = 'ky-thuat-vien';
/* Three tries at a free slug. Each one is four random characters over a name that already
   narrows the field, so a second collision means something is wrong that a fourth attempt
   would not fix either — and an unbounded loop against a unique index is a way for one
   request to hold a connection open forever. */
const SLUG_ATTEMPTS = 3;

/** 'Nguyễn Mai Chi' -> 'nguyen-mai-chi-8f2a'. Never the same twice, by construction. */
export function makeSlug(name) {
  const suffix = [...randomBytes(SUFFIX_LENGTH)]
    .map((byte) => SUFFIX_ALPHABET[byte % SUFFIX_ALPHABET.length])
    .join('');
  return `${slugify(name) || FALLBACK_BASE}-${suffix}`;
}

/* What a first draft is filled in with: whatever the person's newest working row already says
   about her. Ordered active first and then by the most recent claim, because a technician who
   works at two salons should find the page she is standing in today, not the one she left in
   March. NULLS LAST because a row claimed before claimed_at existed sorts above everything
   otherwise, and it is the oldest row on the account. */
const selectPrefillRow = db.prepare(`
  SELECT bio, portfolio, image FROM staff
  WHERE user_id = ?
  ORDER BY active DESC, claimed_at DESC NULLS LAST, id DESC
  LIMIT 1
`);
/* Years are taken across every row instead, and the largest one wins: this is a figure about a
   career and not about a chair, so a salon that entered 8 on one row and left another blank is
   not describing somebody with no experience. */
const selectPrefillYears = db.prepare(
  'SELECT MAX(years_experience) AS years FROM staff WHERE user_id = ?',
);

/* DO NOTHING rather than DO UPDATE, and that is the withdrawal guarantee this whole function
   rests on. Every endpoint that touches the profile calls this first, so a DO UPDATE would
   quietly copy the roster row back over the person's own words on every request — a bio she
   rewrote replaced by the one the salon page still carries, once per page load.
   published_at is not in the column list: NULL is the value it has to be born with, and
   spelling it out would invite somebody to pass one. The explicit RETURNING is what stops
   db.prepare appending its own `RETURNING id` — this table is keyed by user_id and has no id.
   title and specialty are deliberately not prefilled either, even though the staff row has
   both. Those two are the SALON's words about a job — the owner typed them into the console —
   and copying them up into a self-declared field would put the salon's voice inside the
   technician's own sentence with nothing afterwards able to tell the two apart. They start
   empty and she writes her own. */
const INSERT_PROFILE = db.prepare(`
  INSERT INTO staff_profiles
    (user_id, slug, bio, portfolio, image, years_experience, hidden, created_at)
  VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  ON CONFLICT (user_id) DO NOTHING
  RETURNING user_id
`);

/**
 * Make sure `userId` has a profile row, and leave whatever is already there completely alone.
 *
 * Idempotent by the ON CONFLICT above and safe to call on every request, which is what lets
 * the three editor endpoints share one "create it if this is the first visit" path.
 *
 * It owns no transaction and takes no `tx`, deliberately. It is a single INSERT, and the retry
 * below has to be able to run: a failed statement aborts the whole Postgres transaction it sat
 * in, so a retry must WRAP a transaction rather than live inside one (db.js says the same thing
 * about the booking-code retry). Handed a tx, the second attempt would run on a connection that
 * can no longer do anything but roll back.
 */
export async function ensureStaffProfile(userId, name) {
  const row = await selectPrefillRow.get(userId);
  const years = (await selectPrefillYears.get(userId))?.years ?? 0;

  for (let attempt = 1; attempt <= SLUG_ATTEMPTS; attempt += 1) {
    try {
      await INSERT_PROFILE.run(
        userId,
        makeSlug(name),
        row?.bio ?? null,
        row?.portfolio ?? null,
        row?.image ?? null,
        years,
        new Date().toISOString(),
      );
      return;
    } catch (error) {
      /* staff_profiles_slug_key: two people whose names slugify the same drew the same four
         characters. Caught by the constraint's own name rather than by the code alone, because
         23505 is every unique violation this statement could raise, and the one on user_id is
         swallowed by the ON CONFLICT clause rather than thrown — so a bare code test would one
         day retry something a fresh suffix cannot fix. A new suffix on the way round, and the
         last attempt rethrows rather than looping forever. */
      const collided = error.code === '23505' && error.constraint === 'staff_profiles_slug_key';
      if (!collided || attempt === SLUG_ATTEMPTS) {
        throw error;
      }
    }
  }
}
