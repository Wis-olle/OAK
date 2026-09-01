/*
 * One rule for phone numbers, because three places have to agree on it: the sign-up form's
 * server side, the profile update, and the console's lookup of the account behind a walk-in
 * number. A number is typed as '+84 903 555 111' as readily as '0903555111', so every side
 * of every comparison is folded to the same shape before it is compared — and stored in
 * that shape too, or only half the comparison would ever match.
 */

/**
 * '+84 903 555 111', '0901.234.567' and '0901-234-567' all fold to the same digits, and
 * a leading country code becomes the leading 0 the rest of the app stores.
 *
 * Every separator, not only whitespace: dots and dashes are as common a Vietnamese
 * spelling as spaces, and folding one but not the others split the same person into two
 * customers in the console and stopped a walk-in from ever finding their account.
 */
export function normalisePhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.startsWith('84') ? `0${digits.slice(2)}` : digits;
}

// The shape dang-ky.html accepts, applied on the server as well: digits with the separators
// a person actually types. Deliberately loose (a Vietnamese number is written many ways),
// but tight enough that a profile field cannot be swept through arbitrary strings.
const PHONE_PATTERN = /^[\d\s+.-]{8,15}$/;

/**
 * Whether `value` is shaped like a phone number a person would type. The separator test
 * alone accepted "--------", so the digits it folds down to are counted as well: fewer
 * than eight and there is no number in there to store.
 */
export function isValidPhone(value) {
  const text = String(value ?? '').trim();
  return PHONE_PATTERN.test(text) && normalisePhone(text).length >= 8;
}

/**
 * normalisePhone as SQL, for the stored side of a comparison. Rows written before this
 * rule existed (and every seeded one) still hold their spaces and dots, so the column is
 * folded in the query rather than trusted to already be folded.
 */
export function normalisedPhoneSql(column) {
  return `regexp_replace(regexp_replace(coalesce(${column}, ''), '[^0-9]', '', 'g'), '^84', '0')`;
}

/* A booking taken at the counter carries a phone number and no account, and for a while
   typing that number into a sign-up form claimed every one of them. It is not enough, and it
   never was: the number is typed, not verified, so anybody who knows a person's number could
   help themselves to that person's history. So nothing links a booking by phone any more, and
   nothing will until a code sent to the number is checked. The salon's own console still
   attaches a walk-in to an account it recognises (routes/partner.js accountForPhone) — that is
   a number read off the customer standing at the counter, not one a stranger typed into a form.

   What survives here is the one refusal: a number some other live account already answers to
   is turned away out loud (409) rather than stored beside it, because one number answering for
   two accounts is exactly what leaves that console lookup unable to tell whose walk-in is
   whose. The person typing it is owed an answer either way.
*/
const PHONE_HELD_BY_ANOTHER = `
  SELECT 1 FROM users
  WHERE id <> ? AND deleted_at IS NULL AND ${normalisedPhoneSql('phone')} = ?
  LIMIT 1
`;

/**
 * Whether some *other* live account already answers to `phone`.
 *
 * `tx` is a db.withTransaction handle; `userId` is the account doing the claiming, or
 * null when it does not exist yet (a registration). Asked before the number is written
 * rather than after it: two rows folding to one number make the console's "which account is
 * this walk-in?" lookup ambiguous, and would leave the rightful holder unrecognised at the
 * counter ever after.
 *
 * A SELECT, not a constraint: two registrations racing on the same number can both pass
 * and both write, and rows seeded or written before this check existed can already
 * collide. That is why routes/partner.js accountForPhone accepts a number only when
 * exactly one account answers to it — load-bearing, not belt-and-braces.
 */
export async function phoneHeldByAnother(tx, userId, phone) {
  const normalised = normalisePhone(phone);
  if (!normalised) {
    return false;
  }
  // 0 is no account's id, so a registration compares against every row.
  return Boolean(await tx.get(PHONE_HELD_BY_ANOTHER, userId ?? 0, normalised));
}
