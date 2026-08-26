/* "Dán link salon của bạn" — the reading half of it (lib/import-extract.js) and the guard
   that stands in front of every request it makes (lib/safe-fetch.js).

   The KiotViet fixtures below are the shapes their API actually answered with on
   2026-08-26, trimmed to the fields the import reads: a tenant and the first of its
   twenty-one services. Written down here rather than fetched, so a run of this file never
   leaves the machine and a change upstream is a test that fails rather than a salon whose
   draft comes back empty.

   safe-fetch is exercised on addresses that resolve without a DNS query at all — a literal
   private IP, localhost, ::1 — so the refusals it makes are proven with no network in the
   room. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  classifyServiceCategory,
  classifyUrl,
  extractRetailerCode,
  mapServices,
  mapTenant,
  normalizeServiceName,
  parseGenericHtml,
} from '../src/lib/import-extract.js';
import { UnsafeUrlError, isPrivateAddress, safeFetch } from '../src/lib/safe-fetch.js';
import { SocialProfileError, validateSocialProfile } from '../src/lib/social-profile.js';

const TENANT = {
  Status: 1,
  Data: {
    ShopTitle: 'CoCo Nail(코코네일) & Shampoo & Make-Up',
    Hotline: '0338211881',
    Branchs: [
      {
        Id: 4700,
        Name: 'CoCo Nail Dn',
        Address: '43 Nguyễn Chí Thanh',
        District: 'Quận Hải Châu',
        Province: 'Đà Nẵng',
        WardName: '',
        ContactNumber: '0338211881',
        ViewAddressV2: '43 Nguyễn Chí Thanh, Quận Hải Châu, Đà Nẵng',
      },
    ],
    StartTime: '2024-07-27T07:00:31.0970000+07:00',
    EndTime: '2024-07-27T18:30:31.0970000+07:00',
    Logo: 'https://cdn-booking.kiotviet.vn/43coconail/avatar-edca.jpg',
    BackgroundImage: 'https://cdn-booking.kiotviet.vn/43coconail/avatar-6a9c.jpg',
    Currency: { Code: 'VND' },
    IsShowPrice: true,
  },
};

const SERVICES = {
  Status: 1,
  Data: [
    {
      Id: 186672,
      CategoryId: 28344,
      Name: '1.Combo 1 : tay+chân Nhặt da+sơn gel thường',
      FullName: '1.Combo 1 : tay+chân Nhặt da+sơn gel thường',
      Code: 'SP000025',
      BasePrice: 370000.4,
      Unit: '',
      MasterCode: 'SPC000025',
      Duration: 90,
    },
    { Id: 186673, Name: 'Chà gót chân', BasePrice: 90000.0, Duration: 30 },
    { Id: 186674, Name: 'Gội đầu dưỡng sinh', BasePrice: 120000.0, Duration: 45 },
    { Id: 186675, Name: 'Nối mi volume', BasePrice: 350000.0, Duration: 120 },
  ],
};

/* ── classifyUrl ─────────────────────────────────────────────────────────── */

test('a pasted social link is recognised by host, subdomains and short domains included', () => {
  const social = [
    ['https://www.facebook.com/CocoNailDN', 'facebook'],
    ['https://m.facebook.com/CocoNailDN', 'facebook'],
    ['https://fb.me/CocoNailDN', 'facebook'],
    ['https://www.instagram.com/coco.nail/', 'instagram'],
    ['https://vt.tiktok.com/ZS8Wm1234/', 'tiktok'],
    ['https://youtu.be/dQw4w9WgXcQ', 'youtube'],
    ['https://zalo.me/0338211881', 'zalo'],
  ];
  for (const [url, platform] of social) {
    assert.deepEqual(
      { kind: classifyUrl(url).kind, platform: classifyUrl(url).platform },
      { kind: 'social', platform },
      url,
    );
  }
});

test('a host that merely contains a social domain is not one', () => {
  // The suffix has to be a whole label, or facebook.com.evil.test would be fetched as
  // Facebook — and never fetched at all, which is worse: it would be stored as a link.
  assert.equal(classifyUrl('https://facebook.com.evil.test/CocoNail').kind, 'generic');
  assert.equal(classifyUrl('https://notfacebook.com/CocoNail').kind, 'generic');
});

test('a booking link carries the retailer code in its path; a store page has to be read', () => {
  assert.deepEqual(classifyUrl('https://booksalon.kiotviet.vn/4abf76ad'), {
    kind: 'kiotviet-booking',
    retailerCode: '4abf76ad',
    url: 'https://booksalon.kiotviet.vn/4abf76ad',
  });
  assert.equal(classifyUrl('https://43coconail.web-store.online/').kind, 'kiotviet-store');
  assert.equal(classifyUrl('https://coconail.vn/bang-gia').kind, 'generic');
});

test('anything that is not an http(s) address is not classified at all', () => {
  for (const value of ['', '   ', 'coconail.vn', 'ftp://coconail.vn', 'javascript:alert(1)', null]) {
    assert.equal(classifyUrl(value), null, String(value));
  }
});

/* ── extractRetailerCode ─────────────────────────────────────────────────── */

