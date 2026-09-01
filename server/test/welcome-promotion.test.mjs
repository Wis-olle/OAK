/* The one offer OAK runs: a salon joins and gets its own 20% code, good for 30 days.

   The policy is a module, so it is imported and driven. The three paths that write it —
   registration, the seed and the boot-time backfill — need a database, so they are pinned
   by reading the source, as the other unit suites here do; none of this may open a
   connection. The exception is the checkout gate, which is lifted out of bookings.js and
   run against a row shaped exactly like the one those three write: an offer nobody can
   spend is not an offer. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { slugify } from '../src/lib/text.js';
import { addDaysISO, todayISO } from '../src/lib/time.js';
import {
  WELCOME_BACKFILL_CUTOFF,
  WELCOME_CODE_PREFIX,
  WELCOME_DAYS,
  WELCOME_DESCRIPTION,
  WELCOME_IMAGE,
  WELCOME_NOTICE_BODY,
  WELCOME_NOTICE_TITLE,
  WELCOME_PERCENT,
  WELCOME_TITLE,
  welcomeCode,
  welcomeWindow,
} from '../src/lib/welcome-promotion.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = (name) => fs.readFileSync(path.join(root, name), 'utf8');

const authSource = source('server/src/routes/auth.js');
const bookingsSource = source('server/src/routes/bookings.js');
const dbSource = source('server/src/db.js');
const partnerSource = source('server/src/routes/partner.js');
const promotionsSource = source('server/src/routes/promotions.js');
const seedSource = source('server/src/seed.js');

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

/** One `const NAME = ...;` statement, however many lines it runs to. */
function constant(text, name) {
  const start = text.indexOf(`const ${name} =`);
  assert.notEqual(start, -1, `no constant named ${name}`);
  return text.slice(start, text.indexOf(';\n', start) + 1);
}

/* The offers the demo used to invent, retired for good. Spelled out here rather than read
   back from db.js: this is the historical list, and a test that read the list under test
   would agree with whatever it was changed to. */
const RETIRED_SEED_OFFERS = [
  ['OAKNEW20', 'Chào mừng thành viên mới - Giảm 20%'],
  ['OAKSUMMER', 'Ưu đãi hè rực rỡ'],
  ['LALAGEL100', 'Giảm 100.000đ cho dịch vụ sơn gel'],
  ['MUSESPA25', 'Trị liệu spa giảm 25%'],
  ['HAIR200K', 'Phục hồi tóc - Giảm ngay 200.000đ'],
  ['LALACOMBO480', 'Combo Sơn gel + Chăm sóc chân'],
  ['LALACOMBO720', 'Combo Đắp gel + Nail art'],
];

// ------------------------------------------------------------------ the policy

test('one offer, one shape: twenty percent for thirty days, under one title', () => {
  assert.equal(WELCOME_PERCENT, 20);
  assert.equal(WELCOME_DAYS, 30);
  assert.equal(WELCOME_TITLE, 'Chào mừng salon mới - Giảm 20%');
  // The wording quotes the numbers rather than repeating them, so the two cannot drift.
  assert.ok(WELCOME_DESCRIPTION.includes('20%'));
  assert.ok(WELCOME_DESCRIPTION.includes('30 ngày'));
  // The cards bind :src straight into an <img>, so this may never be null.
  assert.match(WELCOME_IMAGE, /^assets\/images\/.+\.(jpg|png|webp)$/);
});

test('the code is derived from the salon, so the same salon always yields the same one', () => {
  assert.equal(welcomeCode(7), `${WELCOME_CODE_PREFIX}7`);
  assert.equal(welcomeCode(7), welcomeCode(7));
  assert.notEqual(welcomeCode(7), welcomeCode(8));
  // promotions.code is UNIQUE across the table: two salons may never collide.
  const codes = new Set([1, 2, 3, 10, 11].map(welcomeCode));
  assert.equal(codes.size, 5);
  // partner.js trims a code it is given, so a code with whitespace in it would come back
  // trimmed and stop matching what registration wrote. It must not have any.
  assert.equal(welcomeCode(7).trim(), welcomeCode(7));
});

