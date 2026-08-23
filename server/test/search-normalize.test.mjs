// The diacritic-free matching behind GET /api/search/salons?q= and /api/salons?q=:
// Vietnamese customers type on a keyboard without Telex, so 'noi mi' has to find 'Nối mi'.
import assert from 'node:assert/strict';
import test from 'node:test';

import { bestMatchTier, countMatchedTokens, normalize, searchTokens } from '../src/lib/text.js';

// One salon, in the shape the routes inject: its name, its district, its service names.
const LALA = ['Lala Nail Studio', 'Quận 1', 'Sơn gel cơ bản', 'Nối mi Classic'];

/** How the routes ask the question: does this query match this salon at all? */
function matched(query, texts) {
  return countMatchedTokens(searchTokens(query), texts);
}

test('normalize strips diacritics and the Vietnamese đ', () => {
  assert.equal(normalize('Nối Mi'), 'noi mi');
  assert.equal(normalize('Quận 1'), 'quan 1');
  assert.equal(normalize('Đà Nẵng'), 'da nang');
});

test('searchTokens splits on whitespace and drops the padding', () => {
  assert.deepEqual(searchTokens('  Nối   Mi '), ['noi', 'mi']);
  assert.deepEqual(searchTokens('   '), []);
});

test("'noi mi' matches the accented service name", () => {
  assert.equal(matched('noi mi', LALA), 2);
});

test('the accented spelling matches exactly as well', () => {
  assert.equal(matched('nối mi', LALA), matched('noi mi', LALA));
});

test("'quan 1' matches the district", () => {
  assert.equal(matched('quan 1', LALA), 2);
});

test("a digits-only word is a whole word — 'quan 1' is not 'Quận 10'", () => {
  const q10 = ['Hair Room Sài Gòn', 'Quận 10', 'Uốn xoăn Hàn Quốc'];
  assert.equal(matched('quan 1', q10), 1); // 'quan' only
  assert.equal(matched('quan 10', q10), 2);
  // A word is still found inside a longer one, so 'nail' keeps finding 'Nails'.
  assert.equal(matched('nail', ['Nails Studio']), 1);
});

test("'lam nail' matches on 'nail' alone — no service is called 'làm'", () => {
  assert.equal(matched('lam nail', LALA), 1);
  assert.equal(searchTokens('lam nail').length, 2);
});

test('a query that matches nothing counts zero', () => {
  assert.equal(matched('zzzz', LALA), 0);
});

test('a match can never straddle two of the texts', () => {
  assert.equal(matched('studioquan', LALA), 0);
});

test('null texts are skipped, so a service without a subcategory is harmless', () => {
  assert.equal(matched('nail art', [null, 'Nail art', undefined]), 2);
});

// The salon shape the style filter sees: one row per service.
const LALA_SERVICES = [
  { subcategory: 'Sơn gel', name: 'Sơn gel cơ bản' },
  { subcategory: 'Nối mi', name: 'Nối mi Classic' },
];

/** How search.js asks it: does ONE service of this salon carry the whole style? */
function matchesStyle(style, services) {
  const tokens = searchTokens(style);
  return services.some(
    (sv) => countMatchedTokens(tokens, [sv.subcategory, sv.name]) === tokens.length,
  );
}

test('a style has to sit in one service, not be pieced together from two', () => {
  assert.equal(matchesStyle('son gel', LALA_SERVICES), true);
  assert.equal(matchesStyle('noi mi classic', LALA_SERVICES), true);
  // 'son' is in one service and 'mi' in another — the salon offers no "sơn mi".
  assert.equal(matchesStyle('son mi', LALA_SERVICES), false);
});

test('the best tier answers, weaker partial matches are dropped', () => {
  // 'noi mi quan 3': Lala matches noi+mi+quan (3), the hair salon only quan+3 (2).
  const lala = { name: 'Lala Nail Studio', matched_tokens: 3, rating: 4.2 };
  const hair = { name: 'Hair Room Sài Gòn', matched_tokens: 2, rating: 4.9 };
  assert.deepEqual(bestMatchTier([hair, lala]), [lala]);
});

test('a tie keeps every salon of the tier', () => {
  const a = { matched_tokens: 1 };
  const b = { matched_tokens: 1 };
  assert.deepEqual(bestMatchTier([a, b]), [a, b]);
});

test('with no query every count is 0, so nothing is dropped', () => {
  const all = [{ matched_tokens: 0 }, { matched_tokens: 0 }];
  assert.deepEqual(bestMatchTier(all), all);
  assert.deepEqual(bestMatchTier([]), []);
});

test('a query is capped at eight words, so its cost cannot be dialled up from outside', () => {
  // q is unauthenticated and the URL limit is measured in kilobytes; every token is then
  // checked against every candidate salon and every one of its services.
  const flood = 'noi mi '.repeat(2000);
  assert.equal(searchTokens(flood).length, 8);
  // The longest real search is nowhere near the cap.
  assert.deepEqual(searchTokens('noi mi quan 3'), ['noi', 'mi', 'quan', '3']);
});
