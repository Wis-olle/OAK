/*
 * In-app notifications, written wherever a booking changes state.
 */

const INSERT_NOTIFICATION =
  'INSERT INTO notifications (user_id, title, body, type, "read", created_at) VALUES (?, ?, ?, ?, 0, ?)';

/**
 * Queue one unread notification for a user. Every caller writes it inside the same
 * transaction as the booking change, so the first argument is that transaction.
 *
 * No-op when userId is null or undefined: partner walk-in bookings carry user_id NULL,
 * so there is no account to notify, and confirming or cancelling one must not fail
 * just because nobody is listening.
 */
export async function notifyUser(tx, userId, title, body, type) {
  if (userId === null || userId === undefined) {
    return;
  }
  await tx.run(INSERT_NOTIFICATION, userId, title, body, type, new Date().toISOString());
}