test('the window opens the day it is handed out and runs thirty days', () => {
  const window = welcomeWindow('2026-08-25');
  assert.equal(window.starts_at, '2026-08-25');
  assert.equal(window.ends_at, '2026-09-24');
  // Across a month end, and across a year end, by the calendar rather than by arithmetic.
  assert.equal(welcomeWindow('2026-12-20').ends_at, '2027-01-19');
});

// ------------------------------------------------------------------ the checkout gate

/** The row every path writes: registration, the seed and the backfill agree on it. */
function welcomeRow(salonId, startISO, overrides = {}) {
  const { starts_at: startsAt, ends_at: endsAt } = welcomeWindow(startISO);
  return {
    id: 1,
    salon_id: salonId,
    code: welcomeCode(salonId),
    type: 'discount',
    title: WELCOME_TITLE,
    description: WELCOME_DESCRIPTION,
    discount_percent: WELCOME_PERCENT,
    discount_amount: null,
    original_price: null,
    sale_price: null,
    // NULL, meaning the whole menu: requireUsablePromotion reads the salon scope and the
    // window, never a service list, so an offer on everything carries no list at all.
    service_ids: null,
    image: WELCOME_IMAGE,
    starts_at: startsAt,
    ends_at: endsAt,
    active: 1,
    ...overrides,
  };
}

/* bookings.js's own gate, lifted out and driven against one row. It closes over the
   statement, the clock and the error helper, which are handed in. */
function checkoutGate(row, today) {
  return vm.runInNewContext(
    `${declaration(bookingsSource, 'async function requireUsablePromotion(')}
     requireUsablePromotion;`,
    {
      selectPromotion: { get: async (code) => (code === row.code ? row : undefined) },
      todayISO: () => today,
      httpError: (status, code, message) =>
        Object.assign(new Error(message), { status, errorCode: code }),
    },
  );
}

test('the welcome code can actually be spent, at the salon that was given it', async () => {
  const row = welcomeRow(4, '2026-08-25');
  const gate = checkoutGate(row, '2026-08-25');
  const promotion = await gate(row.code, 4);
  assert.equal(promotion.code, welcomeCode(4));
  assert.equal(promotion.discount_percent, WELCOME_PERCENT);
});

test('and nowhere else: the code belongs to one salon, not to the platform', async () => {
  const row = welcomeRow(4, '2026-08-25');
  const gate = checkoutGate(row, '2026-08-25');
  await assert.rejects(() => gate(row.code, 5), /Mã ưu đãi không hợp lệ hoặc đã hết hạn\./);
  // A code no salon was ever handed is refused rather than quietly ignored.
  await assert.rejects(() => gate('OAKNEW20', 4), /Mã ưu đãi không hợp lệ hoặc đã hết hạn\./);
});

test('it is live on the last day it promises, and dead the morning after', async () => {
  const row = welcomeRow(4, '2026-08-25');
  assert.equal((await checkoutGate(row, row.starts_at)(row.code, 4)).code, row.code);
  assert.equal((await checkoutGate(row, row.ends_at)(row.code, 4)).code, row.code);
  await assert.rejects(
    () => checkoutGate(row, addDaysISO(row.ends_at, 1))(row.code, 4),
    /Mã ưu đãi không hợp lệ hoặc đã hết hạn\./,
  );
  await assert.rejects(
    () => checkoutGate(row, addDaysISO(row.starts_at, -1))(row.code, 4),
    /Mã ưu đãi không hợp lệ hoặc đã hết hạn\./,
  );
});

test('a combo and a switched-off offer are both turned away at the till', async () => {
  // Why the welcome offer is type 'discount' and not something a salon bundles: the gate
  // turns a combo away, so writing one would hand every new salon a code nobody can use.
  const combo = welcomeRow(4, '2026-08-25', { type: 'combo' });
  await assert.rejects(
    () => checkoutGate(combo, '2026-08-25')(combo.code, 4),
    /Combo được đặt như một dịch vụ, không dùng như mã giảm giá\./,
  );
  const off = welcomeRow(4, '2026-08-25', { active: 0 });
  await assert.rejects(
    () => checkoutGate(off, '2026-08-25')(off.code, 4),
    /Mã ưu đãi không hợp lệ hoặc đã hết hạn\./,
  );
});

