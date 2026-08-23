/*
 * The platform surfaces that hold the site together and show up nowhere on screen: the web
 * app manifest and the tags that point at it, the one line a reader without scripting gets,
 * the way in to Beauty Map, the salon owner's own account inside the console, the blog's
 * shareable address, and the moderation the terms promise. Every one of them breaks silently
 * — an unreachable manifest is still a page that renders — so they are pinned here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ui = path.join(root, 'ui');
const readUi = (name) => fs.readFileSync(path.join(ui, name), 'utf8');
const readServer = (name) => fs.readFileSync(path.join(root, 'server/src', name), 'utf8');

/* The same split robots.txt, ui/sitemap.xml and server/test/seo-ui.test.mjs are built on. */
const PRIVATE = [
  'bao-cao-doanh-thu.html', 'cai-dat-salon.html', 'cai-dat.html', 'dang-ky.html',
  'dang-nhap-doi-tac.html', 'dang-nhap-nguoi-dung.html', 'danh-gia-cua-toi.html',
  'danh-gia-salon.html', 'danh-sach-salon.html', 'dat-lai-mat-khau.html', 'dat-lich.html',
  'ho-so-ca-nhan.html', 'index.html', 'lich-hen-cua-toi.html', 'quan-ly-dich-vu.html',
  'quan-ly-lich-hen.html', 'quan-ly-nhan-vien.html', 'salon-profile-lala-nail-studio.html',
  'thong-bao.html', 'tong-quan-doi-tac.html', 'xac-nhan-dat-lich.html', 'yeu-thich.html',
];
const pages = fs.readdirSync(ui).filter((name) => name.endsWith('.html')).sort();
const PUBLIC = pages.filter((page) => !PRIVATE.includes(page) && page !== '404.html');

/** The six pages of the partner console, which carry their own bar rather than the customer one. */
const CONSOLE = [
  'tong-quan-doi-tac.html', 'quan-ly-lich-hen.html', 'quan-ly-dich-vu.html',
  'quan-ly-nhan-vien.html', 'bao-cao-doanh-thu.html', 'cai-dat-salon.html',
];

/**
 * Run ui/assets/js/oak-header.js into a stand-in document and hand back what it wrote —
 * the bar itself and, here, the tags it adds to the head. Same trick as header-ui.test.mjs:
 * the file is one IIFE over a shell element.
 */
function header(pathname = 'kham-pha.html') {
  const shell = { innerHTML: '', insertAdjacentHTML() {} };
  const head = [];
  const context = {
    location: { pathname },
    document: {
      querySelector: (selector) => (selector === '[data-oak-header]' ? shell : null),
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: (tag) => ({
        tag,
        attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; },
      }),
      head: { appendChild: (node) => head.push(node) },
      body: null,
    },
    window: { addEventListener() {} },
  };
  vm.runInNewContext(fs.readFileSync(path.join(ui, 'assets/js/oak-header.js'), 'utf8'), context);
  return { markup: shell.innerHTML, head };
}

test('the manifest names an installable app and every icon it promises exists', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ui, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.name, 'OAK Beauty');
  assert.ok(manifest.short_name, 'no short name for the home screen');
  assert.equal(manifest.display, 'standalone');
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/);
  assert.match(manifest.background_color, /^#[0-9a-f]{6}$/);
  // A relative start_url resolves against the manifest, which sits beside the pages.
  assert.equal(manifest.start_url, 'kham-pha.html');
  assert.ok(!manifest.start_url.startsWith('/'), 'start_url must not assume a root deploy');

  const sizes = manifest.icons.map((icon) => icon.sizes);
  for (const required of ['192x192', '512x512']) {
    assert.ok(sizes.includes(required), `no ${required} icon`);
  }
  for (const icon of manifest.icons) {
    const file = path.join(ui, icon.src);
    assert.ok(fs.existsSync(file), `${icon.src} is declared but not shipped`);
    // A PNG and not, say, a renamed JPEG: the header of the file says which it is.
    assert.equal(fs.readFileSync(file).subarray(1, 4).toString(), 'PNG', icon.src);
  }
});

test('the top bar installs the manifest, the theme colour and the iOS icon', () => {
  const { head } = header();
  const written = Object.fromEntries(
    head.map((node) => [node.attributes.rel || node.attributes.name, node.attributes]),
  );

  assert.equal(written.manifest.href, 'manifest.webmanifest');
  assert.equal(written['apple-touch-icon'].href, 'assets/images/icon-192.png');
  assert.equal(
    written['theme-color'].content,
    JSON.parse(fs.readFileSync(path.join(ui, 'manifest.webmanifest'), 'utf8')).theme_color,
    'the browser chrome and the installed app are painted different colours',
  );
  // Relative, like every other asset a page asks for: '/'-rooted would break a sub-path deploy.
  for (const node of head) {
    const href = node.attributes.href;
    if (href) assert.ok(!href.startsWith('/'), href);
  }
});

