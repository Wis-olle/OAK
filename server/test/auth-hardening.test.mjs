/* What the account endpoints promise about consent, guessing, sessions and erasure.

   Everything that can be run out here is run: the throttle and the phone rules are lifted
   out of their modules and driven. What is left — the route handlers, which need a database
   and a live request — is pinned by reading the source, as the other unit suites here do;
   none of this may open a connection. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { isValidPhone, normalisePhone, phoneHeldByAnother } from '../src/lib/phone.js';
import { readRepo as source } from './lib/read-source.mjs';

const authSource = source('server/src/routes/auth.js');
const usersSource = source('server/src/routes/users.js');
const phoneSource = source('server/src/lib/phone.js');
const middlewareSource = source('server/src/middleware/auth.js');
const partnerSource = source('server/src/routes/partner.js');
const rateLimitSource = source('server/src/lib/rate-limit.js');
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
  /* The key is spelled out here and cannot be displaced: `...extra` is whatever a role's own
     afterInsert hook wanted the reply to carry, and it is spread FIRST, so a hook can add to
     this body and a hook that one day returns a `welcome_code` of its own loses to the real
     one rather than silently replacing it. For a customer registration there is no hook at all
     and `...undefined` adds nothing. */
  assert.match(create, /data: \{ \.\.\.extra, user, welcome_code: welcomeCode \}/);
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

/* The throttle itself, lifted out of lib/rate-limit.js and driven: what matters is what it
   counts, not how it is spelled. It closes over one constant, which comes with it — and it is
   three functions rather than one: countAttempt does the recording, rateLimited is the record-
   and-test the login and reset paths have always called, and refundAttempt gives one back for
   the caller that has to charge before it knows what the call will cost.

   It reads from the lib rather than from auth.js because that is where it now lives: one
   counter for every door in the app, so a fix to the sweep or the window is made once. Every
   ALLOWANCE is still read out of the route that sets it, below. */
const { rateLimited, refundAttempt, RATE_WINDOW_MS } = vm.runInNewContext(
  `${rateLimitSource.match(/const RATE_WINDOW_MS = .*;/)[0]}
   ${declaration(rateLimitSource, 'function countAttempt(')}
   ${declaration(rateLimitSource, 'function rateLimited(')}
   ${declaration(rateLimitSource, 'function refundAttempt(')}
   ({ rateLimited, refundAttempt, RATE_WINDOW_MS });`,
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
  assert.doesNotMatch(rateLimitSource, /setInterval|setTimeout/);
});

/* POST /api/auth/staff/register's tokenless path, reduced to its throttle and driven on the
   real helpers: reserve at the door, do the awaited work, refund unless a page came of it. The
   `await` in the middle is the whole subject — it stands for findLiveInvite, ~90ms of bcrypt
   and a transaction, and it is where every other request in a burst gets to run. That the route
   really has this shape is pinned in test/staff-persona.test.mjs, which reads the source; what
   is driven here is what the shape DOES.

   `mint` says whether this call publishes a page: false is the technician who mistyped, whose
   attempt must cost her nothing. */
const tokenlessRegister = async (attempts, ip, max, mint) => {
  let reserved = false;
  let published = false;
  try {
    if (rateLimited(attempts, ip, max)) {
      return 429;
    }
    reserved = true;
    await new Promise((resolve) => setImmediate(resolve));
    if (!mint) {
      return 400;
    }
    published = true;
    return 200;
  } finally {
    if (reserved && !published) {
      refundAttempt(attempts, ip);
    }
  }
};

test('a burst arriving together cannot mint more pages than the allowance', async () => {
  /* The failure this test exists for. Read the ceiling first and charge it after the page
     exists, and the charge lands on the far side of an await: fifty concurrent requests every
     one of them read a tally none of them had charged yet, all fifty passed, and one script
     minted fifty published, indexable pages under arbitrary names from one address. Sent one at
     a time the same fifty gave five and forty-five refusals, so nothing sequential could see
     it. Charging at the door is what closes it — on one event loop an increment with no await
     in front of it is the only thing that can hold a limit. */
  const attempts = new Map();
  const answers = await Promise.all(
    Array.from({ length: 50 }, () => tokenlessRegister(attempts, '1.1.1.1', 5, true)),
  );
  assert.equal(answers.filter((code) => code === 200).length, 5, 'pages minted by the burst');
  assert.equal(answers.filter((code) => code === 429).length, 45);

  // And a burst that mints nothing spends nothing: the same fifty, all refused for their own
  // reasons, leave the allowance whole behind them.
  const mistyped = new Map();
  const refused = await Promise.all(
    Array.from({ length: 50 }, () => tokenlessRegister(mistyped, '2.2.2.2', 5, false)),
  );
  assert.equal(refused.filter((code) => code === 400).length, 5);
  assert.equal(refused.filter((code) => code === 429).length, 45);
  assert.equal(mistyped.get('2.2.2.2').count, 45, 'the five refusals were given back');
});

