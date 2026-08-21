import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SOCIAL_PLATFORMS,
  SocialSourceError,
  detectSocialPlatform,
  validateSocialSource,
} from '../src/lib/social-source.js';

test('accepts and normalizes supported social post URLs', () => {
  const examples = [
    ['facebook', 'https://www.facebook.com/oak/posts/123', 'https://www.facebook.com/oak/posts/123'],
    ['instagram', 'https://instagram.com/p/ABC123/', 'https://www.instagram.com/p/ABC123'],
    ['tiktok', 'https://www.tiktok.com/@oak/video/123', 'https://www.tiktok.com/@oak/video/123'],
    ['youtube', 'https://youtu.be/abc123', 'https://www.youtube.com/watch?v=abc123'],
    ['zalo', 'https://zalo.me/post/123', 'https://zalo.me/post/123'],
  ];

  for (const [platform, url, normalizedUrl] of examples) {
    assert.equal(detectSocialPlatform(url), platform);
    const source = validateSocialSource(url);
    assert.equal(source.platform, platform);
    assert.equal(source.url, normalizedUrl);
  }
  assert.deepEqual(SOCIAL_PLATFORMS, ['facebook', 'instagram', 'tiktok', 'youtube', 'zalo']);
});

test('canonicalizes fragments and trailing slashes for duplicate detection', () => {
  assert.equal(
    validateSocialSource(' https://WWW.INSTAGRAM.COM/p/ABC123/#comments ').url,
    'https://www.instagram.com/p/ABC123',
  );
});

test('canonicalizes mobile hosts, tracking parameters and query order', () => {
  assert.equal(
    validateSocialSource(
      'https://m.facebook.com/story.php?utm_source=share&id=20&story_fbid=10&fbclid=tracking',
    ).url,
    'https://www.facebook.com/story.php?id=20&story_fbid=10',
  );
  assert.equal(
    validateSocialSource('https://instagram.com/p/ABC?z=2&igshid=tracking&a=1&utm_medium=social').url,
    'https://www.instagram.com/p/ABC',
  );
});

test('drops arbitrary query parameters from path-based and short-link resources', () => {
  assert.equal(
    validateSocialSource('https://www.instagram.com/p/ABC?foo=1').url,
    validateSocialSource('https://instagram.com/p/ABC?foo=2&_r=1').url,
  );
  assert.equal(
    validateSocialSource('https://www.tiktok.com/@oak/video/123?_r=1&_t=abc').url,
    validateSocialSource('https://m.tiktok.com/@oak/video/123?foo=2').url,
  );
  assert.equal(
    validateSocialSource('https://vm.tiktok.com/ZM123/?_r=1&_t=abc').url,
    validateSocialSource('https://vm.tiktok.com/ZM123?foo=2').url,
  );
  assert.equal(
    validateSocialSource('https://zalo.me/s/123?utm_source=share&foo=1').url,
    'https://zalo.me/s/123',
  );
});

test('keeps only identity parameters for Facebook query-based resources', () => {
  assert.equal(
    validateSocialSource(
      'https://facebook.com/story.php?foo=1&id=456&story_fbid=123&bar=2',
    ).url,
    'https://www.facebook.com/story.php?id=456&story_fbid=123',
  );
  assert.equal(
    validateSocialSource('https://facebook.com/photo.php?id=456&fbid=123&foo=1').url,
    'https://www.facebook.com/photo.php?fbid=123',
  );
  assert.equal(
    validateSocialSource('https://facebook.com/watch?v=123&foo=1').url,
    'https://www.facebook.com/watch?v=123',
  );
});

test('canonicalizes equivalent YouTube video URL variants', () => {
  const variants = [
    'https://youtu.be/abc-123?si=tracking',
    'https://www.youtube.com/watch?feature=share&v=abc-123',
    'https://m.youtube.com/shorts/abc-123/',
    'https://youtube.com/embed/abc-123?utm_source=share',
  ];
  assert.deepEqual(
    variants.map((url) => validateSocialSource(url).url),
    variants.map(() => 'https://www.youtube.com/watch?v=abc-123'),
  );
  assert.equal(
    validateSocialSource('https://youtu.be/abc-123?t=90&utm_source=share').url,
    'https://www.youtube.com/watch?v=abc-123',
  );
  assert.equal(
    validateSocialSource('https://www.youtube.com/watch?v=abc-123&start=90&list=PL123&index=2').url,
    validateSocialSource('https://www.youtube.com/watch?v=abc-123').url,
  );
});

test('accepts direct post and video resources for all five platforms', () => {
  const resources = [
    ['facebook', 'https://m.facebook.com/oak/posts/123'],
    ['facebook', 'https://www.facebook.com/reel/123'],
    ['facebook', 'https://www.facebook.com/watch?v=123'],
    ['facebook', 'https://facebook.com/story.php?story_fbid=123&id=456'],
    ['instagram', 'https://www.instagram.com/reel/ABC123/'],
    ['youtube', 'https://m.youtube.com/shorts/abc123'],
    ['tiktok', 'https://www.tiktok.com/@oak/video/123'],
    ['tiktok', 'https://vm.tiktok.com/ZM123/'],
    ['zalo', 'https://zalo.me/s/123'],
    ['zalo', 'https://www.zalo.com/article/123'],
  ];
  for (const [platform, url] of resources) {
    assert.equal(detectSocialPlatform(url), platform);
    assert.equal(validateSocialSource(url).platform, platform);
  }
});

test('rejects redirectors, arbitrary subdomains and platform homepages', () => {
  const invalid = [
    'https://l.facebook.com/l.php?u=https%3A%2F%2Fevil.example',
    'https://l.instagram.com/?u=https%3A%2F%2Fevil.example',
    'https://www.youtube.com/redirect?q=https%3A%2F%2Fevil.example',
    'https://news.facebook.com/oak/posts/123',
    'https://facebook.com/',
    'https://instagram.com/',
    'https://youtube.com/',
    'https://tiktok.com/',
    'https://zalo.me/',
    'https://facebook.com/oak',
    'https://instagram.com/oak',
    'https://youtube.com/channel/abc123',
    'https://tiktok.com/@oak',
    'https://zalo.me/123',
  ];
  for (const url of invalid) {
    assert.equal(detectSocialPlatform(url), null);
    assert.throws(() => validateSocialSource(url), SocialSourceError);
  }
});

test('rejects a client platform claim that disagrees with the URL', () => {
  assert.throws(
    () => validateSocialSource('https://www.instagram.com/p/ABC123', 'facebook'),
    SocialSourceError,
  );
});

test('rejects unsafe or mismatched social sources', () => {
  const invalid = [
    'http://facebook.com/oak/posts/123',
    'https://user:pass@facebook.com/oak/posts/123',
    'https://facebook.com.evil.example/oak/posts/123',
    'https://threads.net/@oak/post/123',
    'not a url',
    `https://zalo.me/${'a'.repeat(2050)}`,
  ];

  for (const url of invalid) {
    assert.throws(() => validateSocialSource(url), SocialSourceError);
  }
});

test('requires a source URL', () => {
  assert.throws(() => validateSocialSource(''), SocialSourceError);
});
