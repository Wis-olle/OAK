/*
 * Whether a salon is 'Nổi bật' today.
 *
 * The answer is never stored: salons.featured_until holds the day the placement runs out,
 * and everything else is that date read against today. A stored flag would need a sweep to
 * turn it off and would go on ranking a salon whose month ended while the sweep was down —
 * a paid placement that outlives what was paid for is the one failure this must not have.
 *
 * Exclusive on purpose, in both halves: featured_until is the first day the salon is NOT
 * featured, so "pinned through Friday" is stored as Saturday and the two ends of a pin can
 * be written as one date each. NULL is the ordinary state and is never featured.
 */

import { todayISO } from './time.js';

/**
 * The same comparison as SQL, for a query that has to filter or order by it. The date comes
 * from Postgres rather than from a bound parameter so that no caller can forget to pass it;
 * the zone is the one lib/time.js reads "now" in, because a placement bought in Vietnam ends
 * at midnight there and not seven hours later.
 *
 * COALESCE because the answer is used as an ORDER BY key as well as a filter, and a bare
 * `NULL > date` is NULL rather than false: Postgres sorts NULLs first on DESC, so without
 * it every salon that has never been pinned would outrank the one that just was.
 *
 * Assumes the caller aliased salons as `s`, the way lib/cards.js does.
 */
export const IS_FEATURED_SQL =
  "(COALESCE(s.featured_until, '') > to_char(now() AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD'))";

/** True while `featuredUntil` ('YYYY-MM-DD', or null) is still ahead of today. */
export function isFeatured(featuredUntil) {
  return typeof featuredUntil === 'string' && featuredUntil > todayISO();
}
