import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../db.js';
import { recordEvent } from '../lib/events.js';
import { sendResetMail } from '../lib/mailer.js';
import { notifyUser } from '../lib/notify.js';
// One rule for phone numbers, shared with the profile update and the console lookup:
// every path that attaches a number to an account folds it the same way.
import { isValidPhone, normalisePhone, phoneHeldByAnother } from '../lib/phone.js';
// The fixed-window counter behind every allowance below, and the one tally that is not
// this file's alone: PATCH /api/users/me answers the same question a sign-up carrying a
// number does, so both doors are charged to the same per-address budget.
import { phoneLookupLimited, rateLimited, refundAttempt } from '../lib/rate-limit.js';
import {
  CLAIM_STAFF_ROW,
  SPEND_STAFF_INVITE,
  findLiveInvite,
  inviteNotFound,
} from '../lib/staff-invite.js';
/* The person's own page, in the two shapes this route needs it. createStaffProfile writes it
   inside the account's own transaction, for the tokenless registration whose whole point is
   that page; ensureStaffProfile is the lazy, prefilled draft every other path in the codebase
   gives a technician, and the register-with-token path takes that one after its commit. */
import { createStaffProfile, ensureStaffProfile } from '../lib/staff-profile.js';
import { slugify } from '../lib/text.js';
import { todayISO } from '../lib/time.js';
// The one offer OAK runs, spelled once for the seed, this route and the db.js backfill.
// Imported under a name of its own: createAccount already has a `welcomeCode` of its
// own — the code a new CUSTOMER is greeted with — and the two are different things.
import {
  WELCOME_DESCRIPTION,
  WELCOME_IMAGE,
  WELCOME_PERCENT,
  WELCOME_TITLE,
  welcomeCode as salonWelcomeCode,
  welcomeWindow,
} from '../lib/welcome-promotion.js';
import {
  COOKIE_NAME,
  COOKIE_OPTIONS,
  JWT_SECRET,
  httpError,
  issueCookie,
  requireAuth,
  selectPublicUser,
  sessionOutlivedPassword,
} from '../middleware/auth.js';
/* The two answers /me carries besides the account itself. Both are owned by the route that
   also serves them on its own — the bell's number and the booking card — so that the header
   can be told them in one breath without a second opinion of either coming into existence
   here. See the handler at the bottom of this file. */
import { nextBookingFor } from './bookings.js';
import { selectUnreadCount } from './notifications.js';

const router = express.Router();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
/* Far past the longest name anybody answers to, so no real person ever meets it, and there
   for a reason that is not tidiness: a technician's page is addressed by a slug built out of
   this name, and the unique btree behind that slug refuses an entry over roughly 2700 bytes —
   so a name long enough registered an account and then died on the INSERT after it with an
   internal error. lib/staff-profile.js holds the same line from the other side. */
const NAME_MAX_LENGTH = 120;
const ROLES = ['customer', 'partner'];
// Short on purpose: the link is the whole secret, so the window in which a leaked one is
// worth anything stays small.
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

/* Demo-grade throttle, shared by /forgot-password and /login. /forgot-password needs one
   because retiring the previous link before minting a new one means anyone able to spam it
   can keep killing the newest link a victim was sent, locking them out of their own reset;
   /login needs one because guessing a password is otherwise free. Fixed window, keyed on
   the address AND the caller, so one noisy client cannot deny every address and one address
   cannot be attacked from a single client. The counter itself, and the window every tally
   here shares, is lib/rate-limit.js. */
const FORGOT_MAX_ATTEMPTS = 3;
const forgotAttempts = new Map();
// Ten in a quarter of an hour: far above a person mistyping their own password, far below
// what guessing needs. Its own tally, so asking for a reset link never spends a sign-in.
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map();
// And ten for opening a claim link, keyed on the caller alone: the preview takes a token
// and nothing else, so there is no address to key on beside it. This one is housekeeping,
// not a defence — it refuses a single bored client that keeps arriving with tokens that
// are not links, and nothing more. Guessing a token is what the 256 bits of it make
// hopeless, and it would go through /staff/register or /staff-me/claim anyway, which take
// the same tokens and count nothing. Its own tally, so reading a link never spends a
// sign-in — and only a MISS is counted, because a whole salon team opens their links from
// the shop's one address and ten of those is an ordinary morning, not abuse.
const INVITE_PREVIEW_MAX_ATTEMPTS = 10;
const invitePreviewAttempts = new Map();
// And five in the quarter of an hour for opening a technician page with no invitation behind
// it, keyed on the caller alone for the same reason the preview is: there is nothing else to
// key on until a body has been read. The calculus is not the one below it — a run of ordinary
// registrations mints hashes and customer rows nobody but their holder ever sees, so what it
// costs is a little CPU, and it is the phone number on them that is worth rationing rather
// than the accounts. A SUCCESSFUL call on this path
// mints a public page, published at birth and open to a search engine, under whatever name was
// typed into the form. So what abuse buys here is pages carrying OAK's name, and five in a
// quarter of an hour is far more than one person opening one career — and the tally is charged
// on the pages actually minted rather than on the attempts, because an attempt refused for its
// name or its missing tick published nothing at all.
const STAFF_REGISTER_MAX_ATTEMPTS = 5;
const staffRegisterAttempts = new Map();
/* And a registration CARRYING A PHONE NUMBER spends from a budget that is not this file's:
   lib/rate-limit.js holds it, and PATCH /api/users/me spends from the same one, because the
   two doors answer the identical question. Only the phone-bearing sign-ups are counted, and
   that is the whole design: a registration with no number in it tells the caller nothing they
   did not already know, while one with a number answers a question they had no right to ask —
   409 PHONE_IN_USE means "yes, somebody here answers to this number", and nothing else on the
   site will say so. Left uncounted, a script walks a contact list through this form and comes
   out the other side knowing which of a person's friends hold an OAK account.

   Counting only the phone-bearing ones is what keeps the allowance affordable for everybody
   else: sign-ups with no number — the smoke suite's dozens of them, a salon opening accounts
   for its own staff — spend nothing and can never be locked out by somebody else's scanning. */