test('every public page says something without scripting, and says the same thing', () => {
  const blocks = PUBLIC.map((page) => {
    const source = readUi(page);
    const start = source.indexOf('<noscript>');
    assert.notEqual(start, -1, `${page} is blank with scripting off`);
    return source.slice(start, source.indexOf('</noscript>', start));
  });

  // One copy, swept by script: twenty hand-edited variants is how a phone number drifts.
  assert.equal(new Set(blocks).size, 1, 'the noscript block is not identical on every page');
  assert.match(blocks[0], /href="tel:19006035"/, 'no number to call');
  assert.match(blocks[0], /JavaScript/);

  // It belongs where a reader lands, not behind a login: the console and the account pages
  // are unreachable without a session anyway.
  for (const page of PRIVATE) {
    assert.doesNotMatch(readUi(page), /<noscript>/, page);
  }
});

test('Beauty Map has an address of its own and a way in from every page', () => {
  const home = readUi('kham-pha.html');
  assert.match(home, /<section[^>]*id="beauty-map"/, 'the section cannot be linked to');

  const { markup } = header('blog.html');
  assert.match(markup, /href="kham-pha\.html#beauty-map">Beauty Map</, 'no menu entry');
});

test('on a phone the bookable salons come before the two-screen picture', () => {
  const home = readUi('kham-pha.html');
  const map = home.indexOf('id="beauty-map"');
  const salons = home.indexOf('Salon nổi bật gần bạn');
  assert.ok(map < salons, 'the sections are no longer in this order in the markup');

  // Which is why the order is set in CSS: below md the salons are first, from md the
  // reading order of the markup comes back.
  const section = (marker) => home.slice(home.lastIndexOf('<section', home.indexOf(marker)));
  assert.match(section('id="beauty-map"').slice(0, 400), /order-2 md:order-1/);
  assert.match(section('Salon nổi bật gần bạn').slice(0, 400), /order-1 md:order-2/);
  // order-* only means anything inside a flex or grid container.
  assert.match(home.slice(0, map), /<div class="flex flex-col gap-section-gap mb-section-gap">/);
});

test('the console keeps a salon owner in the console', () => {
  for (const page of CONSOLE) {
    const source = readUi(page);
    assert.match(source, /aria-label="Tài khoản"[^>]*href="cai-dat-salon\.html#tai-khoan"/, page);
    // The customer profile page renders a rail of appointments, favourites and reviews.
    assert.doesNotMatch(source, /href="ho-so-ca-nhan\.html"/, `${page} still leaves the console`);
  }

  const settings = readUi('cai-dat-salon.html');
  const block = settings.slice(settings.indexOf('id="tai-khoan"'), settings.indexOf('</main>'));
  assert.match(block, /x-data="salonAccount\(\)"/);
  for (const field of ['account-name', 'account-phone', 'account-current-password',
    'account-new-password', 'account-confirm-password']) {
    assert.ok(block.includes(`id="${field}"`), `${field} is missing from the owner's account`);
  }
  assert.match(block, /setLang\('en'\)/, 'no way to switch language inside the console');
  // Its own component and its own requests: the salon form guards leaving the page on
  // unsaved changes, and the owner's name is not part of that.
  assert.match(settings, /function salonAccount\(\)/);
  assert.match(settings, /'\/api\/auth\/change-password'/);
});

/** oakBlogFeed() over a stand-in browser, with the address bar and the requests recorded. */
function blogFeed(search = '', failing = false) {
  const requests = [];
  const location = { pathname: 'blog.html', search, href: '' };
  const context = {
    URL,
    URLSearchParams,
    location,
    history: {
      replaceState(state, title, url) {
        const mark = url.indexOf('?');
        location.search = mark === -1 ? '' : url.slice(mark);
      },
    },
    FileReader: class {},
    document: {
      getElementById: () => null,
      body: { classList: { add() {}, remove() {} } },
      activeElement: null,
      contains: () => false,
    },
    window: { addEventListener() {} },
    OAK: {
      api: async (pathname) => {
        requests.push(pathname);
        if (failing) {
          throw new Error('Không tải được bài viết.');
        }
        const rows = [];
        rows.meta = { page: 1, limit: 9, total: 40 };
        return rows;
      },
      me: async () => ({ id: 1, role: 'customer' }),
      qs: (name) => new URLSearchParams(location.search).get(name),
      takeDraft: () => null,
      toast() {},
    },
  };
  vm.runInNewContext(
    `${fs.readFileSync(path.join(ui, 'assets/js/oak-blog.js'), 'utf8')}\nresult = oakBlogFeed();`,
    context,
  );
  return { state: context.result, location, requests };
}

