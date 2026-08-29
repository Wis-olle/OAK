// A technician's own page, addressed by the person rather than by a chair: public, no auth.
import express from 'express';
import { db } from '../db.js';
import { parseJsonArray } from '../lib/query.js';
import { careerOf } from '../lib/staff-career.js';
import { userStats } from '../lib/staff-stats.js';
import { httpError } from '../middleware/auth.js';

const router = express.Router();

/*
 * The gate, and every clause in it is load-bearing.
 *
 * published_at IS NOT NULL is the consent: a draft is not a page, and an address that answered
 * before she pressed publish would make the editor a live broadcast. hidden = 0 is the
 * withdrawal, and it takes the page down at its own address the way it takes her words off
 * every stint page. u.deleted_at IS NULL is belt and braces — erasing an account DELETEs this
 * row inside the same transaction (routes/users.js), so the slug is freed rather than
 * anonymised — but an erasure that ever stopped short of the delete must not leave a page
 * standing under a name nobody answers for any more.
 *
 * user_id is selected and never serialized. It is how the two reads below are keyed, and it is
 * the one thing a public person page may not carry: a slug is deliberately unguessable so that
 * no one can walk the accounts, and handing the account id back beside it would give away for
 * free exactly what the suffix was minted to protect.
 */
const selectPublishedProfile = db.prepare(`
  SELECT sp.user_id, sp.slug, sp.title, sp.specialty, sp.bio, sp.image, sp.portfolio,
         sp.years_experience, u.name
  FROM staff_profiles sp
  JOIN users u ON u.id = sp.user_id
  WHERE sp.slug = ? AND sp.published_at IS NOT NULL AND COALESCE(sp.hidden, 0) = 0
    AND u.deleted_at IS NULL
`);

/*
 * Four situations, one answer. A slug that names nobody, a page never published, a page taken
 * back down, and an account erased all read the same from out here — and they have to, because
 * a reply that told them apart would put a withdrawn page back up in the negative: "this used
 * to be somebody" is still an answer about her. Same words the stint page refuses an unknown
 * id in, for the same reason.
 */
router.get('/:slug', async (req, res, next) => {
  try {
    const row = await selectPublishedProfile.get(req.params.slug);
    if (!row) {
      throw httpError(404, 'NOT_FOUND', 'Không tìm thấy kỹ thuật viên này.');
    }

    res.json({
      success: true,
      data: {
        // Her name off the account, and then six fields she wrote herself. The salon's words
        // about a job — the title and speciality an owner typed onto a roster row — are not
        // in here at all: this page speaks in one voice, and the career list below is where
        // the salons get to speak.
        slug: row.slug,
        name: row.name,
        title: row.title,
        specialty: row.specialty,
        bio: row.bio,
        image: row.image,
        portfolio: parseJsonArray(row.portfolio),
        years_experience: row.years_experience,
        // The other half, and the one she did not write: where she has worked, with the dates
        // both sides confirmed and what OAK counted at each. Stints whose pages she has taken
        // down are absent — a withdrawn page may not resurface as a line inside another one —
        // and `is_current` on these entries is what the page builds its booking links out of,
        // so a chair she has left can never be offered for sale from here.
        career: await careerOf(row.user_id),
        // Counted across exactly those same stints. See userStats: one query rather than a
        // sum, so a customer who followed her between salons counts once.
        stats: await userStats(row.user_id),
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
