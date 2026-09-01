// Public promotions: the one offer OAK runs, a salon's own percentage code.
import express from 'express';
import { db } from '../db.js';
import { todayISO } from '../lib/time.js';

const router = express.Router();

// starts_at/ends_at are 'YYYY-MM-DD', so a plain string comparison is a date comparison.
//
// Two gates beyond the window, and both of them decide what an offer IS rather than merely
// where it shows:
//
//   type = 'discount'   The column still allows 'combo' and 'flash_sale', and a database
//                       that ran before this may still hold rows carrying them. Nothing
//                       creates one any more and the till refuses one, so listing one would
//                       advertise a code that cannot be spent. They are dead, not deleted.
//   s.published = 1     A salon's offer is listed only once the salon itself is. A partner
//                       sign-up creates the salon — and, if the owner asked for it, its
//                       welcome code — before anyone has seen either, and salons.published
//                       defaults to 0; without this an unlisted draft would put its name
//                       here the moment the account was made. The join is inner for the
//                       same reason the type gate exists: every offer belongs to a salon
//                       now, so a row with no salon behind it is not one to advertise.
const selectActivePromotions = db.prepare(`
  SELECT p.id, p.code, p.title, p.description, p.discount_percent, p.discount_amount,
         p.image, p.starts_at, p.ends_at, s.name AS salon_name, s.slug AS salon_slug
  FROM promotions p
  JOIN salons s ON s.id = p.salon_id
  WHERE p.active = 1 AND p.type = 'discount' AND p.starts_at <= ? AND p.ends_at >= ?
    AND s.published = 1
  ORDER BY p.id
`);

router.get('/', async (req, res, next) => {
  try {
    const today = todayISO();
    const rows = await selectActivePromotions.all(today, today);

    // discount_amount rides along read-only: the console can no longer write one, but an
    // offer created before that still promises what it promises, and the cards say so.
    const data = rows.map((row) => ({
      id: row.id,
      code: row.code,
      title: row.title,
      description: row.description,
      discount_percent: row.discount_percent,
      discount_amount: row.discount_amount,
      image: row.image,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
      salon: { name: row.salon_name, slug: row.salon_slug },
    }));

    res.json({ success: true, data, meta: { total: data.length } });
  } catch (error) {
    next(error);
  }
});

export default router;