// Comparing against this on the miss path keeps a failed login as slow as a
// successful one, so response time cannot be used to enumerate accounts.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('oak-timing-guard', 10);

const selectCredentials = db.prepare('SELECT id, password_hash FROM users WHERE email = ?');
const selectPasswordHash = db.prepare('SELECT password_hash FROM users WHERE id = ?');
const selectUserIdByEmail = db.prepare('SELECT id FROM users WHERE email = ?');
const selectUserEmail = db.prepare('SELECT email FROM users WHERE id = ?');
// RETURNING spelled out: db.prepare appends ` RETURNING id` to any INSERT that lacks one,
// and this is the only table whose primary key is not called id. Kept as text as well as a
// prepared handle, because the recovery path below writes it inside a caller's transaction.
const INSERT_PASSWORD_RESET =
  'INSERT INTO password_resets (token, user_id, expires_at) VALUES (?, ?, ?) RETURNING token';
const insertPasswordReset = db.prepare(INSERT_PASSWORD_RESET);
const selectPasswordReset = db.prepare(
  'SELECT user_id, expires_at, used FROM password_resets WHERE token = ?',
);
// Conditional on used = 0 so redeeming a token is the same statement that spends it.
const SPEND_PASSWORD_RESET = 'UPDATE password_resets SET used = 1 WHERE token = ? AND used = 0';
// One live link per account: asking for a new one, redeeming one, or changing the password
// from a session all retire whatever was still outstanding. A link the account holder has
// stopped waiting for is a link an attacker holding the mailbox can still spend.
const RETIRE_USER_RESETS = 'UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0';
const retireUserResets = db.prepare(RETIRE_USER_RESETS);
// password_changed_at is written by the same statement that writes the hash, so a changed
// password can never leave the session cut-off behind. Epoch seconds, to match a JWT's iat.
const UPDATE_PASSWORD =
  'UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?';
const SELECT_SALON_BY_SLUG = 'SELECT 1 FROM salons WHERE slug = ?';
const INSERT_USER =
  'INSERT INTO users (name, email, phone, password_hash, role, avatar, created_at, consent_at, marketing_opt_in) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)';
// verified = 1: there is no manual approval step to wait for. The salon is still unlisted
// at this point — salons.published defaults to 0 — because all it holds is a name; its owner
// turns it on from the console once the profile has an address, hours, a service and a photo.
const INSERT_SALON =
  'INSERT INTO salons (owner_id, name, slug, city, verified, created_at) VALUES (?, ?, ?, ?, 1, ?)';
// The city a salon is born with, because the form that creates it asks for a name and
// nothing else. A guess, not an answer — and exported so that the one place which has to
// tell a guess apart from a city the owner typed (routes/import-salon.js, deciding whether
// it may write a location over this one) reads the same string rather than its own copy.
export const REGISTRATION_CITY = 'TP.HCM';
// The welcome offer the salon joins with, written in the same transaction as the salon:
// there is no state in which a salon exists without it. service_ids stays NULL — the
// offer is on everything the salon does, and requireUsablePromotion reads the salon
// scope, not a service list.
const INSERT_WELCOME_PROMOTION = `
  INSERT INTO promotions
    (salon_id, code, type, title, description, discount_percent, image, starts_at, ends_at, active)
  VALUES (?, ?, 'discount', ?, ?, ?, ?, ?, ?, 1)
`;
// The welcome offer a brand-new customer is greeted with: whichever platform-wide code is
// closest to running out, so the one being wound down is the one that gets handed out.
// A salon's own code is not offered — it would send a first-time visitor to one salon.
// The same window bookings.js requireUsablePromotion checks at checkout, so a code named
// here is never one that would be refused there: a promotion that has not started yet is
// not offered, an open-ended one (no ends_at) is, and a combo is not — requireUsablePromotion
// refuses type 'combo' at checkout, so offering one would be a code that cannot be spent.
const SELECT_WELCOME_PROMOTION = `
  SELECT code, discount_percent FROM promotions
  WHERE salon_id IS NULL AND active = 1
    AND type <> 'combo'
    AND (starts_at IS NULL OR starts_at <= ?)
    AND (ends_at IS NULL OR ends_at >= ?)
    AND discount_percent IS NOT NULL
  ORDER BY ends_at LIMIT 1
`;

/** Append -2, -3, ... until the slug is free. Runs inside the register transaction. */
async function uniqueSalonSlug(tx, name) {
  const base = slugify(name) || 'salon';
  let slug = base;
  let suffix = 1;
  while (await tx.get(SELECT_SALON_BY_SLUG, slug)) {
    suffix += 1;
    slug = `${base}-${suffix}`;
  }
  return slug;
}

