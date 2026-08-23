/* The technical-SEO layer is four files and two route lines, and every one of them is the kind
   of thing that breaks silently: a private page that loses its noindex is indexed as a blank
   login screen, a sitemap that lists one is worse, and a 404 that answers 200 teaches the
   crawler that every typo is a real page. None of it shows up on screen, so it is pinned here. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ui = path.join(root, 'ui');
const pages = fs.readdirSync(ui).filter((name) => name.endsWith('.html')).sort();
const readUi = (name) => fs.readFileSync(path.join(ui, name), 'utf8');

/* The account area, the partner console, the auth screens, the two redirect stubs and the one
   hard-coded salon sample. Behind a login or a redirect, so an indexed copy is an empty page. */
const PRIVATE = [
  'bao-cao-doanh-thu.html', 'cai-dat-salon.html', 'cai-dat.html', 'dang-ky.html',
  'dang-nhap-doi-tac.html', 'dang-nhap-nguoi-dung.html', 'danh-gia-cua-toi.html',
  'danh-gia-salon.html', 'danh-sach-salon.html', 'dat-lai-mat-khau.html', 'dat-lich.html', 'ho-so-ca-nhan.html',
  'index.html', 'lich-hen-cua-toi.html', 'quan-ly-dich-vu.html', 'quan-ly-lich-hen.html',
  'quan-ly-nhan-vien.html', 'salon-profile-lala-nail-studio.html', 'thong-bao.html',
  'tong-quan-doi-tac.html', 'xac-nhan-dat-lich.html', 'yeu-thich.html',
];
const PUBLIC = pages.filter((page) => !PRIVATE.includes(page) && page !== '404.html');

const CATEGORIES = [
  'dich-vu-nail.html', 'dich-vu-toc-chuyen-sau.html', 'cham-soc-da.html',
  'spa-massage.html', 'dich-vu-mi.html',
];

const robots = fs.readFileSync(path.join(ui, 'robots.txt'), 'utf8');
const sitemap = fs.readFileSync(path.join(ui, 'sitemap.xml'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'server/src/app.js'), 'utf8');

test('exactly the private pages are noindexed', () => {
  const noindexed = pages.filter((page) => /<meta content="noindex,nofollow" name="robots">/.test(readUi(page)));
  assert.deepEqual(noindexed, [...PRIVATE].sort());
  assert.equal(noindexed.length, 22);
});

test('robots.txt keeps crawlers out of the API, the uploads and every private page', () => {
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Disallow: \/api\/$/m);
  assert.match(robots, /^Disallow: \/uploads\/$/m);
  for (const page of PRIVATE) {
    assert.match(robots, new RegExp(`^Disallow: /${page.replace(/\./g, '\\.')}$`, 'm'), page);
  }
  for (const page of PUBLIC) {
    assert.doesNotMatch(robots, new RegExp(`^Disallow: /${page.replace(/\./g, '\\.')}$`, 'm'), page);
  }
  // express.static answers /404.html with a 200 of its own, so the branded 404 body is a thin
  // indexable page under the brand unless it is excluded here.
  assert.match(robots, /^Disallow: \/404\.html$/m);
  assert.match(robots, /^Sitemap: https:\/\/[^\s]+\/sitemap\.xml$/m);
});

test('sitemap.xml lists the public pages and nothing behind a login', () => {
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  assert.equal(locs.length, 20);
  assert.ok(new Set(locs).size === locs.length, 'a URL is listed twice');

  const origin = robots.match(/^Sitemap: (https:\/\/[^\s]+)\/sitemap\.xml$/m)[1];
  assert.ok(locs.includes(`${origin}/`), 'the home page is missing');

  const named = locs.map((loc) => loc.slice(origin.length + 1));
  for (const page of PRIVATE) assert.ok(!named.includes(page), `${page} is in the sitemap`);
  assert.ok(!named.includes('404.html'), 'the 404 page is in the sitemap');
  // '/' already serves kham-pha.html; naming both declares the same page twice.
  assert.ok(!named.includes('kham-pha.html'), 'the home page is listed twice');
  for (const page of PUBLIC) {
    if (page === 'kham-pha.html') continue;
    assert.ok(named.includes(page), `${page} is missing from the sitemap`);
  }
});

