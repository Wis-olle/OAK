// The reset the smoke suite runs before it spawns a server. `DROP SCHEMA public CASCADE` is
// one typo away from emptying a real database — a mistyped OAK_TEST_DATABASE_URL, or a shell
// that still carries production's — so the refusal lives here, in front of the connection
// rather than inside the suite that opens it.
import pg from 'pg';

/* The identity two spellings of one database share: host, port and database name, with a
   trailing slash and everything else dropped. `postgresql://` and `postgres://` are the same
   server, and `?sslmode=require` is a connection setting rather than a different database —
   compared as written, either of those would read as a difference and clear the way. */
function identity(parsed) {
  const name = parsed.pathname.endsWith('/') ? parsed.pathname.slice(0, -1) : parsed.pathname;
  return `${parsed.hostname}:${parsed.port}${name}`.toLowerCase();
}

/**
 * Whether `testUrl` names a database this file is allowed to drop. Two conditions, both
 * required: the database name ENDS in `_test` — `oak`, `oak_testing`, `oak_test-backup` and
 * `oak_test.old` are somebody’s data rather than a fixture, and so is `oak_test/` with a
 * slash after it — and it is not the live database the environment already points at,
 * compared as identities rather than as text. A live URL that will not parse names no
 * database, so it can match none.
 */
export function isSafeTestDatabaseUrl(testUrl, liveUrl) {
  let test;
  try {
    test = new URL(testUrl);
  } catch {
    return false;
  }
  if (!/_test$/.test(test.pathname)) {
    return false;
  }
  try {
    return identity(test) !== identity(new URL(liveUrl));
  } catch {
    return true;
  }
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