/** Now, in the unit JWT stamps `iat` with, which is what users.password_changed_at holds. */
function epochSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Create an account and, for partners, the salon that comes with it.
 *
 * Shared by POST /register, POST /partner/register and POST /staff/register: each alias is
 * the same flow with the role fixed, so forcedRole overrides whatever the body claims.
 *
 * `afterInsert` is an optional async (tx, userId) run inside the same transaction, right
 * after the user row exists. It is how a role brings something of its own along — the
 * staff alias uses it to take the roster row over — without this function having to know
 * what that something is. Whatever it RETURNS is spread into the reply's `data`, which is
 * how the same role tells the caller about a thing only it knows the name of.
 *
 * Returns the created user, or undefined when nothing was created: every failure leaves
 * here through next(), so a caller with work of its own to do afterwards has one thing to
 * test rather than having to guess from the response object.
 */
async function createAccount(req, res, next, forcedRole, afterInsert) {
  try {
    const {
      name,
      email,
      phone,
      password,
      role,
      salon_name: salonName,
      consent,
      marketing_opt_in: marketingOptIn,
    } = req.body ?? {};

    if (!name || !email || !password) {
      throw httpError(400, 'VALIDATION_ERROR', 'Vui lòng nhập họ tên, email và mật khẩu.');
    }
    if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
      throw httpError(400, 'VALIDATION_ERROR', 'Họ tên, email và mật khẩu phải là chuỗi ký tự.');
    }
    /* Measured after the spaces are taken off, because ' ' is a string and is truthy, so a
       name of nothing but whitespace walked past both checks above and registered an account
       that appeared under a blank name everywhere its holder was named. The trimmed length is
       also what the cap is read against, for the same reason — and the trimmed STRING is what
       is stored, because a cap read against one value and a column filled with another is not a
       cap at all: 'Mai' followed by a hundred thousand spaces passes both readings below and
       would land a hundred thousand characters in the row. Every value this function writes is
       taken from this one, the salon a partner registration names after its owner included.
       (POST /staff/register's own hook still hands createStaffProfile the name as it arrived,
       and may: slugify strips whitespace, so the address it builds is the same either way.) */
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw httpError(400, 'VALIDATION_ERROR', 'Vui lòng nhập họ tên.');
    }
    if (trimmedName.length > NAME_MAX_LENGTH) {
      throw httpError(400, 'VALIDATION_ERROR', 'Họ tên không được dài quá 120 ký tự.');
    }
    if (phone != null && typeof phone !== 'string') {
      throw httpError(400, 'VALIDATION_ERROR', 'Số điện thoại phải là chuỗi ký tự.');
    }
    // Same rule the form applies: this number is how the salon reaches the person, so a
    // string that is not a number never gets to be stored as one.
    if (phone && !isValidPhone(phone)) {
      throw httpError(400, 'VALIDATION_ERROR', 'Số điện thoại không hợp lệ.');
    }
    /* Charged here: past the shape check, so a mistyped number costs nothing, and before the
       ~90ms of hashing below, so scanning never gets the server's bcrypt for free. Every
       phone-bearing registration is charged whatever it goes on to answer — the 409 further
       down is the answer being rationed, so a refusal that did not count would leave the
       oracle wide open. */
    if (phone && phoneLookupLimited(req.ip)) {
      console.warn(`register: too many phone numbers tried from ${req.ip}`);
      throw httpError(
        429,
        'TOO_MANY_ATTEMPTS',
        'Bạn đã thử quá nhiều số điện thoại. Vui lòng đợi 15 phút rồi thử lại.',
      );
    }
    if (salonName != null && typeof salonName !== 'string') {
      throw httpError(400, 'VALIDATION_ERROR', 'Tên salon phải là chuỗi ký tự.');
    }
    if (!EMAIL_PATTERN.test(email)) {
      throw httpError(400, 'VALIDATION_ERROR', 'Địa chỉ email không hợp lệ.');
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw httpError(400, 'VALIDATION_ERROR', 'Mật khẩu phải có ít nhất 8 ký tự.');
    }
    // An affirmative act, checked here and not only in the form: consent that a caller can
    // leave out is not consent at all. Marketing is asked separately and defaults to off,
    // so silence on it is a no.
    if (consent !== true) {
      throw httpError(
        400,
        'CONSENT_REQUIRED',
        'Vui lòng đồng ý với Điều khoản sử dụng và Chính sách bảo mật để tiếp tục.',
      );
    }

    const accountRole = forcedRole ?? role ?? 'customer';
    // The list gates what a CALLER may name, which is why the check is skipped when
    // forcedRole decided it: forcedRole is a literal written in this file's own routes and
    // is not request input. 'staff' deliberately stays out of ROLES — a staff account is
    // created only by this file's own POST /staff/register, with a claim link or without
    // one, and never because a request asked the public register for that role.
    if (forcedRole == null && !ROLES.includes(accountRole)) {
      throw httpError(400, 'VALIDATION_ERROR', 'Loại tài khoản không hợp lệ.');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const createdAt = new Date().toISOString();

    let userId;
    // Reported back so dang-ky.html only promises a code when one was actually written.
    let welcomeCode = null;
    // Whatever the role's own hook wants the reply to carry, and undefined for every role
    // that wants nothing. `...undefined` in an object literal is legal and adds no key at
    // all, so /register, /partner/register and a staff registration redeeming a token all
    // answer with the byte-identical body they answered with before this existed. It is
    // spread FIRST below, so a hook can add to this reply and can never quietly replace
    // `user` or `welcome_code` with something of its own.
    let extra;
    try {
      await db.withTransaction(async (tx) => {
        // A number a live account already answers to is refused here rather than stored
        // beside it: two rows folding to one number leave the console unable to tell
        // whose walk-in is whose, so neither holder is recognised at the counter again.
        if (phone && (await phoneHeldByAnother(tx, null, phone))) {
          throw httpError(
            409,
            'PHONE_IN_USE',
            'Số điện thoại này đang gắn với một tài khoản khác.',
          );
        }
        userId = Number(
          (
            await tx.run(
              INSERT_USER,
              trimmedName,
              email.trim().toLowerCase(),
              // Stored folded, so the number is comparable to the one a console lookup or
              // a later profile edit brings in rather than only to itself.
              phone ? normalisePhone(phone) : null,
              passwordHash,
              accountRole,
              createdAt,
              createdAt,
              marketingOptIn === true ? 1 : 0,
            )
          ).lastInsertRowid,
        );

        // Whatever this role brings with it, written before anything else and in the same
        // transaction: a claim that could not be recorded takes the account down with it
        // rather than leaving somebody holding an account attached to nothing.
        if (afterInsert) {
          extra = await afterInsert(tx, userId);
        }

        if (accountRole === 'customer') {
          // Something in the bell on the first visit: an account whose Thông báo reads
          // "chưa có thông báo nào" has nothing to come back for. dang-ky.html says so with
          // a toast on arrival, so the two are one message.
          // Not gated on marketing_opt_in: this is the one transactional hello that comes
          // with signing up, not a campaign. That box governs the promotions sent later.
          const today = todayISO();
          const promotion = await tx.get(SELECT_WELCOME_PROMOTION, today, today);
          welcomeCode = promotion ? promotion.code : null;
          await notifyUser(
            tx,
            userId,
            'Chào mừng bạn đến với OAK',
            promotion
              ? `Chào mừng ${trimmedName}! Nhập mã ${promotion.code} khi đặt lịch để giảm ${promotion.discount_percent}% cho buổi hẹn đầu tiên.`
              : `Chào mừng ${trimmedName} — đặt lịch đầu tiên của bạn tại OAK.`,
            promotion ? 'promotion' : 'general',
          );
        }

        if (accountRole === 'partner') {
          const partnerSalonName = salonName || `${trimmedName} Salon`;
          const salonId = Number(
            (
              await tx.run(
                INSERT_SALON,
                userId,
                partnerSalonName,
                await uniqueSalonSlug(tx, partnerSalonName),
                REGISTRATION_CITY,
                createdAt,
              )
            ).lastInsertRowid,
          );
          // Joining IS the offer: the salon's own 20% code is live from the day it signs
          // up. Inside the transaction, so a code that could not be written takes the
          // salon and the account down with it rather than leaving a salon without one.
          const { starts_at: startsAt, ends_at: endsAt } = welcomeWindow(todayISO());
          await tx.run(
            INSERT_WELCOME_PROMOTION,
            salonId,
            salonWelcomeCode(salonId),
            WELCOME_TITLE,
            WELCOME_DESCRIPTION,
            WELCOME_PERCENT,
            WELCOME_IMAGE,
            startsAt,
            endsAt,
          );
        }
      });
    } catch (error) {
      // Let the UNIQUE constraint, not a pre-check, decide the duplicate case:
      // check-then-act straddling the ~90ms bcrypt hash was racy.
      if (error.code === '23505' && error.constraint === 'users_email_key') {
        throw httpError(409, 'EMAIL_TAKEN', 'Email này đã được sử dụng.');
      }
      throw error;
    }

    const user = await selectPublicUser.get(userId);
    issueCookie(res, user);
    res.json({ success: true, data: { ...extra, user, welcome_code: welcomeCode } });
    return user;
  } catch (error) {
    next(error);
    return undefined;
  }
}

