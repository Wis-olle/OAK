/*
 * Process entry point: boots the HTTP server and, just as importantly, makes sure this
 * process never dies quietly. A dev server that vanishes with no log looks to the browser
 * exactly like a broken site — every /api call fails, so pages bounce to login.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import app from './app.js';

const port = process.env.PORT || 3000;
const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
// Mirrors the resolution in db.js so the startup line names the database actually opened.
const dbFile = process.env.OAK_DB_FILE || path.join(dataDir, 'oak.db');
const errorLogFile = path.join(dataDir, 'server-error.log');

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
// loading app.js/db.js (say, an unreadable oak.db) still ends up as a plain stack on stderr
// rather than in the log file. That path is loud and exits non-zero already; this guard is
// for the silent mid-flight deaths that leave nothing behind.
process.on('uncaughtException', (error) => {
  logCrash('uncaughtException — exiting with code 1', error);
  process.exit(1);
});

const server = app.listen(port, () => {
  console.log(`[${stamp()}] OAK server listening on http://localhost:${port} — db: ${dbFile}`);
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

function shutdown(signal) {
  console.log(`[${stamp()}] ${signal} received — OAK server shutting down.`);
  // Keep-alive sockets would otherwise hold close() open long after the last request.
  server.closeAllConnections();
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
