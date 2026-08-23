/** "Lala Nail Studio" -> "lala-nail-studio", with Vietnamese diacritics stripped. */
export function slugify(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Lowercase, diacritic-free text: 'Nối mi' -> 'noi mi', so plain ASCII typing matches. */
export function normalize(value) {
  return String(value)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/đ/g, 'd');
}

/*
 * Every token is checked against every candidate salon and every one of its services, so
 * the work a search costs grows with the number of words in it — and the query string is
 * whatever an anonymous caller cares to send, up to the URL limit. Eight words is more
 * than any real search ('noi mi quan 3' is four); past that the tail is noise anyway.
 */
const MAX_QUERY_TOKENS = 8;

/** The searchable words of a query, diacritic-free: 'Nối Mi ' -> ['noi', 'mi']. */
export function searchTokens(query) {
  return normalize(query).split(/\s+/).filter(Boolean).slice(0, MAX_QUERY_TOKENS);
}

/*
 * A digits-only token has to be a whole word: 'quan 1' must find 'Quận 1' and not every
 * 'Quận 10/11/12' as well. Words stay plain containment, so 'nail' still finds 'Nails'.
 */
const DIGITS_ONLY = /^\d+$/;

function hasToken(haystack, token) {
  return DIGITS_ONLY.test(token)
    ? new RegExp(`\\b${token}\\b`).test(haystack)
    : haystack.includes(token);
}

/**
 * How many of `tokens` appear in `texts`, both sides stripped of diacritics so 'noi mi'
 * finds 'Nối mi' and 'quan 1' finds 'Quận 1'. The caller injects whichever texts count as
 * a hit — a salon name, its district, its service names — and null entries are skipped.
 * A count, not a boolean, so a caller can prefer the rows that matched every word.
 */
export function countMatchedTokens(tokens, texts) {
  // Joined on a newline: tokens never contain whitespace, so no match can straddle two texts.
  const haystack = texts
    .filter((text) => text != null)
    .map(normalize)
    .join('\n');
  return tokens.filter((token) => hasToken(haystack, token)).length;
}

/**
 * The strongest matches only: of a set of candidates carrying `matched_tokens` (from
 * countMatchedTokens), the ones that matched the most query words. A salon that matched
 * 3 of 4 words is the answer; one that matched 1 is padding, so the weaker tiers go.
 * With no query at all every count is 0, so every candidate is in the top tier.
 */
export function bestMatchTier(items) {
  const best = Math.max(0, ...items.map((item) => item.matched_tokens));
  return items.filter((item) => item.matched_tokens === best);
}
