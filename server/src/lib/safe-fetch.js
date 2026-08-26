/*
 * The one way out of this process to an address a partner typed.
 *
 * Every other outbound call in this codebase goes to a constant — Nominatim in
 * routes/geo.js, Resend in lib/mailer.js — so the host is decided here and the caller only
 * chooses the path. POST /api/partner/import is the first route where the host itself comes
 * from a request body, and a fetcher that takes a host from a request body is a way for a
 * caller to read whatever this process can reach: the metadata service on the instance, a
 * database that only listens on the private network, an admin page bound to localhost.
 *
 * So: http(s) on ordinary ports only, no credentials in the URL, and the hostname is
 * resolved before the socket is opened — if any address it answers with is inside the
 * network, nothing is fetched. Redirects are followed by hand, three hops at most, and each
 * hop's host is put through the same check, because a public host is free to redirect to
 * 127.0.0.1. A body is read whole with a ceiling on it, and every request has a deadline.
 *
 * What this does NOT close: the gap between the lookup and the connect. A hostname that
 * answers with a public address here and a private one a millisecond later still gets
 * through, and closing it means resolving the address ourselves and connecting to it with
 * the Host header set by hand — a socket-level rewrite this file deliberately does not do.
 * Imports are rate-limited per partner and run from a signed-in partner account, which is
 * the containment this trade rests on.
 */
import dns from 'node:dns';

// Nominatim asks callers to name themselves and so does courtesy: a salon's webmaster
// reading their access log can see who this was and write to the address in it.
const USER_AGENT = 'OAKBeautyDemo/1.0 (hello@oakbeauty.vn)';
// The same ceiling lib/mailer.js and routes/geo.js put on their upstreams, for the same
// reason: a request that never settles would pin a socket for as long as the process lives.
const TIMEOUT_MS = 10_000;
// A salon's site behind a www → apex → https ladder is three hops; a chain longer than that
// is a loop or a redirector being used as one.
const MAX_REDIRECTS = 3;
// A page is read into memory in one piece, so the ceiling is on what one import may hold.
// The heaviest Vietnamese salon homepages are a few hundred KB of markup.
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** A URL this process refuses to open, told apart from an upstream that simply failed. */
export class UnsafeUrlError extends Error {}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isPrivateIPv4(address) {
  const match = address.match(IPV4);
  if (!match) {
    return false;
  }
  const [a, b, c] = match.slice(1).map(Number);
  return (
    a === 0 || // 0.0.0.0/8 — "this network", and 0.0.0.0 itself is localhost to a socket.
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10, carrier-grade NAT: the fabric several
    //                                       container hosts put their internal services on.
    (a === 169 && b === 254) || // Link-local, and the cloud metadata service lives here.
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) || // 192.0.0/24, IETF protocol assignments.
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // 198.18/15, benchmarking.
    a >= 224 // Multicast, reserved, and 255.255.255.255 — none of them a web server.
  );
}

/**
 * Whether `address` is one this process must not open a connection to.
 *
 * Takes what dns.lookup hands back — a numeric address, never a name. IPv6 is folded to
 * lowercase first; a v4-mapped address (::ffff:127.0.0.1) is judged as the v4 address it
 * carries, because that is what the socket will actually reach.
 */
export function isPrivateAddress(address) {
  const value = String(address ?? '').toLowerCase();
  if (isPrivateIPv4(value)) {
    return true;
  }
  const mapped = value.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) {
    return isPrivateIPv4(mapped[1]);
  }
  if (!value.includes(':')) {
    return false;
  }
  return (
    value === '::1' ||
    value === '::' ||
    /^f[cd][0-9a-f]{2}:/.test(value) || // fc00::/7, unique-local.
    /^fe[89ab][0-9a-f]:/.test(value) // fe80::/10, link-local.
  );
}

/**
 * `value` as a URL this process is willing to open, or an UnsafeUrlError saying why not.
 *
 * The port test is what stops the fetcher being pointed at a service that happens to speak
 * HTTP on a port of its own — a database admin panel, a debug server — even on a host whose
 * address is public.
 */
function parsePublicUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new UnsafeUrlError('Đường dẫn không hợp lệ.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeUrlError('Chỉ hỗ trợ đường dẫn http hoặc https.');
  }
  if (parsed.username || parsed.password) {
    throw new UnsafeUrlError('Đường dẫn không được chứa thông tin đăng nhập.');
  }
  const defaultPort = parsed.protocol === 'https:' ? '443' : '80';
  if (parsed.port !== '' && parsed.port !== defaultPort) {
    throw new UnsafeUrlError('Đường dẫn không được chỉ định cổng riêng.');
  }
  return parsed;
}

/** Resolve `hostname` and refuse it unless every address it answers with is public. */
async function assertPublicHost(hostname) {
  let records;
  try {
    records = await dns.promises.lookup(hostname, { all: true });
  } catch {
    throw new UnsafeUrlError('Không tìm thấy tên miền này.');
  }
  // Every answer, not the first: a name that resolves to one public address and one
  // private one would otherwise be a coin toss decided by the resolver's ordering.
  if (records.length === 0 || records.some((record) => isPrivateAddress(record.address))) {
    throw new UnsafeUrlError('Đường dẫn trỏ vào một địa chỉ nội bộ.');
  }
}

/**
 * The body, refused the moment it goes past `maxBytes` rather than once it has all arrived.
 *
 * response.arrayBuffer() would hold the whole thing in memory before anyone could measure
 * it, so a host that answers a hundred megabytes to a two-megabyte cap would be stopped
 * only after it had already spent the heap of a process serving every other request. Read
 * chunk by chunk instead, and cancel the body — which closes the socket — on the first
 * chunk that takes the total over.
 */
async function readCapped(response, maxBytes, hostname) {
  const reader = response.body?.getReader();
  if (!reader) {
    return Buffer.alloc(0);
  }
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`${hostname} answered more than the ${maxBytes} byte cap`);
      }
      chunks.push(value);
    }
  } finally {
    // No-op once the stream has ended on its own; the point is the path where it has not.
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch `rawUrl` under every guard this file exists for.
 *
 * Answers `{ url, status, contentType, buffer }` — url being the address the last hop
 * actually served, which is what a relative link on the page has to be resolved against.
 * A body past `maxBytes` is an error rather than a truncation: half a document parses to
 * nonsense, and half an image is not an image.
 *
 * `refuseUrl` is the caller's own say over where this may go — it is asked about the
 * address given AND about every redirect target, and a string it answers with becomes the
 * refusal. Being private is not the only reason a host may be out of bounds: the import
 * route will not touch facebook.com, and a rule applied only to the pasted link would be
 * walked around by any page that answers 302.
 */
export async function safeFetch(
  rawUrl,
  { headers = {}, maxBytes = MAX_HTML_BYTES, refuseUrl = null } = {},
) {
  let target = parsePublicUrl(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const refusal = refuseUrl?.(target.href);
    if (refusal) {
      throw new UnsafeUrlError(refusal);
    }
    await assertPublicHost(target.hostname);

    const response = await fetch(target.href, {
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT, ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`Redirect ${response.status} without a location`);
      }
      // Resolved against the hop that sent it, then put through the whole check again from
      // the top of the loop — a public host redirecting to 169.254.169.254 is the point.
      target = parsePublicUrl(new URL(location, target).href);
      continue;
    }

    if (!response.ok) {
      throw new Error(`${target.hostname} answered ${response.status}`);
    }

    // The header is a claim, not a promise, so it is only worth the round trip it saves:
    // the real length is measured below on the bytes that arrived.
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`${target.hostname} answered ${declared} bytes, over the ${maxBytes} cap`);
    }
    const buffer = await readCapped(response, maxBytes, target.hostname);

    return {
      url: target.href,
      status: response.status,
      contentType: (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(),
      buffer,
    };
  }

  throw new UnsafeUrlError('Đường dẫn chuyển hướng quá nhiều lần.');
}
