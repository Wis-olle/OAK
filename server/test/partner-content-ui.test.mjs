import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRepo, readServer, readUi } from './lib/read-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/* Five link boxes on the settings page and a row of five chips on the salon page, for a
   thing a salon states once on its own Facebook and never again. They are gone from both:
   the columns and the route stay, because the shopfront importer still writes a link it
   finds, but nothing on OAK asks for one or shows one. */
test('the salon settings form no longer collects social profiles', () => {
  const html = readUi('cai-dat-salon.html');
  for (const platform of ['facebook', 'instagram', 'tiktok', 'youtube', 'zalo']) {
    assert.doesNotMatch(html, new RegExp(`platform: '${platform}'`), platform);
  }
  assert.doesNotMatch(html, /form\.social_links|social_links:/);
  // Nor the free-text tags beside the amenities, which fed no filter and no listing.
  assert.doesNotMatch(html, /id="salon-tags"/);
  assert.doesNotMatch(html, /tagsText/);
  // The route that stores both is untouched: an importer's link is still written and read.
  assert.match(readServer('routes/partner.js'), /social_links/);
});

test('the public salon page renders no link it was handed, and still no x-html', () => {
  const html = readUi('salon-profile.html');
  assert.doesNotMatch(html, /safeSocialLinks/);
  assert.doesNotMatch(html, /social_links/);
  /* The rule that made the old chips safe, kept as the rule for the page as a whole: a
     salon's own text reaches the reader through x-text and never as markup. */
  assert.doesNotMatch(html, /x-html/);
});

test('post source migration deduplicates legacy URLs before creating the global index', () => {
  const schema = readServer('db.js');
  const dedupe = schema.indexOf('ROW_NUMBER() OVER');
  const globalIndex = schema.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_source_url');
  assert.ok(dedupe >= 0 && globalIndex > dedupe);
  assert.match(schema, /SET source_platform = NULL, source_url = NULL/);
  assert.match(schema, /source_platform IS NULL AND source_url IS NULL/);
});

test('the delete icon is included in the shipped Material Symbols subset inputs', () => {
  const names = readRepo('tools/icons/icon-names.txt').split(/\r?\n/);
  const font = fs.statSync(path.join(root, 'ui', 'assets', 'fonts', 'font-material-subset.woff2'));
  assert.ok(names.includes('delete'));
  assert.ok(font.size > 0);
  assert.match(readUi('ho-so-nhan-vien.html'), /data-icon="delete">delete</);
});

/* The blog is gone: its two pages, the script behind them, the route they read and the
   dictionary parts they were translated from. The tables stay — nothing here reads them —
   so the only thing worth pinning is that none of the code came back. */
test('nothing of the blog is left in the tree', () => {
  for (const file of [
    'ui/blog.html',
    'ui/blog-chi-tiet.html',
    'ui/assets/js/oak-blog.js',
    'server/src/routes/posts.js',
    'tools/i18n/parts/blog.json',
    'tools/i18n/parts/blog-chi-tiet.json',
  ]) {
    assert.equal(fs.existsSync(path.join(root, file)), false, file);
  }
  assert.doesNotMatch(readServer('app.js'), /routes\/posts\.js|'\/api\/posts'/);
  // And no page still points a reader at one of them.
  for (const name of fs.readdirSync(path.join(root, 'ui')).filter((file) => file.endsWith('.html'))) {
    assert.doesNotMatch(readUi(name), /href="blog(-chi-tiet)?\.html/, name);
  }
});
