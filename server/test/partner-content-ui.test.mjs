import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readUi = (name) => fs.readFileSync(path.join(root, 'ui', name), 'utf8');

test('salon settings exposes all five social profile fields and saves the object', () => {
  const html = readUi('cai-dat-salon.html');
  for (const platform of ['facebook', 'instagram', 'tiktok', 'youtube', 'zalo']) {
    assert.match(html, new RegExp(`platform: '${platform}'`));
  }
  assert.match(html, /social_links:\s*Object\.assign/);
  assert.match(html, /salon\.social_links/);
});

test('public salon profile renders only allowlisted links without x-html', () => {
  const html = readUi('salon-profile-lala-nail-studio.html');
  assert.match(html, /safeSocialLinks\(\)/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /target="_blank"/);
  assert.doesNotMatch(html, /x-html/);
});

test('Blog integrates author scope, edit, delete, and role-guarded social source controls', () => {
  const html = readUi('blog.html');
  const script = readUi('assets/js/oak-blog.js');
  assert.match(html, /Cộng đồng/);
  assert.match(html, /Bài viết của tôi/);
  assert.match(script, /\/api\/posts\/mine/);
  assert.match(script, /method: 'PATCH'/);
  assert.match(script, /method: 'DELETE'/);
  assert.match(script, /window\.confirm/);
  assert.match(script, /editingPost/);
  assert.match(script, /user\.role === 'partner'/);
  assert.match(script, /loadToken/);
  assert.match(script, /token !== this\.loadToken/);
  assert.match(script, /await this\.reloadFirstPage\(\)/);
  assert.match(html, /x-show="canManage\(post\)"/);
  assert.doesNotMatch(html, /x-show="scope === 'mine'"/);
  assert.doesNotMatch(html + script, /x-html/);
});

test('a failed mine request clears community rows and grants no management actions', async () => {
  const script = readUi('assets/js/oak-blog.js');
  const communityRows = [{ id: 71, title: 'Bài của người khác', can_manage: false }];
  communityRows.meta = { page: 1, limit: 9, total: 1 };
  let confirmed = false;
  const context = {
    URL,
    FileReader: class {},
    document: { getElementById: () => null },
    window: { confirm: () => { confirmed = true; return true; } },
    OAK: {
      api: async (path) => {
        if (path.startsWith('/api/posts/mine')) {
          throw new Error('Mine unavailable');
        }
        return communityRows;
      },
      toast: () => {},
    },
  };
  vm.runInNewContext(`${script}\nresult = oakBlogFeed();`, context);
  const state = context.result;
  state.user = { id: 9, role: 'customer' };
  await state.loadPage(1, false);
  assert.equal(state.posts.length, 1);

  const mineRequest = state.selectScope('mine');
  assert.equal(state.scope, 'mine');
  assert.equal(state.posts.length, 0);
  assert.equal(state.total, 0);
  assert.equal(state.page, 1);
  await mineRequest;
  assert.equal(state.posts.length, 0);
  assert.equal(state.canManage(communityRows[0]), false);

  state.editPost(communityRows[0]);
  await state.removePost(communityRows[0]);
  assert.equal(state.composerOpen, false);
  assert.equal(confirmed, false);
});

test('a failed first page raises loadError instead of the empty state, and retrying clears it', async () => {
  const script = readUi('assets/js/oak-blog.js');
  const rows = [{ id: 12, title: 'Chăm sóc da mùa hanh khô', can_manage: false }];
  rows.meta = { page: 1, limit: 9, total: 1 };
  let failing = true;
  const context = {
    URL,
    FileReader: class {},
    document: { getElementById: () => null },
    OAK: {
      api: async () => {
        if (failing) {
          throw new Error('Không kết nối được máy chủ.');
        }
        return rows;
      },
      toast: () => {},
    },
  };
  vm.runInNewContext(`${script}\nresult = oakBlogFeed();`, context);
  const state = context.result;
  await state.loadPage(1, false);
  assert.equal(state.loadError, true);
  assert.equal(state.posts.length, 0);

  failing = false;
  await state.reloadFirstPage();
  assert.equal(state.loadError, false);
  assert.equal(state.posts.length, 1);

  assert.match(readUi('blog.html'), /x-if="!loading &amp;&amp; !loadError &amp;&amp; !posts\.length"/);
});

