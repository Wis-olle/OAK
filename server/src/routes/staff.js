// Public staff profiles: detail, week availability, reviews.
import express from 'express';
import { db } from '../db.js';
import { getStaffSlots, getStaffWeek, timeOffOn } from '../lib/availability.js';
import { parseJsonArray, parsePagination } from '../lib/query.js';
import { careerOf, stintShape } from '../lib/staff-career.js';
import { staffStats, VISIBLE_PROFILE } from '../lib/staff-stats.js';
import { addDaysISO, isISODate, todayISO } from '../lib/time.js';
import { httpError } from '../middleware/auth.js';

const router = express.Router();

const REVIEW_LIMIT = 10;
const DEFAULT_DAYS = 7;
const MIN_DAYS = 1;
const MAX_DAYS = 14;

/* The other half of the page gate, and deliberately not a plain active = 1.
 *
 * A row off the roster is two entirely different things depending on whether anybody stands
 * behind it. Unclaimed, it is a chair the salon has taken out of service and nothing more, so
 * the page describing it goes with it. Claimed, it is a person whose stint has ENDED — and
 * this page is her CV, the thing the whole persona feature exists to give her. A technician
 * between salons holds no open row anywhere, and answering 404 to the one page that carries
 * her work would delete her working life on the day she left. So she keeps her page, and what
 * it stops being is bookable: the booking wizard's picker, the day strip and the service list
 * are all gated on active = 1 separately, and none of them is touched by this.
 */
const CLAIMED_OR_ON_ROSTER = '(st.user_id IS NOT NULL OR st.active = 1)';

// THIS IS the public profile page, so the withdrawal lands here first: a hidden row answers
// 404 in the same words as an id that names nobody. Not "no longer exists" and not "hidden" —
// a reply that told those apart would put the page back up in the negative.
const selectStaffProfile = db.prepare(`
  SELECT st.id, st.user_id, st.name, st.title, st.specialty, st.bio, st.image, st.rating,
         st.years_experience, st.portfolio,
         s.id AS salon_id, s.slug AS salon_slug, s.name AS salon_name
  FROM staff st
  JOIN salons s ON s.id = st.salon_id
  WHERE st.id = ? AND ${CLAIMED_OR_ON_ROSTER} AND ${VISIBLE_PROFILE}
`);

/* Deliberately NOT gated on the withdrawal: this is what /:id/availability and /:id/services
   resolve their path through, and both of those are operational. Once the booking wizard has
   a technician, those two size the day strip and list what that person performs — and a
   technician who has taken their page down is still at work today, still on the calendar, and
   still owed the appointments the salon has already put on it. Hiding a page is not calling
   in sick. The review list below asks the visible question instead, on its own statement. */
const selectStaffExists = db.prepare('SELECT 1 FROM staff WHERE id = ? AND active = 1');

const selectVisibleStaffExists = db.prepare(
  `SELECT 1 FROM staff st WHERE st.id = ? AND ${CLAIMED_OR_ON_ROSTER} AND ${VISIBLE_PROFILE}`,
);

const selectStaffSalon = db.prepare('SELECT salon_id FROM staff WHERE id = ?');

const selectStaffReviews = db.prepare(`
  SELECT r.id, r.rating, r.comment, r.created_at,
         u.name AS user_name, u.avatar AS user_avatar
  FROM reviews r
  LEFT JOIN users u ON u.id = r.user_id
  WHERE r.staff_id = ?
  ORDER BY r.created_at DESC, r.id DESC
  LIMIT ? OFFSET ?
`);

// What this one technician is booked for: the staff-profile week grid is sized by their
// longest service until one of these is chosen, and then by that one.
const selectStaffServices = db.prepare(`
  SELECT sv.id, sv.name, sv.price, sv.price_is_from, sv.duration_min, sv.category
  FROM services sv
  JOIN staff_services ss ON ss.service_id = sv.id
  WHERE ss.staff_id = ? AND sv.active = 1
  ORDER BY sv.featured DESC, sv.category, sv.price
`);

// Computed over every review of this staff member, not just the page being served.
const selectStaffReviewSummary = db.prepare(
  'SELECT COUNT(*) AS total, ROUND(AVG(rating), 1) AS average FROM reviews WHERE staff_id = ?',
);

