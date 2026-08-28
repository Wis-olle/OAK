/*
 * The technician's own side of OAK: taking a roster row over, reading what that row is
 * booked for, and owning the personal half of what it shows the public.
 *
 * Everything here is scoped to the signed-in person through staff.user_id, never through
 * an id in the path or the body, so there is no roster row a technician can address that is
 * not one they hold.
 */
import express from 'express';
import { db } from '../db.js';
import { recordEvent } from '../lib/events.js';
import { notifyUser } from '../lib/notify.js';
import { parseJsonArray, parsePagination } from '../lib/query.js';
import {
  END_STINT,
  departureDateOrThrow,
  sweepFutureBookings,
} from '../lib/staff-departure.js';
import {
  CLAIM_STAFF_ROW,
  SPEND_STAFF_INVITE,
  findLiveInvite,
  inviteNotFound,
} from '../lib/staff-invite.js';
import { staffStats } from '../lib/staff-stats.js';
import { addDaysISO, formatDateVN, isISODate, todayISO } from '../lib/time.js';
import { isSafeMediaUrl } from '../lib/urls.js';
import { httpError, requireAuth, requireStaff } from '../middleware/auth.js';

const router = express.Router();

/* Signed in, but not necessarily staff. requireStaff is deliberately NOT applied to the
   whole router: /claim is the endpoint a CUSTOMER account calls, and it is the very thing
   that turns them into staff. The two reads below carry it themselves. */
router.use(requireAuth);

const BOOKING_STATUSES = ['pending', 'confirmed', 'completed', 'cancelled', 'no_show'];
const DEFAULT_RANGE_DAYS = 14;
const REVIEW_LIMIT = 10;
// A few paragraphs about themselves, not an essay: the column is TEXT and the profile page
// renders the whole of it, so the ceiling is what stops one row from becoming the page.
const BIO_MAX = 1000;
// The gallery on the public profile. A working portfolio is a handful of recent pieces; an
// unbounded list is a payload the profile has to carry on every read.
const PORTFOLIO_MAX = 12;

// In place, keeping the same row: a technician who books appointments as a customer keeps
// that history when they step behind the counter. Every endpoint they already use reads
// the role out of the database on each request, so the cookie in their browser survives
// the change. Guarded on the role it is upgrading from, so nothing else can be overwritten.
const UPGRADE_TO_STAFF = "UPDATE users SET role = 'staff' WHERE id = ? AND role = 'customer'";

/**
 * Redeem a claim link as somebody who already holds an OAK account.
 *
 * The other half of this — a technician with no account at all — is
 * POST /api/auth/staff/register, which has to create the account first.
 */
router.post('/claim', async (req, res, next) => {
  try {
    const invite = await findLiveInvite((req.body ?? {}).token);
    if (!invite) {
      throw inviteNotFound();
    }

    // A salon owner is not upgraded into their own technician: the console derives its
    // salon from the signed-in owner, and an account that was both would have two
    // incompatible readings of "your salon". A second address costs nothing.
    if (req.user.role === 'partner') {
      throw httpError(
        409,
        'CONFLICT',
        'Tài khoản đối tác không thể nhận hồ sơ kỹ thuật viên. Vui lòng dùng một email khác.',
      );
    }

    const claimedAt = new Date().toISOString();
    try {
      await db.withTransaction(async (tx) => {
        if (req.user.role === 'customer') {
          await tx.run(UPGRADE_TO_STAFF, req.user.id);
        }
        // Guarded, and re-read here rather than trusted from findLiveInvite above: two
        // people opening one link both get past that read, and only one of them can
        // change these rows.
        const claimed = await tx.run(CLAIM_STAFF_ROW, req.user.id, claimedAt, invite.staff_id);
        if (claimed.changes !== 1) {
          throw httpError(409, 'CONFLICT', 'Hồ sơ này đã có người nhận.');
        }
        const spent = await tx.run(SPEND_STAFF_INVITE, invite.token);
        if (spent.changes !== 1) {
          throw httpError(409, 'CONFLICT', 'Hồ sơ này đã có người nhận.');
        }
      });
    } catch (error) {
      // idx_staff_user_salon: one live claimed row per person per salon. A technician who
      // already works here holding two rows would leave the salon unable to say which of
      // them a booking is for. Somebody working at three salons still claims three rows.
      if (error.code === '23505' && error.constraint === 'idx_staff_user_salon') {
        throw httpError(409, 'CONFLICT', 'Bạn đã có hồ sơ kỹ thuật viên tại salon này.');
      }
      throw error;
    }

    await recordEvent('staff_claimed', '/api/staff-me/claim');
    res.json({ success: true, data: { ok: true } });
  } catch (error) {
    next(error);
  }
});

