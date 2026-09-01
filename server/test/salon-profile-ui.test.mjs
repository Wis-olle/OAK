/* The salon profile is the page a shared link lands on, so it has to hold up when it is
   the reader's first and only look at the salon: say whether the doors are open right now,
   show that the gallery has more than one photo on a phone, offer the salon's own running
   offers, let a technician be booked without a detour, and tell a failed request apart from
   a salon that does not exist. These drive the page's own factory over payloads shaped like
   the endpoints it calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readRepo, readUi } from './lib/read-source.mjs';

const html = readUi('salon-profile.html');

/* Monday 09:00-21:00 through Saturday, closed on Sunday. */
const WEEK_HOURS = [
  { weekday: 0, start: '09:00', end: '21:00', is_off: 1 },
  { weekday: 1, start: '09:00', end: '21:00', is_off: 0 },
  { weekday: 2, start: '09:00', end: '21:00', is_off: 0 },
  { weekday: 3, start: '09:00', end: '21:00', is_off: 0 },
  { weekday: 4, start: '09:00', end: '21:00', is_off: 0 },
  { weekday: 5, start: '09:00', end: '21:00', is_off: 0 },
  { weekday: 6, start: '10:00', end: '18:00', is_off: 0 },
];

const SALON = {
  id: 4,
  slug: 'lala-nail-studio',
  name: 'Lala Nail Studio',
  description: 'Nail studio',
  district: 'Quận 1',
  city: 'TP.HCM',
  image: 'a.webp',
  rating: 4.8,
  review_count: 7,
  price_from: 250000,
  verified: true,
  amenities: [],
  social_links: {},
  hours: WEEK_HOURS,
  open_time: '09:00',
  close_time: '21:00',
  lat: null,
  lng: null,
};

/* The one shape /api/promotions answers with now: a salon's own percentage code. */
const WELCOME = {
  id: 1,
  code: 'MOI20-4',
  title: 'Chào mừng salon mới - Giảm 20%',
  discount_percent: 20,
  salon: { name: 'Lala Nail Studio', slug: 'lala-nail-studio' },
};

/* An offer written before the console settled on a percentage. The column is still there
   and the page still reads it, so an old row keeps saying what it promised. */
const AMOUNT = {
  id: 3,
  code: 'LALA100K',
  title: 'Giảm 100.000đ',
  discount_amount: 100000,
  salon: { name: 'Lala Nail Studio', slug: 'lala-nail-studio' },
};

const OTHER_SALON = { ...AMOUNT, id: 5, salon: { name: 'Khác', slug: 'salon-khac' } };

const withMeta = (rows, meta) => Object.assign(rows, { meta });

/* The factory runs in its own vm realm, so its objects carry that realm's prototype;
   copying one here is what lets assert compare it against a literal. */
const plain = (value) => (value ? { ...value } : value);

const REVIEWS = withMeta([], {
  total: 0,
  average: 0,
  breakdown: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
});

/**
 * The factory is inline in the page, so it is lifted out of its <script> and run here.
 * `now` is the clock the open/closed chip reads; `fail` makes one endpoint reject the way
 * a cold server or a dropped connection would.
 */