test('the retailer code is read out of the booking link a store page renders', () => {
  const html = `<a class="btn" href="https://booksalon.kiotviet.vn/4abf76ad" target="_blank">Đặt lịch</a>`;
  assert.equal(extractRetailerCode(html), '4abf76ad');
  assert.equal(extractRetailerCode('<p>Không có link nào</p>'), null);
});

/* ── mapTenant ───────────────────────────────────────────────────────────── */

test('the tenant becomes a salon draft, with the hours read in the offset they carry', () => {
  const draft = mapTenant(TENANT);

  assert.equal(draft.name, 'CoCo Nail(코코네일) & Shampoo & Make-Up');
  assert.equal(draft.phone, '0338211881');
  assert.equal(draft.address, '43 Nguyễn Chí Thanh');
  assert.equal(draft.district, 'Quận Hải Châu');
  assert.equal(draft.city, 'Đà Nẵng');
  assert.equal(draft.branchId, 4700);
  assert.equal(draft.logo, 'https://cdn-booking.kiotviet.vn/43coconail/avatar-edca.jpg');
  assert.equal(draft.background, 'https://cdn-booking.kiotviet.vn/43coconail/avatar-6a9c.jpg');
  // +07:00 is stated in the string itself: 07:00 there is 07:00 to the salon, whatever
  // timezone this process happens to run in.
  assert.deepEqual(draft.hours, { start: '07:00', end: '18:30' });
  assert.deepEqual(draft.warnings, ['hours_single_window']);
});

test('a tenant with two branches says so, and the draft is the first branch', () => {
  const twoBranches = {
    Status: 1,
    Data: {
      ...TENANT.Data,
      Branchs: [TENANT.Data.Branchs[0], { Id: 4701, Name: 'CoCo Nail HCM', Address: 'Quận 1' }],
    },
  };
  const draft = mapTenant(twoBranches);
  assert.equal(draft.branchId, 4700);
  assert.ok(draft.warnings.includes('multiple_branches'));
});

test('a tenant that answered with nothing usable maps to nothing, not to a crash', () => {
  for (const payload of [null, {}, { Status: 0 }, { Status: 1, Data: {} }]) {
    const draft = mapTenant(payload);
    assert.equal(draft.name, null);
    assert.equal(draft.hours, null);
  }
});

/* ── mapServices ─────────────────────────────────────────────────────────── */

test('a service list becomes menu rows: VND integers, minutes, a category each', () => {
  const rows = mapServices(SERVICES);

  assert.equal(rows.length, 4);
  assert.deepEqual(
    { name: rows[0].name, price: rows[0].price, duration_min: rows[0].duration_min },
    {
      name: '1.Combo 1 : tay+chân Nhặt da+sơn gel thường',
      price: 370000, // BasePrice is a float; the column is an integer number of đồng.
      duration_min: 90,
    },
  );
  assert.deepEqual(rows.map((row) => row.category), ['nail', 'nail', 'hair', 'eyelash']);
  assert.ok(rows.every((row) => row.guessed === false));
});

test('a name nothing matches takes the category its siblings mostly had, and says so', () => {
  const rows = mapServices({
    Status: 1,
    Data: [
      { Name: 'Sơn gel', BasePrice: 150000, Duration: 60 },
      { Name: 'Đắp gel nối móng', BasePrice: 250000, Duration: 90 },
      { Name: 'Dịch vụ đặc biệt của tiệm', BasePrice: 500000, Duration: 60 },
    ],
  });

  assert.equal(rows[2].category, 'nail');
  assert.equal(rows[2].guessed, true);
});

test('an unreadable service list is an empty menu, and a nameless row is dropped', () => {
  assert.deepEqual(mapServices(null), []);
  assert.deepEqual(mapServices({ Status: 1, Data: [{ BasePrice: 100000 }] }), []);
});

test('a number too big for the int4 column falls back rather than sinking the import', () => {
  // services.price and services.duration_min are int4. Inserting 9.9e12 would abort the whole
  // transaction — the profile, the week and the rest of the menu with it — so the row keeps
  // its name and loses only the number, exactly as a row that named no price at all does.
  const [row] = mapServices({
    Status: 1,
    Data: [{ Name: 'Sơn gel', BasePrice: 9_900_000_000_000, Duration: 4_000_000_000 }],
  });
  assert.equal(row.name, 'Sơn gel');
  assert.equal(row.price, 0);
  assert.equal(row.duration_min, 60);

  // The ceiling itself is still a number the column holds.
  const [edge] = mapServices({ Status: 1, Data: [{ Name: 'Sơn gel', BasePrice: 2147483647 }] });
  assert.equal(edge.price, 2147483647);
});

test('a name or a description longer than the column expects is cut, not copied whole', () => {
  // og:description is whatever the remote host felt like sending, up to safe-fetch's 2MB cap,
  // and it would be served on every public read of the salon afterwards.
  const [row] = mapServices({ Status: 1, Data: [{ Name: 'x'.repeat(5000) }] });
  assert.equal(row.name.length, 300);

  const draft = parseGenericHtml(
    `<script type="application/ld+json">${JSON.stringify({
      '@type': 'BeautySalon',
      name: 'n'.repeat(5000),
      address: { streetAddress: 'a'.repeat(5000) },
      telephone: 'p'.repeat(5000),
    })}</script>
     <meta property="og:description" content="${'d'.repeat(3000)}">`,
    'https://coconail.vn/',
  );
  assert.equal(draft.name.length, 300);
  assert.equal(draft.address.length, 300);
  assert.equal(draft.phone.length, 300);
  assert.equal(draft.description.length, 2000);
});