/* bio, portfolio and profile_hidden ride along with the operational columns because they are
   the half of the row the technician now owns: PATCH /profile below is the only way they are
   ever written, and somebody has to be able to read back what they just changed. A hidden row
   is still returned here — this is their own row, not the public page it has withdrawn. */
const CLAIMED_STAFF_COLUMNS = `
  st.id, st.name, st.title, st.specialty, st.bio, st.image, st.portfolio,
  st.profile_hidden, st.active, st.claimed_at,
  st.started_at, st.left_at, st.left_by, st.started_confirmed_at, st.left_confirmed_at,
  st.tenure_disputed,
  s.id AS salon_id, s.name AS salon_name, s.slug AS salon_slug
`;
const CLAIMED_STAFF_FROM = `
  FROM staff st
  JOIN salons s ON s.id = st.salon_id
`;
// Ordered by staff id, which is the order the rows were opened: somebody working at two
// salons sees the older stint first.
const selectClaimedStaff = db.prepare(`
  SELECT ${CLAIMED_STAFF_COLUMNS} ${CLAIMED_STAFF_FROM}
  WHERE st.user_id = ?
  ORDER BY st.id
`);
/* One row, addressed by id AND by the account that holds it. A row that exists but belongs to
   somebody else has to answer exactly like one that does not exist — the same rule ownedRow
   applies in routes/partner.js, for the same reason: a 403 here would confirm that the id is
   a real roster row somewhere on OAK. */
const selectClaimedStaffRow = db.prepare(`
  SELECT ${CLAIMED_STAFF_COLUMNS} ${CLAIMED_STAFF_FROM}
  WHERE st.id = ? AND st.user_id = ?
`);

/* The same block lib/staff-stats.js serves the public profile, from the same query: a
   technician has to be able to read their own numbers exactly as a customer reads them, or
   the two pages become an argument. One call per roster row rather than one query over all
   of them — a person holds one stint, two if they work at a second salon. */
async function claimedRowShape(row) {
  return {
    staff_id: row.id,
    salon: { id: row.salon_id, name: row.salon_name, slug: row.salon_slug },
    name: row.name,
    title: row.title,
    specialty: row.specialty,
    bio: row.bio,
    image: row.image,
    portfolio: parseJsonArray(row.portfolio),
    profile_hidden: row.profile_hidden,
    active: row.active,
    claimed_at: row.claimed_at,
    /* The stint as a dated thing: the two dates the salon entered, and what this technician
       has answered about them. Nested, and deliberately the RAW started_at rather than the
       one in stats below — that one falls back to the first completed visit, which is a
       reading of the calendar and not a date anybody can be asked to confirm. */
    stint: {
      started_at: row.started_at,
      left_at: row.left_at,
      left_by: row.left_by,
      started_confirmed: Boolean(row.started_confirmed_at),
      left_confirmed: Boolean(row.left_confirmed_at),
      tenure_disputed: row.tenure_disputed ?? 0,
    },
    stats: await staffStats(row.id),
  };
}

