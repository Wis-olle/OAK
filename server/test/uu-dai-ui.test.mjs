/* The offers page makes one promise per card, and there is one kind of promise left to
   make: a salon's own percentage code, good at that salon until the day it names. The
   bundle price and the countdown that each needed a card of their own are gone from the
   console, /api/promotions lists neither, and the till refuses both — so what is pinned
   here is that the card hands the code to the wizard and to nobody who cannot spend it.
   These tests drive the page's own factory over payloads shaped like GET /api/promotions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readUi } from './lib/read-source.mjs';

const html = readUi('uu-dai.html');

const WELCOME = {
  id: 7,
  code: 'MOI20-4',
  title: 'Chào mừng salon mới - Giảm 20%',
  description: 'Giảm 20% cho mọi dịch vụ tại salon.',
  discount_percent: 20,
  salon: { name: 'Lala Nail Studio', slug: 'lala-nail-studio' },
};

/* An offer written before the console settled on a percentage. discount_amount is still
   read back by /api/promotions, so a row that promised a sum of đồng still says so. */
const AMOUNT = {
  id: 3,
  code: 'LALA100K',
  title: 'Giảm 100.000đ',
  description: 'Giảm 100.000đ cho dịch vụ sơn gel.',
  discount_amount: 100000,
  salon: { name: 'Lala Nail Studio', slug: 'lala-nail-studio' },
};

/* An offer whose salon is not in the first page of /api/salons: the page resolves a slug
   to the id dat-lich.html takes, and cannot for this one. */
const UNKNOWN_SALON = { ...WELCOME, id: 9, code: 'MOI20-99', salon: { name: 'Xa', slug: 'salon-xa' } };

/* The factory is inline in the page, so it is lifted out of its <script> and run here.
   `events` is the harness's record of what OAK.track() sent — the page has no other way
   of reporting that an offer was taken up. */
async function promotionsPage({ promotions = [], user = null, tracking = true } = {}) {
  const events = [];
  const context = {
    URLSearchParams,
    events,
    OAK: {
      me: async () => user,
      api: async (url) =>
        url.startsWith('/api/promotions')
          ? promotions
          : [{ id: 4, slug: 'lala-nail-studio', name: 'Lala Nail Studio' }],
      fmtPrice: (value) => String(value),
      toast: () => {},
    },
  };
  // A browser whose oak-api.js predates OAK.track() is the page served from cache; the
  // harness can be that browser too.
  if (tracking) {
    context.OAK.track = (name, meta) => events.push({ name, meta });
  }
  const tail = html.slice(html.indexOf('function oakPromotions()'));
  const script = tail.slice(0, tail.indexOf('</script>'));
  vm.runInNewContext(`${script}\nresult = oakPromotions();`, context);
  await context.result.init();
  context.result.events = events;
  return context.result;
}

test('every offer listed is one salon’s own, and the page has no other kind to sort', async () => {
  const page = await promotionsPage({ promotions: [WELCOME, AMOUNT], user: { id: 1 } });

  /* The platform-wide grid above the salon one is gone, and with it the split that fed it:
     there is no offer on OAK that is not paid for by the salon running it, so a second
     heading promising "áp dụng tại mọi salon" had nothing true to put under it. */
  assert.equal(page.platform, undefined);
  assert.equal(page.salonOffers, undefined);
  assert.equal(page.promotions.length, 2);
  assert.doesNotMatch(html, /Ưu đãi từ OAK/);
  assert.doesNotMatch(html, /Áp dụng toàn hệ thống OAK/);
});

test('a card carries its code into the wizard, at the salon that issued it', async () => {
  const page = await promotionsPage({ promotions: [WELCOME], user: { id: 1 } });

  assert.equal(page.useUrl(WELCOME), 'dat-lich.html?salon_id=4&promo=MOI20-4');
  // No service deep link left to make: an offer is on the salon's whole menu now.
  assert.doesNotMatch(page.useUrl(WELCOME), /service_id=/);
  assert.equal(page.discountLabel(WELCOME), 'Giảm 20%');
});

test('an older offer priced in đồng still says what it takes off', async () => {
  const page = await promotionsPage({ promotions: [AMOUNT], user: { id: 1 } });

  assert.equal(page.discountLabel(AMOUNT), 'Giảm 100000');
  assert.equal(page.useUrl(AMOUNT), 'dat-lich.html?salon_id=4&promo=LALA100K');
});

test('a salon this page could not resolve still sends its code to the wizard', async () => {
  /* The slug -> id lookup comes from /api/salons, which is one page long. A salon past the
     end of it has no id to carry, and the code has to travel anyway or the visitor lands in
     the wizard with nothing to show for the card they pressed. */
  const page = await promotionsPage({ promotions: [UNKNOWN_SALON], user: { id: 1 } });

  assert.equal(page.useUrl(UNKNOWN_SALON), 'dat-lich.html?promo=MOI20-99');
});

test('a guest keeps the code across the login round trip', async () => {
  // Only a signed-in customer can have a code applied, so the card goes through the login
  // page and comes back to the same booking with the code still on it.
  const page = await promotionsPage({ promotions: [WELCOME] });

  assert.equal(
    page.useUrl(WELCOME),
    'dang-nhap-nguoi-dung.html?next=' +
      encodeURIComponent('dat-lich.html?salon_id=4&promo=MOI20-4'),
  );
});

test('taking up an offer is counted, and the count cannot name the visitor', async () => {
  const page = await promotionsPage({ promotions: [WELCOME], user: { id: 1, phone: '0912345678' } });
  page.trackUse(WELCOME);

  // The id alone: there is one kind of offer, so the kind was a constant worth nothing, and
  // nothing else about the visitor may travel with the count.
  // Through JSON, because the page's objects come out of another realm.
  assert.equal(
    JSON.stringify(page.events),
    JSON.stringify([{ name: 'promo_use', meta: { id: 7 } }]),
  );
});

test('a browser whose oak-api.js has no track() still takes up the offer', async () => {
  /* The counting must never cost the visitor the click it is counting: a cached page
     meeting an older script would otherwise throw out of the 'Dùng ngay' handler. */
  const page = await promotionsPage({ promotions: [WELCOME], user: { id: 1 }, tracking: false });

  assert.doesNotThrow(() => page.trackUse(WELCOME));
  assert.equal(page.useUrl(WELCOME), 'dat-lich.html?salon_id=4&promo=MOI20-4');
});
