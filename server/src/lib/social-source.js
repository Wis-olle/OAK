export const SOCIAL_PLATFORMS = Object.freeze([
  'facebook',
  'instagram',
  'tiktok',
  'youtube',
  'zalo',
]);

const MAX_SOURCE_URL_LENGTH = 2048;
const HOST_PLATFORMS = Object.freeze({
  'facebook.com': 'facebook',
  'www.facebook.com': 'facebook',
  'm.facebook.com': 'facebook',
  'mobile.facebook.com': 'facebook',
  'instagram.com': 'instagram',
  'www.instagram.com': 'instagram',
  'm.instagram.com': 'instagram',
  'tiktok.com': 'tiktok',
  'www.tiktok.com': 'tiktok',
  'm.tiktok.com': 'tiktok',
  'vm.tiktok.com': 'tiktok',
  'vt.tiktok.com': 'tiktok',
  'youtube.com': 'youtube',
  'www.youtube.com': 'youtube',
  'm.youtube.com': 'youtube',
  'youtu.be': 'youtube',
  'zalo.me': 'zalo',
  'www.zalo.me': 'zalo',
  'zalo.com': 'zalo',
  'www.zalo.com': 'zalo',
});
const CANONICAL_HOSTS = Object.freeze({
  'facebook.com': 'www.facebook.com',
  'm.facebook.com': 'www.facebook.com',
  'mobile.facebook.com': 'www.facebook.com',
  'instagram.com': 'www.instagram.com',
  'm.instagram.com': 'www.instagram.com',
  'youtube.com': 'www.youtube.com',
  'm.youtube.com': 'www.youtube.com',
  'tiktok.com': 'www.tiktok.com',
  'm.tiktok.com': 'www.tiktok.com',
});
const RESOURCE_ID = /^[\w.-]+$/;

export class SocialSourceError extends Error {}

function youtubeVideoId(parsed) {
  if (parsed.hostname === 'youtu.be') {
    return parsed.pathname.split('/').filter(Boolean)[0] ?? null;
  }
  if (parsed.pathname === '/watch') {
    return parsed.searchParams.get('v');
  }
  const match = parsed.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]+)\/?$/);
  return match?.[1] ?? null;
}

function isFacebookResource(parsed) {
  if (/^\/(?:reel|reels)\/[\w.-]+\/?$/.test(parsed.pathname)) {
    return true;
  }
  if (/^\/[\w.-]+\/(?:posts|videos)\/[\w.-]+\/?$/.test(parsed.pathname)) {
    return true;
  }
  if (parsed.pathname === '/watch' || parsed.pathname === '/watch/') {
    return RESOURCE_ID.test(parsed.searchParams.get('v') ?? '');
  }
  const requiredParameter = {
    '/story.php': 'story_fbid',
    '/permalink.php': 'story_fbid',
    '/photo.php': 'fbid',
  }[parsed.pathname];
  return requiredParameter
    ? RESOURCE_ID.test(parsed.searchParams.get(requiredParameter) ?? '')
    : false;
}

function isInstagramResource(parsed) {
  return /^\/(?:p|reel|reels|tv)\/[\w.-]+\/?$/.test(parsed.pathname);
}

function isTikTokResource(parsed) {
  if (parsed.hostname === 'vm.tiktok.com' || parsed.hostname === 'vt.tiktok.com') {
    return /^\/[\w-]{4,}\/?$/.test(parsed.pathname);
  }
  return /^\/@[^/]+\/(?:video|photo)\/[\w.-]+\/?$/.test(parsed.pathname);
}

function isZaloResource(parsed) {
  return /^\/(?:s|article|post|posts|video|photo)\/[\w.-]+(?:\/[^?#]*)?$/.test(
    parsed.pathname,
  );
}

function isPlatformResource(parsed, platform) {
  const validators = {
    facebook: isFacebookResource,
    instagram: isInstagramResource,
    tiktok: isTikTokResource,
    youtube: (url) => RESOURCE_ID.test(youtubeVideoId(url) ?? ''),
    zalo: isZaloResource,
  };
  return validators[platform](parsed);
}

function normalizeUrl(parsed, platform) {
  const videoId = platform === 'youtube' ? youtubeVideoId(parsed) : null;
  if (videoId) {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  }

  parsed.hostname = CANONICAL_HOSTS[parsed.hostname] ?? parsed.hostname;
  parsed.hash = '';
  if (parsed.pathname.length > 1) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  }

  const identityParameterNames =
    platform === 'facebook'
      ? {
          '/story.php': ['id', 'story_fbid'],
          '/permalink.php': ['id', 'story_fbid'],
          '/photo.php': ['fbid'],
          '/watch': ['v'],
        }[parsed.pathname] ?? []
      : [];
  const identityParameters = identityParameterNames
    .map((name) => [name, parsed.searchParams.get(name)])
    .filter(([, value]) => value !== null);
  parsed.search = '';
  for (const [name, value] of identityParameters) {
    parsed.searchParams.set(name, value);
  }
  return parsed.toString();
}

/** Identify a supported platform only for a direct post/video resource URL. */
export function detectSocialPlatform(sourceUrl) {
  const rawUrl = typeof sourceUrl === 'string' ? sourceUrl.trim() : '';
  if (!rawUrl || rawUrl.length > MAX_SOURCE_URL_LENGTH) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
    return null;
  }

  const platform = HOST_PLATFORMS[parsed.hostname] ?? null;
  return platform && isPlatformResource(parsed, platform) ? platform : null;
}

/** Derive the platform from the URL and return a stable URL for storage and deduplication. */
export function validateSocialSource(sourceUrl, claimedPlatform = null) {
  const rawUrl = typeof sourceUrl === 'string' ? sourceUrl.trim() : '';
  const platform = detectSocialPlatform(rawUrl);
  if (!platform) {
    throw new SocialSourceError('Link phải trỏ trực tiếp đến một bài viết hoặc video được hỗ trợ.');
  }

  const normalizedClaim =
    typeof claimedPlatform === 'string' ? claimedPlatform.trim().toLowerCase() : null;
  if (normalizedClaim && normalizedClaim !== platform) {
    throw new SocialSourceError('Nền tảng khai báo không khớp với link bài viết gốc.');
  }

  return { platform, url: normalizeUrl(new URL(rawUrl), platform) };
}