// ------------------------------------------------------------------ registration

/* Registration itself, lifted out and run. Everything it reaches for is handed in, so
   what is under test is the real text of createAccount: the statements it fires, in the
   order it fires them, with the values it passes. Reading it was not enough — a regex
   agrees with an expression that throws the moment it is evaluated. */
function registerPartner() {
  const statements = [];
  const SALON_ID = 42;
  let replied = null;
  let failed = null;

  const context = {
    // A transaction that records rather than writes. One salon insert hands back the id
    // the promotion must be tied to; everything else gets a throwaway one.
    db: {
      withTransaction: async (work) =>
        work({
          run: async (sql, ...params) => {
            statements.push({ sql, params });
            return {
              changes: 1,
              lastInsertRowid: sql.includes('INTO salons') ? SALON_ID : statements.length,
            };
          },
          get: async () => undefined,
          all: async () => [],
        }),
    },
    bcrypt: { hash: async () => 'hashed' },
    httpError: (status, code, message) =>
      Object.assign(new Error(message), { status, errorCode: code }),
    isValidPhone: () => true,
    normalisePhone: (value) => value,
    phoneHeldByAnother: async () => false,
    notifyUser: async () => {},
    slugify,
    todayISO,
    welcomeWindow,
    WELCOME_TITLE,
    WELCOME_DESCRIPTION,
    WELCOME_PERCENT,
    WELCOME_IMAGE,
    // Under BOTH names, so this passes whichever one auth.js reaches for — and still
    // fails if the local `welcomeCode` in the handler is what the call resolves to.
    welcomeCode,
    salonWelcomeCode: welcomeCode,
    selectPublicUser: { get: async (id) => ({ id, role: 'partner' }) },
    issueCookie: () => {},
  };

  const createAccount = vm.runInNewContext(
    `${[
      'EMAIL_PATTERN',
      'MIN_PASSWORD_LENGTH',
      'NAME_MAX_LENGTH',
      'ROLES',
      'INSERT_USER',
      'INSERT_SALON',
      'REGISTRATION_CITY',
      'INSERT_WELCOME_PROMOTION',
      'SELECT_WELCOME_PROMOTION',
      'SELECT_SALON_BY_SLUG',
    ]
      .map((name) => constant(authSource, name))
      .join('\n')}
     ${declaration(authSource, 'async function uniqueSalonSlug(')}
     ${declaration(authSource, 'async function createAccount(')}
     createAccount;`,
    context,
  );

  const req = {
    body: {
      name: 'Thu Trang',
      email: 'moi@oak.vn',
      password: 'Oak@1234',
      salon_name: 'Salon Mới',
      consent: true,
    },
  };
  const res = { json: (payload) => { replied = payload; } };
  return createAccount(req, res, (error) => { failed = error; }, 'partner').then(() => ({
    statements,
    salonId: SALON_ID,
    replied,
    failed,
  }));
}

test('registering a partner really does write the offer, with the salon’s own code', async () => {
  const { statements, salonId, replied, failed } = await registerPartner();
  assert.equal(failed, null, `registration failed: ${failed?.message}`);

  const promotion = statements.find(({ sql }) => sql.includes('INSERT INTO promotions'));
  assert.notEqual(promotion, undefined, 'no promotion was written for the new salon');
  // The value that matters: the code is built from the id the salon insert handed back.
  assert.equal(promotion.params[0], salonId);
  assert.equal(promotion.params[1], welcomeCode(salonId));
  assert.equal(promotion.params[1], 'MOI20-42');
  assert.equal(promotion.params[2], WELCOME_TITLE);
  assert.equal(promotion.params[4], WELCOME_PERCENT);
  assert.deepEqual(promotion.params.slice(6), Object.values(welcomeWindow(todayISO())));
  assert.equal(promotion.params.length, (promotion.sql.match(/\?/g) || []).length);

  // In the same transaction, after the salon it belongs to.
  const salon = statements.findIndex(({ sql }) => sql.includes('INTO salons'));
  assert.ok(salon !== -1 && salon < statements.indexOf(promotion));
  // And the handler's own `welcomeCode` — the customer greeting — is untouched by it:
  // a partner is greeted with no code, and still gets an answer.
  assert.deepEqual(replied.data.welcome_code, null);
});