test('a refusal leaves the tally where it found it, and five pages still go through', async () => {
  /* The technician at the form, who is the reason the refund exists at all:
     dang-nhap-nhan-vien.html checks no length, no consent tick and no password of its own, so
     she corrects one refusal at a time. Charged per attempt, her fifth and correct try met a
     429 and she was locked out for a quarter of an hour having created nothing. */
  const attempts = new Map();
  for (let mistake = 0; mistake < 20; mistake += 1) {
    assert.equal(await tokenlessRegister(attempts, '1.1.1.1', 5, false), 400);
  }
  // Nothing held at all: the entry is dropped at zero rather than left sitting on the address.
  assert.equal(attempts.has('1.1.1.1'), false);

  for (let page = 1; page <= 5; page += 1) {
    assert.equal(await tokenlessRegister(attempts, '1.1.1.1', 5, true), 200, `page ${page}`);
  }
  assert.equal(await tokenlessRegister(attempts, '1.1.1.1', 5, true), 429);
  // A refusal after the ceiling is reached is refused for the ceiling, not for itself.
  assert.equal(await tokenlessRegister(attempts, '1.1.1.1', 5, false), 429);
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
function fakeTx({ heldByAnother = false } = {}) {
  const calls = [];
  return {
    calls,
    async get(sql, ...params) {
      calls.push({ verb: 'get', sql, params });
      return heldByAnother ? { exists: 1 } : undefined;
    },
    async run(sql, ...params) {
      calls.push({ verb: 'run', sql, params });
      return { changes: 0 };
    },
  };
}

test('a typed number claims nothing: no booking changes hands for one', () => {
  /* The takeover this closes. Both ways in used to reassign every account-less booking left
     under the number in the body — and the number is typed, not verified, so anybody holding
     a person's phone number held that person's history at the counter, and a contact list was
     a shopping list. There is no OTP to gate it with, so the mechanism is gone rather than
     guarded: what cannot be proved is not done. */
  assert.doesNotMatch(phoneSource, /linkBookingsByPhone/);
  assert.doesNotMatch(phoneSource, /UPDATE bookings SET user_id/);
  assert.doesNotMatch(authSource, /linkBookingsByPhone/);
  assert.doesNotMatch(usersSource, /linkBookingsByPhone/);
  // And the source says what would have to exist before any of it could come back.
  assert.match(phoneSource, /until a code sent to the number is checked/);

  /* The counter's own lookup stays, and is now the only place a number attaches a booking to
     an account — the one place it can be trusted, because the salon read it off the customer
     in front of them. It answers only when exactly one live customer holds the number, which
     is also why PHONE_IN_USE has to keep refusing a second claim on one. */
  assert.match(partnerSource, /async function accountForPhone\(phone\)/);
  assert.match(partnerSource, /role = 'customer' AND deleted_at IS NULL/);
  assert.match(partnerSource, /matches\.length === 1 \? matches\[0\]\.id : null/);
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
  assert.match(patch, /await phoneHeldByAnother\(tx, req\.user\.id, changedPhone\)/);
  assert.match(patch, /409,\s*'PHONE_IN_USE'/);
  assert.ok(patch.indexOf('PHONE_IN_USE') < patch.indexOf('UPDATE users SET'), 'before the write');
});

test('and neither door will answer that question many times over', () => {
  /* The 409 above is an answer nothing else on the site will give: "yes, somebody here holds
     this number". Free and unlimited, it is an oracle — a script walks a contact list through
     the sign-up form and learns which of a person's friends are on OAK. So the ration is on
     the question, not on the door: a registration with no number in it spends nothing, which
     is what keeps a salon opening accounts for its own staff (and this suite) out of it. */
  const create = handler(authSource, 'async function createAccount(', "router.post('/register'");
  assert.ok(create.includes('if (phone && phoneLookupLimited(req.ip))'));
  assert.match(create, /429,\s*'TOO_MANY_ATTEMPTS'/);
  // Vietnamese, like every other message a visitor can be shown.
  assert.match(create, /Vui lòng đợi 15 phút rồi thử lại/);
  // Charged before the ~90ms of hashing, so scanning never gets bcrypt for free...
  assert.ok(create.indexOf('phoneLookupLimited') < create.indexOf('bcrypt.hash'));
  // ...and before the refusal it rations, or the refusal would still be free.
  assert.ok(create.indexOf('phoneLookupLimited(req.ip)') < create.indexOf("'PHONE_IN_USE'"));

  /* ONE budget across both doors, and this is the assertion that matters most here. The
     profile field answers the same question the sign-up form does, and sign-ups without a
     number are free — so an allowance charged only to the account would be theatre: mint a
     throwaway account, spend its five, discard it, open another. Both are charged to the
     ADDRESS, out of a tally neither route owns. */
  assert.match(rateLimitSource, /const PHONE_LOOKUP_MAX_ATTEMPTS = 30;/);
  assert.match(rateLimitSource, /const phoneLookupAttempts = new Map\(\);/);
  assert.ok(rateLimitSource.includes('rateLimited(phoneLookupAttempts, ip, PHONE_LOOKUP_MAX_ATTEMPTS)'));
  const patch = handler(usersSource, "router.patch('/me'", 'const selectPasswordHash');
  assert.ok(patch.includes('if (changedPhone && phoneLookupLimited(req.ip))'));
  // And the account's own five on top of it, which is the cheaper limit of the two.
  assert.ok(
    patch.includes(
      'if (changedPhone && rateLimited(phoneChangeAttempts, req.user.id, PHONE_CHANGE_MAX_ATTEMPTS))',
    ),
  );
  assert.match(usersSource, /const PHONE_CHANGE_MAX_ATTEMPTS = 5;/);
  assert.match(usersSource, /const phoneChangeAttempts = new Map\(\);/);
  assert.match(patch, /429,\s*'TOO_MANY_ATTEMPTS'/);
  assert.ok(patch.indexOf('phoneLookupLimited(req.ip)') < patch.indexOf("'PHONE_IN_USE'"));

  // One counter for the whole app, in a lib both routes import: a route module is nobody's
  // library, and a second copy of the sweep would have to be fixed twice.
  assert.match(
    authSource,
    /import \{\s*phoneLookupLimited,\s*rateLimited,\s*refundAttempt,\s*registerIpLimited,\s*\} from '\.\.\/lib\/rate-limit\.js';/,
  );
  assert.ok(usersSource.includes("import { phoneLookupLimited, rateLimited } from '../lib/rate-limit.js';"));
  assert.ok(!usersSource.includes("from './auth.js'"), 'users.js imports no route module');
  assert.doesNotMatch(authSource, /function (countAttempt|rateLimited|refundAttempt)\(/);
});

test('and opening an account at all is rationed per address, number or no number', () => {
  /* The budget above rations a QUESTION, and a sign-up with no number in it asks none — which
     is deliberate, and is also the hole: a script that simply never sends a phone number paid
     nothing for account number ten thousand, and each one is a bcrypt hash, a row, a notice
     and a door onto the rest of the site. So there is a second ceiling under all three
     registration doors, on the ACT rather than on anything the request carried. */
  assert.ok(
    rateLimitSource.includes('const REGISTER_IP_MAX_ATTEMPTS = Number.isFinite(parsedRegisterIpLimit)'),
  );
  // Forty in the quarter of an hour: met by no shop signing its own staff up, and far under
  // what a script posting sign-ups in a loop would want.
  assert.match(rateLimitSource, /\? parsedRegisterIpLimit\s+: 40;/);
  assert.match(rateLimitSource, /const registerIpAttempts = new Map\(\);/);
  assert.ok(rateLimitSource.includes('rateLimited(registerIpAttempts, ip, REGISTER_IP_MAX_ATTEMPTS)'));

  /* Number.parseInt with an explicit finite check, not `Number(x) || 40`: 0 is the one value
     an operator would only ever type on purpose — sign-ups shut — and the shorter idiom reads
     it as absent and hands back the default. lib/upload-quota.js reads its cap the same way. */
  assert.match(
    rateLimitSource,
    /const parsedRegisterIpLimit = Number\.parseInt\(process\.env\.REGISTER_IP_LIMIT \?\? '', 10\);/,
  );

  /* Charged in createAccount, which is the one place all three doors — /register,
     /partner/register and /staff/register — pass through, and charged unconditionally: an
     `if (phone && ...)` here would be the same hole a second time. */
  const create = handler(authSource, 'async function createAccount(', "router.post('/register'");
  assert.ok(create.includes('if (registerIpLimited(req.ip)) {'));
  assert.equal((authSource.match(/registerIpLimited\(/g) || []).length, 1, 'one door, charged once');
  // Before the ~90ms of hashing, so a run of sign-ups never gets the server's bcrypt free...
  assert.ok(create.indexOf('registerIpLimited') < create.indexOf('bcrypt.hash'));
  // ...and after the shape checks and the consent gate, so no mistyped form costs an account.
  assert.ok(create.indexOf("'CONSENT_REQUIRED'") < create.indexOf('registerIpLimited'));
  assert.match(create, /429,\s*'TOO_MANY_ATTEMPTS'/);
  assert.match(create, /Đã có quá nhiều tài khoản được tạo từ kết nối này/);

  /* And the one caller that legitimately opens dozens of accounts from a single address in a
     few seconds raises it rather than the ceiling being left off. Raised, not disabled, so
     every smoke run still exercises the variable being read. */
  const smoke = source('server/test/api-smoke.mjs');
  assert.match(smoke, /REGISTER_IP_LIMIT: '1000',/);
});

test('and a number that is not changing is not a question at all', () => {
  /* ho-so-ca-nhan.html and cai-dat-salon.html both post the whole profile object, so the
     stored number rides along on every save. Charged on "the body carries a phone", the sixth
     save of an AVATAR would have been refused — and the 409 lookup would have run against the
     saver's own number every time. Both are gated on the value actually being new. */
  const patch = handler(usersSource, "router.patch('/me'", 'const selectPasswordHash');
  assert.match(
    patch,
    /normalisePhone\(claimedPhone\) !== normalisePhone\(req\.user\.phone\)/,
    'both sides folded: a seeded row still holds the spaces it was typed with',
  );
  // Every one of the three gates reads the same decision, rather than re-deriving it.
  assert.equal((patch.match(/changedPhone &&/g) || []).length, 3);
  assert.ok(patch.includes('if (changedPhone && (await phoneHeldByAnother(tx, req.user.id, changedPhone)))'));
  // req.user carries the stored number for the comparison; middleware/auth.js selects it.
  assert.match(middlewareSource, /SELECT id, name, email, phone,/);
});

test('the number is stored folded both ways in, and indexed the way it is compared', () => {
  const patch = handler(usersSource, "router.patch('/me'", 'const selectPasswordHash');
  // Stored folded as well as compared folded, on both paths.
  assert.match(authSource, /phone \? normalisePhone\(phone\) : null/);
  // `|| null`: an emptied field clears to NULL, the value every other empty phone holds.
  assert.match(patch, /column === 'phone' \? normalisePhone\(body\[column\]\) \|\| null : body\[column\]/);
  // phoneHeldByAnother is the only lookup that reaches users by anything but the id, and it
  // compares a folded column — so the index has to be on that same expression. A plain
  // index on the raw column could never serve it, and the old one is dropped, not left.
  assert.match(schemaSource, /DROP INDEX IF EXISTS idx_users_phone;/);
  // ...and so is the earlier folded one: CREATE INDEX IF NOT EXISTS would otherwise keep an
  // index built on the whitespace-only expression alive under its own name.
  assert.match(schemaSource, /DROP INDEX IF EXISTS idx_users_phone_normalised;/);
  assert.match(schemaSource, /CREATE INDEX IF NOT EXISTS idx_users_phone_digits/);
  assert.match(schemaSource, /ON users\(\(regexp_replace\(regexp_replace\(coalesce\(phone/);
  // A SELECT and not a UNIQUE index, deliberately: rows written before this rule existed can
  // already collide, and a constraint added over them would refuse to build on boot.
  assert.doesNotMatch(schemaSource, /UNIQUE.*idx_users_phone_digits/);
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
