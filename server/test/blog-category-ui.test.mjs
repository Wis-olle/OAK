import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { readServer, readUi } from './lib/read-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = readUi('assets/js/oak-blog.js');

/** oakBlogFeed() in a sandbox, with the API calls and login redirects it makes recorded. */
function feed({ api, search = '' } = {}) {
  const requests = [];
  const logins = [];
  const context = {
    URL,
    URLSearchParams,
    location: { search, pathname: 'blog.html', href: '' },
    history: { replaceState() {} },
    FileReader: class {},
    document: {
      getElementById: () => null,
      // The composer is a dialog now: it locks the page behind it and hands the
      // caret back on close.
      body: { classList: { add: () => {}, remove: () => {} } },
      activeElement: null,
      contains: () => false,
    },
    OAK: {
      api: async (path, options) => {
        requests.push({ path, options });
        return api ? api(path, options) : rows([]);
      },
      // The real one never settles once it redirects, so nothing after it may run.
      requireLogin: (next) => {
        logins.push(next);
        return new Promise(() => {});
      },
      toast: () => {},
      // closeComposer() discards any stashed draft; this harness never stashes one.
      takeDraft: () => null,
    },
  };
  vm.runInNewContext(`${script}\nresult = oakBlogFeed();`, context);
  /* Alpine's magic the composer uses: opening it moves the caret onto its heading. */
  context.result.$nextTick = (fn) => fn();
  return { state: context.result, requests, logins };
}

function rows(list, total = list.length) {
  const result = list.slice();
  result.meta = { page: 1, limit: 9, total };
  return result;
}

test('the feed asks the API for one category and drops it again with the scope', async () => {
  const { state, requests } = feed();
  await state.selectCategory('nail');
  assert.equal(state.category, 'nail');
  assert.match(requests.at(-1).path, /^\/api\/posts\?.*&category=nail$/);

  state.user = { id: 3, role: 'customer' };
  await state.selectScope('mine');
  assert.equal(state.category, '');
  assert.match(requests.at(-1).path, /^\/api\/posts\/mine\?/);
  assert.doesNotMatch(requests.at(-1).path, /category=/);
});

test('a post carries its category through the composer payload', () => {
  const { state } = feed();
  state.form = { ...state.form, type: 'article', title: 'Nail mùa thu', content: 'Một đoạn.' };
  assert.equal(state.buildPayload().body.category, null);

  state.form = { ...state.form, category: 'nail' };
  assert.equal(state.buildPayload().body.category, 'nail');

  state.scope = 'mine';
  state.editPost({ id: 5, type: 'article', title: 'A', content: 'B', category: 'spa', can_manage: true });
  assert.equal(state.form.category, 'spa');
});

test('a new post reaches the preview first; an edit is saved straight from the form', async () => {
  const saved = [];
  const { state } = feed({
    api: async (path, options) => {
      if (options) {
        saved.push({ path, options });
        return {};
      }
      return rows([]);
    },
  });
  state.user = { id: 3, role: 'customer' };
  state.form = { ...state.form, type: 'article', title: 'Bài mới', content: 'Nội dung.' };

  state.submitComposer();
  assert.equal(state.previewing, true);
  assert.equal(saved.length, 0);

  state.editingPost = { id: 12 };
  state.previewing = false;
  await state.submitComposer();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].path, '/api/posts/12');
  assert.equal(saved[0].options.method, 'PATCH');
  assert.equal(state.previewing, false);
});

test('a guest sent to sign in comes back to the composer, not just the feed', () => {
  const { state, logins } = feed({ search: '?type=video' });
  state.openComposer();
  assert.equal(state.composerOpen, false);
  // Through requireLogin, so an unreachable server still gets its own banner.
  assert.equal(logins.length, 1);
  assert.match(logins[0], /^blog\.html\?/);
  assert.match(logins[0], /compose=1/);
  assert.match(logins[0], /type=video/);
  const api = readUi('assets/js/oak-api.js');
  assert.match(api, /function requireLogin\(next\)/);
  assert.match(api, /redirectToLogin\(LOGIN_PAGE, next\)/);
  assert.match(api, /encodeURIComponent\(next \|\| currentUrl\(\)\)/);
});

test('the feed offers a topic filter and an end-of-feed way into a booking', () => {
  const html = readUi('blog.html');
  assert.match(html, /aria-label="Lọc theo chủ đề"/);
  assert.match(html, /selectCategory\(''\)/);
  assert.match(html, /x-for="item in categories"/);
  assert.match(html, /id="post-category"/);
  assert.match(html, /Chủ đề \(tùy chọn\)/);
  // The author sees the topic in the preview, beside the content type.
  assert.match(html, /categoryLabel\(previewPayload\.category\)/);
  assert.match(html, /href="ket-qua-tim-kiem\.html"/);
  assert.doesNotMatch(html + script, /x-html/);
});