test('a salon is never created without its offer: one transaction writes both', () => {
  const create = handler(authSource, 'async function createAccount(', "router.post('/register'");
  // `tx` exists only inside the transaction callback, and there is exactly one of those,
  // so writing the offer through tx.run is what makes the two rows one commit: a salon
  // that could not be given its code is a registration that never happened.
  assert.equal(create.match(/db\.withTransaction\(/g).length, 1);
  assert.match(create, /const salonId = Number\(\s*\(\s*await tx\.run\(\s*INSERT_SALON,/);
  // The whole argument list, in order, because nothing can run this statement against a
  // database here: a column and its value drifting apart is exactly what would not show.
  // What each value IS is settled by running it, in the test above.
  assert.match(
    create,
    /await tx\.run\(\s*INSERT_WELCOME_PROMOTION,\s*salonId,\s*\w+\(salonId\),\s*WELCOME_TITLE,\s*WELCOME_DESCRIPTION,\s*WELCOME_PERCENT,\s*WELCOME_IMAGE,\s*startsAt,\s*endsAt,\s*\);/,
  );
  // The window is the salon's own first thirty days, taken from the policy.
  assert.match(create, /welcomeWindow\(todayISO\(\)\)/);
  // Salon-scoped, active, and a discount — the shape the gate above accepts.
  assert.match(
    authSource,
    /INSERT INTO promotions\s*\n?\s*\(salon_id, code, type, title, description, discount_percent, image, starts_at, ends_at, active\)\s*\n?\s*VALUES \(\?, \?, 'discount', \?, \?, \?, \?, \?, \?, 1\)/,
  );
});

test('the customer greeting is left alone, and simply finds nothing to name', () => {
  // Nothing platform-wide is live any more, so SELECT_WELCOME_PROMOTION returns no row and
  // the greeting falls back to the sentence without a code. That branch has to stay.
  const create = handler(authSource, 'async function createAccount(', "router.post('/register'");
  assert.match(create, /const promotion = await tx\.get\(SELECT_WELCOME_PROMOTION, today, today\);/);
  assert.match(create, /welcomeCode = promotion \? promotion\.code : null;/);
  assert.match(authSource, /salon_id IS NULL AND active = 1/);
});

// ------------------------------------------------------------------ the seed

test('the seed ships one offer per salon, generated rather than listed', () => {
  assert.doesNotMatch(seedSource, /const PROMOTIONS = \[/);
  for (const [code, title] of RETIRED_SEED_OFFERS) {
    assert.ok(!seedSource.includes(code), `seed.js still seeds ${code}`);
    assert.ok(!seedSource.includes(title), `seed.js still seeds "${title}"`);
  }
  // Walked over SALONS, so a salon added to the demo cannot be forgotten.
  assert.match(seedSource, /for \(const salon of SALONS\) \{[\s\S]{0,400}?welcomeCode\(salonId\)/);
  // The demo cohort is the newly-joined one: its window opens the day it is seeded.
  assert.match(seedSource, /welcomeWindow\(todayISO\(\)\)/);
});

// ------------------------------------------------------------------ the backfill

test('the backfill retires the old offers by code AND title, and nothing else', () => {
  // A code on its own is something a salon could pick for an offer of its own one day.
  // Both columns matching is what makes a row positively one of the seeded ones.
  assert.match(
    dbSource,
    /DELETE FROM promotions p\s*\n\s*USING unnest\(\$1::text\[\], \$2::text\[\]\) AS retired\(code, title\)\s*\n\s*WHERE p\.code = retired\.code AND p\.title = retired\.title/,
  );
  const listed = vm.runInNewContext(
    `${dbSource.match(/const RETIRED_SEED_OFFERS = \[[\s\S]*?\n\];/)[0]}
     JSON.stringify(RETIRED_SEED_OFFERS);`,
  );
  assert.deepEqual(JSON.parse(listed), RETIRED_SEED_OFFERS);
});

test('the backfill catches up the old cohort, once, and never runs again', () => {
  const sweep = dbSource.slice(dbSource.indexOf('INSERT INTO promotions'));
  // Keyed on the derived code, so a second boot writes nothing...
  assert.match(
    sweep,
    /AND NOT EXISTS \(SELECT 1 FROM promotions p WHERE p\.code = \$1::text \|\| s\.id::text\)/,
  );
  // ...and two instances booting together do not both get past that check.
  assert.match(sweep, /ON CONFLICT \(code\) DO NOTHING/);
  // It reaches only salons older than the policy. Everything since is covered by the
  // register hook, so a salon that deleted its offer on purpose keeps it deleted rather
  // than being handed it back on the next deploy. A salon with no created_at is old.
  assert.match(sweep, /WHERE \(s\.created_at IS NULL OR s\.created_at < \$8::text\)/);
  assert.match(sweep, /WELCOME_BACKFILL_CUTOFF,/);
  // The window it writes still opens today, not at created_at: dating an offer from a
  // sign-up months back would expire it before anyone saw it.
  assert.match(dbSource, /const welcomeWindowNow = welcomeWindow\(todayISO\(\)\);/);
  assert.doesNotMatch(sweep, /welcomeWindow\(s\.created_at\)|created_at.*starts_at/);
  // Every sweep runs after the seed, so a fresh database is right on its first boot.
  assert.ok(dbSource.indexOf('await seed(db)') < dbSource.indexOf('RETIRED_SEED_OFFERS'));
});

test('the cutoff is a date the salon timestamps can actually be compared against', () => {
  // salons.created_at is a full ISO timestamp in both writers, and the comparison is
  // plain text: every timestamp ON the cutoff day sorts after the bare date, so "before
  // the cutoff" means what it reads as. These are the strings the comparison decides on.
  assert.match(WELCOME_BACKFILL_CUTOFF, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok('2026-08-25T23:59:59.999Z' < WELCOME_BACKFILL_CUTOFF);
  assert.ok(!('2026-08-26T00:00:00.000Z' < WELCOME_BACKFILL_CUTOFF));
  assert.ok(!('2027-01-01T00:00:00.000Z' < WELCOME_BACKFILL_CUTOFF));
  // Both writers really do write that shape.
  assert.match(authSource, /const createdAt = new Date\(\)\.toISOString\(\);/);
  assert.match(seedSource, /created_at: '\d{4}-\d{2}-\d{2}T[\d:.]+Z',/);
});

// ------------------------------------------------------------------ who gets listed

test('an unpublished salon does not get to advertise itself on the offers page', () => {
  // Registration creates the salon — and now its offer — before anyone has looked at
  // either, and salons.published defaults to 0. Without this gate a sign-up would put an
  // arbitrary salon name on uu-dai.html on the spot.
  const listing = handler(promotionsSource, 'const selectActivePromotions', '`);');
  assert.match(listing, /AND \(p\.salon_id IS NULL OR s\.published = 1\)/);
  // In the same statement as the window filter, not a separate pass a caller could skip.
  assert.ok(listing.includes('p.active = 1'));
  // What makes the gate necessary: nothing in the register insert publishes the salon.
  assert.match(authSource, /INSERT INTO salons \(owner_id, name, slug, city, verified, created_at\)/);
  assert.ok(!authSource.includes('INSERT INTO salons (owner_id, name, slug, city, verified, published'));
});

// ------------------------------------------------------------------ the reserved prefix

/** partner.js's own code validator, lifted out with the helper it leans on. */
const requirePromotionCode = vm.runInNewContext(
  `${declaration(partnerSource, 'function optionalText(')}
   ${declaration(partnerSource, 'function requirePromotionCode(')}
   requirePromotionCode;`,
  {
    WELCOME_CODE_PREFIX,
    httpError: (status, code, message) =>
      Object.assign(new Error(message), { status, errorCode: code }),
  },
);

test('a salon cannot take a code out of the family registration writes from', () => {
  // promotions.code is UNIQUE, so a console-made MOI20-99 is a code some future salon
  // number 99 could never be given — its registration would fail on the constraint.
  assert.throws(() => requirePromotionCode('MOI20-99'), /không được bắt đầu bằng "MOI20-"/);
  assert.throws(() => requirePromotionCode('moi20-99'), /không được bắt đầu bằng "MOI20-"/);
  assert.throws(() => requirePromotionCode('  MOI20-1  '), /không được bắt đầu bằng "MOI20-"/);
  // Everything else a salon might want is still its own business, blanks included.
  assert.equal(requirePromotionCode('HE2026'), 'HE2026');
  assert.equal(requirePromotionCode('MOI-20'), 'MOI-20');
  assert.equal(requirePromotionCode(null), null);
  assert.equal(requirePromotionCode('   '), null);
  // And the reservation is the same constant the code is built from, not a copy of it.
  assert.match(partnerSource, /import \{ WELCOME_CODE_PREFIX \} from '\.\.\/lib\/welcome-promotion\.js';/);
  assert.ok(welcomeCode(99).startsWith(WELCOME_CODE_PREFIX));
});

test('the notice the retired code left in the bell is rewritten, not left lying', () => {
  // Keyed on the exact sentence the old seed wrote, so it reaches that notification and
  // nothing else, and says nothing on a database that never had it.
  assert.match(
    dbSource,
    /const RETIRED_WELCOME_NOTICE =\s*\n?\s*'Nhập mã OAKNEW20 khi đặt lịch để được giảm 20% cho buổi hẹn đầu tiên, áp dụng đến 30\/09\/2026\.';/,
  );
  assert.match(
    dbSource,
    /UPDATE notifications SET title = \$1, body = \$2 WHERE body = \$3/,
  );
  // Seed and sweep write the same sentence because it is the same constant.
  assert.match(seedSource, /title: WELCOME_NOTICE_TITLE,\s*\n\s*body: WELCOME_NOTICE_BODY,/);
  assert.ok(!seedSource.includes('Nhập mã OAKNEW20'));
  assert.ok(WELCOME_NOTICE_BODY.includes('20%') && WELCOME_NOTICE_TITLE.includes('20%'));
});

test('the greetings that named the code keep their name and lose the instruction', () => {
  // Every customer who signed up while the platform code was live has "Chào mừng Lan!
  // Nhập mã OAKNEW20 …" in their bell. Those carry a name, so they are rewritten, not
  // replaced. This is the transform the sweep applies, run on the shape auth.js wrote.
  const greeting =
    'Chào mừng Lan! Nhập mã OAKNEW20 khi đặt lịch để giảm 20% cho buổi hẹn đầu tiên.';
  const rewritten = `${greeting.split('!')[0]} — đặt lịch đầu tiên của bạn tại OAK.`;
  assert.equal(rewritten, 'Chào mừng Lan — đặt lịch đầu tiên của bạn tại OAK.');
  // Which is the sentence auth.js itself writes when it has no code to name, so a swept
  // greeting and a fresh one read the same.
  assert.ok(authSource.includes('— đặt lịch đầu tiên của bạn tại OAK.'));
  assert.match(
    dbSource,
    /SET body = split_part\(body, '!', 1\) \|\| ' — đặt lịch đầu tiên của bạn tại OAK\.'\s*\n\s*WHERE body LIKE '%OAKNEW20%'/,
  );
  // The condition is the very thing the rewrite removes, so the second boot does nothing.
  assert.ok(!rewritten.includes('OAKNEW20'));
  // The seeded notice is settled first, by exact match, so only greetings are left here.
  assert.ok(dbSource.indexOf('RETIRED_WELCOME_NOTICE') < dbSource.indexOf("LIKE '%OAKNEW20%'"));
});