/** Resolve a :id path segment to an existing active staff id, or 404. */
async function staffIdOrThrow(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || !(await selectStaffExists.get(id))) {
    throw httpError(404, 'NOT_FOUND', 'Không tìm thấy kỹ thuật viên này.');
  }
  return id;
}

/** The same resolution for the reads that ARE the public profile, in the same words. */
async function visibleStaffIdOrThrow(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || !(await selectVisibleStaffExists.get(id))) {
    throw httpError(404, 'NOT_FOUND', 'Không tìm thấy kỹ thuật viên này.');
  }
  return id;
}

/**
 * Per-day slots for one technician performing one service, in getStaffWeek's shape —
 * `closed` included, because this is the endpoint the wizard's day strip calls once a
 * technician has been chosen, and without the flag it strikes a declared day off through
 * as "full". The salon is read once for the whole week, the day-off rows once per date.
 *
 * Sized by the chosen service's duration — the same calculation POST /api/bookings
 * validates against — so the picker never hides a start time the API would accept.
 */
async function getServiceWeek(staffId, serviceId, from, days) {
  const salonId = (await selectStaffSalon.get(staffId))?.salon_id ?? null;
  const week = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = addDaysISO(from, offset);
    const off = salonId === null ? { salon: false, staff: new Set() } : await timeOffOn(salonId, date);
    week.push({
      date,
      closed: off.salon || off.staff.has(staffId),
      // The day-off rows this loop just read are the ones getStaffSlots would go and read
      // again, once per day of the week.
      slots: await getStaffSlots(staffId, serviceId, date, off),
    });
  }
  return week;
}