router.post('/register', (req, res, next) => createAccount(req, res, next, null));

// Same flow as /register, with the role fixed so a partner sign-up form cannot be
// replayed to create a customer (or the reverse).
router.post('/partner/register', (req, res, next) => createAccount(req, res, next, 'partner'));

/* ============================================================================
 * The claim link a salon owner hands a technician
 *
 * Public, both of them: the token is the whole proof, exactly as a reset link is. A claim
 * link only ever exists for a roster row nobody stands behind yet, and redeeming it is the
 * one way a staff account comes into existence. A technician who has already claimed their
 * row and then lost their password does not come back through here — the salon owner
 * triggers an ordinary reset to their inbox instead (POST /api/partner/staff/:id/invite).
 * ========================================================================= */

// What dang-nhap-nhan-vien.html reads before it asks for anything, so it can say whose
// profile at which salon is being taken over rather than showing a bare password box.
router.get('/staff/invite/:token', async (req, res, next) => {
  try {
    const invite = await findLiveInvite(req.params.token);
    if (!invite) {
      // Counted here and nowhere else. A token that resolves is somebody reading the
      // invitation they were handed, and a salon whose team opens theirs one after another
      // from the shop's wifi would otherwise lock its own last technician out. What the
      // allowance is for is the other shape — a client hammering the lookup with tokens
      // that are not links — and every one of those lands in this branch.
      if (rateLimited(invitePreviewAttempts, req.ip, INVITE_PREVIEW_MAX_ATTEMPTS)) {
        console.warn(`staff invite: too many previews from ${req.ip}`);
        throw httpError(
          429,
          'TOO_MANY_ATTEMPTS',
          'Bạn đã mở liên kết quá nhiều lần. Vui lòng đợi 15 phút rồi thử lại.',
        );
      }
      throw inviteNotFound();
    }

    await recordEvent('staff_invite_opened', '/api/auth/staff/invite/:token');
    res.json({
      success: true,
      data: {
        staff_name: invite.staff_name,
        salon_name: invite.salon_name,
        expires_at: invite.expires_at,
      },
    });
  } catch (error) {
    next(error);
  }
});