async function salonPage({
  salon = SALON,
  promotions = [],
  reviews = REVIEWS,
  now = new Date('2026-08-24T14:00:00'), // a Monday afternoon, inside opening hours
  fail = null,
  query = { salon: 'lala-nail-studio' },
  user = null,
  requests = [],
} = {}) {
  const context = {
    URL,
    URLSearchParams,
    Date: class extends Date {
      constructor(...args) {
        super(...(args.length ? args : [now]));
      }
    },
    location: { href: 'https://oak.test/salon-profile.html?salon=lala-nail-studio', pathname: '/salon-profile.html', search: '?salon=lala-nail-studio' },
    history: { replaceState: () => {} },
    navigator: {},
    toasts: [],
    OAK: {
      qs: (name) => query[name] ?? null,
      me: async () => user,
      meta: () => {},
      fmtTime: (value) => value,
      fmtDate: (value) => value,
      fmtPrice: (value) => String(value),
      fmtPriceFrom: (value) => String(value),
      toast: (message) => context.toasts.push(message),
      requireLogin: async (next) => { context.loginNext = next; },
      api: async (url, options) => {
        requests.push(url);
        if (fail && url.startsWith(fail.url)) {
          const error = new Error(fail.message || 'boom');
          error.code = fail.code;
          throw error;
        }
        if (url.startsWith('/api/promotions')) return promotions;
        if (url.includes('/reviews')) return reviews;
        if (url.startsWith('/api/favorites')) {
          return options ? {} : { salons: [], services: [] };
        }
        if (url.startsWith('/api/bookings/mine')) return withMeta([], { total: 0 });
        if (url.startsWith('/api/reviews/mine')) return [];
        if (url.startsWith('/api/salons/')) {
          if (url.endsWith('/photos')) return [{ id: 1, image: 'a.webp', caption: 'a' }, { id: 2, image: 'b.webp', caption: 'b' }];
          if (url.endsWith('/services')) return [];
          if (url.endsWith('/staff')) return [];
          return salon;
        }
        return [];
      },
    },
  };
  const tail = html.slice(html.indexOf('const OAK_CATEGORY_LABELS'));
  const script = tail.slice(0, tail.indexOf('</script>'));
  vm.runInNewContext(`${script}\nresult = oakSalonProfile();`, context);
  await context.result.init();
  context.result.toasts = context.toasts;
  context.result.context = context;
  return context.result;
}

test('the chip says whether the doors are open right now, and when that changes', async () => {
  // Inside Monday's hours: open, and the reader is told when it ends.
  const open = await salonPage({ now: new Date('2026-08-24T14:00:00') });
  assert.deepEqual(plain(open.openStatus()), { open: true, label: 'Đang mở cửa · đóng', time: '21:00' });

  // Before opening on a working day: closed, and today's own opening is the next one.
  const early = await salonPage({ now: new Date('2026-08-24T07:30:00') });
  assert.deepEqual(plain(early.openStatus()), { open: false, label: 'Đã đóng · mở', time: '09:00' });

  // After closing: the next opening is tomorrow's, not today's that has already passed.
  const late = await salonPage({ now: new Date('2026-08-24T22:30:00') });
  assert.deepEqual(plain(late.openStatus()), { open: false, label: 'Đã đóng · mở', time: '09:00' });

  // Sunday is a day off, so the next opening is Monday's — Saturday's 10:00 is behind it.
  const sunday = await salonPage({ now: new Date('2026-08-23T12:00:00') });
  assert.deepEqual(plain(sunday.openStatus()), { open: false, label: 'Đã đóng · mở', time: '09:00' });

  // A salon that has published nothing gets no chip rather than a guess.
  const blank = await salonPage({ salon: { ...SALON, hours: [], open_time: null, close_time: null } });
  assert.equal(blank.openStatus(), null);

  // Half a pair of times cannot answer "open now" either: an opening hour with no closing
  // hour used to compare against NaN and call an open salon closed.
  const halfPair = await salonPage({ salon: { ...SALON, hours: [], close_time: null } });
  assert.equal(halfPair.openStatus(), null);
  const halfRow = await salonPage({
    salon: { ...SALON, hours: [{ weekday: 1, start: '09:00', end: null, is_off: 0 }], open_time: null, close_time: null },
  });
  assert.equal(halfRow.openRow(1), null);
});

test('the hours table marks the row the reader is standing in', async () => {
  const page = await salonPage({ now: new Date('2026-08-24T14:00:00') });
  const rows = page.hoursRows();
  assert.equal(rows.filter((row) => row.today).length, 1);
  assert.equal(rows.find((row) => row.today).label, 'Thứ 2');
  // The table is Monday-first and still says which days are off.
  assert.equal(rows.find((row) => row.label === 'Chủ Nhật').time, 'Nghỉ');
  assert.match(html, /:aria-current="row.today \? 'date' : false"/);
});

