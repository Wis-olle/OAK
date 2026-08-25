/* The newly-joined grid borrows the offers list to badge a card, and that borrowing is the
   whole risk: the grid is the page's own salon list and must keep standing whatever the
   offers read does. These tests drive the page's own factory over payloads shaped like
   GET /api/salons?sort=newest and GET /api/promotions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const html = fs.readFileSync(path.join(root, 'ui', 'kham-pha.html'), 'utf8');

const LALA = { name: 'Lala Nail Studio', slug: 'lala-nail-studio' };

const SALONS = [
  { id: 4, name: 'Lala Nail Studio', slug: 'lala-nail-studio' },
  { id: 5, name: 'Glow Spa', slug: 'glow-spa' },
  { id: 6, name: 'Bare Studio', slug: 'bare-studio' },
  { id: 7, name: 'Admin Salon', slug: 'admin-salon' },
];

/* The factory is inline in the page, so it is lifted out of its <script> and run here; the
   slice stops at the function's own closing brace because the rest of that <script> is
   page bootstrap that wants a document. `fmtPrice` is the page's own money formatter, so
   the amount label a test reads is the label a visitor reads. */
async function newSalons({ salons = SALONS, promotions = [], fails = '' } = {}) {
  const tail = html.slice(html.indexOf('function oakNewSalons()'));
  const script = tail.slice(0, tail.indexOf('\n    }\n') + 7);
  const context = {
    OAK: {
      api: async (url) => {
        const leg = url.startsWith('/api/promotions') ? 'promotions' : 'salons';
        if (leg === fails) {
          throw new Error('offline');
        }
        return leg === 'promotions' ? promotions : salons;
      },
      fmtPrice: (value) => Number(value).toLocaleString('vi-VN') + 'đ',
    },
  };
  vm.runInNewContext(`${script}\nresult = oakNewSalons();`, context);
  await context.result.load();
  return context.result;
}

test('a percentage outranks an amount from the same salon', async () => {
  const page = await newSalons({
    promotions: [
      { id: 3, title: 'Giảm 100.000đ', discount_amount: 100000, salon: LALA },
      { id: 9, title: 'Giảm 20%', discount_percent: 20, salon: LALA },
    ],
  });

  assert.equal(page.promoLabels['lala-nail-studio'], 'Giảm 20%');

  /* The route orders by id, so the amount can arrive second just as easily. */
  const other = await newSalons({
    promotions: [
      { id: 3, title: 'Giảm 20%', discount_percent: 20, salon: LALA },
      { id: 9, title: 'Giảm 100.000đ', discount_amount: 100000, salon: LALA },
    ],
  });

  assert.equal(other.promoLabels['lala-nail-studio'], 'Giảm 20%');

  /* quan-ly-dich-vu.html takes both figures on one offer, and the badge has room for one:
     the percentage reads without knowing what the service costs. */
  const both = await newSalons({
    promotions: [
      { id: 3, title: 'Giảm 20%', discount_percent: 20, discount_amount: 100000, salon: LALA },
    ],
  });

  assert.equal(both.promoLabels['lala-nail-studio'], 'Giảm 20%');
});

test('an amount offer says the price the page itself would print', async () => {
  const page = await newSalons({
    promotions: [{ id: 3, title: 'Giảm 50.000đ', discount_amount: 50000, salon: LALA }],
  });

  assert.equal(page.promoLabels['lala-nail-studio'], 'Giảm 50.000đ');
});

test('a platform-wide offer belongs to no salon and so badges no card', async () => {
  const page = await newSalons({
    promotions: [{ id: 1, title: 'Giảm 30%', discount_percent: 30, salon: null }],
  });

  // Through JSON, because the page's object comes out of another realm.
  assert.equal(JSON.stringify(page.promoLabels), '{}');
});

test('a combo has no discount to state, so it leaves the card bare', async () => {
  const page = await newSalons({
    promotions: [
      {
        id: 7,
        type: 'combo',
        title: 'Combo Sơn gel + Chăm sóc chân',
        original_price: 600000,
        sale_price: 480000,
        discount_percent: null,
        discount_amount: null,
        salon: LALA,
      },
    ],
  });

  assert.equal(JSON.stringify(page.promoLabels), '{}');
});

test('a salon named after a prototype member still carries only its own badge', async () => {
  /* slugify() lowercases to [a-z0-9-], so "Constructor" is a slug a salon can really have
     — and a plain {} would answer for it out of Object.prototype, painting the badge as
     the source of a function. */
  const page = await newSalons({ salons: [{ id: 8, name: 'Constructor', slug: 'constructor' }] });

  assert.equal(page.promoLabels['constructor'], undefined);
});

test('a failing offers read leaves the grid whole and says nothing went wrong', async () => {
  const page = await newSalons({ fails: 'promotions' });

  assert.equal(page.salons.length, 4);
  assert.equal(JSON.stringify(page.promoLabels), '{}');
  assert.equal(page.error, '');
});

test('a failing salons read is still the error the section reports', async () => {
  /* The badges are the extra; the list is the section, and its failure still offers the
     retry rather than an empty "nothing here". */
  const page = await newSalons({
    fails: 'salons',
    promotions: [{ id: 3, title: 'Giảm 20%', discount_percent: 20, salon: LALA }],
  });

  assert.equal(page.salons.length, 0);
  assert.equal(JSON.stringify(page.promoLabels), '{}');
  assert.match(page.error, /Không tải được salon mới/);
});
