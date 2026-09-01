/*
 * The operator's own door: the handful of things OAK does to the platform rather than for
 * one account. There is no admin page and deliberately none — everything here is done by
 * hand, a few times a month, with the curl commands DEPLOY.md §12 spells out. A console
 * nobody would open twice a week is a surface to keep secure for no gain.
 *
 * Two jobs, both groundwork for charging money: selling a 'Nổi bật' placement to a salon,
 * and telling everybody something — which is how the terms' promise of thirty days' notice
 * before any fee is actually kept.
 */
import express from 'express';
import { db } from '../db.js';
import { notifyUser } from '../lib/notify.js';
import { formatDateVN, isISODate } from '../lib/time.js';
import { httpError, requireAdmin, requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.use(requireAuth, requireAdmin);

/* How many bells one INSERT rings. An announcement to every customer is one statement per
   500 accounts rather than one per account, and the whole fan-out is one transaction: an
   announcement that reached half the platform and then failed cannot be sent again without
   ringing the first half twice. 500 keeps each statement's parameter array small enough to
   be unremarkable while making the round trips negligible at any size this platform reaches. */
const FANOUT_BATCH = 500;

const ANNOUNCEMENT_AUDIENCES = ['partner', 'customer', 'all'];
// What both notices below are filed under. 'system' is a type ui/thong-bao.html knows
// nothing about, which is exactly right: the row is read where it stands and there is no
// page to send the reader to.
const SYSTEM_NOTIFICATION_TYPE = 'system';
const TITLE_MAX = 120;
const BODY_MAX = 1000;

const selectSalons = db.prepare(`
  SELECT s.id, s.name, s.slug, u.email AS owner_email, s.published, s.featured_until
  FROM salons s
  LEFT JOIN users u ON u.id = s.owner_id
  ORDER BY s.id
`);

const selectSalonOwner = 'SELECT owner_id, name FROM salons WHERE id = ?';
const setFeaturedUntil = 'UPDATE salons SET featured_until = ? WHERE id = ?';

const INSERT_ANNOUNCEMENT =
  'INSERT INTO announcements (title, body, audience, created_by, created_at) VALUES (?, ?, ?, ?, ?)';
const selectAnnouncements = db.prepare(`
  SELECT a.id, a.title, a.body, a.audience, a.created_at, u.email AS created_by_email
  FROM announcements a
  LEFT JOIN users u ON u.id = a.created_by
  ORDER BY a.id DESC
`);

// Which role each audience means, and null for the audience that means everybody —
// technicians included, because a fee notice is about the platform and everybody standing
// on it is entitled to read it.
const AUDIENCE_ROLE = { partner: 'partner', customer: 'customer', all: null };

/** A trimmed string of at most `max` characters, or a 400 naming the field. */
function requireText(value, max, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '' || text.length > max) {
    throw httpError(400, 'VALIDATION_ERROR', `${field} phải là chuỗi từ 1 đến ${max} ký tự.`);
  }
  return text;
}

router.get('/salons', async (req, res, next) => {
  try {
    const rows = await selectSalons.all();
    res.json({ success: true, data: rows, meta: { total: rows.length } });
  } catch (error) {
    next(error);
  }
});

/*
 * Sell — or take back — a 'Nổi bật' placement. `until` is the day the pin runs out and is
 * exclusive (lib/featured.js): a pin sold "through the 30th" is stored as the 1st. null
 * takes it off, which is the same statement with a null, so a refund needs no second route.
 *
 * The owner is told when a pin is set and deliberately not when one is cleared: the salon
 * bought a placement and has to know it started and when it ends, while an operator undoing
 * their own typo would otherwise ring a bell about something that never happened. A pin that
 * simply expires rings nothing either — nothing runs on the day it does.
 */
router.patch('/salons/:id/featured', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      throw httpError(400, 'VALIDATION_ERROR', 'Mã salon không hợp lệ.');
    }
    const until = req.body?.until ?? null;
    if (until !== null && !isISODate(until)) {
      throw httpError(400, 'VALIDATION_ERROR', 'Ngày kết thúc phải có dạng YYYY-MM-DD.');
    }

    await db.withTransaction(async (tx) => {
      const salon = await tx.get(selectSalonOwner, id);
      if (!salon) {
        throw httpError(404, 'NOT_FOUND', 'Không tìm thấy salon này.');
      }
      await tx.run(setFeaturedUntil, until, id);
      if (until !== null) {
        await notifyUser(
          tx,
          salon.owner_id,
          'Salon của bạn được ghim Nổi bật',
          `Salon của bạn được ghim Nổi bật đến ngày ${formatDateVN(until)}. Trong thời gian này, ${salon.name} được xếp lên đầu danh sách và trang tìm kiếm.`,
          SYSTEM_NOTIFICATION_TYPE,
        );
      }
    });

    res.json({ success: true, data: { id, featured_until: until } });
  } catch (error) {
    next(error);
  }
});

router.get('/announcements', async (req, res, next) => {
  try {
    const rows = await selectAnnouncements.all();
    res.json({ success: true, data: rows, meta: { total: rows.length } });
  } catch (error) {
    next(error);
  }
});

/*
 * Say something to everybody, or to one side of the platform. This is the channel the terms
 * name: "OAK Beauty thông báo cho đối tác trước ít nhất 30 ngày" before charging for
 * anything, and an announcement to `partner` is how that notice is given.
 *
 * The row and every bell it rings are written together, so an announcement that is listed
 * here was delivered and one that failed was not delivered to anybody.
 */
router.post('/announcements', async (req, res, next) => {
  try {
    const title = requireText(req.body?.title, TITLE_MAX, 'Tiêu đề');
    const body = requireText(req.body?.body, BODY_MAX, 'Nội dung');
    const audience = req.body?.audience;
    if (!ANNOUNCEMENT_AUDIENCES.includes(audience)) {
      throw httpError(
        400,
        'VALIDATION_ERROR',
        `Đối tượng nhận phải là một trong: ${ANNOUNCEMENT_AUDIENCES.join(', ')}.`,
      );
    }

    const role = AUDIENCE_ROLE[audience];
    const createdAt = new Date().toISOString();
    const result = await db.withTransaction(async (tx) => {
      const { lastInsertRowid } = await tx.run(
        INSERT_ANNOUNCEMENT,
        title,
        body,
        audience,
        req.user.id,
        createdAt,
      );
      const recipients = role
        ? await tx.all('SELECT id FROM users WHERE role = ? ORDER BY id', role)
        : await tx.all('SELECT id FROM users ORDER BY id');
      for (let start = 0; start < recipients.length; start += FANOUT_BATCH) {
        const batch = recipients.slice(start, start + FANOUT_BATCH).map((row) => row.id);
        await tx.run(
          `INSERT INTO notifications (user_id, title, body, type, "read", created_at)
           SELECT id, ?, ?, ?, 0, ? FROM unnest(?::int[]) AS recipient(id)`,
          title,
          body,
          SYSTEM_NOTIFICATION_TYPE,
          createdAt,
          batch,
        );
      }
      return { id: Number(lastInsertRowid), notified: recipients.length };
    });

    res.json({
      success: true,
      data: {
        id: result.id,
        title,
        body,
        audience,
        // How many bells it rang, so the operator can see the fan-out reached the size of
        // the audience they meant rather than trusting a 200.
        notified: result.notified,
        created_at: createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
