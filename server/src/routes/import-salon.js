/*
 * "Dán link salon của bạn" — POST /api/partner/import.
 *
 * A salon that already exists somewhere on the internet has typed its address, its opening
 * hours and its whole price list at least once. Asking them to type it again is where a
 * partner sign-up stops: the console opens on an empty profile with four things missing
 * before anyone can see it. So they paste the link they already have, and this route fills
 * in what it can read.
 *
 * Three readings, and only three, because that is what Vietnam actually holds:
 *
 *  - KiotViet. Most salon chains here book through booksalon.kiotviet.vn, whose API answers
 *    an unauthenticated request with the tenant and the menu. This is the reading that fills
 *    a profile properly — address, phone, hours, twenty services with prices. Where the
 *    store is a page of its own, that page is read as well and its answers fill the gaps
 *    the API leaves: the gallery, the Facebook button and the owner's own description are
 *    on the page and nowhere in the API.
 *  - An ordinary website. Best effort out of JSON-LD and OpenGraph: whatever a booking
 *    plugin or a theme happened to mark up.
 *  - A Facebook/Instagram/TikTok/Zalo/YouTube page. Nothing is fetched — those are login
 *    walls whose terms forbid automated collection, and behind the wall there is nothing
 *    machine-readable anyway. The link is saved as the salon's social link and the partner
 *    is told to fill the rest in by hand. That is a success, not a failure.
 *
 * What an import does with what it read is the partner's own choice, ticked on the card
 * before the request. Left alone, it fills blanks and nothing else: every column it writes
 * is one the salon left empty, hours go only into a week that has none, and a service whose
 * name the salon already has is skipped. Ticked, `overwrite` says the page is the record and
 * the profile is the draft — what the source states is written over what is there, which is
 * what a partner who has half-typed a profile and then remembered their old site is asking
 * for. What the source is silent about is still left exactly as it stands in either reading:
 * a page that lists no phone number does not erase one.
 *
 * Two things hold whichever box is ticked. A service the partner has is never deleted — every
 * booking ever taken points at a service id — and salons.published is untouched, so the
 * console's own checklist still decides when the salon goes live.
 *
 * Every outbound request goes through lib/safe-fetch.js — see the note at the top of that
 * file for what a route that fetches a caller-supplied host has to defend against.
 */
import express from 'express';
import { db } from '../db.js';
import {
  classifyUrl,
  extractRetailerCode,
  geocodeQueries,
  mapServices,
  mapTenant,
  mergeContactSocialLinks,
  nextDataContact,
  normalizeServiceName,
  parseGenericHtml,
} from '../lib/import-extract.js';
import { UnsafeUrlError, safeFetch } from '../lib/safe-fetch.js';
import { SocialProfileError, validateSocialProfile } from '../lib/social-profile.js';
import { MAX_IMAGE_BYTES, extensionForContentType, storeImage } from '../lib/store-image.js';
import { releaseUpload, reserveUpload, settleUpload } from '../lib/upload-quota.js';
import { httpError, requireAuth, requirePartner } from '../middleware/auth.js';
import { REGISTRATION_CITY } from './auth.js';

const router = express.Router();

// The same gate the rest of the console sits behind: an import writes into one salon's
// profile, and the salon is derived from the session, never from the body.
router.use(requireAuth, requirePartner);

const KIOTVIET_API = 'https://api-booksalon.kiotviet.vn';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
// Nominatim allows one request a second per client. This is the gap between the two lookups
// one import makes — a second apart plus room for a clock that rounds the wrong way — and
// nothing more: unlike routes/geo.js, which queues every reader on one process-wide chain,
// two imports running at once still ask twice in the same instant. What holds the rate down
// here is scarcity rather than a queue: three imports per account per ten minutes, at most
// two lookups each. See the note on geocode() for why the two do not share a chain.
const NOMINATIM_GAP_MS = 1100;
const MAX_URL_LENGTH = 2048;
// Six pictures is a cover and a gallery row — enough for the profile to look like something
// on the first day, few enough that one import cannot spend a storage bucket. The number is
// spoken aloud by the images_capped line on the card, so changing it here means changing the
// string in ui/cai-dat-salon.html and its twin key in tools/i18n/parts/cai-dat-salon.json
// ('Trang của bạn có nhiều ảnh — OAK lấy 6 ảnh đầu tiên…'), then rebuilding the dictionary.
const MAX_IMPORTED_IMAGES = 6;
// A menu longer than this is a wholesale price list, not a salon's services page. The cap is
// on rows written in one transaction as much as on what a partner would want to scroll.
const MAX_IMPORTED_SERVICES = 200;
const DAYS_IN_WEEK = 7;

/* Three imports per partner per ten minutes, the same in-memory fixed-window counter
   routes/geo.js and routes/events.js use, with the same caveats: it lives in one process's
   memory, resets on deploy, and an account with several browsers walks past it. It is here
   because one import is up to nine outbound requests — a page, two API calls, six images —
   against hosts this process did not choose, plus a Nominatim lookup that the whole site
   shares one rate for. Three is more than anyone needs: a partner imports once, sees what
   came back, and fixes the rest by hand. Keyed on the account rather than the address, so
   a salon behind a shared office IP is not throttled by its neighbours. */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_IMPORTS_PER_WINDOW = 3;
