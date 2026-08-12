// Public promotions: platform-wide and per-salon offers.
import express from 'express';
import { db } from '../db.js';
import { parseJsonArray } from '../lib/query.js';
import { todayISO } from '../lib/time.js';

const router = express.Router();

// starts_at/ends_at are 'YYYY-MM-DD', so a plain string comparison is a date comparison.
// Platform-wide offers (salon_id IS NULL) are listed first.
const selectActivePromotions = db.prepare(`
  SELECT p.id, p.code, p.type, p.title, p.description, p.discount_percent, p.discount_amount,
         p.original_price, p.sale_price, p.service_ids, p.image, p.starts_at, p.ends_at,
         s.name AS salon_name, s.slug AS salon_slug
  FROM promotions p
  LEFT JOIN salons s ON s.id = p.salon_id
  WHERE p.active = 1 AND p.starts_at <= ? AND p.ends_at >= ?
  ORDER BY (p.salon_id IS NULL) DESC, p.id
`);

const selectServiceName = db.prepare('SELECT name FROM services WHERE id = ?');

/** Combo offers bundle service ids; the list is only useful to a client as names. */
async function resolveServiceNames(serviceIds) {
  const names = [];
  for (const id of parseJsonArray(serviceIds).filter((value) => Number.isInteger(value))) {
    const name = (await selectServiceName.get(id))?.name;
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
}

router.get('/', async (req, res, next) => {
  try {
    const today = todayISO();
    const rows = await selectActivePromotions.all(today, today);

    const data = [];
    for (const row of rows) {
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
        service_names: await resolveServiceNames(row.service_ids),
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
