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
/* And how much of the name is allowed into the address at all. staff_profiles_slug_key is a
   btree, and a btree refuses an entry over roughly 2700 bytes outright — so a registration
   carrying a name long enough to slugify past that died on this INSERT with an internal error,
   at the last statement, after the account had already been shaped. Sixty characters is longer
   than any name a person actually answers to and short enough to read out loud. Taken off the
   BASE and not off the finished slug, because the four random characters are the whole reason
   two people with one name get two addresses: trimmed after the suffix was appended, the
   longest names would all come back as the same string. */
const SLUG_BASE_MAX = 60;
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
  return `${slugify(name).slice(0, SLUG_BASE_MAX) || FALLBACK_BASE}-${suffix}`;
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

/* The same row, minted the other way: alongside the account itself, inside the transaction that
   creates it, at a moment when there is nothing to fill it in from.

   Plain SQL strings rather than db.prepare handles, the way CLAIM_STAFF_ROW in lib/staff-invite.js
   is a string: a prepared statement is bound to the pool and would run on a connection of its own,
   outside the caller's transaction — so an account that rolled back would leave a page behind it.
   The explicit RETURNING is here for the reason INSERT_PROFILE spells its own: db.js appends
   ` RETURNING id` to any INSERT that lacks one, and this table is keyed by user_id and has no id. */
const SELECT_SLUG_TAKEN = 'SELECT 1 FROM staff_profiles WHERE slug = ?';
/* No prefill, and there is nothing that could be prefilled: a brand-new account has claimed no
   roster row, so the two reads above would find nothing to copy. bio, portfolio and image are born
   NULL and years_experience 0, and everything the page says she writes herself in the editor. */
const INSERT_NEW_PROFILE = `
  INSERT INTO staff_profiles
    (user_id, slug, years_experience, hidden, published_at, created_at)
  VALUES (?, ?, 0, 0, ?, ?)
  RETURNING user_id
`;

/**
 * Mint `userId`'s profile row inside the CALLER's transaction, and hand back the slug it will be
 * reachable at. An account whose page could not be written is not an account: both go or neither.
 *
 * `publishedAt` is a parameter rather than the NULL its sibling above hard-codes, because only the
 * caller knows which consent was given. INSERT_PROFILE's comment — "NULL is the value it has to be
 * born with" — stays true of that statement and of every lazy draft it writes: a page becomes
 * public because somebody pressed publish. A registration carrying a claim token is the same story
 * and passes null, since what she agreed to there was a profile at one salon. A TOKENLESS
 * registration is the one case where it is not: the consent copy on dang-nhap-nhan-vien.html
 * describes that public page and nothing else, so agreeing to it IS the act of publishing, and the
 * date it happened is written here rather than waiting for a second press that would mean nothing.
 */
export async function createStaffProfile(tx, userId, name, publishedAt) {
  /* Where this parts company with ensureStaffProfile above, which catches the unique violation and
     retries with a fresh suffix. That cannot be done in here: a failed statement aborts the whole
     Postgres transaction it sat in, so the second attempt would run on a connection that can do
     nothing but roll back — and it would take the account down with it. So the retry happens BEFORE
     the INSERT — pick a slug, ask whether anybody holds it, write when it is free — and the last of
     the SLUG_ATTEMPTS goes in unasked, letting the unique index have the final word. That raises
     exactly the error the function above rethrows on its own last attempt, rather than inventing a
     second kind of failure for the same collision. */
  let slug = makeSlug(name);
  for (let attempt = 1; attempt < SLUG_ATTEMPTS; attempt += 1) {
    if (!(await tx.get(SELECT_SLUG_TAKEN, slug))) {
      break;
    }
    slug = makeSlug(name);
  }

  await tx.run(INSERT_NEW_PROFILE, userId, slug, publishedAt, new Date().toISOString());
  return slug;
}