test('the server answers / with the home page and an unknown page with a branded 404', () => {
  assert.match(appJs, /app\.get\('\/',[\s\S]*?sendFile\(path\.join\(uiDir, 'kham-pha\.html'\)\)/);
  assert.match(appJs, /res\.status\(404\)\.sendFile\(path\.join\(uiDir, '404\.html'\)\)/);

  // A caller that sends no Accept header at all states no preference, and req.accepts falls to
  // the first listed type — so a bare `curl /khong-ton-tai.html` got 9 bytes of text/plain
  // where the acceptance check asks for the branded page.
  assert.match(appJs, /req\.headers\.accept && req\.accepts\(\['text\/plain', 'text\/html'\]\)/);

  // Registration order is the whole behaviour: express.static would answer '/' with
  // index.html — the redirect stub — if it were mounted first, and would never reach the
  // 404 handler if that were mounted before it.
  assert.ok(appJs.indexOf("app.get('/'") < appJs.indexOf('app.use(express.static(uiDir))'));
  assert.ok(appJs.indexOf('app.use(express.static(uiDir))') < appJs.indexOf("'404.html'"));
});

test('the 404 page offers a way back rather than a dead end', () => {
  const notFound = readUi('404.html');
  /* The server hands this page back for every unmatched path, and an old or renamed URL —
     the case the page exists for — is usually a nested one. Without a base, 'assets/js/…'
     under /blog/bai-cu asks for /blog/assets/js/… and the page arrives unstyled with a
     'home' link pointing at /blog/kham-pha.html. The base has to precede the first URL. */
  assert.match(notFound, /<base href="\/">/, 'the 404 page has no base URL');
  const firstUrl = notFound.search(/\s(?:src|href)="/);
  assert.ok(notFound.indexOf('<base href="/">') < firstUrl, 'an asset is requested before the base');
  assert.match(notFound, /href="kham-pha\.html"/, 'no link home');
  assert.match(notFound, /<form action="ket-qua-tim-kiem\.html"[^>]*method="get"/, 'no search form');
  assert.match(notFound, /name="q"/, 'the search form sends no query');
  assert.match(notFound, /data-oak-header/, 'the page does not carry the site header');
});

test('the home page title says what OAK does and where', () => {
  const home = readUi('kham-pha.html');
  const title = home.match(/<title>([^<]+)<\/title>/)[1];
  assert.match(title, /OAK Beauty/);
  assert.match(title, /Đặt lịch/);
  assert.match(title, /TP\.HCM/);
  assert.ok(home.includes(`<meta content="${title}" property="og:title">`), 'og:title drifted');
  assert.match(home, /<link href="https:\/\/[^"]+\/" rel="canonical">/);

  for (const page of CATEGORIES) {
    const source = readUi(page);
    const heading = source.match(/<title>([^<]+)<\/title>/)[1];
    assert.match(heading, /^Đặt lịch .* tại TP\.HCM – OAK Beauty$/, page);
    // The share card and the tab said different things once; this is why.
    assert.ok(source.includes(`<meta content="${heading}" property="og:title">`), `og:title drifted on ${page}`);
  }
});

test('the home page and the contact page carry parseable structured data', () => {
  const blocks = (name) =>
    [...readUi(name).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map((match) => JSON.parse(match[1]));

  const [home] = blocks('kham-pha.html');
  const types = home['@graph'].map((node) => node['@type']);
  assert.deepEqual(types.sort(), ['Organization', 'WebSite']);
  const website = home['@graph'].find((node) => node['@type'] === 'WebSite');
  assert.match(website.potentialAction.target.urlTemplate, /ket-qua-tim-kiem\.html\?q=\{search_term_string\}/);

  const [contact] = blocks('lien-he.html');
  assert.equal(contact['@type'], 'Organization');
  assert.equal(contact.contactPoint[0].telephone, '1900 6035');
  assert.ok(contact.contactPoint[0].hoursAvailable.length >= 1);
});

test('each category page declares its breadcrumb where a search engine can read it', () => {
  const origin = robots.match(/^Sitemap: (https:\/\/[^\s]+)\/sitemap\.xml$/m)[1];

  for (const page of CATEGORIES) {
    const source = readUi(page);
    const blocks = [...source.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map((match) => JSON.parse(match[1]));
    // Exactly one, not "at least one": a second copy of the same trail is duplicate
    // structured data, and reading only the first block would let it ship unnoticed.
    assert.equal(blocks.length, 1, page);
    const [block] = blocks;
    assert.equal(block['@type'], 'BreadcrumbList', page);

    const [home, here] = block.itemListElement;
    assert.equal(home.item, `${origin}/`, page);
    assert.equal(here.item, `${origin}/${page}`, page);
    // The structured trail and the one on screen have to name the same step.
    const leaf = source.match(/aria-current="page"[^>]*>([^<]+)</)[1];
    assert.equal(here.name, leaf.replace(/&amp;/g, '&'), page);
  }
});

test('the contact page publishes no channel and no number it cannot answer', () => {
  const contact = readUi('lien-he.html');
  /* A guessed Zalo or Messenger handle is a dead support channel with a brand's name on it,
     and a 1900 number in +84 form cannot be dialled from abroad at all. This looks for OAK's
     own accounts only: the share buttons and the salon profile links build zalo.me and
     facebook.com URLs from real salon data, and those are not claims about OAK. */
  const OWN_ACCOUNT = /zalo\.me\/19006035|(?:m\.me|facebook\.com|zalo\.me)\/oakbeauty/;
  for (const page of pages) {
    assert.doesNotMatch(readUi(page), OWN_ACCOUNT, page);
  }
  assert.match(contact, /href="tel:19006035"/, 'the hotline is gone too');
  assert.match(contact, /href="mailto:hello@oakbeauty\.vn"/, 'the email is gone too');
  // The signature used to name a domain this build has no way of knowing it is served from.
  assert.match(contact, /Gửi từ ' \+ location\.hostname/);
  assert.doesNotMatch(contact, /oakbeauty\.vn';/);
});

test('no page still calls itself a demo', () => {
  for (const page of pages) {
    assert.doesNotMatch(readUi(page), /Bản demo/, page);
  }
});

test('the partner half of the terms exists and is what partners are asked to accept', () => {
  const terms = readUi('dieu-khoan.html');
  assert.match(terms, /id="doi-tac"/);
  assert.match(terms, /Phiên bản 1\.1/);
  for (const promise of [/4 giờ làm việc/, /31\/12\/2026/, /30 ngày/]) {
    assert.match(terms, promise, `the partner section does not state ${promise}`);
  }
  assert.match(readUi('dang-nhap-doi-tac.html'), /href="dieu-khoan\.html#doi-tac"/);
  // The free period is quoted in two places; a date in one and vagueness in the other is
  // how a promise turns into a dispute.
  assert.match(readUi('gioi-thieu.html'), /miễn phí đến hết 31\/12\/2026/);
});

test('the privacy policy names where the data actually lives and under which law', () => {
  const privacy = readUi('bao-mat.html');
  assert.match(privacy, /Supabase/);
  assert.match(privacy, /Singapore/);
  assert.match(privacy, /Render/);
  assert.match(privacy, /Luật Bảo vệ dữ liệu cá nhân/);
  assert.match(privacy, /YouTube/, 'the embedded video sets its own cookies and goes unmentioned');
  assert.match(privacy, /24 tháng/, 'no retention period');
  assert.match(privacy, /Rút lại đồng ý/, 'no right to withdraw consent');
  // The old text put the data "on OAK Beauty's own servers", which was never true.
  assert.doesNotMatch(privacy, /Dữ liệu được lưu trên máy chủ của OAK Beauty\./);
});

test('the HTML site map sends a visitor somewhere that works', () => {
  const map = readUi('sitemap.html');

  // dat-lich.html is step 1 of the wizard with nothing chosen yet: a dead end for anyone
  // arriving from the site map rather than from a salon.
  assert.doesNotMatch(map, /href="dat-lich\.html"/, 'the site map still links the empty wizard');
  assert.match(map, /href="ket-qua-tim-kiem\.html">Tìm salon và đặt lịch</);
  assert.match(map, /href="dieu-khoan\.html#doi-tac">Điều khoản đối tác</);

  // Six pages behind a login, said before the click rather than after it.
  const gated = ['ho-so-ca-nhan.html', 'lich-hen-cua-toi.html', 'yeu-thich.html',
    'danh-gia-cua-toi.html', 'thong-bao.html', 'cai-dat.html'];
  for (const page of gated) {
    const item = map.slice(map.indexOf(`href="${page}"`));
    assert.match(item.slice(0, item.indexOf('</li>')), /\(cần đăng nhập\)/, page);
  }

  // The flagship branch page is a place, not a service category.
  const categories = map.slice(map.indexOf('>Danh mục dịch vụ<'));
  assert.doesNotMatch(categories.slice(0, categories.indexOf('</ul>')), /khong-gian-tien-ich/);
  assert.match(map, /href="khong-gian-tien-ich\.html"/, 'the page is no longer listed at all');
});