test('two spellings of one service name fold together for the duplicate check', () => {
  assert.equal(
    normalizeServiceName('  Sơn   Gel  Hàn   Quốc '),
    normalizeServiceName('sơn gel hàn quốc'),
  );
  assert.notEqual(normalizeServiceName('Nối mi Classic'), normalizeServiceName('Nối mi Volume'));
});

/* ── classifyServiceCategory ─────────────────────────────────────────────── */

test('service names land in the six categories the menu already uses', () => {
  const expected = [
    ['1.Combo 1 : tay+chân Nhặt da+sơn gel thường', 'nail'],
    ['Chà gót chân', 'nail'],
    ['Chăm sóc da tay chuyên sâu', 'nail'], // seed.js files this under nail, not skincare.
    ['Gội đầu dưỡng sinh', 'hair'],
    ['Uốn xoăn lơi Hàn Quốc', 'hair'],
    ['Nối mi volume', 'eyelash'],
    ['Uốn mi Keratin', 'eyelash'], // 'uốn' is a hair word; 'mi' outranks it.
    ['Chăm sóc da mặt', 'skincare'],
    ['Massage mặt', 'skincare'], // ...but a body massage is spa. seed.js splits them so.
    ['Massage ấn huyệt cổ vai gáy', 'spa'],
    ['Trị liệu thảo mộc', 'spa'],
  ];
  for (const [name, category] of expected) {
    assert.equal(classifyServiceCategory(name), category, name);
  }
  assert.equal(classifyServiceCategory('Dịch vụ đặc biệt của tiệm'), null);
});

/* ── parseGenericHtml ────────────────────────────────────────────────────── */

const GENERIC_HTML = `
<!doctype html><html><head>
<meta property="og:title" content="Coco Nail Đà Nẵng">
<meta property="og:description" content="Tiệm nail nhỏ trên đường Nguyễn Chí Thanh.">
<meta property="og:image" content="/img/cover.jpg">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "BeautySalon",
  "name": "Coco Nail",
  "telephone": "+84 338 211 881",
  "address": {
    "@type": "PostalAddress",
    "streetAddress": "43 Nguyễn Chí Thanh",
    "addressLocality": "Quận Hải Châu",
    "addressRegion": "Đà Nẵng"
  },
  "geo": { "@type": "GeoCoordinates", "latitude": 16.0678, "longitude": 108.2208 },
  "openingHoursSpecification": [
    { "dayOfWeek": ["https://schema.org/Monday", "Tuesday"], "opens": "08:00", "closes": "20:00" }
  ],
  "hasOfferCatalog": {
    "itemListElement": [
      { "itemOffered": { "@type": "Service", "name": "Sơn gel" }, "price": "150000" }
    ]
  }
}
</script>
</head><body>
<a href="tel:0338211881">Gọi ngay</a>
<a href="https://www.facebook.com/CocoNailDN">Facebook</a>
<a href="https://www.instagram.com/coco.nail/">Instagram</a>
<img src="https://cdn.coconail.vn/nail-1.jpg">
<img src="data:image/gif;base64,R0lGOD">
</body></html>`;

test('a plain website gives up its name, address, phone, hours, links and pictures', () => {
  const draft = parseGenericHtml(GENERIC_HTML, 'https://coconail.vn/gioi-thieu');

  assert.equal(draft.name, 'Coco Nail');
  assert.equal(draft.description, 'Tiệm nail nhỏ trên đường Nguyễn Chí Thanh.');
  assert.equal(draft.address, '43 Nguyễn Chí Thanh');
  assert.equal(draft.district, 'Quận Hải Châu');
  assert.equal(draft.city, 'Đà Nẵng');
  assert.equal(draft.phone, '+84 338 211 881');
  assert.deepEqual(draft.geo, { lat: 16.0678, lng: 108.2208 });
  assert.deepEqual(draft.services, [{ name: 'Sơn gel', price: 150000 }]);

  // Monday is weekday 1, Tuesday 2 — the same numbering salon_hours already stores.
  assert.deepEqual(draft.hours, [
    { weekday: 1, start: '08:00', end: '20:00' },
    { weekday: 2, start: '08:00', end: '20:00' },
  ]);

  assert.deepEqual(draft.socialLinks, [
    { platform: 'facebook', url: 'https://www.facebook.com/CocoNailDN' },
    { platform: 'instagram', url: 'https://www.instagram.com/coco.nail' },
  ]);

  // Relative sources are resolved against the page they were read from, and a data: URL
  // is not something to re-host.
  assert.deepEqual(draft.images, [
    'https://coconail.vn/img/cover.jpg',
    'https://cdn.coconail.vn/nail-1.jpg',
  ]);
});

test('a page with nothing on it parses to a draft with nothing in it', () => {
  const draft = parseGenericHtml('<html><body><p>Xin chào</p></body></html>', 'https://coconail.vn/');
  assert.equal(draft.name, null);
  assert.equal(draft.address, null);
  assert.deepEqual(draft.images, []);
  assert.deepEqual(draft.services, []);
});

