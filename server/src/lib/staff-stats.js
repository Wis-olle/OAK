/*
 * The numbers a technician's profile stands on, in the one place they are computed.
 *
 * Both the public profile (routes/staff.js) and the technician's own reading of it
 * (routes/staff-me.js) serve this block, from here rather than from a copy each: two
 * spellings of this query is exactly how the page a customer reads and the page the
 * technician reads would come to disagree about the same person.
 *
 * A number is "verified" only where two independent parties attested to it. Everything
 * else is still counted and still shown — a walk-in is real work — but under its own name,
 * never folded into the verified figure.
 */
import { db } from '../db.js';
import { todayISO } from './time.js';

const MONTHS_PER_YEAR = 12;

/* The technician's withdrawal, in the one clause every page-shaped read of a roster row is
   gated on. COALESCE because the column was added to a table that already had rows, so an
   unwritten one is 0 rather than a reason to disappear; user_id IS NULL because a row nobody
   stands behind has nobody to have withdrawn it — the predicate is "claimed AND hidden"
   everywhere it appears, and a bare hidden test would let a stray column value take a salon's
   own roster entry off the site.

   It lives here rather than in routes/staff.js because three files now ask it: the stint page
   and its review list, the career list in lib/staff-career.js, and the cross-stint figures
   below. A withdrawal spelled two ways is a withdrawal that holds on one surface and not on
   the next, which is the one failure this feature cannot have. */
export const VISIBLE_PROFILE = '(st.user_id IS NULL OR COALESCE(st.profile_hidden, 0) = 0)';

/*
 * Every completed booking on a roster row falls into exactly one tier, decided by a strict
 * precedence chain rather than by four independent tests. The plain readings overlap — a
 * walk-in and a legacy row can both be auto_closed — and four counts that overlap do not
 * add up to anything.
 *
 *   1. auto_closed = 1                        unattested. The calendar closed this, nobody
 *                                             confirmed it happened. Wins over everything.
 *   2. source = 'customer', salon published   verified. Two independent parties: the
 *                                             customer who booked it, and a salon that is
 *                                             publicly listed and answerable for it.
 *   3. source = 'customer', salon unpublished unattested. An unlisted salon is not an
 *                                             independent party — a free partner sign-up
 *                                             creates one — so a sock-puppet salon's
 *                                             "customers" carry exactly the weight of a
 *                                             calendar sweep.
 *   4. source = 'partner'                     walkin. The salon says it happened, and only
 *                                             the salon. Promoting one the customer later
 *                                             reviewed was considered and deliberately not
 *                                             done: a tier is the channel a booking came in
 *                                             by, and the review is already on the profile
 *                                             as rating_avg and review_count.
 *   5. source IS NULL                         legacy. Written before the column existed;
 *                                             provenance unknown and never guessed at.
 *
 * Non-overlapping and total, so the four counts always sum to the completed total — which
 * is what makes the partition safe to show a customer. A staff row belongs to exactly one
 * salon, so the published gate is constant across a technician's bookings; it is joined per
 * row all the same, because that is where the fact lives. LEFT, so that totality is a
 * property of the query rather than of a convention: bookings.salon_id is nullable, and a
 * row that fell out of an inner join would vanish from all four counts and leave the
 * profile showing a customer arithmetic that does not close. A missing salon is not a
 * published one, so it lands in unattested, which is the safe side of the question.
 */
const TIER_CASE = `
    CASE
      WHEN b.auto_closed = 1 THEN 'unattested'
      WHEN b.source = 'customer' AND s.published = 1 THEN 'verified'
      WHEN b.source = 'customer' THEN 'unattested'
      WHEN b.source = 'partner' THEN 'walkin'
      ELSE 'legacy'
    END AS tier`;

/* The four counts the partition yields, written once because two readers now ask for them:
   one roster row, and one person across every row she still shows. A second spelling is how
   a career page and the stint pages inside it would come to disagree about the same work. */
const TIER_COUNTS = `
  SELECT COUNT(*) FILTER (WHERE tier = 'verified') AS verified_count,
         COUNT(*) FILTER (WHERE tier = 'walkin') AS walkin_count,
         COUNT(*) FILTER (WHERE tier = 'unattested') AS unattested_count,
         COUNT(*) FILTER (WHERE tier = 'legacy') AS legacy_count,
         COUNT(DISTINCT user_id) FILTER (WHERE tier = 'verified') AS distinct_customers
  FROM tiered`;

