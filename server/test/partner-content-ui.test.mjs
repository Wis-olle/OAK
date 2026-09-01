import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRepo, readServer, readUi } from './lib/read-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('salon settings exposes all five social profile fields and saves the object', () => {
  const html = readUi('cai-dat-salon.html');
  for (const platform of ['facebook', 'instagram', 'tiktok', 'youtube', 'zalo']) {
    assert.match(html, new RegExp(`platform: '${platform}'`));
  }
  assert.match(html, /social_links:\s*Object\.assign/);
  assert.match(html, /salon\.social_links/);
});

test('public salon profile renders only allowlisted links without x-html', () => {
  const html = readUi('salon-profile.html');
  assert.match(html, /safeSocialLinks\(\)/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /target="_blank"/);
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
  assert.doesNotMatch(readServer('app.js'), /posts/);
  // And no page still points a reader at one of them.
  for (const name of fs.readdirSync(path.join(root, 'ui')).filter((file) => file.endsWith('.html'))) {
    assert.doesNotMatch(readUi(name), /href="blog(-chi-tiet)?\.html/, name);
  }
});
