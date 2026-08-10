/*
 * In-app notifications, written wherever a booking changes state.
 */

import { db } from '../db.js';

const insertNotification = db.prepare(
  'INSERT INTO notifications (user_id, title, body, type, "read", created_at) VALUES (?, ?, ?, ?, 0, ?)',
);

/**
 * Queue one unread notification for a user.
 *
 * No-op when userId is null or undefined: partner walk-in bookings carry user_id NULL,
 * so there is no account to notify, and confirming or cancelling one must not fail
 * just because nobody is listening.
 */
export function notifyUser(userId, title, body, type) {
  if (userId === null || userId === undefined) {
    return;
  }
  insertNotification.run(userId, title, body, type, new Date().toISOString());
}
