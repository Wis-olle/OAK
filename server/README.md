# OAK Beauty — backend

Express 5 API + static host for the `ui/` pages. Data lives in a single SQLite file, opened
through Node's built-in `node:sqlite`, and is seeded automatically the first time it is empty.
Requires **Node 24+** (that is what `node:sqlite` is used from here).

## Chạy server / Running the server

```bash
cd server
npm install      # once
npm start        # http://localhost:3000
npm run dev      # same, but restarts on file changes (node --watch)
npm test         # spawns its own server on port 3199 against a throwaway database
```

On boot the server prints one line — if you do not see it, the server is not up:

```
[2026-08-10T13:21:34.069Z] OAK server listening on http://localhost:3000 — db: E:\...\server\data\oak.db
```

Stop it with `Ctrl+C`; it prints a matching shutdown line.

## Biến môi trường / Environment variables

| Variable      | Default                | Notes                                                          |
| ------------- | ---------------------- | -------------------------------------------------------------- |
| `PORT`        | `3000`                 | The UI is served from the same origin, so `/api` calls just work. |
| `OAK_DB_FILE` | `server/data/oak.db`   | Point it elsewhere to boot against a throwaway database.        |
| `JWT_SECRET`  | `oak-dev-secret`       | **Required** when `NODE_ENV=production`; the server refuses to start without it. |

```powershell
# PowerShell — run a second, isolated instance
$env:PORT='3330'; $env:OAK_DB_FILE='C:\temp\oak-scratch.db'; npm start
```

## Tài khoản demo / Demo accounts

Every seeded account uses the password `Oak@1234`.

| Email           | Role     | What they have                                       |
| --------------- | -------- | ---------------------------------------------------- |
| `khach@oak.vn`  | customer | Bookings, reviews, favourites, notifications          |
| `doitac@oak.vn` | partner  | Owns the "Lala Nail Studio" salon                     |

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
