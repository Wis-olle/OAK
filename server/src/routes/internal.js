/*
 * The door an external scheduler knocks on to run the tick (lib/tick.js).
 *
 * src/index.js already runs the tick on an interval of its own, and on a service that is
 * kept awake by the health ping (DEPLOY.md §8) that is enough. This route is the belt to
 * that pair of braces: a cron-job.org monitor pointed here runs the sweep even if the
 * process has just restarted, and it is the only way to make a tick happen on demand —
 * which is what the smoke suite uses it for.
 *
 * Authentication is a shared key and nothing more. There is no account behind a cron job, so
 * requireAuth is the wrong shape; what the key has to be is unguessable and compared without
 * leaking its length or its prefix through timing. Both spellings are accepted because the
 * free cron services differ: a URL is all some of them can send, a header is cleaner where
 * it is available, and a key in a URL is a key in somebody's request log — treat it as one
 * more secret to rotate rather than as a lesser kind.
 */
import crypto from 'node:crypto';
import express from 'express';
import { db } from '../db.js';
import { runTick } from '../lib/tick.js';

const router = express.Router();

/**
 * True when `given` is the configured key. Constant-time over equal-length buffers, and a
 * plain length comparison first because timingSafeEqual throws on a mismatch — the length
 * of a secret is not what an attacker is short of.
 */
function keyAccepted(given, secret) {
  const offered = Buffer.from(String(given ?? ''), 'utf8');
  const expected = Buffer.from(secret, 'utf8');
  return offered.length === expected.length && crypto.timingSafeEqual(offered, expected);
}

async function tick(req, res, next) {
  try {
    const secret = process.env.TICK_SECRET;
    if (!secret) {
      // Not a 401: nothing the caller sends could ever be right, and an operator reading a
      // wall of 401s would look for a wrong key rather than for a missing setting.
      console.error('TICK_SECRET is not set — /api/internal/tick is closed.');
      res.status(503).json({
        success: false,
        error: { code: 'TICK_DISABLED', message: 'Không có TICK_SECRET, tác vụ định kỳ đang tắt.' },
      });
      return;
    }

    const offered = req.query.key ?? req.get('x-oak-tick-key');
    if (!keyAccepted(offered, secret)) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHENTICATED', message: 'Khoá không hợp lệ.' },
      });
      return;
    }

    res.json({ success: true, data: await runTick(db) });
  } catch (error) {
    next(error);
  }
}

// GET as well as POST: a free cron service that can only send a GET is the common case, and
// the tick is idempotent by construction — a second one straight after the first finds
// nothing left to close and nothing left to remind about.
router.get('/tick', tick);
router.post('/tick', tick);

export default router;