router.get('/:id/availability', async (req, res, next) => {
  try {
    const staffId = await staffIdOrThrow(req.params.id);

    const from = req.query.from === undefined ? todayISO() : req.query.from;
    if (!isISODate(from)) {
      throw httpError(400, 'VALIDATION_ERROR', 'Ngày bắt đầu phải theo định dạng YYYY-MM-DD.');
    }

    const days = Math.min(
      MAX_DAYS,
      Math.max(MIN_DAYS, Number.parseInt(req.query.days, 10) || DEFAULT_DAYS),
    );

    // With ?service_id the grid is sized for that one service; without it, the week
    // grid keeps its max-duration sizing for the staff-profile view.
    let serviceId = null;
    if (req.query.service_id !== undefined) {
      serviceId = Number.parseInt(req.query.service_id, 10);
      if (!Number.isInteger(serviceId) || serviceId <= 0) {
        throw httpError(400, 'VALIDATION_ERROR', 'Mã dịch vụ không hợp lệ.');
      }
    }

    const week =
      serviceId === null
        ? await getStaffWeek(staffId, from, days)
        : await getServiceWeek(staffId, serviceId, from, days);

    res.json({ success: true, data: { from, week } });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/services', async (req, res, next) => {
  try {
    const rows = await selectStaffServices.all(await staffIdOrThrow(req.params.id));
    res.json({
      success: true,
      data: rows.map((row) => ({ ...row, price_is_from: Boolean(row.price_is_from) })),
      meta: { total: rows.length },
    });
  } catch (error) {
    next(error);
  }
});

/* Gated with the page, because it IS the page: this is the review list the public profile
   renders under itself, so it stands or falls on exactly the same question — leaving it open
   would serve the contents of a page that is no longer there, the same words, the same faces,
   one endpoint further in, and closing it a stint early would strip the reviews off a CV whose
   profile is still standing.

   What is deliberately NOT touched is the salon's own list. GET /api/salons/:id/reviews joins
   staff_name and goes on naming this technician in the reviews of visits they worked: that is
   the salon's record of its own work, written by its own customers, and gutting it to honour
   one person's withdrawal would take the salon's history down with the technician's page. */
router.get('/:id/reviews', async (req, res, next) => {
  try {
    const staffId = await visibleStaffIdOrThrow(req.params.id);
    const { page, limit, offset } = parsePagination(req.query, REVIEW_LIMIT);
    const summary = await selectStaffReviewSummary.get(staffId);
    const rows = await selectStaffReviews.all(staffId, limit, offset);

    res.json({
      success: true,
      data: rows.map((row) => ({
        id: row.id,
        rating: row.rating,
        comment: row.comment,
        created_at: row.created_at,
        user: { name: row.user_name, avatar: row.user_avatar },
      })),
      meta: { page, limit, total: summary.total, average: summary.average ?? 0 },
    });
  } catch (error) {
    next(error);
  }
});

/* The CV this endpoint answers with is lib/staff-career.js, keyed by the person: the row in
   the path is only how the person is found. Its own gate is here — claimed AND hidden is 404,
   in the same words a missing id gets. */
const selectVisibleStaffRow = db.prepare(`
  SELECT st.id, st.user_id, st.active, st.started_at, st.left_at, st.left_by,
         st.started_confirmed_at, st.left_confirmed_at, st.tenure_disputed,
         s.id AS salon_id, s.slug AS salon_slug, s.name AS salon_name
  FROM staff st
  JOIN salons s ON s.id = st.salon_id
  WHERE st.id = ? AND ${VISIBLE_PROFILE}
`);

router.get('/:id/history', async (req, res, next) => {
  try {
    const row = /^\d+$/.test(req.params.id)
      ? await selectVisibleStaffRow.get(Number(req.params.id))
      : null;
    if (!row) {
      throw httpError(404, 'NOT_FOUND', 'Không tìm thấy kỹ thuật viên này.');
    }

    /* A row nobody stands behind is a CV of one: it describes a chair at one salon, and there
       is no person tying it to any other row. Same answer after an account is erased, which
       clears user_id off every row it held (RELEASE_STAFF_ROWS in routes/users.js) — the
       stints stop being one person's history, because there is no longer a person. */
    const data = row.user_id === null ? [await stintShape(row)] : await careerOf(row.user_id);

    res.json({ success: true, data, meta: { total: data.length } });
  } catch (error) {
    next(error);
  }
});

/* The person behind the chair, if there is one and if she has put her own page on the public
 * side. Both halves of the gate are in the statement and neither is optional: published_at
 * IS NOT NULL is the consent — a draft nobody agreed to publish is not a page — and hidden = 0
 * is the withdrawal, the same one VISIBLE_PROFILE asks of a roster row, asked again about the
 * person because taking your page down has to reach every surface it was on. COALESCE for the
 * reason it is there above: a column that has never been written is 0, not a reason to vanish.
 */
const selectPublishedProfile = db.prepare(`
  SELECT slug, bio, image, portfolio, years_experience
  FROM staff_profiles
  WHERE user_id = ? AND published_at IS NOT NULL AND COALESCE(hidden, 0) = 0
`);

/** Whether a self-declared text column actually carries a declaration. '' is a cleared field. */
function declared(value) {
  return value !== null && value !== undefined && value !== '';
}

/**
 * Which of the two voices this stint page speaks the personal half in.
 *
 * A roster row's bio, face and gallery are what the salon's own record of that chair carries.
 * A published profile is what the PERSON says about herself, and the override exists so that HER
 * words win: she wrote them, they are one page across every salon she has worked at, and the
 * address they live at (`technician.slug`) rides along so a reader can go from the stint to the
 * career.
 *
 * Which is why the override is FIELD-WISE and not wholesale. A page that says nothing has no
 * words to win with, so the salon's record of that chair stands until she writes over it. That
 * is not a corner case any more: registering needs no invitation, so a technician can hold a
 * PUBLISHED page with every field empty — one is created that way, published, the moment she
 * signs up — and be rostered afterwards by a salon that enters a photo and eight years. An
 * all-or-nothing override would take that photo and those years off her stint page the instant
 * she claimed the chair, while the salon's own team strip went on showing both.
 *
 * "Says nothing" is emptiness of every kind the two writers can produce: null and '' for the bio
 * and the face, an empty list for the gallery, and null OR ZERO for the years — createStaffProfile
 * inserts 0 rather than NULL, so a plain COALESCE would read "she declared zero years" out of a
 * column nobody has touched.
 *
 * The other direction — seeding the existing row from the roster record when she claims — was
 * considered and refused. Her page is already PUBLISHED at that moment, so filling it would put
 * the salon's bio and photograph on her public career page, under her name and her byline,
 * without her ever having pressed anything. That is a worse defect than the one it fixes: this
 * fallback shows the salon's record on the SALON's own stint page, where it has always been and
 * where nothing is labelled as hers.
 *
 * Where there is no published profile the answer is exactly the row — and exactly the reply
 * this endpoint sent before this table existed, down to the last key. That covers a chair
 * nobody stands behind, a technician who never opened the editor, a draft she never published,
 * and a page she has taken back down: four different situations that must all look the same
 * from out here, because telling them apart would leak the existence of a page somebody chose
 * not to show. The gate itself is untouched by the field-wise rule above: an unpublished or
 * hidden page still returns the row wholesale, because the question there is not whose words
 * these are but whether there is a page at all.
 *
 * Which is why `link` is a whole key that is spread in rather than a `technician` field set to
 * null. A page nobody has published has nothing to say about a person, and saying null about
 * her is still saying something — it is this endpoint announcing, on every chair on OAK, that
 * there is a person-shaped hole here and a table somewhere that fills it. An absent key says
 * nothing at all, and nothing at all is the truth. The slug is the sharpest case of the same
 * rule: an address is the one thing an unpublished page must never hand out.
 *
 * name, title, specialty and rating are not in it at all. Those are the salon's words about a
 * job and OAK's own count of what its customers said, and a stint page goes on speaking them
 * whoever else has a page.
 *
 * SCOPE, and a question left open on purpose. This override covers ONE surface: the stint page
 * that GET /api/staff/:id serves. Every other place a technician's face and years appear still
 * reads them off the roster row — the salon's team strip out of routes/salons.js, and the
 * technician picker in the booking wizard out of routes/services.js. So a published profile
 * can show one photo on her stint page and another on the salon card that links to it, and
 * that really is a disagreement rather than a distinction: both are OAK showing a customer
 * the same person.
 *
 * It is left that way here deliberately, and not by oversight. This slice's headline property
 * is that nothing publicly visible moves until somebody publishes, and reaching into the
 * booking picker to make it read a second table is a change to the surface that sells hours —
 * a much wider blast radius than the page this endpoint serves, and one nobody has reviewed.
 * Consent-first holds either way: an unpublished profile is invisible on every one of these
 * surfaces, because they are all still reading the roster. The slice that opens the person's
 * own page is where "which surfaces speak in her voice" should be settled across all three at
 * once, rather than one endpoint at a time from three different directions.
 */
async function personalHalf(row) {
  const person = row.user_id === null ? undefined : await selectPublishedProfile.get(row.user_id);
  if (!person) {
    return {
      bio: row.bio,
      image: row.image,
      portfolio: parseJsonArray(row.portfolio),
      years_experience: row.years_experience,
      link: {},
    };
  }
  /* Field by field: hers wherever she said something, the salon's record of the chair wherever
     she did not. The address rides along regardless — it is a fact about there BEING a published
     page, which is settled by the gate above and not by whether she has filled any of it in. */
  const gallery = parseJsonArray(person.portfolio);
  return {
    bio: declared(person.bio) ? person.bio : row.bio,
    image: declared(person.image) ? person.image : row.image,
    portfolio: gallery.length > 0 ? gallery : parseJsonArray(row.portfolio),
    // Truthiness rather than a null test, and that is the whole point: the column is born 0.
    years_experience: person.years_experience ? person.years_experience : row.years_experience,
    link: { technician: { slug: person.slug } },
  };
}

router.get('/:id', async (req, res, next) => {
  try {
    const row = /^\d+$/.test(req.params.id)
      ? await selectStaffProfile.get(Number(req.params.id))
      : null;
    if (!row) {
      throw httpError(404, 'NOT_FOUND', 'Không tìm thấy kỹ thuật viên này.');
    }
    const person = await personalHalf(row);

    res.json({
      success: true,
      data: {
        id: row.id,
        name: row.name,
        title: row.title,
        specialty: row.specialty,
        bio: person.bio,
        image: person.image,
        // The cache of this technician's real review average (staff.rating), maintained by
        // every write in routes/reviews.js — not a figure anybody typed. stats.rating_avg
        // below is the same average computed live from the reviews table, so a reader of
        // this reply can see for themselves whether the two still agree.
        rating: row.rating ?? 0,
        years_experience: person.years_experience,
        portfolio: person.portfolio,
        salon: { id: row.salon_id, slug: row.salon_slug, name: row.salon_name },
        // One key, `technician`, naming where the person's own page lives — and nothing
        // whatsoever when this chair is all there is to read. See personalHalf above.
        ...person.link,
        // What this technician has actually done here, split by who attested to it. The
        // profile used to show a seeded number; this is the work, counted.
        stats: await staffStats(row.id),
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
