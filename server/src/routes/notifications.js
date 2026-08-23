// Customer notifications: list, unread count, mark read.
import express from 'express';
import { db } from '../db.js';
import { runReminderSweep } from '../lib/reminders.js';
import { httpError, requireAuth } from '../middleware/auth.js';

const router = express.Router();

// The bell only ever shows the signed-in account's own notifications.
router.use(requireAuth);

// The list is a notification bell, not an archive: 30 newest is all the UI can show.
const FEED_LIMIT = 30;

/* The 24-hour reminder has no cron to run it — this deployment sleeps whenever nobody is
   looking — so the bell itself sweeps for due appointments before it answers. Reading the
   bell is also the only moment a reminder could be seen, so nothing is lost by waiting for
   it. Once every ten minutes at most, across the whole process: the sweep looks at every
   account, not just the caller's, so one reader pays for all of them. */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
let lastSweepAt = 0;

async function sweepReminders() {
  if (Date.now() - lastSweepAt < SWEEP_INTERVAL_MS) {
    return;
  }
  // Stamped before the await, not after: two requests arriving together must not both sweep.
  lastSweepAt = Date.now();
  try {
    await runReminderSweep();
  } catch (error) {
    // A bell that cannot show one extra row is still a bell; a bell that 500s is not.
    console.error('reminder sweep failed:', error);
  }
}

// "read" is a SQL keyword, so it stays quoted in every statement that touches it.
const selectFeed = db.prepare(`
  SELECT id, title, body, type, "read", booking_id, created_at
  FROM notifications
  WHERE user_id = ?
  ORDER BY created_at DESC, id DESC
  LIMIT ?
`);
const selectUnreadFeed = db.prepare(`
  SELECT id, title, body, type, "read", booking_id, created_at
  FROM notifications
  WHERE user_id = ? AND "read" = 0
  ORDER BY created_at DESC, id DESC
  LIMIT ?
`);
const selectUnreadCount = db.prepare(
  'SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND "read" = 0',
);
const markRead = db.prepare('UPDATE notifications SET "read" = 1 WHERE id = ? AND user_id = ?');
const markAllRead = db.prepare(
  'UPDATE notifications SET "read" = 1 WHERE user_id = ? AND "read" = 0',
);

function toNotification(row) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    type: row.type,
    read: Boolean(row.read),
    // What the notification is about, when it is about a booking: the row then opens that
    // booking rather than the list it lives in.
    booking_id: row.booking_id ?? null,
    created_at: row.created_at,
  };
}

router.get('/', async (req, res, next) => {
  try {
    // Before either branch, so the badge counts a reminder the same load it is written on.
    await sweepReminders();

    // count_only wins: the badge needs a number, and sending the rows too would be waste.
    if (req.query.count_only === 'true') {
      res.json({
        success: true,
        data: { unread_count: (await selectUnreadCount.get(req.user.id)).count },
      });
      return;
    }

    const rows =
      req.query.unread === 'true'
        ? await selectUnreadFeed.all(req.user.id, FEED_LIMIT)
        : await selectFeed.all(req.user.id, FEED_LIMIT);

    res.json({ success: true, data: rows.map(toNotification) });
  } catch (error) {
    next(error);
  }
});

router.patch('/:id/read', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    // Scoped by user_id in the UPDATE itself, so another account's notification simply
    // matches nothing — there is no window between a check and the write.
    const changes = Number.isInteger(id)
      ? Number((await markRead.run(id, req.user.id)).changes)
      : 0;
    if (changes === 0) {
      throw httpError(404, 'NOT_FOUND', 'Không tìm thấy thông báo.');
    }

    res.json({ success: true, data: { ok: true } });
  } catch (error) {
    next(error);
  }
});

router.post('/read-all', async (req, res, next) => {
  try {
    const updated = Number((await markAllRead.run(req.user.id)).changes);
    res.json({ success: true, data: { updated } });
  } catch (error) {
    next(error);
  }
});

export default router;
