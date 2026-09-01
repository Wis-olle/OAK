/*
 * The salon and service card shapes, defined once so /api/salons, /api/services,
 * /api/search and /api/favorites cannot drift apart.
 *
 * The COLUMNS constants are SELECT-list fragments, not whole queries: they assume the
 * caller aliased salons as `s` and services as `sv`. They contain no user input.
 */

import { isFeatured } from './featured.js';
import { parseJsonArray } from './query.js';

/* auto_confirm rides along on the card, and it is the cheapest column here — a plain integer
   beside three correlated subqueries. It has to: every page on the booking path tells the
   reader what happens after they press the button, and until it was carried they all said the
   forgiving half of it ("you will be told when the salon confirms") because they had no way to
   know that for a salon with auto_confirm on the confirming has already happened. The wizard
   in particular reads its salon three different ways — a card off this list, a service's
   nested salon, or the detail — so a flag on only one of them would be a sentence that changed
   depending on which door the reader came through. */
export const SALON_CARD_COLUMNS = `
  s.id, s.slug, s.name, s.address, s.district, s.city, s.image, s.verified, s.tags, s.lat, s.lng,
  s.auto_confirm,
  s.featured_until,
  (SELECT ROUND(AVG(r.rating), 1) FROM reviews r WHERE r.salon_id = s.id) AS rating,
  (SELECT COUNT(*) FROM reviews r WHERE r.salon_id = s.id) AS review_count,
  (SELECT MIN(sv.price) FROM services sv
     WHERE sv.salon_id = s.id AND sv.active = 1 AND sv.category <> 'amenity') AS price_from
`;

export function toSalonCard(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    address: row.address,
    district: row.district,
    city: row.city,
    image: row.image,
    verified: Boolean(row.verified),
    // The column is born 1 and older rows may hold null; anything that is not a 1 is a salon
    // that confirms by hand, which is the half of the pair a page is safe to promise.
    auto_confirm: row.auto_confirm === 1,
    // Computed rather than stored, and computed here so every surface that draws a card
    // draws the same chip: see lib/featured.js. The date itself stays off the card — a
    // customer is being told this salon is featured, not until when it has been paid for.
    featured: isFeatured(row.featured_until),
    tags: parseJsonArray(row.tags),
    rating: row.rating ?? 0,
    review_count: row.review_count ?? 0,
    price_from: row.price_from ?? null,
    lat: row.lat,
    lng: row.lng,
  };
}

// cancel_cutoff_hours/cancel_policy_text ride along on the card because every page that
// shows a service also shows "hủy miễn phí trước N tiếng", and a platform-wide 2 would be
// the wrong promise for a salon that asks for 24.
export const SERVICE_CARD_COLUMNS = `
  sv.id, sv.name, sv.description, sv.price, sv.price_is_from, sv.duration_min, sv.image,
  sv.category, sv.subcategory,
  s.id AS salon_id, s.slug AS salon_slug, s.name AS salon_name, s.district AS salon_district,
  s.cancel_cutoff_hours AS salon_cancel_cutoff_hours,
  s.cancel_policy_text AS salon_cancel_policy_text,
  s.auto_confirm AS salon_auto_confirm
`;

export function toServiceCard(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    price: row.price,
    price_is_from: Boolean(row.price_is_from),
    duration_min: row.duration_min,
    image: row.image,
    category: row.category,
    subcategory: row.subcategory,
    salon: {
      id: row.salon_id,
      slug: row.salon_slug,
      name: row.salon_name,
      district: row.salon_district,
      cancel_cutoff_hours: row.salon_cancel_cutoff_hours,
      cancel_policy_text: row.salon_cancel_policy_text,
      auto_confirm: row.salon_auto_confirm === 1,
    },
  };
}
