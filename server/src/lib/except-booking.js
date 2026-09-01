/*
 * `?except=<id>` on the two public availability endpoints.
 *
 * A customer moving an appointment reads the calendar with their own booking taken out of
 * it: the hour that booking sits on is about to be given back, so counting it as busy hides
 * exactly the hours a move is most likely to want — the half-hour beside their own visit,
 * an overlap with nobody but themselves. POST and PATCH already take the same exception on
 * the write side (lib/availability.js), and a grid that disagreed with the write would be
 * offering hours the server refuses, or hiding hours it would have taken.
 *
 * These endpoints are public, so the exception is a claim about a private row and is checked
 * as one: only a signed-in caller, only their own booking, and only one still standing. A
 * claim that fails any of those is IGNORED rather than refused — the answer is then exactly
 * the answer the same request without `?except` would have given, which is what keeps this
 * from becoming a way to ask whether a booking id exists.
 */
import { db } from '../db.js';
import { sessionUser } from '../middleware/auth.js';

const selectOwnLiveBooking = db.prepare(
  "SELECT 1 FROM bookings WHERE id = ? AND user_id = ? AND status IN ('pending', 'confirmed')",
);

/** The booking id `req` may read the calendar without, or null. */
export async function exceptBookingIdFor(req) {
  const id = Number.parseInt(req.query.except, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }
  // The cookie is only opened for a request that actually asks, so the public grid costs
  // no extra read on the requests — nearly all of them — that do not.
  const user = await sessionUser(req);
  if (!user) {
    return null;
  }
  return (await selectOwnLiveBooking.get(id, user.id)) ? id : null;
}
