/*
 * Anonymous product measurement: POST /api/events, one row per thing that happened.
 *
 * The point is to know whether anyone uses the blog CTA, the assistant, the language
 * switch — questions that are otherwise answered by guessing. The cost of asking them has
 * to stay near zero: no account, no cookie of its own, nothing personal in a row, and
 * nothing here that can make a page fail. Callers are pages, via OAK.track() in
 * ui/assets/js/oak-api.js, which sends and forgets.
 */
import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import { db } from '../db.js';
import { todayISO } from '../lib/time.js';
import { httpError } from '../middleware/auth.js';

const router = express.Router();

// Lowercase snake_case, the shape every call site uses. Not a list of known names on
// purpose: pages are instrumented one at a time, and an event this file has not heard of
// is a real event, not a bad request.
const NAME_PATTERN = /^[a-z][a-z0-9_]{2,39}$/;

const MAX_TEXT_LENGTH = 200;
const MAX_META_KEYS = 8;
const MAX_META_LENGTH = 40;

/* Same in-memory fixed-window counter as the /forgot-password throttle in routes/auth.js,
   with the same caveats: it lives in one process's memory, resets on deploy, and a caller
   with many addresses walks past it. It is here to stop one bored client from filling the
   table, not to stop an attacker. */
const WINDOW_MS = 60 * 1000;
const MAX_EVENTS_PER_WINDOW = 60;
const hits = new Map();

/** Record one call from `key`; true once the minute's allowance is spent. */
function rateLimited(key) {
  const now = Date.now();
  // Swept on the way through, like the auth throttle: an idle process holds nothing and
  // no timer keeps it awake. Whatever survives the sweep is in-window by definition.
  for (const [seen, entry] of hits) {
    if (now - entry.windowStart >= WINDOW_MS) {
      hits.delete(seen);
    }
  }

  const entry = hits.get(key);
  if (!entry) {
    hits.set(key, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_EVENTS_PER_WINDOW;
}

/* A run of digits long enough to be a phone number, and the shape of an email address.
   Crude on purpose: meta carries counts and short labels, so anything looking remotely
   like a way to reach a person is a mis-instrumented page, not a value worth keeping. */
const PII_PATTERN = /\d{6,}|@/;

/* Keys that name a person or an account, whatever they hold. A number called user_id is
   still a user_id, and this table is the one place in the schema that must not be able to
   say who did something. */
const PII_KEY_PATTERN = /user|account|email|phone|token|khach/i;

/** Trim a caller-supplied string to something a column can hold, or null. */
function text(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  return value.trim().slice(0, MAX_TEXT_LENGTH);
}

/**
 * Keep the numbers, the booleans and the short harmless strings; drop everything else.
 * meta is for things like {total: 12} or {category: 'nail'} — the answer to "how many"
 * and "which kind" — and a value that could identify a person is dropped rather than
 * stored, so no page can turn this table into personal data by accident.
 *
 * One limit worth knowing before adding a call site: PII_PATTERN reads strings only.
 * Numbers are trusted on the strength of their key name alone, because a digit rule
 * cannot tell 912345678 from a price of 250000. So a key carrying a person-shaped number
 * must be named so PII_KEY_PATTERN catches it — or, better, not sent at all.
 */
function sanitiseMeta(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const clean = {};
  for (const [key, entry] of Object.entries(value).slice(0, MAX_META_KEYS)) {
    if (key.length > MAX_META_LENGTH || PII_KEY_PATTERN.test(key)) {
      continue;
    }
    if ((typeof entry === 'number' && Number.isFinite(entry)) || typeof entry === 'boolean') {
      clean[key] = entry;
    } else if (
      typeof entry === 'string' &&
      entry.length <= MAX_META_LENGTH &&
      !PII_PATTERN.test(entry)
    ) {
      clean[key] = entry;
    }
  }
  return Object.keys(clean).length ? JSON.stringify(clean) : null;
}

/* Minted at boot and never written down: two rows of one visit can be counted as one
   visit for the day, and nobody holding the database — including us — can turn a hash
   back into an address, or match today's rows against yesterday's. */
const SALT = randomBytes(16).toString('hex');

function sessionHash(req) {
  return createHash('sha256')
    .update(`${req.ip}|${req.get('user-agent') || ''}|${todayISO()}|${SALT}`)
    .digest('hex')
    .slice(0, 16);
}

const insertEvent = db.prepare(
  `INSERT INTO events (name, page, ref, meta, session_hash, created_at)
   VALUES (?, ?, ?, ?, ?, ?)`,
);

router.post('/', async (req, res, next) => {
  try {
    // Before validation, so a client sending nothing but junk is throttled too.
    if (rateLimited(req.ip)) {
      throw httpError(429, 'RATE_LIMITED', 'Bạn thao tác quá nhanh, vui lòng thử lại sau.');
    }

    const body = req.body ?? {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!NAME_PATTERN.test(name)) {
      throw httpError(400, 'VALIDATION_ERROR', 'Tên sự kiện không hợp lệ.');
    }

    await insertEvent.run(
      name,
      text(body.page),
      // Path only: a referring url's query string can carry someone's search terms.
      text(String(body.ref ?? '').split('?')[0]),
      sanitiseMeta(body.meta),
      sessionHash(req),
      new Date().toISOString(),
    );

    res.json({ success: true, data: { ok: true } });
  } catch (error) {
    next(error);
  }
});

export default router;
