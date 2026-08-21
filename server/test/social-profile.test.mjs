import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SocialProfileError,
  validateSocialProfile,
} from '../src/lib/social-profile.js';

const accepted = [
  ['facebook', 'https://m.facebook.com/LalaNail/?utm_source=oak#about', 'https://www.facebook.com/LalaNail'],
  ['instagram', 'https://instagram.com/lala.nail/?igsh=abc', 'https://www.instagram.com/lala.nail'],
  ['tiktok', 'https://m.tiktok.com/@lalanail/?lang=vi', 'https://www.tiktok.com/@lalanail'],
  ['youtube', 'https://m.youtube.com/@LalaNail/videos?si=abc', 'https://www.youtube.com/@LalaNail/videos'],
  ['zalo', 'https://zalo.me/lalanail/?utm_campaign=oak#info', 'https://zalo.me/lalanail'],
];

test('accepts and normalizes profile/page URLs for all supported platforms', () => {
  for (const [platform, input, expected] of accepted) {
    assert.equal(validateSocialProfile(input, platform), expected);
  }
});

test('rejects unsafe, deceptive, redirect, homepage, and mismatched URLs', () => {
  const rejected = [
    ['http://facebook.com/lalanail', 'facebook'],
    ['https://user:pass@facebook.com/lalanail', 'facebook'],
    ['https://facebook.com:444/lalanail', 'facebook'],
    ['https://facebook.com.evil.test/lalanail', 'facebook'],
    ['https://www.facebook.com/l.php?u=https://evil.test', 'facebook'],
    ['https://www.instagram.com/accounts', 'instagram'],
    ['https://zalo.me/redirect/evil', 'zalo'],
    ['https://zalo.me/post/123', 'zalo'],
    ['https://zalo.me/s/123', 'zalo'],
    ['https://www.youtube.com/@LalaNail/not-a-tab', 'youtube'],
    ['https://www.youtube.com/channel/UC123/not-a-tab', 'youtube'],
    ['https://www.facebook.com/', 'facebook'],
    ['https://www.instagram.com/', 'instagram'],
    ['https://www.tiktok.com/', 'tiktok'],
    ['https://www.youtube.com/', 'youtube'],
    ['https://zalo.me/', 'zalo'],
    ['https://www.instagram.com/lalanail', 'facebook'],
    ['https://example.com/lalanail', 'facebook'],
    [`https://www.facebook.com/${'a'.repeat(2050)}`, 'facebook'],
  ];

  for (const [url, platform] of rejected) {
    assert.throws(() => validateSocialProfile(url, platform), SocialProfileError, url);
  }
});

test('rejects non-string values and unsupported platform names', () => {
  assert.throws(() => validateSocialProfile(null, 'facebook'), SocialProfileError);
  assert.throws(() => validateSocialProfile('https://facebook.com/lalanail', 'linkedin'), SocialProfileError);
});
