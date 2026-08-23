/* What the account endpoints promise about consent, guessing, sessions and erasure.

   Everything that can be run out here is run: the throttle and the phone rules are lifted
   out of their modules and driven. What is left — the route handlers, which need a database
   and a live request — is pinned by reading the source, as the other unit suites here do;
   none of this may open a connection. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  isValidPhone,
  linkBookingsByPhone,
  normalisePhone,
  phoneHeldByAnother,
} from '../src/lib/phone.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = (name) => fs.readFileSync(path.join(root, name), 'utf8');

const authSource = source('server/src/routes/auth.js');
const usersSource = source('server/src/routes/users.js');
const phoneSource = source('server/src/lib/phone.js');
const middlewareSource = source('server/src/middleware/auth.js');
const schemaSource = source('server/src/db.js');

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

/** Nothing under test may write to the console during a test run. */
async function quietly(work) {
  const { warn, info } = console;
  console.warn = () => {};
  console.info = () => {};
  try {
    return await work();
  } finally {
    console.warn = warn;
    console.info = info;
  }
}

// ------------------------------------------------------------------ consent

test('an account cannot be created without an affirmative agreement', () => {
  const create = handler(authSource, 'async function createAccount(', "router.post('/register'");
  assert.match(create, /if \(consent !== true\) \{/);
  assert.match(create, /'CONSENT_REQUIRED'/);
  // Refused before the password is hashed, so a caller that left it out pays nothing.
  assert.ok(create.indexOf('consent !== true') < create.indexOf('bcrypt.hash'));
  // Both sign-up forms come through here, so the partner form is covered by the same gate.
  assert.match(authSource, /createAccount\(req, res, next, 'partner'\)/);
});

test('when it was agreed to is stored, and being marketed to is a separate answer', () => {
  assert.match(authSource, /INSERT INTO users \([^)]*consent_at, marketing_opt_in\)/);
  // Anything that is not an explicit true is a no: silence is never an opt-in.
  assert.match(authSource, /marketingOptIn === true \? 1 : 0/);
  assert.match(schemaSource, /ALTER TABLE users ADD COLUMN IF NOT EXISTS consent_at TEXT;/);
  assert.match(
    schemaSource,
    /ALTER TABLE users ADD COLUMN IF NOT EXISTS marketing_opt_in INTEGER DEFAULT 0;/,
  );
});