test('a coordinate outside the globe is no coordinate at all', () => {
  // PATCH /api/partner/salon refuses a latitude outside ±90 or a longitude outside ±180, and
  // an import must not write into those columns what the console's own validator would send
  // back. A page carrying a swapped or mistyped pair simply arrives without a pin.
  const withGeo = (geo) =>
    parseGenericHtml(
      `<script type="application/ld+json">${JSON.stringify({
        '@type': 'BeautySalon',
        name: 'Coco Nail',
        geo,
      })}</script>`,
      'https://coconail.vn/',
    ).geo;

  assert.deepEqual(withGeo({ latitude: 16.0678, longitude: 108.2208 }), {
    lat: 16.0678,
    lng: 108.2208,
  });
  assert.equal(withGeo({ latitude: 108.2208, longitude: 16.0678 }), null); // Swapped.
  assert.equal(withGeo({ latitude: 16.0678, longitude: 1082208 }), null);
  assert.equal(withGeo({ latitude: -91, longitude: 0 }), null);
});

test('a page built to make these scans quadratic is still read in a moment', () => {
  /* Every regex parseGenericHtml runs walks markup a partner's link handed us, up to
     safe-fetch's 2MB cap, on the event loop the whole site shares. A quadratic one is a
     site-wide outage a single import can trigger, so the shapes that used to cause one are
     pinned here: one enormous attribute-less tag (the ATTRIBUTE name run backtracking from
     every offset), a page of nothing but opening tags with no '>' anywhere, and a thousand
     JSON-LD blocks that never close. */
  const pages = [
    `<img ${'a'.repeat(2 * 1024 * 1024)}>`,
    `<img src="${'a'.repeat(2 * 1024 * 1024)}`,
    '<img '.repeat(400_000),
    '<a href'.repeat(300_000),
    '<meta '.repeat(350_000),
    `<script type="application/ld+json">{`.repeat(50_000),
  ];

  for (const html of pages) {
    const started = process.hrtime.bigint();
    parseGenericHtml(html, 'https://coconail.vn/');
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 1000, `${ms.toFixed(0)}ms on a ${html.length} byte page`);
  }
});

test('broken JSON-LD is skipped rather than fatal', () => {
  const html = `<script type="application/ld+json">{ not json </script>
    <meta property="og:title" content="Coco Nail">`;
  assert.equal(parseGenericHtml(html, 'https://coconail.vn/').name, 'Coco Nail');
});

/* ── safe-fetch ──────────────────────────────────────────────────────────── */

test('every address that leads back inside the network is refused', () => {
  const private_ = [
    '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '169.254.169.254',
    '0.0.0.0', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1',
    // Not "private" in the 1918 sense, but no more a salon's website for that: carrier-grade
    // NAT is the internal fabric of several container hosts, and the last quarter of the
    // address space is multicast and reserved.
    '100.64.0.1', '100.127.255.255', '192.0.0.1', '198.18.0.1', '198.19.255.255',
    '224.0.0.1', '239.255.255.250', '255.255.255.255',
  ];
  for (const address of private_) {
    assert.equal(isPrivateAddress(address), true, address);
  }

  const public_ = [
    '43.239.223.1', '172.32.0.1', '172.15.0.1', '8.8.8.8', '2606:4700::1111',
    // The addresses just outside each of the ranges above.
    '100.63.255.255', '100.128.0.1', '192.0.1.1', '198.17.255.255', '198.20.0.1', '223.255.255.255',
  ];
  for (const address of public_) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test('a URL pointing at this machine never reaches fetch', async () => {
  // None of these need a DNS server: a literal address is its own answer, and localhost is
  // resolved from the hosts file. A green run here is proof with no network involved.
  const refused = [
    'http://10.0.0.1/tenant',
    'http://localhost:8080/tenant',
    'http://127.0.0.1/tenant',
    'http://[::1]/tenant',
    'http://169.254.169.254/latest/meta-data/',
  ];
  for (const url of refused) {
    await assert.rejects(safeFetch(url), UnsafeUrlError, url);
  }
});

test('a scheme, a port or a credential that is not ordinary is refused too', async () => {
  const refused = [
    'ftp://coconail.vn/',
    'file:///etc/passwd',
    'http://coconail.vn:8080/',
    'https://user:pass@coconail.vn/',
    'not a url at all',
  ];
  for (const url of refused) {
    await assert.rejects(safeFetch(url), UnsafeUrlError, url);
  }
});

/* The three tests below are the only ones here that let safeFetch reach `fetch` at all, so
   the global is swapped for the duration and put back afterwards. The first hop is always a
   literal public address: dns.lookup answers a numeric host out of its own hand, so these
   stay as network-free as the refusals above. */
async function withFetch(respond, work) {
  const real = globalThis.fetch;
  globalThis.fetch = respond;
  try {
    await work();
  } finally {
    globalThis.fetch = real;
  }
}

const redirectTo = (location) =>
  async () => new Response(null, { status: 302, headers: { location } });

test('a redirect into the network is refused at the hop that answers it', async () => {
  // The whole point of following redirects by hand: the first host is public and passes, and
  // the address it sends us to is the metadata service.
  await withFetch(redirectTo('http://169.254.169.254/latest/meta-data/'), async () => {
    await assert.rejects(safeFetch('http://93.184.216.34/'), UnsafeUrlError);
  });
});

test('the caller’s own refusal is asked of every hop, not only of the first', async () => {
  // What routes/import-salon.js passes: nothing on a social page is ever fetched, and a
  // 302 must not be a way around that.
  const refuseUrl = (url) => (classifyUrl(url)?.kind === 'social' ? 'mạng xã hội' : null);

  await withFetch(redirectTo('https://www.facebook.com/CocoNailDN'), async () => {
    await assert.rejects(safeFetch('http://93.184.216.34/', { refuseUrl }), UnsafeUrlError);
  });
});

test('a body over the cap is refused while it arrives, not once it has all arrived', async () => {
  let chunksProduced = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      chunksProduced += 1;
      // Ends on its own eventually, so a fetcher that buffered the lot would finish rather
      // than hang — and would leave `cancelled` false, which is what this test is watching.
      if (chunksProduced > 64) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(1024));
    },
    cancel() {
      cancelled = true;
    },
  });

  await withFetch(
    async () => new Response(body, { headers: { 'content-type': 'text/html' } }),
    async () => {
      await assert.rejects(safeFetch('http://93.184.216.34/', { maxBytes: 4096 }), /cap/);
    },
  );

  assert.equal(cancelled, true);
  assert.ok(chunksProduced <= 16, `${chunksProduced} KB read past a 4096 byte cap`);
});

