/*
 * Reading a salon out of a link somebody pasted — all of it, and nothing else.
 *
 * Every function here is pure: a string or a parsed payload in, a draft out. Nothing in
 * this file opens a socket or touches the database, which is what lets the whole of it be
 * tested against the shapes KiotViet actually answers with (server/test/import-salon.test.mjs)
 * instead of against a machine that has to be online.
 *
 * Two sources, because in Vietnam there are two. A salon on KiotViet has a real menu behind
 * a real API, so that branch reads a menu. Everything else is a website, and a website tells
 * you what its author bothered to mark up: JSON-LD if a plugin wrote some, OpenGraph if not,
 * a tel: link, a few pictures. Facebook and Instagram are neither — they are login walls
 * whose terms forbid this, so classifyUrl names them and the route stops there.
 */
import { validateSocialProfile } from './social-profile.js';
import { normalize } from './text.js';

/* ============================================================================
 * Which kind of link is this
 * ========================================================================= */

// Matched as whole labels: 'facebook.com.evil.test' ends with none of these, and neither
// does 'notfacebook.com'. Both would otherwise be fetched as if they were Facebook.
const SOCIAL_DOMAINS = Object.freeze({
  'facebook.com': 'facebook',
  'fb.com': 'facebook',
  'fb.me': 'facebook',
  'instagram.com': 'instagram',
  'tiktok.com': 'tiktok',
  'zalo.me': 'zalo',
  'zalo.com': 'zalo',
  'youtube.com': 'youtube',
  'youtu.be': 'youtube',
});
const KIOTVIET_BOOKING_HOST = 'booksalon.kiotviet.vn';
// Every KiotViet web store lives on a subdomain of this one.
const KIOTVIET_STORE_DOMAIN = 'web-store.online';
const RETAILER_CODE = /^[A-Za-z0-9_-]{4,64}$/;

function matchesDomain(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/**
 * What a pasted link is, before anything is fetched: a social page we may only store, a
 * KiotViet salon we can read a whole menu from, or a website to be read for what it says.
 *
 * Returns null for anything that is not an ordinary http(s) address — the route turns that
 * into the 400 the form shows beside the field.
 */
export function classifyUrl(rawUrl) {
  const value = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  const url = parsed.href;

  for (const [domain, platform] of Object.entries(SOCIAL_DOMAINS)) {
    if (matchesDomain(hostname, domain)) {
      return { kind: 'social', platform, url };
    }
  }

  if (hostname === KIOTVIET_BOOKING_HOST) {
    // The path segment IS the retailer code: booksalon.kiotviet.vn/4abf76ad.
    const code = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
    if (RETAILER_CODE.test(code)) {
      return { kind: 'kiotviet-booking', retailerCode: code, url };
    }
  }

  if (matchesDomain(hostname, KIOTVIET_STORE_DOMAIN)) {
    return { kind: 'kiotviet-store', url };
  }

  return { kind: 'generic', url };
}

/**
 * The retailer code out of a page that renders a KiotViet booking button.
 *
 * A web store page carries it, and so does many a salon's own site: the "Đặt lịch" button
 * on the homepage is this same link. One regex over the markup rather than a parse, because
 * the only thing being looked for is a URL.
 */
export function extractRetailerCode(html) {
  const match = String(html ?? '').match(
    /booksalon\.kiotviet\.vn\/([A-Za-z0-9_-]{4,64})/,
  );
  return match ? match[1] : null;
}

/* ============================================================================
 * KiotViet
 * ========================================================================= */

/* Ceilings on what an import copies out of a page it did not write. The console's own form
   has no length limit on these columns, but nothing typed there arrives from a stranger:
   an og:description is whatever the remote host felt like sending, up to safe-fetch's 2MB
   page cap, and it would then be served on every public read of that salon. A name, an
   address or a phone number that needs more than MAX_TEXT is not one. */
const MAX_TEXT = 300;
const MAX_DESCRIPTION = 2000;
// Enough for a signed CDN address; the same ceiling the route puts on the pasted link.
const MAX_URL = 2048;

/** A trimmed non-empty string, or null — the shape every "is this column empty?" test wants. */
function text(value, max = MAX_TEXT) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? null : trimmed.slice(0, max);
}

