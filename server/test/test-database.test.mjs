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

// `_test` has to be the end of the word. `oak_testing` is a database somebody named on
// purpose, and the suite has no business guessing that the extra letters do not matter.
test('a name that is not a whole _test word is refused', () => {
  assert.equal(isSafeTestDatabaseUrl('postgres://postgres:postgres@localhost:5432/oak', undefined), false);
  assert.equal(
    isSafeTestDatabaseUrl('postgres://postgres:postgres@localhost:5432/oak_testing', undefined),
    false,
  );
});

test('anything that is not a URL is refused', () => {
  assert.equal(isSafeTestDatabaseUrl('oak_test', undefined), false);
  assert.equal(isSafeTestDatabaseUrl('', undefined), false);
  assert.equal(isSafeTestDatabaseUrl(undefined, undefined), false);
});
