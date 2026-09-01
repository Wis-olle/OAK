import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readUi } from './lib/read-source.mjs';

/* The five category pages are one page written five times: same control block, one
   category key apart. Every assertion below runs over all of them. */
const CATEGORY_PAGES = [
  { file: 'dich-vu-nail.html', key: 'nail' },
  { file: 'dich-vu-mi.html', key: 'eyelash' },
  { file: 'dich-vu-toc-chuyen-sau.html', key: 'hair' },
  { file: 'cham-soc-da.html', key: 'skincare' },
  { file: 'spa-massage.html', key: 'spa' },
];

/** The factory is inline in the page, so lift the last <script> out and run it here. */
function categoryPage(file, { search = '', api } = {}) {
  const html = readUi(file);
  const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  const name = script.match(/function (oak\w+Page)\(\)/)[1];
  const requests = [];
  const urls = [];
  const context = {
    URLSearchParams,
    location: { search, pathname: '/' + file },
    history: { replaceState: (state, title, url) => urls.push(url) },
    OAK: {
      api: async (requested) => {
        requests.push(requested);
        return api ? api(requested) : rows([]);
      },
      toast: () => {},
      fmtPriceFrom: () => '',
    },
  };
  vm.runInNewContext(`${script}\nresult = ${name}();`, context);
  return { state: context.result, requests, urls };
}

function rows(list, total = list.length) {
  const result = list.slice();
  result.meta = { page: 1, limit: 6, total };
  return result;
}

test('every category page asks for six services a page, its own category only', async () => {
  for (const page of CATEGORY_PAGES) {
    const { state } = categoryPage(page.file);
    assert.equal(
      state.pageUrl(2),
      '/api/services?category=' + page.key + '&sort=popular&page=2&limit=6',
      page.file,
    );
    state.subcategory = 'Gel';
    state.sort = 'price_asc';
    assert.equal(
      state.pageUrl(1),
      '/api/services?category=' + page.key + '&sort=price_asc&page=1&limit=6&subcategory=Gel',
      page.file,
    );
  }
});

test('the chip and the sort survive a reload, and a value the select never offers does not', () => {
  for (const page of CATEGORY_PAGES) {
    const { state } = categoryPage(page.file, { search: '?subcategory=Gel%20m%C3%B2ng&sort=rating' });
    state.readUrl();
    assert.equal(state.subcategory, 'Gel mòng', page.file);
    assert.equal(state.sort, 'rating', page.file);

    const injected = categoryPage(page.file, { search: '?sort=sv.price--' }).state;
    injected.readUrl();
    assert.equal(injected.sort, 'popular', page.file);
    assert.equal(injected.subcategory, '', page.file);
  }
});

test('loading the list writes the state it loaded back into the address bar', async () => {
  for (const page of CATEGORY_PAGES) {
    const { state, urls } = categoryPage(page.file);
    state.subcategory = 'Gel';
    state.sort = 'rating';
    await state.reload();
    assert.equal(urls.at(-1), '/' + page.file + '?subcategory=Gel&sort=rating', page.file);

    // The default list is the bare URL again — not ?sort=popular.
    state.subcategory = '';
    state.sort = 'popular';
    await state.reload();
    assert.equal(urls.at(-1), '/' + page.file, page.file);
  }
});

test('a query the page was opened with is left alone by the sync', async () => {
  const { state, urls } = categoryPage('dich-vu-nail.html', { search: '?utm_source=zalo' });
  await state.reload();
  assert.equal(urls.at(-1), '/dich-vu-nail.html?utm_source=zalo');
});

test('init reads the URL before it loads anything', async () => {
  for (const page of CATEGORY_PAGES) {
    const { state, requests } = categoryPage(page.file, { search: '?subcategory=Gel' });
    await state.init();
    assert.ok(
      requests.some((url) => url.includes('/api/services?category=' + page.key) && url.includes('&subcategory=Gel')),
      page.file + ': ' + requests.join(' | '),
    );
  }
});

test('the empty list offers the whole category instead of a dead end', () => {
  for (const page of CATEGORY_PAGES) {
    const html = readUi(page.file);
    const { state } = categoryPage(page.file);
    assert.equal(state.allSalonsUrl(), 'ket-qua-tim-kiem.html?category=' + page.key, page.file);
    assert.match(html, /<!-- OAK-EMPTY -->/, page.file);
    assert.match(html, /:href="allSalonsUrl\(\)"[^>]*>Xem tất cả salon</, page.file);
    // The frame is the one lifted from yeu-thich.html, so i18n and Tailwind see one shape.
    assert.match(html, /class="bg-surface-container-low rounded-lg py-16 px-6 text-center"/, page.file);
    assert.doesNotMatch(html, /class="py-8 font-body-md text-body-md text-on-surface-variant"/, page.file);
  }
});

test('the five pages carry the same control block, one category key apart', () => {
  const blocks = CATEGORY_PAGES.map((page) => {
    const html = readUi(page.file);
    // The block is the two constants plus the four methods that read and write them. What
    // each page keeps beside its service list, and fetches into it, is its own business.
    const head = html.slice(html.indexOf("        const CATEGORY = "), html.indexOf("        return {"));
    const from = html.indexOf("            readUrl() {");
    const to = html.indexOf("            },", html.indexOf("            pageUrl(page) {"));
    assert.ok(head && from > 0 && to > from, page.file);
    return (head + html.slice(from, to)).replace("const CATEGORY = '" + page.key + "';", "const CATEGORY = '<key>';");
  });
  for (const block of blocks) {
    assert.equal(block, blocks[0]);
  }
  assert.match(blocks[0], /const PAGE_SIZE = 6;/);
  assert.match(blocks[0], /history\.replaceState\(null, ''/);
});

test('every category page shows three featured salons, not two', () => {
  for (const page of CATEGORY_PAGES) {
    const html = readUi(page.file);
    for (const call of html.match(/\/api\/salons\?category=[^']*/g) || []) {
      /* spa-massage.html asks for ONE, and it is not the same section: the other four list
         salons to choose between, while that page builds an editorial bento out of a single
         salon's photographs. What every one of them has to hold to is the rule underneath the
         number — best rated within the category, earned rather than assigned. */
      const expected = page.file === 'spa-massage.html' ? /limit=1/ : /limit=3/;
      assert.match(call, expected, page.file + ': ' + call);
      assert.match(call, /sort=rating/, page.file + ': ' + call);
    }
  }
});

test('the spa spotlight is the best-rated spa, not a column only the seed writes', () => {
  /* It asked ?flagship=1, and salons.flagship is written by nothing but src/seed.js — so on a
     real deployment the bento was empty and a third of the page went with it. The other three
     readers of that column go with a later cut; this one is the page that loses most by it. */
  const html = readUi('spa-massage.html');
  assert.match(html, /OAK\.api\('\/api\/salons\?category=spa&sort=rating&limit=1'\)/);
  assert.doesNotMatch(html, /flagship=1/);
});
