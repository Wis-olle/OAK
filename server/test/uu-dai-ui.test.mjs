/* The offers page makes one promise per card, and a combo's promise is the hardest one to
   keep: the card shows a bundle price that no discount code can produce. So a combo card
   has to send the visitor to the service that IS the bundle — priced at the sale price —
   and must never hand out a code the server will refuse. These tests drive the page's own
   factory over payloads shaped like GET /api/promotions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readUi } from './lib/read-source.mjs';

const html = readUi('uu-dai.html');

const COMBO = {
  id: 7,
  code: 'LALACOMBO480',
  type: 'combo',
  title: 'Combo Sơn gel + Chăm sóc chân',
  original_price: 600000,
  sale_price: 480000,
  service_ids: [12],
  service_names: ['Combo Sơn Gel + Chăm Sóc Chân'],
  salon: { name: 'Lala Nail Studio', slug: 'lala-nail-studio' },
};

const DISCOUNT = {
  id: 3,
  code: 'LALA100K',
  type: 'discount',
  title: 'Giảm 100.000đ',
  discount_amount: 100000,
  service_ids: [],
  service_names: [],
  salon: { name: 'Lala Nail Studio', slug: 'lala-nail-studio' },
};

/* Nothing stops a salon from creating a combo over several of its ordinary services in
   quan-ly-dich-vu.html — that offer has no single service carrying the bundle price. */
const LOOSE_COMBO = {
  id: 9,
  code: 'LALALOOSE',
  type: 'combo',
  title: 'Combo tự chọn',
  original_price: 600000,
  sale_price: 480000,
  service_ids: [12, 13],
  service_names: ['Sơn Gel Cơ Bản', 'Chăm Sóc Chân Chuyên Sâu'],
  salon: { name: 'Lala Nail Studio', slug: 'lala-nail-studio' },
};

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
  const tail = html.slice(html.indexOf('const PROMOTION_TYPE_LABELS'));
  const script = tail.slice(0, tail.indexOf('</script>'));
  vm.runInNewContext(`${script}\nresult = oakPromotions();`, context);
  await context.result.init();
  context.result.events = events;
  return context.result;
}

test('a combo books its own service at the combo price, never as a code', async () => {
  const page = await promotionsPage({ promotions: [COMBO], user: { id: 1 } });

  const url = page.useUrl(COMBO);
  assert.equal(url, 'dat-lich.html?salon_id=4&service_id=12');
  // The wizard would send it to /quote, and the server refuses a combo code there.
  assert.doesNotMatch(url, /promo=/);
  // And the card does not offer the code in the first place.
  assert.equal(page.usesCode(COMBO), false);
  assert.equal(page.isCombo(COMBO), true);
});

test('a combo over several services claims nothing and books nothing in particular', async () => {
  const page = await promotionsPage({ promotions: [LOOSE_COMBO], user: { id: 1 } });

  // Sending the visitor to one part of the bundle would sell that part at the bundle price.
  const url = page.useUrl(LOOSE_COMBO);
  assert.equal(url, 'dat-lich.html?salon_id=4');
  assert.doesNotMatch(url, /service_id=/);
  // So the card makes no combo-price promise either, and still offers no code.
  assert.equal(page.comboServiceId(LOOSE_COMBO), null);
  assert.equal(page.usesCode(LOOSE_COMBO), false);
  // It names the services instead, which the single-service combo does not need to.
  assert.equal(JSON.stringify(page.serviceChips(LOOSE_COMBO)), JSON.stringify(LOOSE_COMBO.service_names));
  assert.equal(page.serviceChips(COMBO).length, 0);
});

test('a discount offer still carries its code into the wizard', async () => {
  const page = await promotionsPage({ promotions: [DISCOUNT], user: { id: 1 } });

  const url = page.useUrl(DISCOUNT);
  assert.equal(url, 'dat-lich.html?salon_id=4&promo=LALA100K');
  assert.doesNotMatch(url, /service_id=/);
  assert.equal(page.usesCode(DISCOUNT), true);
});

test('a guest keeps the combo service across the login round trip', async () => {
  const page = await promotionsPage({ promotions: [COMBO] });

  assert.equal(
    page.useUrl(COMBO),
    'dang-nhap-nguoi-dung.html?next=' +
      encodeURIComponent('dat-lich.html?salon_id=4&service_id=12'),
  );
});

test('taking up an offer is counted, and the count cannot name the visitor', async () => {
  const page = await promotionsPage({ promotions: [COMBO], user: { id: 1, phone: '0912345678' } });
  page.trackUse(COMBO);

  // Through JSON, because the page's objects come out of another realm.
  assert.equal(
    JSON.stringify(page.events),
    JSON.stringify([{ name: 'promo_use', meta: { type: 'combo', id: 7 } }]),
  );
});

test('a browser whose oak-api.js has no track() still takes up the offer', async () => {
  /* The counting must never cost the visitor the click it is counting: a cached page
     meeting an older script would otherwise throw out of the 'Dùng ngay' handler. */
  const page = await promotionsPage({ promotions: [COMBO], user: { id: 1 }, tracking: false });

  assert.doesNotThrow(() => page.trackUse(COMBO));
  assert.equal(page.useUrl(COMBO), 'dat-lich.html?salon_id=4&service_id=12');
});
