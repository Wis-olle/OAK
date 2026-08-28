/*
 * In-app notifications, written wherever a booking changes state.
 */

const INSERT_NOTIFICATION =
  'INSERT INTO notifications (user_id, title, body, type, "read", booking_id, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)';

/**
 * Queue one unread notification for a user. Every caller writes it inside the same
 * transaction as the booking change, so the first argument is that transaction.
 *
 * `bookingId` is what the notification is about, so the UI can open that booking instead
 * of the whole list; it stays null for notifications that point at nothing bookable.
 *
 * No-op when userId is null or undefined: partner walk-in bookings carry user_id NULL,
 * so there is no account to notify, and confirming or cancelling one must not fail
 * just because nobody is listening.
 */
export async function notifyUser(tx, userId, title, body, type, bookingId = null) {
  if (userId === null || userId === undefined) {
    return;
  }
  await tx.run(
    INSERT_NOTIFICATION,
    userId,
    title,
    body,
    type,
    bookingId ?? null,
    new Date().toISOString(),
  );
}

/*
 * The type a technician's own notifications carry, and the reason it is not 'booking'.
 *
 * notifications has no link column: ui/thong-bao.html routes a row by its TYPE, through
 * OAK_NOTIFICATION_LINKS, and every type in that map today points at a customer page. A
 * technician told about their own calendar under 'booking' would be handed a link into the
 * customer's appointment list, which is not their appointment and not a page they can act
 * on. Under its own type the bell degrades the right way instead: an unmapped type is a row
 * with no arrow on it, and the map gains an entry pointing at lich-cua-toi.html when the page
 * is wired up. There is no CHECK constraint on the column, so the string is the whole change.
 */
const STAFF_NOTIFICATION_TYPE = 'staff';

const SELECT_STAFF_ACCOUNT = 'SELECT user_id FROM staff WHERE id = ?';

/**
 * Queue one notification for the person standing behind a roster row.
 *
 * The account is resolved HERE, off the staff row on the caller's own transaction, rather
 * than being passed in: "only a claimed row is notified" is then a single rule in a single
 * place, and no call site can forget it or aim a notice at an account of its own choosing.
 *
 * No-op when the row has no technician (a booking taken without one), when the id names no
 * row at all, and when the row is unclaimed — the ordinary state of a roster the owner typed
 * in by hand. Same reasoning as notifyUser's null-user no-op: there is nobody listening, and
 * a booking must not fail to save because of it.
 *
 * `bookingId` is what the notice is about, exactly as it is for notifyUser.
 */
export async function notifyStaff(tx, staffId, title, body, bookingId = null) {
  if (staffId === null || staffId === undefined) {
    return;
  }
  const staff = await tx.get(SELECT_STAFF_ACCOUNT, staffId);
  await notifyUser(
    tx,
    staff?.user_id ?? null,
    title,
    body,
    STAFF_NOTIFICATION_TYPE,
    bookingId,
  );
}