test('the offers strip shows this salon and nobody else', async () => {
  /* Every offer belongs to one salon now — the platform-wide row this strip used to honour
     as well cannot exist — so the filter is the slug and nothing else. */
  const page = await salonPage({ promotions: [WELCOME, AMOUNT, OTHER_SALON] });
  assert.deepEqual([...page.salonPromotions()].map((promotion) => promotion.id), [1, 3]);
});

test('a code opens the wizard at this salon, carrying itself', async () => {
  const page = await salonPage({ promotions: [WELCOME, AMOUNT], user: { id: 1 } });
  assert.equal(page.promoUrl(WELCOME), 'dat-lich.html?salon_id=4&promo=MOI20-4');
  assert.equal(page.promoLabel(WELCOME), 'Giảm 20%');
  // The older shape still reads as what it promises, because the column is still read.
  assert.equal(page.promoLabel(AMOUNT), 'Giảm 100000');
});

test('a guest sent to use a code signs in first, the way the offers page sends them', async () => {
  // Only a signed-in customer can have a code applied — carrying a guest straight into the
  // wizard ends at "Đăng nhập để áp dụng mã ưu đãi.", the dead end the offer exists to avoid.
  const guest = await salonPage({ promotions: [AMOUNT] });
  assert.equal(
    guest.promoUrl(AMOUNT),
    'dang-nhap-nguoi-dung.html?next=' + encodeURIComponent('dat-lich.html?salon_id=4&promo=LALA100K'),
  );

  const signedIn = await salonPage({ promotions: [AMOUNT], user: { id: 1 } });
  assert.equal(signedIn.promoUrl(AMOUNT), 'dat-lich.html?salon_id=4&promo=LALA100K');
});

test('a failed request is told apart from a salon that does not exist', async () => {
  // A 404 is the only answer that means "no such salon".
  const missing = await salonPage({ fail: { url: '/api/salons/', code: 'NOT_FOUND' } });
  assert.equal(missing.salon, null);
  assert.equal(missing.loadError, '');

  // Everything else keeps a way back in instead of sending the reader away.
  const broken = await salonPage({ fail: { url: '/api/salons/', code: 'NETWORK_ERROR' } });
  assert.equal(broken.salon, null);
  assert.equal(broken.loadError, 'Không tải được thông tin salon.');
  assert.equal(broken.loading, false);
  assert.match(html, /x-show="loadError"/);
  assert.match(html, /@click="init\(\)"/);

  // A sub-request that fails does not leave a half-page claiming the salon has no services.
  const partial = await salonPage({ fail: { url: '/api/salons/4/services', code: 'NETWORK_ERROR' } });
  assert.equal(partial.salon, null);
  assert.equal(partial.loadError, 'Không tải được thông tin salon.');

  // But the extras go the other way: a slow /api/promotions hides the offers strip, it does
  // not replace a salon that loaded perfectly well with an error panel.
  const noOffers = await salonPage({
    promotions: [AMOUNT],
    fail: { url: '/api/promotions', code: 'NETWORK_ERROR' },
  });
  assert.equal(noOffers.salon.id, 4);
  assert.equal(noOffers.loadError, '');
  assert.deepEqual([...noOffers.salonPromotions()], []);
});

test('the heart a guest pressed survives the login page', async () => {
  // The intent comes back as ?fav=1, is spent once, and is taken out of the address bar.
  const requests = [];
  const saved = await salonPage({ query: { salon: 'lala-nail-studio', fav: '1' }, user: { id: 1 }, requests });
  assert.equal(saved.isFavorite, true);
  assert.ok(requests.includes('/api/favorites'));
  assert.deepEqual(saved.toasts, ['Đã lưu vào yêu thích.']);

  // A guest who lands on ?fav=1 without a session saves nothing and is told nothing.
  const guest = await salonPage({ query: { salon: 'lala-nail-studio', fav: '1' }, user: null });
  assert.equal(guest.isFavorite, false);
  assert.deepEqual(guest.toasts, []);

  // And the press itself carries a ?next= the login page will accept: OAK_NEXT_PAGE on
  // both login pages is /^[\w-]+\.html(\?.*)?$/, which a leading '/' fails.
  const guestPress = await salonPage({ user: null });
  await guestPress.toggleFavorite();
  assert.equal(guestPress.context.loginNext, 'salon-profile.html?salon=lala-nail-studio&fav=1');
  assert.match(guestPress.context.loginNext, /^[\w-]+\.html(\?.*)?$/);
});