/* Two registrations through one door, and the token is what tells them apart.
 *
 * With one, this is what it has always been: the account a claim link was minted for, taking
 * its roster row over on the way in. Without one, it is a technician who has been invited
 * nowhere opening a career page of her own — which needs no salon's permission, because
 * nothing in it belongs to a salon.
 */
router.post('/staff/register', async (req, res, next) => {
  /* The two halves of the free-registration allowance, read by the `finally` at the bottom.
     `reserved` says this request took a charge at the door; `published` says a page came of it.
     A charge with no page behind it is given back, so a refusal costs nothing while the ceiling
     still holds against requests that arrive together. */
  let reserved = false;
  let published = false;
  try {
    const { token, name } = req.body ?? {};
    /* Read before anything else: an unusable link is refused before ~90ms of hashing is
       spent on it. A link whose row was claimed in the meantime is not live any more, so
       that case arrives here as the same 404 as any other dead token.

       And a DEAD token must never fall through into a free registration, which is the single
       most important line in this route. A body carrying a token is somebody saying "I am the
       person this link was handed to"; answering that with a portfolio-only account and a 200
       would leave her believing she had claimed a roster row she has not — reading her own
       calendar for a shift that was never hers, at a salon that never heard of her. So an
       explicit token that does not resolve is refused here, in the same uniform 404 as
       everywhere else, and nothing below this branch ever runs. Only a body that named no
       token at all — absent, or the empty string dang-nhap-nhan-vien.html posts on the free
       path — is a free registration.

       And it is the free registration alone that is rationed. What the allowance counts is
       PAGES rather than attempts, and the two are reconciled by reserving here and refunding in
       the `finally` at the bottom — not by waiting to charge until a page exists. Waiting is
       what makes it useless: everything between this line and the page being written is
       awaited, so fifty requests arriving together would every one of them read a ceiling none
       of them had charged yet, and fifty published pages would come out the other side. This
       increment is the last thing on the path that happens without an await in front of it, so
       it is the only thing here that can hold a limit at all.
       Reserved inside the else rather than ahead of the branch so that an invited technician
       cannot even reach it: a salon whose whole team opens their links from the shop's one wifi
       is the ordinary morning this route was built for, and being turned away from your own
       invitation because five colleagues redeemed theirs first is a defence of nothing. */
    let invite = null;
    if (token != null && token !== '') {
      invite = await findLiveInvite(token);
      if (!invite) {
        throw inviteNotFound();
      }
    } else if (rateLimited(staffRegisterAttempts, req.ip, STAFF_REGISTER_MAX_ATTEMPTS)) {
      console.warn(`staff register: too many free registrations from ${req.ip}`);
      throw httpError(
        429,
        'TOO_MANY_ATTEMPTS',
        'Bạn đã tạo tài khoản quá nhiều lần. Vui lòng đợi 15 phút rồi thử lại.',
      );
    } else {
      reserved = true;
    }

    /* An ordinary registration that takes a roster row over on its way through, or opens a
       page and nothing else. createAccount owns the validation, the consent gate, the hashing
       and the cookie; all this adds is what happens inside its transaction.

       And the two paths put the person's page in at DIFFERENT moments, which is the one thing
       worth reading this route slowly for.

       With a token, the page is an unpublished draft prefilled from the roster row this very
       request is claiming — so it has to be written after that claim is COMMITTED, or the
       prefill would read a row the transaction cannot see yet and copy nothing. Nothing is lost
       by its being outside: a draft nobody has published is invisible either way, and one that
       failed to appear is created on the first visit to the editor by the same lazy call. That
       is exactly the contract POST /api/staff-me/claim keeps, and it is the same situation —
       somebody joining a salon, being given a draft off the row they just took over.

       Without a token there is no such row and no such laziness: the page IS the account, and
       the date on it is the consent that was ticked to create it. An account that came into
       being while its published page did not would be a consent recorded against nothing, so
       that one is written inside the transaction and stands or falls with the account. */
    const created = await createAccount(req, res, next, 'staff', async (tx, userId) => {
      if (invite) {
        // Re-checked here rather than trusted from above: the read straddles the hash, so
        // two people opening one link can both get past it. Both updates are guarded, and
        // whoever actually changes the rows is the one who claimed the profile.
        const claimedAt = new Date().toISOString();
        const claimed = await tx.run(CLAIM_STAFF_ROW, userId, claimedAt, invite.staff_id);
        if (claimed.changes !== 1) {
          throw httpError(409, 'CONFLICT', 'Hồ sơ này đã có người nhận.');
        }
        const spent = await tx.run(SPEND_STAFF_INVITE, invite.token);
        if (spent.changes !== 1) {
          throw httpError(409, 'CONFLICT', 'Hồ sơ này đã có người nhận.');
        }
        return undefined;
      }

      /* With no link there is no roster row to claim — no salon has said anything about her at
         all — so the page IS the registration. Published at birth, because the consent she
         ticked describes exactly this public page and agreeing to it is the act of publishing
         it; a draft here would be an account that consented to a page nobody can read. The
         address comes back so the reply can name where she now lives. */
      const slug = await createStaffProfile(tx, userId, name, new Date().toISOString());
      /* The page the reservation was taken for now exists, so the refund below is off. Set
         HERE, at the write, rather than off `created` after the reply: createAccount answers
         with nothing whenever it took next(), and that includes a reply that failed on its way
         out over a transaction that had already committed. Keyed on `created`, that case would
         refund a charge for a page standing on the public internet. */
      published = true;
      return { slug };
    });
    /* createAccount hands back the account it created and nothing at all when it took the
       error path, so this is the transaction having committed and not an inference from
       the state of the response.

       Two literal recordEvent call sites rather than one with the name chosen above them: this
       table is the one that must never be able to name a person, and the way that is held is
       that every recordEvent in this file reads as a constant pair a scan can check without
       running it (test/staff-persona.test.mjs). A ternary inside the call would be the first
       argument that is not a literal. */
    if (created) {
      if (invite) {
        /* The draft, now that the claim it copies from is on disk. Named off the ACCOUNT rather
           than off the roster row, like every other call to this: the page belongs to the person
           and outlives whatever the salon typed onto a chair. ON CONFLICT DO NOTHING, so this is
           the same idempotent call the editor makes and cannot write over anything.

           And it cannot decide this request's outcome, for the reason recordEvent below gives
           about itself: the whole contract of this row is that it is created lazily on first
           need, so a draft that failed to appear here is created by the next visit to the editor
           and nobody ever knows. Worse, this runs AFTER res.json — the reply is already on the
           wire, and app.js's error handler does not check whether one has been sent before it
           answers, so a throw here would end in a destroyed socket racing the flushed body and a
           page reporting a network failure over an account that exists and is signed in already.
           The failure goes to the log, where it belongs, and the request stands. */
        await ensureStaffProfile(created.id, created.name).catch((error) => {
          console.error('staff-profile: could not seed the draft for', created.id, error);
        });
        await recordEvent('staff_claimed', '/api/auth/staff/register');
      } else {
        await recordEvent('staff_registered', '/api/auth/staff/register');
      }
    }
  } catch (error) {
    next(error);
  } finally {
    /* Nothing was published, so nothing was rationed, so the reservation goes back. This is the
       half that keeps the allowance about pages: dang-nhap-nhan-vien.html checks no length, no
       consent tick and no password of its own, so a technician correcting one refusal at a time
       — a name too long, then a tick she forgot, then a typo in her address — would otherwise
       arrive at her first correct attempt already locked out of a page she never opened.
       In a `finally` rather than beside the 400s, because there is no one place those leave
       from: every refusal in createAccount travels out through next() and comes back here as an
       account that is simply not there. */
    if (reserved && !published) {
      refundAttempt(staffRegisterAttempts, req.ip);
    }
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      throw httpError(400, 'VALIDATION_ERROR', 'Vui lòng nhập email và mật khẩu.');
    }
    if (typeof email !== 'string' || typeof password !== 'string') {
      throw httpError(401, 'INVALID_CREDENTIALS', 'Email hoặc mật khẩu không đúng.');
    }

    // Keyed on the address AND the caller, so a shared office address cannot lock out
    // every account behind it and one account cannot be walked through from one machine.
    // Checked before the hash is compared: guessing should not get the server's work for
    // free either.
    const normalised = email.trim().toLowerCase();
    const attemptKey = `${normalised}|${req.ip}`;
    if (rateLimited(loginAttempts, attemptKey, LOGIN_MAX_ATTEMPTS)) {
      console.warn(`login: too many attempts for ${req.ip}`);
      throw httpError(
        429,
        'TOO_MANY_ATTEMPTS',
        'Bạn đã thử đăng nhập quá nhiều lần. Vui lòng đợi 15 phút rồi thử lại.',
      );
    }

    const credentials = await selectCredentials.get(normalised);
    const matches = await bcrypt.compare(
      password,
      credentials?.password_hash ?? DUMMY_PASSWORD_HASH,
    );
    if (!credentials || !matches) {
      throw httpError(401, 'INVALID_CREDENTIALS', 'Email hoặc mật khẩu không đúng.');
    }

    // Whoever proved they own the account owes the window nothing: only failed guessing
    // accumulates, so signing in and out repeatedly can never lock a person out.
    loginAttempts.delete(attemptKey);

    const user = await selectPublicUser.get(credentials.id);
    issueCookie(res, user);
    // Every staff sign-in, not only the first one. "First" cannot be derived without a
    // column saying so, and the only other way to get it would be putting an account id in
    // the events table — the one table in this schema that must never be able to name a
    // person. So the row says a technician signed in, and nothing more.
    if (user.role === 'staff') {
      await recordEvent('staff_login', '/api/auth/login');
    }
    res.json({ success: true, data: { user } });
  } catch (error) {
    next(error);
  }
});

