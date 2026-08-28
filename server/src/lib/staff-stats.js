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
 *                                             the salon.
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
const selectStaffTiers = db.prepare(`
  WITH tiered AS (
    SELECT b.user_id,
           CASE
             WHEN b.auto_closed = 1 THEN 'unattested'
             WHEN b.source = 'customer' AND s.published = 1 THEN 'verified'
             WHEN b.source = 'customer' THEN 'unattested'
             WHEN b.source = 'partner' THEN 'walkin'
             ELSE 'legacy'
           END AS tier
    FROM bookings b
    LEFT JOIN salons s ON s.id = b.salon_id
    WHERE b.staff_id = ? AND b.status = 'completed'
  )
  SELECT COUNT(*) FILTER (WHERE tier = 'verified') AS verified_count,
         COUNT(*) FILTER (WHERE tier = 'walkin') AS walkin_count,
         COUNT(*) FILTER (WHERE tier = 'unattested') AS unattested_count,
         COUNT(*) FILTER (WHERE tier = 'legacy') AS legacy_count,
         COUNT(DISTINCT user_id) FILTER (WHERE tier = 'verified') AS distinct_customers
  FROM tiered
`);

/* Computed live, and deliberately the same expression staff.rating caches, so an endpoint
   serving both says whether the cache has drifted rather than hiding it. AVG over no
   reviews is NULL and 0 is what "nobody has rated this person yet" is spelled as
   everywhere else on the platform — see the rating column's default. */
const selectStaffReviewStats = db.prepare(`
  SELECT COUNT(*) AS review_count, COALESCE(ROUND(AVG(rating), 1), 0) AS rating_avg
  FROM reviews WHERE staff_id = ?
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

const selectStaffStart = db.prepare('SELECT started_at FROM staff WHERE id = ?');

/**
 * Whole calendar months from `startedAt` to `today`, floored — the figure a profile shows
 * as "N tháng tại OAK". Null when there is no start date: a roster row with no bookings
 * behind it has nothing to count from, and inventing one is worse than saying nothing.
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
  const startedAt = (await selectStaffStart.get(staffId))?.started_at ?? null;

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
  };
}
