# OAK Beauty — backend

Express 5 API + static host for the `ui/` pages. Data lives in Postgres (Supabase in
production, a local instance in development) reached through `pg`, and is seeded
automatically the first time the database is empty. Requires **Node 24+** and a Postgres
the server can connect to — without one it exits at boot, because `src/db.js` awaits the
schema query before it listens.

## Chạy server / Running the server

```bash
cd server
npm install      # once
npm start        # http://localhost:3000
npm run dev      # same, but restarts on file changes (node --watch)
npm run test:unit # the node:test files only — no database needed
npm test         # the above, then api-smoke against its own server on port 3199
```

`npm test` needs a Postgres of its own (`OAK_TEST_DATABASE_URL`, default
`postgres://postgres:postgres@localhost:5432/oak_test`) because it drops and rebuilds the
schema. Only `npm run test:unit` runs without a database.

On boot the server prints one line — if you do not see it, the server is not up:

```
[2026-08-10T13:21:34.069Z] OAK server listening on http://localhost:3000 — db: localhost/oak
```

Stop it with `Ctrl+C`; it prints a matching shutdown line.

## Biến môi trường / Environment variables

| Variable      | Default                | Notes                                                          |
| ------------- | ---------------------- | -------------------------------------------------------------- |
| `PORT`        | `3000`                 | The UI is served from the same origin, so `/api` calls just work. |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/oak` | The Postgres opened on boot. Point it elsewhere to run against a throwaway database. **Required** when `NODE_ENV=production`. |
| `OAK_TEST_DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/oak_test` | The database `npm test` drops and rebuilds. Never point it at one you want to keep. |
| `JWT_SECRET`  | `oak-dev-secret`       | **Required** when `NODE_ENV=production`; the server refuses to start without it. |
| `TZ`          | host clock             | Set it to `Asia/Ho_Chi_Minh` to match production. "Today" and "now" in booking are pinned to Vietnam time by `src/lib/time.js` either way. |
| `UPLOADS_DAILY_CAP` | `500`            | How much the whole site may write into the storage bucket in one Vietnamese calendar day before uploads answer `UPLOADS_PAUSED`. A circuit breaker on the bucket, not a quota. Its unit is **picture-equivalents of 1MB**: the day's budget is this number times 1MB, so 500 is half a gigabyte however it is spent, and a 5MB picture the salon importer pulls off a partner's website costs five. One account is separately held to 20 pictures an hour — a rate limit on a person, counted in pictures rather than bytes — and to one megabyte a picture through `POST /api/uploads`. Raise it for a day that genuinely needs the room. `0` is honoured rather than read as absent, and closes uploads entirely — what an operator wants while they clear the bucket out by hand. |
| `RESEND_API_KEY` | unset               | The reset-mail channel (`src/lib/mailer.js`). Unset, nothing is mailed and `/api/auth/forgot-password` hands the link back in its own reply instead — but only when `NODE_ENV` is not `production`. Setting it retires that demo link everywhere. See DEPLOY.md §7. |
| `RESET_MAIL_FROM` | `OAK Beauty <no-reply@oakbeauty.vn>` | The From of that one mail. Must be an address on a domain verified in Resend, or Resend refuses the send. |
| `TICK_SECRET` | unset | The key `GET|POST /api/internal/tick` asks for, as `?key=` or the `x-oak-tick-key` header. Unset, that route answers `503` and only the in-process interval below runs the sweep. Treat a key in a URL as a secret in somebody's request log. |
| `TICK_INTERVAL_MS` | `600000` | How often the process runs the tick itself (`src/lib/tick.js`: closing out the days that have gone by, writing the 24-hour reminders). The first one is 15 seconds after boot, which is what catches up whatever was missed while the service slept. Only a literal `0` turns the interval off — what `npm test` does, so a run's only ticks are the ones the suite asked for; anything unparseable falls back to the default rather than to silence. |
| `OAK_TEST_TICK_SECRET` | *(the suite's own fixed key)* | What `test/api-smoke.mjs` sends to `/api/internal/tick`. Only needed in external mode (`OAK_TEST_BASE_URL`), where the server was started by somebody else: set it to that server's `TICK_SECRET`, or the tick-driven groups skip instead of failing. |

```powershell
# PowerShell — run a second, isolated instance
$env:PORT='3330'; $env:DATABASE_URL='postgres://postgres:postgres@localhost:5432/oak_scratch'; npm start
```

## Tài khoản demo / Demo accounts

Every seeded account uses the password `Oak@1234`. That is why the seed runs only when the
`users` table is empty **and** `NODE_ENV` is not `production` — set `SEED_DEMO=1` to opt a
production database in deliberately.

| Email           | Role     | What they have                                       |
| --------------- | -------- | ---------------------------------------------------- |
| `khach@oak.vn`  | customer | Bookings, reviews, favourites, notifications          |
| `doitac@oak.vn` | partner  | Owns the "Lala Nail Studio" salon                     |
| `nhanvien@oak.vn` | staff  | Holds the "Lan Khuê" roster row at Lala Nail Studio   |

Other seeded emails (same password) are listed at the top of `src/seed.js`.

## Dữ liệu / Where the data lives

- `server/data/oak.db` — the database. Not in git.
- `server/uploads/` — images posted to `POST /api/uploads`, served back from `/uploads`. Not in git.
- `server/data/server-error.log` — crash log, see below. Not in git.

**Reset the database:** stop the server, delete `server/data/oak.db`, start it again — an empty
database re-seeds itself on boot.

```powershell
Remove-Item server\data\oak.db; npm start
```

## Khi có sự cố / Crash log

`src/index.js` installs two process-level guards. Both write to stderr **and** append to
`server/data/server-error.log` with a timestamp and the full stack:

- **`unhandledRejection`** — logged, and the server **keeps running**. A promise nobody caught
  usually costs one request its answer; taking the whole site down over it would be worse.
- **`uncaughtException`** — logged, then the process **exits with code 1**. A stack was abandoned
  half-way, so state may be inconsistent; exiting is Node's own guidance and lets a supervisor
  (or `npm run dev`) restart cleanly. It is never swallowed.

If the site misbehaved and the server is gone, that file is the first place to look.

## Nếu trang web có vẻ hỏng / If the site seems broken

Most "nothing happens when I click" reports are a backend that is not running — every page
loads its data from `/api`, so a dead server makes the whole site look dead.

1. **Is the server up?** Look for the `OAK server listening on …` line in the terminal, or:
   ```powershell
   curl http://localhost:3000/api/health     # expect {"success":true,"data":{"status":"ok"}}
   ```
   The pages now show a red banner — *"Không kết nối được máy chủ…"* — instead of bouncing you
   to the login page when the API is unreachable, so this case is visible from the browser too.
2. **Did it crash?** Check `server/data/server-error.log`, then restart with `npm start`.
3. **`KHÔNG khởi động được: cổng 3000 đang được một tiến trình khác sử dụng`** — another server
   already owns the port. Stop it, or run on another port: `$env:PORT='3001'; npm start`.
   On Windows the misleading `listening` line can print just before this error; the error wins.
4. **Logged in but treated as a guest?** The session is a `httpOnly` cookie on this origin —
   open the UI through the server (`http://localhost:3000/kham-pha.html`), not as a `file://` page.

