/*
 * Booking reference codes: OAK- plus 6 uppercase alphanumerics, shown to the customer.
 */

import { randomInt } from 'node:crypto';
import { httpError } from '../middleware/auth.js';

const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CODE_LENGTH = 6;
const MAX_ATTEMPTS = 5;

function randomCode() {
  let suffix = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    suffix += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return `OAK-${suffix}`;
}

/**
 * Run `insert(code)` with a fresh code, retrying on a duplicate.
 *
 * Codes are drawn at random rather than derived, so two concurrent bookings can draw
 * the same one. The UNIQUE index is the only authority on that: a SELECT-then-INSERT
 * pre-check would still lose the race between the two statements.
 */
export function withBookingCode(insert) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const code = randomCode();
    try {
      insert(code);
      return code;
    } catch (error) {
      if (!String(error.message).includes('UNIQUE constraint failed: bookings.code')) {
        throw error;
      }
    }
  }

  // 5 collisions in a row against a 2-billion code space means something is wrong
  // with the generator, not with this booking.
  throw httpError(500, 'CODE_COLLISION', 'Không tạo được mã đặt lịch, vui lòng thử lại.');
}
