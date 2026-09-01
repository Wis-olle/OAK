/*
 * Process entry point: boots the HTTP server and, just as importantly, makes sure this
 * process never dies quietly. A dev server that vanishes with no log looks to the browser
 * exactly like a broken site — every /api call fails, so pages bounce to login.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import app from './app.js';
import { db } from './db.js';
import { runTick, tickIntervalFrom } from './lib/tick.js';

const port = process.env.PORT || 3000;
const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
const errorLogFile = path.join(dataDir, 'server-error.log');

// Mirrors the resolution in db.js so the startup line names the database actually opened.
// Only host and database name — never credentials.
const dbUrl = new URL(
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/oak',
);
const dbTarget = `${dbUrl.hostname}${dbUrl.pathname}`;

function stamp() {
  return new Date().toISOString();
}

/**
 * Crash reports go to stderr for whoever is watching the console, and to
 * server/data/server-error.log for whoever arrives after the process is gone.
 * A failure to write the file must never become the thing that kills us.
 */
function logCrash(kind, error) {
  const entry = `[${stamp()}] ${kind}: ${(error && error.stack) || String(error)}`;
  console.error(entry);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(errorLogFile, `${entry}\n`);
  } catch (writeError) {
    console.error(`[${stamp()}] could not write ${errorLogFile}: ${writeError.message}`);
  }
}

// A rejected promise nobody caught usually costs one request its answer and leaves
// everything else intact, so the deliberate choice here is to log loudly and KEEP SERVING:
// taking the whole site down over it would be a worse outage than the bug itself.
process.on('unhandledRejection', (reason) => {
  logCrash('unhandledRejection — server kept running', reason);
});

// An uncaught exception is the opposite case: a stack was abandoned half-way, so state may
// be inconsistent and Node's own guidance is to leave rather than soldier on. We log first,
// then exit non-zero so a supervisor (pm2/systemd/`npm run dev`'s watcher) restarts us.
// Swallowing this and pretending all is well is exactly the failure this file exists to stop.
// Scope note: ESM evaluates the imports above before this line runs, so a failure while
// loading app.js/db.js (say, an unreachable Postgres) still ends up as a plain stack on
// stderr rather than in the log file. That path is loud and exits non-zero already; this guard is
// for the silent mid-flight deaths that leave nothing behind.
process.on('uncaughtException', (error) => {
  logCrash('uncaughtException — exiting with code 1', error);
  process.exit(1);
});

const server = app.listen(port, () => {
  console.log(`[${stamp()}] OAK server listening on http://localhost:${port} — db: ${dbTarget}`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    // On Windows the bind conflict surfaces a millisecond AFTER the listening callback has
    // already run, so the line above wrongly claims success — say so, or the next person
    // reads "listening" in the console and spends an hour wondering why nothing responds.
    console.error(
      `[${stamp()}] KHÔNG khởi động được: cổng ${port} đang được một tiến trình khác sử dụng ` +
        `(dòng "listening" phía trên là sai, server này đang thoát).\n` +
        `           Hãy tắt server cũ, hoặc chạy lại với cổng khác: PORT=3001 npm start`,
    );
    process.exit(1);
  }
  logCrash('server error — exiting with code 1', error);
  process.exit(1);
});

/*
 * The scheduler, such as it is: a setInterval in the web process.
 *
 * There is no worker dyno and no cron on this plan, and there does not need to be. The
 * health ping keeps exactly one instance awake round the clock (DEPLOY.md §8), so an
 * in-process interval is the cheapest scheduler that exists here — no extra service, no
 * extra bill, nothing to keep in sync with the code it runs. What it cannot promise is a
 * process that was asleep or restarting, and the tick a few seconds after boot is for that:
 * whatever was missed while nobody was home is swept the moment somebody is. Fifteen seconds
 * rather than immediately, so a cold start spends its first moments answering the request
 * that woke it rather than sweeping every salon's yesterday.
 *
 * Both timers are unref'd: a tick pending is never a reason for the process to stay alive.
 * TICK_INTERVAL_MS=0 turns the interval off entirely — what the smoke suite does, so that
 * the only ticks in a test run are the ones the suite asked for. GET /api/internal/tick
 * stands beside this for an external cron; the advisory lock in lib/tick.js is what keeps
 * the two of them (and two instances mid-deploy) out of each other's way.
 */
const BOOT_TICK_DELAY_MS = 15 * 1000;
// Parsed in lib/tick.js, where it can be tested: only a literal 0 turns the clock off, and
// anything unusable falls back to the default rather than to silence.
const tickIntervalMs = tickIntervalFrom(process.env.TICK_INTERVAL_MS);

async function tick() {
  try {
    await runTick(db);
  } catch (error) {
    // A sweep that failed is a sweep the next one redoes. Nothing here may take the site
    // down, and an unhandled rejection out of a timer would do exactly that.
    logCrash('tick failed — the next one will retry', error);
  }
}

// One line at boot, because the tick is otherwise silent by design — it logs only when it
// wrote something — and "no tick lines all day" would look exactly the same whether it was
// running and finding nothing or never scheduled at all.
if (tickIntervalMs > 0) {
  console.log(`[${stamp()}] tick: every ${Math.round(tickIntervalMs / 1000)}s, first in ${BOOT_TICK_DELAY_MS / 1000}s.`);
  setTimeout(tick, BOOT_TICK_DELAY_MS).unref();
  setInterval(tick, tickIntervalMs).unref();
} else {
  console.log(`[${stamp()}] tick disabled (TICK_INTERVAL_MS=0) — only GET /api/internal/tick will run it.`);
}

function shutdown(signal) {
  console.log(`[${stamp()}] ${signal} received — OAK server shutting down.`);
  // Keep-alive sockets would otherwise hold close() open long after the last request.
  server.closeAllConnections();
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