router.get('/profile', requireStaff, async (req, res, next) => {
  try {
    const data = [];
    for (const row of await selectClaimedStaff.all(req.user.id)) {
      data.push(await claimedRowShape(row));
    }

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

/* ============================================================================
 * The half of the row the technician owns
 * ========================================================================= */

/* Four columns need four parsers, so these are local rather than lifted out of
   routes/partner.js, whose own set is module-private and answers to a much wider form. Same
   shapes and the same words, because a technician and their owner refusing the same value in
   two different sentences is one form disagreeing with another about one row. */

/** Optional free text. null and '' both clear the column; a non-string is a client error. */
function optionalText(value, label) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw httpError(400, 'VALIDATION_ERROR', `${label} phải là chuỗi ký tự.`);
  }
  return value.trim() === '' ? null : value.trim();
}

/** Optional free text with a ceiling, so a textarea cannot become an essay in the column. */
function optionalLimitedText(value, label, max) {
  const text = optionalText(value, label);
  if (text !== null && text.length > max) {
    throw httpError(400, 'VALIDATION_ERROR', `${label} tối đa ${max} ký tự.`);
  }
  return text;
}

/**
 * An optional image path that will be rendered back into a public <img>/:src binding — the
 * same guard and the same message the avatar, gallery and post-image sinks use in
 * routes/partner.js, because text is not enough: 'javascript:…' is text too.
 */
function optionalMediaUrl(value, label) {
  const url = optionalText(value, label);
  if (!isSafeMediaUrl(url)) {
    throw httpError(400, 'VALIDATION_ERROR', 'Đường dẫn ảnh không hợp lệ.');
  }
  return url;
}

/**
 * The portfolio column: a JSON array of image paths in one TEXT field, written the way
 * seed.js writes it and read back by parseJsonArray in routes/staff.js and the console.
 *
 * Shaped like requireJsonStringArray in routes/partner.js, with the media guard added on
 * every entry — these strings are rendered straight back into the public profile's <img>
 * bindings, so one 'javascript:…' among twelve paths is the whole gallery's problem.
 */
function requireMediaUrlArray(value, label) {
  if (!Array.isArray(value)) {
    throw httpError(400, 'VALIDATION_ERROR', `${label} phải là một danh sách.`);
  }

  /* Blanks are dropped rather than stored. isSafeMediaUrl says an empty value is safe, and it
     is right about that — for a nullable column, empty is how the field is cleared — but an
     empty string inside the array is not a cleared field, it is a gallery slot the form left
     unfilled, and it renders as <img src=""> on the public profile. The ceiling is then
     counted on what will actually be stored, so a form posting twelve pictures and a trailing
     blank row is twelve pictures. */
  const urls = value
    .map((item) => {
      if (typeof item !== 'string') {
        throw httpError(400, 'VALIDATION_ERROR', `${label} chỉ nhận chuỗi ký tự.`);
      }
      return item.trim();
    })
    .filter((url) => url !== '');

  if (urls.length > PORTFOLIO_MAX) {
    throw httpError(400, 'VALIDATION_ERROR', `${label} tối đa ${PORTFOLIO_MAX} ảnh.`);
  }
  for (const url of urls) {
    if (!isSafeMediaUrl(url)) {
      throw httpError(400, 'VALIDATION_ERROR', 'Đường dẫn ảnh không hợp lệ.');
    }
  }
  return JSON.stringify(urls);
}

function requireFlag(value, label) {
  if (value === true || value === 1 || value === '1') {
    return 1;
  }
  if (value === false || value === 0 || value === '0') {
    return 0;
  }
  throw httpError(400, 'VALIDATION_ERROR', `${label} phải là true hoặc false.`);
}

/* Exactly the four columns a technician owns, and the whole of what PATCH /profile can
   write. Everything else on the row — name, title, specialty, the schedule, the service list,
   active — is the salon's: the owner runs the roster, and the console is where it is run. */
const PROFILE_COLUMNS = {
  bio: (value) => optionalLimitedText(value, 'Giới thiệu', BIO_MAX),
  image: (value) => optionalMediaUrl(value, 'Ảnh đại diện'),
  portfolio: (value) => requireMediaUrlArray(value, 'Ảnh tác phẩm'),
  profile_hidden: (value) => requireFlag(value, 'Ẩn hồ sơ'),
};

/** A roster row id out of a request, in the one shape every endpoint in this file wants. */
function requireStaffId(value) {
  const staffId = Number(value);
  if (!Number.isInteger(staffId) || staffId <= 0) {
    throw httpError(400, 'VALIDATION_ERROR', 'Mã kỹ thuật viên không hợp lệ.');
  }
  return staffId;
}

const NOT_YOURS =
  'Bạn chỉ có thể cập nhật giới thiệu, ảnh đại diện, ảnh tác phẩm và trạng thái ẩn hồ sơ. Tên, chức danh, chuyên môn và lịch làm việc do salon quản lý.';
const PROFILE_NOT_FOUND = 'Không tìm thấy hồ sơ kỹ thuật viên này.';

router.patch('/profile', requireStaff, async (req, res, next) => {
  try {
    const body = req.body ?? {};

    const staffId = requireStaffId(body.staff_id);
    const row = await selectClaimedStaffRow.get(staffId, req.user.id);
    if (!row) {
      throw httpError(404, 'NOT_FOUND', PROFILE_NOT_FOUND);
    }

    /* An unrecognised key is refused rather than dropped, which is where this parts company
       with buildPatch in routes/partner.js: that one walks its whitelist and silently ignores
       whatever else the body carried, and here that would be the wrong kindness. A technician
       who posted `name` and got a 200 back would believe they had renamed themselves, and
       would then be arguing with their own page about it. So the refusal names what this
       endpoint owns and says out loud who owns the rest. */
    const assignments = [];
    const values = [];
    for (const [key, value] of Object.entries(body)) {
      if (key === 'staff_id') {
        continue;
      }
      if (!Object.hasOwn(PROFILE_COLUMNS, key)) {
        throw httpError(400, 'VALIDATION_ERROR', NOT_YOURS);
      }
      assignments.push(`"${key}" = ?`);
      values.push(PROFILE_COLUMNS[key](value));
    }
    if (assignments.length === 0) {
      throw httpError(400, 'VALIDATION_ERROR', 'Không có thông tin nào để cập nhật.');
    }

    // Scoped by user_id in the UPDATE itself, not merely by the read above: there is no
    // window between proving the row is theirs and writing to it.
    await db
      .prepare(`UPDATE staff SET ${assignments.join(', ')} WHERE id = ? AND user_id = ?`)
      .run(...values, staffId, req.user.id);

    /* Re-read rather than assumed, and checked: the row can be gone by now. A technician
       erasing their own account releases every roster row they held (RELEASE_STAFF_ROWS in
       routes/users.js), and one landing between the UPDATE above and this read would leave
       nothing to shape — a 500 on the one path in this file that is otherwise careful about
       saying "not yours" and "not there" in the same words. */
    const updated = await selectClaimedStaffRow.get(staffId, req.user.id);
    if (!updated) {
      throw httpError(404, 'NOT_FOUND', PROFILE_NOT_FOUND);
    }

    res.json({ success: true, data: await claimedRowShape(updated) });
  } catch (error) {
    next(error);
  }
});

/* ============================================================================
 * Leaving, and answering for the dates on a stint
 * ========================================================================= */

/* The stint and the salon behind it, in one read, scoped by the account that holds the row.
   owner_id is what a departure is announced to: an owner reads their bell as anybody else
   does, so there is no partner-only channel to reach and none is invented. */
const selectMyStint = db.prepare(`
  SELECT st.id, st.name, st.active, st.started_at, st.left_at,
         s.id AS salon_id, s.name AS salon_name, s.owner_id
  FROM staff st
  JOIN salons s ON s.id = st.salon_id
  WHERE st.id = ? AND st.user_id = ?
`);

const STINT_ALREADY_ENDED = 'Bạn đã kết thúc làm việc tại salon này.';

/*
 * The technician's own half of a departure — the same act the console's
 * POST /api/partner/staff/:id/departure performs, from the other side of it. Same
 * transaction, same sweep, and left_by is the whole difference in the row it writes: a
 * person leaving and a salon letting them go are not the same event, and a page that showed
 * them as one would be describing something that did not happen.
 */
router.post('/leave', requireStaff, async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const staffId = requireStaffId(body.staff_id);
    // A row somebody else holds answers exactly like one that does not exist, as everywhere
    // else in this file: the caller is naming an id, and a 403 would confirm it is real.
    const stint = await selectMyStint.get(staffId, req.user.id);
    if (!stint) {
      throw httpError(404, 'NOT_FOUND', PROFILE_NOT_FOUND);
    }
    if (stint.active !== 1) {
      throw httpError(409, 'CONFLICT', STINT_ALREADY_ENDED);
    }
    const leftAt = departureDateOrThrow(body.left_at);

    const salon = { id: stint.salon_id, name: stint.salon_name, owner_id: stint.owner_id };
    const swept = await db.withTransaction(async (tx) => {
      // Scoped by user_id in the UPDATE itself and guarded on the row still being open, so
      // this and the owner's own button cannot both date the same stint.
      const ended = await tx.run(
        `${END_STINT} AND user_id = ?`, leftAt, 'staff', staffId, req.user.id,
      );
      if (ended.changes !== 1) {
        throw httpError(409, 'CONFLICT', STINT_ALREADY_ENDED);
      }
      await notifyUser(
        tx,
        stint.owner_id,
        'Kỹ thuật viên kết thúc hợp tác',
        `${stint.name} đã báo kết thúc làm việc tại ${stint.salon_name} từ ngày ${formatDateVN(leftAt)}.`,
        'general',
      );
      return sweepFutureBookings(tx, { staffId, salon, leftAt, actorUserId: req.user.id });
    });

    res.json({ success: true, data: { left_at: leftAt, ...swept } });
  } catch (error) {
    next(error);
  }
});

