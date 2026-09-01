import test from 'node:test';
import assert from 'node:assert/strict';
import { readUi } from './lib/read-source.mjs';

const blogHtml = readUi('blog.html');
const blogScript = readUi('assets/js/oak-blog.js');
const blog = blogHtml + blogScript;
const detail = readUi('blog-chi-tiet.html');

test('partner composer auto-detects a source platform without a platform select', () => {
  assert.match(blog, /user\.role === 'partner'/);
  assert.match(blog, /x-show="[^"]*form\.has_social_source"/);
  assert.doesNotMatch(blog, /id="post-source-platform"/);
  assert.match(blog, /oakDetectSocialPlatform/);
  assert.match(blog, /detectedPlatform/);
  assert.match(blog, /source_url: sourceUrl/);
});

test('composer requires a preview and explicit confirmation before publishing', () => {
  assert.match(blog, /@submit\.prevent="submitComposer\(\)"/);
  assert.match(blog, /Xem trước/);
  assert.match(blog, /Quay lại chỉnh sửa/);
  assert.match(blog, /@click="publish\(\)"/);
  assert.match(blog, /previewPayload/);
  assert.match(blog, /salon\.name/);
  // An edit is the one exception: its author has already seen the post as it stands.
  assert.match(blog, /Lưu thay đổi/);
});

test('feed and detail render safe external source links without raw HTML', () => {
  for (const page of [blog, detail]) {
    assert.match(page, /target="_blank"/);
    assert.match(page, /rel="noopener noreferrer"/);
    assert.doesNotMatch(page, /x-html=/);
  }
  assert.match(blog, /post\.salon\.name/);
  assert.match(blog, /safeSourceUrl/);
  assert.match(blog, /absolute inset-0 z-10/);
  assert.match(blog, /pointer-events-none/);
  assert.match(blog, /z-20[^\"]*pointer-events-auto|pointer-events-auto[^\"]*z-20/);
  assert.match(detail, /Xem bài gốc/);
  assert.match(detail, /safeSourceUrl/);
});

test('preview shows safe full article content and a safe video link', () => {
  assert.match(blog, /data-oak-post-preview/);
  assert.match(blog, /previewPayload\.content/);
  assert.match(blog, /whitespace-pre-line/);
  assert.match(blog, /safePreviewVideoUrl/);
  assert.match(blog, /Xem video YouTube/);
  assert.match(blog, /data-oak-preview-button/);
  assert.match(blog, /data-oak-publish-button/);
  assert.match(blog, /data-oak-edit-button/);
  assert.doesNotMatch(blog, /x-html=/);
});