## Đo lường ẩn danh / Anonymous measurement — `POST /api/events`

Pages report what happened through `OAK.track(name, meta)` (`ui/assets/js/oak-api.js`), which
sends a beacon and forgets. One row per event in the `events` table:

```json
{ "name": "booking_submit", "page": "dat-lich.html", "ref": "https://oak.vn/blog.html",
  "meta": { "total": 12 } }
```

- **No account, no cookie of its own.** A row has no `user_id` and never gets one. The only
  thread between two rows is `session_hash`, a one-way digest of the caller's address, their
  user agent and today's date under a salt minted at boot — it counts a visit for one day and
  cannot be turned back into a person or matched against yesterday.
- **`meta` is for counts and short labels.** The route keeps numbers, booleans and strings up
  to 40 characters, and drops anything holding an `@` or six digits in a row, so a
  mis-instrumented page cannot write personal data here.
- **Limits.** `name` must be `^[a-z][a-z0-9_]{2,39}$`; `page`/`ref` are trimmed to 200
  characters and `ref` loses its query string. Over 60 calls a minute from one address the
  route answers `429` — an in-memory counter, like the `/forgot-password` throttle, with the
  same caveats.

Read the week with `tools/sql/weekly.sql`: five queries — events this week against last,
sessions per day, the search → wizard → booking funnel, whether the blog CTA leads to a
booking, and where the visits came from.
