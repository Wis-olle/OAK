// Public promotions: platform-wide and per-salon offers.
import express from 'express';
import { db } from '../db.js';
import { parseJsonArray } from '../lib/query.js';
import { todayISO } from '../lib/time.js';

const router = express.Router();

// starts_at/ends_at are 'YYYY-MM-DD', so a plain string comparison is a date comparison.
// Platform-wide offers (salon_id IS NULL) are listed first.
//
// A salon's offer is listed only once the salon itself is: salons.published defaults to 0
// and a partner sign-up creates the salon — and now its welcome offer — before anyone has
// seen either, so without this gate an unlisted draft would advertise its name here the
// moment the account was made. The same gate covers an offer a salon writes in the console
// while its profile is still unpublished.
const selectActivePromotions = db.prepare(`
  SELECT p.id, p.code, p.type, p.title, p.description, p.discount_percent, p.discount_amount,
         p.original_price, p.sale_price, p.service_ids, p.image, p.starts_at, p.ends_at,
         s.name AS salon_name, s.slug AS salon_slug
  FROM promotions p
  LEFT JOIN salons s ON s.id = p.salon_id
  WHERE p.active = 1 AND p.starts_at <= ? AND p.ends_at >= ?
    AND (p.salon_id IS NULL OR s.published = 1)
  ORDER BY (p.salon_id IS NULL) DESC, p.id
`);

// Hidden services drop out entirely: the id is a deep link into the wizard, so an offer
// must never advertise a bookable price for a service the salon has taken off the menu.
const selectServiceName = db.prepare('SELECT name FROM services WHERE id = ? AND active = 1');

/**
 * The services an offer points at: their ids, because a combo's id is the deep link that
 * books it at the combo price, and their names, because that is what a card can show.
 */
async function resolveServices(serviceIds) {
  const services = [];
  for (const id of parseJsonArray(serviceIds).filter((value) => Number.isInteger(value))) {
    const name = (await selectServiceName.get(id))?.name;
    if (name !== undefined) {
      services.push({ id, name });
    }
  }
  return services;
}

router.get('/', async (req, res, next) => {
  try {
    const today = todayISO();
    const rows = await selectActivePromotions.all(today, today);

    const data = [];
    for (const row of rows) {
      const services = await resolveServices(row.service_ids);
      data.push({
        id: row.id,
        code: row.code,
        type: row.type,
        title: row.title,
        description: row.description,
        discount_percent: row.discount_percent,
        discount_amount: row.discount_amount,
        original_price: row.original_price,
        sale_price: row.sale_price,
        service_ids: services.map((service) => service.id),
        service_names: services.map((service) => service.name),
        image: row.image,
        starts_at: row.starts_at,
        ends_at: row.ends_at,
        salon: row.salon_slug ? { name: row.salon_name, slug: row.salon_slug } : null,
      });
    }

    res.json({ success: true, data, meta: { total: data.length } });
  } catch (error) {
    next(error);
  }
});

export default router;
