/*
 * 'Nổi bật' — the first thing OAK will sell — and the page that says so out loud.
 *
 * The whole design is one date: salons.featured_until, read against today. What is worth
 * pinning is therefore not "a salon can be featured" but the two ways a placement goes
 * wrong. It must END without anything having to run, which is why nothing stores the
 * answer; and it must be VISIBLE, because a list whose order money can buy and which does
 * not say so is an advertisement pretending to be a ranking.
 *
 * The third thing here is the price list. A platform that is about to charge for something
 * has to say what it charges for before the salon signs up, not only in mục 7 afterwards.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { IS_FEATURED_SQL, isFeatured } from '../src/lib/featured.js';
import { addDaysISO, todayISO } from '../src/lib/time.js';
import { readServer, readUi } from './lib/read-source.mjs';

test('a placement is live while its last day is still ahead, and over the moment it is not', () => {
  const today = todayISO();
  assert.equal(isFeatured(addDaysISO(today, 1)), true);
  assert.equal(isFeatured(addDaysISO(today, 30)), true);
  // Exclusive at both ends of the platform: featured_until is the first day it is NOT
  // featured, so a pin sold "through Friday" is stored as Saturday and today's own date
  // means the placement has just run out.
  assert.equal(isFeatured(today), false);
  assert.equal(isFeatured(addDaysISO(today, -1)), false);
  // The ordinary salon, which has never bought one.
  assert.equal(isFeatured(null), false);
  assert.equal(isFeatured(undefined), false);
  assert.equal(isFeatured(''), false);
});

test('the SQL half answers false for a salon that has never been pinned, rather than null', () => {
  /* Not pedantry: the expression is an ORDER BY key as well as a filter, and Postgres sorts
     NULLs FIRST on DESC. Without the COALESCE every salon that never bought a placement
     outranks the one that just did — the pin would read as working while doing the opposite. */
  assert.match(IS_FEATURED_SQL, /COALESCE\(s\.featured_until, ''\)/);
  // And the day it is compared against is Vietnam's, because that is where midnight is.
  assert.match(IS_FEATURED_SQL, /Asia\/Ho_Chi_Minh/);
});

test('a pin ranks in the two default orders and in neither order the reader asked for', () => {
  const salons = readServer('routes/salons.js');
  const search = readServer('routes/search.js');
  // The list's own order, and the search's own comparator.
  assert.match(salons, /const DEFAULT_SORT = `\$\{IS_FEATURED_SQL\} DESC,/);
  assert.match(search, /const BY_RELEVANCE = \(a, b\) =>\n\s*Number\(b\.featured\) - Number\(a\.featured\)/);
  /* And the three comparators a reader picks by name are untouched: "rẻ nhất trước" that
     answered with whoever paid would be the sentence this whole slice is trying not to be. */
  const sorts = /const SORTS = \{([\s\S]*?)\n\};/.exec(search)[1];
  assert.doesNotMatch(sorts, /featured/);
});

test('the flag is really on the payload every card is drawn from', () => {
  const cards = readServer('lib/cards.js');
  assert.match(cards, /^\s*s\.featured_until,$/m);
  assert.match(cards, /featured: isFeatured\(row\.featured_until\),/);
  // And the date itself is not: the customer is told this salon is featured, not what OAK
  // was paid or until when.
  assert.doesNotMatch(cards, /featured_until: row\.featured_until/);
});

test('a paid placement is labelled where it ranks, not left to the ordering alone', () => {
  for (const [name, page] of [
    ['ket-qua-tim-kiem.html', readUi('ket-qua-tim-kiem.html')],
    ['salon-profile.html', readUi('salon-profile.html')],
  ]) {
    assert.match(page, /x-show="salon\.featured"/, `${name} draws no chip`);
    assert.match(page, /Nổi bật/, `${name} does not name the placement`);
  }
});

test('the fee notice is fanned out to living accounts only', () => {
  /* The channel the terms' thirty days' notice travels down writes one bell per account of
     the audience. An account its holder erased must not be one of them: the erasure DELETEd
     the notifications it had, nobody can sign in to read a new one, and it would inflate the
     `notified` count the operator reconciles the notice against. Both queries, because the
     audience 'all' takes the other branch. */
  const recipients = /const recipients = ([\s\S]*?);\n/.exec(readServer('routes/admin.js'))[1];
  assert.equal(
    (recipients.match(/deleted_at IS NULL/g) || []).length,
    2,
    'an announcement reaches erased accounts',
  );
});

test('the partner is told what OAK charges before signing up, and it matches the terms', () => {
  const register = readUi('dang-nhap-doi-tac.html');
  const about = readUi('gioi-thieu.html');
  const terms = readUi('dieu-khoan.html');
  assert.match(register, /Bảng giá/);
  /* The three promises, on all three pages, because a partner reads whichever one they
     landed on and two of them disagreeing is how a promise turns into a dispute. */
  for (const [name, page] of [['register', register], ['about', about], ['terms', terms]]) {
    assert.match(page, /31\/12\/2026/, `${name}: the free period has no date on it`);
    assert.match(page, /không thu hoa hồng|Không thu hoa hồng/, `${name}: says nothing about commission`);
    assert.match(page, /Nổi bật/, `${name}: does not name what may be sold`);
    assert.match(page, /30 ngày/, `${name}: does not state the notice period`);
  }
});