test('a technician can be booked from the salon without a detour through their profile', () => {
  // The card was one anchor to the profile; the booking link cannot nest inside it.
  assert.match(html, /'dat-lich\.html\?salon_id=' \+ salon\.id \+ '&amp;staff_id=' \+ member\.id/);
  assert.match(html, /<span>Đặt với<\/span> <span x-text="member\.name"><\/span>/);
});

test('a phone is told the gallery holds more than the one photo it shows', () => {
  // Four of the five tiles are hidden below md, and the "+N Ảnh" badge sits in one of them.
  assert.match(html, /class="md:hidden absolute[^"]*"[^>]*x-show="photos\.length &gt; 1"/);
  assert.match(html, /<span>Xem tất cả<\/span> <span x-text="photos\.length"><\/span> <span>ảnh<\/span>/);
  // And the viewer it opens gives the photo the screen rather than the padding.
  assert.match(html, /px-4 py-16 md:px-16 md:py-20/);
  assert.match(html, /max-h-\[80vh\]/);
});

test('the service menu scrolls on its own so the booking button stays on screen', () => {
  assert.match(html, /class="space-y-6 md:max-h-\[calc\(100vh-16rem\)\] md:overflow-y-auto pr-2"/);
  // The CTA is outside that container: it closes before the button opens.
  const list = html.indexOf('md:max-h-[calc(100vh-16rem)]');
  const cta = html.indexOf('Đặt lịch ngay', list);
  assert.ok(html.slice(list, cta).includes('</div>'));
});

