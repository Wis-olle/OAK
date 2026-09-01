/*
 * One way to read a source file for a test to assert against.
 *
 * Forty-odd suites here read the pages, the scripts and the server's own modules as TEXT and
 * assert on what is written in them, and every one of them had grown its own two-line reader:
 * a `root` resolved from import.meta.url, a path.join, an 'utf8'. Forty copies of a thing is
 * forty places for it to differ, and the difference that actually bit was line endings — a
 * Windows checkout with core.autocrlf on turns every one of those files into CRLF and every
 * multi-line assertion in the suite red at once, all for a reason that has nothing to do with
 * the code under test.
 *
 * .gitattributes is the first line of defence and the better one: it says the working copy is
 * LF whatever the platform, so the bytes on disk match the bytes in the index. This is the
 * second. A checkout made before that line existed, a file written by an editor that decided
 * otherwise, a tool that rewrote something in passing — none of those should be able to fail
 * a test about markup. Folding \r\n on the way in costs nothing and takes the whole class of
 * failure off the table.
 *
 * Three doors, because the suites ask three different questions: a page under ui/, a module
 * under server/src/, and anything else in the repository by its own path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** One file anywhere in the repository, by its path from the root, as LF text. */
export function readRepo(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8').replace(/\r\n/g, '\n');
}

/** One page or asset under ui/ — 'dat-lich.html', 'assets/js/oak-api.js'. */
export function readUi(name) {
  return readRepo(path.join('ui', name));
}

/** One server module, by its path from server/src — 'routes/auth.js', 'db.js'. */
export function readServer(relPath) {
  return readRepo(path.join('server/src', relPath));
}