/* ── the route itself ────────────────────────────────────────────────────── */

/* routes/import-salon.js imports db.js, which opens a database connection the moment it is
   imported, so the router body is lifted and driven in a context of stubs instead — the
   trick geo-route.test.mjs, events-route.test.mjs and assistant-parser.test.mjs all use.
   The extraction libraries go in for real: what is faked here is the database, the network
   and the image store, and nothing else. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routeJs = fs.readFileSync(path.join(root, 'src', 'routes', 'import-salon.js'), 'utf8');

const REGISTERED_SALON = Object.freeze({
  id: 12,
  owner_id: 7,
  name: 'CoCo Nail',
  slug: 'coco-nail',
  // What POST /api/auth/partner/register leaves behind: a name, a slug, a default city.
  city: 'TP.HCM',
  description: null,
  address: null,
  district: null,
  phone: null,
  image: null,
  lat: null,
  lng: null,
  published: 0,
});

/**
 * A database that answers the handful of questions the route asks, and records every write.
 *
 * `failWrite` is a statement that fails, standing in for the deadlock or the lost connection
 * that can end any transaction half-way; withTransaction then discards what was written, the
 * way db.js's ROLLBACK does, so a test can assert the import left nothing behind.
 */
function fakeDb(salon, { serviceNames = [], hourRows = 0, photoRows = 0, failWrite = null } = {}) {
  const writes = [];

  const get = async (sql) => {
    if (/FROM salons WHERE owner_id/.test(sql) || /SELECT \* FROM salons WHERE id/.test(sql)) {
      return salon;
    }
    if (/COUNT\(\*\) AS count FROM salon_hours/.test(sql)) {
      return { count: hourRows };
    }
    if (/COUNT\(\*\) AS count FROM salon_photos/.test(sql)) {
      return { count: photoRows };
    }
    if (/MAX\(sort_order\)/.test(sql) || /MAX\(sort\)/.test(sql)) {
      return { position: 1 };
    }
    throw new Error(`unexpected get: ${sql}`);
  };
  const all = async (sql) => {
    if (/SELECT name FROM services/.test(sql)) {
      return serviceNames.map((name) => ({ name }));
    }
    throw new Error(`unexpected all: ${sql}`);
  };
  const run = async (sql, ...params) => {
    if (failWrite?.test(sql)) {
      throw new Error('deadlock detected');
    }
    writes.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return { changes: 1, lastInsertRowid: 1 };
  };

  return {
    writes,
    db: {
      prepare: (sql) => ({ get: () => get(sql), all, run }),
      withTransaction: async (work) => {
        const before = writes.length;
        try {
          return await work({ get, all, run });
        } catch (error) {
          writes.length = before;
          throw error;
        }
      },
    },
  };
}

/**
 * The module body, wired to stubs. Both markers are code rather than comments, so rewording
 * a comment in the route cannot change what is under test. Each lift starts with an empty
 * per-partner allowance.
 */