test('every new customer is greeted, and with a code that can actually be spent', () => {
  const create = handler(authSource, 'async function createAccount(', "router.post('/register'");
  // Not gated on marketing_opt_in: this is the one transactional hello that comes with
  // signing up, not a campaign, and the spec asks for a 'promotion' notification on every
  // new customer account. The offers box governs what is sent afterwards.
  assert.match(create, /const promotion = await tx\.get\(SELECT_WELCOME_PROMOTION, today, today\);/);
  assert.doesNotMatch(create, /marketingOptIn === true \? await tx\.get\(SELECT_WELCOME_PROMOTION/);
  // The same window bookings.js requireUsablePromotion applies at checkout, combos and all,
  // so a code named in the greeting is never one that would be refused at the till.
  assert.match(authSource, /AND type <> 'combo'/);
  assert.match(create, /promotion \? 'promotion' : 'general'/);
  // ...and the reply says which of the two it was, because the greeting dang-ky.html
  // raises names a code: without this it would promise one on a database where no
  // platform-wide promotion is live, pointing at a notification that has none.
  assert.match(create, /welcomeCode = promotion \? promotion\.code : null;/);
  assert.match(create, /data: \{ user, welcome_code: welcomeCode \}/);
});

test('the permission can be withdrawn, and only ever as a boolean', () => {
  const patch = handler(usersSource, "router.patch('/me'", 'const selectPasswordHash');
  assert.match(patch, /if \('marketing_opt_in' in body\) \{/);
  assert.match(patch, /typeof body\.marketing_opt_in !== 'boolean'/);
  assert.match(patch, /values\.push\(body\.marketing_opt_in \? 1 : 0\)/);
  // It has to reach the page that shows the switch, or the switch opens on the wrong state.
  assert.match(
    middlewareSource,
    /SELECT id, name, email[^']*marketing_opt_in[^']*FROM users WHERE id = \?/,
  );
});

// ------------------------------------------------------------------ login throttle

/* The throttle itself, lifted out of auth.js and driven: what matters is what it counts,
   not how it is spelled. It closes over one constant, which comes with it. */
const { rateLimited, RATE_WINDOW_MS } = vm.runInNewContext(
  `${authSource.match(/const RATE_WINDOW_MS = .*;/)[0]}
   ${declaration(authSource, 'function rateLimited(')}
   ({ rateLimited, RATE_WINDOW_MS });`,
);

test('the allowance is spent, not exceeded: max tries pass, the next one is refused', () => {
  const attempts = new Map();
  assert.equal(rateLimited(attempts, 'a@oak.vn|1.1.1.1', 3), false);
  assert.equal(rateLimited(attempts, 'a@oak.vn|1.1.1.1', 3), false);
  assert.equal(rateLimited(attempts, 'a@oak.vn|1.1.1.1', 3), false);
  assert.equal(rateLimited(attempts, 'a@oak.vn|1.1.1.1', 3), true);
  // Still refused afterwards: being over the line does not reset it.
  assert.equal(rateLimited(attempts, 'a@oak.vn|1.1.1.1', 3), true);
  // Ten of them for a sign-in, in a quarter of an hour.
  assert.match(authSource, /const LOGIN_MAX_ATTEMPTS = 10;/);
  assert.equal(RATE_WINDOW_MS, 15 * 60 * 1000);
});

test('one key cannot spend another, and one tally cannot spend the other', () => {
  const attempts = new Map();
  // Keyed on the address AND the caller: one office cannot be locked out by one attacker,
  // and one account cannot be walked through from one machine.
  rateLimited(attempts, 'a@oak.vn|1.1.1.1', 1);
  assert.equal(rateLimited(attempts, 'a@oak.vn|1.1.1.1', 1), true);
  assert.equal(rateLimited(attempts, 'a@oak.vn|2.2.2.2', 1), false);
  assert.equal(rateLimited(attempts, 'b@oak.vn|1.1.1.1', 1), false);

  // And two Maps, so asking for a reset link never spends a sign-in.
  const other = new Map();
  assert.equal(rateLimited(other, 'a@oak.vn|1.1.1.1', 1), false);
  assert.match(authSource, /const forgotAttempts = new Map\(\);/);
  assert.match(authSource, /const loginAttempts = new Map\(\);/);
});

test('the window reopens, and stale keys are swept by the call that reopens it', () => {
  const attempts = new Map();
  attempts.set('spent|1.1.1.1', { count: 99, windowStart: Date.now() - RATE_WINDOW_MS - 1 });
  attempts.set('idle|9.9.9.9', { count: 99, windowStart: Date.now() - RATE_WINDOW_MS - 1 });

  // The window this key was locked out in has passed, so it starts again from one.
  assert.equal(rateLimited(attempts, 'spent|1.1.1.1', 3), false);
  // ...and the key nobody came back for is gone with it: no timer, nothing held by an
  // idle process.
  assert.equal(attempts.has('idle|9.9.9.9'), false);
  assert.equal(attempts.size, 1);
  assert.doesNotMatch(authSource, /setInterval|setTimeout/);
});

test('the throttle is spent before the hash, and cleared by proving the password', () => {
  const login = handler(authSource, "router.post('/login'", 'async function mintReset');
  assert.match(login, /rateLimited\(loginAttempts, attemptKey, LOGIN_MAX_ATTEMPTS\)/);
  assert.match(login, /429,\s*'TOO_MANY_ATTEMPTS'/);
  // Vietnamese, like every other message a visitor can be shown.
  assert.match(login, /Vui lòng đợi 15 phút rồi thử lại/);
  // Checked first: guessing should not get the server's ~90ms of bcrypt for free.
  assert.ok(login.indexOf('rateLimited(loginAttempts') < login.indexOf('bcrypt.compare'));
  // Only failure accumulates, so somebody who really owns the account is never locked out
  // of it by using it.
  assert.ok(login.indexOf('INVALID_CREDENTIALS') < login.indexOf('loginAttempts.delete'));
});

// ------------------------------------------------------------------ sliding session

test('a session in use is renewed before it can expire under the reader', () => {
  assert.match(middlewareSource, /const SLIDE_AFTER_SECONDS = 3 \* 24 \* 60 \* 60;/);
  assert.match(
    middlewareSource,
    /payload\.iat > SLIDE_AFTER_SECONDS\) \{\s*issueCookie\(res, user\);/,
  );
  // Signed from the row, not from the payload: a re-issue can never carry a role the
  // account has lost. And only after the cut-off check, so a dead session is never renewed.
  const guarded = handler(
    middlewareSource,
    'export async function requireAuth',
    'export function requirePartner',
  );
  assert.ok(
    guarded.indexOf('sessionOutlivedPassword(payload, user)') <
      guarded.indexOf('SLIDE_AFTER_SECONDS'),
  );
  assert.match(middlewareSource, /export function issueCookie\(res, user\) \{/);
  // One definition of the cookie, shared by the middleware and the routes.
  assert.doesNotMatch(authSource, /const COOKIE_OPTIONS = \{/);
});

// ------------------------------------------------------------------ deleting an account

test('erasing an account needs the password, and refuses while a salon is holding a chair', () => {
  const remove = handler(usersSource, "router.delete('/me'");
  assert.match(remove, /requireAuth/);
  assert.match(remove, /bcrypt\.compare\(password, credentials\.password_hash\)/);
  assert.match(remove, /401, 'INVALID_CREDENTIALS'/);
  assert.match(remove, /409,\s*'BOOKING_PENDING'/);
  // Proven before anything is written, and read in Vietnam time like every other
  // "is this still to come" question here.
  assert.ok(remove.indexOf('BOOKING_PENDING') < remove.indexOf('db.withTransaction'));
  assert.match(
    usersSource,
    /status IN \('pending','confirmed'\)\s*AND \(date > \? OR \(date = \? AND time >= \?\)\)/,
  );
  assert.match(remove, /todayISO\(\)/);
  assert.match(remove, /fromMinutes\(nowMinutes\(\)\)/);
});

test('a partner cannot erase the account its salon is operated from', () => {
  const remove = handler(usersSource, "router.delete('/me'");
  // The salon would stay verified, listed and bookable with an owner nobody can sign in
  // as — so this one is refused outright rather than left to the booking check, which only
  // ever looks at the caller's OWN bookings.
  assert.match(remove, /req\.user\.role === 'partner'/);
  assert.match(remove, /409,\s*'PARTNER_ACCOUNT'/);
  // Refused before the password is even read, so no body can reach past it.
  assert.ok(remove.indexOf('PARTNER_ACCOUNT') < remove.indexOf('bcrypt.compare'));
});

test('what is erased is erased, and what is not is anonymous', () => {
  const remove = handler(usersSource, "router.delete('/me'");
  for (const table of ['favorites', 'notifications', 'password_resets']) {
    assert.match(remove, new RegExp(`DELETE FROM ${table} WHERE user_id = \\?`));
  }
  // The bookings and the reviews stay: a salon's own history and the ratings other
  // customers read are not one person's to withdraw. The row behind them carries no name.
  assert.doesNotMatch(remove, /DELETE FROM (bookings|reviews)/);
  assert.match(usersSource, /SET name = 'Người dùng đã xóa'/);
  assert.match(usersSource, /phone = NULL/);
  assert.match(usersSource, /avatar = NULL/);
  assert.match(usersSource, /marketing_opt_in = 0/);
  assert.match(usersSource, /deleted_at = \?/);
  assert.match(remove, /`deleted\+\$\{req\.user\.id\}@oak\.invalid`/);
  assert.match(schemaSource, /ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TEXT;/);
  // The bookings survive, but not the contact details copied onto them at booking time:
  // the console falls back to those whenever the joined account column is null, so an
  // erased profile would otherwise still show its holder's number on every card.
  assert.match(remove, /ANONYMISE_BOOKING_CONTACT, req\.user\.id/);
  assert.match(
    usersSource,
    /UPDATE bookings SET customer_name = 'Người dùng đã xóa', customer_phone = NULL/,
  );
});

test('nothing can sign back into it: the session goes, and so does the password', () => {
  const remove = handler(usersSource, "router.delete('/me'");
  // Same cut-off a password change uses, so every token minted before now stops validating.
  assert.match(usersSource, /password_changed_at = \?/);
  assert.match(remove, /Math\.floor\(Date\.now\(\) \/ 1000\)/);
  assert.match(remove, /res\.clearCookie\(COOKIE_NAME, clearOptions\)/);
  // The stored hash becomes one of a secret nobody has.
  assert.match(remove, /bcrypt\.hash\(randomBytes\(32\)\.toString\('hex'\), 10\)/);
  // One write, so a half-erased account cannot exist.
  assert.ok(remove.indexOf('db.withTransaction') < remove.indexOf('ANONYMISE_USER'));
});

// ------------------------------------------------------------------ bookings by phone

test('a phone number is compared in one shape, whichever way it was typed', () => {
  assert.equal(normalisePhone('+84 901 234 567'), '0901234567');
  assert.equal(normalisePhone('0901 234 567'), '0901234567');
  assert.equal(normalisePhone('0901234567'), '0901234567');
  assert.equal(normalisePhone(''), '');
  assert.equal(normalisePhone(null), '');
  assert.equal(normalisePhone(undefined), '');
});

test('and only something shaped like a number gets to be one', () => {
  assert.equal(isValidPhone('0901 234 567'), true);
  assert.equal(isValidPhone('+84 903 555 111'), true);
  assert.equal(isValidPhone('028 3822 1456'), true);
  assert.equal(isValidPhone('123'), false, 'too short to be a number');
  assert.equal(isValidPhone('0901234567890123456'), false, 'too long to be a number');
  assert.equal(isValidPhone("' OR 1=1 --"), false);
  assert.equal(isValidPhone(''), false);
  assert.equal(isValidPhone(null), false);
  // The same rule both ways in, so a number the form refuses cannot be PATCHed in instead.
  assert.match(authSource, /if \(phone && !isValidPhone\(phone\)\)/);
  assert.match(
    usersSource,
    /column === 'phone' && body\[column\] && !isValidPhone\(body\[column\]\)/,
  );
});

/** A db.withTransaction handle that answers whatever the case needs and records the calls. */
function fakeTx({ heldByAnother = false, changes = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async get(sql, ...params) {
      calls.push({ verb: 'get', sql, params });
      return heldByAnother ? { exists: 1 } : undefined;
    },
    async run(sql, ...params) {
      calls.push({ verb: 'run', sql, params });
      return { changes };
    },
  };
}

test('the claim compares the folded number, not the one that happened to be typed', async () => {
  const tx = fakeTx({ changes: 2 });
  assert.equal(await quietly(() => linkBookingsByPhone(tx, 7, '+84 903 555 111')), 2);

  const update = tx.calls.find((call) => call.verb === 'run');
  assert.equal(update.params[0], 7);
  assert.equal(update.params[1], '0903555111', 'the incoming number is folded');
  // ...and so is the stored one, or half the bookings could never match. Both sides go
  // through the same expression, which is SQL and so can only be read here, not run.
  assert.match(update.sql, /regexp_replace\(regexp_replace\(coalesce\(customer_phone/);
  assert.match(update.sql, /'\[\^0-9\]', '', 'g'/, 'every separator, not only whitespace');
  assert.match(update.sql, /'\^84', '0'/);
  // Only bookings nobody owns: a booking already attached to an account is never moved.
  assert.match(update.sql, /WHERE user_id IS NULL/);
});

test('a number already answering for somebody else is spotted before it is stored', async () => {
  const tx = fakeTx({ heldByAnother: true });
  assert.equal(await phoneHeldByAnother(tx, 7, '+84 987 654 321'), true);
  const lookup = tx.calls[0];
  assert.equal(lookup.params[0], 7, 'the caller is excluded, or it would refuse its own number');
  assert.equal(lookup.params[1], '0987654321', 'compared folded, whichever way it was typed');
  assert.match(lookup.sql, /deleted_at IS NULL/, 'an erased account holds nothing');

  // A registration has no id yet, so it compares against every row.
  const fresh = fakeTx({ heldByAnother: true });
  assert.equal(await phoneHeldByAnother(fresh, null, '0987654321'), true);
  assert.equal(fresh.calls[0].params[0], 0);

  // Free, and free of a query, when there is no number to ask about.
  const empty = fakeTx({ heldByAnother: true });
  assert.equal(await phoneHeldByAnother(empty, 7, '   '), false);
  assert.deepEqual(empty.calls, []);
});

test('and both ways in refuse it out loud rather than storing it quietly', () => {
  // The refusal is the point: storing the number anyway would leave two rows folding to
  // one, which is what the console lookup cannot resolve. Both sites answer 409 with a
  // sentence, so the person typing it is told instead of being told nothing.
  const create = handler(authSource, 'async function createAccount(', "router.post('/register'");
  assert.match(create, /await phoneHeldByAnother\(tx, null, phone\)/);
  assert.match(create, /409,\s*'PHONE_IN_USE'/);
  assert.ok(create.indexOf('PHONE_IN_USE') < create.indexOf('INSERT_USER'), 'before the write');

  const patch = handler(usersSource, "router.patch('/me'", 'const selectPasswordHash');
  assert.match(patch, /await phoneHeldByAnother\(tx, req\.user\.id, claimedPhone\)/);
  assert.match(patch, /409,\s*'PHONE_IN_USE'/);
  assert.ok(patch.indexOf('PHONE_IN_USE') < patch.indexOf('UPDATE users SET'), 'before the write');
});

test('no number, no claim: nothing is asked and nothing is written', async () => {
  for (const value of ['', null, undefined, '   ']) {
    const tx = fakeTx({ changes: 3 });
    assert.equal(await quietly(() => linkBookingsByPhone(tx, 7, value)), 0);
    assert.deepEqual(tx.calls, []);
  }
});

test('both ways in go through it, and the profile write is in the same transaction', () => {
  // The account being created (a customer's — a salon owner's business line is not a claim
  // on those bookings), and the number being added to one that exists.
  assert.match(
    authSource,
    /if \(phone && accountRole === 'customer'\) \{\s*await linkBookingsByPhone\(tx, userId, phone\);/,
  );
  const patch = handler(usersSource, "router.patch('/me'", 'const selectPasswordHash');
  assert.match(
    patch,
    /if \(claimedPhone && req\.user\.role === 'customer'\) \{\s*await linkBookingsByPhone\(tx, req\.user\.id, claimedPhone\);/,
  );
  assert.ok(patch.indexOf('db.withTransaction') < patch.indexOf('linkBookingsByPhone'));
  // Stored folded as well as compared folded, on both paths.
  assert.match(authSource, /phone \? normalisePhone\(phone\) : null/);
  // `|| null`: an emptied field clears to NULL, the value every other empty phone holds.
  assert.match(patch, /column === 'phone' \? normalisePhone\(body\[column\]\) \|\| null : body\[column\]/);
  // The lookup this adds is the only one that reaches users by anything but the id, and it
  // compares a folded column — so the index has to be on that same expression. A plain
  // index on the raw column could never serve it, and the old one is dropped, not left.
  assert.match(schemaSource, /DROP INDEX IF EXISTS idx_users_phone;/);
  // ...and so is the earlier folded one: CREATE INDEX IF NOT EXISTS would otherwise keep an
  // index built on the whitespace-only expression alive under its own name.
  assert.match(schemaSource, /DROP INDEX IF EXISTS idx_users_phone_normalised;/);
  assert.match(schemaSource, /CREATE INDEX IF NOT EXISTS idx_users_phone_digits/);
  assert.match(schemaSource, /ON users\(\(regexp_replace\(regexp_replace\(coalesce\(phone/);
  // Still unverified, and the source says so: an OTP is the step that would make the claim
  // proof rather than an assertion.
  assert.match(phoneSource, /INCOMPLETE BY DESIGN/);
});

// ------------------------------------------------------------------ migrations

test('every column added here is added the way an existing database can take it', () => {
  // A salon's answer to a review, which the console writes and the salon page reads.
  assert.match(schemaSource, /ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reply_text TEXT;/);
  assert.match(schemaSource, /ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reply_at TEXT;/);
  // Every one of them idempotent, so booting twice is a no-op.
  for (const statement of schemaSource.match(/ALTER TABLE \w+ ADD COLUMN (?!IF NOT EXISTS)/g) || []) {
    assert.fail(`not idempotent: ${statement}`);
  }
});
