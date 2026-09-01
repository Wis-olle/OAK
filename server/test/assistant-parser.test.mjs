/* The rule-based assistant in routes/search.js: what it takes out of a sentence, and how it
   says it back. The route file talks to the database, so it cannot simply be imported — the
   body between the router and the default export is lifted and driven in a context whose
   `db` and `express` are stubs, the same trick events-route.test.mjs uses. The three pure
   libraries it reads (text, time, locations) are the real ones: the district list under test
   IS lib/locations.js, and a stub of it would test nothing. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { CITY_DISTRICTS } from '../src/lib/locations.js';
import { bestMatchTier, countMatchedTokens, normalize, searchTokens } from '../src/lib/text.js';
import {
  addDaysISO,
  fromMinutes,
  isHHMM,
  isISODate,
  nowMinutes,
  toMinutes,
  todayISO,
  weekdayOf,
} from '../src/lib/time.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routeJs = fs.readFileSync(path.join(root, 'src', 'routes', 'search.js'), 'utf8');

/* Everything the module declares, with the imports and the default export cut away. Both
   markers are code, not comments, so rewording a comment cannot change what is under test —
   but moving the parser out of search.js will fail loudly right here. */
function lift() {
  const from = routeJs.indexOf('const router = express.Router();');
  const to = routeJs.indexOf('export default router');
  assert.ok(from !== -1 && to > from, 'search.js no longer has a router body to lift');

  /* Statements, not queries: the lifted body prepares its statements at module level and
     registers its routes, and neither is what this file is about. */
  const statement = { all: async () => [], get: async () => ({ count: 0 }) };
  const context = {
    express: { Router: () => ({ get() {}, post() {}, use() {} }) },
    db: { prepare: () => statement },
    CITY_DISTRICTS,
    bestMatchTier,
    countMatchedTokens,
    normalize,
    searchTokens,
    addDaysISO,
    fromMinutes,
    isHHMM,
    isISODate,
    nowMinutes,
    toMinutes,
    todayISO,
    weekdayOf,
    httpError: () => new Error('httpError'),
    salonsWithSlotsInRange: async () => new Set(),
    SALON_CARD_COLUMNS: '',
    toSalonCard: (row) => row,
    haversineKm: () => null,
    parsePagination: () => ({ page: 1, limit: 12, offset: 0 }),
  };
  vm.runInNewContext(
    `${routeJs.slice(from, to)}\nglobalThis.lifted = { parseAssistantMessage, buildReply };`,
    context,
  );
  return context.lifted;
}

const { parseAssistantMessage: parse, buildReply } = lift();

/* The parser runs in its own realm, so its objects fail a strict deep compare on their
   prototype alone. Spreading brings the values back into this one. */
function parseAssistantMessage(message) {
  return { ...parse(message) };
}

test('a salon name the rules do not know is carried on as the free keyword', () => {
  assert.deepEqual(parseAssistantMessage('Lala nail quận 1'), {
    category: 'nail',
    district: 'Quận 1',
    q: 'lala',
  });
});

test('a message that is nothing but scaffolding leaves no keyword behind', () => {
  assert.deepEqual(parseAssistantMessage('mình muốn tìm tiệm nail ở quận 3'), {
    category: 'nail',
    district: 'Quận 3',
  });
});

test('the words a rule already claimed never come back as the keyword', () => {
  const parsed = parseAssistantMessage('nối mi quận 12 buổi chiều dưới 500k');
  assert.equal(parsed.category, 'eyelash');
  assert.equal(parsed.district, 'Quận 12');
  assert.equal(parsed.time_from, '13:00');
  assert.equal(parsed.price_max, 500000);
  assert.equal(parsed.q, undefined);
});

test('a leftover shorter than three characters is noise, not a name', () => {
  assert.equal(parseAssistantMessage('nail ở q1 ab').q, undefined);
  // Measured per word, not over the joined run: two short fragments are still two fragments,
  // and a one-letter token matches nearly every salon by containment.
  assert.equal(parseAssistantMessage('ừ ok').q, undefined);
  assert.equal(parseAssistantMessage('có ai ở đó không').q, undefined);
});

/* q is a hard filter on the results page: a keyword no salon carries is an empty page, so
   the opening line of a conversation must never become one. */
test('a greeting or a question is not a keyword', () => {
  for (const message of ['chào bạn', 'tìm salon gần đây', 'spa gần đây', 'salon nào tốt không']) {
    assert.equal(parseAssistantMessage(message).q, undefined, `"${message}" became a keyword`);
  }
});

test('a word a rule claimed is gone from the keyword however often it was said', () => {
  assert.equal(parseAssistantMessage('nail quận 1 làm nail').q, undefined);
});

/* The five districts the old hand-written list held, plus the ones it did not: the list is
   generated from lib/locations.js now, so every district the profile form offers is a
   district the assistant understands. */
test('every named district of every city the product serves is understood', () => {
  const named = Object.values(CITY_DISTRICTS)
    .flat()
    .filter((name) => !/\d/.test(name));
  for (const district of named) {
    assert.equal(
      parseAssistantMessage(`tìm salon ở ${district}`).district,
      district,
      `${district} was not understood`,
    );
  }
});

test('a longer district name is not answered by a shorter one it contains', () => {
  assert.equal(parseAssistantMessage('nail ở Bình Tân').district, 'Quận Bình Tân');
  assert.equal(parseAssistantMessage('nail ở Bình Thạnh').district, 'Quận Bình Thạnh');
});

test('the reply names the rating and the keyword it understood', () => {
  const reply = buildReply({ q: 'lala', category: 'nail', rating_min: 4.5 }, 3, null);

  assert.match(reply, /từ khoá "lala"/);
  assert.match(reply, /đánh giá từ 4\.5 sao/);
  assert.match(reply, /dịch vụ nail/);
});

/* The count knows the district, the category and the keyword and nothing else, so it says
   which of the three it counted: called "phù hợp" beside a budget or a date it would simply
   read as wrong. */
test('the count says what it counted', () => {
  assert.match(buildReply({ category: 'nail' }, 6, null), /Hiện có 6 salon nail\./);
  assert.match(buildReply({ district: 'Quận 1' }, 4, null), /Hiện có 4 salon ở Quận 1\./);
  assert.match(
    buildReply({ q: 'lala', category: 'nail', district: 'Quận 1' }, 2, null),
    /Hiện có 2 salon nail ở Quận 1 khớp "lala"\./,
  );
});

test('nothing countable is nothing said', () => {
  assert.ok(!buildReply({ price_max: 300000 }, null, null).includes('Hiện có'));
});

/* q is a hard filter on the results page, so a keyword nothing matches is let go before the
   reply promises a number — and the sentence says which word went, or the reader is left
   comparing a reply about a keyword with a page that no longer has one. */
test('a keyword that matched nothing is named as let go', () => {
  const reply = buildReply({ category: 'spa', district: 'Quận 3' }, 1, null, 'thu gian');

  assert.match(reply, /chưa thấy salon nào khớp từ khoá "thu gian"/);
  /* The full stop is part of the match: the count sentence names what it counted, and the
     keyword that was let go is not part of that. */
  assert.match(reply, /Hiện có 1 salon spa & massage ở Quận 3\./);
});

test('a district with no salon is said out loud, with the nearest ones named', () => {
  const reply = buildReply({ category: 'eyelash' }, 4, {
    district: 'Quận 12',
    nearest: ['Quận 1', 'Quận 3'],
  });

  assert.match(reply, /chưa có salon ở Quận 12/);
  assert.match(reply, /gần nhất là Quận 1 và Quận 3/);
});
