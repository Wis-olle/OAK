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
