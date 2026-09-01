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
  /* Every list the pin-first default order reaches, each binding the salon its own way: the
     results grid and the profile read `salon`, the booking wizard's step-1 directory reads
     `entry`. The wizard's grid is the one a customer meets on the way to paying, so a chip
     missing there is the undisclosed advertisement in the place it matters most. */
  for (const [name, chip] of [
    ['ket-qua-tim-kiem.html', /x-show="salon\.featured"/],
    ['salon-profile.html', /x-show="salon\.featured"/],
    ['dat-lich.html', /x-show="entry\.featured"/],
  ]) {
    const page = readUi(name);
    assert.match(page, chip, `${name} draws no chip`);
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

test('a pin dated in the past is stored, and announced to nobody', () => {
  /* A mistyped year stores a placement that never ranks and draws no chip, so a bell about
     it would be a promise about a thing the owner can look for and not find — with no way to
     take it back, because clearing a pin is deliberately silent. The guard is the same
     function the card and the SQL read, so the bell can never disagree with the chip. */
  const admin = readServer('routes/admin.js');
  assert.match(admin, /if \(isFeatured\(until\)\) \{\s*await notifyUser\(/);
  /* And the day the sentence names is the last one she actually holds: featured_until is
     exclusive, so a pin stored as the 1st was sold through the 30th, and an owner told the
     stored date has been promised a day more than she paid for. */
  assert.match(admin, /formatDateVN\(addDaysISO\(until, -1\)\)/);
});

test('a system notice reads as one, and points nowhere it cannot follow', () => {
  /* The type both the fee notice and the placement bell are written as. It belongs to no
     list, so the page must not offer an arrow — a row whose arrow lands somewhere that never
     mentions it is worse than a row with none — and it must not fall through to the generic
     bell the page's own rail is already drawn with. */
  const page = readUi('thong-bao.html');
  assert.match(page, /system: 'campaign',/);
  const links = /var OAK_NOTIFICATION_LINKS = \{([\s\S]*?)\};/.exec(page)[1];
  assert.doesNotMatch(links, /system:/);
  // Which is only safe because the arrow is drawn from that map and withheld when it is empty.
  assert.match(page, /linkFor\(type\) \{\s*return OAK_NOTIFICATION_LINKS\[type\] \|\| '';/);
  assert.match(page, /x-show="destination\(item\)"/);
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