test('the blog feed keeps its state in the address bar, and reads it back', async () => {
  const opened = blogFeed();
  await opened.state.init();
  // Nothing chosen is nothing in the URL: the default feed keeps a clean address.
  assert.equal(opened.location.search, '');

  await opened.state.selectCategory('nail');
  await opened.state.selectType('video');
  assert.equal(new URLSearchParams(opened.location.search).get('category'), 'nail');
  assert.equal(new URLSearchParams(opened.location.search).get('type'), 'video');

  await opened.state.loadMore();
  assert.equal(new URLSearchParams(opened.location.search).get('page'), '2');

  // What F5 does: the same address, a fresh component.
  const reloaded = blogFeed(opened.location.search);
  await reloaded.state.init();
  assert.equal(reloaded.state.category, 'nail');
  assert.equal(reloaded.state.type, 'video');
  assert.equal(reloaded.state.page, 2);
  // Two pages restored as one request, because the API caps a request at 50 rows.
  assert.match(reloaded.requests[0], /limit=18&page=1/);
  assert.match(reloaded.requests[0], /category=nail/);

  // A value no chip offers filters the feed to nothing and lights nothing up.
  const typed = blogFeed('?category=zzz');
  await typed.state.init();
  assert.equal(typed.state.category, '');

  // A restored page that never lands is a failure of the whole list, not an empty topic:
  // the reader gets the error and its "Thử lại" rather than "no posts here yet".
  const broken = blogFeed('?page=2', true);
  await broken.state.init();
  assert.equal(broken.state.loadError, true, 'a failed restore reads as an empty feed');
  assert.equal(broken.state.posts.length, 0);
});