test('the share button is on all three pages a link is shared from', () => {
  for (const name of ['salon-profile.html', 'chi-tiet-dich-vu.html', 'ho-so-chuyen-gia.html']) {
    const page = readUi(name);
    assert.match(page, /@click="share\(\)" aria-label="Chia sẻ"/, name);
    // 44px, the way the heart beside it is, and the icon has to be in the subset font.
    assert.match(page, /aria-label="Chia sẻ" class="shrink-0 w-11 h-11/, name);
    assert.match(page, /<span aria-hidden="true" class="material-symbols-outlined">share<\/span>/, name);
  }
  const names = readRepo('tools/icons/icon-names.txt');
  assert.equal(names.split(/\r?\n/).filter((line) => line === 'share').length, 1);
});

/* The service page's own free-hours block: seven days in one request, a booked hour that
   stays on screen struck through, and a day the salon does not open labelled as such. */
async function servicePage({ week, slots, failSlots = false } = {}) {
  const serviceHtml = readUi('chi-tiet-dich-vu.html');
  const context = {
    URL,
    URLSearchParams,
    location: { href: 'https://oak.test/chi-tiet-dich-vu.html?id=4' },
    navigator: {},
    OAK: {
      qs: (name) => (name === 'id' ? '4' : null),
      me: async () => null,
      meta: () => {},
      fmtDate: (value) => value,
      fmtPrice: (value) => String(value),
      fmtPriceFrom: (value) => String(value),
      toast: () => {},
      api: async (url) => {
        if (url.includes('availability') && url.includes('days=7')) return { week };
        if (url.includes('availability')) {
          if (failSlots) throw new Error('boom');
          return { slots };
        }
        if (url.includes('/reviews')) return withMeta([], { total: 0, average: 0 });
        if (url.startsWith('/api/favorites')) return { salons: [], services: [] };
        if (url === '/api/services/4') {
          return {
            id: 4,
            name: 'Sơn Gel Cơ Bản',
            description: 'x',
            image: 'a.webp',
            price: 250000,
            price_is_from: false,
            duration_min: 45,
            salon: { id: 4, slug: 'lala-nail-studio', name: 'Lala', address: 'x', image: 'b.webp', rating: 4.5, review_count: 1 },
          };
        }
        return [];
      },
    },
  };
  const tail = serviceHtml.slice(serviceHtml.indexOf('function oakTodayISO('));
  vm.runInNewContext(`${tail.slice(0, tail.indexOf('</script>'))}\nresult = oakServiceDetail();`, context);
  await context.result.init();
  return context.result;
}

test('the service page offers seven days, and says which ones are off and which are full', async () => {
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString().slice(0, 10);
  const tomorrow = new Date(new Date(today + 'T00:00:00').getTime() + 86400000)
    .toISOString().slice(0, 10);
  const page = await servicePage({
    week: [
      { date: today, slots: [{ time: '23:59', available: true }] },
      { date: tomorrow, slots: [{ time: '10:00', available: false }] },
      { date: '2099-01-01', slots: [] },
    ],
    slots: [{ time: '23:59', available: true }, { time: '23:58', available: false }],
  });

  const chips = [...page.dayChips].map((chip) => ({ ...chip }));
  assert.equal(chips.length, 3);
  assert.equal(chips[0].weekday, 'Hôm nay');
  assert.equal(chips[0].full, false);
  // Hours exist but none can be taken: struck through, still pressable.
  assert.equal(chips[1].full, true);
  assert.equal(chips[1].closed, false);
  // No hours at all: the chip reads 'Nghỉ' in place of the date.
  assert.equal(chips[2].closed, true);
  const serviceHtml = readUi('chi-tiet-dich-vu.html');
  assert.match(serviceHtml, /x-text="chip.closed \? 'Nghỉ' : chip.day"/);

  // The panel underneath says nothing about opening hours: an empty answer is an empty
  // answer, whether the salon is shut or simply has nobody rostered.
  assert.match(serviceHtml, /!slots\.length">Không còn lịch trống trong ngày này\.<\/p>/);
  assert.ok(!serviceHtml.includes('closedDay'));
});

test('a reader who has already reviewed everything here is not told they may not', () => {
  // Three states, not two: may write one, has none to write, has written them all.
  for (const name of ['salon-profile.html', 'chi-tiet-dich-vu.html']) {
    const page = readUi(name);
    assert.match(page, /x-if="!reviewGate.href &amp;&amp; !reviewGate.done"/, name);
    assert.match(page, /x-if="!reviewGate.href &amp;&amp; reviewGate.done"/, name);
    assert.match(page, /Bạn đã đánh giá các lịch hẹn tại salon này rồi\./, name);
  }
});

test('a booked hour stays on screen instead of making a busy day look like a closed one', async () => {
  const page = await servicePage({ week: [], slots: [{ time: '23:59', available: true }, { time: '23:58', available: false }] });
  // Both hours are listed; the unavailable one is disabled rather than dropped.
  assert.equal([...page.slots].length, 2);
  const serviceHtml = readUi('chi-tiet-dich-vu.html');
  assert.match(serviceHtml, /:disabled="!slot.available"/);
  assert.match(serviceHtml, /disabled:opacity-40 disabled:line-through/);
});

test('clearing the date puts the hour skeleton away instead of leaving it spinning', async () => {
  // The date field can be emptied — browsers allow it and @change fires. loadSlots() bumps
  // its token before that early return, so the read still open can no longer clear the flag
  // from its own finally; if this branch does not clear it, the skeleton never comes down
  // and "Thử lại" stays disabled.
  const page = await servicePage({ week: [], slots: [{ time: '23:59', available: true }] });
  page.slotsLoading = true;
  page.date = '';
  await page.loadSlots();
  assert.equal(page.slotsLoading, false);
  assert.equal([...page.slots].length, 0);
});

test('a failed slot request says so, instead of reading as a fully booked day', async () => {
  const page = await servicePage({ week: [], slots: [], failSlots: true });
  assert.equal(page.slotsError, 'Không tải được khung giờ trống.');
  assert.equal([...page.slots].length, 0);
  const serviceHtml = readUi('chi-tiet-dich-vu.html');
  // The "no hours left" line waits for both the load and the error to clear.
  assert.match(serviceHtml, /x-show="!slotsLoading &amp;&amp; !slotsError &amp;&amp; !slots.length"/);
  assert.match(serviceHtml, /x-show="slotsLoading &amp;&amp; !slots.length"/);
});
