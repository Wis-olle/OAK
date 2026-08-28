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
const consoleHtml = ui('quan-ly-lich-hen.html');
const apiJs = ui('assets/js/oak-api.js');
const inviteSource = source('lib', 'staff-invite.js');
const eventsLibSource = source('lib', 'events.js');
const middlewareSource = source('middleware', 'auth.js');
const staffSource = source('routes', 'staff.js');
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
  assert.match(
    usersSource,
    /RELEASE_STAFF_ROWS =\s*'UPDATE staff SET user_id = NULL, claimed_at = NULL WHERE user_id = \?'/,
  );
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

  // The column is added like any other, in SCHEMA and unconditionally: nothing writes it
  // yet, and where it is empty lib/staff-stats.js answers from the bookings instead.
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

/** oakStaffProfile() over a stand-in browser, answering /api/staff/:id with `stats`. */
function specialistPage(stats) {
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
function schedulePage(profiles) {
  const tail = scheduleHtml.slice(scheduleHtml.indexOf('function oakStaffSchedule('));
  const context = {
    OAK: {
      requireStaff: async () => ({ name: 'KTV Số Liệu' }),
      api: async (endpoint) => (endpoint === '/api/staff-me/profile' ? profiles : []),
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
     path and must NOT ask the question. */
  assert.match(staffSource, /WHERE st\.id = \? AND st\.active = 1 AND \$\{VISIBLE_PROFILE\}/);
  assert.match(
    staffSource,
    /const selectVisibleStaffExists = db\.prepare\(\s*`SELECT 1 FROM staff st WHERE st\.id = \? AND st\.active = 1 AND \$\{VISIBLE_PROFILE\}`,/,
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

  // The booking wizard's technician picker, for the same reason: dropping a technician out of
  // it would quietly take a salon's chair off sale.
  const picker = handler(servicesSource, 'const selectServiceStaff', '`);');
  assert.doesNotMatch(picker, /profile_hidden/);

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

test('the five things a technician is told about, each written once and in a transaction', () => {
  /* Every notice rides the transaction that made the change it announces, so a booking that
     rolled back cannot leave a technician looking at an appointment nobody has. The count per
     file is the "exactly once per event" half: a second call anywhere is a second bell. Seven
     call sites for five triggers, because the reassignment is two events in one save — one
     technician loses the hour and another gains it. */
  const sites = [
    ['routes/bookings.js', bookingsSource, 2],
    ['routes/partner.js', partnerSource, 4],
    ['routes/reviews.js', reviewsSource, 1],
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
     news for anybody's day. Cancelling wins over it, so one save cannot ring twice. */
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
  // One read of the row for all three sentences, so the customer and both technicians are
  // told about the same hour.
  assert.match(
    patch,
    /if \(notification \|\| staffCancelled \|\| restaffed\) \{\s*const updated = await tx\.get\(/,
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