test('a post can be sent to somebody who is not on OAK yet', () => {
  const post = readUi('blog-chi-tiet.html');
  assert.match(post, /aria-label="Chia sẻ"/);
  assert.match(post, /navigator\.share/, 'no share sheet on a phone');
  assert.match(post, /navigator\.clipboard\.writeText\(location\.href\)/, 'no fallback');
  assert.match(post, /https:\/\/zalo\.me\/share\?url=' \+ encodeURIComponent\(location\.href\)/);
  assert.match(post, /facebook\.com\/sharer\/sharer\.php\?u=' \+ encodeURIComponent\(location\.href\)/);
});

test('the about page shows salons that exist and admits when it cannot', () => {
  const about = readUi('gioi-thieu.html');
  assert.match(about, /'\/api\/salons\?featured=1&limit=6'/);
  // An empty list draws nothing; a failed request is a different answer and says so.
  assert.match(about, /x-show="partnersError \|\| partners\.length > 0"/);
  assert.match(about, /Không tải được danh sách salon\./);
  assert.match(about, /@click="loadPartners\(\)"/);
  assert.match(about, /Không tải được số liệu\./);
  assert.match(about, /@click="loadStats\(\)"/);

  // The office, the hotline and the address are the contact page's, not invented here, and
  // there is still no tax code because there is still no legal entity to name.
  assert.match(about, /Liên hệ &amp; địa chỉ/);
  assert.doesNotMatch(about, /Pháp nhân/, 'the heading promises an entity the cards do not name');
  assert.match(about, /Tầng 8, 72 Lê Thánh Tôn/);
  assert.match(about, /href="tel:19006035"/);
  assert.doesNotMatch(about, /MST|Mã số thuế/);
});

test('the results page tells a search engine which search it is', () => {
  const results = readUi('ket-qua-tim-kiem.html');
  const applyMeta = results.slice(results.indexOf('applyMeta() {'));
  assert.match(applyMeta.slice(0, 900), /OAK\.meta\(/);
  assert.match(applyMeta.slice(0, 900), /CATEGORY_LABELS\.get\(this\.incoming\.category\)/);
  // Both halves come from a list the page itself offers, so a crafted ?district=… cannot
  // become the sentence a shared link previews as — which is why it waits for the areas.
  assert.match(applyMeta.slice(0, 900), /this\.districts\.includes\(this\.incoming\.district\)/);
  assert.match(results, /this\.districts = await OAK\.districts\(\);\n\s*this\.applyMeta\(\);/);

  // Assembled in JS, so neither shape can be a dictionary key: each carries a rule, and
  // tools/i18n/check-rules.js holds the English they make.
  const engine = fs.readFileSync(path.join(ui, 'assets/js/oak-i18n.js'), 'utf8');
  assert.match(engine, /\^Salon\(\?: \(\.\+\)\)\? tại \(\.\+\) - OAK Beauty\$/);
  assert.match(engine, /\^Danh sách salon\(\?: \(\.\+\)\)\? tại \(\.\+\) trên OAK Beauty/);
  // The static title the page ships with is what Phase 2 pinned; this only replaces it
  // once there is something better to say.
  assert.match(results, /<title>Tìm salon - OAK Beauty<\/title>/);
});

test('the public feed is the published half of the blog, written at a human rate', () => {
  const posts = readServer('routes/posts.js');
  assert.match(posts, /const conditions = \["p\.status = 'published'"\]/);
  assert.match(posts, /WHERE c\.post_id = \? AND c\.status = 'published'/);
  assert.match(posts, /post\.status !== 'published'/, 'a hidden post is still at its own URL');
  assert.match(posts, /POST_MAX_PER_HOUR = 5/);
  assert.match(posts, /COMMENT_MAX_PER_HOUR = 20/);
  assert.match(posts, /rateLimited\(postAttempts, req\.user\.id, POST_MAX_PER_HOUR\)/);
  assert.match(posts, /rateLimited\(commentAttempts, req\.user\.id, COMMENT_MAX_PER_HOUR\)/);
  // Hiding is an operator's tool, and an unset ADMIN_EMAILS means nobody rather than everybody.
  assert.match(posts, /ADMIN_EMAILS\.has\(String\(req\.user\.email \|\| ''\)\.toLowerCase\(\)\)/);
  assert.match(posts, /router\.patch\('\/:id\/status'/);
  // "Bài viết của tôi" is not filtered on status, so it is the one list a hidden post is
  // still on: it says which row that is rather than linking to a URL that answers 404.
  const mine = posts.slice(posts.indexOf("router.get('/mine'"), posts.indexOf("router.post('/'"));
  assert.match(mine, /status: row\.status,/);
  const feed = readUi('blog.html');
  assert.match(feed, /x-if="post\.status === 'hidden'"/);
  assert.match(feed, />Đã ẩn</);

  const schema = fs.readFileSync(path.join(root, 'server/src/db.js'), 'utf8');
  assert.match(schema, /ALTER TABLE posts ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'published'/);
  assert.match(schema, /ALTER TABLE post_comments ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'published'/);
});

test('the site map is generated from what the site actually holds', () => {
  const app = readServer('app.js');
  assert.match(app, /app\.get\('\/sitemap\.xml'/);
  // Above the static handler, which would answer with the committed file instead.
  assert.ok(app.indexOf("app.get('/sitemap.xml'") < app.indexOf('express.static(uiDir'));
  assert.match(app, /FROM salons WHERE verified = 1 AND published = 1/);
  assert.match(app, /FROM posts WHERE status = 'published'/);
  // The four query-driven shells are replaced by the addresses that hold something, not
  // added to — and the pages half still comes from the one committed list.
  assert.match(app, /SITEMAP_SHELL/);
  assert.match(app, /sitemap\.xml'\), 'utf8'\)/);
});

test('a salon or service image cannot be a script URL', () => {
  const partner = readServer('routes/partner.js');
  assert.match(partner, /function optionalMediaUrl\(value, label\) \{/);
  // All four stored image columns of this router: the salon's and the technician's avatar,
  // the service and the offer. One rule, or the next sink added copies the weaker one.
  for (const label of ['Ảnh dịch vụ', 'Ảnh đại diện', 'Ảnh ưu đãi']) {
    assert.match(partner, new RegExp(`image: \\(value\\) => optionalMediaUrl\\(value, '${label}'\\)`), label);
  }
  assert.doesNotMatch(partner, /image: \(value\) => optionalText\(/, 'an image sink takes any string');
  // The same message the gallery-photo sink answers with, so one wrong paste reads the same
  // wherever it lands.
  const guard = partner.slice(partner.indexOf('function optionalMediaUrl'));
  assert.match(guard.slice(0, 400), /Đường dẫn ảnh không hợp lệ\./);
});

test('a week of one service asks about each day once', () => {
  const availability = fs.readFileSync(path.join(root, 'server/src/lib/availability.js'), 'utf8');
  assert.match(
    availability,
    /export async function getStaffSlots\(staffId, serviceId, date, knownOff = null, leadMin = null\)/,
  );
  const staff = readServer('routes/staff.js');
  assert.match(staff, /getStaffSlots\(staffId, serviceId, date, off\)/);
});