const selectStaffTiers = db.prepare(`
  WITH tiered AS (
    SELECT b.user_id, ${TIER_CASE}
    FROM bookings b
    LEFT JOIN salons s ON s.id = b.salon_id
    WHERE b.staff_id = ? AND b.status = 'completed'
  )
  ${TIER_COUNTS}
`);

/*
 * The same partition asked about a PERSON: every completed booking on every roster row she
 * still shows, in one query rather than a sum over the stints.
 *
 * One query and not a fold, for distinct_customers. A customer who followed a technician from
 * one salon to the next is one customer, and adding the per-row figures up would count her
 * twice — inflating exactly the number the career page tells a reader to trust, and inflating
 * it most for the technicians who have moved most. COUNT(DISTINCT b.user_id) over the whole
 * career is the only place that question can be answered.
 *
 * Restricted to the stints the career list SHOWS, by the same VISIBLE_PROFILE the list is
 * gated on: a stint whose page the technician has taken down must not walk back onto the site
 * inside an aggregate. The join is the restriction — a row that fails it contributes no
 * bookings at all — so the counts and the list can never describe different sets of work.
 */
const selectUserTiers = db.prepare(`
  WITH tiered AS (
    SELECT b.user_id, ${TIER_CASE}
    FROM bookings b
    JOIN staff st ON st.id = b.staff_id
    LEFT JOIN salons s ON s.id = b.salon_id
    WHERE st.user_id = ? AND ${VISIBLE_PROFILE} AND b.status = 'completed'
  )
  ${TIER_COUNTS}
`);

/* Computed live, and deliberately the same expression staff.rating caches, so an endpoint
   serving both says whether the cache has drifted rather than hiding it. AVG over no
   reviews is NULL and 0 is what "nobody has rated this person yet" is spelled as
   everywhere else on the platform — see the rating column's default. */
const selectStaffReviewStats = db.prepare(`
  SELECT COUNT(*) AS review_count, COALESCE(ROUND(AVG(rating), 1), 0) AS rating_avg
  FROM reviews WHERE staff_id = ?
`);

/* Every review of every stint the person still shows, averaged once over all of them rather
   than averaged per stint and averaged again — a mean of means weights a two-review stint the
   same as a two-hundred-review one. Gated on the same withdrawal as the counts above it. */
const selectUserReviewStats = db.prepare(`
  SELECT COUNT(*) AS review_count, COALESCE(ROUND(AVG(r.rating), 1), 0) AS rating_avg
  FROM reviews r
  JOIN staff st ON st.id = r.staff_id
  WHERE st.user_id = ? AND ${VISIBLE_PROFILE}
`);

/* The write side of that same average, kept in this file so the cache and the live figure
   are one expression rather than two that agree for now. Run inside the transaction of
   whatever moved a review — routes/reviews.js when one is written or edited,
   routes/partner.js when a reassignment carries one onto another roster row — because a
   review that landed while the figure beside it did not would leave a profile stating a
   number its own review list contradicts, and nothing afterwards would put the two back
   together. COALESCE because a technician's last review can be edited or carried away but
   not deleted, and 0 is how "nobody has rated this person yet" is spelled in that column. */
export const RECOMPUTE_STAFF_RATING = `
  UPDATE staff
  SET rating = COALESCE((SELECT ROUND(AVG(rating), 1) FROM reviews WHERE staff_id = ?), 0)
  WHERE id = ?
`;

/* The date a profile counts from: the roster row's first completed visit, unless the salon
   owner has entered one, in which case that is the answer. The column wins wherever it is
   set — it is the salon's own statement, and the technician confirms it from their own page —
   and where it is empty the figure is derived on every read rather than frozen at whatever a
   sweep once wrote. Completed only: a cancelled visit is not a day anybody worked, and a
   booking still in the future is not a day anybody has worked yet. A row with neither reads
   NULL, and the profile says nothing rather than naming a month it cannot know.

   The stint's own columns ride along, because tenureVerified below is asked about the same
   row on the same read: a page showing a date and a page deciding whether that date is
   attested to must not be able to disagree by a query. */
