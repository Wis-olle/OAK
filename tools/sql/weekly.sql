-- OAK Beauty — weekly read of the events table (see server/src/routes/events.js).
--
-- Run against the production database (Supabase SQL editor, or `psql "$DATABASE_URL"`)
-- once a week. Nothing here writes, and nothing here can name a person: events carry no
-- account, and session_hash is a one-way digest that changes every day and every deploy,
-- so "sessions" is a count of visits, never of people. The salt is minted at boot and a
-- free Render instance restarts after every sleep, so a visit that straddles a restart
-- counts as two sessions: query 3's funnel is a floor, not an exact rate.
--
-- created_at is stored as an ISO-8601 UTC string. The day is read in Vietnam time — the
-- day the salon and the visitor were both living in — but the week is *selected* by
-- comparing the raw text against a UTC string of the same shape: ISO-8601 sorts the same
-- way as the instants it names, so the comparison is exact without casting the column.
-- All five queries filter on the date alone, so all five scan the table today:
-- idx_events_name_created_at (server/src/db.js) leads on `name`, and Postgres before 18
-- has no skip scan. Keeping the column uncast is what would let a future query that also
-- pins `name` use that index for the range. At this table's size the scan is the right
-- trade; if it ever starts to hurt, the fix is an index on created_at alone, not a
-- rewrite here.

-- 1. What happened this week, against the week before it.
--    The one query to read first: it says which events moved, in which direction.
WITH windowed AS (
  SELECT
    name,
    (created_at::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS day
  FROM events
  WHERE created_at >= to_char((now() - interval '14 days') AT TIME ZONE 'UTC',
                              'YYYY-MM-DD"T"HH24:MI:SS')
)
SELECT
  name,
  COUNT(*) FILTER (WHERE day > (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 7) AS this_week,
  COUNT(*) FILTER (WHERE day <= (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 7) AS week_before
FROM windowed
GROUP BY name
ORDER BY this_week DESC;

-- 2. Day by day: how many visits, and how much they did.
--    A flat line of sessions with a rising line of events is a smaller audience doing
--    more, which is a different thing to celebrate than growth.
SELECT
  (created_at::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS day,
  COUNT(DISTINCT session_hash) AS sessions,
  COUNT(*) AS events
FROM events
WHERE created_at >= to_char((now() - interval '7 days') AT TIME ZONE 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS')
GROUP BY day
ORDER BY day;

-- 3. The booking funnel: search -> wizard -> submitted.
--    Counted in sessions, not in events, so one visitor searching five times is one
--    visitor. The step that loses the most is the one worth a week of work.
WITH week AS (
  SELECT name, session_hash
  FROM events
  WHERE created_at >= to_char((now() - interval '7 days') AT TIME ZONE 'UTC',
                              'YYYY-MM-DD"T"HH24:MI:SS')
),
funnel AS (
  SELECT
    COUNT(DISTINCT session_hash) FILTER (WHERE name = 'search_submit') AS searched,
    COUNT(DISTINCT session_hash) FILTER (WHERE name = 'wizard_start') AS started,
    COUNT(DISTINCT session_hash) FILTER (WHERE name = 'booking_submit') AS submitted
  FROM week
)
SELECT
  searched,
  started,
  submitted,
  ROUND(100.0 * started / NULLIF(searched, 0), 1) AS search_to_wizard_pct,
  ROUND(100.0 * submitted / NULLIF(started, 0), 1) AS wizard_to_booking_pct
FROM funnel;

-- 4. Does the blog send anyone to a booking?
--    Per page, the CTA presses and how many of those same visits went on to submit a
--    booking that day. This is the question the blog was written to answer.
WITH week AS (
  SELECT name, page, session_hash
  FROM events
  WHERE created_at >= to_char((now() - interval '7 days') AT TIME ZONE 'UTC',
                              'YYYY-MM-DD"T"HH24:MI:SS')
),
clicks AS (
  SELECT page, session_hash FROM week WHERE name = 'blog_cta_click'
),
booked AS (
  SELECT DISTINCT session_hash FROM week WHERE name = 'booking_submit'
)
SELECT
  clicks.page,
  COUNT(*) AS cta_clicks,
  COUNT(DISTINCT clicks.session_hash) AS sessions,
  COUNT(DISTINCT booked.session_hash) AS sessions_that_booked
FROM clicks
LEFT JOIN booked ON booked.session_hash = clicks.session_hash
GROUP BY clicks.page
ORDER BY cta_clicks DESC;

-- 5. Where the week came from.
--    Referrers are stored without their query string; an empty one is someone who typed
--    the address, opened a bookmark, or came from an app that sends no referrer at all.
SELECT
  COALESCE(NULLIF(ref, ''), '(trực tiếp / direct)') AS came_from,
  COUNT(DISTINCT session_hash) AS sessions,
  COUNT(*) AS events
FROM events
WHERE created_at >= to_char((now() - interval '7 days') AT TIME ZONE 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS')
GROUP BY came_from
ORDER BY sessions DESC
LIMIT 20;
