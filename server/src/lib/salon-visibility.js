/*
 * Who may read a salon that is not on OAK.
 *
 * `published` is the switch a salon signs up behind: it is unlisted until its owner has
 * given it an address, a week, a service and a picture and turned it on. The listing, the
 * search and the map have always honoured that switch. The salon's own profile route did
 * not — it was left open to anyone holding the link so that the console's "xem trước" could
 * be a plain page load — and "anyone holding the link" is a slug built out of the salon's
 * name, which is guessable, and which the console's own copy promised only the owner could
 * open. A half-built profile, its price list and its roster were readable by anybody who
 * tried the name.
 *
 * So the answer is the same everywhere now: a draft is the owner's page and nobody else's,
 * and the preview keeps working because the owner arrives carrying their own cookie. Every
 * public read of a salon, its photos, its menu, its roster, its reviews, one of its
 * services and one of its chairs asks this before it answers.
 *
 * sessionUser rather than requireAuth: these are public routes and a stranger is allowed
 * there — a stranger simply does not get a draft.
 */
import { sessionUser } from '../middleware/auth.js';

/** True when a salon in this state may be shown to whoever sent `req`. */
export async function salonVisibleTo(req, published, ownerId) {
  if (Number(published) === 1) {
    return true;
  }
  const user = await sessionUser(req);
  return user !== null && user.id === ownerId;
}
