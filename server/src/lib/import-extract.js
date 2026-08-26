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
    address: text(branch.Address) ?? text(branch.ViewAddressV2),
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
    const link = classifyUrl(href);
    if (link?.kind !== 'social' || socialLinks.some((saved) => saved.platform === link.platform)) {
      continue;
    }
    try {
      // The same validation the settings form applies, so an imported link is a link the
      // partner could have typed: a profile page, not a post and not a share redirect.
      socialLinks.push({ platform: link.platform, url: validateSocialProfile(href, link.platform) });
    } catch {
      // A link to a single post is not this salon's page; nothing to store.
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
