// The smoke suite drops a whole schema before every run. This file is the proof that it
// drops the fixture and nothing else: the name has to say `_test` out loud, and it has to
// disagree with whatever DATABASE_URL the shell is carrying.
import assert from 'node:assert/strict';
import test from 'node:test';

import { isSafeTestDatabaseUrl } from './lib/test-database.mjs';

const TEST_URL = 'postgres://postgres:postgres@localhost:5432/oak_test';

test('the fixture database is resettable', () => {
  assert.equal(isSafeTestDatabaseUrl(TEST_URL, undefined), true);
  assert.equal(isSafeTestDatabaseUrl(TEST_URL, ''), true);
  // Supabase hands out its URL with query parameters; they belong to the connection, not
  // to the name being checked.
  assert.equal(isSafeTestDatabaseUrl(`${TEST_URL}?sslmode=require`, undefined), true);
});

// The one case a developer shell actually produces: DATABASE_URL exported for `npm start`,
// OAK_TEST_DATABASE_URL copied from it, and the suite about to empty the dev database.
test('a test URL that is also the live URL is refused', () => {
  assert.equal(isSafeTestDatabaseUrl(TEST_URL, TEST_URL), false);
  assert.equal(isSafeTestDatabaseUrl(TEST_URL, 'postgres://postgres@db.supabase.co/postgres'), true);
});

/* And it is the same database that matters, not the same string. A connection setting the
   two spellings disagree on, or the longer name of the same protocol, would otherwise read
   as a different database and clear the way to dropping the live one. */
test('the live URL is matched as a database, not as text', () => {
  assert.equal(isSafeTestDatabaseUrl(`${TEST_URL}?sslmode=require`, TEST_URL), false);
  assert.equal(
    isSafeTestDatabaseUrl(TEST_URL, 'postgresql://postgres:postgres@localhost:5432/oak_test'),
    false,
  );
  assert.equal(isSafeTestDatabaseUrl(TEST_URL, 'postgres://postgres@LOCALHOST:5432/oak_test'), false);
});

// `_test` has to be where the name ENDS. Every one of these is a database somebody named on
// purpose — a backup taken before a migration most of all — and the suite has no business
// guessing that the extra characters do not matter.
test('a name that does not end in _test is refused', () => {
  assert.equal(isSafeTestDatabaseUrl('postgres://postgres:postgres@localhost:5432/oak', undefined), false);
  assert.equal(
    isSafeTestDatabaseUrl('postgres://postgres:postgres@localhost:5432/oak_testing', undefined),
    false,
  );
  assert.equal(
    isSafeTestDatabaseUrl('postgres://postgres:postgres@localhost:5432/oak_test-backup', undefined),
    false,
  );
  assert.equal(
    isSafeTestDatabaseUrl('postgres://postgres:postgres@localhost:5432/oak_test.old', undefined),
    false,
  );
  assert.equal(isSafeTestDatabaseUrl(`${TEST_URL}/`, undefined), false);
});

test('anything that is not a URL is refused', () => {
  assert.equal(isSafeTestDatabaseUrl('oak_test', undefined), false);
  assert.equal(isSafeTestDatabaseUrl('', undefined), false);
  assert.equal(isSafeTestDatabaseUrl(undefined, undefined), false);
});
