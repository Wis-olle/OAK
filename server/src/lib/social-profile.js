export const SOCIAL_PROFILE_PLATFORMS = Object.freeze([
  'facebook',
  'instagram',
  'tiktok',
  'youtube',
  'zalo',
]);

const MAX_URL_LENGTH = 2048;
const HOSTS = Object.freeze({
  facebook: new Set(['facebook.com', 'www.facebook.com', 'm.facebook.com']),
  instagram: new Set(['instagram.com', 'www.instagram.com', 'm.instagram.com']),
  tiktok: new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com']),
  youtube: new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']),
  zalo: new Set(['zalo.me', 'www.zalo.me']),
});
const CANONICAL_HOST = Object.freeze({
  facebook: 'www.facebook.com',
  instagram: 'www.instagram.com',
  tiktok: 'www.tiktok.com',
  youtube: 'www.youtube.com',
  zalo: 'zalo.me',
});
const SIMPLE_SEGMENT = /^[\w.@-]+$/;
const YOUTUBE_PROFILE_TABS = new Set([
  'featured', 'videos', 'shorts', 'streams', 'playlists', 'community', 'about',
]);

export class SocialProfileError extends Error {}

function isProfilePath(parsed, platform) {
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (platform === 'facebook') {
    if (parsed.pathname === '/profile.php') {
      return /^[\w.-]+$/.test(parsed.searchParams.get('id') ?? '');
    }
    return segments.length === 1 && SIMPLE_SEGMENT.test(segments[0]) && ![
      'home.php', 'l.php', 'login.php', 'share.php', 'sharer.php', 'watch', 'reel', 'reels',
    ].includes(segments[0].toLowerCase());
  }
  if (platform === 'instagram') {
    return segments.length === 1 && /^[\w.]+$/.test(segments[0]) && ![
      'accounts', 'explore', 'direct', 'reels', 'stories',
    ].includes(segments[0].toLowerCase());
  }
  if (platform === 'tiktok') {
    return segments.length === 1 && /^@[\w.-]+$/.test(segments[0]);
  }
  if (platform === 'youtube') {
    const isHandle = /^@[\w.-]+$/.test(segments[0] ?? '');
    const isLegacyChannel = ['channel', 'c', 'user'].includes(segments[0])
      && SIMPLE_SEGMENT.test(segments[1] ?? '');
    const tabIndex = isHandle ? 1 : 2;
    return (isHandle || isLegacyChannel)
      && segments.length <= tabIndex + 1
      && (segments.length === tabIndex || YOUTUBE_PROFILE_TABS.has(segments[tabIndex]));
  }
  return segments.length === 1 && SIMPLE_SEGMENT.test(segments[0]);
}

function normalize(parsed, platform) {
  parsed.hostname = CANONICAL_HOST[platform];
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  const facebookId = platform === 'facebook' && parsed.pathname === '/profile.php'
    ? parsed.searchParams.get('id')
    : null;
  parsed.search = '';
  if (facebookId) {
    parsed.searchParams.set('id', facebookId);
  }
  return parsed.toString().replace(/\/$/, '');
}

/** Validate one public social profile/page URL without following redirects. */
export function validateSocialProfile(value, platform) {
  const normalizedPlatform = typeof platform === 'string' ? platform.trim().toLowerCase() : '';
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!SOCIAL_PROFILE_PLATFORMS.includes(normalizedPlatform) || !raw || raw.length > MAX_URL_LENGTH) {
    throw new SocialProfileError('Link trang mạng xã hội không hợp lệ.');
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new SocialProfileError('Link trang mạng xã hội không hợp lệ.');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    !HOSTS[normalizedPlatform].has(parsed.hostname) ||
    !isProfilePath(parsed, normalizedPlatform)
  ) {
    throw new SocialProfileError('Link phải trỏ trực tiếp đến trang hoặc hồ sơ mạng xã hội tương ứng.');
  }
  return normalize(parsed, normalizedPlatform);
}
