/* What the staff persona promises about who may become one, who may read what, and what a
   dead claim link is allowed to say.

   Everything that can be driven out here is driven: the given-name cut is lifted out of
   its route and run. What is left — handlers and SQL, which would need a database and a
   live request — is pinned by reading the source, as the other unit suites here do. The
   two invariants this file exists for are the ones the smoke suite genuinely cannot see:
   an invite that expired seven days ago, and the fact that 'staff' never entered the list
   of roles a caller may ask the public register for. None of this may open a connection. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (...parts) => fs.readFileSync(path.join(root, 'src', ...parts), 'utf8');

const authSource = source('routes', 'auth.js');
const dbSource = source('db.js');
const partnerSource = source('routes', 'partner.js');
const staffMeSource = source('routes', 'staff-me.js');
const usersSource = source('routes', 'users.js');
const ui = (name) => fs.readFileSync(path.join(root, '..', 'ui', name), 'utf8');
const loginHtml = ui('dang-nhap-nhan-vien.html');
const profileHtml = ui('ho-so-chuyen-gia.html');
const scheduleHtml = ui('lich-cua-toi.html');
const profileMeHtml = ui('ho-so-nhan-vien.html');
const notificationsHtml = ui('thong-bao.html');
const consoleHtml = ui('quan-ly-lich-hen.html');
const rosterHtml = ui('quan-ly-nhan-vien.html');
const termsHtml = ui('dieu-khoan.html');
const privacyHtml = ui('bao-mat.html');
const apiJs = ui('assets/js/oak-api.js');
const inviteSource = source('lib', 'staff-invite.js');
const eventsLibSource = source('lib', 'events.js');
const middlewareSource = source('middleware', 'auth.js');
const staffSource = source('routes', 'staff.js');
const departureSource = source('lib', 'staff-departure.js');
const salonsSource = source('routes', 'salons.js');
const servicesSource = source('routes', 'services.js');
const bookingsSource = source('routes', 'bookings.js');
const reviewsSource = source('routes', 'reviews.js');
const notifySource = source('lib', 'notify.js');

/** The handler of one route, up to whatever comes after it. */
function handler(text, from, to) {
  const start = text.indexOf(from);
  assert.notEqual(start, -1, `no handler matching ${from}`);
  const end = to === undefined ? text.length : text.indexOf(to, start);
  return text.slice(start, end === -1 ? text.length : end);
}

/** One top-level declaration, from its first line to the `}` that closes it in column 1. */
function declaration(text, from) {
  const start = text.indexOf(from);
  assert.notEqual(start, -1, `no declaration matching ${from}`);
  return text.slice(start, text.indexOf('\n}', start) + 2);
}

/**
 * Every call to `name(` in `text`, as source text with its parentheses balanced.
 *
 * A regex cannot do this: the arguments here span lines and carry calls of their own. The
 * scan is naive about parentheses inside string literals, which is safe for the call sites
 * it is pointed at — none of the Vietnamese bodies in this codebase contain one — and would
 * fail loudly rather than silently if one ever did.
 */