/* The two ends of a stint, and the column each of them is answered in. The date has to be
   there to be answered for: a ✓ on a date nobody entered would say the technician confirmed
   something, and a dispute over one would be an argument about nothing. */
const TENURE_FIELDS = {
  started: { date: 'started_at', confirmed: 'started_confirmed_at', label: 'ngày bắt đầu' },
  left: { date: 'left_at', confirmed: 'left_confirmed_at', label: 'ngày kết thúc' },
};

/** Resolve {staffId, stint, field} for both attestation endpoints, or throw. */
async function tenureTarget(req) {
  const staffId = requireStaffId(req.params.staffId);
  /* hasOwn rather than a truthiness test on the lookup: the column name goes into the SET
     clause as an identifier, and 'constructor' or '__proto__' resolve to something truthy on
     any plain object. Only the two keys written above may name a column. */
  const requested = (req.body ?? {}).field;
  if (!Object.hasOwn(TENURE_FIELDS, requested)) {
    throw httpError(400, 'VALIDATION_ERROR', 'Chỉ có thể xác nhận ngày bắt đầu hoặc ngày kết thúc.');
  }
  const field = TENURE_FIELDS[requested];
  const stint = await selectMyStint.get(staffId, req.user.id);
  if (!stint) {
    throw httpError(404, 'NOT_FOUND', PROFILE_NOT_FOUND);
  }
  if (!stint[field.date]) {
    throw httpError(409, 'CONFLICT', `Salon chưa nhập ${field.label} cho hồ sơ này.`);
  }
  return { staffId, stint, field };
}

