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
const partnerSource = source('routes', 'partner.js');
const staffMeSource = source('routes', 'staff-me.js');
const inviteSource = source('lib', 'staff-invite.js');
const eventsLibSource = source('lib', 'events.js');
const middlewareSource = source('middleware', 'auth.js');

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
  // One factory and nothing else: a 404 written by hand in any of the three paths that
  // take a token would be a reply that says whether the token was real.
  assert.equal((inviteSource.match(/httpError\(\s*404/g) || []).length, 1);
  for (const [name, text] of [
    ['routes/auth.js', authSource],
    ['routes/staff-me.js', staffMeSource],
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
