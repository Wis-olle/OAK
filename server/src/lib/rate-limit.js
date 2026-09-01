/*
 * One fixed-window counter, for every door in this codebase that has to say "not that many".
 *
 * Demo-grade throttling: it lives in one process's memory, resets on deploy, and a botnet
 * with many source addresses walks past it. It is a mitigation, not a rate limiter, and
 * production wants a real one at the infrastructure layer or in a shared store. What it does
 * buy is the single script from a single address, which is the shape every abuse this
 * codebase has actually had to answer for takes.
 *
 * Each caller brings its own Map, so one allowance can never spend another: guessing a
 * password, asking for a reset link, opening a claim link and minting a technician page are
 * four separate tallies of the same shape. The window they share is here.
 */
const RATE_WINDOW_MS = 15 * 60 * 1000;

/** Record one attempt for `key` in `attempts`, and hand back what it has spent in the window. */
function countAttempt(attempts, key) {
  const now = Date.now();
  // Swept here rather than on a timer: the Map is only ever walked on a call, so an idle
  // process holds nothing and there is no interval keeping it awake. Whatever survives the
  // sweep is in-window by definition.
  for (const [seen, entry] of attempts) {
    if (now - entry.windowStart >= RATE_WINDOW_MS) {
      attempts.delete(seen);
    }
  }

  const entry = attempts.get(key);
  if (!entry) {
    attempts.set(key, { count: 1, windowStart: now });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

/** Record one attempt for `key` in `attempts`; true once `max` in the window is spent. */
function rateLimited(attempts, key, max) {
  return countAttempt(attempts, key) > max;
}

/* Give back one attempt recorded for `key`, for a caller that took the charge before it knew
   what the call would cost. The free-registration allowance rations PUBLISHED PAGES, and it
   cannot wait to find out whether one appeared before charging: fifty requests arriving
   together would all read a ceiling none of them had charged yet and all be let through. So it
   charges at the door, which is the only thing a single-threaded event loop can do atomically,
   and puts the charge back the moment it is clear no page came of it.

   The entry can be gone by now — the window closed under a slow request and countAttempt swept
   it — and there is nothing to give back then; the tally it belonged to is over. Removed at
   zero rather than left at it, so an address that only ever mistypes holds nothing here and
   starts its next window fresh. */
function refundAttempt(attempts, key) {
  const entry = attempts.get(key);
  if (!entry) {
    return;
  }
  entry.count -= 1;
  if (entry.count <= 0) {
    attempts.delete(key);
  }
}

/* ============================================================================
 * The one tally that is NOT the caller's own: asking whether a phone number is taken
 * ========================================================================= */

/* 409 PHONE_IN_USE is an answer nothing else on this site will give — "somebody here holds
   this number" — and there are two doors it comes out of: a sign-up carrying a number
   (routes/auth.js) and a profile save carrying a new one (routes/users.js). ONE allowance
   covers both, because they answer the identical question and an attacker picks whichever is
   cheaper. Split in two, the ration would be theatre: sign-ups with no number in them are
   free and always will be, so a script mints a throwaway account, spends that account's own
   five saves probing numbers, throws it away and opens another. Charging both doors to the
   caller's address is what makes that loop cost the same as doing it the obvious way.
   Keyed on the address for the same reason: the account doing the asking is free to replace.

   Thirty in the quarter of an hour, per address. It has to sit above a whole shop signing its
   staff up from one wifi and above a phone network's worth of customers behind one CGNAT
   address, since a refusal here is a person unable to open an account. It sits far below a
   contact list, which is the only thing this is asked to stop. Nothing is silently dropped to
   stay under it: past the ceiling the caller is told 429 and can come back, because a number
   quietly discarded is a customer the salon cannot phone. */
const PHONE_LOOKUP_MAX_ATTEMPTS = 30;
const phoneLookupAttempts = new Map();

/** Charge one phone-number question to `ip`; true once the shared allowance is spent. */
function phoneLookupLimited(ip) {
  return rateLimited(phoneLookupAttempts, ip, PHONE_LOOKUP_MAX_ATTEMPTS);
}

export {
  PHONE_LOOKUP_MAX_ATTEMPTS,
  RATE_WINDOW_MS,
  phoneLookupLimited,
  rateLimited,
  refundAttempt,
};