/** Retire whatever the account had outstanding, then store the new link. */
async function mintReset(token, userId, expiresAt) {
  // Before the insert, never after: the new row must not retire itself.
  await retireUserResets.run(userId);
  await insertPasswordReset.run(token, userId, expiresAt);
}

/**
 * The absolute link a reset mail carries, or null when this deploy has not said where it
 * lives.
 *
 * The link leaves the browser, so it has to be absolute — and what it carries is a live
 * reset token, so the address must never come from anything the caller controls. Render
 * publishes the service's own origin as RENDER_EXTERNAL_URL; PUBLIC_BASE_URL is the same
 * declaration for a host that does not. A forged Host header would otherwise be enough to
 * have OAK mail a victim a genuine link pointing at the attacker's server, so a production
 * deploy that declared neither builds nothing at all rather than trusting the request.
 *
 * One spelling for both callers — /forgot-password and the recovery hatch a salon owner
 * can trigger — because this is the rule that must never drift between them.
 */
function resetLinkUrl(req, token) {
  const declaredOrigin = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_BASE_URL;
  if (!declaredOrigin && process.env.NODE_ENV === 'production') {
    return null;
  }
  const origin = (declaredOrigin || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return `${origin}/dat-lai-mat-khau.html?token=${token}`;
}

/* The way back in for a technician who has lost their password, exported for
   routes/partner.js. It lives here because it is all this file's machinery — the same
   table, the same TTL, the same origin rule, the same mailer — and a second copy of any of
   those is a copy that can drift. (auth.js already exports REGISTRATION_CITY to
   routes/import-salon.js, so a route reaching into this one for a rule it owns is the
   established direction, and there is no cycle.) */

/**
 * Retire whatever links `userId` still had outstanding and mint a new one, inside the
 * CALLER's transaction, so the link and whatever else that transaction writes stand or
 * fall together. Returns the token — which IS the secret, and must reach the account
 * holder and nobody else.
 */
export async function mintResetIn(tx, userId) {
  const token = randomBytes(32).toString('hex');
  // Before the insert, never after: the new row must not retire itself.
  await tx.run(RETIRE_USER_RESETS, userId);
  await tx.run(
    INSERT_PASSWORD_RESET,
    token,
    userId,
    new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString(),
  );
  return token;
}

/**
 * Put the link in front of the person who owns the account, and only them. Called AFTER
 * the commit: a mail sent for a transaction that rolled back points at a token that does
 * not exist. sendResetMail logs its own failures and never rejects.
 *
 * The address is read in here rather than passed in, so a caller with no business knowing
 * a technician's email address never has to hold one.
 */
export async function deliverResetLink(req, userId, token) {
  const account = await selectUserEmail.get(userId);
  const url = account ? resetLinkUrl(req, token) : null;
  if (!url) {
    console.error('recovery link: nowhere to send it — no such account, or no declared origin');
    return;
  }

  /* The one place this deliberately parts company with /forgot-password. There, a deploy
     with no mail channel hands the link back in the reply, because the caller IS the
     account holder. Here the caller is the salon owner, and an owner able to read this
     link could set the password on their technician's account — which is the whole reason
     this path mails a reset instead of minting a link of its own. So it goes to the server
     log and nowhere near the response. */
  if (!process.env.RESEND_API_KEY && process.env.NODE_ENV !== 'production') {
    console.info(`recovery link for user ${userId}: ${url}`);
    return;
  }
  await sendResetMail(account.email, url);
}

router.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = req.body ?? {};
    if (typeof email !== 'string' || !email.trim()) {
      throw httpError(400, 'VALIDATION_ERROR', 'Vui lòng nhập email.');
    }

    // 200 either way, and the same message either way: answering "no such account" would
    // turn this endpoint into an account-enumeration oracle.
    const normalised = email.trim().toLowerCase();
    const account = await selectUserIdByEmail.get(normalised);
    const data = { message: 'Nếu email tồn tại, chúng tôi đã gửi liên kết đặt lại — kiểm tra hộp thư, kể cả mục Spam.' };

    // Over the allowance: the reply is the ordinary one, so the throttle does not become a
    // new oracle of its own — but nothing is retired and nothing is minted, which is the
    // whole point of having it.
    if (!account || rateLimited(forgotAttempts, `${normalised}|${req.ip}`, FORGOT_MAX_ATTEMPTS)) {
      return res.json({ success: true, data });
    }

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();

    // DEMO ONLY — a checkout with no mail channel has nowhere to send the link, so it comes
    // back in the response instead. Two things make that unacceptable anywhere real: the
    // field IS the reset secret, and its mere presence tells the caller the address is
    // registered, which is the enumeration oracle the message above avoids.
    //
    // Hence both halves of the gate. RESEND_API_KEY answers "is there a way to send this?"
    // — wherever there is one, the link is mailed and never written to a response — and the
    // NODE_ENV half keeps a production deploy that forgot the key from falling back to the
    // demo instead of failing quietly, which is the only direction worth failing in.
    if (!process.env.RESEND_API_KEY && process.env.NODE_ENV !== 'production') {
      // This branch must write before it replies, because the token it just minted is what
      // the reply carries. The timing side channel that creates only matters where the
      // field is emitted at all, i.e. never in production.
      await mintReset(token, account.id, expiresAt);
      data.demo_reset_url = `dat-lai-mat-khau.html?token=${token}`;
      return res.json({ success: true, data });
    }

    // Built before the reply, because a production deploy that declared no origin of its
    // own must send nothing at all rather than trust the request's Host header — see
    // resetLinkUrl for why that would be enough to mail a victim an attacker's link.
    const url = resetLinkUrl(req, token);
    if (!url) {
      console.error(
        'forgot-password: no RENDER_EXTERNAL_URL or PUBLIC_BASE_URL configured, not mailing',
      );
      return res.json({ success: true, data });
    }

    // Reply first, work after: a known address would otherwise take two round trips
    // longer to answer than an unknown one, and response time would say what the message
    // deliberately does not. Nothing after this line may throw into `next` — the reply is
    // already on the wire — so the write reports failure to the log instead. The mail is
    // sent only once the token is stored, or the link would arrive dead; sendResetMail
    // logs its own failures and never rejects.
    res.json({ success: true, data });
    return mintReset(token, account.id, expiresAt)
      .then(() => sendResetMail(normalised, url))
      .catch((error) => {
        console.error('forgot-password: could not store the reset token:', error);
      });
  } catch (error) {
    next(error);
  }
});