function httpUrl(value) {
  const trimmed = text(value, MAX_URL);
  return trimmed && /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

/**
 * 'HH:MM' out of an ISO datetime, in the offset the string itself states.
 *
 * KiotViet sends '2024-07-27T07:00:31.0970000+07:00' and means seven in the morning at the
 * salon. Read as an instant it would be seven in the morning in whatever timezone this
 * process runs in, which on a UTC host is midnight — so the characters are taken as they
 * are written rather than parsed into a Date.
 */
function localTime(value) {
  const match = String(value ?? '').match(/T(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : null;
}

/**
 * A branch's address, with its ward on the end where the address does not already say it.
 *
 * KiotViet keeps the ward in a field of its own, and keeps Address as free text: a street
 * for one salon, a whole address for the next, a notice to customers for the third. So the
 * two are joined rather than chosen between — a ward is a street's worth of precision to
 * whoever reads the profile, and to whoever looks the address up. WardName arrives as an
 * empty string more often than it arrives filled, which text() has already turned into null.
 *
 * ViewAddressV2 is the fallback and is left whole: it is the address KiotViet itself
 * assembled, ward and district and city included, so there is nothing to add to it.
 */
function branchAddress(branch) {
  const street = text(branch.Address);
  if (!street) {
    return text(branch.ViewAddressV2);
  }
  const ward = text(branch.WardName);
  // Back through text(): two capped strings joined are twice the ceiling, and the reason for
  // the ceiling — this is a stranger's field, served on every public read — has not changed.
  return !ward || wardLine(street).includes(wardLine(ward))
    ? street
    : text(`${street}, ${ward}`);
}

/**
 * An address folded to the form two typings of the same ward share.
 *
 * The salon types its Address by hand and picks its WardName off a list, so the two say the
 * ward in different words as often as not: 'phường Thạch Thang' against 'Phường Thạch Thang',
 * or the 'P.' every second address in the country is written with. A plain includes() calls
 * those different wards and prints both on the profile — the doubled line then being what a
 * public read shows and what the gazetteer is asked for.
 *
 * The prefix is expanded rather than dropped: half the wards in Hồ Chí Minh City are numbers,
 * and a ward stripped to '5' is contained in every district and every house number on the
 * line. Nothing else is guessed at — an address that abbreviates some other way is left to
 * say the ward twice, which reads badly and breaks nothing.
 */
function wardLine(value) {
  return normalize(value)
    .replace(/\bp\s*\.\s*/g, 'phuong ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The salon draft inside a GET /tenant answer: who they are, where, and when they open. */
export function mapTenant(payload) {
  const data = payload?.Data ?? {};
  const branches = Array.isArray(data.Branchs) ? data.Branchs : [];
  const branch = branches[0] ?? {};
  const start = localTime(data.StartTime);
  const end = localTime(data.EndTime);

  const warnings = [];
  // One window for the whole week is all KiotViet holds — there is no per-day shape to read.
  // The console shows seven identical days afterwards, so the partner is told to check them.
  if (start && end) {
    warnings.push('hours_single_window');
  }
  // Only the first branch becomes this salon. OAK's console is built around one salon per
  // partner account, so the others are named rather than silently merged into it.
  if (branches.length > 1) {
    warnings.push('multiple_branches');
  }

  return {
    name: text(data.ShopTitle),
    phone: text(branch.ContactNumber) ?? text(data.Hotline),
    address: branchAddress(branch),
    district: text(branch.District),
    city: text(branch.Province),
    hours: start && end ? { start, end } : null,
    logo: httpUrl(data.Logo),
    background: httpUrl(data.BackgroundImage),
    branchId: Number.isInteger(branch.Id) ? branch.Id : null,
    warnings,
  };
}

// A service with no duration cannot be booked — lib/availability.js lays slots end to end
// by this number — so an hour stands in until the salon says otherwise.
const DEFAULT_DURATION_MIN = 60;
// services.price and services.duration_min are int4. A source number above this is not a
// salon's menu row, and inserting it would abort the whole import transaction with an opaque
// 500 rather than leaving one row unpriced — so it is treated as no number at all.
const MAX_INT4 = 2147483647;

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= MAX_INT4 ? Math.round(number) : null;
}

/** The menu inside a GET /services answer, as rows the services table can take. */
export function mapServices(payload, classify = classifyServiceCategory) {
  const items = Array.isArray(payload?.Data) ? payload.Data : [];
  const rows = items.flatMap((item) => {
    const name = text(item?.Name) ?? text(item?.FullName);
    if (!name) {
      return [];
    }
    return [
      {
        name,
        // BasePrice arrives as a float (370000.0000) and the column counts whole đồng.
        price: count(item?.BasePrice) ?? 0,
        duration_min: count(item?.Duration) ?? DEFAULT_DURATION_MIN,
        category: classify(name),
        guessed: false,
      },
    ];
  });
  return fillMissingCategories(rows);
}

/* ============================================================================
 * Which of the six categories a service name belongs to
 * ========================================================================= */

/* The words are matched against a name folded the way lib/text.js folds a search query —
   lowercase, no diacritics — so 'Nối mi' and 'noi mi' are one thing. Whole words only:
   'mi' as a substring is in half the language, and 'son' is inside a dozen names that have
   nothing to do with a manicure.

   The order below is the whole of the disambiguation. 'Uốn mi Keratin' carries a hair word
   (uốn) and an eyelash word (mi), and it is an eyelash service; 'Massage mặt' carries a spa
   word and a skincare one, and seed.js files it under skincare while 'Massage ấn huyệt cổ
   vai gáy' is spa. The lists were written against seed.js's own menu so an imported salon
   is filed the way the house data is. 'amenity' is deliberately absent: a tea or a sauna
   room is not something a salon's price list calls a service, and guessing one would put a
   bookable row where a perk belongs. */
const CATEGORY_WORDS = Object.freeze([
  ['eyelash', ['mi', 'lash', 'noi mi', 'uon mi']],
  ['nail', [
    'nail', 'mong', 'gel', 'son', 'polish', 'manicure', 'pedicure', 'ombre',
    'da chan', 'got chan', 'da tay', 'tay chan',
  ]],
  ['hair', ['toc', 'hair', 'uon', 'nhuom', 'duoi', 'cat toc', 'goi dau']],
  ['skincare', ['da mat', 'facial', 'cham soc da', 'peel', 'mun', 'massage mat']],
  ['spa', ['massage', 'spa', 'xong', 'tri lieu', 'body', 'foot']],
]);

const CATEGORY_PATTERNS = CATEGORY_WORDS.map(([category, words]) => [
  category,
  new RegExp(`\\b(?:${words.join('|')})\\b`),
]);

/** The category a service name reads as, or null when nothing in it says. */
export function classifyServiceCategory(name) {
  const folded = normalize(name ?? '');
  for (const [category, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(folded)) {
      return category;
    }
  }
  return null;
}

/**
 * Give every unmatched row a category, and mark it as guessed.
 *
 * A nail salon's one oddly-named item is a nail service far more often than it is anything
 * else, so the majority of its siblings decides. With no siblings to go on at all the row
 * falls to 'spa', the broadest of the six. Every guess is flagged, so the route can tell
 * the partner that the categories are worth a look.
 */
function fillMissingCategories(rows) {
  const counts = new Map();
  for (const row of rows) {
    if (row.category) {
      counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
    }
  }
  const [fallback] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['spa'];

  return rows.map((row) =>
    row.category ? row : { ...row, category: fallback, guessed: true },
  );
}

/**
 * A service name folded to the form two spellings of the same service share.
 *
 * The duplicate check on import compares against what the salon already has, and a menu
 * typed by hand differs from an imported one by its capitals and its spacing far more often
 * than by its words.
 */
export function normalizeServiceName(name) {
  return normalize(name ?? '').replace(/\s+/g, ' ').trim();
}

/* ============================================================================
 * Where to look the imported address up
 * ========================================================================= */

/**
 * The queries one import is worth asking a gazetteer, in the order to ask them.
 *
 * The whole line first — street, district, city — because a pin on the door is the point of
 * having one. But the address an import carries is whatever the source keeps in that field,
 * and KiotViet's is free text: the salon this was built against fills it with a booking
 * notice in Korean, which no gazetteer on earth will find. The area on its own resolves
 * where that does not, and a salon pinned on its district is a salon whose owner drags the
 * pin a few streets — better than a profile with no map at all.
 *
 * Never the same string twice: an address that is only a district would otherwise be asked
 * for twice, a second later, for the same answer.
 */
export function geocodeQueries({ address, district, city }) {
  const full = [address, district, city].filter(Boolean).join(', ');
  const area = [district, city].filter(Boolean).join(', ');
  return [full, area].filter(
    (query, index, queries) => query !== '' && queries.indexOf(query) === index,
  );
}

/* ============================================================================
 * An ordinary website
 * ========================================================================= */

/* Every regex below is run over markup a partner's link handed us, up to safe-fetch's 2MB
   page cap, so each one has to be linear in the length of that page — a quadratic scan here
   is a whole-site outage that one import can trigger, the event loop being the thing it
   blocks. Two habits keep them linear:

   - No scan may start in the middle of a run it would then re-walk. The lookbehind on
     ATTRIBUTE is the whole of that: without it, `<img aaaa…a>` (one 2MB word-character run
     and no '=') is retried from every one of those two million offsets, each walking the
     rest of the run. Dropping the \s* around '=' would not help — the blowup is the greedy
     [\w:.-]* giving back one character at a time, at every starting offset.
   - A tag body excludes '<' as well as '>', and is capped. '<' means the runs a failing
     `<img …` scan walks cannot overlap the next one's, so a page of nothing but '<img' is
     read once rather than once per tag; the 4096 cap bounds any single tag regardless. The
     price is one tag: an unescaped '<' inside an attribute value, or a <meta> longer than
     4096 characters, is skipped — and both are already a parse error to a browser. */
const META_TAG = /<meta\b[^<>]{0,4096}>/gi;
const IMG_TAG = /<img\b[^<>]{0,4096}>/gi;
const ANCHOR_TAG = /<a\b[^<>]{0,4096}>/gi;
const ATTRIBUTE = /(?<![\w:.-])([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
// An address written out in running text. One greedy character class with nothing after it
// to make the engine give any of it back, and capped at the longest URL anything here will
// accept, so a page that is two million characters with no space in it is walked once.
const BARE_URL = /https?:\/\/[^\s"'<>]{1,2048}/gi;
// What a sentence puts after an address rather than in one. BARE_URL stops at whitespace and
// at nothing else, so 'Theo dõi tiệm tại https://www.facebook.com/CoconailDN.' hands over the
// full stop as part of the path — and validateSocialProfile's segment check accepts a trailing
// dot, so that dead page would be stored and served. A comma or a closing bracket fails the
// check instead and the salon simply loses its Facebook page. Both are the printing around a
// URL, never the URL, so both come off before anything else looks at the match.
const SENTENCE_TAIL = /[.,;:!?)\]}>"']+$/;
// And a look before the parse, because prose is where the addresses are: a page may print
// ninety thousand of them, and only the ones on a host SOCIAL_DOMAINS already names are
// worth building a URL out of. Written off those same keys so there is one list, not two.
const SOCIAL_URL_HINT = new RegExp(
  `^https?://[^/]{0,255}(?:${Object.keys(SOCIAL_DOMAINS)
    .map((domain) => domain.replace(/\./g, '\\.'))
    .join('|')})(?:[/?#]|$)`,
  'i',
);

/**
 * Keep one page per platform: the first spelling seen, if it is a page at all.
 *
 * Written against a list rather than around one, because the candidates arrive from two
 * readings of a page — its markup, and the contact block nextDataContact reads below — and
 * "the first spelling seen" has to mean the same thing across both.
 */
function addSocialLink(links, candidate) {
  const link = classifyUrl(candidate);
  if (link?.kind !== 'social' || links.some((saved) => saved.platform === link.platform)) {
    return;
  }
  try {
    // The same validation the settings form applies, so an imported link is a link the
    // partner could have typed: a profile page, not a post and not a share redirect.
    links.push({
      platform: link.platform,
      url: validateSocialProfile(candidate, link.platform),
    });
  } catch {
    // A link to a single post is not this salon's page; nothing to store.
  }
}

/** The attributes of one tag, lowercased names to raw values. */
function attributes(tag) {
  const found = {};
  for (const match of tag.matchAll(ATTRIBUTE)) {
    found[match[1].toLowerCase()] = match[2] ?? match[3] ?? '';
  }
  return found;
}

// Enough of an entity decoder for the handful of attributes read here: markup written by a
// CMS escapes ampersands and quotes in a title, and nothing else reliably.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

function decode(value) {
  return String(value ?? '').replace(/&(#\d+|[a-z]+);/gi, (whole, name) => {
    const known = ENTITIES[name.toLowerCase()];
    if (known) {
      return known;
    }
    return name.startsWith('#') ? String.fromCharCode(Number(name.slice(1))) : whole;
  });
}

/**
 * The text the page prints: the bodies of its <script> and <style> blocks left out, and
 * every tag along with them.
 *
 * What is read out of running text has to be text the page meant a reader to see. Inside
 * <script> sits every analytics tag a theme ships, and a Meta pixel's facebook.com/tr is a
 * one-segment Facebook address that would pass for a salon's own page and be stored as it.
 * The same pixel ships a <noscript><img src="…/tr?…"> beside the script — markup no script
 * filter touches — and being in <head> it would outrank the address the footer prints. So
 * the tags go too: every attribute worth reading is read off the tag it belongs to, by the
 * loops above, and nothing in one has any business being found again as prose.
 *
 * Opening tag by regex, closing tag by a second regex whose lastIndex only ever moves
 * forwards — the same shape jsonLdNodes uses below, and for the same reason: a page with a
 * thousand unclosed <script> tags must not send a lazy quantifier to the end of it a
 * thousand times. Both regexes are built here rather than at module scope because exec()
 * carries lastIndex on the object, and two imports read two pages at once.
 */
function prose(html) {
  const open = /<(?:script|style)\b[^<>]{0,4096}>/gi;
  const close = /<\/(?:script|style)\s*>/gi;
  // A tag body excludes '<' for the reason META_TAG and its siblings above do, and it is the
  // whole reason this is linear: the scan for a tag that never closes stops at the next '<'
  // rather than running to the end of the page, so a page of nothing but '<a href' is walked
  // once instead of once per '<'. The price is the same one tag those regexes pay.
  const withoutTags = (parts) => parts.join(' ').replace(/<[^<>]*>/g, ' ');
  const kept = [];
  let from = 0;
  let block;
  while ((block = open.exec(html)) !== null) {
    kept.push(html.slice(from, block.index));
    close.lastIndex = open.lastIndex;
    // Nothing closes it: a browser reads the rest of the page as script, and so do we.
    if (close.exec(html) === null) {
      return withoutTags(kept);
    }
    from = close.lastIndex;
    open.lastIndex = from;
  }
  kept.push(html.slice(from));
  return withoutTags(kept);
}

const LD_CLOSE = '</script>';

/** Every JSON-LD node on the page, flattened out of its @graph and array wrappers. */
function jsonLdNodes(html) {
  const nodes = [];
  // The closing tag is found with indexOf rather than by a lazy [\s\S]*? inside the regex: a
  // page carrying a thousand opening tags and no closing one would send that quantifier to
  // the end of the page a thousand times over. lastIndex only ever moves forwards past a
  // block that has been read, so every byte of the page is walked once however they fall.
  const open = /<script\b[^<>]{0,4096}type\s*=\s*["']application\/ld\+json["'][^<>]{0,4096}>/gi;
  let block;
  while ((block = open.exec(html)) !== null) {
    const from = block.index + block[0].length;
    const to = html.indexOf(LD_CLOSE, from);
    if (to === -1) {
      break;
    }
    open.lastIndex = to + LD_CLOSE.length;

    let parsed;
    try {
      parsed = JSON.parse(html.slice(from, to));
    } catch {
      // A page with one broken block still has its other blocks and its meta tags.
      continue;
    }
    const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
    while (queue.length > 0) {
      const node = queue.shift();
      if (node === null || typeof node !== 'object') {
        continue;
      }
      if (Array.isArray(node['@graph'])) {
        queue.push(...node['@graph']);
      }
      nodes.push(node);
    }
  }
  return nodes;
}

// The schema.org types a beauty business is published as. A page marked up only as an
// Organization or a WebSite says nothing about where to go or when they open, so it is left
// to OpenGraph like any other page.
const BUSINESS_TYPES = new Set([
  'localbusiness', 'beautysalon', 'hairsalon', 'nailsalon', 'healthandbeautybusiness', 'dayspa',
]);

function isBusiness(node) {
  const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  return types.some((type) => BUSINESS_TYPES.has(String(type ?? '').toLowerCase()));
}

const WEEKDAYS = Object.freeze({
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
});

function weekdayOfName(value) {
  // Written either as a bare name or as the full https://schema.org/Monday IRI.
  const name = String(value ?? '').split('/').pop().toLowerCase();
  return Object.hasOwn(WEEKDAYS, name) ? WEEKDAYS[name] : null;
}

function clockTime(value) {
  const match = String(value ?? '').match(/^(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : null;
}

/** openingHoursSpecification as the per-weekday rows salon_hours stores. */
function openingHours(node) {
  const raw = node.openingHoursSpecification;
  const entries = Array.isArray(raw) ? raw : [raw];
  const rows = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    const start = clockTime(entry.opens);
    const end = clockTime(entry.closes);
    if (!start || !end || start >= end) {
      continue;
    }
    const days = Array.isArray(entry.dayOfWeek) ? entry.dayOfWeek : [entry.dayOfWeek];
    for (const day of days) {
      const weekday = weekdayOfName(day);
      // First mention of a day wins: a page listing the same day twice is listing a break,
      // and salon_hours holds one window per day.
      if (weekday !== null && !rows.some((row) => row.weekday === weekday)) {
        rows.push({ weekday, start, end });
      }
    }
  }
  return rows.sort((a, b) => a.weekday - b.weekday);
}

/** The named services inside hasOfferCatalog / makesOffer, priced where they say so. */
function offeredServices(node) {
  const catalogs = [node.hasOfferCatalog, node.makesOffer, node.hasOfferCatalog?.itemListElement]
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value) => value !== null && typeof value === 'object');

  const services = [];
  for (const offer of catalogs) {
    const offered = offer.itemOffered ?? offer;
    const name = text(offered?.name);
    if (!name || services.some((service) => service.name === name)) {
      continue;
    }
    services.push({
      name,
      price: count(offer.price ?? offered.price ?? offer.priceSpecification?.price),
    });
  }
  return services;
}

function postalAddress(node) {
  const address = Array.isArray(node.address) ? node.address[0] : node.address;
  if (typeof address === 'string') {
    return { address: text(address), district: null, city: null };
  }
  if (address === null || typeof address !== 'object') {
    return { address: null, district: null, city: null };
  }
  const region = text(address.addressRegion);
  const locality = text(address.addressLocality);
  // A Vietnamese address is street, district, city. A page that fills both fields means
  // locality as the district; one that fills only locality means the city.
  return {
    address: text(address.streetAddress),
    district: region ? locality : null,
    city: region ?? locality,
  };
}

// How many pictures are worth carrying off one page: the cover plus a gallery row.
const MAX_IMAGES = 6;

/**
 * What an ordinary salon website gives up about itself.
 *
 * Best effort by definition — a page marked up by a booking plugin hands over an address,
 * a week of hours and a price list; a page that is one background image and a phone number
 * hands over a phone number. Everything is optional and nothing here throws: whatever comes
 * back fills the columns the salon left empty, and the rest stays the partner's to type.
 */
export function parseGenericHtml(html, baseUrl) {
  const source = String(html ?? '');
  const business = jsonLdNodes(source).find(isBusiness) ?? {};

  const meta = {};
  for (const tag of source.matchAll(META_TAG)) {
    const found = attributes(tag[0]);
    const key = (found.property ?? found.name ?? '').toLowerCase();
    if (key.startsWith('og:') && found.content && !Object.hasOwn(meta, key)) {
      meta[key] = decode(found.content);
    }
  }

  /** An absolute http(s) address, or null — relative sources resolve against the page. */
  const absolute = (value) => {
    try {
      const resolved = new URL(decode(value), baseUrl);
      return resolved.protocol === 'http:' || resolved.protocol === 'https:'
        ? resolved.href
        : null;
    } catch {
      return null;
    }
  };

  const images = [];
  const addImage = (value) => {
    const url = value ? absolute(value) : null;
    if (url && !images.includes(url) && images.length < MAX_IMAGES) {
      images.push(url);
    }
  };
  // The cover the page chose for itself comes first, then whatever is on it in page order.
  addImage(meta['og:image']);
  addImage(typeof business.image === 'string' ? business.image : business.image?.url);
  for (const tag of source.matchAll(IMG_TAG)) {
    addImage(attributes(tag[0]).src);
  }

  let telephone = text(business.telephone);
  const socialLinks = [];

  for (const tag of source.matchAll(ANCHOR_TAG)) {
    const href = decode(attributes(tag[0]).href ?? '');
    if (!telephone && href.toLowerCase().startsWith('tel:')) {
      telephone = text(decodeURIComponent(href.slice(4)));
      continue;
    }
    addSocialLink(socialLinks, href);
  }
  // Then the addresses the page printed instead of linking. A KiotViet web store writes its
  // contact block as text — the Facebook address sits in a paragraph with no href anywhere
  // near it — which is why the first live import of one came back with no social link at
  // all. Read after the anchors, so a real link still speaks for its platform first.
  for (const found of prose(source).matchAll(BARE_URL)) {
    if (SOCIAL_URL_HINT.test(found[0])) {
      addSocialLink(socialLinks, decode(found[0]).replace(SENTENCE_TAIL, ''));
    }
  }

  const address = postalAddress(business);
  // Bounded here, not only checked for being a number: PATCH /api/partner/salon refuses a
  // latitude outside ±90 or a longitude outside ±180, and an import may not write into those
  // columns what the console's own validator would send back.
  const latitude = Number(business.geo?.latitude);
  const longitude = Number(business.geo?.longitude);
  const located =
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180;

  return {
    name: text(business.name) ?? text(meta['og:title']),
    description:
      text(business.description, MAX_DESCRIPTION) ??
      text(meta['og:description'], MAX_DESCRIPTION),
    phone: telephone,
    ...address,
    hours: openingHours(business),
    services: offeredServices(business),
    images,
    socialLinks,
    geo: located ? { lat: latitude, lng: longitude } : null,
  };
}

/* ============================================================================
 * The contact block a KiotViet web store keeps inside its page
 * ========================================================================= */

/* A web store is a Next.js page, and a Next.js page ships the props it was rendered from in
   a <script id="__NEXT_DATA__" type="application/json"> blob. The store's contact block sits
   in there — a phone, a Facebook page, a Zalo number, and the reason any of this is read at
   all: an address that is an address. KiotViet's own Branchs[].Address is free text, and the
   salon this was built against fills it with a booking notice in Korean, while the block
   below is the field the page's own map link is built out of.

   Found by shape rather than by path. props.pageProps.<something>.contact is where it sits
   today, and a Next.js release or a theme rewrite moves it; an object holding an address with
   a Facebook page or a Zalo number beside it is the same block wherever it has been moved to.
   The blob holds the branch record as well, nearer its root, so the shape has to be narrow
   enough to tell the two apart — see CONTACT_KEYS. */
const NEXT_DATA_TAG =
  /<script\b[^<>]{0,4096}(?<![\w:.-])id\s*=\s*["']__NEXT_DATA__["'][^<>]{0,4096}>/i;
const SCRIPT_CLOSE = '</script>';
// The whole page is already capped at 2MB by safe-fetch, so a blob longer than that is a
// page nothing on it can be trusted to say. Cheaper to refuse than to hand to JSON.parse.
const MAX_NEXT_DATA = 2 * 1024 * 1024;
// A blob is props, and props are a whole page's worth of them: a store with a long menu
// carries tens of thousands of nodes. Far enough in to pass the contact block on every shape
// seen, and a ceiling all the same — the walk is on the event loop the whole site shares.
const MAX_CONTACT_NODES = 20_000;
/* What tells the contact block apart from everything else in the blob that holds an address.
   A phone does not: the blob carries KiotViet's own branch records too, and a branch record
   is an address and a phone side by side — the branch free text being the very string this
   whole reading exists to get away from. On the store this was built against that record sits
   nearer the root than the contact block does, so "an address with a phone beside it" finds
   the Korean booking notice and nothing is gained. A Facebook page or a Zalo number is a
   field only a contact card has. Where a store fills in neither, this reads nothing and the
   tenant's free text stands, which is where it stood before. */
const CONTACT_KEYS = ['facebook_url', 'zalo_url'];
const NO_CONTACT = { address: null, phone: null, facebookUrl: null, zaloUrl: null };

/** The first object in a parsed blob that is shaped like a contact block, or null. */
function findContact(root) {
  const queue = [root];
  // Read with an index rather than shift(): a blob's arrays run to thousands of entries, and
  // shifting one off the front of a queue that long is the whole queue moved each time.
  for (let at = 0; at < queue.length && at < MAX_CONTACT_NODES; at += 1) {
    const node = queue[at];
    if (node === null || typeof node !== 'object') {
      continue;
    }
    if (
      !Array.isArray(node) &&
      typeof node.address === 'string' &&
      CONTACT_KEYS.some((key) => typeof node[key] === 'string')
    ) {
      return node;
    }
    for (const value of Object.values(node)) {
      if (value !== null && typeof value === 'object') {
        queue.push(value);
      }
    }
  }
  return null;
}

/**
 * What a Next.js page says about how to reach the shop it renders.
 *
 * The first __NEXT_DATA__ block only, its closing tag found with indexOf rather than by a
 * lazy quantifier — the same forward-only reading jsonLdNodes makes, and for the same reason:
 * a page carrying a thousand opening tags and no closing one must not send a scan to the end
 * of it a thousand times. A blob that is not JSON is a page that says nothing, not an error:
 * everything here is optional, and the tenant is still holding an answer for every field.
 */
export function nextDataContact(html) {
  const source = String(html ?? '');
  const open = source.match(NEXT_DATA_TAG);
  if (!open) {
    return { ...NO_CONTACT };
  }
  const from = open.index + open[0].length;
  const to = source.indexOf(SCRIPT_CLOSE, from);
  if (to === -1 || to - from > MAX_NEXT_DATA) {
    return { ...NO_CONTACT };
  }

  let parsed;
  try {
    parsed = JSON.parse(source.slice(from, to));
  } catch {
    return { ...NO_CONTACT };
  }
  const contact = findContact(parsed);
  if (!contact) {
    return { ...NO_CONTACT };
  }
  return {
    address: text(contact.address),
    phone: text(contact.phone),
    facebookUrl: text(contact.facebook_url, MAX_URL),
    zaloUrl: text(contact.zalo_url, MAX_URL),
  };
}

/**
 * The Zalo field as a link, the owner having typed either.
 *
 * zalo_url holds a phone number about as often as it holds an address — the store's own
 * button builds one out of the other — and zalo.me/<number> is the page Zalo opens a chat
 * from. Anything else that is neither a number nor an http(s) address is left for
 * validateSocialProfile to refuse, which is where every other candidate is refused too.
 */
function zaloLink(value) {
  const raw = text(value, MAX_URL);
  if (!raw || /^https?:\/\//i.test(raw)) {
    return raw;
  }
  const digits = raw.replace(/[\s.+-]/g, '');
  return /^\d{8,15}$/.test(digits) ? `https://zalo.me/${digits}` : null;
}

/** The page's markup links, with the contact block's own filling whatever they left empty. */
export function mergeContactSocialLinks(socialLinks, contact) {
  const links = [...socialLinks];
  addSocialLink(links, contact.facebookUrl);
  addSocialLink(links, zaloLink(contact.zaloUrl));
  return links;
}
