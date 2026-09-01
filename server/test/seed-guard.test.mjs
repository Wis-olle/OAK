// The demo seed writes ten accounts that share one password server/README.md prints in
// full. This file is the proof that a production database never gets them by accident:
// every case below is a database that is empty, which is the only state in which the
// question is even asked, plus the two shapes COUNT(*) can arrive in.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { shouldSeedDemo } from '../src/seed.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dbSource = fs.readFileSync(path.join(root, 'server/src/db.js'), 'utf8');

test('an empty database on a developer machine is seeded', () => {
  assert.equal(shouldSeedDemo({}, 0), true);
  assert.equal(shouldSeedDemo({ NODE_ENV: 'development' }, 0), true);
});

test('an empty production database is not seeded', () => {
  assert.equal(shouldSeedDemo({ NODE_ENV: 'production' }, 0), false);
});

test('production seeds only when asked for it by name', () => {
  assert.equal(shouldSeedDemo({ NODE_ENV: 'production', SEED_DEMO: '1' }, 0), true);
});

// The opt-in is a literal '1', not a truthiness test: 'true' and '0' are both things an
// operator plausibly types into a dashboard, and neither one may seed production.
test('any SEED_DEMO other than 1 leaves production alone', () => {
  assert.equal(shouldSeedDemo({ NODE_ENV: 'production', SEED_DEMO: 'true' }, 0), false);
  assert.equal(shouldSeedDemo({ NODE_ENV: 'production', SEED_DEMO: '0' }, 0), false);
  assert.equal(shouldSeedDemo({ NODE_ENV: 'production', SEED_DEMO: '' }, 0), false);
});

// db.js installs an int8 type parser, so COUNT(*) reaches the guard as a number today;
// the string is what pg hands back without it, and re-seeding a database that already
// holds accounts would be the worse failure of the two.
test('a database that already holds accounts is never seeded, in either spelling', () => {
  assert.equal(shouldSeedDemo({}, 3), false);
  assert.equal(shouldSeedDemo({}, '3'), false);
  assert.equal(shouldSeedDemo({ SEED_DEMO: '1' }, 3), false);
  assert.equal(shouldSeedDemo({ NODE_ENV: 'production', SEED_DEMO: '1' }, '3'), false);
});

// Everything above is true of a function nobody calls. This pins the one call site: the
// guard decides from the real environment, not from a literal somebody left behind.
test('db.js asks the guard, and asks it with the process environment', () => {
  assert.match(dbSource, /shouldSeedDemo\(process\.env, /);
});