/**
 * The row as it stands after an attestation, or the same 404 PATCH /profile answers with when
 * it re-reads: an account erased between the write and this read has released every roster row
 * it held, and there would be nothing left to shape.
 */
async function stintAfterAnswer(staffId, userId) {
  const row = await selectClaimedStaffRow.get(staffId, userId);
  if (!row) {
    throw httpError(404, 'NOT_FOUND', PROFILE_NOT_FOUND);
  }
  return claimedRowShape(row);
}

/*
 * The technician's ✓ on a date the salon entered. Nothing is finalised and nothing expires:
 * the badge on the public profile is simply "date + this stamp + no dispute"
 * (tenureVerified in lib/staff-stats.js), so withdrawing the ✓ is disputing it below, and an
 * unanswered date stays unanswered for as long as it takes.
 */
router.post('/tenure/:staffId/confirm', requireStaff, async (req, res, next) => {
  try {
    const { staffId, field } = await tenureTarget(req);
    await db
      .prepare(
        `UPDATE staff SET "${field.confirmed}" = ?, tenure_disputed = 0
         WHERE id = ? AND user_id = ?`,
      )
      .run(new Date().toISOString(), staffId, req.user.id);

    res.json({ success: true, data: await stintAfterAnswer(staffId, req.user.id) });
  } catch (error) {
    next(error);
  }
});

