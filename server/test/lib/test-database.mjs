// The reset the smoke suite runs before it spawns a server. `DROP SCHEMA public CASCADE` is
// one typo away from emptying a real database — a mistyped OAK_TEST_DATABASE_URL, or a shell
// that still carries production's — so the refusal lives here, in front of the connection
// rather than inside the suite that opens it.
import pg from 'pg';

/**
 * Whether `testUrl` names a database this file is allowed to drop. Two conditions, both
 * required: the database name ends in a whole `_test` word — `oak` and `oak_testing` are
 * somebody's data, not a fixture — and it is not the live URL the environment already
 * points at, when there is one.
 */
export function isSafeTestDatabaseUrl(testUrl, liveUrl) {
  let database;
  try {
    database = new URL(testUrl).pathname;
  } catch {
    return false;
  }
  if (!/_test\b/.test(database)) {
    return false;
  }
  return !liveUrl || testUrl !== liveUrl;
}

/** Drop and recreate the public schema so the server boots into an empty database.
 * The CASCADE also takes the citext extension's objects with it, so it is reinstalled. */
export async function resetDatabase(url) {
  if (!isSafeTestDatabaseUrl(url, process.env.DATABASE_URL)) {
    throw new Error(
      `refusing to reset ${url}: a test database must be named …_test and must not be DATABASE_URL`,
    );
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      'DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public;',
    );
    await client.query('CREATE EXTENSION IF NOT EXISTS citext SCHEMA public;');
  } finally {
    await client.end();
  }
}