router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, password } = req.body ?? {};
    if (typeof token !== 'string' || !token || typeof password !== 'string') {
      throw httpError(400, 'VALIDATION_ERROR', 'Vui lòng nhập mật khẩu mới.');
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw httpError(400, 'VALIDATION_ERROR', 'Mật khẩu phải có ít nhất 8 ký tự.');
    }

    // Read first so an unusable link is refused before ~90ms of hashing is spent on it.
    const reset = await selectPasswordReset.get(token);
    if (!reset || reset.used === 1 || new Date(reset.expires_at).getTime() <= Date.now()) {
      throw httpError(
        400,
        'INVALID_RESET_TOKEN',
        'Liên kết đặt lại không hợp lệ hoặc đã hết hạn. Vui lòng yêu cầu liên kết mới.',
      );
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await db.withTransaction(async (tx) => {
      // Re-checked here, not above: the read straddles the hash, so two concurrent
      // redemptions of one link can both pass it. Whoever spends the row wins; the loser
      // changes nothing, because the password update rides in the same transaction.
      const spent = await tx.run(SPEND_PASSWORD_RESET, token);
      if (spent.changes !== 1) {
        throw httpError(
          400,
          'INVALID_RESET_TOKEN',
          'Liên kết đặt lại không hợp lệ hoặc đã hết hạn. Vui lòng yêu cầu liên kết mới.',
        );
      }
      // The spend above covers this link; this covers every other one the account still
      // had outstanding, so one completed reset closes them all.
      await tx.run(RETIRE_USER_RESETS, reset.user_id);
      // Whoever was signed in on the old password is signed out by this: the reset path is
      // exactly the case where that other session may be the attacker's.
      await tx.run(UPDATE_PASSWORD, passwordHash, epochSeconds(), reset.user_id);
    });

    // Signed in on the way out: whoever just proved they hold the mailbox and chose the
    // new password has no reason to be asked for it again on the next screen (WCAG 3.3.7).
    // Minted after the write, so its iat cannot fall before the cut-off it must survive.
    const user = await selectPublicUser.get(reset.user_id);
    issueCookie(res, user);
    res.json({ success: true, data: { user } });
  } catch (error) {
    next(error);
  }
});