test('the article ends on the salons that offer what it is about', () => {
  const html = readUi('blog-chi-tiet.html');
  // The heading claims kinship only when the list actually came from the category query.
  assert.match(html, /relatedByCategory \? 'Bài viết liên quan' : 'Bài viết khác'/);
  assert.match(html, /this\.relatedByCategory = true;/);
  assert.match(html, /max-w-\[65ch\]/);
  assert.match(html, /:href="ctaUrl"/);
  assert.match(html, /:href="categoryPageUrl"/);
  assert.match(html, /ket-qua-tim-kiem\.html\?category=/);
  assert.match(html, /'&category=' \+ encodeURIComponent\(category\)/);
  assert.doesNotMatch(html, /x-html/);
});

test('all three category tables name exactly the categories the API accepts', () => {
  const route = readServer('routes/posts.js');
  const detail = readUi('blog-chi-tiet.html');

  const api = [...route.match(/const CATEGORIES = \[([^\]]*)\]/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const feedValues = [...script.match(/const OAK_POST_CATEGORIES = \[([\s\S]*?)\];/)[1].matchAll(/value: '([^']+)'/g)].map((m) => m[1]);
  const labels = [...detail.match(/OAK_POST_CATEGORY_LABELS = \{([\s\S]*?)\};/)[1].matchAll(/(\w+):/g)].map((m) => m[1]);
  const pages = [...detail.match(/OAK_POST_CATEGORY_PAGES = \{([\s\S]*?)\};/)[1].matchAll(/(\w+):/g)].map((m) => m[1]);

  assert.equal(api.length, 5);
  for (const table of [feedValues, labels, pages]) {
    assert.deepEqual([...table].sort(), [...api].sort());
  }
});

test('the posts route stores, filters and validates the five service categories', () => {
  const route = readServer('routes/posts.js');
  const schema = readServer('db.js');
  assert.match(route, /const CATEGORIES = \['nail', 'hair', 'skincare', 'spa', 'eyelash'\]/);
  assert.match(route, /CATEGORIES\.includes\(req\.query\.category\)/);
  assert.match(route, /Chủ đề bài viết không hợp lệ\./);
  assert.match(schema, /ALTER TABLE posts ADD COLUMN IF NOT EXISTS category TEXT;/);
  assert.match(schema, /category IS NULL OR category IN \('nail','hair','skincare','spa','eyelash'\)/);
});

test('every customer footer carries the blog and the current copyright year', () => {
  const pages = fs.readdirSync(path.join(root, 'ui')).filter((name) => name.endsWith('.html'));
  let footers = 0;
  for (const page of pages) {
    const html = readUi(page);
    const footer = html.match(/<footer[\s\S]*?<\/footer>/);
    if (!footer) {
      continue;
    }
    footers += 1;
    assert.match(footer[0], /href="blog\.html">Blog</, page);
    // The sitemap is reachable from nowhere else, so the footer is its only way in.
    assert.match(footer[0], /href="sitemap\.html">Sơ đồ trang</, page);
    assert.match(footer[0], /© 2026 OAK Beauty/, page);
    assert.doesNotMatch(footer[0], /© 2024/, page);
  }
  assert.ok(footers > 25, `only ${footers} pages have a footer`);
});

test('the sitemap reads as a customer page, with no internal screen counts or console links', () => {
  const html = readUi('sitemap.html');
  assert.match(html, /<title>Sơ đồ trang - OAK Beauty<\/title>/);
  assert.match(html, /data-oak-header/);
  assert.match(html, /assets\/js\/oak-i18n\.js/);
  for (const leak of [/màn hình/, /phase 2/i, /tong-quan-doi-tac\.html/, /quan-ly-/, /bao-cao-doanh-thu\.html/, /cai-dat-salon\.html/]) {
    assert.doesNotMatch(html, leak, String(leak));
  }
  assert.match(html, /href="dang-nhap-doi-tac\.html"/);
  // danh-sach-salon.html only redirects to the row above it, so it is not listed twice.
  assert.doesNotMatch(html, /href="danh-sach-salon\.html"/);
  assert.match(html, /name="description"/);
  assert.match(html, /property="og:title"/);
  assert.doesNotMatch(readUi('index.html'), /màn hình/);
});