const BUSY_MESSAGE = 'Bạn vừa nhập liệu tự động vài lần, chờ ít phút rồi thử lại nhé.';
const hits = new Map();

/** Record one import by `key`; true once the window's allowance is spent. */
function rateLimited(key) {
  const now = Date.now();
  // Swept on the way through: an idle process holds nothing and no timer keeps it awake.
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
  return entry.count > MAX_IMPORTS_PER_WINDOW;
}

// The same statement and the same reading of "the owner's salon" as ownedSalon in
// routes/partner.js: the lowest id owned by the signed-in account, never an id from a body.
const selectOwnedSalon = db.prepare('SELECT * FROM salons WHERE owner_id = ? ORDER BY id LIMIT 1');

const selectPhotoCount = db.prepare(
  'SELECT COUNT(*) AS count FROM salon_photos WHERE salon_id = ?',
);

async function ownedSalon(req) {
  const salon = await selectOwnedSalon.get(req.user.id);
  if (!salon) {
    throw httpError(404, 'PARTNER_NO_SALON', 'Tài khoản của bạn chưa có salon nào.');
  }
  return salon;
}

/** Whether a column is one an import may write into: NULL, or a string with nothing in it. */
function isEmpty(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

/* ============================================================================
 * Reading the source
 * ========================================================================= */

/**
 * Why a hop must not be followed: it lands on a page this route only ever stores a link to.
 *
 * Handed to safeFetch rather than checked once here, because it has to hold for every hop.
 * classifyUrl decides the pasted link before anything is fetched, but an ordinary link is
 * free to answer 302 to facebook.com — and "nothing on a social page is ever fetched" is
 * not a guarantee if a redirect is all it takes to walk around it.
 */
function refuseSocialUrl(url) {
  return classifyUrl(url)?.kind === 'social'
    ? 'Đường dẫn này dẫn sang một trang mạng xã hội, vui lòng dán thẳng link đó.'
    : null;
}

/** One JSON answer from an upstream, under every guard in lib/safe-fetch.js. */
async function fetchJson(url, headers) {
  const answer = await safeFetch(url, { headers: { Accept: 'application/json', ...headers } });
  return JSON.parse(answer.buffer.toString('utf8'));
}

/** One window for the whole week, fanned across the seven days salon_hours stores. */
function everyWeekday({ start, end }) {
  return Array.from({ length: DAYS_IN_WEEK }, (unused, weekday) => ({ weekday, start, end }));
}

/**
 * A KiotViet salon: the tenant, then that branch's menu.
 *
 * The retailer code is the whole of the authentication — the API answers any caller that
 * names a retailer, which is what makes the booking page work without a login. A menu that
 * cannot be read does not sink the import: the address and the hours are worth more than
 * the price list, and the partner can add services by hand.
 */
async function readKiotViet(retailerCode) {
  const headers = { 'x-retailer-code': retailerCode };
  const tenant = mapTenant(await fetchJson(`${KIOTVIET_API}/tenant`, headers));

  let services = [];
  if (tenant.branchId !== null) {
    try {
      services = mapServices(
        await fetchJson(`${KIOTVIET_API}/services?BranchId=${tenant.branchId}`, headers),
      );
    } catch (error) {
      console.error('partner/import: could not read the KiotViet menu:', error.message);
    }
  }

  return {
    mode: 'kiotviet',
    name: tenant.name,
    description: null,
    phone: tenant.phone,
    address: tenant.address,
    district: tenant.district,
    city: tenant.city,
    hours: tenant.hours ? everyWeekday(tenant.hours) : [],
    services,
    images: [tenant.logo, tenant.background].filter(Boolean),
    socialLinks: [],
    geo: null,
    warnings: tenant.warnings,
  };
}

/** An ordinary website: whatever its markup was willing to say. */
function readWebsite(html, pageUrl) {
  const page = parseGenericHtml(html, pageUrl);
  return {
    mode: 'generic',
    name: page.name,
    description: page.description,
    phone: page.phone,
    address: page.address,
    district: page.district,
    city: page.city,
    hours: page.hours,
    // Fed back through the KiotViet mapper so one code path decides prices, durations and
    // categories however the names arrived.
    services: mapServices({
      Data: page.services.map((service) => ({ Name: service.name, BasePrice: service.price })),
    }),
    images: page.images,
    socialLinks: page.socialLinks,
    geo: page.geo,
    warnings: [],
  };
}

/**
 * The KiotViet reading, filled out with what the page it was found on also said.
 *
 * The API answers with a tenant and a menu and nothing else: no description, no social
 * links, and two pictures — a logo and a banner. The web store page around it carries the
 * gallery the salon actually uploaded, the Facebook button in its footer and the sentence
 * its owner wrote about themselves, and dropping all of that on the floor is why the first
 * live import came back with one photo and no description.
 *
 * KiotViet wins every field it has an answer for, save the one noted below. A name, a phone,
 * a district and a week read out of the tenant are the salon's own records; the same things
 * guessed out of markup are a theme's best effort. So only the gaps are filled.
 */
function mergePage(source, page, contact) {
  return {
    ...source,
    description: source.description ?? page.description,
    // The address is the exception, and the page wins it. KiotViet keeps Branchs[].Address as
    // free text, so it holds whatever the owner wanted a customer to read: the salon this was
    // built against keeps a booking notice in Korean there, which is no address at all and
    // which no gazetteer will ever find — the first rung of the geocode ladder could not
    // resolve while that was the string being asked about. The web store's contact block is
    // the field KiotViet structures, and the one the page's own map link is built from. Where
    // the page offers none, the tenant's free text is still all there is.
    address: contact.address ?? source.address,
    // The branch's own number, where the tenant has one; the contact block fills the gap.
    phone: source.phone ?? contact.phone,
    // The tenant answers with none at all. A link the salon already has is left where it is
    // by the insert's ON CONFLICT DO NOTHING, so there is nothing to reconcile here.
    socialLinks: mergeContactSocialLinks(page.socialLinks, contact),
    // Logo and banner first — the pictures the salon chose to be seen by — then the page's
    // own, in page order, with anything named twice carried once. rehostImages still stops
    // at MAX_IMPORTED_IMAGES, so a long gallery costs no more requests than a short one.
    images: [...new Set([...source.images, ...page.images])],
  };
}

/**
 * The draft behind a pasted link.
 *
 * A generic page is read for a KiotViet booking button before it is read as prose: a salon
 * whose own domain fronts a KiotViet store has its whole menu one request away, and the
 * markup would have given up a phone number at best. But it is read as prose either way —
 * the HTML is already in hand, and what the API does not hold is on the page.
 *
 * A booking link pasted directly has no page around it to read, and is not fetched one:
 * booksalon.kiotviet.vn renders its store from the same API this route is already asking.
 */
async function readSource(link) {
  if (link.kind === 'kiotviet-booking') {
    return readKiotViet(link.retailerCode);
  }

  const page = await safeFetch(link.url, {
    headers: { Accept: 'text/html,*/*;q=0.8' },
    refuseUrl: refuseSocialUrl,
  });
  const html = page.buffer.toString('utf8');
  const retailerCode = extractRetailerCode(html);
  if (!retailerCode) {
    return readWebsite(html, page.url);
  }
  return mergePage(
    await readKiotViet(retailerCode),
    parseGenericHtml(html, page.url),
    nextDataContact(html),
  );
}

/* ============================================================================
 * Coordinates and pictures
 * ========================================================================= */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One address lookup, straight to Nominatim rather than through routes/geo.js.
 *
 * That route's serialized 1.1s chain and its cache are module-private, and re-exporting them
 * would make a proxy built for two pages into shared infrastructure. At most two lookups per
 * import, a second apart, behind a three-per-ten-minutes allowance, is well inside
 * Nominatim's usage policy.
 *
 * Never fatal. A Vietnamese network answers the whole openstreetmap.org family with a reset
 * connection (see the note in routes/geo.js), so this fails on every local dev machine in
 * the country — the salon simply arrives without a pin, and the settings map can drop one.
 */
async function geocode(query) {
  try {
    const answer = await safeFetch(
      `${NOMINATIM}?${new URLSearchParams({ format: 'json', countrycodes: 'vn', limit: '1', q: query })}`,
    );
    const [place] = JSON.parse(answer.buffer.toString('utf8'));
    const lat = Number(place?.lat);
    const lng = Number(place?.lon);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  } catch (error) {
    console.error('partner/import: could not geocode the imported address:', error.message);
    return null;
  }
}

/**
 * Fetch the pictures and store them here, under our own names.
 *
 * Never a hotlink: an <img> pointing at somebody else's CDN is their bandwidth, their
 * analytics on our readers, and a blank square on the profile the day they reorganise their
 * files. The bytes go through the same storage lib/store-image.js gives POST /api/uploads and
 * are charged to the same allowance lib/upload-quota.js holds that route to, so the partner's
 * own twenty an hour and the site-wide breaker cover this door too — a ceiling only one of
 * two doors into a bucket honours is a ceiling with a way around it. The type ceiling is the
 * one thing that differs: 5MB rather than a megabyte, because these are somebody's original
 * files off their own website and no browser of ours shrank them first. Anything outside the
 * four types is skipped rather than stored, and the answer says so with 'images_partial'.
 *
 * A refusal from the allowance is that same 'images_partial' and not an error: a gallery
 * half brought across is the standing contract of this route — a download that times out
 * already ends this way — and turning the partner's whole import into a 500 because the
 * seventeenth picture met the hour's twentieth would throw away everything that did arrive.
 *
 * A gallery longer than the cap is not a failure and is not reported as one: 'capped' is its
 * own answer, because a partner told "some photos could not be fetched" when every download
 * succeeded goes looking for a fault that is not there. A merged KiotViet import — two API
 * pictures plus the page's own — passes the cap routinely.
 *
 * These files are written before the transaction opens, and a transaction that rolls back
 * leaves them behind with no row pointing at them. Accepted rather than cleaned up: the
 * alternative is holding a pool connection open across six downloads from hosts we do not
 * control, and six orphaned JPEGs on the rare failed import cost less than that does on
 * every successful one. Nothing serves a file nothing references.
 */
async function rehostImages(urls, userId) {
  const stored = [];
  let partial = false;

  for (const url of urls.slice(0, MAX_IMPORTED_IMAGES)) {
    let reservation = null;
    try {
      const answer = await safeFetch(url, {
        maxBytes: MAX_IMAGE_BYTES,
        refuseUrl: refuseSocialUrl,
      });
      const extension = extensionForContentType(answer.contentType);
      if (!extension) {
        partial = true;
        continue;
      }
      // Taken after the download and before the store, the same order the upload route
      // takes it in: what the allowance rations is bytes written into the bucket, and a
      // picture that turned out to be a PDF never gets that far.
      reservation = await reserveUpload(userId, answer.buffer.length);
      const address = await storeImage(answer.buffer, extension);
      await settleUpload(reservation, address);
      stored.push(address);
    } catch (error) {
      console.error('partner/import: could not re-host an image:', error.message);
      if (reservation !== null) {
        await releaseUpload(reservation);
      }
      partial = true;
    }
  }

  return { stored, partial, capped: urls.length > MAX_IMPORTED_IMAGES };
}

/* ============================================================================
 * Writing
 * ========================================================================= */

// The columns an import may fill. slug is absent from both lists — it is in every link to
// the salon, including the ones already handed out — and so are verified, featured and
// published. name joins the writable set under `overwrite` alone: a name is the one thing
// registration always asks for, so a blanks-first import has nothing to say about it, and
// replacing it takes an explicit "the page is the record".
const IMPORTABLE_COLUMNS = ['description', 'address', 'phone'];
const OVERWRITABLE_COLUMNS = ['name', ...IMPORTABLE_COLUMNS];

const DELETE_SALON_HOURS = 'DELETE FROM salon_hours WHERE salon_id = ?';
const DELETE_SALON_PHOTOS = 'DELETE FROM salon_photos WHERE salon_id = ?';
// COALESCE on both halves, so a page that priced a service but never said how long it takes
// reprices the row and leaves its minutes alone — and one that states a length without a price
// writes the length onto a price that stays the salon's. See the note beside the call for why
// the two halves of a menu row have to be guarded one by one.
const UPDATE_SERVICE_PRICE =
  'UPDATE services SET price = COALESCE(?, price), duration_min = COALESCE(?, duration_min) WHERE id = ?';
const INSERT_SALON_HOURS =
  'INSERT INTO salon_hours (salon_id, weekday, "start", "end", is_off) VALUES (?, ?, ?, ?, ?)';
const UPDATE_SALON_SUMMARY = 'UPDATE salons SET open_time = ?, close_time = ? WHERE id = ?';
const INSERT_SERVICE = `
  INSERT INTO services (salon_id, category, name, price, duration_min, sort_order, active)
  VALUES (?, ?, ?, ?, ?, ?, 1)
`;
const INSERT_SALON_PHOTO = 'INSERT INTO salon_photos (salon_id, image, caption, sort) VALUES (?, ?, NULL, ?)';
// RETURNING platform is load-bearing, not decoration: db.prepare appends ' RETURNING id' to
// any INSERT that names no RETURNING clause, and this is the one table with no id column —
// its key is (salon_id, platform). routes/partner.js spells its own insert out for the same
// reason. DO NOTHING then returns no row, which is the 0 that says the link was already there.
const INSERT_SOCIAL_LINK = `
  INSERT INTO salon_social_links (salon_id, platform, url) VALUES (?, ?, ?)
  ON CONFLICT (salon_id, platform) DO NOTHING RETURNING platform
`;
// The same insert under `overwrite`, where a link already stored is the stale one: a salon
// that moved its page is exactly the salon reaching for this. DO UPDATE returns its row
// whether or not the address changed, so the count is "links this import wrote" rather than
// "links this import altered" — near enough for a line that says how much came across.
const UPSERT_SOCIAL_LINK = `
  INSERT INTO salon_social_links (salon_id, platform, url) VALUES (?, ?, ?)
  ON CONFLICT (salon_id, platform) DO UPDATE SET url = excluded.url RETURNING platform
`;
const INSERT_SALON_IMPORT = `
  INSERT INTO salon_imports (salon_id, url, mode, consent_at, imported_at, summary)
  VALUES (?, ?, ?, ?, ?, ?)
`;

/** The whole-week summary salons.open_time/close_time hold: earliest open, latest close. */
function hoursSummary(hours) {
  const starts = hours.map((day) => day.start).sort();
  const ends = hours.map((day) => day.end).sort();
  return [starts[0], ends[ends.length - 1]];
}

/**
 * Everything this import writes, in one transaction.
 *
 * The salon row is read again inside it rather than trusted from before the fetches: those
 * took seconds, and the partner may have been typing into the settings form throughout. What
 * is empty at this moment is what gets filled.
 *
 * `overwrite` turns every "only where it is empty" below into "wherever the source has an
 * answer". `skipped` keeps its one meaning through both — the source offered this and we
 * left it alone — which is why an overwrite mostly reports none: the only things it refuses
 * are what it could not fetch, and a pin whose address it never wrote.
 */
async function writeImport(tx, salon, source, { images, geo, url, consentAt, overwrite }) {
  const current = await tx.get('SELECT * FROM salons WHERE id = ?', salon.id);
  const filled = [];
  const skipped = [];
  const assignments = [];
  const values = [];

  const write = (column, value) => {
    assignments.push(`${column} = ?`);
    values.push(value);
    filled.push(column);
  };

  // A column the source says nothing about is left alone in either mode: "replace what the
  // page states" is not "empty what the page omits".
  for (const column of overwrite ? OVERWRITABLE_COLUMNS : IMPORTABLE_COLUMNS) {
    if (isEmpty(source[column])) {
      continue;
    }
    if (overwrite || isEmpty(current[column])) {
      write(column, source[column]);
    } else {
      skipped.push(column);
    }
  }

  // district and city move together or not at all. Column by column they come apart: every
  // salon is born in auth.js with a city of REGISTRATION_CITY and no district, so city is
  // never empty and district always is — an "only fill what is empty" rule applied to each
  // on its own imports "Quận Hải Châu" onto "TP.HCM" and leaves a district of Đà Nẵng
  // sitting under the wrong city. That is not an edge case, it is every salon outside
  // Saigon, and a wrong city is worse than no city: it is what search filters on.
  //
  // So the pair is written only where there is demonstrably nothing of the partner's in it:
  // no district at all, and a city that is either empty or still the exact string sign-up
  // guessed. Anything else the row holds is an answer somebody gave — a partner who typed
  // "Hà Nội" and never reached the district list has still told us where their salon is, and
  // an import that read a different city may not correct them. Both halves go to `skipped`
  // then, the same "never take anything away" rule as everywhere else here.
  //
  // Under `overwrite` the partner has said in so many words that the page knows better, and
  // the pair still moves together — which is a rule about the source as much as about the row.
  // A page marked up with addressLocality and no addressRegion states a city and no district,
  // and writing that city on its own leaves the district the partner typed standing under a
  // city from somewhere else: the same mismatch this guard exists to prevent, arrived at from
  // the other side. So an overwrite writes the pair where the source states both halves of it;
  // where the source has only one, the rule above stands and that half goes in only if there
  // is demonstrably nothing of the partner's for it to contradict. The missing half is never
  // cleared to make room — a page silent about a district does not erase one, here as
  // everywhere else in this route.
  const cityIsRegistrationGuess =
    isEmpty(current.city) || String(current.city).trim() === REGISTRATION_CITY;
  const locationUntouched = isEmpty(current.district) && cityIsRegistrationGuess;
  const sourceStatesBoth = !isEmpty(source.district) && !isEmpty(source.city);
  if (!isEmpty(source.district) || !isEmpty(source.city)) {
    if ((overwrite && sourceStatesBoth) || locationUntouched) {
      if (!isEmpty(source.district)) {
        write('district', source.district);
      }
      if (!isEmpty(source.city)) {
        write('city', source.city);
      }
    } else {
      if (!isEmpty(source.district)) {
        skipped.push('district');
      }
      if (!isEmpty(source.city)) {
        skipped.push('city');
      }
    }
  }

  // The first picture becomes the cover when there is none; the rest join the gallery — and
  // only into a gallery that is empty, for the reason the hours rule below exists. A partner
  // who imports twice would otherwise get the same pictures twice, and a gallery is the one
  // place duplicates are laborious to undo: one delete per photo, by hand.
  //
  // Under `overwrite` the gallery is thrown away and rebuilt from the page instead — but only
  // where there is something to rebuild it from. The test is what will actually be inserted,
  // not what was re-hosted and not what the page listed: a gallery emptied and then not
  // refilled is the one outcome nobody asked for, and it arrives two ways — six downloads that
  // all timed out, and a source holding exactly one picture, which the cover column takes and
  // leaves nothing behind it. So `rest` is what decides, and it is read after the cover branch
  // below, which is what settles whether the one picture is a cover or a gallery row.
  const existingPhotos = await tx.get(
    'SELECT COUNT(*) AS count FROM salon_photos WHERE salon_id = ?',
    salon.id,
  );
  const [cover, ...rest] = images;
  if (cover && (overwrite || isEmpty(current.image))) {
    write('image', cover);
  } else if (!isEmpty(current.image) && source.images.length > 0) {
    // Reported off what the source held rather than off what was downloaded: the cover is
    // not fetched at all when the column is already taken, and the partner is still owed the
    // fact that there was a picture we left alone. A download that simply failed is not a
    // skip — 'images_partial' says that instead.
    skipped.push('image');
    if (cover) {
      rest.unshift(cover);
    }
  }
  const replacePhotos = overwrite && rest.length > 0;
  const gallery = replacePhotos || existingPhotos.count === 0 ? rest : [];

  // A coordinate is a pair: half of one would pin the salon on a meridian somewhere, so both
  // columns move together or neither does — the same rule PATCH /api/partner/salon enforces.
  //
  // And a pin describes an address, so it may only be dropped where the address on the row
  // is the one it describes: either this import just wrote it, or the row has none for the
  // pin to contradict. A salon that kept its own address — the district/city rule above, or
  // an address the partner typed — keeps its own map, and is told so in `skipped`.
  //
  // Which is also why an overwrite that moves the address and cannot geocode it takes the pin
  // away: the salon has just moved street, and a pin still standing on the old one is a map
  // that lies about where to walk. The partner is told by 'geocode_failed' and drops it again
  // from the settings map. Cleared rather than filled, so `filled` is not credited for it.
  //
  // Moved, though, not merely written again. An overwrite writes the address whatever the row
  // already holds, so the same page imported twice writes the same street a second time — and
  // a pin taken down over that is a partner's own hand-dropped marker destroyed by an import
  // that changed nothing. Nothing contradicts a pin but an address that is genuinely different.
  const addressWritten = filled.includes('address');
  const addressChanged =
    addressWritten && String(current.address ?? '').trim() !== String(source.address).trim();
  const geocoded = overwrite
    ? Boolean(geo) && addressWritten
    : Boolean(geo) && isEmpty(current.address) && current.lat === null && current.lng === null;
  if (geocoded) {
    write('lat', geo.lat);
    write('lng', geo.lng);
  } else if (overwrite && addressChanged && (current.lat !== null || current.lng !== null)) {
    assignments.push('lat = ?', 'lng = ?');
    values.push(null, null);
  } else if (geo) {
    skipped.push('lat', 'lng');
  }

  if (assignments.length > 0) {
    await tx.run(`UPDATE salons SET ${assignments.join(', ')} WHERE id = ?`, ...values, salon.id);
  }

  // All seven days or none: a week half from an import and half from the console would be a
  // schedule nobody wrote. Only a salon that has never set its hours is touched at all —
  // unless `overwrite`, where the old week is deleted and the source's written in whole. A
  // source with no hours at all still changes nothing: there is no week to put in its place.
  const existingHours = await tx.get(
    'SELECT COUNT(*) AS count FROM salon_hours WHERE salon_id = ?',
    salon.id,
  );
  const hoursSet = source.hours.length > 0 && (overwrite || existingHours.count === 0);
  if (hoursSet) {
    if (existingHours.count > 0) {
      await tx.run(DELETE_SALON_HOURS, salon.id);
    }
    // Every weekday gets a row, including the ones the source never named. A missing row is
    // not "unknown" to lib/availability.js — it is "no restriction", so a page that lists
    // Monday to Friday would leave the salon bookable around the clock at the weekend. A day
    // the source did not name is written closed, in the shape PATCH /api/partner/salon
    // writes one: no window, is_off = 1. The partner opens it from the console if it was
    // open all along, which is the safe way round.
    const named = new Map(source.hours.map((day) => [day.weekday, day]));
    for (let weekday = 0; weekday < DAYS_IN_WEEK; weekday += 1) {
      const day = named.get(weekday);
      await tx.run(
        INSERT_SALON_HOURS,
        salon.id,
        weekday,
        day ? day.start : null,
        day ? day.end : null,
        day ? 0 : 1,
      );
    }
    await tx.run(UPDATE_SALON_SUMMARY, ...hoursSummary(source.hours), salon.id);
  }

  // Compared on the folded name: an imported "SƠN GEL HÀN QUỐC" is the service the salon
  // already typed as "Sơn Gel Hàn Quốc", and importing it again would give them two menus.
  // Under `overwrite` that row is repriced instead of passed over — but never, in either
  // mode and whatever the page says, deleted: every booking the salon has ever taken points
  // at a service id, and a menu tidied to match a website would take the salon's own history
  // with it. A service the partner added that the page has never heard of simply stays.
  const existingServices = new Map();
  for (const row of await tx.all('SELECT id, name FROM services WHERE salon_id = ?', salon.id)) {
    const key = normalizeServiceName(row.name);
    if (key !== '' && !existingServices.has(key)) {
      existingServices.set(key, row.id);
    }
  }
  const nextService = await tx.get(
    'SELECT COALESCE(MAX(sort_order), 0) + 1 AS position FROM services WHERE salon_id = ?',
    salon.id,
  );
  let servicePosition = nextService.position;
  let servicesAdded = 0;
  let categoryGuessed = false;
  for (const service of source.services.slice(0, MAX_IMPORTED_SERVICES)) {
    const key = normalizeServiceName(service.name);
    if (key === '') {
      continue;
    }
    const existingId = existingServices.get(key);
    if (existingId !== undefined) {
      // The price and the length are what a menu is read for; the category, the description
      // and the picture on that row are the partner's own work sitting on top of it, and are
      // left where they are. A row this same import wrote a moment ago — the page listing one
      // service twice — is already the source's own and has nothing to be repriced from.
      //
      // And only from what the page actually states, each half on its own. A source that
      // lists its services by name alone still has to reach the services table with a number
      // in both columns, so mapServices stands 0 đ and an hour in for the ones it was never
      // told — the shape of "the page did not say", and the one thing an overwrite must not
      // write over figures the partner typed. The stand-ins are a fine start for a row being
      // inserted; they are not answers to replace one with. The two are guarded separately
      // because a page states them separately: JSON-LD asks for a price and has no field for
      // a length at all, so a menu read that way carries the stand-in duration on every row.
      // lib/availability.js lays its slots end to end by that number, and an hour written
      // over a ninety-minute service is that service double-booked from the next morning.
      // So either half stated is reason enough to visit the row, and each column is written
      // only where the page stated that column — the other is COALESCEd back to what it was.
      if (overwrite && existingId !== null && (service.price > 0 || service.duration_stated)) {
        await tx.run(
          UPDATE_SERVICE_PRICE,
          service.price > 0 ? service.price : null,
          service.duration_stated ? service.duration_min : null,
          existingId,
        );
      }
      continue;
    }
    existingServices.set(key, null);
    await tx.run(
      INSERT_SERVICE,
      salon.id,
      service.category,
      service.name,
      service.price,
      service.duration_min,
      servicePosition,
    );
    servicePosition += 1;
    servicesAdded += 1;
    categoryGuessed = categoryGuessed || service.guessed;
  }

  // The rows go; the files they name stay on the store with nothing pointing at them, exactly
  // as they do when a partner deletes a photo from the console. Sweeping them is a job for
  // whatever eventually sweeps those, not for an import.
  if (replacePhotos) {
    await tx.run(DELETE_SALON_PHOTOS, salon.id);
  }
  const nextPhoto = await tx.get(
    'SELECT COALESCE(MAX(sort), 0) + 1 AS position FROM salon_photos WHERE salon_id = ?',
    salon.id,
  );
  let photoPosition = nextPhoto.position;
  for (const image of gallery) {
    await tx.run(INSERT_SALON_PHOTO, salon.id, image, photoPosition);
    photoPosition += 1;
  }

  let socialLinksAdded = 0;
  for (const link of source.socialLinks) {
    socialLinksAdded += (
      await tx.run(
        overwrite ? UPSERT_SOCIAL_LINK : INSERT_SOCIAL_LINK,
        salon.id,
        link.platform,
        link.url,
      )
    ).changes;
  }

  return {
    filled,
    skipped,
    services_added: servicesAdded,
    photos_added: gallery.length,
    social_links_added: socialLinksAdded,
    hours_set: hoursSet,
    geocoded,
    categoryGuessed,
    consentAt,
    url,
  };
}

/** The record of the consent this import ran under, and of what it did. */
async function recordImport(tx, salon, mode, url, consentAt, summary) {
  await tx.run(
    INSERT_SALON_IMPORT,
    salon.id,
    url,
    mode,
    consentAt,
    new Date().toISOString(),
    JSON.stringify(summary),
  );
}

/* ============================================================================
 * The route
 * ========================================================================= */

/**
 * A social page: the link is stored, nothing is fetched.
 *
 * validateSocialProfile is the same check the settings form applies, so what an import
 * stores is what a partner could have typed there — a page, not a post and not a share
 * redirect. A link that fails it is worth saying so about: silently storing nothing would
 * look exactly like an import that worked.
 */
async function importSocialLink(salon, link, rawUrl, consentAt, overwrite) {
  let url;
  try {
    url = validateSocialProfile(rawUrl, link.platform);
  } catch (error) {
    if (error instanceof SocialProfileError) {
      throw httpError(400, 'VALIDATION_ERROR', error.message);
    }
    throw error;
  }

  const summary = {
    mode: 'social',
    filled: [],
    skipped: [],
    services_added: 0,
    photos_added: 0,
    social_links_added: 0,
    hours_set: false,
    geocoded: false,
    warnings: [],
  };

  await db.withTransaction(async (tx) => {
    // The one thing `overwrite` can mean here: a salon that has moved its page and is pasting
    // the new address over the old one.
    const insert = overwrite ? UPSERT_SOCIAL_LINK : INSERT_SOCIAL_LINK;
    summary.social_links_added = (await tx.run(insert, salon.id, link.platform, url)).changes;
    await recordImport(tx, salon, 'social', url, consentAt, { ...summary, overwrite });
  });

  return summary;
}

router.post('/', async (req, res, next) => {
  try {
    const salon = await ownedSalon(req);
    const body = req.body ?? {};

    const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
    if (rawUrl === '' || rawUrl.length > MAX_URL_LENGTH) {
      throw httpError(400, 'VALIDATION_ERROR', 'Vui lòng dán link trang salon của bạn.');
    }
    const link = classifyUrl(rawUrl);
    if (!link) {
      throw httpError(400, 'VALIDATION_ERROR', 'Link phải bắt đầu bằng http:// hoặc https://.');
    }
    // An affirmative act, checked on the server and not only in the form: this copies a page
    // into a public profile, and consent a caller can leave out is not consent at all.
    if (body.consent !== true) {
      throw httpError(
        400,
        'CONSENT_REQUIRED',
        'Vui lòng xác nhận bạn là chủ sở hữu (hoặc được uỷ quyền) của trang này.',
      );
    }
    // The second tick on the card, and the only thing that lets this route write over
    // anything. Anything short of the boolean itself is the absent box: a form that forgot to
    // send the field, or a caller sending the string, must not overwrite a salon's profile.
    const overwrite = body.overwrite === true;
    if (rateLimited(req.user.id)) {
      throw httpError(429, 'RATE_LIMITED', BUSY_MESSAGE);
    }

    const consentAt = new Date().toISOString();

    if (link.kind === 'social') {
      res.json({
        success: true,
        data: await importSocialLink(salon, link, rawUrl, consentAt, overwrite),
      });
      return;
    }

    let source;
    try {
      source = await readSource(link);
    } catch (error) {
      // A link that points inside the network, or at something that is not a web page, is
      // the partner's to fix; anything else upstream is ours to apologise for.
      if (error instanceof UnsafeUrlError) {
        throw httpError(400, 'VALIDATION_ERROR', error.message);
      }
      console.error('partner/import: could not read the pasted link:', error);
      throw httpError(
        502,
        'UPSTREAM_ERROR',
        'Không đọc được trang bạn dán, vui lòng thử lại hoặc nhập thủ công.',
      );
    }

    // Both of these reach the network, so they run before the transaction opens: a database
    // client held across a fetch is a connection out of a pool of five spent on waiting.
    // Looked up only when the address is one this import is actually about to write, and
    // only into a salon with no pin of its own.
    let geo = source.geo;
    let geocodeFailed = false;
    let geocodeApproximate = false;
    if (
      !geo &&
      !isEmpty(source.address) &&
      (overwrite || (isEmpty(salon.address) && salon.lat === null))
    ) {
      // The whole address, then the area it stands in — see geocodeQueries for why the
      // second one so often lands where the first cannot. A pin found that way is on a
      // district rather than on a door, so the answer says so and the partner drags it.
      const queries = geocodeQueries(source);
      for (const [step, query] of queries.entries()) {
        if (step > 0) {
          await sleep(NOMINATIM_GAP_MS);
        }
        geo = await geocode(query);
        if (geo) {
          geocodeApproximate = step > 0;
          break;
        }
      }
      geocodeFailed = geo === null;
    }
    // Narrowed before the download, not after: a salon that already has a gallery needs at
    // most a cover out of this import, and one that has both needs no bytes at all. The
    // transaction re-reads the counts and decides for real — this only settles what is worth
    // fetching, and every skip here is a picture we do not pull across somebody's bandwidth.
    // An overwrite wants the whole set whatever the salon holds, so it narrows nothing.
    let wanted = source.images;
    if (!overwrite) {
      const existingPhotos = await selectPhotoCount.get(salon.id);
      wanted =
        existingPhotos.count === 0
          ? source.images
          : source.images.slice(0, isEmpty(salon.image) ? 1 : 0);
    }
    const { stored, partial, capped } = await rehostImages(wanted, req.user.id);

    const written = await db.withTransaction(async (tx) => {
      const result = await writeImport(tx, salon, source, {
        images: stored,
        geo,
        url: link.url,
        consentAt,
        overwrite,
      });

      const warnings = [
        ...source.warnings,
        ...(result.categoryGuessed ? ['category_guessed'] : []),
        // Only where a pin was actually written. The lookup happens before the transaction,
        // and writeImport re-reads the row: a partner who types an address into the form
        // while the page and the gazetteer are being read leaves geocoded false, and the
        // card would otherwise ask them to drag a pin the map has not got.
        ...(geocodeApproximate && result.geocoded ? ['geocode_approximate'] : []),
        ...(geocodeFailed ? ['geocode_failed'] : []),
        ...(partial ? ['images_partial'] : []),
        ...(capped ? ['images_capped'] : []),
      ];
      const summary = {
        mode: source.mode,
        filled: result.filled,
        skipped: result.skipped,
        services_added: result.services_added,
        photos_added: result.photos_added,
        social_links_added: result.social_links_added,
        hours_set: result.hours_set,
        geocoded: result.geocoded,
        warnings,
      };
      // Nothing at all came back — a page behind a script, or a profile that already held
      // everything this import could offer. The form says so rather than claiming a success
      // the partner cannot see anywhere.
      if (
        summary.filled.length === 0 &&
        summary.services_added === 0 &&
        summary.photos_added === 0 &&
        summary.social_links_added === 0 &&
        !summary.hours_set
      ) {
        warnings.push('nothing_found');
      }

      // The stored record carries one field the answer does not: which reading the partner
      // consented to. An import that replaced a profile is the one anybody looking back at
      // this table will want to tell from an import that only filled its blanks.
      await recordImport(tx, salon, source.mode, link.url, consentAt, { ...summary, overwrite });
      return summary;
    });

    res.json({ success: true, data: written });
  } catch (error) {
    next(error);
  }
});

export default router;
