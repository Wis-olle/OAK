/*
 * A career: every stint one person has held on OAK, and the shape a page renders one in.
 *
 * Lifted out of routes/staff.js because two endpoints now serve it — the stint page's
 * /api/staff/:id/history, which resolves the person through the row that was asked for, and
 * the person's own page in routes/technicians.js, which has the person to begin with. The
 * query was already keyed by user id; what moved is where it lives, so the two cannot drift
 * into two answers about the same working life.
 */
import { db } from '../db.js';
import { staffStats, VISIBLE_PROFILE } from './staff-stats.js';

/* Gated on the withdrawal alone, and on nothing about the roster: a stint that ended is
 * exactly what a career is made of, and the row it is being asked about may itself be a
 * closed one — a technician between salons has no open row anywhere, and answering with
 * nothing would delete her working life the day she left. A chair the salon has retired is
 * one line of a career that stays true. The withdrawal is honoured as it is on the profile:
 * a stint whose page is down is left out of the list rather than reappearing inside another
 * one.
 *
 * By staff id in DESCENDING order, which is the order the stints were opened, newest first:
 * a row is opened when somebody joins a salon, so the ids ARE the sequence. Sorting by
 * started_at instead would sort by a column that is empty on most rows and puts a stint the
 * salon back-dated above the one the technician is working today.
 */
export const selectStaffStints = db.prepare(`
  SELECT st.id, st.user_id, st.active, st.started_at, st.left_at, st.left_by,
         st.started_confirmed_at, st.left_confirmed_at, st.tenure_disputed,
         s.id AS salon_id, s.slug AS salon_slug, s.name AS salon_name
  FROM staff st
  JOIN salons s ON s.id = st.salon_id
  WHERE st.user_id = ? AND ${VISIBLE_PROFILE}
  ORDER BY st.id DESC
`);

/** One stint, in the shape the CV renders: where, when, and what is behind it. */
export async function stintShape(row) {
  const stats = await staffStats(row.id);
  return {
    staff_id: row.id,
    salon: { id: row.salon_id, slug: row.salon_slug, name: row.salon_name },
    started_at: stats.started_at,
    left_at: row.left_at,
    left_by: row.left_by,
    started_confirmed: Boolean(row.started_confirmed_at),
    left_confirmed: Boolean(row.left_confirmed_at),
    tenure_disputed: row.tenure_disputed ?? 0,
    // Open stints only, and both halves of it: a row is open while it carries no leaving date
    // AND is still on the roster, which is the pairing idx_staff_user_salon rests on.
    is_current: row.left_at === null && row.active === 1,
    // The badge rule, decided in lib/staff-stats.js so this page and the console cannot come
    // to different conclusions about the same two columns.
    tenure_verified: stats.tenure_verified,
    verified_count: stats.verified_count,
    review_count: stats.review_count,
    rating_avg: stats.rating_avg,
  };
}

/** Every stint behind one person, newest first, in the shape both pages render. */
export async function careerOf(userId) {
  const career = [];
  for (const stint of await selectStaffStints.all(userId)) {
    career.push(await stintShape(stint));
  }
  return career;
}