test('a failed load more keeps the loaded rows, the page number and the non-error state', async () => {
  const script = readUi('assets/js/oak-blog.js');
  const rows = [{ id: 31, title: 'Xu hướng nail mùa thu', can_manage: false }];
  rows.meta = { page: 1, limit: 9, total: 3 };
  let failing = false;
  const context = {
    URL,
    FileReader: class {},
    document: { getElementById: () => null },
    OAK: {
      api: async () => {
        if (failing) {
          throw new Error('Máy chủ bận.');
        }
        return rows;
      },
      toast: () => {},
    },
  };
  vm.runInNewContext(`${script}\nresult = oakBlogFeed();`, context);
  const state = context.result;
  await state.loadPage(1, false);
  assert.equal(state.posts.length, 1);

  failing = true;
  await state.loadMore();
  assert.equal(state.posts.length, 1);
  assert.equal(state.loadError, false);
  assert.equal(state.page, 1);
});

test('resetting the composer invalidates an abandoned image upload', async () => {
  const script = readUi('assets/js/oak-blog.js');
  let finishUpload;
  const upload = new Promise((resolve) => { finishUpload = resolve; });
  class FakeFileReader {
    readAsDataURL() {
      this.result = 'data:image/png;base64,AA==';
      this.onload();
    }
  }
  const context = {
    URL,
    FileReader: FakeFileReader,
    document: { getElementById: () => ({ value: 'old-file' }) },
    OAK: { api: () => upload, toast: () => {} },
  };
  vm.runInNewContext(`${script}\nresult = oakBlogFeed();`, context);
  const state = context.result;
  const pending = state.uploadImage({ target: { files: [{ name: 'old.png' }] } });
  await Promise.resolve();
  assert.equal(state.uploading, true);

  state.resetComposer();
  state.form = { ...state.form, title: 'Bản nháp mới' };
  assert.equal(state.uploading, false);
  finishUpload({ url: '/uploads/old.png' });
  await pending;

  assert.equal(state.form.title, 'Bản nháp mới');
  assert.equal(state.form.image, '');
  assert.equal(state.uploading, false);
});

test('the blog delete icon is included in the shipped Material Symbols subset inputs', () => {
  const names = fs.readFileSync(path.join(root, 'tools', 'icons', 'icon-names.txt'), 'utf8').split(/\r?\n/);
  const font = fs.statSync(path.join(root, 'ui', 'assets', 'fonts', 'font-material-subset.woff2'));
  assert.ok(names.includes('delete'));
  assert.ok(font.size > 0);
  assert.match(readUi('blog.html'), /data-icon="delete">delete</);
});

test('owned post deletion verifies the scoped delete before committing comment removal', () => {
  const route = fs.readFileSync(path.join(root, 'server', 'src', 'routes', 'posts.js'), 'utf8');
  assert.match(route, /const deleted = await tx\.run\([\s\S]*?if \(deleted\.changes !== 1\)/);
});

test('post source migration deduplicates legacy URLs before creating the global index', () => {
  const schema = fs.readFileSync(path.join(root, 'server', 'src', 'db.js'), 'utf8');
  const dedupe = schema.indexOf('ROW_NUMBER() OVER');
  const globalIndex = schema.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_source_url');
  assert.ok(dedupe >= 0 && globalIndex > dedupe);
  assert.match(schema, /SET source_platform = NULL, source_url = NULL/);
  assert.match(schema, /source_platform IS NULL AND source_url IS NULL/);
});

test('partner console and sitemap have no separate post manager artifact', () => {
  const files = ['tong-quan-doi-tac.html', 'quan-ly-lich-hen.html', 'quan-ly-dich-vu.html', 'quan-ly-nhan-vien.html', 'bao-cao-doanh-thu.html', 'cai-dat-salon.html'];
  for (const file of files) {
    assert.doesNotMatch(readUi(file), /quan-ly-bai-viet\.html/, file);
  }
  assert.doesNotMatch(readUi('sitemap.html'), /quan-ly-bai-viet\.html/);
  assert.equal(fs.existsSync(path.join(root, 'ui', 'quan-ly-bai-viet.html')), false);
  assert.equal(fs.existsSync(path.join(root, 'tools', 'i18n', 'parts', 'quan-ly-bai-viet.json')), false);
});
