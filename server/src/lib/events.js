/*
 * Funnel events the server counts for itself.
 *
 * routes/events.js is the page-facing half of this table: it needs a live request, because
 * what it stores is derived from one. The server also has moments worth counting that no
 * page can see — a claim link being minted, a roster row being taken over — and those rows
 * are written here instead.
 *
 * The events table is the one table in the schema that must not be able to name a person,
 * which is what `page` is for: it carries the SHAPE of the route
 * ('/api/partner/staff/:id/invite'), never a filled-in id, and ref, meta and session_hash
 * stay NULL because there is no visitor behind these rows to describe.
 */
import { db } from '../db.js';

const insertEvent = db.prepare(
  `INSERT INTO events (name, page, ref, meta, session_hash, created_at)
   VALUES (?, ?, NULL, NULL, NULL, ?)`,
);

/**
 * Count one thing that happened.
 *
 * Never fails its caller: measurement that can take a technician's claim down with it is
 * worse than measurement with a row missing, so the failure is logged here and goes no
 * further. Call sites still await it, so a test can read the row back the moment the
 * response lands.
 */
export async function recordEvent(name, page = null) {
  try {
    await insertEvent.run(name, page, new Date().toISOString());
  } catch (error) {
    console.error(`events: could not record ${name}:`, error);
  }
}