// Changing a password from inside a session, which is a different act from resetting a
// forgotten one: the current password is the proof, not a mailed link.
router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const { current_password: currentPassword, new_password: newPassword } = req.body ?? {};
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      throw httpError(400, 'VALIDATION_ERROR', 'Vui lòng nhập mật khẩu hiện tại và mật khẩu mới.');
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      throw httpError(400, 'VALIDATION_ERROR', 'Mật khẩu mới phải có ít nhất 8 ký tự.');
    }

    const credentials = await selectPasswordHash.get(req.user.id);
    if (!(await bcrypt.compare(currentPassword, credentials.password_hash))) {
      throw httpError(400, 'INVALID_CREDENTIALS', 'Mật khẩu hiện tại không đúng.');
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    const changedAt = epochSeconds();
    // One transaction: a password that changed while an old reset link stayed live would
    // leave that link able to change it straight back.
    await db.withTransaction(async (tx) => {
      await tx.run(UPDATE_PASSWORD, passwordHash, changedAt, req.user.id);
      await tx.run(RETIRE_USER_RESETS, req.user.id);
    });

    // Every session minted before changedAt is now dead, this caller's included — so it is
    // handed a fresh one. Signed after the write, so its iat cannot predate the cut-off;
    // the other devices, holding older tokens, still get logged out.
    issueCookie(res, req.user);
    res.json({ success: true, data: { ok: true } });
  } catch (error) {
    next(error);
  }
});

router.post('/logout', (req, res) => {
  // Derived from COOKIE_OPTIONS so the two can never drift apart.
  const { maxAge, ...clearOptions } = COOKIE_OPTIONS;
  res.clearCookie(COOKIE_NAME, clearOptions);
  res.json({ success: true, data: { ok: true } });
});

/*
 * Optional auth: a guest is a normal outcome here, not a 401. Every page probes this on
 * load, so an anonymous visitor gets 200 {user:null} and the browser console stays clean;
 * the endpoints that genuinely need a session keep using requireAuth.
 *
 * A signed-in reader gets two more fields on the account, and the reason is that every page
 * load used to make three requests to draw one header: this one, the bell's unread count,
 * and the customer's next appointment. Two of the three answered a single number and a
 * single row, both of them cheap, both of them wanted by the page that had already asked
 * this question. So they ride along. GET /api/notifications?count_only=true and GET
 * /api/bookings/mine both stay exactly as they were — the pages that refresh a count after
 * marking something read still need them — and the numbers come from the same statements,
 * so the two doors cannot disagree.
 *
 * next_booking is for customers alone: it is the header strip's row, and a partner or a
 * technician meets the site through a console that has no such strip.
 */
router.get('/me', async (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  let user = null;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
      user = (await selectPublicUser.get(payload.id)) ?? null;
      // Same cut-off requireAuth applies. Without it the header would keep showing a
      // signed-in reader whose every action already 401s.
      if (user && sessionOutlivedPassword(payload, user)) {
        user = null;
      }
    } catch {
      user = null;
    }
  }
  if (user) {
    user.unread_count = (await selectUnreadCount.get(user.id)).count;
    if (user.role === 'customer') {
      user.next_booking = await nextBookingFor(user.id);
    }
  }
  res.json({ success: true, data: { user } });
});

export default router;
