/*
 * The address lookup, forwarded: GET /api/geo/search.
 *
 * ket-qua-tim-kiem.html and cai-dat-salon.html used to call nominatim.openstreetmap.org
 * from the page. A Vietnamese network answers the whole openstreetmap.org family with a
 * reset connection, so for the readers this site is built for the lookup returned nothing
 * at all. The host this app runs on is not behind that, so it asks on their behalf.
 *
 * The upstream address is a constant, never anything a caller sends, and only the handful
 * of parameters the two pages use are carried across: there is nowhere a caller can point
 * this, and nothing a caller can ask for that the pages do not already ask for.
 */
import express from 'express';
import { httpError } from '../middleware/auth.js';

const router = express.Router();

const UPSTREAM = 'https://nominatim.openstreetmap.org/search';
// The same ceiling lib/mailer.js puts on Resend, for the same reason: a request that never
// settles would pin a socket for as long as the process lives.
const TIMEOUT_MS = 10_000;
// Nominatim's usage policy allows one request a second per client, and this process is one
// client however many pages are searching. 1100ms leaves room for a clock that rounds the
// wrong way.
const GAP_MS = 1100;
// A queue with no ceiling is how a page that retries in a loop takes the process's memory
// with it. Ten deep is already eleven seconds of waiting, which nobody sits through.
const MAX_WAITING = 10;
// Nominatim asks callers to say who they are, and refuses the ones that do not.
const USER_AGENT = 'OAKBeautyDemo/1.0 (hello@oakbeauty.vn)';
// Both refusals below are the same thing to a reader: come back in a moment. The body is a
// fallback — the pages key off the 429 status, not off this text.
const BUSY_MESSAGE = 'Tra cứu địa chỉ đang bận, bạn chờ một phút rồi thử lại nhé.';

/* Same in-memory fixed-window counter as the /events throttle in routes/events.js, with the
   same caveats: it lives in one process's memory, resets on deploy, and a caller with many
   addresses walks past it. It is here because MAX_WAITING bounds how many lookups run at
   once, not how many arrive: without it one script can hold the single 1.1s chain for as
   long as it likes, and ask Nominatim ~78,000 times a day from this deploy's one egress
   address — the absolute usage that gets an address blocked for everybody sharing it.
   The one serialized 1.1s chain can issue at most ~54 upstream lookups a minute for the
   whole site, so an allowance of thirty lets two callers starve everyone else. Both pages
   only look an address up when someone presses a button, and the deepest ladder in
   cai-dat-salon.html is a few rungs, so ten a minute costs a real user nothing. */
const WINDOW_MS = 60 * 1000;
const MAX_LOOKUPS_PER_WINDOW = 10;
const hits = new Map();

/** Record one call from `key`; true once the minute's allowance is spent. */
function rateLimited(key) {
  const now = Date.now();
  // Swept on the way through, like the events throttle: an idle process holds nothing and
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
  return entry.count > MAX_LOOKUPS_PER_WINDOW;
}

/* What the two call sites send, and so the whole of what is carried upstream. Forwarding
   the query wholesale would let a caller add polygon_geojson=1 and turn a few request bytes
   into administrative boundaries that this route reads into memory in one piece, or set a
   format neither page can parse. */
const FORWARDED = ['format', 'countrycodes', 'accept-language', 'q'];
const LIMIT_DEFAULT = 5;
const LIMIT_MAX = 10;

/** The upstream query string: the parameters above as the caller sent them, nothing else. */
function upstreamQuery(query) {
  const params = new URLSearchParams();
  for (const name of FORWARDED) {
    // Express hands ?q[]=x over as an array and ?q[a]=x as an object; neither is a query.
    if (typeof query[name] === 'string' && query[name] !== '') {
      params.set(name, query[name]);
    }
  }
  const limit = Number.parseInt(query.limit, 10);
  params.set('limit', String(limit >= 1 && limit <= LIMIT_MAX ? limit : LIMIT_DEFAULT));
  return params.toString();
}

/* Two salon owners registering in the same district ask the same question a minute apart,
   and the answer has not moved between them. Nothing downstream keeps one — the /api
   middleware in app.js marks every response no-store — so the repeat would otherwise spend
   the single 1.1s slot the owner behind them is waiting for. Small and short-lived on
   purpose: this is here to spare that slot, not to be a store. */
const CACHE_MAX = 200;
const CACHE_TTL_MS = 10 * 60 * 1000;
const answers = new Map();

/** What was last read for `query`, if it was read recently enough to still be true. */
function remembered(query) {
  const entry = answers.get(query);
  if (!entry) {
    return undefined;
  }
  if (Date.now() - entry.at >= CACHE_TTL_MS) {
    answers.delete(query);
    return undefined;
  }
  return entry.places;
}

function remember(query, places) {
  answers.set(query, { at: Date.now(), places });
  if (answers.size > CACHE_MAX) {
    // Insertion order: the first key a Map hands back is the oldest one in it.
    answers.delete(answers.keys().next().value);
  }
}

// One chain for the whole process: two readers searching at the same moment still reach
// Nominatim one after the other.
let chain = Promise.resolve();
let waiting = 0;

/** Run `task` behind everything already queued, at least GAP_MS after the last one ran. */
function serialize(task) {
  if (waiting >= MAX_WAITING) {
    throw httpError(429, 'RATE_LIMITED', BUSY_MESSAGE);
  }
  waiting += 1;

  const run = chain.then(task);
  // What follows waits for this call to settle and then for the gap. The failure is
  // swallowed here and only here: a rejected chain would hand its rejection to every
  // lookup after it.
  chain = run.then(
    () => {},
    () => {},
  ).then(() => new Promise((resolve) => setTimeout(resolve, GAP_MS)));

  return run.finally(() => {
    waiting -= 1;
  });
}

router.get('/search', async (req, res, next) => {
  try {
    if (rateLimited(req.ip)) {
      throw httpError(429, 'RATE_LIMITED', BUSY_MESSAGE);
    }

    const query = upstreamQuery(req.query);
    const known = remembered(query);
    if (known) {
      return res.json(known);
    }

    const upstream = await serialize(() => {
      // Waiting a turn can take as long as the queue ahead is deep, and the page gave up
      // saying so long before that. A reader who closed it has nobody left to answer, and
      // the slot belongs to whoever is still there.
      if (req.destroyed) {
        return null;
      }
      return fetch(`${UPSTREAM}?${query}`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    });

    if (!upstream) {
      return undefined;
    }

    if (!upstream.ok) {
      throw new Error(`Nominatim answered ${upstream.status}`);
    }

    // Nominatim's own array, passed on as it arrived rather than wrapped in the
    // {success, data} envelope the rest of the API uses: both call sites parse the raw
    // shape, and a proxy that reshapes what it forwards is not a proxy.
    const places = await upstream.json();
    // Nominatim can answer 200 with an error object instead of a list. Both pages already
    // step around one; holding it would make that address unlookupable for ten minutes.
    if (Array.isArray(places)) {
      remember(query, places);
    }
    return res.json(places);
  } catch (error) {
    if (error.isAppError) {
      return next(error);
    }
    // A refusal, a timeout and a network that is not there are one thing to the pages:
    // no answer. They only ever look at response.ok.
    console.error('geo/search: could not reach Nominatim:', error);
    return next(
      httpError(502, 'UPSTREAM_ERROR', 'Không tra cứu được địa chỉ, vui lòng thử lại sau.'),
    );
  }
});

export default router;
