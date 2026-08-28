/*
 * The claim link a salon owner hands a technician — in person, or over Zalo. Whoever
 * holds it is, by construction, the person the owner meant to give it to, so the link
 * itself is the whole proof and there is no mail channel in the middle.
 *
 * Four call sites reach this table: the owner minting and revoking a link
 * (routes/partner.js), the public preview and the redeem that creates the account
 * (routes/auth.js), and the redeem by somebody who already holds an OAK account
 * (routes/staff-me.js). All four have to agree on what "still usable" means and all four
 * have to refuse an unusable one identically, so both are written here once.
 */
import { db } from '../db.js';
import { httpError } from '../middleware/auth.js';

// A week: long enough that a link handed over on a Monday survives the technician's next
// day off, short enough that a screenshot left in a group chat stops being worth anything.
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// RETURNING spelled out: db.prepare appends ` RETURNING id` to an INSERT that lacks one,
// and this table's primary key is the token — the same reason insertPasswordReset in
// routes/auth.js spells its own.
export const INSERT_STAFF_INVITE = `
  INSERT INTO staff_invites (token, staff_id, created_by, expires_at, used, created_at)
  VALUES (?, ?, ?, ?, 0, ?) RETURNING token
`;
// One live link per roster row: minting a new one, revoking, or spending one retires
// whatever was still outstanding. A link the owner has stopped waiting for is a link
// whoever was standing behind them when they showed the phone can still spend.
export const RETIRE_STAFF_INVITES =
  'UPDATE staff_invites SET used = 1 WHERE staff_id = ? AND used = 0';
// Conditional on used = 0, the way SPEND_PASSWORD_RESET is: redeeming a link is the same
// statement that spends it, so two people opening one link cannot both come out with a
// claim — whoever changes the row wins and the other one changes nothing.
export const SPEND_STAFF_INVITE = 'UPDATE staff_invites SET used = 1 WHERE token = ? AND used = 0';
// Guarded on user_id IS NULL for the same reason, and because it is the rule itself: a
// roster row describes one employment stint and can only be taken over once.
export const CLAIM_STAFF_ROW =
  'UPDATE staff SET user_id = ?, claimed_at = ? WHERE id = ? AND user_id IS NULL';

/* Everything the redeem screens need about a link, and the whole definition of a link
   that can still be spent: not yet used, not yet expired, pointing at a roster row the
   salon still has, and pointing at one nobody stands behind yet.

   The last two clauses are why the join is here rather than in the callers. An invite for
   a technician who has left is dead however fresh the token is; so is one for a row that
   was claimed in the meantime, which is the real race — the owner mints a link, and the
   technician claims the row through /api/staff-me/claim with an account they already had
   before ever opening it. Both belong in the validity rule rather than in a branch at each
   of the three call sites: put here, they come out as the same uniform 404 as any other
   dead token, which is one fewer thing a reply can be read to say. */
const SELECT_LIVE_INVITE = `
  SELECT i.token, i.staff_id, i.expires_at,
         st.name AS staff_name,
         s.id AS salon_id, s.name AS salon_name
  FROM staff_invites i
  JOIN staff st ON st.id = i.staff_id
  JOIN salons s ON s.id = st.salon_id
  WHERE i.token = ? AND i.used = 0 AND i.expires_at > ?
    AND st.active = 1 AND st.user_id IS NULL
`;
const selectLiveInvite = db.prepare(SELECT_LIVE_INVITE);

/** The invite behind `token`, or undefined when there is nothing left to spend. */
export async function findLiveInvite(token) {
  if (typeof token !== 'string' || !token) {
    return undefined;
  }
  // expires_at is an ISO-8601 UTC string and so is this, and that format sorts
  // lexicographically in the order the instants happened, which is what makes the
  // comparison mean what it looks like it means.
  return selectLiveInvite.get(token, new Date().toISOString());
}

/**
 * The one refusal every path that takes a token gives back.
 *
 * Garbage, already spent, expired, pointing at somebody who no longer works here, or
 * pointing at a row that has since been claimed: all of them answer with this exact body,
 * so the reply cannot be used to tell a real token from an invented one — or to find out
 * whether a technician still works at a salon, or whether they hold an account.
 */
export function inviteNotFound() {
  return httpError(
    404,
    'NOT_FOUND',
    'Liên kết không hợp lệ hoặc đã hết hạn. Vui lòng hỏi chủ salon một liên kết mới.',
  );
}

/** Where the link the owner copies actually points. */
export function inviteUrl(token) {
  return `/dang-nhap-nhan-vien.html?invite=${token}`;
}