function calls(text, name) {
  const found = [];
  for (let index = text.indexOf(`${name}(`); index !== -1; ) {
    let depth = 0;
    let end = index + name.length;
    for (; end < text.length; end += 1) {
      if (text[end] === '(') {
        depth += 1;
      } else if (text[end] === ')') {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    found.push(text.slice(index, end));
    index = text.indexOf(`${name}(`, end);
  }
  return found;
}

/* Every file that reads or writes a roster row, for the sweeps that have to hold across all
   of them rather than in one place. */
const STAFF_READERS = [
  ['db.js', dbSource],
  ['lib/notify.js', notifySource],
  ['lib/staff-departure.js', departureSource],
  ['routes/staff.js', staffSource],
  ['routes/staff-me.js', staffMeSource],
  ['routes/salons.js', salonsSource],
  ['routes/services.js', servicesSource],
  ['routes/bookings.js', bookingsSource],
  ['routes/partner.js', partnerSource],
  ['routes/reviews.js', reviewsSource],
];

// ------------------------------------------------------------------ who may become staff

test("'staff' is not a role the public register can be asked for", () => {
  // The list is what a CALLER may name. A staff account exists only because a salon owner
  // minted a link and somebody redeemed it, so adding 'staff' here would be handing them
  // out on request.
  assert.match(authSource, /const ROLES = \['customer', 'partner'\];/);
  assert.doesNotMatch(authSource, /ROLES = \[[^\]]*'staff'/);

  // The check is skipped only when this file's own routes fixed the role, never when the
  // request named one.
  const create = handler(authSource, 'async function createAccount(', "router.post('/register'");
  assert.match(create, /if \(forcedRole == null && !ROLES\.includes\(accountRole\)\) \{/);
  assert.match(create, /const accountRole = forcedRole \?\? role \?\? 'customer';/);
  // Every forcedRole in the file is a literal, which is what makes skipping the list safe.
  for (const call of authSource.match(/(?<!function )createAccount\(req, res, next, [^,)]+/g) ?? []) {
    assert.match(call, /createAccount\(req, res, next, (null|'customer'|'partner'|'staff')/, call);
  }
  assert.match(authSource, /createAccount\(req, res, next, 'staff'/);
});

test('the claim runs inside the transaction that creates the account', () => {
  // The hook is awaited inside db.withTransaction, so a claim that could not be written
  // takes the account down with it rather than leaving somebody holding nothing.
  const create = handler(authSource, 'async function createAccount(', "router.post('/register'");
  const transaction = create.slice(create.indexOf('db.withTransaction'));
  assert.match(transaction, /if \(afterInsert\) \{\s*await afterInsert\(tx, userId\);/);

  const register = handler(authSource, "router.post('/staff/register'", "router.post('/login'");
  assert.match(register, /await tx\.run\(CLAIM_STAFF_ROW, userId, claimedAt, invite\.staff_id\)/);
  assert.match(register, /await tx\.run\(SPEND_STAFF_INVITE, invite\.token\)/);
  // Both guarded, and both a 409: two people redeeming one link at the same moment, and
  // only the one whose UPDATE actually changed a row comes out with the profile. This is
  // the race findLiveInvite cannot close, because its read straddles the password hash.
  assert.equal((register.match(/changes !== 1/g) || []).length, 2);
  // The event is gated on what createAccount returned, not on the state of the response:
  // res.headersSent is true on the failure path too, one microtask later.
  assert.match(register, /const created = await createAccount\(req, res, next, 'staff',/);
  assert.match(register, /if \(created\) \{\s*await recordEvent\('staff_claimed'/);
  assert.doesNotMatch(authSource, /headersSent/);
  // createAccount hands the account back, and hands back nothing when it took next().
  assert.match(create, /res\.json\(\{ success: true, data: \{ user, welcome_code: welcomeCode \} \}\);\s*return user;/);
  assert.match(create, /catch \(error\) \{\s*next\(error\);\s*return undefined;/);
});

test('the register endpoint only ever performs a first claim', () => {
  const register = handler(authSource, "router.post('/staff/register'", "router.post('/login'");
  // No second branch and no password write: a link that sets a password on an account
  // somebody already holds is account takeover, whoever hands it over.
  assert.doesNotMatch(register, /UPDATE_PASSWORD|issueCookie|invite\.user_id/);
  assert.doesNotMatch(register, /MIN_PASSWORD_LENGTH/);
  // The preview says nothing about whether a row is claimed, because a claim link now only
  // ever exists for a row that is not.
  const preview = handler(
    authSource,
    "router.get('/staff/invite/:token'",
    "router.post('/staff/register'",
  );
  assert.doesNotMatch(preview, /claimed/);
  assert.match(preview, /staff_name: invite\.staff_name,\s*salon_name: invite\.salon_name,\s*expires_at: invite\.expires_at,/);
});

test('the owner-triggered recovery mails the technician and tells the owner nothing', () => {
  const invite = handler(
    partnerSource,
    "router.post('/staff/:id/invite'",
    "router.delete('/staff/:id/invite'",
  );
  const claimed = invite.slice(invite.indexOf('if (staff.user_id != null)'), invite.indexOf('const token = randomBytes'));
  assert.ok(claimed.length > 0, 'the claimed-row branch has moved');

  // The reset table, through auth.js's own machinery — never a staff_invites row.
  assert.match(claimed, /resetToken = await mintResetIn\(tx, staff\.user_id\)/);
  assert.doesNotMatch(claimed, /INSERT_STAFF_INVITE|inviteUrl|RETIRE_STAFF_INVITES/);
  assert.match(partnerSource, /import \{ deliverResetLink, mintResetIn \} from '\.\/auth\.js';/);
  // Delivered after the commit: a mail sent for a rolled-back transaction points at a
  // token that was never written.
  assert.ok(claimed.indexOf('db.withTransaction') < claimed.indexOf('await deliverResetLink('));
  // The owner learns that it went, and nothing whatsoever about the link.
  assert.match(claimed, /res\.json\(\{ success: true, data: \{ recovery: 'sent' \} \}\)/);
  assert.doesNotMatch(claimed, /resetToken \}|url|token:/);
  // The technician is told, in the same transaction, and told the truth about where it went.
  assert.match(claimed, /Liên kết đã được gửi tới email của bạn/);

  // And in a deploy with no mail channel the link goes to the log, never into a reply:
  // the caller here is the owner, not the account holder.
  const deliver = declaration(authSource, 'export async function deliverResetLink(');
  assert.match(deliver, /if \(!process\.env\.RESEND_API_KEY && process\.env\.NODE_ENV !== 'production'\) \{\s*console\.info/);
  assert.doesNotMatch(deliver, /res\.|demo_reset_url/);
  // The address is read in there, so partner.js never has to hold a technician's email.
  assert.match(deliver, /await selectUserEmail\.get\(userId\)/);
  assert.doesNotMatch(partnerSource, /selectUserEmail|sendResetMail/);
  // One funnel event name per path, and this path creates no invite so it raises none.
  assert.doesNotMatch(claimed, /recordEvent/);
});

test("an owner leaning on the recovery button stops retiring their technician's reset", () => {
  const invite = handler(
    partnerSource,
    "router.post('/staff/:id/invite'",
    "router.delete('/staff/:id/invite'",
  );
  const claimed = invite.slice(invite.indexOf('if (staff.user_id != null)'), invite.indexOf('const token = randomBytes'));

  // A minute per roster row. Minting retires whatever reset the account had outstanding,
  // so without this a second press kills the link the technician asked for themselves.
  assert.match(partnerSource, /const RECOVERY_COOLDOWN_MS = 60 \* 1000;/);
  assert.match(
    claimed,
    /if \(recoveryOnCooldown\(staffId\)\) \{\s*res\.json\(\{ success: true, data: \{ recovery: 'sent' \} \}\);\s*return;/,
  );
  // Stamped after the mail has actually gone, so a mint that rolled back leaves the next
  // press free rather than blocking it for a minute on nothing.
  assert.ok(claimed.indexOf('await deliverResetLink(') < claimed.indexOf('recoverySentAt.set('));
  // Swept on the way past, like the tallies in auth.js: an idle process holds nothing.
  const cooldown = declaration(partnerSource, 'function recoveryOnCooldown(');
  assert.match(cooldown, /now - sentAt >= RECOVERY_COOLDOWN_MS/);
  assert.match(cooldown, /recoverySentAt\.delete\(seen\)/);
});

test('only a dead token spends the preview allowance', () => {
  const preview = handler(
    authSource,
    "router.get('/staff/invite/:token'",
    "router.post('/staff/register'",
  );
  // Counted after the lookup and inside the miss branch alone. A whole salon team opens
  // their links from the shop's one address, and ten of those in a morning is ordinary
  // traffic — counting them locked the last technician out of their own invitation.
  assert.ok(preview.indexOf('await findLiveInvite') < preview.indexOf('rateLimited('));
  const miss = preview.slice(preview.indexOf('if (!invite) {'));
  assert.match(miss, /rateLimited\(invitePreviewAttempts, req\.ip, INVITE_PREVIEW_MAX_ATTEMPTS\)/);
  assert.match(miss, /429,\s*'TOO_MANY_ATTEMPTS'/);
  assert.equal((preview.match(/rateLimited\(/g) || []).length, 1);
});

test('erasing an account gives its roster rows back to the salon', () => {
  /* The chair goes back to the salon and the personal half goes with the person. Clearing
     user_id alone would not merely leave a bio and a face behind — it would PUT THEM BACK UP:
     the public gates pass any row with user_id IS NULL, so a profile its holder had withdrawn
     returns to the public side the moment they erase the account, with nobody left who can
     sign in and take it down. And profile_hidden is reset so the next person to claim the
     chair does not inherit somebody else's withdrawal.

     The attestations go with her too, and for the sharpest version of the same reason: a ✓ is
     one person's answer about one date, so leaving started_confirmed_at, left_confirmed_at or
     a dispute on the released row would hand the next claimant a stint already attested to —
     a badge for days she has never seen, or an argument she never started. The DATES stay:
     started_at and left_at are the salon's own record of when that chair was worked. What
     leaves is only what the person said back about them. */
  /* The whole statement, not three substrings of it: this UPDATE decides what survives an
     erasure, and a scope or a column slipped into the gaps between substring matches — an
     `active = 0`, an `AND salon_id = ?` — would change who it touches without failing a
     thing. Whitespace-normalised so the SQL can be re-wrapped, never re-worded. */
  const release = handler(usersSource, 'const RELEASE_STAFF_ROWS', '`;').replace(/\s+/g, ' ').trim();
  assert.equal(
    release,
    'const RELEASE_STAFF_ROWS = ` UPDATE staff SET user_id = NULL, claimed_at = NULL, ' +
      'bio = NULL, portfolio = NULL, image = NULL, profile_hidden = 0, ' +
      'started_confirmed_at = NULL, left_confirmed_at = NULL, tenure_disputed = 0 ' +
      'WHERE user_id = ?',
  );
  // Named here as well as inside that string, so a column dropped out of the SET clause and
  // out of the expectation together still fails something.
  for (const column of ['started_confirmed_at', 'left_confirmed_at', 'tenure_disputed']) {
    assert.match(release, new RegExp(`${column} = (?:NULL|0)`), column);
  }
  // And the dates themselves are not in it: they are the salon's statement, not hers.
  assert.doesNotMatch(release, /started_at = NULL|left_at = NULL|left_by = NULL/);
  // In the same transaction as the anonymise, and before it: a row still pointing at an
  // account whose address is now deleted+id@oak.invalid reads as claimed forever, and
  // every recovery the owner triggers from it mails into nothing.
  const erase = handler(usersSource, "router.delete('/me'", 'export default router');
  const transaction = erase.slice(erase.indexOf('db.withTransaction'));
  assert.match(transaction, /await tx\.run\(RELEASE_STAFF_ROWS, req\.user\.id\);/);
  assert.ok(transaction.indexOf('RELEASE_STAFF_ROWS') < transaction.indexOf('ANONYMISE_USER'));
});

test('requireStaff is requirePartner with the other role', () => {
  const requireStaff = declaration(middlewareSource, 'export function requireStaff(');
  const requirePartner = declaration(middlewareSource, 'export function requirePartner(');
  assert.equal(
    requireStaff
      .replace(/requireStaff/, 'requirePartner')
      .replace(/'staff'/, "'partner'")
      .replace(/tài khoản nhân viên/, 'tài khoản đối tác'),
    requirePartner,
  );
  assert.match(requireStaff, /'FORBIDDEN', 'Chức năng này chỉ dành cho tài khoản nhân viên\.'/);
});

// ------------------------------------------------------------------ what a dead link says

test('a link is live only while it is unspent, unexpired, and behind an unclaimed working row', () => {
  // Two of these clauses are the only place they are checked at all: the smoke suite has
  // no database handle inside a group, so it can neither age a token by seven days nor
  // claim a row out from under a live token without spending that token in the process.
  assert.match(
    inviteSource,
    /WHERE i\.token = \? AND i\.used = 0 AND i\.expires_at > \?\s*AND st\.active = 1 AND st\.user_id IS NULL/,
  );
  // user_id IS NULL lives in the rule, not in three callers: put here it comes back as the
  // same uniform 404 as any other dead token, so no reply can be read to say whether the
  // technician behind a row has an account.
  assert.doesNotMatch(inviteSource, /SELECT[\s\S]*?st\.user_id,/);
  for (const text of [authSource, staffMeSource]) {
    assert.doesNotMatch(text, /invite\.user_id/);
  }
  // Compared against now, as an ISO-8601 string, which sorts in the order the instants
  // happened — the comparison means what it looks like it means.
  assert.match(
    inviteSource,
    /return selectLiveInvite\.get\(token, new Date\(\)\.toISOString\(\)\);/,
  );
  // An invite for a roster row that was taken off the roster is dead however fresh the
  // token is, which is why the staff join lives in here rather than in the callers.
  assert.match(inviteSource, /JOIN staff st ON st\.id = i\.staff_id/);
});

test('garbage, spent, expired, retired and already-claimed all answer with one body', () => {
  assert.match(
    inviteSource,
    /export function inviteNotFound\(\) \{\s*return httpError\(\s*404,\s*'NOT_FOUND',/,
  );
  /* One factory and nothing else: a 404 written by hand in any of the three paths that take a
     token would be a reply that says whether the token was real.

     staff-me.js is asked about its claim handler rather than about the whole file, because
     PATCH /profile answers 404 too and that one is a different question — a roster row the
     caller does not hold, addressed by an id they already had. It says nothing about a token
     and borrows nothing from this rule, so folding it in here would only blunt the rule. */
  assert.equal((inviteSource.match(/httpError\(\s*404/g) || []).length, 1);
  const claim = handler(staffMeSource, "router.post('/claim'", 'const CLAIMED_STAFF_COLUMNS');
  for (const [name, text] of [
    ['routes/auth.js', authSource],
    ['routes/staff-me.js (the claim)', claim],
  ]) {
    assert.equal((text.match(/httpError\(\s*404/g) || []).length, 0, name);
    assert.match(text, /inviteNotFound/, name);
  }
  // The preview, the register and the claim: all three refuse an unusable token this way,
  // and each of them exactly once — the validity rule leaves them nothing to branch on.
  assert.equal((authSource.match(/throw inviteNotFound\(\)/g) || []).length, 2);
  assert.equal((staffMeSource.match(/throw inviteNotFound\(\)/g) || []).length, 1);
});

test('spending a link is the same statement that redeems it', () => {
  // Conditional on used = 0, the way SPEND_PASSWORD_RESET is, so the guard and the write
  // cannot come apart under two concurrent redemptions.
  assert.match(
    inviteSource,
    /SPEND_STAFF_INVITE = 'UPDATE staff_invites SET used = 1 WHERE token = \? AND used = 0'/,
  );
  assert.match(
    inviteSource,
    /CLAIM_STAFF_ROW =\s*'UPDATE staff SET user_id = \?, claimed_at = \? WHERE id = \? AND user_id IS NULL'/,
  );
  // The new row must never retire itself, so the retire runs first — the same order
  // mintReset uses for a password link.
  const invite = handler(
    partnerSource,
    "router.post('/staff/:id/invite'",
    "router.delete('/staff/:id/invite'",
  );
  assert.ok(invite.indexOf('RETIRE_STAFF_INVITES') < invite.indexOf('INSERT_STAFF_INVITE'));
});

// ------------------------------------------------------------------ what a technician reads

test('the technician read never selects anything that identifies a customer', () => {
  const columns = handler(staffMeSource, 'const STAFF_BOOKING_COLUMNS', 'const STAFF_BOOKING_FROM');
  assert.doesNotMatch(columns, /customer_phone/);
  assert.doesNotMatch(columns, /b\.note/);
  // customer_name is read only so the given name can be cut out of it, and the shape the
  // handler builds is explicit, so nothing else can ride along.
  assert.match(columns, /b\.customer_name/);
  const shape = handler(staffMeSource, 'data: rows.map', 'export default router');
  assert.match(shape, /customer: \{ given_name: givenName\(row\.customer_name\) \}/);
  assert.doesNotMatch(shape, /row\.customer_name,/);
});

test('the given name is the last token of a Vietnamese name', () => {
  // Lifted rather than imported: importing the route would open a database connection,
  // which nothing in this directory may do.
  const { givenName } = vm.runInNewContext(
    `${declaration(staffMeSource, 'export function givenName(').replace('export ', '')}
     ({ givenName });`,
  );

  assert.equal(givenName('Nguyễn Thị Mai Lan'), 'Lan');
  assert.equal(givenName('Ngọc Anh'), 'Anh');
  assert.equal(givenName('Lan'), 'Lan');
  assert.equal(givenName('  Trần   Bảo   Long  '), 'Long');
  // A booking taken over the counter without a name has no given name to hand over.
  assert.equal(givenName(''), null);
  assert.equal(givenName('   '), null);
  assert.equal(givenName(null), null);
  assert.equal(givenName(undefined), null);
});

test('/claim is reachable by a customer, and only the two reads are staff-only', () => {
  // A global requireStaff would lock out exactly the accounts /claim exists to upgrade.
  assert.match(staffMeSource, /router\.use\(requireAuth\);/);
  assert.doesNotMatch(staffMeSource, /router\.use\([^)]*requireStaff/);
  assert.match(staffMeSource, /router\.get\('\/profile', requireStaff,/);
  assert.match(staffMeSource, /router\.get\('\/bookings', requireStaff,/);
  assert.match(staffMeSource, /router\.post\('\/claim', async/);

  // Scoped through the claim, never through an id in the path: there is no roster row a
  // technician can name that is not one they hold.
  assert.match(staffMeSource, /WHERE st\.user_id = \?/);
  assert.match(staffMeSource, /'st\.user_id = \?'/);
});

test('a customer is upgraded in place, keeping the row their history hangs off', () => {
  assert.match(
    staffMeSource,
    /UPGRADE_TO_STAFF = "UPDATE users SET role = 'staff' WHERE id = \? AND role = 'customer'"/,
  );
  const claim = handler(staffMeSource, "router.post('/claim'", 'const selectClaimedStaff');
  // A partner is refused rather than upgraded: the console derives its salon from the
  // signed-in owner, and an account that was both would have two readings of "your salon".
  assert.match(claim, /if \(req\.user\.role === 'partner'\)/);
  assert.ok(claim.indexOf("=== 'partner'") < claim.indexOf('db.withTransaction'));
  // One live claimed row per person per salon, enforced by the index rather than by a
  // check that a second request could slip past.
  assert.match(claim, /error\.constraint === 'idx_staff_user_salon'/);
});

// ------------------------------------------------------------ what the numbers rest on

test('neither figure a profile rests on is left to a sweep that ran once', () => {
  /* Neither of these can be driven end to end: this file may not open a connection, and the
     smoke suite boots the server exactly once, so "boot it twice and watch nothing move" is
     out of reach from either side. Pinned at source level instead, the way the expiry clause
     above is.

     The whole shape being pinned is the absence of a one-time migration. A backfill guarded
     by a sentinel writes every row it will ever write on one boot, so anything opened
     afterwards is a row that block will never see again — which is how started_at came to
     mark the veterans and leave every later hire blank forever. */
  assert.doesNotMatch(dbSource, /column_name = 'started_at'/);

  // The column is added like any other, in SCHEMA and unconditionally. It is written from
  // one place — the console, a date the salon typed — and where it is empty lib/staff-stats.js
  // answers from the bookings instead.
  assert.match(dbSource, /^ALTER TABLE staff ADD COLUMN IF NOT EXISTS started_at TEXT;$/m);
  assert.equal((dbSource.match(/ADD COLUMN IF NOT EXISTS started_at/g) || []).length, 1);
  // And no sweep writes it, at boot or anywhere else — a start date is derived on every read
  // or it is the salon's own answer, never a value frozen at whatever one boot could see.
  assert.doesNotMatch(dbSource, /SET started_at/);

  /* The rating cache is the opposite case and gets the opposite treatment: it has live
     writers in routes/reviews.js, so bringing it to the real average is self-healing rather
     than a one-time guess, and it runs on every boot behind no sentinel at all. */
  const converge = dbSource.slice(
    dbSource.indexOf('UPDATE staff st SET rating'),
    dbSource.indexOf('`);', dbSource.indexOf('UPDATE staff st SET rating')),
  );
  assert.ok(converge.length > 0, 'the rating convergence has moved');
  assert.match(
    converge,
    /UPDATE staff st SET rating = COALESCE\(\s*\(SELECT ROUND\(AVG\(r\.rating\), 1\) FROM reviews r WHERE r\.staff_id = st\.id\), 0\s*\)/,
  );
  assert.doesNotMatch(converge, /IF NOT EXISTS|DO \$\$/);
  /* What keeps every-boot from meaning every-boot-rewrites-the-roster: the WHERE, and the
     cast inside it. Without ::real the stored four-byte 4.8 is compared against the ten-digit
     4.8 the average comes back as, no row ever looks converged, and the guard is decoration. */
  assert.match(
    converge,
    /WHERE st\.rating IS DISTINCT FROM COALESCE\(\s*\(SELECT ROUND\(AVG\(r\.rating\), 1\) FROM reviews r WHERE r\.staff_id = st\.id\), 0\s*\)::real/,
  );
  // And it is the only sweep that rewrites a roster row.
  assert.equal((dbSource.match(/UPDATE staff st SET/g) || []).length, 1);

  // A row written before the source column existed keeps NULL: there is no sweep anywhere
  // that guesses at who attested to a visit nobody recorded.
  assert.match(dbSource, /ALTER TABLE bookings ADD COLUMN IF NOT EXISTS source TEXT;/);
  assert.doesNotMatch(dbSource, /UPDATE bookings SET source/);

  /* The other half of "NULL means the pre-column era and nothing else": the seed names it on
     every row it writes, so a fresh install demos the tiers it actually has rather than
     filing today's demo data as history from before the system existed. */
  const seedSource = source('seed.js');
  assert.match(seedSource, /INSERT INTO bookings \([^)]*payment_method, source, created_at\)/);
  assert.equal(
    (seedSource.match(/source: '(customer|partner)',/g) || []).length,
    (seedSource.match(/code: 'OAK-[A-Z0-9]+',/g) || []).length,
  );
  // One of them is a walk-in, so the tier a counter-typed visit lands in is not empty on a
  // demo — and it is completed, because nothing else is counted into a tier at all.
  assert.match(seedSource, /status: 'completed',[\s\S]{0,300}?source: 'partner',/);
});

/* The start date is a read, not a stored fact: the column wins where a salon has entered one
   and the bookings answer everywhere else. Pinned here because the expression is the whole
   rule — completed only, and the column first — and the smoke suite can only see its result. */
test('a start date is the first completed visit, unless the salon entered one', () => {
  const statsSource = source('lib', 'staff-stats.js');
  const start = handler(statsSource, 'const selectStaffStart', '`);');
  // The stored value leads the COALESCE, so it outranks the derived date rather than being
  // averaged with it or ignored.
  assert.match(start, /COALESCE\(\s*st\.started_at,/);
  assert.match(start, /SELECT MIN\(b\.date\) FROM bookings b WHERE b\.staff_id = st\.id/);
  /* Completed only. A cancelled visit is not a day anybody worked, and a booking still in
     the future is not a day anybody has worked yet — either one would date a career from a
     day that never happened, and put a "tại salon từ" on the profile to prove it. */
  assert.match(start, /AND b\.status = 'completed'/);
  // And months_active counts from that same effective value rather than from the column.
  assert.match(statsSource, /months_active: monthsActive\(startedAt, todayISO\(\)\)/);
});

// ------------------------------------------------------ the page the link opens onto

/* dang-nhap-nhan-vien.html keeps its factory inline in a <script>, so lift it out and
   drive it here — the way test/auth-password-ui.test.mjs drives the other sign-in pages. */
function staffLoginPage({ user = null, invite = null, loginAs = null, query = {} } = {}) {
  const tail = loginHtml.slice(loginHtml.indexOf('function oakStaffNext('));
  const script = tail.slice(0, tail.indexOf('</script>'));
  const context = {
    location: { href: '' },
    OAK: {
      me: async () => user,
      api: async (endpoint) => {
        if (endpoint.startsWith('/api/auth/staff/invite/')) {
          if (!invite) {
            throw new Error('Liên kết không hợp lệ hoặc đã hết hạn.');
          }
          return invite;
        }
        if (endpoint === '/api/auth/login') {
          return { user: { role: loginAs } };
        }
        return assert.fail(`unexpected call: ${endpoint}`);
      },
      fmtDate: (value) => String(value),
      qs: (name) => (name in query ? query[name] : null),
    },
  };
  vm.runInNewContext(`${script}\nresult = oakStaffAuth();`, context);
  context.result.location = context.location;
  return context.result;
}

const liveInvite = {
  staff_name: 'Phương Vy',
  salon_name: 'Lala Nail Studio',
  expires_at: '2026-09-05T00:00:00.000Z',
};

test('a technician holding a link from a second salon is offered the claim, not their calendar', async () => {
  const state = staffLoginPage({
    user: { role: 'staff', email: 'nhanvien@oak.vn' },
    invite: liveInvite,
    query: { invite: 'tok-second-salon' },
  });

  await state.init();

  // Somebody who works at two salons is handed the second link exactly as they were the
  // first, and POST /api/staff-me/claim takes it. Sending them to their calendar here —
  // which is what being staff used to mean on this page — left that profile unclaimable
  // from the site at all.
  assert.equal(state.mode, 'claim');
  assert.equal(state.location.href, '');
  // And the panel names the account that is about to gain it, rather than calling the
  // technician's own account "another OAK account".
  assert.equal(state.account, 'nhanvien@oak.vn');
  assert.match(loginHtml, /<span x-text="account"><\/span>/);
  assert.doesNotMatch(loginHtml, /một tài khoản OAK khác/);
});

test('a technician arriving with no link is sent straight to their calendar', async () => {
  const state = staffLoginPage({ user: { role: 'staff', email: 'nhanvien@oak.vn' } });

  await state.init();

  assert.equal(state.location.href, 'lich-cua-toi.html');
  assert.equal(state.account, '');
});

test('only a technician is sent on by ?next=', async () => {
  // lich-cua-toi.html bounces everybody who is not staff, and writes ?next= on its way. A
  // customer who signs in here and is then handed that same target lands back on the page
  // that bounced them — signed in, told nothing, and looking at this form again.
  const bounced = { next: 'lich-cua-toi.html' };

  const customer = staffLoginPage({ loginAs: 'customer', query: bounced });
  await customer.init();
  await customer.login();
  assert.equal(customer.location.href, 'kham-pha.html');

  const technician = staffLoginPage({ loginAs: 'staff', query: bounced });
  await technician.init();
  await technician.login();
  assert.equal(technician.location.href, 'lich-cua-toi.html');

  const owner = staffLoginPage({ loginAs: 'partner', query: bounced });
  await owner.init();
  await owner.login();
  assert.equal(owner.location.href, 'tong-quan-doi-tac.html');
});

// ------------------------------------------------------------------ measurement

test('the events the server writes itself can never name a person', () => {
  // ref, meta and session_hash are NULL by construction: there is no visitor behind these
  // rows to describe, and this table is the one that must not be able to say who did what.
  assert.match(eventsLibSource, /VALUES \(\?, \?, NULL, NULL, NULL, \?\)/);
  // A failure here must never take its caller's request down with it.
  assert.match(eventsLibSource, /catch \(error\) \{\s*console\.error/);

  /* Every call site passes a route SHAPE and never a filled-in one. There is exactly one
     way to get an id in there — interpolating it — so the second argument has to be a
     plain single-quoted literal starting at /api/, with no digit anywhere in it. */
  const callSites = [
    ...(authSource.match(/recordEvent\([^)]*\)/g) ?? []),
    ...(partnerSource.match(/recordEvent\([^)]*\)/g) ?? []),
    ...(staffMeSource.match(/recordEvent\([^)]*\)/g) ?? []),
  ];
  assert.equal(callSites.length, 5);
  for (const call of callSites) {
    const shape = call.match(/^recordEvent\('[a-z_]+', '(\/api\/[a-z:/-]+)'\)$/);
    assert.ok(shape, `not a literal route shape: ${call}`);
    assert.doesNotMatch(shape[1], /\d/, call);
  }
  assert.match(partnerSource, /recordEvent\('staff_invite_created', '\/api\/partner\/staff\/:id\/invite'\)/);
  assert.match(authSource, /recordEvent\('staff_invite_opened', '\/api\/auth\/staff\/invite\/:token'\)/);
  assert.match(staffMeSource, /recordEvent\('staff_claimed', '\/api\/staff-me\/claim'\)/);
  // Logged on every staff sign-in, because "first" cannot be derived without either a
  // column for it or an account id in this table, and the second is not on the table.
  assert.match(authSource, /recordEvent\('staff_login', '\/api\/auth\/login'\)/);
});

// ------------------------------------------------- the numbers, on the pages that show them

/* Both pages keep their factory inline in a <script>, so lift each one out and drive it,
   the way the sign-in page above is driven. */

/**
 * oakStaffProfile() over a stand-in browser, answering /api/staff/:id with `stats`.
 *
 * `history` is the CV underneath it, and `historyFails` is the other half of that contract:
 * the read is soft, so a rejection has to leave the rest of init() standing.
 */
function specialistPage(stats, { history = [], historyFails = null } = {}) {
  const tail = profileHtml.slice(profileHtml.indexOf('function oakTodayISO('));
  const reviews = Object.assign([], { meta: { total: 0, average: 0 } });
  const context = {
    URLSearchParams,
    location: { href: 'https://oak.test/ho-so-chuyen-gia.html?id=1' },
    navigator: {},
    window: {},
    OAK: {
      qs: (name) => (name === 'id' ? '1' : null),
      meta: () => {},
      fmtDate: (value) => value,
      toast: () => {},
      api: async (url) => {
        if (url.includes('/availability')) {
          return { week: [] };
        }
        if (url.includes('/reviews')) {
          return reviews;
        }
        if (url.endsWith('/services')) {
          return [];
        }
        if (url.endsWith('/history')) {
          if (historyFails) {
            throw new Error(historyFails);
          }
          return history;
        }
        return {
          id: 1, name: 'KTV Số Liệu', title: 'KTV', specialty: '', bio: '', image: 'a.webp',
          rating: 4.8, years_experience: 6, portfolio: [],
          salon: { id: 4, slug: 'lala', name: 'Lala' }, stats,
        };
      },
    },
  };
  vm.runInNewContext(
    `${tail.slice(0, tail.indexOf('</script>'))}\nresult = oakStaffProfile();`,
    context,
  );
  return context.result;
}

/** oakStaffSchedule() over the same kind of stand-in, answering /api/staff-me/profile. */
function schedulePage(profiles, { unread = 0, profileError = null } = {}) {
  const tail = scheduleHtml.slice(scheduleHtml.indexOf('function oakStaffSchedule('));
  const toasts = [];
  const context = {
    OAK: {
      requireStaff: async () => ({ name: 'KTV Số Liệu' }),
      toast: (message, type) => toasts.push([message, type]),
      api: async (endpoint) => {
        if (endpoint === '/api/staff-me/profile') {
          if (profileError) {
            throw new Error(profileError);
          }
          return profiles;
        }
        if (endpoint.startsWith('/api/notifications')) {
          return { unread_count: unread };
        }
        return [];
      },
      todayISO: () => '2026-08-28',
      fmtDate: (value) => value,
      fmtTime: (value) => value,
      bookingStatus: () => ({ label: '', icon: '', class: '' }),
    },
  };
  vm.runInNewContext(
    `${tail.slice(0, tail.indexOf('</script>'))}\nresult = oakStaffSchedule();`,
    context,
  );
  context.result.toasts = toasts;
  return context.result;
}

const COUNTED = {
  verified_count: 3,
  walkin_count: 2,
  unattested_count: 1,
  legacy_count: 4,
  distinct_customers: 3,
  review_count: 5,
  rating_avg: 4.8,
  started_at: '2026-02-14',
  months_active: 6,
};

test('the profile adds the four tiers up, and never invents a month it was not given', async () => {
  const page = specialistPage(COUNTED);
  await page.init();

  // The tiers are a partition of the completed bookings, so the headline figure is their
  // sum — not verified_count, which would understate the work, and not a fifth query.
  assert.equal(page.completedTotal(), 10);
  assert.equal(page.sinceLabel(), 'tại salon từ 02/2026');

  /* A roster row whose only bookings were cancelled, or are still ahead of it, has completed
     nothing to date from and no date of its own, so the server sends null. The fragment is
     dropped whole rather than filled with today, which would read as a career starting this
     morning. The "(tự khai)" beside the self-declared years stays regardless: those years
     are the technician's own claim whether or not anything here corroborates them. */
  const fresh = specialistPage({ ...COUNTED, started_at: null, months_active: null });
  await fresh.init();
  assert.equal(fresh.sinceLabel(), '');

  // And a reply with no block at all leaves the strip off the page rather than reading a
  // row of zeroes at a technician whose numbers nobody has.
  const bare = specialistPage(undefined);
  await bare.init();
  assert.equal(bare.stats(), null);
  assert.equal(bare.showStats(), false);
});

test('a technician with nothing behind them yet is shown no numbers, not a row of zeroes', async () => {
  const EMPTY = {
    verified_count: 0, walkin_count: 0, unattested_count: 0, legacy_count: 0,
    distinct_customers: 0, review_count: 0, rating_avg: 0,
    started_at: null, months_active: null,
  };

  /* The strip is not information at zero — "0 lượt hoàn thành · 0 khách khác nhau" under
     somebody hired last week says nothing a customer can act on, and reads as a verdict on
     them. The whole thing is withheld rather than trimmed figure by figure. */
  const opening = specialistPage(EMPTY);
  await opening.init();
  assert.equal(opening.completedTotal(), 0);
  assert.equal(opening.showStats(), false);

  /* One completed visit, and it all comes back — including the bold zero. "0 khách khác
     nhau" beside real completed work is the one reading this line exists to make possible:
     a salon that ran the same customer through twice, or a row of counter-typed walk-ins.
     Hiding that figure on its own is what would make the strip a claim rather than a count. */
  const working = specialistPage({ ...EMPTY, walkin_count: 1 });
  await working.init();
  assert.equal(working.completedTotal(), 1);
  assert.equal(working.showStats(), true);
  assert.equal(working.stats().distinct_customers, 0);

  // A review with no completed visit behind it is also something to say, so it opens the
  // strip on its own.
  const reviewed = specialistPage({ ...EMPTY, review_count: 1, rating_avg: 5 });
  await reviewed.init();
  assert.equal(reviewed.showStats(), true);

  /* The case the later slice creates: a salon enters a start date for somebody who has
     completed nothing and been reviewed by nobody. The strip stays away — a date somebody
     typed is not a record of work — so the page carries the years chip and nothing to hold
     it against. */
  const dated = specialistPage({ ...EMPTY, started_at: '2020-03-01', months_active: 77 });
  await dated.init();
  assert.equal(dated.sinceLabel(), 'tại salon từ 03/2020');
  assert.equal(dated.showStats(), false);

  /* And that is exactly the profile the hedge must not desert. `opening` above is the
     starkest version of it — no start date, no strip — and the label is on the years chip
     there as much as anywhere, because it is unconditional markup: no x-show to evaluate,
     so no state of this component can withhold it. Pinned as markup rather than driven,
     since there is no method left to call: that is the point of the change. */
  assert.equal(opening.sinceLabel(), '');
  assert.equal(opening.showStats(), false);
  assert.match(profileHtml, /<span> \(tự khai\)<\/span>/);
  assert.doesNotMatch(profileHtml, /x-show="[^"]*"> \(tự khai\)</);

  // The strip itself still hangs off showStats() and not off stats(), which is only "did a
  // block arrive" — and stats() is read first inside it, since completedTotal() derefs it.
  assert.match(profileHtml, /<template x-if="showStats\(\)">/);
  assert.doesNotMatch(profileHtml, /<template x-if="stats\(\)">/);
  const show = handler(profileHtml, 'showStats() {', '},');
  assert.ok(show.indexOf('this.stats()') < show.indexOf('this.completedTotal()'));
});

test('every figure on the profile is one the server counted, and a tier of nothing is no line', () => {
  assert.match(profileHtml, /x-text="completedTotal\(\) \+ ' lượt hoàn thành'"/);
  // distinct_customers is the one figure a salon cannot lift by putting the same customer
  // through twice, so it is the one carrying the emphasis.
  assert.match(
    profileHtml,
    /class="font-bold text-primary" x-text="stats\(\)\.distinct_customers \+ ' khách khác nhau'"/,
  );
  // The average and the count behind it come out of that same block, live…
  assert.match(
    profileHtml,
    /Number\(stats\(\)\.rating_avg\)\.toFixed\(1\) \+ ' từ ' \+ stats\(\)\.review_count \+ ' đánh giá'/,
  );
  // …and nothing on the page reads the cached column beside it, which is the field a
  // profile used to state a seeded number out of.
  assert.doesNotMatch(profileHtml, /staff\.rating/);

  /* Every tier is named, and a tier nobody has any of is not a line saying zero. All four,
     deliberately: a walk-in counted into the headline total and then left unnamed underneath
     it is the one arithmetic this line exists to close. */
  const TIERS = ['verified_count', 'walkin_count', 'unattested_count', 'legacy_count'];
  for (const tier of TIERS) {
    assert.match(profileHtml, new RegExp(`x-show="stats\\(\\)\\.${tier}"`), tier);
  }

  /* And each separator hangs off the piece in front of it rather than the one behind, so a
     technician with nothing verified opens that line on a word instead of on a stray dot —
     which is exactly the reading a roster row of walk-ins gets. Each dot is therefore shown
     on the disjunction of every tier that could precede it, and the first piece has none. */
  for (const page of [profileHtml, scheduleHtml]) {
    for (let index = 1; index < TIERS.length; index += 1) {
      const preceding = TIERS.slice(0, index)
        .map((tier) => `[\\w.()]*${tier}`)
        .join(' \\|\\| ');
      assert.match(
        page,
        new RegExp(`<span aria-hidden="true" x-show="${preceding}">·</span>`),
        TIERS[index],
      );
    }
    // The first phrase carries no dot at all, whichever tier turns out to be first.
    assert.doesNotMatch(page, /<span aria-hidden="true">·<\/span>/);
  }

  /* The headline figure is the sum of exactly the tiers named underneath it, so the line
     accounts for every visit the number above it counted and a reader can add it up. */
  const total = handler(profileHtml, 'completedTotal() {', '},');
  for (const tier of TIERS) {
    assert.match(total, new RegExp(`stats\\.${tier}`), tier);
  }

  /* The years are self-declared in every case, so the label carries no condition at all —
     no x-show, no expression, nothing that could switch it off on the profile with the least
     behind it. It stays its own element rather than being folded into the text beside it
     because "(tự khai)" is a dictionary entry of its own, and the i18n scanner reads text
     nodes. */
  assert.match(profileHtml, /<span x-text="staff\.years_experience \+ ' năm kinh nghiệm'"><\/span><span> \(tự khai\)<\/span>/);
  // Nothing anywhere still gates it on the stats block or on a start date.
  assert.doesNotMatch(profileHtml, /x-show="[^"]*"> \(tự khai\)</);
});

test('the technician reads their own numbers, and a row without them shows no card', async () => {
  const NOTHING_YET = {
    verified_count: 0, walkin_count: 0, unattested_count: 0, legacy_count: 0,
    distinct_customers: 0, review_count: 0, rating_avg: 0,
    started_at: null, months_active: null,
  };
  const page = schedulePage([
    { staff_id: 7, salon: { id: 4, name: 'Lala', slug: 'lala' }, stats: COUNTED },
    { staff_id: 9, salon: { id: 5, name: 'Mộc', slug: 'moc' } },
    // A second salon that hired them last week: the block arrived, and it has nothing in it.
    { staff_id: 11, salon: { id: 6, name: 'Hạ', slug: 'ha' }, stats: NOTHING_YET },
  ]);
  await page.init();

  assert.deepEqual(page.statRows().map((row) => row.staff_id), [7]);
  assert.equal(page.completedTotal(COUNTED), 10);
  assert.equal(page.sinceLabel(COUNTED), 'tại salon từ 02/2026');
  // A row with no completed visit and no date of its own names no month.
  assert.equal(page.sinceLabel({ started_at: null }), '');

  /* One completed visit is enough to bring the card back whole, bold zero and all — the same
     rule the public profile applies, so the two pages appear and disappear together. */
  const started = schedulePage([
    { staff_id: 11, salon: { id: 6, name: 'Hạ', slug: 'ha' }, stats: { ...NOTHING_YET, walkin_count: 1 } },
  ]);
  await started.init();
  assert.deepEqual(started.statRows().map((row) => row.staff_id), [11]);
  assert.match(scheduleHtml, /x-text="row\.stats\.distinct_customers \+ ' khách khác nhau'"/);

  // And with every claimed row empty, x-show on the section takes the heading with it rather
  // than leaving a titled panel over nothing.
  const none = schedulePage([
    { staff_id: 11, salon: { id: 6, name: 'Hạ', slug: 'ha' }, stats: NOTHING_YET },
  ]);
  await none.init();
  assert.equal(none.statRows().length, 0);
  assert.match(scheduleHtml, /<section class="mb-8" x-cloak="" x-show="statRows\(\)\.length">/);
});

test('the two pages say the same thing about the same figures, word for word', () => {
  /* lib/staff-stats.js computes these once so the page a customer reads and the page the
     technician reads cannot disagree about one person. Two copies of the markup can still
     drift apart in their wording, which is that same failure one layer up. */
  const phrases = [
    "' lượt hoàn thành'",
    "' khách khác nhau'",
    "' từ '",
    "' đánh giá'",
    "'trong đó '",
    "' lượt do khách đặt và đã xác thực'",
    "' lượt khách tại quầy'",
    "' lượt hệ thống tự đóng'",
    "' lượt trước hệ thống xác thực'",
    "'tại salon từ '",
  ];
  for (const phrase of phrases) {
    assert.ok(profileHtml.includes(phrase), `ho-so-chuyen-gia.html: ${phrase}`);
    assert.ok(scheduleHtml.includes(phrase), `lich-cua-toi.html: ${phrase}`);
  }

  // The technician's card names what it is and what "verified" is counted from, in words
  // somebody who never read the schema can act on.
  assert.match(scheduleHtml, /<h2[^>]*>Số liệu của bạn \(như khách thấy\)<\/h2>/);
  assert.match(scheduleHtml, /Số "đã xác thực" đếm từ lượt khách tự đặt và hoàn tất/);

  // And it stays a reading, not a console: there is nothing in it to press.
  const card = scheduleHtml.slice(
    scheduleHtml.indexOf('x-show="statRows().length"'),
    scheduleHtml.indexOf('<template x-if="!loading'),
  );
  assert.ok(card.length > 0, 'the numbers card has moved');
  assert.doesNotMatch(card, /<button|@click/);
});

test('the console hands a refusal on in the words the server refused it in', () => {
  /* Two refusals reach this page for the first time with this slice: finishing a booking
     before it has begun, and moving a completed one off a roster row somebody stands
     behind. Both are 409s carrying a Vietnamese sentence that says which it was, and both
     arrive on paths the console already had — so what has to hold is that neither path
     replaces that sentence with a house apology. */
  assert.match(partnerSource, /'Chỉ có thể hoàn tất lịch hẹn sau giờ hẹn\.'/);
  assert.match(
    partnerSource,
    /'Không thể đổi kỹ thuật viên của lịch hẹn đã hoàn tất: việc này ảnh hưởng hồ sơ đã xác thực của kỹ thuật viên\.'/,
  );

  // OAK.api carries the envelope's own message onto the Error it throws.
  assert.match(apiJs, /envelope\.code \|\| 'UNKNOWN_ERROR',\s*envelope\.message \|\|/);

  // The status buttons put that message straight into the toast…
  const setStatus = handler(consoleHtml, 'async setStatus(status) {', 'canSet(status) {');
  assert.match(setStatus, /catch \(error\) \{\s*OAK\.toast\(error\.message, 'error'\);/);
  // …and the edit form — the only place in the console a booking changes technician — puts
  // it in front of the caret instead, where a refused save is being read.
  const submit = handler(consoleHtml, 'async submitBooking() {', 'showFormError(message) {');
  assert.match(submit, /catch \(error\) \{\s*this\.showFormError\(error\.message\);/);
  assert.doesNotMatch(consoleHtml, /Có lỗi xảy ra/);

  /* The early-finish refusal is one a partner can actually walk into: "Không đến" is gated
     on the clock by canMarkNoShow(), and "Hoàn tất" deliberately is not — the transition
     table is all that stands in front of it. */
  assert.match(
    consoleHtml,
    /@click="setStatus\('completed'\)"[^>]*x-show="canSet\('completed'\)"/,
  );
});

// -------------------------------------------------- who owns which half of a roster row

test('the technician writes exactly four columns, and an unknown key is refused', () => {
  /* The four are the personal half of the row. Everything a salon runs on — the name on the
     roster, the title, the specialty, whether the stint is open — is deliberately absent, and
     asserting the map is exactly these four is what keeps it that way as the form grows. */
  const columns = handler(staffMeSource, 'const PROFILE_COLUMNS = {', '};');
  const named = [...columns.matchAll(/^ {2}([a-z_]+): /gm)].map((match) => match[1]);
  assert.deepEqual(named.sort(), ['bio', 'image', 'portfolio', 'profile_hidden']);
  for (const owned of ['name', 'title', 'specialty', 'active']) {
    assert.doesNotMatch(columns, new RegExp(`\\b${owned}:`), owned);
  }

  /* And an unrecognised key is a 400 rather than a silent drop, which is the one place this
     endpoint deliberately parts company with buildPatch in routes/partner.js: that one walks
     its whitelist and ignores the rest, and a technician who posted `name`, got a 200 and
     believed they had renamed themselves would be left arguing with their own page. */
  const patch = handler(staffMeSource, "router.patch('/profile'", 'const selectMyStaffReviews');
  assert.match(
    patch,
    /if \(!Object\.hasOwn\(PROFILE_COLUMNS, key\)\) \{\s*throw httpError\(400, 'VALIDATION_ERROR', NOT_YOURS\);/,
  );
  assert.doesNotMatch(staffMeSource, /buildPatch\(/);
  // The refusal says who owns the rest, rather than only that the caller may not have it.
  assert.match(staffMeSource, /Tên, chức danh, chuyên môn và lịch làm việc do salon quản lý\./);
  // An empty body is the house's own words for it, not a fifth wording of the same thing.
  assert.match(patch, /'VALIDATION_ERROR', 'Không có thông tin nào để cập nhật\.'/);

  /* Scoped by user_id in the UPDATE itself and not merely by the read above it: between
     proving the row is theirs and writing to it there is no window at all. The read answers
     404 rather than 403 for the same reason ownedRow does — a 403 would confirm the id. */
  assert.match(
    patch,
    /UPDATE staff SET \$\{assignments\.join\(', '\)\} WHERE id = \? AND user_id = \?/,
  );
  assert.match(patch, /if \(!row\) \{\s*throw httpError\(404, 'NOT_FOUND'/);
  assert.match(staffMeSource, /WHERE st\.id = \? AND st\.user_id = \?/);

  /* The portfolio strings come back out of the column into public <img> bindings, so every
     entry goes through the same guard the avatar does — an array of plain strings would let
     one 'javascript:…' through in a list of twelve. */
  const portfolio = declaration(staffMeSource, 'function requireMediaUrlArray(');
  assert.match(portfolio, /if \(!isSafeMediaUrl\(url\)\) \{/);
  assert.match(portfolio, /'Đường dẫn ảnh không hợp lệ\.'/);
  assert.match(portfolio, /JSON\.stringify\(urls\)/);
  assert.match(declaration(staffMeSource, 'function optionalMediaUrl('), /isSafeMediaUrl/);

  /* Blank entries are dropped before anything else looks at them. isSafeMediaUrl calls an
     empty value safe — correct for a nullable column, where empty is how the field is cleared,
     and wrong for an array element, where it is an unfilled form row that reaches the profile
     as <img src="">. The ceiling then counts what will actually be stored. */
  assert.match(portfolio, /\.filter\(\(url\) => url !== ''\)/);
  assert.match(portfolio, /if \(urls\.length > PORTFOLIO_MAX\)/);
  assert.ok(portfolio.indexOf(".filter((url) => url !== '')") < portfolio.indexOf('urls.length > PORTFOLIO_MAX'));
});

test("the avatar on a claimed row stops being the owner's, in exactly these words", () => {
  const patch = handler(partnerSource, "router.patch('/staff/:id'", "router.delete('/staff/:id'");
  // Pinned byte for byte: the console puts the server's own sentence in front of the caret,
  // so this string is the whole of what an owner is told about why the save was refused.
  assert.match(
    patch,
    /throw httpError\(409, 'CONFLICT', 'Ảnh đại diện do kỹ thuật viên tự quản lý\.'\);/,
  );
  // Only on a row somebody stands behind, and only for `image`. An unclaimed row is the
  // salon's own description of a chair and stays entirely theirs.
  assert.match(
    patch,
    /if \(staff\.user_id != null && Object\.hasOwn\(req\.body \?\? \{\}, 'image'\)\)/,
  );

  /* And only when the value actually CHANGED — the same rule this file's customer notices are
     gated on, because quan-ly-nhan-vien.html posts name, title, specialty and image on every
     save and awaits this PATCH before the schedule and services PUTs. Refusing on the presence
     of the key would make a claimed technician's title, hours and service list unsaveable, so
     the boundary would read as a frozen roster. Compared through the column's own parser, so
     the '' an empty photo field sends and the NULL the column holds are the same value. */
  assert.match(patch, /const wanted = STAFF_COLUMNS\.image\(req\.body\.image\);/);
  assert.match(patch, /if \(wanted !== \(staff\.image \?\? null\)\) \{/);
  // Refused before the patch is built, so a body carrying `image` alongside `name` writes
  // neither half rather than half of it.
  assert.ok(patch.indexOf('Ảnh đại diện do kỹ thuật viên') < patch.indexOf('buildPatch'));

  /* The other two personal columns need no guard because they were never on the owner's map
     to begin with — asserting their absence is what keeps a later edit from adding them back
     and quietly handing the bio to the console. name/title/specialty/active stay: the owner
     runs the roster. */
  const columns = handler(partnerSource, 'const STAFF_COLUMNS = {', '};');
  assert.doesNotMatch(columns, /\bbio\b/);
  assert.doesNotMatch(columns, /\bportfolio\b/);
  for (const owned of ['name', 'title', 'specialty', 'image', 'active']) {
    assert.match(columns, new RegExp(`^ {2}${owned}: `, 'm'), owned);
  }
});

test('a hidden profile is always a CLAIMED hidden profile, never a bare flag', () => {
  /* An unclaimed row carrying profile_hidden = 1 is only reachable by direct SQL, and it must
     behave exactly as it does today: nobody stands behind it, so nobody has withdrawn
     anything from it. A bare `hidden` test anywhere would let a stray column value take a
     salon's own roster entry off its page, which is a deletion nobody asked for. */
  for (const [name, text] of STAFF_READERS) {
    assert.doesNotMatch(text, /profile_hidden\s*(?:=|<>|!=)\s*1/, name);
  }
  // Both halves of the predicate, spelled the same way in both places that carry it. COALESCE
  // because the column was added to a table that already had rows: an unwritten value is 0,
  // not a reason to disappear.
  assert.match(
    staffSource,
    /const VISIBLE_PROFILE =\s*'\(st\.user_id IS NULL OR COALESCE\(st\.profile_hidden, 0\) = 0\)';/,
  );
  assert.match(salonsSource, /AND \(user_id IS NULL OR COALESCE\(profile_hidden, 0\) = 0\)/);

  // Added like any other column, once, unconditionally, and no sweep writes it: hiding a
  // profile is an act by the person behind the row and never something a boot decides.
  assert.match(
    dbSource,
    /^ALTER TABLE staff ADD COLUMN IF NOT EXISTS profile_hidden INTEGER DEFAULT 0;$/m,
  );
  assert.equal((dbSource.match(/ADD COLUMN IF NOT EXISTS profile_hidden/g) || []).length, 1);
  assert.doesNotMatch(dbSource, /SET profile_hidden/);
});

test('the withdrawal hides the page and never the working day', () => {
  /* The public profile and its own review list are the page; both refuse a hidden row, and
     both refuse it in the words an id naming nobody already got. Two statements rather than
     one shared resolver, because the other two reads in this file resolve through the same
     path and must NOT ask the question.

     The roster half of the gate is CLAIMED_OR_ON_ROSTER, not active = 1: a chair the salon
     retired takes its page with it, while a CLAIMED row that has been closed is a technician
     between salons, and 404 on the one page carrying her work would delete her working life
     on the day she left. Both statements ask it, so the reviews cannot outlive the profile or
     fall off one that is still standing. */
  assert.match(
    staffSource,
    /const CLAIMED_OR_ON_ROSTER = '\(st\.user_id IS NOT NULL OR st\.active = 1\)';/,
  );
  assert.match(
    staffSource,
    /WHERE st\.id = \? AND \$\{CLAIMED_OR_ON_ROSTER\} AND \$\{VISIBLE_PROFILE\}/,
  );
  assert.match(
    staffSource,
    /const selectVisibleStaffExists = db\.prepare\(\s*`SELECT 1 FROM staff st WHERE st\.id = \? AND \$\{CLAIMED_OR_ON_ROSTER\} AND \$\{VISIBLE_PROFILE\}`,/,
  );
  assert.match(
    staffSource,
    /router\.get\('\/:id\/reviews'[\s\S]{0,400}?await visibleStaffIdOrThrow\(req\.params\.id\)/,
  );
  const detail = handler(staffSource, "router.get('/:id',", 'export default router');
  assert.match(detail, /'NOT_FOUND', 'Không tìm thấy kỹ thuật viên này\.'/);

  /* Operational, and gated on nothing: the day strip and the service list of one technician.
     Somebody who has taken their page down is still at work today, still on the calendar, and
     still owed the appointments the salon has already put on it. */
  assert.match(
    staffSource,
    /const selectStaffExists = db\.prepare\('SELECT 1 FROM staff WHERE id = \? AND active = 1'\);/,
  );
  for (const route of ['/:id/availability', '/:id/services']) {
    const read = handler(staffSource, `router.get('${route}'`, '});');
    assert.match(read, /staffIdOrThrow\(req\.params\.id\)/, route);
    assert.doesNotMatch(read, /visibleStaffIdOrThrow/, route);
  }

  /* The booking wizard's technician picker, for the same reason: dropping a technician out of
     it would quietly take a salon's chair off sale.

     Pinned by what the query IS rather than by what it does not say. A `doesNotMatch` on the
     flag reads as a guard and is not one: a predicate can sit in the JOIN as easily as in the
     WHERE, and no assertion over the SQL at all can see a `rows.filter(...)` dropping the row
     in the route afterwards. So the whole shape of the query is spelled out here, and the
     route is pinned as a straight map with no filter in it. */
  const picker = handler(servicesSource, 'const selectServiceStaff', '`);')
    .replace(/\s+/g, ' ')
    .trim();
  assert.equal(
    picker,
    'const selectServiceStaff = db.prepare(` SELECT st.id, st.name, st.title, st.specialty, ' +
      'st.image, st.rating, st.years_experience, st.user_id, st.profile_hidden ' +
      'FROM staff st JOIN staff_services ss ON ss.staff_id = st.id ' +
      'WHERE ss.service_id = ? AND st.active = 1 ORDER BY st.rating DESC, st.id',
  );
  const pickerRoute = handler(servicesSource, "router.get('/:id/staff'", '});');
  assert.match(pickerRoute, /data: rows\.map\(pickerCard\)/);
  assert.doesNotMatch(pickerRoute, /\.filter\(/);

  /* Claimed rows only, the standing rule: nobody stands behind an unclaimed row, so nobody has
     withdrawn anything from it. Everything the public profile shows off is dropped; id and
     name stay, because a customer who asks for her by name must still be able to pick her. */
  const card = declaration(servicesSource, 'function pickerCard(');
  assert.match(card, /const withdrawn = row\.user_id !== null && Boolean\(row\.profile_hidden\);/);
  for (const shown of ['title', 'specialty', 'image', 'rating', 'years_experience']) {
    assert.match(card, new RegExp(`\\b${shown}: withdrawn \\? null : row\\.${shown},`), shown);
  }
  assert.match(card, /^ {4}id: row\.id,\s*\n\s*name: row\.name,/m);
  // The account column is asked about and never answered with.
  assert.doesNotMatch(card, /user_id:/);
  /* What every card does carry, withdrawn or not: whether a real account stands behind the
     chair. It is the one fact the reduction must NOT take away — the ✓ chip marks a person
     who signed in and claimed the row, and hiding a page is not ceasing to be that person. */
  assert.match(card, /claimed: row\.user_id !== null,/);
  assert.doesNotMatch(card, /claimed: withdrawn/);

  /* The console is the salon's own operational view of its roster, so a withdrawn technician
     is still on it — the owner has a day to run and a person to run it with. Unchanged, and
     pinned as unchanged. */
  assert.match(
    partnerSource,
    /const selectSalonStaff = db\.prepare\('SELECT \* FROM staff WHERE salon_id = \? ORDER BY id'\);/,
  );
  assert.doesNotMatch(partnerSource, /profile_hidden/);

  /* And the technician's own reads never hide their own row from them: they have to be able
     to see the switch they just threw, and to throw it back. */
  assert.match(staffMeSource, /st\.profile_hidden, st\.active, st\.claimed_at,/);
  assert.doesNotMatch(staffMeSource, /profile_hidden\s*(?:=|IS)/);
});

test("a 'staff' notification can only be written by notifyStaff", () => {
  // One definition of the type, in the one function that uses it. It is the routing key
  // ui/thong-bao.html maps a row by, and every other type in that map opens a customer page.
  assert.match(notifySource, /const STAFF_NOTIFICATION_TYPE = 'staff';/);
  assert.equal((notifySource.match(/'staff'/g) || []).length, 1);

  /* The account is resolved off the roster row, on the caller's own transaction, rather than
     being passed in: "claimed rows only" then lives in exactly one place, and no call site
     can aim a technician's notice at an account of its own choosing. */
  const notifyStaff = declaration(notifySource, 'export async function notifyStaff(');
  assert.match(
    notifyStaff,
    /export async function notifyStaff\(tx, staffId, title, body, bookingId = null\)/,
  );
  assert.match(
    notifySource,
    /const SELECT_STAFF_ACCOUNT = 'SELECT user_id FROM staff WHERE id = \?';/,
  );
  assert.match(notifyStaff, /const staff = await tx\.get\(SELECT_STAFF_ACCOUNT, staffId\);/);
  // A booking with no technician, an id naming no row, and a row nobody has claimed all
  // no-op — the same reasoning as notifyUser's null-user no-op, in the same place.
  assert.match(notifyStaff, /if \(staffId === null \|\| staffId === undefined\) \{\s*return;/);
  assert.match(notifyStaff, /staff\?\.user_id \?\? null,/);
  assert.match(notifyStaff, /STAFF_NOTIFICATION_TYPE,/);
  // Through notifyUser, so there is still exactly one INSERT into the table in the codebase.
  for (const [name, text] of STAFF_READERS) {
    if (name !== 'lib/notify.js') {
      assert.doesNotMatch(text, /INSERT INTO notifications/, name);
    }
  }

  // And no caller anywhere writes that type by hand through notifyUser, which is the one way
  // a technician's routing key could end up on a customer's row or the other way about.
  for (const [name, text] of STAFF_READERS) {
    for (const call of calls(text, 'notifyUser')) {
      assert.ok(!call.includes("'staff'"), `${name}: notifyUser must not be handed the staff type`);
    }
  }
});

test('the nine things a technician is told about, each written once and in a transaction', () => {
  /* Every notice rides the transaction that made the change it announces, so a booking that
     rolled back cannot leave a technician looking at an appointment nobody has. The count per
     file is the "exactly once per event" half: a second call anywhere is a second bell. Eleven
     call sites for nine triggers, because the reassignment is two events in one save — one
     technician loses the hour and another gains it. The three newest are the departure itself,
     told to the technician whose stint the console just closed, the hour a colleague inherits
     from it, and the departure being taken back: a row that went from "đã nghỉ" to working
     again without a word would leave her to find it out from her own profile. */
  const sites = [
    ['routes/bookings.js', bookingsSource, 2],
    ['routes/partner.js', partnerSource, 7],
    ['routes/reviews.js', reviewsSource, 1],
    ['lib/staff-departure.js', departureSource, 1],
  ];
  for (const [name, text, expected] of sites) {
    const found = calls(text, 'notifyStaff');
    assert.equal(found.length, expected, name);
    for (const call of found) {
      assert.match(call, /^notifyStaff\(\s*tx,/, `${name}: ${call.slice(0, 40)}`);
    }
  }

  /* The customer booking: the technician actually assigned, which covers "Bất kỳ" as well as
     an explicit choice — the customer named nobody, but somebody is expected at that hour. */
  const created = handler(bookingsSource, 'const assigned =', 'catch (error) {');
  assert.match(created, /await notifyStaff\(\s*tx,\s*assigned,/);
  assert.doesNotMatch(created, /notifyStaff\(\s*tx,\s*staffId,/);

  /* The reassignment tells both ends and gates on `restaffed`, which is `movable`-gated: a
     cancelled or completed row moved between two names is a correction to the record and not
     news for anybody's day. Cancelling wins over it, and it wins over the move, so one save
     cannot ring twice. */
  const patch = handler(
    partnerSource,
    "router.patch('/bookings/:id'",
    'Free hours, and the customer',
  );
  assert.match(
    patch,
    /const staffCancelled = Object\.hasOwn\(patch, 'status'\) && patch\.status === 'cancelled';/,
  );
  assert.match(patch, /if \(staffCancelled\) \{[\s\S]*?\} else if \(restaffed\) \{/);
  /* And the move last of the three. The reassignment pair already carry the NEW hour in their
     own sentences, so a save that moves the hour AND swaps the chair is fully told by them;
     "and it moved" on top would be one save ringing twice. The move is therefore the branch
     for the technician who is STAYING, and it names the hour she is now expected at. */
  assert.match(patch, /\} else if \(restaffed\) \{[\s\S]*?\} else if \(moved\) \{/);
  /* A move is a new date, a new time, or both, so the title says neither: 'đã đổi giờ' on a
     save that shifted only the day would be the notice contradicting its own body. Worded
     like its sibling three branches up, which had the same problem to solve. */
  assert.match(
    patch,
    /await notifyStaff\(\s*tx,\s*booking\.staff_id,\s*'Một lịch hẹn đã được dời',/,
  );
  assert.match(patch, /đã dời lịch hẹn \$\{updated\.code\} sang \$\{when\}/);
  assert.match(patch, /await notifyStaff\(\s*tx,\s*booking\.staff_id,/);
  assert.match(
    patch,
    /await notifyStaff\(\s*tx,\s*patch\.staff_id,\s*'Lịch hẹn mới trên lịch của bạn',/,
  );
  /* staff_id is nullable, so the departing side has two cases: the console can clear a booking
     back to "Bất kỳ", which takes the hour off somebody without giving it to anybody. Told it
     went "sang một kỹ thuật viên khác" they would go looking for a colleague who does not
     exist, and nothing would correct it — the arriving call no-ops on a null. */
  assert.match(patch, /patch\.staff_id === null\s*\? 'Lịch hẹn đã gỡ khỏi lịch của bạn'/);
  assert.match(patch, /đã gỡ lịch hẹn \$\{updated\.code\} \$\{when\} khỏi lịch của bạn/);
  /* 'cancelled' and nothing else. Not 'completed' and not 'no_show': both of those are the
     counter writing down what the technician was standing there for, and a bell for every
     appointment somebody finished is a bell nobody reads. */
  for (const closed of ['completed', 'no_show']) {
    assert.doesNotMatch(patch, new RegExp(`patch\\.status === '${closed}'`), closed);
  }
  /* One read of the row for every sentence, so the customer and the technicians are told about
     the same hour. `moved` is on the gate in its own right rather than left to the `notification`
     it usually implies: a save carrying a status AND a new date takes `notification` from the
     status, and the branch below would then depend on a coincidence to be reached at all. */
  assert.match(
    patch,
    /if \(notification \|\| staffCancelled \|\| restaffed \|\| moved\) \{\s*const updated = await tx\.get\(/,
  );

  // The walk-in, and the customer's own cancellation, on the row each of them is about.
  const walkIn = handler(partnerSource, "router.post('/bookings'", "router.get('/bookings/:id'");
  assert.match(walkIn, /await notifyStaff\(\s*tx,\s*staffId,/);
  const cancel = handler(bookingsSource, "router.patch('/:id/cancel'", 'export default router');
  assert.match(cancel, /await notifyStaff\(\s*tx,\s*booking\.staff_id,/);

  // And the review, inside the transaction that writes the review itself.
  const review = handler(reviewsSource, 'id = await db.withTransaction', 'catch (error) {');
  assert.match(review, /await notifyStaff\(\s*tx,\s*booking\.staff_id,/);
  assert.match(review, /Khách đã đánh giá \$\{rating\} sao cho lịch hẹn/);
});

test('the unread badge already counts these, and gains nothing new', () => {
  /* GET /api/notifications?count_only=true has answered {unread_count} since the bell existed,
     and assets/js/oak-api.js reads exactly that. A technician's rows are notifications like
     any other, so a second count beside it would be a number that can disagree with itself. */
  const notificationsSource = source('routes', 'notifications.js');
  assert.match(
    notificationsSource,
    /if \(req\.query\.count_only === 'true'\) \{\s*res\.json\(\{\s*success: true,\s*data: \{ unread_count: \(await selectUnreadCount\.get\(req\.user\.id\)\)\.count \},/,
  );
  assert.doesNotMatch(notificationsSource, /meta: \{[^}]*unread/);
  assert.match(apiJs, /count_only=true/);
});

// ------------------------------------------- the page the technician owns their half from

/**
 * oakStaffMe() over a stand-in browser, with every write it sends recorded.
 *
 * `sent` is the whole point of the harness: PATCH /api/staff-me/profile refuses an
 * unrecognised key with a 400, so what has to hold is not what the markup looks like but
 * what the form actually posts — which is only visible by driving it.
 */
function profilePage({
  profiles = [], reviews = [], unread = 0, patchError = null, reviewsFail = null,
  today = '2026-08-28', tenureReply = null, tenureError = null,
  leaveReply = { reassigned: 0, needs_attention: 0 }, leaveError = null,
  /* How many reads of the roster succeed before the rest throw. The departure reloads the
     list, and the ordering inside confirmLeave() turns on what a failed reload does. */
  profileReadsBeforeFailing = null,
} = {}) {
  const tail = profileMeHtml.slice(profileMeHtml.indexOf('const OAK_PORTFOLIO_MAX'));
  const sent = [];
  /* The attestations and the departure are kept out of `sent`, which the four-columns sweep
     above reads as "every PATCH /profile this form made". They go through their own
     endpoints and post keys PATCH /profile would refuse, so counting them there would be
     counting a different question. */
  const posted = [];
  const asked = [];
  const toasts = [];
  let profileReads = 0;
  const context = {
    // The upload path reads the file before it posts it; nothing here cares what it read.
    FileReader: class {
      readAsDataURL(file) {
        this.result = `data:image/webp;base64,${file.name}`;
        this.onload();
      }
    },
    OAK: {
      requireStaff: async () => {
        asked.push('requireStaff');
        return { name: 'KTV Số Liệu' };
      },
      toast: (message, type) => toasts.push([message, type]),
      fmtDate: (value) => value,
      fmtRange: (from, to) => `${from} – ${to}`,
      todayISO: () => today,
      api: async (endpoint, options) => {
        asked.push(endpoint);
        if (endpoint.startsWith('/api/notifications')) {
          return { unread_count: unread };
        }
        if (endpoint.startsWith('/api/staff-me/tenure/')) {
          posted.push({ endpoint, method: options.method, body: options.body });
          if (tenureError) {
            throw new Error(tenureError);
          }
          // The server answers an attestation with the whole row as it now stands, exactly
          // as PATCH /profile does, so the page can swap it straight into the list.
          return tenureReply;
        }
        if (endpoint === '/api/staff-me/leave') {
          posted.push({ endpoint, method: options.method, body: options.body });
          if (leaveError) {
            throw new Error(leaveError);
          }
          // This one answers with the sweep and not the row, which is why the page re-reads.
          return leaveReply;
        }
        if (endpoint.startsWith('/api/staff-me/reviews')) {
          if (reviewsFail) {
            throw new Error(reviewsFail);
          }
          return reviews;
        }
        if (endpoint === '/api/uploads') {
          return { url: UPLOADED };
        }
        if (endpoint === '/api/staff-me/profile') {
          if (!options) {
            profileReads += 1;
            if (profileReadsBeforeFailing !== null
                && profileReads > profileReadsBeforeFailing) {
              throw new Error('Không tải được hồ sơ.');
            }
            return profiles;
          }
          sent.push(options.body);
          if (patchError) {
            throw new Error(patchError);
          }
          // The server answers with the whole row as it now stands, so the page can read
          // back what it just wrote.
          const row = profiles.find((entry) => entry.staff_id === options.body.staff_id);
          return Object.assign({}, row, options.body);
        }
        return assert.fail(`unexpected call: ${endpoint}`);
      },
    },
  };
  vm.runInNewContext(
    `${tail.slice(0, tail.indexOf('</script>'))}\nresult = oakStaffMe();`,
    context,
  );
  return Object.assign(context.result, { sent, posted, asked, toasts });
}

const UPLOADED = 'uploads/moi.webp';

/** What a file picker hands a change handler, and what it hands back after the pick. */
function pickFile(name) {
  return { target: { files: [{ name, size: 1024 }], value: name } };
}

const CLAIMED_ROW = {
  staff_id: 7,
  salon: { id: 4, name: 'Lala', slug: 'lala' },
  name: 'Phương Vy',
  title: 'KTV chính',
  specialty: 'Nail nghệ thuật',
  bio: null,
  image: null,
  portfolio: ['uploads/cu.webp'],
  profile_hidden: 0,
  active: 1,
  /* The stint claimedRowShape() nests on every row it sends. Carried on the fixture rather
     than bolted on per test: the stint card reads row().stint unconditionally, so a row
     without one is not a row GET /api/staff-me/profile can answer with. */
  stint: {
    started_at: '2024-01-05',
    left_at: null,
    left_by: null,
    started_confirmed: false,
    left_confirmed: false,
    tenure_disputed: 0,
  },
};

/** CLAIMED_ROW with one or both ends of its stint overwritten. */
const withStint = (stint, row = CLAIMED_ROW) => ({
  ...row,
  stint: { ...row.stint, ...stint },
});

test('the profile page stands behind the same gate, and names the same way back in', () => {
  // requireStaff, not requireLogin: a customer who guessed the URL would otherwise reach a
  // form whose every request answers 403.
  assert.match(profileMeHtml, /this\.user = await OAK\.requireStaff\(\);/);
  // And the sign-out link names the technician's login, which is what requireStaff bounces
  // to — the same pair lich-cua-toi.html carries.
  for (const [name, html] of [['ho-so-nhan-vien.html', profileMeHtml], ['lich-cua-toi.html', scheduleHtml]]) {
    assert.match(html, /data-oak-logout href="dang-nhap-nhan-vien\.html"/, name);
  }
  assert.match(apiJs, /var STAFF_LOGIN_PAGE = 'dang-nhap-nhan-vien\.html';/);
});

test('every write the profile form sends is staff_id plus the four columns it owns', async () => {
  const page = profilePage({ profiles: [CLAIMED_ROW] });
  await page.init();
  assert.ok(page.asked.includes('requireStaff'), 'the page drew itself without asking who it is');

  // Every control on the page, once each.
  page.bio = 'Mười năm làm nail';
  await page.saveBio();
  page.hidden = true;
  await page.saveHidden();
  await page.uploadAvatar(pickFile('daidien.webp'));
  await page.addPhoto(pickFile('tacpham.webp'));
  await page.removePhoto('uploads/cu.webp');

  /* Read off the bodies actually posted rather than off the markup: PATCH /profile answers
     an unrecognised key with a 400 rather than dropping it, so what matters is what the form
     posts and not what it looks like.

     The whitelist is parsed out of the route rather than restated here — the same parse the
     "writes exactly four columns" case above makes — so the page is measured against the
     server's real map and not against a copy of it that can go stale. */
  const OWNED = [...handler(staffMeSource, 'const PROFILE_COLUMNS = {', '};')
    .matchAll(/^ {2}([a-z_]+): /gm)].map((hit) => hit[1]).sort();
  assert.equal(OWNED.length, 4, 'PROFILE_COLUMNS has moved');
  assert.equal(page.sent.length, 5);
  const written = [];
  for (const body of page.sent) {
    assert.equal(body.staff_id, CLAIMED_ROW.staff_id);
    const fields = Object.keys(body).filter((key) => key !== 'staff_id');
    assert.ok(fields.length > 0, 'a PATCH with nothing but a staff_id is a 400');
    for (const key of fields) {
      assert.ok(OWNED.includes(key), `${key} is the salon's, not the technician's`);
    }
    written.push(...fields);
  }
  // …and all four are genuinely exercised, so the sweep above ran over a whole form.
  assert.deepEqual([...new Set(written)].sort(), OWNED);

  // The two picture writes send the list as it will be, because the column is one JSON array.
  assert.deepEqual(page.sent[3].portfolio, ['uploads/cu.webp', UPLOADED]);
  assert.deepEqual(page.sent[4].portfolio, [UPLOADED]);

  /* The drive above is only ever as complete as the list of controls it knows to press, so
     the page's own call sites are read beside it: a sixth writer, or one naming a column the
     server does not hand over, fails here even though nothing above would think to press it.
     Both sides of this come out of source — the call sites from the page, the whitelist from
     the route — so neither can be quietly widened to fit the other. */
  const sites = [...profileMeHtml.matchAll(/this\.patch\(\w+, \{\s*(\w+):/g)].map((hit) => hit[1]);
  assert.equal(
    sites.length,
    (profileMeHtml.match(/this\.patch\(/g) || []).length,
    'a patch() call site is written in a shape this scan cannot read',
  );
  assert.equal(sites.length, page.sent.length, 'a write on the page that the drive never presses');
  for (const key of new Set(sites)) {
    assert.ok(OWNED.includes(key), `the page writes ${key}, which PATCH /profile refuses`);
  }
});

test('the withdrawal switch says all four things it does, and undoes itself on a refusal', async () => {
  const consent = handler(profileMeHtml, '>Hiển thị công khai</h2>', '</section>');
  // The promise Slice 1 made when the row was claimed, spelled out where it is thrown.
  assert.match(consent, /trang hồ sơ công khai của bạn không còn mở được/);
  assert.match(consent, /thẻ của bạn không còn hiện trên trang salon/);
  assert.match(consent, /Lịch hẹn của bạn và trang quản lý của salon vẫn chạy bình thường/);
  assert.match(consent, /Bạn tắt lại lúc nào cũng được/);
  // The box IS the state, so putting the state back puts the box back with it.
  assert.match(consent, /@change="saveHidden\(\)"[^>]*x-model="hidden"/);

  const page = profilePage({ profiles: [CLAIMED_ROW], patchError: 'Không lưu được.' });
  await page.init();
  assert.equal(page.hidden, false);

  page.hidden = true;
  await page.saveHidden();

  // Never a box claiming a state the server refused.
  assert.equal(page.hidden, false);
  assert.equal(page.hiddenError, 'Không lưu được.');
});

test('the gallery closes at the ceiling the server enforces, not at a number typed twice', async () => {
  // Read out of the route rather than written here: two copies of "12" is exactly how the
  // page comes to offer a thirteenth upload the save then throws away.
  const cap = Number(staffMeSource.match(/const PORTFOLIO_MAX = (\d+);/)[1]);
  assert.ok(cap > 0, 'PORTFOLIO_MAX has moved');

  const full = Array.from({ length: cap }, (value, index) => `uploads/${index}.webp`);
  const page = profilePage({ profiles: [{ ...CLAIMED_ROW, portfolio: full }] });
  await page.init();
  assert.equal(page.portfolioMax, cap);
  assert.equal(page.atPortfolioCap(), true);

  // One short of it and the control is open again.
  const room = profilePage({ profiles: [{ ...CLAIMED_ROW, portfolio: full.slice(1) }] });
  await room.init();
  assert.equal(room.atPortfolioCap(), false);

  // And that is what the add control is actually disabled on.
  assert.match(profileMeHtml, /:disabled="portfolioBusy \|\| atPortfolioCap\(\)"/);
});

test('the rail badge appears on a count and nowhere else, on both staff pages', async () => {
  for (const build of [profilePage, (options) => schedulePage([CLAIMED_ROW], options)]) {
    /* Driven directly rather than read off the state after init(): the badge must not hold
       the page's own reads up, so init() starts the count and does not await it — and a test
       that asserts on it afterwards is asserting on microtask ordering. */
    const quiet = build({ profiles: [CLAIMED_ROW], unread: 0 });
    await quiet.init();
    await quiet.loadUnread();
    assert.equal(quiet.unread, 0);

    const loud = build({ profiles: [CLAIMED_ROW], unread: 4 });
    await loud.init();
    await loud.loadUnread();
    assert.equal(loud.unread, 4);
  }

  /* One count, the one the bell has always read: {unread_count} out of count_only=true.
     A second number beside it is a number that can disagree with itself. */
  for (const [name, html] of [['ho-so-nhan-vien.html', profileMeHtml], ['lich-cua-toi.html', scheduleHtml]]) {
    assert.match(html, /OAK\.api\('\/api\/notifications\?count_only=true'\)\)\.unread_count/, name);
    // The number is its own node beside an ordinary Vietnamese one, so the dictionary never
    // has to hold a string with a count baked into it.
    assert.match(
      html,
      /<span class="sr-only">Thông báo chưa đọc<\/span> <span x-text="unread"><\/span>/,
      name,
    );
    assert.equal((html.match(/x-show="unread"/g) || []).length, 2, name);
  }
});

test('the technician rail is one rail, in one order, in all four copies of it', () => {
  /* No shared-component mechanism in this repo, so the rail is copied markup — four times
     over two pages. The entries and their order are what must not drift; the marked entry
     is the one thing each copy is allowed to differ on. */
  const RAIL = [
    ['lich-cua-toi.html', 'calendar_month'],
    ['ho-so-nhan-vien.html', 'person'],
    ['thong-bao.html', 'notifications'],
    ['salonUrl(row)', 'storefront'],
    ['dang-nhap-nhan-vien.html', 'logout'],
  ];

  let copies = 0;
  for (const [page, html] of [['lich-cua-toi.html', scheduleHtml], ['ho-so-nhan-vien.html', profileMeHtml]]) {
    for (const [hook, close] of [['data-oak-staff-nav=""', '</aside>'], ['data-oak-staff-tabs=""', '</nav>']]) {
      const at = html.indexOf(hook);
      assert.notEqual(at, -1, `${page}: no ${hook}`);
      const block = html.slice(at, html.indexOf(close, at));
      copies += 1;

      assert.deepEqual(
        [...block.matchAll(/:?href="([^"]*)"/g)].map((match) => match[1]),
        RAIL.map((entry) => entry[0]),
        `${page} ${hook}`,
      );
      assert.deepEqual(
        [...block.matchAll(/data-icon="([^"]*)"/g)].map((match) => match[1]),
        RAIL.map((entry) => entry[1]),
        `${page} ${hook}`,
      );
      // Exactly one entry is marked, and it is the page the copy sits on.
      assert.deepEqual(
        [...block.matchAll(/<a aria-current="page"[^>]*href="([^"]*)"/g)].map((hit) => hit[1]),
        [page],
        `${page} ${hook}`,
      );
    }
  }
  assert.equal(copies, 4);

  /* Its own hook, never the customer one: [data-oak-account-nav] and its strip are pinned
     byte-identical across the six account pages, and this is a different set of entries. */
  for (const html of [scheduleHtml, profileMeHtml]) {
    assert.doesNotMatch(html, /<(aside|nav)[^>]*data-oak-account-(nav|tabs)/);
  }
});

test("a technician's notice opens the page a technician can act on", () => {
  /* lib/notify.js writes its own type precisely so the bell can route it somewhere other
     than the customer's appointment list, and asks for this entry in so many words. */
  assert.match(notifySource, /const STAFF_NOTIFICATION_TYPE = 'staff';/);
  const links = handler(notificationsHtml, 'var OAK_NOTIFICATION_LINKS = {', '};');
  assert.match(links, /^ {8}staff: 'lich-cua-toi\.html',$/m);

  /* And NOT into the booking types: those resolve through booking_id onto
     xac-nhan-dat-lich.html, which is the customer's own confirmation page. */
  const bookingTypes = handler(notificationsHtml, 'var OAK_NOTIFICATION_BOOKING_TYPES', ';');
  assert.doesNotMatch(bookingTypes, /staff/);
});

test('the rows the rail is drawn from surface their own failure rather than vanishing', async () => {
  /* The bookings list has an error block of its own and still renders, so a profile read
     that failed is a toast rather than a page-wide error state — but it is never silence:
     the rail, the salon chips and the numbers card all come out of these rows. */
  const page = schedulePage([], { profileError: 'Không kết nối được máy chủ.' });
  await page.init();

  assert.equal(page.profiles.length, 0);
  assert.deepEqual(page.toasts, [['Không kết nối được máy chủ.', 'error']]);
  assert.equal(page.error, '', 'the bookings error block was taken over by the profile read');
});

test('each roster row is read and written on its own, reviews included', async () => {
  const second = { ...CLAIMED_ROW, staff_id: 9, salon: { id: 5, name: 'Mộc', slug: 'moc' }, bio: 'Chuyên mi' };
  const page = profilePage({
    profiles: [{ ...CLAIMED_ROW, bio: 'Chuyên nail' }, second],
    reviews: [
      { id: 1, staff_id: 7, rating: 5, comment: 'Rất khéo', created_at: '2026-08-01', salon: { id: 4, name: 'Lala' } },
      { id: 2, staff_id: 9, rating: 4, comment: '', created_at: '2026-08-02', salon: { id: 5, name: 'Mộc' } },
    ],
  });
  await page.init();

  // The first claimed row opens, and everything on the page is about that one row.
  assert.equal(page.selected, 7);
  assert.equal(page.bio, 'Chuyên nail');
  assert.deepEqual(page.reviewRows().map((review) => review.id), [1]);

  // One list arrives for every row they hold, so switching is a filter rather than a fetch.
  const before = page.asked.length;
  page.select(9);
  assert.equal(page.bio, 'Chuyên mi');
  assert.deepEqual(page.reviewRows().map((review) => review.id), [2]);
  assert.equal(page.asked.length, before);

  // And the write that follows names the row now on screen.
  page.bio = 'Chuyên mi và nail';
  await page.saveBio();
  assert.equal(page.sent[0].staff_id, 9);

  // The switcher itself is only drawn for somebody who holds more than one row.
  assert.match(profileMeHtml, /x-cloak="" x-show="profiles\.length > 1"/);
  assert.match(profileMeHtml, /:aria-pressed="row\.staff_id === selected \? 'true' : 'false'"/);
});

test('a bio half typed survives a look at the other salon, and is dropped once it is saved', async () => {
  const second = { ...CLAIMED_ROW, staff_id: 9, salon: { id: 5, name: 'Mộc', slug: 'moc' }, bio: 'Chuyên mi' };
  const page = profilePage({ profiles: [{ ...CLAIMED_ROW, bio: 'Chuyên nail' }, second] });
  await page.init();

  // Checking what the other row says is not a reason to lose a paragraph.
  page.bio = 'Mười năm làm nail, chuyên đắp bột';
  page.select(9);
  assert.equal(page.bio, 'Chuyên mi');
  page.select(7);
  assert.equal(page.bio, 'Mười năm làm nail, chuyên đắp bột');

  /* And once the server has it the stash is dropped, so the row itself is the answer again:
     a draft left behind here would outrank the column on the next read of the list — which
     is exactly what the retry button does. */
  await page.saveBio();
  assert.ok(!(CLAIMED_ROW.staff_id in page.bioDrafts), 'a saved row keeps a draft to outrank it');
  assert.equal(page.row().bio, 'Mười năm làm nail, chuyên đắp bột');
});

test('a picture belongs to the salon it was picked for, not the one on screen when it lands', async () => {
  /* The switcher stays live for the whole upload on purpose — abandoning a file somebody is
     waiting on is the worse trade — so both writers that read a file first have to pin their
     row before the read rather than look it up again when it comes back. */
  const second = {
    ...CLAIMED_ROW,
    staff_id: 9,
    salon: { id: 5, name: 'Mộc', slug: 'moc' },
    portfolio: ['uploads/moc.webp'],
  };
  const page = profilePage({ profiles: [CLAIMED_ROW, second] });
  await page.init();
  assert.equal(page.selected, 7);

  const avatar = page.uploadAvatar(pickFile('cua-lala.webp'));
  page.select(9);
  await avatar;

  const gallery = page.addPhoto(pickFile('cua-moc.webp'));
  page.select(7);
  await gallery;

  assert.deepEqual(page.sent.map((body) => body.staff_id), [7, 9]);
  // …and the gallery write appends to the list of the row it was started on, not the one the
  // switcher happens to be pointing at when the upload lands.
  assert.deepEqual([...page.sent[1].portfolio], ['uploads/moc.webp', UPLOADED]);
});

test('a review list that never arrived leaves the half the technician can edit standing', async () => {
  const page = profilePage({
    profiles: [CLAIMED_ROW],
    reviewsFail: 'Không tải được đánh giá.',
  });
  await page.init();

  /* The reviews are read-only and the rest of the page is not: a 500 on them used to take
     the avatar, the bio, the gallery and the withdrawal switch off the page with it, because
     one catch emptied `profiles` and the x-if that mounts all four reads row(). */
  assert.equal(page.error, '');
  assert.equal(page.profiles.length, 1);
  assert.equal(page.row().staff_id, CLAIMED_ROW.staff_id);
  assert.equal(page.reviewsError, 'Không tải được đánh giá.');

  // The list says so where the list is, and offers the one thing worth pressing.
  const section = handler(profileMeHtml, '>Đánh giá về bạn</h2>', '</section>');
  assert.match(section, /<template x-if="reviewsError">/);
  assert.match(section, /@click="loadReviews\(\)"/);
  // …and the empty state stays out of the way of it, rather than claiming there are none.
  assert.match(section, /<template x-if="!reviewsError &amp;&amp; !reviewRows\(\)\.length">/);

  // Retrying reaches only that read: the editor above it is not re-fetched to fix a list.
  const before = page.asked.filter((endpoint) => endpoint === '/api/staff-me/profile').length;
  await page.loadReviews();
  assert.equal(page.asked.filter((endpoint) => endpoint === '/api/staff-me/profile').length, before);
});

// ------------------------------------------------- leaving, as a dated event with two sides

test('the columns a departure writes are added like any other, and nothing sweeps them', () => {
  const added = [
    'left_at TEXT',
    'left_by TEXT',
    'started_confirmed_at TEXT',
    'left_confirmed_at TEXT',
    'tenure_disputed INTEGER DEFAULT 0',
  ];
  for (const column of added) {
    const name = column.split(' ')[0];
    assert.match(
      dbSource,
      new RegExp(`^ALTER TABLE staff ADD COLUMN IF NOT EXISTS ${column};$`, 'm'),
      name,
    );
    assert.equal(
      (dbSource.match(new RegExp(`ADD COLUMN IF NOT EXISTS ${name}\\b`, 'g')) || []).length,
      1,
      name,
    );
    /* No backfill, at boot or anywhere else. Every row already carrying active = 0 ended
       before there was anywhere to write a date, and guessing one from the last booking would
       put a day on somebody's public record that nobody agreed to. */
    assert.doesNotMatch(dbSource, new RegExp(`SET ${name}`), name);
  }
  // Guarded and never dropped first, like bookings_source_allowed: nothing has ever written
  // this column, so there is no earlier shape of the rule to replace.
  const guard = dbSource.lastIndexOf('DO $$', dbSource.indexOf("conname = 'staff_left_by_allowed'"));
  const check = dbSource.slice(guard, dbSource.indexOf('END $$;', guard));
  assert.match(check, /IF NOT EXISTS \(/);
  assert.match(check, /CHECK \(\s*left_by IS NULL OR left_by IN \('partner','staff'\)\s*\)/);
  assert.doesNotMatch(check, /DROP CONSTRAINT/);
});

test('an open stint is active = 1 AND left_at NULL, and one statement writes both', () => {
  /* The unique index that keeps one live claimed row per person per salon is predicated on
     active = 1. That predicate only means "open stint" while every departure closes both
     halves at once — a row with a leaving date still sitting active would block the re-hire
     the date says has already happened. */
  const stint = handler(departureSource, 'export const END_STINT', '`;')
    .replace(/\s+/g, ' ')
    .trim();
  assert.equal(
    stint,
    'export const END_STINT = ` UPDATE staff SET left_at = ?, left_by = ?, active = 0, ' +
      'left_confirmed_at = NULL ' +
      'WHERE id = ? AND user_id IS NOT NULL AND active = 1',
  );
  /* And what it deliberately does NOT write. tenure_disputed is one flag over the whole
     stint, and the date most often under argument is started_at, which a departure does not
     touch: clearing it here would let a salon answer "that start date is wrong" by recording
     a departure, and the ✓ the technician had refused would come back on a date she never
     agreed to. A dispute outlives the stint it was raised on. */
  assert.doesNotMatch(stint, /tenure_disputed/);
  /* Both callers append their own ownership clause to that one statement rather than writing
     one of their own, and both are scoped in the UPDATE itself: there is no window between
     proving the row is theirs and closing it. */
  assert.match(
    partnerSource,
    /tx\.run\(\s*`\$\{END_STINT\} AND salon_id = \?`, leftAt, 'partner', staffId, salon\.id,/,
  );
  assert.match(
    staffMeSource,
    /tx\.run\(\s*`\$\{END_STINT\} AND user_id = \?`, leftAt, 'staff', staffId, req\.user\.id,/,
  );
  // And both check that they were the one that closed it: two presses of the button, or both
  // sides at the same moment, and only one of them may date the stint.
  for (const [name, text] of [
    ['routes/partner.js', partnerSource],
    ['routes/staff-me.js', staffMeSource],
  ]) {
    assert.match(text, /const ended = await tx\.run\(/, name);
    assert.match(text, /if \(ended\.changes !== 1\) \{/, name);
  }
  // The index keeps its predicate, and the comment above it now states the pairing that makes
  // it true instead of promising to refine it: CREATE INDEX IF NOT EXISTS would keep a stale
  // predicate under the same name without a word.
  const index = dbSource.slice(
    dbSource.lastIndexOf(
      '-- One live claimed row',
      dbSource.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_user_salon'),
    ),
    dbSource.indexOf('WHERE user_id IS NOT NULL AND active = 1'),
  );
  assert.match(index, /left_at and active = 0 in ONE statement/);
  assert.doesNotMatch(index, /A later phase refines/);
});

test('the ✓ on a date is three things, decided in one place', () => {
  const statsSource = source('lib', 'staff-stats.js');
  const { tenureVerified } = vm.runInNewContext(
    `${declaration(statsSource, 'export function tenureVerified(').replace('export ', '')}
     ({ tenureVerified });`,
  );

  const attested = {
    started_at: '2024-01-05',
    started_confirmed_at: '2024-02-01T00:00:00.000Z',
    left_at: '2026-08-28',
    left_confirmed_at: '2026-08-28T00:00:00.000Z',
    tenure_disputed: 0,
  };
  // Read field by field rather than deep-compared: the object comes back from another realm,
  // where its prototype is a different Object and deepStrictEqual says so.
  const badge = (row) => `${tenureVerified(row).started}/${tenureVerified(row).left}`;
  assert.equal(badge(attested), 'true/true');
  // A date nobody entered, and a date nobody answered for, each carry nothing.
  assert.equal(badge({ ...attested, left_at: null }), 'true/false');
  assert.equal(badge({ ...attested, started_confirmed_at: null }), 'false/true');
  // One dispute takes both ✓ off: there is no arbitration behind the flag, so a stint whose
  // dates are contested is not one this platform can put a mark of its own on.
  assert.equal(badge({ ...attested, tenure_disputed: 1 }), 'false/false');
  assert.equal(badge({}), 'false/false');

  /* Read against the RAW column, never the COALESCE the profile displays: a start date
     derived from the first completed booking is a reading of the calendar, and there is
     nothing in it for anybody to have confirmed. */
  const start = handler(statsSource, 'const selectStaffStart', '`);');
  assert.match(start, /\) AS effective_started_at,\s*\n\s*st\.started_at, st\.left_at/);
  assert.match(statsSource, /tenure_verified: tenureVerified\(tenure\)/);
  // One rule, one exporter, and every reader served from it rather than re-deriving it.
  assert.equal((statsSource.match(/export function tenureVerified/g) || []).length, 1);
  for (const [name, text] of [
    ['routes/staff.js', staffSource],
    ['routes/partner.js', partnerSource],
  ]) {
    assert.doesNotMatch(text, /started_confirmed_at\)? &&/, name);
  }
});

test('a claimed row is ended, never deleted, and an unclaimed one deleted, never ended', () => {
  const remove = handler(partnerSource, "router.delete('/staff/:id'", 'Time off — holidays');
  // Refused before anything is written, and refused with the door it should have used.
  assert.match(remove, /if \(staff\.user_id != null\) \{[\s\S]*?409,\s*'CONFLICT',/);
  assert.match(remove, /kết thúc hợp tác kèm ngày nghỉ thay vì xóa khỏi danh sách/);
  assert.ok(remove.indexOf('user_id != null') < remove.indexOf('DEACTIVATE_STAFF'));
  // And the soft delete underneath it is untouched: no date, because there was no stint.
  assert.match(remove, /await tx\.run\(DEACTIVATE_STAFF, staffId, salon\.id\);/);
  assert.doesNotMatch(remove, /left_at|END_STINT/);

  // The mirror of it: a chair nobody stands behind has no collaboration to end.
  const departure = handler(
    partnerSource,
    "router.post('/staff/:id/departure'",
    "router.delete('/staff/:id'",
  );
  assert.match(departure, /if \(staff\.user_id == null\) \{[\s\S]*?409,\s*'CONFLICT',/);
  assert.match(departure, /Hãy xóa khỏi danh sách thay vì kết thúc hợp tác/);
});

test('a date the owner rewrites arrives unattested, whatever the old one had earned', () => {
  assert.match(
    partnerSource,
    /const RESET_STARTED_ATTESTATION = 'started_confirmed_at = NULL, tenure_disputed = 0';/,
  );
  /* Appended to the SET clause of the same UPDATE rather than run beside it: a date that
     landed while its ✓ stayed would be a profile claiming the technician confirmed a day she
     has never seen, and a second statement is a second chance to not run. */
  const patch = handler(
    partnerSource,
    "router.patch('/staff/:id'",
    "router.post('/staff/:id/departure'",
  );
  assert.match(
    patch,
    /if \(Object\.hasOwn\(patch, 'started_at'\)\) \{\s*assignments\.push\(RESET_STARTED_ATTESTATION\);\s*\}/,
  );
  assert.ok(patch.indexOf('RESET_STARTED_ATTESTATION') < patch.indexOf('UPDATE staff SET'));
  // The same rule at the other end, inside END_STINT: a new leaving date is unconfirmed too.
  assert.match(
    departureSource,
    /SET left_at = \?, left_by = \?, active = 0, left_confirmed_at = NULL/,
  );
});

test('the sweep is the booking wizard’s own machinery, run one appointment at a time', () => {
  const sweep = declaration(departureSource, 'export async function sweepFutureBookings(');
  /* Reused rather than reimplemented. The three rules a replacement has to satisfy — she
     performs the service, she is on shift, she is free for the whole duration — are the rules
     the customer's own calendar was built from, and a second implementation of them is a
     second answer to "who could take this". */
  assert.match(
    sweep,
    /await pickAvailableStaff\(\s*tx, salon\.id, booking\.service_id, booking\.date, booking\.time, booking\.duration_min,/,
  );
  assert.doesNotMatch(departureSource, /staff_services|staff_schedule/);
  // Sequentially, on the caller's transaction: each move has to be visible to the next pick,
  // or two appointments an hour apart both land on the one colleague free for one of them.
  assert.doesNotMatch(sweep, /Promise\.all/);
  assert.match(sweep, /for \(const booking of rows\) \{/);

  // Only what is still to happen, and only after the day worked: an appointment ON the
  // leaving date is one she is still there for, and a completed row is a record.
  const future = handler(departureSource, 'const FUTURE_BOOKINGS_SQL', '`;');
  assert.match(
    future,
    /WHERE b\.staff_id = \? AND b\.status IN \('pending','confirmed'\) AND b\.date > \?/,
  );

  /* An appointment nobody can take is left exactly where it is. Cancelling for the customer
     is not this function's decision, and clearing the technician off it would drop it out of
     every list the salon runs its day from — so it keeps holding the closed row's slot until
     the owner acts, and the count is what tells them to. */
  assert.match(sweep, /needsAttention \+= 1;\s*continue;/);
  assert.match(sweep, /return \{ reassigned, needs_attention: needsAttention \};/);
  // One notice for the whole sweep, outside the loop, and only when there is something in it.
  assert.match(sweep, /if \(needsAttention > 0\) \{\s*await notifyUser\(/);
  assert.equal((sweep.match(/lịch hẹn tương lai cần bạn xử lý/g) || []).length, 1);

  /* The audit row for every one of these, pending included — unlike the console's own PATCH,
     which leaves pending swaps out as corrections to a plan. A whole calendar changing hands
     is not a correction. Both writers spell the row from one place. */
  assert.match(
    sweep,
    /await tx\.run\(\s*INSERT_BOOKING_STAFF_CHANGE, booking\.id, staffId, replacement, actorUserId, changedAt,/,
  );
  assert.match(
    partnerSource,
    /import \{[\s\S]*?INSERT_BOOKING_STAFF_CHANGE,[\s\S]*?\} from '\.\.\/lib\/staff-departure\.js';/,
  );
  assert.equal((partnerSource.match(/INSERT INTO booking_staff_changes/g) || []).length, 0);
});

test('one sentence tells a customer their chair changed, however it changed', () => {
  // The console's manual swap and a departure sweep are the same fact from where the customer
  // sits, so partner.js serves the sweep's own builder rather than a second wording of it.
  assert.match(
    departureSource,
    /export const restaffedNotice = \(salon, booking\) => \(\{\s*title: 'Lịch hẹn đổi kỹ thuật viên',/,
  );
  assert.match(partnerSource, /^ {2}restaffed: restaffedNotice,$/m);
  assert.equal((partnerSource.match(/Lịch hẹn đổi kỹ thuật viên/g) || []).length, 0);
});

test('a departure tells the other side, and an owner hears it as an owner', () => {
  /* There is no partner-only notification channel and none is invented here: an owner reads
     their bell through the same endpoint everybody else does, which is how they are already
     told about a new booking. 'general' rather than 'booking' because none of these rows is
     about an appointment of the reader's own — ui/thong-bao.html routes by type, and an
     unmapped type is a row with no arrow rather than a link into somebody else's list. */
  const ownerNotices = [
    ['the sweep’s leftovers', departureSource, 'Lịch hẹn cần bạn xử lý'],
    ['the technician leaving', staffMeSource, 'Kỹ thuật viên kết thúc hợp tác'],
    ['the disputed date', staffMeSource, 'Kỹ thuật viên báo sai ngày'],
  ];
  for (const [name, text, title] of ownerNotices) {
    const call = calls(text, 'notifyUser').find((one) => one.includes(title));
    assert.ok(call, `${name}: no owner notice found`);
    assert.match(call, /^notifyUser\(\s*tx,/, name);
    assert.match(call, /owner_id,/, name);
    assert.match(call, /'general',\s*\)$/, name);
  }
  /* The other direction rides notifyStaff, which resolves the account off the roster row: a
     departure keeps user_id, so the person whose stint just ended is still reachable on it. */
  const departure = handler(
    partnerSource,
    "router.post('/staff/:id/departure'",
    "router.delete('/staff/:id'",
  );
  assert.match(departure, /await notifyStaff\(\s*tx,\s*staffId,\s*'Hợp tác đã kết thúc',/);
  // Inside the transaction that closed the stint, like every other notice in this codebase,
  // and before the sweep that hands the calendar on.
  assert.ok(departure.indexOf('db.withTransaction') < departure.indexOf('notifyStaff'));
  assert.ok(departure.indexOf('notifyStaff') < departure.indexOf('sweepFutureBookings'));
});

test('a departure date reaches back as far as it likes and never past today', () => {
  const bound = declaration(departureSource, 'export function departureDateOrThrow(');
  assert.match(bound, /if \(!isISODate\(value\)\) \{/);
  /* The past is wide open on purpose: a salon writing a departure down weeks after the fact
     is the ordinary case, and refusing it only teaches owners to enter today's date, which
     puts a wrong day on somebody's record forever. */
  assert.doesNotMatch(bound, /value < /);
  /* And the future is shut, with today as the ceiling. Recording a departure is not
     scheduling one — active = 0 is written on the press and nothing runs later to do it on
     the day — so a date a month out takes a technician off the roster, out of the picker and
     off the salon's page for the whole notice period she is still working. There is no lead
     allowance left to read, and no constant naming one. */
  assert.match(bound, /if \(value > todayISO\(\)\) \{/);
  assert.doesNotMatch(departureSource, /MAX_LEAD_DAYS/);
  // One validator for both doors, so the two sides cannot disagree about which dates exist.
  for (const [name, text] of [
    ['routes/partner.js', partnerSource],
    ['routes/staff-me.js', staffMeSource],
  ]) {
    assert.match(text, /const leftAt = departureDateOrThrow\(/, name);
  }
});

test('the CV is every stint of one person, and the withdrawal reaches it', () => {
  const history = handler(staffSource, "router.get('/:id/history'", "router.get('/:id',");
  /* The only read in this file not gated on active = 1, and it has to be: a stint that ended
     is what a career is made of, and a technician between salons has no open row anywhere. */
  assert.match(
    staffSource,
    /const selectVisibleStaffRow = db\.prepare\(`[\s\S]*?WHERE st\.id = \? AND \$\{VISIBLE_PROFILE\}\s*`\);/,
  );
  assert.doesNotMatch(history, /active = 1/);
  // Hidden is 404 in the same words the profile itself answers with, and a hidden stint is
  // left out of everybody else's list rather than reappearing inside one.
  assert.match(history, /'NOT_FOUND', 'Không tìm thấy kỹ thuật viên này\.'/);
  assert.match(staffSource, /WHERE st\.user_id = \? AND \$\{VISIBLE_PROFILE\}\s*ORDER BY st\.id DESC/);

  /* A row nobody stands behind is a chair, not a person, so there is nothing tying it to any
     other row — which is also what an erased account leaves behind, since the release clears
     user_id off every row it held. */
  assert.match(
    history,
    /const stints = row\.user_id === null \? \[row\] : await selectStaffStints\.all\(row\.user_id\);/,
  );

  // Both halves of "still here": no leaving date, and still on the roster.
  const shape = declaration(staffSource, 'async function stintShape(');
  assert.match(shape, /is_current: row\.left_at === null && row\.active === 1,/);
  // Per stint, through the one block both the public profile and the technician's own page
  // are served from, rather than a second count written for this endpoint.
  assert.match(shape, /const stats = await staffStats\(row\.id\);/);
  assert.match(shape, /tenure_verified: stats\.tenure_verified,/);
  assert.doesNotMatch(shape, /COUNT\(|SELECT /);
});

// ------------------------------------------------- the CV, on the page a customer reads

/* One stint the way GET /api/staff/:id/history sends one — stintShape() in routes/staff.js.
   tenure_verified is its own nested object precisely so nothing on the page has to work the
   badge out from the two columns underneath it. */
const STINT = {
  staff_id: 7,
  salon: { id: 4, slug: 'lala', name: 'Lala Nail Studio' },
  started_at: '2024-01-05',
  left_at: null,
  left_by: null,
  started_confirmed: true,
  left_confirmed: false,
  tenure_disputed: 0,
  is_current: true,
  tenure_verified: { started: true, left: false },
  verified_count: 3,
  review_count: 5,
  rating_avg: 4.8,
};

const CLOSED_STINT = {
  ...STINT,
  staff_id: 9,
  salon: { id: 5, slug: 'moc', name: 'Mộc Spa' },
  started_at: '2021-06-01',
  left_at: '2023-12-20',
  left_by: 'partner',
  left_confirmed: true,
  is_current: false,
  tenure_verified: { started: true, left: true },
};

test('the CV rides in with the profile, and one that never arrived is one section fewer', async () => {
  const page = specialistPage(COUNTED, { history: [STINT, CLOSED_STINT] });
  await page.init();

  /* Compared by length and by JSON: the array crossed a realm boundary on its way into the
     component, so deepStrictEqual would fail on the prototype rather than on the contents. */
  assert.equal(page.history.length, 2);
  assert.equal(
    JSON.stringify(page.history.map((stint) => [stint.staff_id, stint.is_current])),
    JSON.stringify([[7, true], [9, false]]),
  );

  /* The soft-fail contract. The CV is an extra, like the service chips beside it: a read
     that failed is one section fewer on the page and never a profile that says it could not
     be read — which is what dropping the .catch() would turn a 500 on /history into, since
     Promise.all rejects as a whole. */
  const broken = specialistPage(COUNTED, { historyFails: 'Không tải được quá trình.' });
  await broken.init();

  assert.equal(broken.history.length, 0);
  assert.equal(broken.loadError, '');
  assert.equal(broken.loading, false);
  assert.equal(broken.staff.name, 'KTV Số Liệu');
  assert.equal(broken.completedTotal(), 10);

  // And the catch is on that one read rather than around the whole Promise.all, which would
  // hand the same silence to a failed profile.
  assert.match(profileHtml, /OAK\.api\('\/api\/staff\/' \+ id \+ '\/history'\)\.catch\(\(\) => \[\]\)/);
  assert.match(profileHtml, /<section class="mt-section-gap" x-show="history\.length">/);
});

test('the CV names a month out of what it was given, and nothing out of what it was not', async () => {
  const page = specialistPage(COUNTED);
  await page.init();

  // A plain ISO date, and the ISO timestamp the confirmation columns are stamped in: the
  // slice(0, 10) is what makes one helper serve both.
  assert.equal(page.monthOf('2024-01-05'), '01/2024');
  assert.equal(page.monthOf('2026-08-28T13:45:00.000Z'), '08/2026');
  /* Nothing, rather than a month built out of nothing. left_at is null on every open stint
     and started_at is null on a row with no completed visit behind it, so both reach this
     helper on an ordinary profile — 'undefined/NaN' would be the whole date row. */
  assert.equal(page.monthOf(null), '');
  assert.equal(page.monthOf(''), '');
  assert.equal(page.monthOf(undefined), '');
});

test('the ✓ on the CV comes from tenure_verified and from nothing else', () => {
  const cv = handler(profileHtml, '>Quá trình làm việc</h2>', '</section>');
  assert.ok(cv.length > 0, 'the CV section has moved');

  /* The invariant the comment over tenureVerified() in lib/staff-stats.js exists to protect:
     one rule, one exporter, every reader served from it. A page that re-derived the badge
     from started_confirmed/left_confirmed/tenure_disputed would be a second implementation
     of it, free to disagree with the owner console about the same two columns. */
  assert.doesNotMatch(profileHtml, /started_confirmed|left_confirmed/);
  for (const end of ['started', 'left']) {
    assert.match(
      cv,
      new RegExp(`x-show="stint\\.tenure_verified\\.${end}">\\s*<span aria-hidden="true"[^>]*>verified</span>\\s*<span>Được OAK xác thực</span>`),
      end,
    );
  }
  // Exactly two ✓ in the section — one per date — and no third gated on something else.
  assert.equal((cv.match(/Được OAK xác thực/g) || []).length, 2);

  /* tenure_disputed is on the page once, on a line of its own, and never inside a gate that
     also reads tenure_verified: it can neither put a badge on nor take one off that
     tenureVerified() had already granted. One flag over the stint, said once — the next test
     is about why it may not be said per date. */
  assert.deepEqual(cv.match(/x-show="[^"]*tenure_disputed[^"]*"/g), ['x-show="stint.tenure_disputed"']);
  assert.equal((cv.match(/stint\.tenure_disputed/g) || []).length, 1);

  /* "chưa xác thực" and not "đang chờ xác nhận": started_at falls back to the first completed
     visit, so a date nobody entered is not a date awaiting anybody's answer. The technician's
     own page does say "chờ xác nhận", because there somebody really is being waited on. */
  assert.match(cv, />chưa xác thực</);
  // As a text node, since the comment above the rows quotes the wording it rejected.
  assert.doesNotMatch(cv, />chờ xác nhận</);
  assert.match(profileMeHtml, />chờ xác nhận</);
});

test('the CV says the dispute once over the stint, and never about a date she wrote herself', () => {
  const cv = handler(profileHtml, '>Quá trình làm việc</h2>', '</section>');

  /* tenure_disputed is ONE column over the stint — confirming either date clears it, and
     lib/staff-stats.js takes both ✓ off for it — so a chip on each date row was one flag
     rendered twice, as though there were two. Once, under both rows. */
  assert.equal((cv.match(/đang khiếu nại/g) || []).length, 2, 'one line, two wordings of it');
  assert.doesNotMatch(cv, /ngày đang có khiếu nại/);

  /* And never said about a date she recorded herself. left_by = 'staff' is her own
     departure: nobody is on the other side of that day to argue with it — ho-so-nhan-vien
     .html will not even offer her the button — so the only date an objection can be about
     is the one the salon entered, and the CV names it rather than pointing at hers. */
  assert.match(cv, /x-show="stint\.left_by !== 'staff'">Kỹ thuật viên đang khiếu nại ngày làm việc tại salon này\.<\/span>/);
  assert.match(cv, /x-show="stint\.left_by === 'staff'">Kỹ thuật viên đang khiếu nại ngày bắt đầu do salon nhập\.<\/span>/);

  /* The per-date state that is left is the one that was always true of an unverified date,
     and it now stands on the verified flag alone: a disputed date is an unverified date, and
     the old `&& !tenure_disputed` half of the gate left the row saying nothing at all. */
  for (const end of ['started', 'left']) {
    assert.match(
      cv,
      new RegExp(`x-show="!stint\\.tenure_verified\\.${end}">chưa xác thực</span>`),
      end,
    );
  }
  assert.equal((cv.match(/>chưa xác thực<\/span>/g) || []).length, 2);

  // left_by rides in on the payload the page is drawn from — stintShape() in routes/staff.js.
  assert.match(declaration(staffSource, 'async function stintShape('), /left_by: row\.left_by,/);
});

test('each date row on the CV is gated on its own date being there', () => {
  const cv = handler(profileHtml, '>Quá trình làm việc</h2>', '</section>');

  /* An open stint has left_at null and a fresh one can have started_at null, so both rows
     have to disappear on their own. One gate over the pair would print "Kết thúc" with an
     empty month beside it on every technician still working — a leaving date the salon has
     not entered and nobody has agreed to. */
  for (const [end, label] of [['started', 'Bắt đầu'], ['left', 'Kết thúc']]) {
    assert.match(
      cv,
      new RegExp(`x-show="stint\\.${end}_at">\\s*<span class="text-on-surface-variant">${label}</span>\\s*<span x-text="monthOf\\(stint\\.${end}_at\\)"></span>`),
      end,
    );
  }
  // The salon link and the current/former chip are the only things outside those two gates,
  // so a stint with no dates at all is still a salon somebody worked at.
  assert.match(cv, /x-show="stint\.is_current">Hiện tại</);
  assert.match(cv, /x-show="!stint\.is_current">trước đây</);

  // The legend is its own section beside the CV rather than inside it: the "(tự khai)" chip
  // in the hero needs it whether or not this person has a single stint on record.
  assert.match(profileHtml, /@click="legendOpen = !legendOpen"/);
  assert.match(profileHtml, /id="oak-chu-giai" x-cloak="" x-show="legendOpen"/);
  assert.ok(
    profileHtml.indexOf('id="oak-chu-giai"') > profileHtml.indexOf('x-show="history.length"'),
    'the legend was folded inside the CV section, which x-show="history.length" would hide',
  );
});

// ------------------------------------------ the stint, on the page the technician answers on

test('each attestation posts its own end of the stint, and the answer replaces the row', async () => {
  const answered = withStint({ started_confirmed: true });
  const page = profilePage({ profiles: [CLAIMED_ROW], tenureReply: answered });
  await page.init();
  assert.equal(page.row().stint.started_confirmed, false);

  await page.answerTenure('confirm', 'started');

  /* The path carries the roster row and the body carries which of its two dates. One flag
     covers the whole stint on the dispute side, but a ✓ belongs to a single date — so an
     attestation that posted no field at all would confirm whichever end the server guessed. */
  assert.equal(page.posted.length, 1);
  assert.equal(page.posted[0].endpoint, '/api/staff-me/tenure/7/confirm');
  assert.equal(page.posted[0].method, 'POST');
  assert.equal(JSON.stringify(page.posted[0].body), '{"field":"started"}');
  // Swapped into the list rather than re-read: the endpoint answers with the whole row.
  assert.equal(page.row().stint.started_confirmed, true);
  assert.equal(page.tenureBusy, false);
  assert.equal(page.tenureError, '');
  assert.deepEqual(page.toasts, [['Đã xác nhận ngày.', undefined]]);
});

test('the dispute panel answers about the date it was opened over, and shuts before it asks', async () => {
  const page = profilePage({
    profiles: [withStint({ left_at: '2026-08-01' })],
    tenureReply: withStint({ left_at: '2026-08-01', tenure_disputed: 1 }),
  });
  await page.init();

  page.openDispute('left');
  assert.equal(page.disputeField, 'left');
  assert.equal(page.disputeOpen, true);

  await page.confirmDispute();

  /* Shut before the request rather than after it: what a refusal has to say belongs on the
     card beside the date it is about, not behind a panel the reader has to close first. */
  assert.equal(page.disputeOpen, false);
  assert.equal(page.posted[0].endpoint, '/api/staff-me/tenure/7/dispute');
  assert.equal(JSON.stringify(page.posted[0].body), '{"field":"left"}');
  assert.equal(page.row().stint.tenure_disputed, 1);
  assert.deepEqual(page.toasts, [['Đã gửi phản hồi tới chủ salon.', undefined]]);
});

test('a refused attestation says so beside the date, and lets go of both buttons', async () => {
  const page = profilePage({
    profiles: [CLAIMED_ROW],
    tenureError: 'Ngày này đã được xác nhận.',
  });
  await page.init();

  await page.answerTenure('confirm', 'started');

  // The line under the card, and never a row claiming an answer the server refused.
  assert.equal(page.tenureError, 'Ngày này đã được xác nhận.');
  assert.equal(page.row().stint.started_confirmed, false);
  // The flag both buttons are disabled on has to come back, or the card is dead for good.
  assert.equal(page.tenureBusy, false);
  assert.deepEqual(page.toasts, []);
  assert.match(profileMeHtml, /x-show="tenureError" x-text="tenureError"/);
  assert.match(profileMeHtml, /:disabled="tenureBusy" @click="answerTenure\('confirm', 'started'\)"/);
});

test('a date is answerable only while somebody entered it and nobody has settled it', async () => {
  const other = (staffId, salon, stint) => ({
    ...withStint(stint), staff_id: staffId, salon,
  });
  const page = profilePage({
    profiles: [
      // Entered, unanswered: the ordinary case, and the only one with anything to press.
      withStint({}),
      // Nobody entered it. The server answers an attestation on one of these with a 409.
      other(9, { id: 5, name: 'Mộc', slug: 'moc' }, { started_at: null }),
      // Already confirmed and uncontested: nothing left to say about it.
      other(11, { id: 6, name: 'Hạ', slug: 'ha' }, { started_confirmed: true }),
      /* Confirmed AND disputed. The ✓ is off (tenureVerified reads the flag), so there is
         still something to answer — but not one date at a time: the flag covers the stint
         and the way back out of it is withdrawDispute(), tested on its own below. */
      other(13, { id: 7, name: 'Vy', slug: 'vy' }, { started_confirmed: true, tenure_disputed: 1 }),
    ],
  });
  await page.init();

  const seen = [];
  for (const staffId of [7, 9, 11, 13]) {
    page.select(staffId);
    seen.push([page.tenureState('started'), page.canAnswer('started'), page.canWithdraw()]);
  }
  assert.deepEqual(seen, [
    ['pending', true, false],
    ['missing', false, false],
    ['confirmed', false, false],
    ['disputed', false, true],
  ]);

  // The other end of the stint is asked the same way and answers 'missing' while it is open.
  page.select(7);
  assert.equal(page.tenureState('left'), 'missing');
  assert.equal(page.canAnswer('left'), false);
  /* Said in words once, on the one row it can be true of. started_at is the salon's entry
     and nobody else's, so a blank there IS the salon's omission; the end date row is not on
     an open stint's card at all (showEnd() below), and the sentence went with it. */
  assert.match(profileMeHtml, /x-show="!row\(\)\.stint\.started_at">Salon chưa nhập ngày này</);
  assert.equal((profileMeHtml.match(/Salon chưa nhập ngày này/g) || []).length, 1);
});

test('a leaving date the technician wrote herself is never hers to confirm', async () => {
  /* POST /api/staff-me/leave writes left_at with left_by = 'staff', no confirmation and no
     dispute; there is no salon-side confirmation endpoint anywhere, so /tenure/:id/confirm
     is the ONLY writer of left_confirmed_at and only she can reach it. Offering her the
     button on her own date would let her earn, single-handed, the mark the legend on
     ho-so-chuyen-gia.html calls a day both sides named. */
  assert.match(
    departureSource,
    /SET left_at = \?, left_by = \?, active = 0, left_confirmed_at = NULL/,
  );
  assert.match(staffMeSource, /left_by: row\.left_by,/);
  assert.match(profileHtml, /ngày cả salon và kỹ thuật viên cùng xác nhận/);

  const page = profilePage({
    profiles: [
      withStint({ left_at: '2026-08-20', left_by: 'staff' }),
      {
        ...withStint({ left_at: '2026-08-20', left_by: 'partner' }),
        staff_id: 9,
        salon: { id: 5, name: 'Mộc', slug: 'moc' },
      },
    ],
  });
  await page.init();

  page.select(7);
  assert.equal(page.tenureState('left'), 'self');
  assert.equal(page.canAnswer('left'), false);
  /* The start date is untouched by any of this: started_at is only ever written by the owner
     (POST/PATCH /api/partner/staff), so her ✓ on it really is the second signature. */
  assert.equal(page.canAnswer('started'), true);

  // And an end date the salon entered is answered exactly as it always was.
  page.select(9);
  assert.equal(page.tenureState('left'), 'pending');
  assert.equal(page.canAnswer('left'), true);

  /* Said on the card in its own words, and never as "chờ xác nhận": nobody is waiting on
     her for a day she typed, and the salon has already been told about it. */
  assert.match(
    profileMeHtml,
    /x-show="tenureState\('left'\) === 'self'">\s*<span aria-hidden="true"[^>]*>person<\/span>\s*<span>bạn tự ghi ngày này, salon đã nhận thông báo<\/span>/,
  );
  // Both buttons on that row hang off the one gate, so withholding the state withholds both.
  assert.match(
    profileMeHtml,
    /x-show="canAnswer\('left'\)">\s*<button [^>]*@click="answerTenure\('confirm', 'left'\)"/,
  );
  assert.match(
    profileMeHtml,
    /x-show="canAnswer\('left'\)">[\s\S]*?@click="openDispute\('left'\)"/,
  );
});

test('a dispute is withdrawn once, for the stint, and never by confirming one date', async () => {
  /* tenure_disputed is ONE column over the whole stint and /tenure/:staffId/confirm sets it
     to 0 whichever date it is given, so a bare per-date "Xác nhận" beside a disputed row
     reads as an answer about that row and is an answer about the pair. */
  assert.match(staffMeSource, /SET "\$\{field\.confirmed\}" = \?, tenure_disputed = 0/);

  const disputed = { left_at: '2026-08-30', left_by: 'partner', tenure_disputed: 1 };
  const page = profilePage({
    profiles: [withStint(disputed)],
    tenureReply: withStint({ ...disputed, tenure_disputed: 0 }),
  });
  await page.init();

  // Both rows read as disputed, and neither carries an answer of its own.
  assert.deepEqual(
    ['started', 'left'].map((field) => [page.tenureState(field), page.canAnswer(field)]),
    [['disputed', false], ['disputed', false]],
  );
  assert.equal(page.canWithdraw(), true);

  await page.withdrawDispute();

  /* Every date she is the one to attest to, one call each. Confirming only the first would
     lift the dispute off the stint while the other date stood unagreed — which is the silent
     withdrawal this single action exists to make impossible. */
  assert.deepEqual(
    page.posted.map((call) => [call.endpoint, JSON.stringify(call.body)]),
    [
      ['/api/staff-me/tenure/7/confirm', '{"field":"started"}'],
      ['/api/staff-me/tenure/7/confirm', '{"field":"left"}'],
    ],
  );
  // One action, so one word back, and it names the withdrawal rather than a date.
  assert.deepEqual(page.toasts, [['Đã rút khiếu nại.', undefined]]);
  assert.equal(page.tenureBusy, false);
  assert.equal(page.tenureError, '');

  /* A date she wrote herself is not one she may attest to, so the withdrawal does not reach
     for it either — the ✓ stays off it by this door as well as by the other. */
  const hers = profilePage({
    profiles: [withStint({ left_at: '2026-08-30', left_by: 'staff', tenure_disputed: 1 })],
    tenureReply: withStint({ left_at: '2026-08-30', left_by: 'staff', tenure_disputed: 0 }),
  });
  await hers.init();
  await hers.withdrawDispute();
  assert.deepEqual(hers.posted.map((call) => JSON.stringify(call.body)), ['{"field":"started"}']);

  // A refusal lands on the same one line under the card, and lets go of the button.
  const refused = profilePage({
    profiles: [withStint({ tenure_disputed: 1 })],
    tenureError: 'Hồ sơ không tồn tại.',
  });
  await refused.init();
  await refused.withdrawDispute();
  assert.equal(refused.tenureError, 'Hồ sơ không tồn tại.');
  assert.equal(refused.tenureBusy, false);
  assert.deepEqual(refused.toasts, []);

  // One action on the page, under the rows rather than beside one of them, saying what it
  // does to the stint. And still exactly two per-date confirms, both behind canAnswer.
  assert.match(profileMeHtml, /x-show="canWithdraw\(\)"/);
  assert.match(profileMeHtml, /@click="withdrawDispute\(\)"[^>]*>Rút khiếu nại<\/button>/);
  assert.match(profileMeHtml, /Khiếu nại của bạn tính cho cả quá trình tại salon này/);
  assert.equal((profileMeHtml.match(/answerTenure\('confirm'/g) || []).length, 2);
});

test('the end of a stint is on the card only once there is an end to speak of', async () => {
  const page = profilePage({
    profiles: [
      // Still working. No end date, and no row accusing the salon of failing to enter one.
      withStint({}),
      {
        ...withStint({ left_at: '2026-07-01', left_by: 'partner' }),
        active: 0,
        staff_id: 9,
        salon: { id: 5, name: 'Mộc', slug: 'moc' },
      },
      /* Off the roster with no date behind it — a row deactivated before departures existed.
         That the stint ended is a fact about it, so the row stands; which day it ended is
         not, so the row says the day is unknown rather than inventing one. */
      { ...withStint({}), active: 0, staff_id: 11, salon: { id: 6, name: 'Hạ', slug: 'ha' } },
    ],
  });
  await page.init();

  const seen = [];
  for (const staffId of [7, 9, 11]) {
    page.select(staffId);
    seen.push(page.showEnd());
  }
  assert.deepEqual(seen, [false, true, true]);
  // Nothing to say about a row that has not arrived either.
  page.select(null);
  assert.equal(page.showEnd(), false);

  // The whole row is gated, not merely the date inside it.
  assert.match(
    profileMeHtml,
    /<div class="flex flex-wrap items-center gap-3 py-3 border-b border-outline-variant\/20" x-show="showEnd\(\)">\s*<span[^>]*>Ngày kết thúc<\/span>/,
  );
  assert.match(profileMeHtml, /x-show="!row\(\)\.stint\.left_at">Chưa rõ ngày</);
});

test('the leave posts the day it was given and reads the sweep back as one sentence', async () => {
  const page = profilePage({
    profiles: [CLAIMED_ROW],
    leaveReply: { reassigned: 2, needs_attention: 1 },
  });
  await page.init();

  page.openLeave();
  // Opens on today, because that is the answer far more often than any other.
  assert.equal(page.leaveDate, '2026-08-28');
  assert.equal(page.leaveOpen, true);

  page.leaveDate = '2026-09-15';
  await page.confirmLeave();

  assert.equal(page.posted.length, 1);
  assert.equal(page.posted[0].endpoint, '/api/staff-me/leave');
  assert.equal(page.posted[0].method, 'POST');
  /* The row is named in the body rather than in the path: this endpoint is scoped by the
     account that holds the row and takes the roster row as an argument, so a body without
     staff_id is a departure from whichever of her salons the server picked. */
  assert.equal(JSON.stringify(page.posted[0].body), '{"staff_id":7,"left_at":"2026-09-15"}');
  assert.equal(page.leaveOpen, false);
  assert.equal(page.leaveBusy, false);
  /* One sentence built here rather than three nodes on the page, so it reaches the toast as
     a single text node — and both counts are read together, which is the point of them. */
  assert.deepEqual(page.toasts, [['2 lịch đã chuyển, 1 lịch cần salon xử lý', undefined]]);
  // The list is read again rather than patched: the reply is the sweep, not the row.
  assert.equal(page.asked.filter((endpoint) => endpoint === '/api/staff-me/profile').length, 2);
});

test('a refused departure keeps the panel and the date the technician typed', async () => {
  const page = profilePage({
    profiles: [CLAIMED_ROW],
    leaveError: 'Ngày kết thúc không hợp lệ.',
  });
  await page.init();
  page.openLeave();
  page.leaveDate = '2030-01-01';

  await page.confirmLeave();

  /* The panel stays open and says so in place. Closing it would take the date field away
     with it, and every refusal this endpoint has is about that field. */
  assert.equal(page.leaveOpen, true);
  assert.equal(page.leaveDate, '2030-01-01');
  assert.equal(page.leaveError, 'Ngày kết thúc không hợp lệ.');
  assert.equal(page.leaveBusy, false);
  assert.deepEqual(page.toasts, []);
});

test('the departure panel shuts only once the reload it triggers is done', async () => {
  /* leaveError is read in exactly one place — inside the panel — so nothing that can still
     refuse may run after the panel is gone. The reload is the last such thing.

     Pinned as source because there is nothing to observe from here: load() catches its own
     failure onto the page's error block, so the ordering cannot currently produce a lost
     message. It is the invariant that is being kept, not a live bug being closed. */
  const confirmLeave = handler(profileMeHtml, 'async confirmLeave() {', '\n            },');
  assert.ok(
    confirmLeave.indexOf('await this.load();') < confirmLeave.indexOf('this.leaveOpen = false;'),
    'the panel is shut before the reload, where a later refusal would have nowhere to be said',
  );

  /* And a reload that failed speaks on the page rather than nowhere: the card gives way to
     the error block with its own way back in, the panel is gone, and the sweep is still
     reported, because the departure itself did happen. */
  const page = profilePage({
    profiles: [CLAIMED_ROW],
    leaveReply: { reassigned: 1, needs_attention: 0 },
    profileReadsBeforeFailing: 1,
  });
  await page.init();
  page.openLeave();
  await page.confirmLeave();

  assert.equal(page.leaveOpen, false);
  assert.equal(page.leaveError, '');
  assert.equal(page.error, 'Không tải được hồ sơ.');
  assert.equal(page.loading, false);
  assert.deepEqual(page.toasts, [['1 lịch đã chuyển, 0 lịch cần salon xử lý', undefined]]);
});

test('the leave picker stops where the server stops, on the day the dialog opened', async () => {
  /* The gap is closed: departureDateOrThrow() refuses anything after today, and so does the
     picker. Recording a departure is not scheduling one — the row goes off the roster on the
     press — so a month of lead was a month in which the page offered a date that took a
     working technician off her own salon. The arithmetic that built it is gone with it. */
  assert.doesNotMatch(profileMeHtml, /\+ 30\)/);
  assert.doesNotMatch(profileMeHtml, /MAX_LEAD_DAYS/);

  const on = async (today) => {
    const page = profilePage({ profiles: [CLAIMED_ROW], today });
    await page.init();
    return page.leaveMax();
  };

  /* Today itself, whatever today is — a month end and a year end included, which is where a
     ceiling built by arithmetic on a day number used to go wrong. OAK.todayISO() still reads
     the day out of local getFullYear/getMonth/getDate parts, never toISOString(), which would
     hand a technician in Hanoi yesterday's ceiling for seven hours a day. */
  assert.equal(await on('2026-08-28'), '2026-08-28');
  assert.equal(await on('2026-01-31'), '2026-01-31');
  assert.equal(await on('2026-12-31'), '2026-12-31');
  assert.match(profileMeHtml, /:max="leaveMax\(\)"/);
  assert.match(profileMeHtml, /return OAK\.todayISO\(\);/);
});

test('only an open stint can be ended, and a closed one says when it ran', async () => {
  const page = profilePage({
    profiles: [
      withStint({}),
      // Already dated by the salon: there is nothing left to end, and the server 409s.
      {
        ...withStint({ left_at: '2026-07-01' }),
        staff_id: 9,
        salon: { id: 5, name: 'Mộc', slug: 'moc' },
      },
      // Off the roster, however it got there.
      { ...withStint({}), staff_id: 11, active: 0, salon: { id: 6, name: 'Hạ', slug: 'ha' } },
    ],
  });
  await page.init();

  const seen = [];
  for (const staffId of [7, 9, 11]) {
    page.select(staffId);
    seen.push(page.canLeave());
  }
  assert.deepEqual(seen, [true, false, false]);
  // Nothing to end before a row has arrived either.
  page.select(null);
  assert.equal(page.canLeave(), false);

  /* The span beside a finished stint's name in the switcher, so a row that is over reads as
     a place they worked. A stint with no start date names the one date it has rather than a
     range opening on nothing. */
  assert.equal(page.stintRange(page.profiles[0]), '');
  assert.equal(page.stintRange(page.profiles[1]), '2024-01-05 – 2026-07-01');
  assert.equal(
    page.stintRange({ stint: { started_at: null, left_at: '2026-07-01' } }),
    '2026-07-01',
  );
  // Closed rows stay choosable — the dates on a finished stint are still theirs to answer
  // for — and are faded rather than dropped.
  assert.match(profileMeHtml, /\(row\.active === 1 \? '' : ' opacity-60'\)/);
  assert.match(profileMeHtml, /<span class="sr-only" x-show="row\.active !== 1">Đã kết thúc<\/span>/);
});

test('switching salons closes whatever panel was open over the other one', async () => {
  const page = profilePage({
    profiles: [
      withStint({}),
      { ...withStint({}), staff_id: 9, salon: { id: 5, name: 'Mộc', slug: 'moc' } },
    ],
  });
  await page.init();

  page.openLeave();
  page.openDispute('started');
  page.tenureError = 'cũ';
  page.leaveError = 'cũ';

  page.select(9);

  /* Both panels act on this.selected, and this is the moment that moves: a dispute opened
     over Lala and confirmed after a switch would be answered against Mộc. */
  assert.equal(page.leaveOpen, false);
  assert.equal(page.disputeOpen, false);
  assert.equal(page.tenureError, '');
  assert.equal(page.leaveError, '');
  assert.equal(page.posted.length, 0);
});

// ---------------------------------------------- the stint, on the console the owner runs

/** oakPartnerStaff() over a stand-in browser, with every call it makes recorded. */
function rosterPage(api) {
  const tail = rosterHtml.slice(rosterHtml.indexOf('var OAK_WEEKDAY_LABELS'));
  const script = tail.slice(0, tail.lastIndexOf('oakPartnerChrome();'));
  const asked = [];
  const sent = [];
  const toasts = [];
  const context = {
    OAK: {
      requirePartner: async () => {},
      qs: () => null,
      toast: (message, tone) => toasts.push([message, tone]),
      fmtDate: (value) => value,
      pendingBadge: () => {},
      api: async (endpoint, options) => {
        asked.push(endpoint);
        if (options) {
          sent.push({ endpoint, method: options.method, body: options.body });
        }
        return api(endpoint, options);
      },
    },
  };
  vm.runInNewContext(`${script}\nresult = oakPartnerStaff();`, context);
  return Object.assign(context.result, { asked, sent, toasts });
}

/** A roster list the way OAK.api hands one back: rows, with the stats meta behind them. */
const rosterList = (rows) =>
  Object.assign(rows.slice(), { meta: { total: rows.length, on_shift: 0, rating_avg: 0 } });

/** One list row — the grid's own shape, which carries no stint at all. */
const CHAIR = {
  id: 2, name: 'Ghế trống', title: null, specialty: null, image: null,
  active: 1, claimed: false, invite_pending: false, shift: null, rating: 0,
};

/** GET /api/partner/staff/:id, in the shape staffDetail() answers with. */
const detailOf = (id, extra = {}) => ({
  id,
  name: 'Phương Vy',
  title: 'KTV chính',
  specialty: 'Nail nghệ thuật',
  image: null,
  started_at: '2024-01-05',
  left_at: null,
  tenure_disputed: 0,
  tenure_verified: { started: false, left: false },
  service_ids: [4],
  schedule: [],
  ...extra,
});

test('the console draws its stint chips off the list row, without a request per card', async () => {
  const list = rosterList([
    { ...CHAIR, id: 1, claimed: true, started_at: '2024-01-05', left_at: null, left_by: null,
      tenure_disputed: 0, tenure_verified: { started: true, left: false } },
    { ...CHAIR, started_at: null, left_at: null, left_by: null, tenure_disputed: 0,
      tenure_verified: { started: false, left: false } },
    { ...CHAIR, id: 3, claimed: true, active: 0, started_at: '2023-03-01', left_at: '2026-08-01',
      left_by: 'salon', tenure_disputed: 1, tenure_verified: { started: false, left: false } },
  ]);
  const page = rosterPage(async (endpoint) => {
    if (endpoint === '/api/partner/staff') {
      return list;
    }
    return assert.fail(`unexpected call: ${endpoint}`);
  });

  await page.load();

  /* One request for the whole grid. GET /api/partner/staff spreads stintFields() onto every
     row — the identical block staffDetail() is built from, so the two cannot drift — and the
     fan-out that used to fetch it, one GET /staff/:id per claimed row, is gone with the reason
     for it. Thirty chips off thirty questions was a page that got slower the better the salon
     did, and every one of those reads could fail on its own. */
  assert.deepEqual(page.asked, ['/api/partner/staff']);
  assert.doesNotMatch(rosterHtml, /loadStints/);
  const listRoute = handler(partnerSource, "router.get('/staff',", "router.post('/staff',");
  assert.match(listRoute, /\.\.\.stintFields\(member\),/);

  // The two the card actually reads, straight off the row the list handed over.
  assert.equal(page.staff[2].left_at, '2026-08-01');
  assert.equal(page.staff[2].tenure_disputed, 1);
  assert.equal(page.hasLeft(page.staff[2]), true);
  assert.equal(page.hasLeft(page.staff[0]), false);
  assert.equal(page.staff.length, 3);
  assert.deepEqual(page.toasts, []);
  assert.equal(page.loading, false);
});

test('the roster keeps a closed stint on the page and still drops a chair nobody claimed', () => {
  const page = rosterPage(async () => assert.fail('the roster is a filter, not a read'));
  page.staff = [
    { ...CHAIR, id: 1 },
    /* Somebody's stint, now closed. A record of who worked here and of a date she has to be
       able to answer for, so it stays on the page, dimmed. */
    { ...CHAIR, id: 2, claimed: true, active: 0 },
    { ...CHAIR, id: 3, claimed: true },
    // A soft-deleted chair nobody ever claimed is still gone: taking it off the list is the
    // whole of what deleting it ever meant.
    { ...CHAIR, id: 4, active: 0 },
  ];

  assert.deepEqual(page.roster().map((member) => member.id), [1, 2, 3]);
  assert.deepEqual(page.staff.map((member) => page.hasLeft(member)), [false, true, false, true]);

  // The shift badge and the next-shift line are both withheld once she has actually gone —
  // a different question from whether the stint has closed, and the next test is about it.
  assert.match(rosterHtml, /x-show="stillWorking\(member\)" x-text="onShift\(member\) \? 'Đang làm ca'/);
  assert.match(rosterHtml, /<div class="flex flex-col" x-show="stillWorking\(member\)">/);
  assert.match(rosterHtml, /:class="hasLeft\(member\) \? 'opacity-60' : ''"/);
  // The date beside "Đã nghỉ" is absent, never a placeholder, on a row that predates this
  // feature and therefore has no left_at.
  assert.match(
    rosterHtml,
    /<span x-show="member\.left_at" x-text="OAK\.fmtDate\(member\.left_at, 'short'\)"><\/span>/,
  );
});

test('a stint that has closed can still be working today, and the grid asks both', () => {
  const page = rosterPage(async () => assert.fail('this is a reading of the grid, not a read'));
  /* Relative to the real clock, like the departure test below: the page reads today through
     its own oakDateISO() and there is no seam to hold it still. */
  const now = new Date();
  const iso = (offset) => {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  };

  const rows = [
    // Open: on the roster, no date on it.
    { ...CHAIR, id: 1, claimed: true },
    /* A date ahead of today, which departureDateOrThrow() now refuses on both doors — but
       rows written before that ceiling landed still carry one, and this is a reading of
       whatever the row says rather than of what the API would accept for it today. She is
       not gone until the day she is dated for, and the owner runs the day off this grid. */
    { ...CHAIR, id: 2, claimed: true, active: 0, left_at: iso(18) },
    /* The case this actually answers now: a departure recorded FOR today. END_STINT sets
       active = 0 on the press, but the last day worked is a day worked — the sweep leaves
       that day's bookings on her, and the card has to agree with the calendar. */
    { ...CHAIR, id: 3, claimed: true, active: 0, left_at: iso(0) },
    { ...CHAIR, id: 4, claimed: true, active: 0, left_at: iso(-1) },
    // Deactivated before departures existed: no date to read, and she is not here.
    { ...CHAIR, id: 5, claimed: true, active: 0 },
    // On the roster with a date on it. Unreachable through END_STINT, which writes the pair
    // together — but "closed" has one meaning here and it answers this row too.
    { ...CHAIR, id: 6, claimed: true, left_at: iso(-5) },
  ];

  assert.deepEqual(
    rows.map((member) => page.hasLeft(member)),
    [false, true, true, true, true, true],
  );
  assert.deepEqual(
    rows.map((member) => page.stillWorking(member)),
    [true, true, true, false, false, false],
  );
});

test('the editor is told whether the row is on the roster, so its red button can ask', async () => {
  const list = rosterList([
    { ...CHAIR, id: 5, claimed: true },
    { ...CHAIR, id: 6, claimed: true, active: 0 },
  ]);
  const api = async (endpoint) => {
    if (endpoint === '/api/partner/staff') {
      return list;
    }
    if (endpoint === '/api/partner/staff/5' || endpoint === '/api/partner/staff/6') {
      return detailOf(Number(endpoint.slice(-1)));
    }
    return assert.fail(`unexpected call: ${endpoint}`);
  };
  const page = rosterPage(api);
  await page.load();

  await page.openStaff(page.staff[0]);
  assert.equal(page.form.active, 1);
  assert.equal(page.hasLeft(page.form), false);

  /* active = 0 with left_at null, which is reachable: active is patchable, and rows
     deactivated before departures existed are still in the table. END_STINT is guarded on
     active = 1, so "Kết thúc hợp tác" here is a button whose only answer is a 409. */
  await page.openStaff(page.staff[1]);
  assert.equal(page.form.active, 0);
  assert.equal(page.form.left_at, null);
  assert.equal(page.hasLeft(page.form), true);

  /* The flag comes off the list row beside `claimed`: GET /staff/:id answers with the
     profile the owner edits and says nothing about whether the row is on the roster. */
  assert.doesNotMatch(rosterHtml, /active: detail\.active/);
  // A row being created is open by definition, and form.id gates the button anyway.
  await page.openStaff(null);
  assert.equal(page.hasLeft(page.form), false);
});

test('a start date the owner only looked at is never sent back', async () => {
  const list = rosterList([{ ...CHAIR, id: 5, claimed: true }]);
  const api = async (endpoint) => {
    if (endpoint === '/api/partner/staff') {
      return list;
    }
    if (endpoint.startsWith('/api/partner/staff/5')) {
      return detailOf(5);
    }
    return assert.fail(`unexpected call: ${endpoint}`);
  };

  const page = rosterPage(api);
  await page.load();
  await page.openStaff(page.staff[0]);
  assert.equal(page.form.started_at, '2024-01-05');
  assert.equal(page.form.started_at_was, '2024-01-05');

  // A save that touched nothing but the job title.
  page.form.title = 'KTV trưởng';
  await page.submitStaff();

  /* THE point of started_at_was. PATCH /staff/:id appends RESET_STARTED_ATTESTATION on the
     PRESENCE of the key and not on a change to the value (routes/partner.js), so echoing the
     date back on every save would clear the technician's ✓ and her dispute each time the
     owner edited a title — and the note beside the field would never leave "chờ xác nhận". */
  const patched = page.sent.filter((call) => call.method === 'PATCH');
  assert.equal(patched.length, 1);
  assert.ok(
    !Object.hasOwn(patched[0].body, 'started_at'),
    'the unchanged start date rode along and reset the technician’s answer',
  );
  assert.equal(patched[0].body.title, 'KTV trưởng');

  // Moved, and it goes.
  page.form.started_at = '2024-02-01';
  await page.submitStaff();
  assert.equal(page.sent.filter((call) => call.method === 'PATCH')[1].body.started_at, '2024-02-01');

  /* Cleared, and it also goes: null is a value like any other here. Sending nothing would
     leave the old date standing, and the field the owner just emptied would fill itself back
     in on the next read. */
  const clearing = rosterPage(api);
  await clearing.load();
  await clearing.openStaff(clearing.staff[0]);
  clearing.form.started_at = '';
  await clearing.submitStaff();
  const cleared = clearing.sent.filter((call) => call.method === 'PATCH')[0];
  assert.ok(Object.hasOwn(cleared.body, 'started_at'));
  assert.equal(cleared.body.started_at, null);
});

test('a row being created carries whatever date the form was opened with', async () => {
  const api = async (endpoint, options) => {
    if (endpoint === '/api/partner/staff') {
      return options ? { id: 9 } : rosterList([]);
    }
    return assert.fail(`unexpected call: ${endpoint}`);
  };

  const page = rosterPage(api);
  await page.openStaff(null);
  page.form.name = 'Mai Lan';
  page.form.started_at = '2026-03-01';
  await page.submitStaff();

  // Nothing to compare against on a create, and nothing to reset either, so the key rides
  // unconditionally here — and carries null when the owner left the field alone.
  const created = page.sent.filter((call) => call.method === 'POST');
  assert.equal(created.length, 1);
  assert.equal(created[0].body.started_at, '2026-03-01');

  const blank = rosterPage(api);
  await blank.openStaff(null);
  blank.form.name = 'Mai Lan';
  await blank.submitStaff();
  const bare = blank.sent.filter((call) => call.method === 'POST')[0];
  assert.ok(Object.hasOwn(bare.body, 'started_at'));
  assert.equal(bare.body.started_at, null);
});

test('the departure posts the day, closes both dialogs and reads the sweep back', async () => {
  const list = rosterList([{ ...CHAIR, id: 5, claimed: true }]);
  const page = rosterPage(async (endpoint, options) => {
    if (endpoint === '/api/partner/staff/5/departure') {
      return { left_at: options.body.left_at, reassigned: 2, needs_attention: 1 };
    }
    if (endpoint === '/api/partner/staff') {
      return list;
    }
    if (endpoint === '/api/partner/staff/5') {
      return detailOf(5);
    }
    return assert.fail(`unexpected call: ${endpoint}`);
  });
  await page.load();
  await page.openStaff(page.staff[0]);

  page.endStint();
  assert.equal(page.confirmMode, 'departure');
  assert.equal(page.confirmMessage, 'Kết thúc hợp tác với "Phương Vy"?');
  assert.match(page.departureDate, /^\d{4}-\d{2}-\d{2}$/);

  /* The picker's ceiling is the server's, and both are today: departureDateOrThrow() refuses
     anything past it, because recording a departure is not scheduling one and active = 0 is
     written on the press. The dialog opens on today too, so the two are the same string. The
     past is left open on purpose — there is no lower bound, since writing a departure down
     weeks later is the ordinary case — and there is no lead allowance left on either side to
     keep in step, which is why the page carries no constant naming one. */
  assert.equal(page.departureMax(), page.departureDate);
  assert.doesNotMatch(rosterHtml, /MAX_LEAD_DAYS/);

  page.departureDate = '2026-09-01';
  await page.submitDeparture();

  const posted = page.sent.filter((call) => call.endpoint.endsWith('/departure'));
  assert.equal(posted.length, 1);
  assert.equal(posted[0].method, 'POST');
  assert.equal(JSON.stringify(posted[0].body), '{"left_at":"2026-09-01"}');
  // Both dialogs go: the confirm sits above the editor, and the row it was editing is closed.
  assert.equal(page.confirmOpen, false);
  assert.equal(page.staffModalOpen, false);
  assert.deepEqual(page.toasts, [['2 lịch đã chuyển, 1 lịch cần bạn xử lý', undefined]]);
  // And the grid is read again, because every row it is drawn from has just changed.
  assert.equal(page.asked.filter((endpoint) => endpoint === '/api/partner/staff').length, 2);
});

test('a refused departure stays inside the dialog, beside the date it is about', async () => {
  const list = rosterList([{ ...CHAIR, id: 5, claimed: true }]);
  const page = rosterPage(async (endpoint) => {
    if (endpoint === '/api/partner/staff/5/departure') {
      throw new Error('Ngày kết thúc quá xa trong tương lai.');
    }
    if (endpoint === '/api/partner/staff') {
      return list;
    }
    if (endpoint === '/api/partner/staff/5') {
      return detailOf(5);
    }
    return assert.fail(`unexpected call: ${endpoint}`);
  });
  await page.load();
  await page.openStaff(page.staff[0]);
  page.endStint();
  page.departureDate = '2030-01-01';

  await page.submitDeparture();

  // Closing would take the date field away with it, and every refusal here is about it.
  assert.equal(page.confirmOpen, true);
  assert.equal(page.confirmError, 'Ngày kết thúc quá xa trong tương lai.');
  assert.equal(page.departureDate, '2030-01-01');
  assert.deepEqual(page.toasts, []);
  assert.match(rosterHtml, /x-show="confirmError" x-text="confirmError"/);
});

test('the undo puts the row back with one flag, and says what it cannot give back', async () => {
  const list = rosterList([{ ...CHAIR, id: 5, name: 'Phương Vy', claimed: true, active: 0, left_at: '2026-08-01' }]);
  const page = rosterPage(async (endpoint, options) => {
    // The reply is the whole staffDetail row, which this page does not read: it re-reads.
    if (endpoint === '/api/partner/staff/5' && options) {
      return detailOf(5);
    }
    if (endpoint === '/api/partner/staff') {
      return list;
    }
    return assert.fail(`unexpected call: ${endpoint}`);
  });
  await page.load();

  // Opened off the card, so it carries the row's own id: the editor never saw this one.
  page.reopenStint(page.staff[0]);
  assert.equal(page.confirmMode, 'reopen');
  assert.equal(page.reopenId, 5);
  assert.equal(page.confirmMessage, 'Hủy ghi nhận nghỉ việc của "Phương Vy"?');
  assert.equal(page.confirmOpen, true);
  assert.equal(page.staffModalOpen, false);

  await page.submitReopen();

  /* One flag and nothing else. active = 1 on a claimed row that carries a leaving date IS the
     undo (routes/partner.js): the server clears left_at, left_by and the ✓ in the same
     statement and notifies the technician, and there is no left_at here to send because no
     route accepts one. */
  const patched = page.sent.filter((call) => call.method === 'PATCH');
  assert.equal(patched.length, 1);
  assert.equal(patched[0].endpoint, '/api/partner/staff/5');
  assert.equal(JSON.stringify(patched[0].body), '{"active":1}');

  assert.equal(page.confirmOpen, false);
  assert.equal(page.confirmBusy, false);
  assert.deepEqual(page.toasts, [['Đã hủy ghi nhận nghỉ việc.', undefined]]);
  // The whole grid is read again: active, left_at and the "Đã nghỉ" chip all moved together.
  assert.equal(page.asked.filter((endpoint) => endpoint === '/api/partner/staff').length, 2);

  // No date is asked for and none could be used — the date block is the departure's alone.
  const dialog = handler(rosterHtml, '<!-- Confirm Delete Modal.', '<!-- BottomNavBar');
  assert.equal((dialog.match(/type="date"/g) || []).length, 1);
  assert.match(dialog, /<div class="space-y-1" x-cloak="" x-show="confirmMode === 'departure'">/);
  const reopenBlock = handler(dialog, `<div class="space-y-2" x-cloak="" x-show="confirmMode === 'reopen'">`, '</div>');
  assert.doesNotMatch(reopenBlock, /<input/);
  // Honest about the half of it that does not come back: the sweep handed those hours on.
  assert.match(reopenBlock, /Lịch hẹn đã chuyển sang đồng nghiệp sẽ không tự quay lại\./);
  assert.match(reopenBlock, /kỹ thuật viên sẽ nhận được thông báo/);

  /* Putting somebody back on the roster is not a destructive act and is not dressed as one,
     and the dismiss says what it does to the row rather than "keep" — which had nothing to
     keep in front of an undo. */
  assert.match(rosterHtml, /:class="confirmMode === 'reopen' \? 'btn-primary' : 'btn-danger'"/);
  assert.match(
    rosterHtml,
    /x-text="confirmMode === 'departure' \? 'Kết thúc' : confirmMode === 'reopen' \? 'Hủy ghi nhận' : 'Xóa'"/,
  );
  assert.doesNotMatch(dialog, /Giữ lại\s*<\/button>/);
  assert.match(dialog, /Để nguyên\s*<\/button>/);
});

test('the undo is offered on the rows the server would accept it for, and nowhere else', () => {
  const page = rosterPage(async () => assert.fail('this is a reading of the grid, not a read'));

  /* Claimed AND a date on the row — the server's own `reopening` predicate, word for word,
     and NOT hasLeft(). An unclaimed row was never a collaboration and its whole deletion is
     the list; a claimed row still working has nothing to undo. */
  assert.match(
    rosterHtml,
    /@click\.stop="reopenStint\(member\)"[^>]*x-show="member\.claimed &amp;&amp; member\.left_at"/,
  );
  assert.match(
    partnerSource,
    /const reopening = staff\.user_id != null && staff\.left_at != null && patch\.active === 1;/,
  );
  const rows = [
    { ...CHAIR, id: 1, claimed: true },
    { ...CHAIR, id: 2, claimed: true, active: 0, left_at: '2026-08-01' },
    /* Deactivated before departures existed — hasLeft() says closed, and the button used to
       follow it here. It must not: `reopening` needs left_at, so on this row the PATCH puts
       the chair back and clears nothing, notifies nobody, and every word of the dialog over
       it — the title, "kỹ thuật viên sẽ nhận được thông báo", the toast — would be describing
       a departure that was never recorded. Out of scope on purpose. */
    { ...CHAIR, id: 3, claimed: true, active: 0 },
    { ...CHAIR, id: 4, active: 0, left_at: '2026-08-01' },
    CHAIR,
  ];
  assert.deepEqual(
    rows.map((member) => Boolean(member.claimed) && Boolean(member.left_at)),
    [false, true, false, false, false],
  );
  // And the gate really is a different question from the one the dim and the chip ask.
  assert.equal(page.hasLeft(rows[2]), true);

  /* It sits beside "Sửa" in the same footer and wears the same tone: the footer wraps rather
     than squeezing, because this label is a sentence and the shift block may be beside it. */
  assert.match(rosterHtml, /<div class="mt-auto pt-6 border-t border-outline-variant\/20 flex flex-wrap justify-between items-center gap-3">/);
  const footer = handler(rosterHtml, '<div class="mt-auto pt-6 border-t', '</template>');
  assert.doesNotMatch(footer, /text-error/);
});

test('a refused undo stays in the dialog and leaves the card exactly as it was', async () => {
  const list = rosterList([{ ...CHAIR, id: 5, claimed: true, active: 0, left_at: '2026-08-01' }]);
  const page = rosterPage(async (endpoint, options) => {
    if (endpoint === '/api/partner/staff/5' && options) {
      throw new Error('Không tìm thấy kỹ thuật viên này.');
    }
    if (endpoint === '/api/partner/staff') {
      return list;
    }
    return assert.fail(`unexpected call: ${endpoint}`);
  });
  await page.load();
  page.reopenStint(page.staff[0]);

  await page.submitReopen();

  // The dialog is the only place this refusal can be read, so it stays open holding it.
  assert.equal(page.confirmOpen, true);
  assert.equal(page.confirmError, 'Không tìm thấy kỹ thuật viên này.');
  assert.equal(page.confirmBusy, false);
  assert.deepEqual(page.toasts, []);
  // And nothing was re-read: the roster on screen is still the truth.
  assert.equal(page.asked.filter((endpoint) => endpoint === '/api/partner/staff').length, 1);
  assert.equal(page.staff[0].left_at, '2026-08-01');
});

test('the one red button under the editor asks whichever question the row deserves', () => {
  /* A chair nobody has claimed is a line in the salon's own list and deleting it is all it
     ever was; a row somebody holds is a collaboration, which ends on a day both sides can
     name — and DELETE /staff/:id refuses it with a 409 anyway. */
  assert.match(
    rosterHtml,
    /@click="form\.claimed \? endStint\(\) : removeStaff\(\)"[^>]*x-show="form\.id &amp;&amp; !hasLeft\(form\)"[^>]*x-text="form\.claimed \? 'Kết thúc hợp tác' : 'Xóa'"/,
  );
  /* The unconditional delete is gone rather than left standing beside the new one — and with
     it the old gate, which was `x-show="form.id"` alone: a closed stint has nothing left to
     end and the POST would 409, so the button has to go once the stint has closed. hasLeft()
     and not `!form.left_at`: END_STINT is guarded on active = 1, so a row taken off the
     roster without a date is one the POST refuses just the same. The "Mời lên OAK" block
     keeps its own bare form.id gate, which is why this looks at the button and not at the
     page. */
  const button = handler(rosterHtml, '<button @click="form.claimed ?', '</button>');
  assert.doesNotMatch(button, /@click="removeStaff\(\)"/);
  assert.doesNotMatch(button, /x-show="form\.id">/);
  // Both labels are x-text on the one button rather than two buttons with a text node each,
  // so the dictionary holds two phrases and the page can never show both.
  assert.doesNotMatch(button, />[^<]*Xóa/);

  // One dialog for both questions, so there is one escape key, one backdrop and one z-index
  // to keep straight above the edit modal.
  assert.match(
    rosterHtml,
    /@click="confirmMode === 'departure' \? submitDeparture\(\) : confirmMode === 'reopen' \? submitReopen\(\) : deleteStaff\(\)"/,
  );
  assert.equal((rosterHtml.match(/id="confirm-title"/g) || []).length, 1);
  assert.match(rosterHtml, /x-show="confirmMode === 'departure'"/);
  assert.match(rosterHtml, /x-show="confirmMode === 'reopen'"/);

  /* The notes beside the start date are decided in one method rather than in two x-show
     expressions, so they cannot both appear and cannot both vanish. */
  for (const state of ['pending', 'confirmed']) {
    assert.match(rosterHtml, new RegExp(`x-show="startedState\\(\\) === '${state}'"`), state);
  }
});

test("the console's own note on the start date reads the same rule the CV does", () => {
  const page = rosterPage(async () => assert.fail('startedState is a reading, not a read'));

  // Nothing to have answered on a row that does not exist yet, or one with no date on it.
  page.form = { id: null, started_at: '2024-01-05', tenure_disputed: 0, tenure_verified: {} };
  assert.equal(page.startedState(), '');
  page.form = { id: 5, started_at: '', tenure_disputed: 0, tenure_verified: {} };
  assert.equal(page.startedState(), '');

  /* tenure_verified again, and never started_confirmed_at: this note and the ✓ on the public
     CV are the same claim about the same column, and lib/staff-stats.js is the one place it
     is decided. A console that re-derived it could tell the owner "đã xác nhận" over a date
     the technician's own profile shows as unverified. */
  const form = { id: 5, started_at: '2024-01-05', tenure_disputed: 0, tenure_verified: { started: true } };
  page.form = form;
  assert.equal(page.startedState(), 'confirmed');
  page.form = { ...form, tenure_verified: { started: false } };
  assert.equal(page.startedState(), 'pending');
  assert.doesNotMatch(rosterHtml, /started_confirmed|left_confirmed/);
});

test('a dispute is one flag over the stint, so the console never hangs it on the start date', () => {
  const page = rosterPage(async () => assert.fail('startedState is a reading, not a read'));
  const form = {
    id: 5, started_at: '2024-01-05', left_at: null,
    tenure_disputed: 1, tenure_verified: { started: false, left: false },
  };

  /* Nothing beside Ngày vào làm while a dispute stands, in either direction. "Đang khiếu
     nại ngày này" attributes to the start date an objection that may be about the leaving
     date — the flag is one column over the stint (db.js) and confirming either date clears
     it. And "chờ xác nhận" would be no better on the row below: POST /tenure/:id/dispute
     does not clear started_confirmed_at, so a technician who confirmed this date and then
     disputed the OTHER one reaches here with her ✓ intact and only suspended. */
  page.form = form;
  assert.equal(page.startedState(), '');
  page.form = { ...form, tenure_verified: { started: true, left: false } };
  assert.equal(page.startedState(), '');
  const disputeRoute = handler(staffMeSource, "router.post('/tenure/:staffId/dispute'", '\n});');
  assert.match(disputeRoute, /UPDATE staff SET tenure_disputed = 1 WHERE id = \? AND user_id = \?/);
  assert.doesNotMatch(disputeRoute, /confirmed_at/);

  // Cleared, and the note comes straight back on the value underneath it.
  page.form = { ...form, tenure_disputed: 0 };
  assert.equal(page.startedState(), 'pending');

  // The wording that hung it on one date is gone, and no note beside the field is gated on it.
  assert.doesNotMatch(rosterHtml, /khiếu nại ngày này/);
  assert.doesNotMatch(rosterHtml, /startedState\(\) === 'disputed'/);

  /* The dispute has its own gate instead — form.id and the flag, and nothing about
     started_at — so a stint the salon never dated still says in the modal what the card chip
     behind it is already saying. That is the case the old note could not reach at all:
     startedState() answers '' with no date, and the owner opened the modal to find nothing. */
  assert.match(rosterHtml, /x-show="form\.id &amp;&amp; form\.tenure_disputed === 1"/);
  assert.match(
    rosterHtml,
    /Kỹ thuật viên đang khiếu nại ngày làm việc của cả quá trình này, không riêng một mốc ngày\./,
  );

  /* And it does not pretend the modal can fix the day she is probably objecting to — left_at
     is not in STAFF_COLUMNS, so PATCH /staff/:id cannot carry it and this form has no field
     for it — but it no longer says the date is unfixable either. It names the one correction
     there is: the undo on the card, then the departure dialog again. Beside it, the one edit
     the form CAN make is labelled with what it does to the dispute, since
     RESET_STARTED_ATTESTATION sets the flag back to 0 whatever the objection was about. */
  const columns = handler(partnerSource, 'const STAFF_COLUMNS = {', '\n};');
  assert.doesNotMatch(columns, /left_at/);
  assert.doesNotMatch(rosterHtml, /chưa sửa được ở đây/);
  assert.match(
    rosterHtml,
    /Sửa ngày này bằng cách hủy ghi nhận nghỉ việc trên thẻ nhân viên, rồi ghi nhận lại\./,
  );
  assert.match(rosterHtml, /x-text="OAK\.fmtDate\(form\.left_at, 'short'\)"/);
  assert.match(rosterHtml, /Đổi ngày vào làm sẽ gỡ khiếu nại/);
  assert.match(partnerSource, /RESET_STARTED_ATTESTATION = 'started_confirmed_at = NULL, tenure_disputed = 0'/);
});

test('the "đang làm ca" tile counts the cards the badges are on, not meta.on_shift', () => {
  const page = rosterPage(async () => assert.fail('this is a reading of the grid, not a read'));
  const now = new Date();
  const iso = (offset) => {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  };
  const working = { start: '09:00', end: '18:00', is_off: false };

  page.staff = [
    { ...CHAIR, id: 1, shift: working },
    // Dated ahead of today, which only a row written before the ceiling can be. active = 0
    // and so out of meta.on_shift, but she is here today: the badge on her card says "Đang
    // làm ca" and the tile has to agree with it.
    { ...CHAIR, id: 2, claimed: true, active: 0, left_at: iso(12), shift: working },
    // The last day worked is a day worked.
    { ...CHAIR, id: 3, claimed: true, active: 0, left_at: iso(0), shift: working },
    // Gone yesterday, and gone with no date at all: neither is on shift today.
    { ...CHAIR, id: 4, claimed: true, active: 0, left_at: iso(-1), shift: working },
    { ...CHAIR, id: 5, claimed: true, active: 0, shift: working },
    // Here, and off today.
    { ...CHAIR, id: 6, shift: { ...working, is_off: true } },
    // Here, with no shift on the books for today at all.
    { ...CHAIR, id: 7, shift: null },
  ];

  // Exactly the rows whose card carries the badge: stillWorking() AND onShift(), the pair
  // the badge itself is drawn from, over the rows roster() puts on the page.
  assert.deepEqual(
    page.roster().filter((member) => page.stillWorking(member) && page.onShift(member))
      .map((member) => member.id),
    [1, 2, 3],
  );
  assert.equal(page.onShiftToday(), 3);

  /* The server's own count is a third question — active = 1 with a shift today — and the tile
     may not be read off it any more: three cards saying "Đang làm ca" over a tile reading 2
     is the same page answering itself. */
  assert.match(partnerSource, /if \(member\.active === 1 && today_shift && !today_shift\.is_off\)/);
  assert.doesNotMatch(rosterHtml, /x-text="stats\.on_shift"/);
  assert.match(rosterHtml, /x-text="onShiftToday\(\)"/);
});

// ------------------------------------------- an hour with nobody behind it, on the calendar

/**
 * oakPartnerBookings() over a stand-in browser, standing on a roster already in hand.
 *
 * Nothing below reads: every question these tests ask is a reading of the roster the page was
 * handed, the stint on each row included. A call is recorded on `asked` and then fails, so a
 * test can both assert the emptiness and see what broke it.
 */
function bookingsPage(staff) {
  const tail = consoleHtml.slice(consoleHtml.indexOf('var OAK_BOOKING_CLASSES'));
  const script = tail.slice(0, tail.lastIndexOf('oakPartnerChrome();'));
  const asked = [];
  const context = {
    URLSearchParams,
    document: {
      title: 'OAK',
      visibilityState: 'visible',
      activeElement: null,
      getElementById: () => null,
      addEventListener: () => {},
      querySelectorAll: () => [],
      querySelector: () => null,
    },
    setInterval: () => {},
    OAK: {
      api: async (endpoint) => {
        asked.push(endpoint);
        return assert.fail(`staffLeft is a reading of the roster, not a read of it: ${endpoint}`);
      },
      toast: () => {},
      fmtDate: (value) => value,
      fmtPrice: (value) => value,
      todayISO: () => '2026-08-28',
      qs: () => null,
      pendingBadge: async () => 0,
      setPendingBadge: () => {},
      requirePartner: async () => {},
      me: async () => ({ name: 'Thu Trang' }),
      bookingStatus: () => ({ label: '', icon: '', class: '' }),
      BOOKING_STATUSES: ['pending', 'confirmed', 'completed', 'cancelled', 'no_show'],
    },
  };
  vm.runInNewContext(`${script}\nresult = oakPartnerBookings();`, context);
  context.result.staff = staff;
  return Object.assign(context.result, { asked });
}

test('an hour whose technician is off the roster is flagged, and only while somebody can act', () => {
  const page = bookingsPage([
    { id: 2, name: 'Lan Khuê', active: 1 },
    { id: 3, name: 'Phương Vy', active: 0 },
  ]);
  const booking = (staffId, status = 'confirmed') => ({
    id: 7, status, staff: staffId === null ? null : { id: staffId, name: 'x' },
  });

  // On the roster and working: the ordinary case, and no chip.
  assert.equal(page.staffLeft(booking(2)), false);
  // Her stint closed. Read off the same list the columns are drawn from.
  assert.equal(page.staffLeft(booking(3)), true);
  /* And a row missing from that list entirely counts too — a chair the salon deleted outright
     leaves bookings behind it, and those hours have nobody behind them just the same. */
  assert.equal(page.staffLeft(booking(99)), true);
  // "Bất kỳ": nobody was ever assigned, so nobody has left.
  assert.equal(page.staffLeft(booking(null)), false);

  /* Only said about a booking somebody can still act on. A completed or cancelled visit is a
     record of a day that is over, and a warning there is one the salon would have to scroll
     past forever without ever being able to answer it. */
  assert.deepEqual(
    ['pending', 'confirmed', 'completed', 'cancelled', 'no_show']
      .map((status) => [status, page.staffLeft(booking(3, status))]),
    [
      ['pending', true],
      ['confirmed', true],
      ['completed', false],
      ['cancelled', false],
      ['no_show', false],
    ],
  );

  /* Twice on the page and nowhere else, in both places the same call: the list is the window
     that spans every day still ahead, and the detail panel is where the hour actually gets
     handed on, through the staff select in Đổi lịch. */
  for (const subject of ['booking', 'detail']) {
    assert.match(
      consoleHtml,
      new RegExp(`x-cloak="" x-show="staffLeft\\(${subject}\\)">KTV đã nghỉ</span>`),
      subject,
    );
  }
  assert.equal((consoleHtml.match(/KTV đã nghỉ/g) || []).length, 2);
});

test('an hour up to the last day worked still has the technician it was sold with', () => {
  /* The sweep moves only b.date > left_at — "an appointment ON the leaving date is one they
     are still there for" — so an hour up to and including the last day worked stays on her
     calendar on purpose. Branding those sends the owner off to reassign an hour that never
     needed touching, or to cancel on a customer.

     The rows below are dated ahead of the leaving date the console can now record (today at
     the latest, departureDateOrThrow): the console reads whatever left_at the row carries and
     compares it to whatever date the booking has, and a departure entered weeks after the
     fact leaves exactly this shape behind — a closed stint with bookings on both sides of
     its date. */
  assert.match(departureSource, /AND b\.status IN \('pending','confirmed'\) AND b\.date > \?/);

  const page = bookingsPage([
    { id: 2, name: 'Lan Khuê', active: 1, claimed: true },
    { id: 3, name: 'Phương Vy', active: 0, claimed: true, left_at: '2026-09-15' },
    // Off the roster with no date to compare against — a row that predates the feature. The
    // flag alone answers, which is where this started.
    { id: 4, name: 'Mai Lan', active: 0, claimed: true },
  ]);
  const on = (staffId, date) => page.staffLeft({
    id: 7, status: 'confirmed', date, staff: { id: staffId, name: 'x' },
  });

  assert.deepEqual(
    [
      on(3, '2026-09-05'), // before the last day worked
      on(3, '2026-09-15'), // the last day worked itself
      on(3, '2026-09-16'), // after it, where the sweep did reach
      on(2, '2026-09-16'), // still on the roster
      on(4, '2026-09-16'), // a flag with no date behind it
      on(99, '2026-09-16'), // no row at all
    ],
    [false, false, true, false, true, true],
  );
});

test('the day grid brands a leftover column by the day it is drawn for, not by the flag', () => {
  /* The column list is activeStaff(), active === 1, so a technician whose stint has closed is
     not in it and her bookings land in the leftover column below — which used to name itself
     "<name> (đã nghỉ)" on the strength of that same flag. The owner writes the departure down
     on 11/09, the last day Nguyệt actually worked, and then pages the day grid back to 05/09
     to look at a day she did work: the list view showed her booking with no chip, the detail
     panel showed no chip, and the grid headed her column "đã nghỉ". One page, one booking,
     both answers. */
  const page = bookingsPage([
    { id: 2, name: 'Lan Khuê', active: 1, claimed: true },
    { id: 3, name: 'Nguyệt', active: 0, claimed: true, left_at: '2026-09-11' },
    { id: 4, name: 'Mai Lan', active: 0, claimed: true, left_at: '2026-08-01' },
    // Off the roster with no date behind it: the flag alone still answers.
    { id: 5, name: 'Thu Hà', active: 0, claimed: true },
  ]);
  const booking = (id, staffId, date) => ({
    id, status: 'confirmed', date, staff: { id: staffId, name: page.staff.find((m) => m.id === staffId).name },
  });
  const named = (date, ...bookings) => {
    page.date = date;
    page.bookings = bookings;
    return page.columns.map((column) => column.name);
  };

  // A day before the last one she worked. She was there for this hour — the sweep in
  // lib/staff-departure.js left it on her on purpose — so the column carries her name plainly.
  assert.deepEqual(
    named('2026-09-05', booking(1, 3, '2026-09-05')),
    ['Lan Khuê', 'Nguyệt'],
  );
  // The last day worked is a day worked, and the day after it is not.
  assert.deepEqual(named('2026-09-11', booking(1, 3, '2026-09-11')), ['Lan Khuê', 'Nguyệt']);
  assert.deepEqual(named('2026-09-12', booking(1, 3, '2026-09-12')), ['Lan Khuê', 'Nguyệt (đã nghỉ)']);
  // Gone in August, and gone with no date at all.
  assert.deepEqual(named('2026-09-05', booking(1, 4, '2026-09-05')), ['Lan Khuê', 'Mai Lan (đã nghỉ)']);
  assert.deepEqual(named('2026-09-05', booking(1, 5, '2026-09-05')), ['Lan Khuê', 'Thu Hà (đã nghỉ)']);

  /* One predicate, so the header and the chip cannot disagree about the same booking on the
     same screen. staffLeft() is the chip and adds only its own status gate; both sit on
     staffGone(), and the column asks it about the day the card is on. */
  const inside = booking(1, 3, '2026-09-05');
  const after = booking(2, 3, '2026-09-12');
  assert.equal(page.staffLeft(inside), false);
  assert.equal(page.staffLeft(after), true);
  assert.equal(page.staffGone(3, '2026-09-05'), false);
  assert.equal(page.staffGone(3, '2026-09-12'), true);
  // A column is about the day, not about one card's status: the chip's gate stays on the chip.
  assert.equal(page.staffLeft({ ...after, status: 'completed' }), false);
  assert.equal(page.staffGone(3, after.date), true);
  assert.deepEqual(
    named('2026-09-12', { ...after, status: 'completed' }),
    ['Lan Khuê', 'Nguyệt (đã nghỉ)'],
  );

  // Read through the one predicate in the source too, so a second copy of the rule cannot
  // creep back into the getter.
  assert.match(consoleHtml, /name: self\.staffGone\(booking\.staff\.id, booking\.date\)\s*\n\s*\? booking\.staff\.name \+ ' \(đã nghỉ\)'/);
  assert.equal((consoleHtml.match(/\(đã nghỉ\)/g) || []).length, 1);
});

test('the calendar reads the stint off the roster it was handed, and asks nothing more', () => {
  /* Every list row carries left_at now — stintFields() is spread onto the list and onto
     staffDetail alike — so the fan-out that ran off the back of the roster read is gone: it
     fetched one GET /staff/:id per claimed, inactive row for the single field the list was
     missing. Nothing follows the roster read inside init()'s try any more. */
  assert.doesNotMatch(consoleHtml, /loadStints/);
  assert.match(
    consoleHtml,
    /this\.services = await OAK\.api\('\/api\/partner\/services'\);\s*\n\s*\} catch \(error\) \{/,
  );

  const page = bookingsPage([
    { id: 1, name: 'Lan Khuê', active: 1, claimed: true, left_at: null },
    { id: 2, name: 'Phương Vy', active: 0, claimed: true, left_at: '2026-08-01' },
    // An unclaimed chair the salon deleted, and a row off the roster with no date behind it:
    // neither ever had a detail worth fetching, and the flag alone still answers for both.
    { id: 3, name: 'Ghế trống', active: 0, claimed: false, left_at: null },
    { id: 4, name: 'Mai Lan', active: 0, claimed: true, left_at: null },
  ]);
  const on = (staffId, date) => page.staffLeft({
    id: 7, status: 'confirmed', date, staff: { id: staffId, name: 'x' },
  });

  // The date the list supplied still decides it, exactly as it did when a second request
  // fetched that date: up to and including the last day worked is hers, after it is not.
  assert.deepEqual(
    [
      on(1, '2026-08-05'),
      on(2, '2026-07-20'),
      on(2, '2026-08-01'),
      on(2, '2026-08-02'),
      on(3, '2026-08-05'),
      on(4, '2026-08-05'),
    ],
    [false, false, false, true, true, true],
  );
  assert.equal(page.staffGone(2, '2026-08-01'), false);
  assert.equal(page.staffGone(2, '2026-08-02'), true);
  // And not one request went out for any of it.
  assert.deepEqual(page.asked, []);
});

// -------------------------------------------------------------- what the two legal pages say

test('each legal page gained one section at the end, and nothing above it moved', () => {
  /* Both pages are numbered prose with a chip nav over the top, so the two things that break
     are a chip pointing at an id nobody has and a number that shifted underneath the other
     page's cross-reference. Read as whole lists rather than as substrings, so an insertion
     anywhere but the end fails here.

     Note test/seo-ui.test.mjs pins /Phiên bản 1\.1/ on dieu-khoan.html. That line names the
     mục-7 revision and was deliberately not bumped, so it is left exactly as it stands. */
  const pages = [
    ['dieu-khoan.html', termsHtml, 'chuyen-vien', '9. Dành cho chuyên viên', [
      've-oak-beauty', 'tai-khoan', 'huy-lich', 'gia-va-thanh-toan',
      'noi-dung-nguoi-dung', 'trach-nhiem', 'doi-tac', 'thay-doi-dieu-khoan',
    ]],
    ['bao-mat.html', privacyHtml, 'chuyen-vien-du-lieu', '8. Tài khoản chuyên viên', [
      'du-lieu-thu-thap', 'muc-dich-su-dung', 'cookie-va-phien', 'luu-tru-va-bao-mat',
      'quyen-cua-ban', 'tre-vi-thanh-nien', 'lien-he-du-lieu',
    ]],
  ];

  for (const [name, html, id, heading, before] of pages) {
    const ids = [...html.matchAll(/<article[^>]*id="([^"]+)"/g)].map((hit) => hit[1]);
    // Appended, and appended once: every section that was there is still there, in order.
    assert.deepEqual(ids, [...before, id], name);

    // Every chip resolves to a section, and in the order the sections appear in.
    const chips = [...html.matchAll(/href="#([^"]+)"/g)].map((hit) => hit[1]);
    assert.deepEqual(chips, ids, `${name}: the nav and the sections have come apart`);

    /* The numbers run consecutively from 1, so the new section is the next one rather than a
       second "8." — and no earlier heading was renumbered to make room, which is what would
       silently break the other page's "mục N" cross-reference below. */
    const numbers = [...html.matchAll(/<h2[^>]*>(\d+)\. /g)].map((hit) => Number(hit[1]));
    assert.deepEqual(numbers, ids.map((entry, index) => index + 1), name);
    assert.match(html, new RegExp(`id="${id}">\\s*<h2[^>]*>${heading}</h2>`), name);
  }

  // And the two new sections point at each other by the ids just pinned, so neither
  // cross-reference can rot without failing above.
  assert.match(termsHtml, /href="bao-mat\.html#chuyen-vien-du-lieu">Chính sách bảo mật<\/a>/);
  assert.match(privacyHtml, /href="dieu-khoan\.html#chuyen-vien">Điều khoản sử dụng<\/a>/);
  // Each names the other's number in prose too, which is the half a chip href cannot check.
  assert.match(termsHtml, /xem mục 8 trang/);
  assert.match(privacyHtml, /có tại mục 9 trang/);
});

// ------------------------------------------- the page a stint outlives, once the stint ends

const wizardHtml = ui('dat-lich.html');
const serviceHtml = ui('chi-tiet-dich-vu.html');

/**
 * oakStaffProfile() over a server answering the way the real one answers once a stint has
 * ENDED: the profile and the reviews still come back — the CV is the whole reason this page
 * outlives the job — while /availability and /services resolve through `staffIdOrThrow`,
 * which is `active = 1`, and both 404.
 *
 * `fails` overrides any single read with an error of its own, which is how the difference
 * between "she has left" and "the connection dropped" is put to the page. Every request is
 * recorded, because the other half of the contract is that the page does not go back for
 * more hours it cannot sell.
 */
function formerPage({ history = [], onRoster = true, fails = {} } = {}) {
  const tail = profileHtml.slice(profileHtml.indexOf('function oakTodayISO('));
  const calls = [];
  const gone = () => {
    const error = new Error('Không tìm thấy kỹ thuật viên này.');
    error.code = 'NOT_FOUND';
    return error;
  };
  const reviews = Object.assign(
    [{ id: 3, rating: 5, comment: 'Rất khéo tay.', user: { name: 'Ngọc Anh' } }],
    { meta: { total: 1, average: 5 } },
  );
  const answer = (name, value) => {
    if (fails[name]) {
      throw fails[name];
    }
    if (!onRoster && (name === 'availability' || name === 'services')) {
      throw gone();
    }
    return value;
  };
  const context = {
    URLSearchParams,
    location: { href: 'https://oak.test/ho-so-chuyen-gia.html?id=7' },
    navigator: {},
    window: {},
    OAK: {
      qs: (name) => (name === 'id' ? '7' : null),
      meta: () => {},
      fmtDate: (value) => value,
      toast: () => {},
      api: async (url) => {
        calls.push(url);
        if (url.includes('/availability')) {
          return answer('availability', {
            week: [{ date: '2026-08-29', slots: [{ time: '09:00', available: true }] }],
          });
        }
        if (url.endsWith('/services')) {
          return answer('services', [{ id: 9, name: 'Sơn Gel Cơ Bản' }]);
        }
        if (url.includes('/reviews')) {
          return answer('reviews', reviews);
        }
        if (url.endsWith('/history')) {
          return answer('history', history);
        }
        return answer('profile', {
          id: 7, name: 'Mai Chi', title: 'KTV', specialty: 'Vẽ móng', bio: 'Mười năm nghề.',
          image: 'a.webp', rating: 4.8, years_experience: 10, portfolio: [],
          salon: { id: 4, slug: 'lala', name: 'Lala Nail Studio' }, stats: COUNTED,
        });
      },
    },
  };
  vm.runInNewContext(
    `${tail.slice(0, tail.indexOf('</script>'))}\nresult = oakStaffProfile();`,
    context,
  );
  context.result.calls = calls;
  return context.result;
}

/** The two stints above, belonging to the row this page is about. */
const LEFT_STINT = { ...CLOSED_STINT, staff_id: 7 };
const OPEN_STINT = { ...STINT, staff_id: 7 };

test('a technician who has left keeps her page, and it stops selling hours', async () => {
  const page = formerPage({ history: [LEFT_STINT], onRoster: false });
  await page.init();

  /* The headline case: two of the five reads 404 for a closed row, and before the catches
     went on they took the whole Promise.all down with them — leaving "Không tải được hồ sơ
     chuyên gia." where the CV was meant to be, which is the one thing this feature exists
     to put on screen. */
  assert.equal(page.loadError, '');
  assert.equal(page.loading, false);
  assert.equal(page.staff.name, 'Mai Chi');
  assert.equal(page.history.length, 1);
  assert.equal(page.completedTotal(), 10);

  // What the 404s cost, and all they cost: the week grid and the service chips.
  assert.equal([...page.week].length, 0);
  assert.equal([...page.services].length, 0);
  assert.equal(page.workingDays().length, 0);
  // The reviews stand behind the profile's own gate, so they answer for her and are read.
  assert.equal([...page.reviews].length, 1);
  assert.equal(page.reviewMeta.total, 1);

  assert.equal(page.departed(), true);
  /* And nothing asks for the week a second time. loadWeek() has two ways in — a service chip
     and the retry beside a failed read — and a closed row has neither: the chips are gated on
     a service list that came back empty, and no read failed loudly enough to raise a retry. */
  assert.equal(page.calls.filter((url) => url.includes('/availability')).length, 1);
  assert.equal(page.weekError, '');
  assert.match(profileHtml, /<div class="mb-6 flex flex-col gap-3" x-show="services\.length">/);
  assert.match(profileHtml, /x-show="weekError"[\s\S]{0,400}?@click="loadWeek\(\)"/);
});

test('the availability 404 costs the page its grid, and the profile read still speaks for itself', async () => {
  /* The soft reads carry their own catch so no one of them can blank a page that otherwise
     arrived. The reviews do NOT: GET /:id/reviews is gated on visibleStaffIdOrThrow, the same
     gate as the profile beside it, so it cannot 404 for a departed row and has no failure of
     its own to survive — and a catch there would render "chưa có đánh giá" over forty of them
     and drop the star average with it. */
  assert.match(profileHtml, /'\/availability\?from=' \+ oakTodayISO\(\) \+ '&days=7'\)\r?\n\s*\.catch\(\(\) => null\)/);
  assert.match(profileHtml, /OAK\.api\('\/api\/staff\/' \+ id \+ '\/reviews'\),/);
  assert.doesNotMatch(profileHtml, /'\/reviews'\)\.catch/);
  /* And that really is one gate and not two that happen to agree today: the profile resolves
     through selectStaffProfile and the reviews through visibleStaffIdOrThrow's own existence
     query, and both are the same predicate pair. Whatever 404s one 404s the other. */
  assert.match(handler(staffSource, "router.get('/:id/reviews'", '\n});'), /visibleStaffIdOrThrow\(/);
  for (const [name, from] of [
    ['profile', 'const selectStaffProfile = db.prepare('],
    ['reviews', 'const selectVisibleStaffExists = db.prepare('],
  ]) {
    assert.match(
      handler(staffSource, from, ');'),
      /\$\{CLAIMED_OR_ON_ROSTER\} AND \$\{VISIBLE_PROFILE\}/,
      name,
    );
  }

  /* A caught availability read hands back null, and the assignment site keeps the shape the
     markup binds to: `week` an array to filter. But null is NOT an empty week — for a
     technician who is still working it is a dropped connection, and rendering "Chưa có lịch
     trống trong tuần này." over it shows a fully free technician as fully booked with no way
     back. She gets the error line and the "Thử lại" beside it instead. */
  const broken = formerPage({
    history: [OPEN_STINT],
    fails: { availability: new Error('Mất kết nối.') },
  });
  await broken.init();
  assert.equal(broken.loadError, '');
  assert.equal(broken.staff.name, 'Mai Chi');
  assert.equal(broken.departed(), false);
  assert.equal([...broken.week].length, 0);
  assert.equal(broken.weekError, 'Không tải được lịch trống.');
  // The reads that did answer are untouched by it.
  assert.equal([...broken.reviews].length, 1);
  assert.equal(broken.reviewMeta.total, 1);

  /* And the same null, on a row whose stint has closed, stays silent: there the 404 is the
     expected answer and the line over the grid has already explained it. An error block there
     would be the page telling a visitor something went wrong with a page that is working. */
  const departed = formerPage({ history: [LEFT_STINT], onRoster: false });
  await departed.init();
  assert.equal(departed.departed(), true);
  assert.equal([...departed.week].length, 0);
  assert.equal(departed.weekError, '');

  /* The reviews now stand or fall with the profile, which is what the server already decided.
     A transport failure there is a failure of the page, said once by the outer catch, rather
     than forty reviews quietly becoming none. */
  const noReviews = formerPage({
    history: [OPEN_STINT],
    fails: { reviews: new Error('Mất kết nối.') },
  });
  await noReviews.init();
  assert.equal(noReviews.staff, null);
  assert.equal(noReviews.loadError, 'Không tải được hồ sơ chuyên gia.');

  /* The profile read deliberately keeps no catch of its own. There is no page without it, and
     the outer catch is already the right handler: it tells a 404 — no such specialist, its own
     quiet panel — from a cold server, which gets the error line and a way back in. A
     `.catch(() => null)` here would hand both the same blank page and lose that distinction. */
  const profileRead = handler(profileHtml, "OAK.api('/api/staff/' + id)", ',');
  assert.doesNotMatch(profileRead, /catch/);

  const missing = formerPage({
    fails: { profile: Object.assign(new Error('Không tìm thấy chuyên gia này.'), { code: 'NOT_FOUND' }) },
  });
  await missing.init();
  assert.equal(missing.staff, null);
  assert.equal(missing.loadError, '');

  const cold = formerPage({ fails: { profile: new Error('Máy chủ chưa sẵn sàng.') } });
  await cold.init();
  assert.equal(cold.staff, null);
  assert.equal(cold.loadError, 'Không tải được hồ sơ chuyên gia.');
});

test('a technician still at work is untouched by any of it', async () => {
  const page = formerPage({ history: [OPEN_STINT] });
  await page.init();

  assert.equal(page.departed(), false);
  assert.equal(page.workingDays().length, 1);
  assert.equal([...page.services].length, 1);
  assert.equal(page.bookingUrl(), 'dat-lich.html?salon_id=4&staff_id=7');

  // And a profile with no CV at all is nobody's departure either: the page cannot say a stint
  // has ended on the strength of a list that never arrived.
  const noHistory = formerPage({ fails: { history: new Error('Không tải được quá trình.') } });
  await noHistory.init();
  assert.equal(noHistory.history.length, 0);
  assert.equal(noHistory.departed(), false);
});

test('departure is read off the CV, and never off a request that failed', async () => {
  /* The lie this page must not tell. /availability 404s for a technician who has left — and
     it also fails on a dropped connection, a cold server and a phone in a lift. A page that
     read one as the other would tell visitors a technician still at work had gone, on the
     strength of a request that would have succeeded a second later. */
  const flaky = formerPage({
    history: [OPEN_STINT],
    fails: { availability: new Error('Mất kết nối.') },
  });
  await flaky.init();
  assert.equal(flaky.departed(), false);

  const helper = handler(profileHtml, '            departed() {', '            },');
  assert.match(helper, /this\.history\.find\(\(entry\) => entry\.staff_id === this\.staff\.id\)/);
  assert.match(helper, /!stint\.is_current/);
  // Nothing about the week, the failed read or the service list gets a vote.
  assert.doesNotMatch(helper, /week|weekError|services|left_at/);

  /* is_current is the server's own answer to the same question — left_at IS NULL AND
     active = 1 — so the page never works it out from two columns of its own. */
  assert.match(
    declaration(staffSource, 'async function stintShape('),
    /is_current: row\.left_at === null && row\.active === 1,/,
  );
  // And GET /api/staff/:id carries no roster flag at all, which is why the CV is the signal.
  const detail = handler(staffSource, "router.get('/:id',", 'export default router');
  assert.doesNotMatch(detail, /active|left_at|is_current/);
});

test('what a departure takes off the page is the booking, and nothing else', () => {
  // One quiet line where the week grid was: no error colour, no retry, nothing failed.
  assert.match(
    profileHtml,
    /<p class="font-body-md text-body-md text-on-surface-variant" x-show="departed\(\)">Kỹ thuật viên hiện không nhận lịch mới qua OAK\.<\/p>/,
  );
  assert.match(profileHtml, /pb-4" x-show="!departed\(\)">Lịch trống tuần này<\/h3>/);
  // "Chưa có lịch trống" is a week that happens to be full, which this is not.
  assert.match(profileHtml, /x-show="!departed\(\)">Chưa có lịch trống trong tuần này\.<\/p>/);

  // Both booking buttons go; "Xem đánh giá" stays, because the reviews are still there.
  assert.match(profileHtml, /<template x-if="!departed\(\)">\s*<a :href="bookingUrl\(\)" style="display:contents/);
  assert.match(profileHtml, /<template x-if="!departed\(\)">\s*<div class="fixed bottom-0[^"]*" data-oak-sticky-cta>/);
  const cta = handler(profileHtml, '<div class="mt-8 flex gap-4">', '</div>');
  assert.equal((cta.match(/departed\(\)/g) || []).length, 1, 'the reviews button was gated too');
  assert.match(cta, /<a href="#danh-gia"/);

  // The salon line stops claiming she is there, which is the other thing that would be false.
  assert.match(
    profileHtml,
    /<span x-show="!departed\(\)">Làm việc tại<\/span>\s*<span x-show="departed\(\)">Từng làm việc tại<\/span>/,
  );

  /* And the CV and its legend carry no departure gate of any kind: they are what the page is
     for once the stint has ended, and they are the sections that must render. */
  const cv = handler(profileHtml, '>Quá trình làm việc</h2>', '</section>');
  assert.doesNotMatch(cv, /departed\(\)/);
  const legend = handler(profileHtml, '>Chú giải</span>', '</section>');
  assert.doesNotMatch(legend, /departed\(\)/);
  assert.match(profileHtml, /<section class="mt-section-gap" x-show="history\.length">/);
});

// --------------------------------------- the chip in the picker, on both pages that draw one

/**
 * One of the two technician pickers, lifted out of its page and driven. Everything a pick
 * fans out to — the slot read, the day strip, the quote — is stubbed away, so what is left is
 * the single decision these tests are about.
 *
 * `tracking` describes the browser rather than the page: one served from cache can meet an
 * oak-api.js from before any of this was measured, and must still be able to pick.
 */
function pickerPage(html, factory, { tracking = true } = {}) {
  const tail = html.slice(html.indexOf(`function ${factory}(`));
  const events = [];
  const context = {
    URLSearchParams,
    location: { search: '', href: '' },
    oakToday: () => '2026-08-29',
    oakTodayISO: () => '2026-08-29',
    OAK: { toast: () => {} },
  };
  if (tracking) {
    context.OAK.track = (name, meta) => events.push([name, meta]);
  }
  vm.runInNewContext(
    `${tail.slice(0, tail.indexOf('</script>'))}\nresult = ${factory}();`,
    context,
  );
  const page = context.result;
  for (const method of ['loadSlots', 'loadDayChips', 'loadQuote']) {
    page[method] = () => {};
  }
  page.events = events;
  return page;
}

/** A card the way GET /api/services/:id/staff sends one: always these seven keys. */
const CARD = {
  id: 7, name: 'Mai Chi', claimed: true, title: 'KTV', specialty: 'Vẽ móng',
  image: 'a.webp', rating: 4.8, years_experience: 10,
};
const UNCLAIMED_CARD = { ...CARD, id: 8, name: 'Chị Hoa', claimed: false };
/* A claimed technician who has taken her public page down: the showcase is gone and the name
   and the chip are not, because hiding a page is not ceasing to be the person in the chair. */
const REDUCED_CARD = {
  id: 9, name: 'Thu Hà', claimed: true, title: null, specialty: null,
  image: null, rating: null, years_experience: null,
};

test('the picker says which chair has an OAK account behind it', () => {
  for (const [name, html] of [['dat-lich.html', wizardHtml], ['chi-tiet-dich-vu.html', serviceHtml]]) {
    /* Two card designs over the same seven keys, so the chip is written twice — but gated on
       `claimed` and on nothing else in both, and drawn in the house pill these pages already
       use for a ✓ elsewhere. */
    assert.match(html, /<template x-if="member\.claimed">/, name);
    assert.match(
      html,
      /rounded-full bg-tertiary-fixed[^"]*text-on-tertiary-fixed-variant[^>]*>\s*<span aria-hidden="true" class="material-symbols-outlined text-\[14px\]">verified<\/span>\s*<span>Hồ sơ OAK<\/span>/,
      name,
    );
    // Said once per page, and never conditioned on any of the showcase a reduced card lacks.
    assert.equal((html.match(/Hồ sơ OAK/g) || []).length, 1, name);
    assert.deepEqual(html.match(/x-if="[^"]*claimed[^"]*"/g), ['x-if="member.claimed"'], name);
  }

  // The name is ungated on both cards, so a reduced card is a name plus the chip and no more.
  assert.match(wizardHtml, /class="block font-label-md text-label-md" x-text="member\.name"/);
  assert.match(serviceHtml, /<h4 class="font-label-md[^"]*" x-text="member\.name"><\/h4>/);
  const wizard = pickerPage(wizardHtml, 'oakBookingForm');
  assert.equal(wizard.staffMeta(REDUCED_CARD), '');
  assert.equal(wizard.staffMeta(CARD), 'KTV · 4.8');
});

test('a technician picked with the chip beside her name is counted, and nobody else is', () => {
  /* One event name for both pickers: track() sends the page it fired on, so the same name
     tells the wizard's step 3 from the service page's team strip by itself. */
  const wizard = pickerPage(wizardHtml, 'oakBookingForm');
  wizard.staffList = [CARD, UNCLAIMED_CARD, REDUCED_CARD];

  wizard.setStaff(CARD.id);
  assert.deepEqual(wizard.events, [['staff_verified_pick', undefined]]);
  // A row the salon typed in carries no chip, so there was nothing to choose by.
  wizard.setStaff(UNCLAIMED_CARD.id);
  assert.equal(wizard.events.length, 1);
  // "Bất kỳ" is not a person and not a pick.
  wizard.setStaff(null);
  assert.equal(wizard.events.length, 1);
  // A withdrawn profile keeps the chip, so choosing her is still a choice made on it.
  wizard.setStaff(REDUCED_CARD.id);
  assert.equal(wizard.events.length, 2);

  const service = pickerPage(serviceHtml, 'oakServiceDetail');
  service.staff = [CARD, UNCLAIMED_CARD];

  service.pickStaff(CARD.id);
  assert.deepEqual(service.events, [['staff_verified_pick', undefined]]);
  /* The same button again is an un-pick — the hours widen back out to everyone who performs
     the service — and hours offered by everyone were chosen on nobody's chip. */
  service.pickStaff(CARD.id);
  assert.equal(service.staffId, null);
  assert.equal(service.events.length, 1);
  service.pickStaff(UNCLAIMED_CARD.id);
  assert.equal(service.events.length, 1);

  // Nothing about a person rides along: the event carries no meta at all, on either page.
  for (const [, meta] of [...wizard.events, ...service.events]) {
    assert.equal(meta, undefined);
  }
});

test('a picker whose oak-api.js has no track() still picks', () => {
  /* The case a bare OAK.track(...) turns into a dead button: a page served from cache meeting
     a script from before any of this was measured. Both pages, since both now call it. */
  const wizard = pickerPage(wizardHtml, 'oakBookingForm', { tracking: false });
  wizard.staffList = [CARD];
  assert.doesNotThrow(() => wizard.setStaff(CARD.id));
  assert.equal(wizard.staffId, CARD.id);

  const service = pickerPage(serviceHtml, 'oakServiceDetail', { tracking: false });
  service.staff = [CARD];
  assert.doesNotThrow(() => service.pickStaff(CARD.id));
  assert.equal(service.staffId, CARD.id);

  for (const html of [wizardHtml, serviceHtml]) {
    assert.match(html, /typeof OAK\.track === 'function'\) \{\s*OAK\.track\('staff_verified_pick'\);/);
  }
});