/*
 * And the other answer: this date is wrong. One flag over the whole stint rather than one per
 * date, because there is no arbitration behind it — the platform cannot know which of two
 * parties is right about a day, so all a dispute does is take both ✓ off the page and put the
 * question in front of the owner, who is the only person who can change the date.
 */
router.post('/tenure/:staffId/dispute', requireStaff, async (req, res, next) => {
  try {
    const { staffId, stint, field } = await tenureTarget(req);
    await db.withTransaction(async (tx) => {
      await tx.run(
        'UPDATE staff SET tenure_disputed = 1 WHERE id = ? AND user_id = ?',
        staffId,
        req.user.id,
      );
      await notifyUser(
        tx,
        stint.owner_id,
        'Kỹ thuật viên báo sai ngày',
        `${stint.name} cho rằng ${field.label} (${formatDateVN(stint[field.date])}) trên hồ sơ tại ${stint.salon_name} chưa đúng.`,
        'general',
      );
    });

    res.json({ success: true, data: await stintAfterAnswer(staffId, req.user.id) });
  } catch (error) {
    next(error);
  }
});

/* Every review of every row the caller holds, newest first — the same shape and the same
   pagination GET /api/staff/:id/reviews serves the public, so a technician reading their own
   list and a customer reading their profile are reading one thing.

   The reviewer's name and avatar are in here, and deliberately, even though this file is
   otherwise the strictest read in the codebase about who a customer is: the neighbouring
   public endpoint already shows both to anybody at all, so withholding them from the person
   being reviewed would protect nothing and would only leave them unable to recognise the
   visit. What stays out is what stays out there too — no phone number, no booking note.

   Scoped through staff.user_id, never through an id from the request. */
const selectMyStaffReviews = db.prepare(`
  SELECT r.id, r.rating, r.comment, r.created_at, r.staff_id,
         u.name AS user_name, u.avatar AS user_avatar,
         s.id AS salon_id, s.name AS salon_name,
         b.date AS booking_date
  FROM reviews r
  JOIN staff st ON st.id = r.staff_id
  LEFT JOIN users u ON u.id = r.user_id
  LEFT JOIN salons s ON s.id = r.salon_id
  LEFT JOIN bookings b ON b.id = r.booking_id
  WHERE st.user_id = ?
  ORDER BY r.created_at DESC, r.id DESC
  LIMIT ? OFFSET ?
`);
// Counted over every review of every row they hold, not just the page being served, so the
// pager has a total to work from.
const countMyStaffReviews = db.prepare(`
  SELECT COUNT(*) AS total
  FROM reviews r
  JOIN staff st ON st.id = r.staff_id
  WHERE st.user_id = ?
`);

router.get('/reviews', requireStaff, async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, REVIEW_LIMIT);
    const total = (await countMyStaffReviews.get(req.user.id)).total;
    const rows = await selectMyStaffReviews.all(req.user.id, limit, offset);

    res.json({
      success: true,
      data: rows.map((row) => ({
        id: row.id,
        staff_id: row.staff_id,
        rating: row.rating,
        comment: row.comment,
        created_at: row.created_at,
        // What the review was about, so a row means something without the profile beside it.
        salon: { id: row.salon_id, name: row.salon_name },
        booking_date: row.booking_date ?? null,
        user: { name: row.user_name, avatar: row.user_avatar },
      })),
      meta: { page, limit, total },
    });
  } catch (error) {
    next(error);
  }
});