function lift({ db, safeFetch: fetcher, storeImage: store = async () => '/uploads/stored.jpg' }) {
  const from = routeJs.indexOf('const router = express.Router();');
  const to = routeJs.indexOf('export default router');
  assert.ok(from !== -1 && to > from, 'import-salon.js no longer has a router body to lift');

  const routes = {};
  const context = {
    express: {
      Router: () => ({
        use() {},
        post(routePath, handler) {
          routes[routePath] = handler;
        },
      }),
    },
    db,
    classifyUrl,
    extractRetailerCode,
    mapServices,
    mapTenant,
    normalizeServiceName,
    parseGenericHtml,
    UnsafeUrlError,
    safeFetch: fetcher,
    SocialProfileError,
    validateSocialProfile,
    MAX_IMAGE_BYTES: 5 * 1024 * 1024,
    extensionForContentType: (type) =>
      ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' })[type] ?? null,
    storeImage: store,
    httpError: (status, code, message) =>
      Object.assign(new Error(message), { status, code, isAppError: true }),
    // The gate is real in app.js; here the handler is called with a session already on it.
    requireAuth: () => {},
    requirePartner: () => {},
    Buffer,
    URL,
    URLSearchParams,
    console: { error() {}, info() {} },
  };
  vm.runInNewContext(routeJs.slice(from, to), context);

  assert.ok(routes['/'], 'import-salon.js no longer registers POST /');
  return routes['/'];
}

/** One request through the lifted handler, resolving when it has answered. */
function call(handler, body, userId = 7) {
  const answered = { body: undefined, error: undefined };
  return handler(
    { user: { id: userId }, body },
    {
      // Round-tripped through JSON, which is both what express does to it and what makes
      // the arrays in it comparable: a value built inside the vm context has that context's
      // Array prototype, and deepEqual is strict about which realm an array came from.
      json(value) {
        answered.body = JSON.parse(JSON.stringify(value));
      },
    },
    (error) => {
      answered.error = error;
    },
  ).then(() => answered);
}

const json = (url, payload) => ({
  url,
  status: 200,
  contentType: 'application/json',
  buffer: Buffer.from(JSON.stringify(payload)),
});

const page = (url, markup) => ({
  url,
  status: 200,
  contentType: 'text/html',
  buffer: Buffer.from(markup),
});

