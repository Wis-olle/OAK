// Customer favourites: salons and services.
import express from 'express';
import { db } from '../db.js';
import {
  SALON_CARD_COLUMNS,
  SERVICE_CARD_COLUMNS,
  toSalonCard,
  toServiceCard,
} from '../lib/cards.js';
import { httpError, requireAuth } from '../middleware/auth.js';

const router = express.Router();

// A favourite only means anything in the context of one account.
router.use(requireAuth);

// The publish switch, the same one every public listing reads. A favourite is the longest-
// lived link a customer holds — it outlasts a search result and a browser history — so a
// salon that has taken itself off OAK would otherwise keep a card in somebody's saved list
// leading to a page and a booking form that no longer answer.
const LISTED_SALON = 's.published = 1 AND s.verified = 1';
const selectFavoriteSalons = db.prepare(`
  SELECT ${SALON_CARD_COLUMNS}
  FROM favorites f
  JOIN salons s ON s.id = f.salon_id
  WHERE f.user_id = ? AND ${LISTED_SALON}
  ORDER BY f.id DESC
`);
// A service the salon has hidden ("Tạm ẩn dịch vụ") is gone from every customer-facing
// listing, so it must drop out of the favourites list too — the row itself is kept, and
// comes back if the salon un-hides the service. Its salon's own switch reads the same way.
const selectFavoriteServices = db.prepare(`
  SELECT ${SERVICE_CARD_COLUMNS}
  FROM favorites f
  JOIN services sv ON sv.id = f.service_id
  JOIN salons s ON s.id = sv.salon_id
  WHERE f.user_id = ? AND sv.active = 1 AND ${LISTED_SALON}
  ORDER BY f.id DESC
`);
// Same 404 a missing salon gets: an unlisted one does not exist for a customer, and a heart
// that could be pressed on it would save a card the list above then refuses to serve back.
const selectSalon = db.prepare(`SELECT 1 FROM salons s WHERE s.id = ? AND ${LISTED_SALON}`);
// Same 404 the public service endpoints give: a hidden service does not exist for a customer,
// and neither does one whose salon is not on OAK — the list above serves back neither.
const selectService = db.prepare(`
  SELECT 1 FROM services sv JOIN salons s ON s.id = sv.salon_id
  WHERE sv.id = ? AND sv.active = 1 AND ${LISTED_SALON}
`);
const selectFavoriteSalon = db.prepare(
  'SELECT id FROM favorites WHERE user_id = ? AND salon_id = ?',
);
const selectFavoriteService = db.prepare(
  'SELECT id FROM favorites WHERE user_id = ? AND service_id = ?',
);
const insertFavorite = db.prepare(
  'INSERT INTO favorites (user_id, salon_id, service_id, created_at) VALUES (?, ?, ?, ?)',
);
const deleteFavoriteSalon = db.prepare('DELETE FROM favorites WHERE user_id = ? AND salon_id = ?');
const deleteFavoriteService = db.prepare(
  'DELETE FROM favorites WHERE user_id = ? AND service_id = ?',
);

/**
 * One favourite row points at a salon or a service, never both and never neither.
 * The table CHECKs the same rule; this is the first line of defence, so a bad request
 * gets a 400 with a Vietnamese message instead of a constraint failure.
 */
function parseTarget(source) {
  const hasSalon = source.salon_id != null && source.salon_id !== '';
  const hasService = source.service_id != null && source.service_id !== '';
  if (hasSalon === hasService) {
    throw httpError(400, 'VALIDATION_ERROR', 'Vui lòng chọn một salon hoặc một dịch vụ.');
  }

  const id = Number.parseInt(hasSalon ? source.salon_id : source.service_id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw httpError(400, 'VALIDATION_ERROR', 'Mã salon hoặc dịch vụ không hợp lệ.');
  }
  return { isSalon: hasSalon, id };
}

router.get('/', async (req, res, next) => {
  try {
    res.json({
      success: true,
      data: {
        salons: (await selectFavoriteSalons.all(req.user.id)).map(toSalonCard),
        services: (await selectFavoriteServices.all(req.user.id)).map(toServiceCard),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { isSalon, id } = parseTarget(req.body ?? {});

    const exists = isSalon ? await selectSalon.get(id) : await selectService.get(id);
    if (!exists) {
      throw httpError(404, 'NOT_FOUND', 'Không tìm thấy salon hoặc dịch vụ.');
    }

    // Idempotent: tapping the heart twice is a UI race, not a client error, so an
    // existing row is reported as success instead of a UNIQUE constraint failure.
    const existing = isSalon
      ? await selectFavoriteSalon.get(req.user.id, id)
      : await selectFavoriteService.get(req.user.id, id);
    if (!existing) {
      try {
        await insertFavorite.run(
          req.user.id,
          isSalon ? id : null,
          isSalon ? null : id,
          new Date().toISOString(),
        );
      } catch (error) {
        // Two identical taps raced past the check above: the row exists, which is
        // exactly the state the client asked for — success, like the pre-check path.
        const duplicate =
          error.code === '23505' &&
          (error.constraint === 'favorites_user_id_salon_id_key' ||
            error.constraint === 'favorites_user_id_service_id_key');
        if (!duplicate) {
          throw error;
        }
      }
    }

    res.json({ success: true, data: { ok: true } });
  } catch (error) {
    next(error);
  }
});

router.delete('/', async (req, res, next) => {
  try {
    const { isSalon, id } = parseTarget(req.query);

    // Also idempotent: removing something already gone leaves the client in the state it
    // asked for, so a zero-row delete is still a success.
    if (isSalon) {
      await deleteFavoriteSalon.run(req.user.id, id);
    } else {
      await deleteFavoriteService.run(req.user.id, id);
    }

    res.json({ success: true, data: { ok: true } });
  } catch (error) {
    next(error);
  }
});

export default router;