/* The same join routes/bookings.js reads a booking through, and deliberately a much
   narrower list of columns, because privacy is the whole point of this endpoint. It is
   the one read in the codebase where the person asking is neither the customer nor the
   salon owner, so what a technician gets is what they need to work a shift and nothing
   else: NEVER customer_phone, NEVER b.note — the customer's own words, written to the
   salon and sometimes about the technician — and never the customer's full name.
   customer_name is selected only so the given name can be cut out of it below. */
const STAFF_BOOKING_COLUMNS = `
  b.id, b.date, b.time, b.status, b.total_price, b.customer_name,
  sv.id AS service_id, sv.name AS service_name,
  s.id AS salon_id, s.name AS salon_name
`;
// The staff join is inner, not left: this list IS "the rows my roster row is booked for",
// so a booking with no technician on it has nothing to do with anybody here.
const STAFF_BOOKING_FROM = `
  FROM bookings b
  JOIN services sv ON sv.id = b.service_id
  JOIN salons s ON s.id = b.salon_id
  JOIN staff st ON st.id = b.staff_id
`;

/**
 * The given name out of a Vietnamese full name: 'Nguyễn Thị Mai Lan' -> 'Lan'.
 *
 * Vietnamese name order puts the family name first and the given name last, and the given
 * name is what one greets somebody with — it is also the half that identifies nobody on
 * its own, which is why it is the half a technician gets. A booking taken without a name
 * has none to give.
 */
export function givenName(fullName) {
  if (typeof fullName !== 'string') {
    return null;
  }
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  return parts.length === 0 ? null : parts[parts.length - 1];
}

/** An ISO date from the query string, or the fallback when it was not asked for. */
function rangeDate(value, fallback, label) {
  if (value === undefined || value === '') {
    return fallback;
  }
  if (!isISODate(value)) {
    throw httpError(400, 'VALIDATION_ERROR', `${label} không hợp lệ.`);
  }
  return value;
}

router.get('/bookings', requireStaff, async (req, res, next) => {
  try {
    const today = todayISO();
    const from = rangeDate(req.query.from, today, 'Ngày bắt đầu');
    const to = rangeDate(req.query.to, addDaysISO(today, DEFAULT_RANGE_DAYS), 'Ngày kết thúc');

    // active = 1, not user_id alone: taking somebody off the roster is a soft delete that
    // deliberately keeps user_id, so their past work stays attributed to a person. It must
    // not also leave them reading the salon's calendar — a stint that has ended is not a
    // licence to keep seeing who is coming in next week. GET /profile still shows the row,
    // flagged inactive: that one is their own history rather than the salon's diary.
    const conditions = ['st.user_id = ?', 'st.active = 1', 'b.date >= ?', 'b.date <= ?'];
    const params = [req.user.id, from, to];
    if (req.query.status !== undefined && req.query.status !== '') {
      if (!BOOKING_STATUSES.includes(req.query.status)) {
        throw httpError(400, 'VALIDATION_ERROR', 'Trạng thái lịch hẹn không hợp lệ.');
      }
      conditions.push('b.status = ?');
      params.push(req.query.status);
    }

    const rows = await db
      .prepare(
        `SELECT ${STAFF_BOOKING_COLUMNS} ${STAFF_BOOKING_FROM}
         WHERE ${conditions.join(' AND ')}
         ORDER BY b.date DESC, b.time DESC`,
      )
      .all(...params);

    res.json({
      success: true,
      data: rows.map((row) => ({
        id: row.id,
        date: row.date,
        time: row.time,
        status: row.status,
        total_price: row.total_price,
        service: { id: row.service_id, name: row.service_name },
        salon: { id: row.salon_id, name: row.salon_name },
        customer: { given_name: givenName(row.customer_name) },
      })),
    });
  } catch (error) {
    next(error);
  }
});

export default router;