/** The KiotViet salon at the top of this file, answered over a stubbed network. */
function kiotvietNetwork({ geocodeWorks = false } = {}) {
  return mock.fn(async (url) => {
    if (url.endsWith('/tenant')) {
      return json(url, TENANT);
    }
    if (url.includes('/services?BranchId=4700')) {
      return json(url, SERVICES);
    }
    if (url.startsWith('https://nominatim.')) {
      if (!geocodeWorks) {
        // What a Vietnamese network actually does to openstreetmap.org.
        throw new Error('read ECONNRESET');
      }
      return json(url, [{ lat: '16.0678', lon: '108.2208' }]);
    }
    if (url.startsWith('https://cdn-booking.kiotviet.vn/')) {
      return { url, status: 200, contentType: 'image/jpeg', buffer: Buffer.from('jpeg-bytes') };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

test('a KiotViet link fills the empty columns, the week, the menu and the gallery', async () => {
  const { db, writes } = fakeDb({ ...REGISTERED_SALON });
  const handler = lift({ db, safeFetch: kiotvietNetwork() });

  const { body, error } = await call(handler, {
    url: 'https://booksalon.kiotviet.vn/4abf76ad',
    consent: true,
  });

  assert.equal(error, undefined);
  assert.equal(body.success, true);
  assert.equal(body.data.mode, 'kiotviet');
  // district and city arrive together. Registration wrote a placeholder 'TP.HCM' and no
  // district, so the location was never the partner's: taking the district without the city
  // would leave Quận Hải Châu sitting under Saigon.
  assert.deepEqual(body.data.filled, ['address', 'phone', 'district', 'city', 'image']);
  assert.deepEqual(body.data.skipped, []);
  assert.equal(body.data.services_added, 4);
  assert.equal(body.data.photos_added, 1); // The logo became the cover; the background is gallery.
  assert.equal(body.data.hours_set, true);
  assert.equal(body.data.geocoded, false);
  assert.deepEqual(body.data.warnings, ['hours_single_window', 'geocode_failed']);

  // One window fanned across all seven days, and the whole-week summary written beside it.
  const hourWrites = writes.filter((write) => write.sql.startsWith('INSERT INTO salon_hours'));
  assert.equal(hourWrites.length, 7);
  assert.deepEqual(hourWrites.map((write) => write.params[1]), [0, 1, 2, 3, 4, 5, 6]);
  const summary = writes.find((write) => write.sql.startsWith('UPDATE salons SET open_time'));
  assert.deepEqual(summary.params, ['07:00', '18:30', 12]);

  // Publication is the console's decision, never an import's.
  const salonUpdate = writes.find((write) => /^UPDATE salons SET address/.test(write.sql));
  assert.doesNotMatch(salonUpdate.sql, /published|verified|slug|name = /);

  // The consent is recorded with the link it was given for.
  const record = writes.find((write) => write.sql.startsWith('INSERT INTO salon_imports'));
  assert.equal(record.params[1], 'https://booksalon.kiotviet.vn/4abf76ad');
  assert.equal(record.params[2], 'kiotviet');
  assert.match(record.params[3], /^\d{4}-\d{2}-\d{2}T/);
});

test('nothing an import reads may replace something the salon already holds', async () => {
  const { db, writes } = fakeDb(
    {
      ...REGISTERED_SALON,
      address: '43 Nguyễn Chí Thanh (tầng 2)',
      phone: '0900000000',
      image: '/uploads/mine.jpg',
      lat: 16.07,
      lng: 108.22,
    },
    { serviceNames: ['CHÀ  GÓT   CHÂN'], hourRows: 7, photoRows: 2 },
  );
  const network = kiotvietNetwork({ geocodeWorks: true });
  const handler = lift({ db, safeFetch: network });

  const { body } = await call(handler, {
    url: 'https://booksalon.kiotviet.vn/4abf76ad',
    consent: true,
  });

  assert.deepEqual(body.data.filled, ['district', 'city']);
  assert.deepEqual(body.data.skipped, ['address', 'phone', 'image']);
  // Importing the same salon twice must not give it the same pictures twice — and with the
  // cover taken and a gallery already there, not one image is pulled across the wire.
  assert.equal(body.data.photos_added, 0);
  assert.equal(
    network.mock.calls.some((fetched) => fetched.arguments[0].startsWith('https://cdn-booking.')),
    false,
  );
  // A week that already exists is left entirely alone, and the duplicate service is skipped
  // however it was capitalised or spaced.
  assert.equal(body.data.hours_set, false);
  assert.equal(body.data.services_added, 3);
  assert.equal(writes.some((write) => write.sql.startsWith('INSERT INTO salon_hours')), false);
  // The salon already has a pin; a lookup must never move it.
  assert.equal(body.data.geocoded, false);
  assert.equal(writes.some((write) => /lat = /.test(write.sql)), false);
});

test('a location the partner set is left whole: neither half of it is rewritten', async () => {
  const { db } = fakeDb({
    ...REGISTERED_SALON,
    // A partner who has been through the settings form has both halves, and this one is not
    // in Đà Nẵng. Filling the district from the source would move the salon across the
    // country; filling the city would move it back. Neither may happen.
    district: 'Quận 3',
    city: 'TP.HCM',
  });
  const handler = lift({ db, safeFetch: kiotvietNetwork() });

  const { body } = await call(handler, {
    url: 'https://booksalon.kiotviet.vn/4abf76ad',
    consent: true,
  });

  assert.equal(body.data.filled.includes('district'), false);
  assert.equal(body.data.filled.includes('city'), false);
  assert.deepEqual(
    body.data.skipped.filter((column) => column === 'district' || column === 'city'),
    ['district', 'city'],
  );
});

test('a Facebook page is stored as a link, and nothing on facebook.com is ever fetched', async () => {
  const { db, writes } = fakeDb({ ...REGISTERED_SALON });
  const network = mock.fn(async () => {
    throw new Error('the route must not fetch a social page');
  });
  const handler = lift({ db, safeFetch: network });

  const { body, error } = await call(handler, {
    url: 'https://m.facebook.com/CocoNailDN?ref=bookmarks',
    consent: true,
  });

  assert.equal(error, undefined);
  assert.equal(network.mock.callCount(), 0);
  assert.equal(body.data.mode, 'social');
  assert.equal(body.data.social_links_added, 1);
  assert.deepEqual(body.data.filled, []);

  const link = writes.find((write) => write.sql.startsWith('INSERT INTO salon_social_links'));
  assert.deepEqual(link.params, [12, 'facebook', 'https://www.facebook.com/CocoNailDN']);
  /* Postgres would refuse this insert without its own RETURNING clause: db.prepare adds
     ' RETURNING id' to any INSERT that lacks one, and salon_social_links is the one table
     with no id column. It cost a live 500 to find out, so it is pinned here. */
  assert.match(link.sql, /RETURNING platform/);
});

test('the url and the consent tick are both required, and each says which is missing', async () => {
  const { db } = fakeDb({ ...REGISTERED_SALON });
  const handler = lift({ db, safeFetch: kiotvietNetwork() });

  const empty = await call(handler, { consent: true });
  assert.equal(empty.error.status, 400);
  assert.equal(empty.error.code, 'VALIDATION_ERROR');

  const notAUrl = await call(handler, { url: 'coconail.vn', consent: true });
  assert.equal(notAUrl.error.code, 'VALIDATION_ERROR');

  // Silence is not consent, and neither is a string that looks like one.
  for (const consent of [undefined, false, 'true', 1]) {
    const refused = await call(handler, { url: 'https://booksalon.kiotviet.vn/4abf76ad', consent });
    assert.equal(refused.error.status, 400);
    assert.equal(refused.error.code, 'CONSENT_REQUIRED');
  }
});

test('a partner gets three imports in the window, and does not spend another partner’s', async () => {
  const { db } = fakeDb({ ...REGISTERED_SALON });
  const handler = lift({ db, safeFetch: kiotvietNetwork() });
  const body = { url: 'https://booksalon.kiotviet.vn/4abf76ad', consent: true };

  for (let n = 0; n < 3; n += 1) {
    assert.equal((await call(handler, body)).error, undefined, `import ${n + 1} of 3`);
  }
  const refused = await call(handler, body);
  assert.equal(refused.error.status, 429);
  assert.equal(refused.error.code, 'RATE_LIMITED');

  assert.equal((await call(handler, body, 99)).error, undefined);
});

test('an upstream that cannot be read is a 502; a link pointing inward is a 400', async () => {
  const { db } = fakeDb({ ...REGISTERED_SALON });

  const broken = lift({
    db,
    safeFetch: mock.fn(async () => {
      throw new Error('The operation was aborted due to timeout');
    }),
  });
  const failed = await call(broken, { url: 'https://coconail.vn/', consent: true });
  assert.equal(failed.error.status, 502);
  assert.equal(failed.error.code, 'UPSTREAM_ERROR');

  const inward = lift({
    db,
    safeFetch: mock.fn(async () => {
      throw new UnsafeUrlError('Đường dẫn trỏ vào một địa chỉ nội bộ.');
    }),
  });
  const refused = await call(inward, { url: 'http://intranet.coconail.vn/', consent: true });
  assert.equal(refused.error.status, 400);
  assert.equal(refused.error.code, 'VALIDATION_ERROR');
});

test('a page with nothing to give answers success with nothing_found', async () => {
  const { db } = fakeDb({ ...REGISTERED_SALON });
  const handler = lift({
    db,
    safeFetch: mock.fn(async (url) => page(url, '<html><body><p>Đang cập nhật</p></body></html>')),
  });

  const answered = await call(handler, { url: 'https://coconail.vn/', consent: true });

  assert.equal(answered.error, undefined);
  assert.equal(answered.body.data.mode, 'generic');
  assert.deepEqual(answered.body.data.warnings, ['nothing_found']);
});

test('an import that fails part-way through its writes leaves no row behind', async () => {
  // The record of the import is the last statement of the transaction, so a failure there is
  // one that lands after the profile, the whole week and the menu have all been written.
  // Rows only: the pictures were re-hosted before the transaction opened, and those files
  // stay on the store unreferenced — see the note above rehostImages().
  const { db, writes } = fakeDb({ ...REGISTERED_SALON }, { failWrite: /INSERT INTO salon_imports/ });
  const handler = lift({ db, safeFetch: kiotvietNetwork() });

  const { body, error } = await call(handler, {
    url: 'https://booksalon.kiotviet.vn/4abf76ad',
    consent: true,
  });

  assert.equal(body, undefined);
  assert.match(error.message, /deadlock/);
  assert.deepEqual(writes, []);
});

/** A stubbed network that serves one website and a JPEG for every picture on it. */
function websiteNetwork(markup) {
  return mock.fn(async (url) =>
    url === 'https://coconail.vn/'
      ? page(url, markup)
      : { url, status: 200, contentType: 'image/jpeg', buffer: Buffer.from('jpeg-bytes') },
  );
}

test('a page that names two days closes the other five rather than leaving them open', async () => {
  const { db, writes } = fakeDb({ ...REGISTERED_SALON });
  const handler = lift({ db, safeFetch: websiteNetwork(GENERIC_HTML) });

  const { body, error } = await call(handler, { url: 'https://coconail.vn/', consent: true });

  assert.equal(error, undefined);
  assert.equal(body.data.hours_set, true);
  // A weekday with no row at all is not "unknown" to lib/availability.js — it is "open
  // around the clock". The five days this page never mentioned are written closed instead,
  // in the shape PATCH /api/partner/salon writes one: no window, is_off = 1.
  const hourWrites = writes.filter((write) => write.sql.startsWith('INSERT INTO salon_hours'));
  assert.deepEqual(
    hourWrites.map((write) => write.params.slice(1)),
    [
      [0, null, null, 1],
      [1, '08:00', '20:00', 0],
      [2, '08:00', '20:00', 0],
      [3, null, null, 1],
      [4, null, null, 1],
      [5, null, null, 1],
      [6, null, null, 1],
    ],
  );
  // The whole-week summary spans the days that are actually open.
  const summary = writes.find((write) => write.sql.startsWith('UPDATE salons SET open_time'));
  assert.deepEqual(summary.params, ['08:00', '20:00', 12]);
});

test('a pin is only dropped under an address this import actually wrote', async () => {
  // The partner typed their own address and the import may not touch it; the page carries
  // coordinates for the address the page states. Storing them would pin this salon somewhere
  // its own address does not say — so the pair is left off and reported as skipped.
  const { db, writes } = fakeDb({ ...REGISTERED_SALON, address: '43 Nguyễn Chí Thanh (tầng 2)' });
  const handler = lift({ db, safeFetch: websiteNetwork(GENERIC_HTML) });

  const { body } = await call(handler, { url: 'https://coconail.vn/', consent: true });

  assert.equal(body.data.geocoded, false);
  assert.deepEqual(
    body.data.skipped.filter((column) => column === 'lat' || column === 'lng'),
    ['lat', 'lng'],
  );
  assert.equal(writes.some((write) => /lat = /.test(write.sql)), false);
});

test('a salon’s own site fronting a KiotViet store is read as KiotViet', async () => {
  const { db } = fakeDb({ ...REGISTERED_SALON });
  const kiotviet = kiotvietNetwork();
  const handler = lift({
    db,
    safeFetch: mock.fn(async (url, options) =>
      url === 'https://coconail.vn/'
        ? page(url, '<a href="https://booksalon.kiotviet.vn/4abf76ad">Đặt lịch</a>')
        : kiotviet(url, options),
    ),
  });

  const answered = await call(handler, { url: 'https://coconail.vn/', consent: true });

  assert.equal(answered.body.data.mode, 'kiotviet');
  assert.equal(answered.body.data.services_added, 4);
});