const selectStaffStart = db.prepare(`
  SELECT COALESCE(
           st.started_at,
           (SELECT MIN(b.date) FROM bookings b WHERE b.staff_id = st.id AND b.status = 'completed')
         ) AS effective_started_at,
         st.started_at, st.left_at, st.started_confirmed_at, st.left_confirmed_at,
         st.tenure_disputed
  FROM staff st WHERE st.id = ?
`);

/**
 * The ✓ a profile puts beside a date, decided here and nowhere else.
 *
 * Three things, all of them: the date exists, the person on the other side of it stamped
 * their confirmation, and nobody is disputing the stint. A derived start date can never earn
 * one — st.started_at is the raw column, not the COALESCE above — because what a technician
 * confirmed is a date the salon entered, and the earliest completed booking is nobody's
 * statement about anything.
 *
 * The dispute flag is one flag over both dates, and it clears both: somebody who says the
 * dates on their stint are wrong is not making a claim this platform can partly believe.
 */
export function tenureVerified(row) {
  const disputed = Number(row?.tenure_disputed ?? 0) === 1;
  return {
    started: Boolean(row?.started_at) && Boolean(row?.started_confirmed_at) && !disputed,
    left: Boolean(row?.left_at) && Boolean(row?.left_confirmed_at) && !disputed,
  };
}

/**
 * Whole calendar months from `startedAt` to `today`, floored — the figure a profile shows
 * as "N tháng tại OAK". Null when there is no start date: a roster row that has completed
 * nothing yet, and whose salon has entered no date of its own, has nothing to count from,
 * and inventing one is worse than saying nothing.
 */
export function monthsActive(startedAt, today) {
  if (!startedAt) {
    return null;
  }
  const [startYear, startMonth, startDay] = String(startedAt).split('-').map(Number);
  const [year, month, day] = String(today).split('-').map(Number);
  const months =
    (year - startYear) * MONTHS_PER_YEAR + (month - startMonth) - (day < startDay ? 1 : 0);
  return Math.max(0, months);
}

/** Every figure a profile shows for one roster row, in one shape both routes serve. */
export async function staffStats(staffId) {
  const tiers = await selectStaffTiers.get(staffId);
  const reviews = await selectStaffReviewStats.get(staffId);
  const tenure = await selectStaffStart.get(staffId);
  const startedAt = tenure?.effective_started_at ?? null;

  return {
    verified_count: tiers.verified_count,
    walkin_count: tiers.walkin_count,
    unattested_count: tiers.unattested_count,
    legacy_count: tiers.legacy_count,
    distinct_customers: tiers.distinct_customers,
    review_count: reviews.review_count,
    rating_avg: reviews.rating_avg,
    started_at: startedAt,
    months_active: monthsActive(startedAt, todayISO()),
    // Served from the same read the date came out of, so a page never has to ask a second
    // endpoint whether the date it is showing is attested to.
    tenure_verified: tenureVerified(tenure),
  };
}

/**
 * The same figures asked about one person rather than one chair: what a career adds up to.
 *
 * Deliberately shorter than staffStats by three keys, and none of the three is an oversight.
 * started_at, months_active and tenure_verified are statements about a STINT — a date a salon
 * entered and the technician confirmed, or the first completed visit on one row — and a career
 * has no single one of any of them. The earliest date across a person's stints would be a
 * number with no ✓ available to it: tenureVerified answers about a row, and there is no way to
 * put a mark on a minimum taken over several. The career list underneath the strip carries
 * every date there is, one per stint, each with its own mark. Naming a career-wide "since"
 * beside them would be the page's one unmarked date, which is the one thing this feature is
 * built not to print.
 */
export async function userStats(userId) {
  const tiers = await selectUserTiers.get(userId);
  const reviews = await selectUserReviewStats.get(userId);

  return {
    verified_count: tiers.verified_count,
    walkin_count: tiers.walkin_count,
    unattested_count: tiers.unattested_count,
    legacy_count: tiers.legacy_count,
    distinct_customers: tiers.distinct_customers,
    review_count: reviews.review_count,
    rating_avg: reviews.rating_avg,
  };
}
