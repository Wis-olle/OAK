import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/* Finding a salon is one page now; danh-sach-salon.html only forwards to it. */
const html = fs.readFileSync(path.join(root, 'ui', 'ket-qua-tim-kiem.html'), 'utf8');
const redirect = fs.readFileSync(path.join(root, 'ui', 'danh-sach-salon.html'), 'utf8');

const rows = [{ id: 4, name: 'Lala Nail Studio', slug: 'lala-nail-studio', district: 'Quận 1' }];
rows.meta = { page: 1, limit: 20, total: 1 };

/* The factory is inline in the page, so lift it out of its <script> to drive it here. The
   address bar it writes to is a plain object, which is also what the assertions read back. */
function searchPage(api, search) {
  const tail = html.slice(html.indexOf('function oakSearchResults()'));
  const script = tail.slice(0, tail.indexOf('</script>'));
  const location = { pathname: '/ket-qua-tim-kiem.html', search: search || '' };
  const media = { matches: false, addEventListener() {}, removeEventListener() {} };
  const context = {
    URLSearchParams,
    location,
    window: { matchMedia: () => media },
    history: {
      replaceState(state, title, url) {
        const mark = url.indexOf('?');
        location.search = mark === -1 ? '' : url.slice(mark);
      },
    },
    OAK: {
      api,
      toast: () => {},
      fmtDate: (iso) => iso,
      fmtPrice: (value) => String(value),
    },
  };
  vm.runInNewContext(`${script}\nresult = oakSearchResults();`, context);
  const state = context.result;
  /* Alpine's own, and the only thing init() needs that a plain object has not got. */
  state.$watch = () => {};
  /* `oak` is the page's own window.OAK. It is handed back so a test can decide what this
     browser has: the stub carries no track() by default, which is the browser served a
     cached page from before measurement existed. */
  return { state, location, oak: context.OAK };
}

test('a failed search raises loadError instead of the empty state, and retrying clears it', async () => {
  let failing = true;
  const { state } = searchPage(async () => {
    if (failing) {
      throw new Error('Không kết nối được máy chủ.');
    }
    return rows;
  });

  await state.load();
  assert.equal(state.loadError, true);
  assert.equal(state.salons.length, 0);
  assert.equal(state.total, 0);

  failing = false;
  await state.load();
  assert.equal(state.loadError, false);
  assert.equal(state.salons.length, 1);
});

test('the chosen sort reaches both the request and the address bar', () => {
  const { state, location } = searchPage(async () => rows);

  assert.equal(state.sortLabel, 'Phù hợp nhất');
  state.setSort('rating');
  assert.equal(state.sortLabel, 'Đánh giá');
  assert.equal(new URLSearchParams(state.query()).get('sort'), 'rating');
  assert.equal(new URLSearchParams(location.search).get('sort'), 'rating');

  /* Back to the default: the key leaves the query string rather than riding along empty. */
  state.setSort('');
  assert.equal(new URLSearchParams(location.search).has('sort'), false);
});

test('sorting by distance waits for a position, and gives it up with the location', () => {
  const { state } = searchPage(async () => rows);

  assert.equal(state.hasLocation, false);
  assert.equal(state.sortable('distance'), false);
  assert.equal(state.sortable(''), true);
  assert.equal(state.sortable('rating'), true);
  /* The dropdown reads the same rule the URL is checked against. */
  assert.match(html, /:disabled="!sortable\(option\.value\)"/);

  state.coords.lat = 10.776;
  state.coords.lng = 106.7;
  assert.equal(state.sortable('distance'), true);
  state.setSort('distance');
  state.clearLocation();
  assert.equal(state.filters.sort, '');
});

test('a sort key the page cannot honour never reaches the request', () => {
  /* Distance with nothing to measure from would sort the whole page on NaN. */
  const stranded = searchPage(async () => rows, '?sort=distance');
  stranded.state.init();
  assert.equal(stranded.state.filters.sort, '');

  const bogus = searchPage(async () => rows, '?sort=bogus&q=nail');
  bogus.state.init();
  assert.equal(bogus.state.filters.sort, '');
  /* State first, then the address bar on the next thing the reader does. */
  bogus.state.applyQuery();
  assert.equal(new URLSearchParams(bogus.location.search).has('sort'), false);

  const kept = searchPage(async () => rows, '?sort=distance&lat=10.776&lng=106.7');
  kept.state.init();
  assert.equal(kept.state.filters.sort, 'distance');
});

test('every criterion the search is filtering on has a chip', () => {
  /* Every key tim-kiem-thong-minh.html sends (SEARCH_KEYS) plus the filters set here. */
  const { state } = searchPage(async () => rows, '?q=nail&category=nail&style=Nail%20art'
    + '&district=Qu%E1%BA%ADn%201&date=2026-08-21&time_from=18:00&time_to=20:00'
    + '&open_now=1&price_max=300000&rating_min=4');
  state.init();

  /* Array.from, because the chips are built in the page's own realm. */
  assert.deepEqual(Array.from(state.chips, (chip) => chip.key),
    ['q', 'category', 'style', 'district', 'date', 'time', 'open_now', 'rating_min', 'price_max']);
  assert.deepEqual(Array.from(state.chips, (chip) => chip.label),
    ['"nail"', 'Nail', 'Nail art', 'Quận 1', '2026-08-21', '18:00–20:00',
      'Đang mở cửa', 'Từ 4.0 sao', 'Dưới 300.000đ']);
});

test('an open-ended hour window is one chip, and it drops both of its parameters', () => {
  const after = searchPage(async () => rows, '?date=2026-08-21&time_from=18:00');
  after.state.init();
  assert.equal(after.state.chips.find((chip) => chip.key === 'time').label, 'Sau 18:00');

  const { state, location } = searchPage(async () => rows,
    '?date=2026-08-21&time_from=18:00&time_to=20:00&q=nail');
  state.init();
  assert.equal(state.chips.find((chip) => chip.key === 'time').label, '18:00–20:00');

  state.removeCriterion('time');
  const params = new URLSearchParams(location.search);
  assert.equal(params.has('time_from'), false);
  assert.equal(params.has('time_to'), false);
  assert.equal(params.get('date'), '2026-08-21');
  assert.equal(params.get('q'), 'nail');
});

test('an hour window with no day to narrow is neither shown nor sent', () => {
  /* The assistant can read an hour out of "massage buổi tối" and name no date at all, and
     the search only applies the window inside a date — so a chip would promise a filter
     that nothing performed. */
  const { state } = searchPage(async () => rows, '?q=massage&time_from=17:00&time_to=21:00');
  state.init();

  assert.equal(state.chips.some((chip) => chip.key === 'time'), false);
  const params = new URLSearchParams(state.query());
  assert.equal(params.has('time_from'), false);
  assert.equal(params.has('time_to'), false);
  assert.equal(params.get('q'), 'massage');
});

test('dropping the day drops the hours that stood on it', () => {
  const { state, location } = searchPage(async () => rows,
    '?q=massage&date=2026-08-21&time_from=17:00&time_to=21:00');
  state.init();
  assert.equal(state.chips.find((chip) => chip.key === 'time').label, '17:00–21:00');

  state.removeCriterion('date');
  const params = new URLSearchParams(location.search);
  assert.equal(params.has('date'), false);
  assert.equal(params.has('time_from'), false);
  assert.equal(params.has('time_to'), false);
  assert.equal(state.chips.some((chip) => chip.key === 'time'), false);
  assert.equal(params.get('q'), 'massage');
});

test('removing a chip drops its parameter and leaves the others standing', () => {
  const { state, location } = searchPage(async () => rows,
    '?q=nail&date=2026-08-21&open_now=1&price_max=300000');
  state.init();

  state.removeCriterion('date');
  assert.equal(new URLSearchParams(location.search).has('date'), false);
  assert.equal(state.chips.some((chip) => chip.key === 'date'), false);

  state.removeCriterion('open_now');
  assert.equal(new URLSearchParams(location.search).has('open_now'), false);

  state.removeCriterion('price_max');
  assert.equal(new URLSearchParams(location.search).has('price_max'), false);

  /* The keyword goes from the search box as well as from the address bar. */
  state.removeCriterion('q');
  assert.equal(new URLSearchParams(location.search).has('q'), false);
  assert.equal(state.q, '');
  assert.equal(state.chips.length, 0);
});

test('the keyword box rewrites q and keeps the rest of the search', () => {
  const { state, location } = searchPage(async () => rows, '?district=Qu%E1%BA%ADn%201&q=nail');
  state.init();

  assert.equal(state.q, 'nail');
  state.q = '  cắt tóc  ';
  state.applyQuery();

  const params = new URLSearchParams(location.search);
  assert.equal(params.get('q'), 'cắt tóc');
  assert.equal(params.get('district'), 'Quận 1');
  /* Written straight back through query(), an unchanged search must stay one parameter. */
  assert.deepEqual(params.getAll('q'), ['cắt tóc']);
  state.applyQuery();
  assert.deepEqual(new URLSearchParams(location.search).getAll('q'), ['cắt tóc']);
});

/*
 * The height budget below md, in the two views, both orientations and with 0 or 3 chips.
 * Type and spacing are read off ui/assets/js/oak-tailwind-config.js; the control widths are
 * estimates of the rendered chrome, rounded up so the budget is a floor rather than a fit.
 * main is h-screen with pt-24 and, below md, no bottom padding (max-md:pb-0).
 */
const BOX = {
  headerOffset: 96,            // main's pt-24, clearing the fixed top bar
  padding: { list: 24, map: 16 },   // the header block's p-6, and its max-md:p-4 over a map
  border: 1,                   // border-b under the header block
  gap: 24,                     // mb-6 between the header's rows
  mapGap: 12,                  // the form's max-md:mb-3 over a map
  form: 52,                    // input: py-3 + 1px borders + 16px/1.6 line
  heading: 34,                 // h1: 24px/1.4
  subtitle: 26,                // the "all salons" line: 16px/1.6
  chipRow: 32,                 // chip: py-1 around a 24px close button
  chipGap: 8,                  // gap-2 between chip rows
  chipWidth: 110,              // a chip with a short label and its close button
  filterRow: 36,               // filter button: py-2 + a 14px label
  filterGap: 12,               // gap-3 between filter rows
  filterWidths: [68, 128, 106, 88, 104, 196],   // Giá … Sắp xếp: Phù hợp nhất
};

/** How many lines `widths` wrap into at `available` px, laid out left to right with `gap`. */
function wrapRows(widths, gap, available) {
  let count = widths.length ? 1 : 0;
  let line = 0;
  for (const width of widths) {
    const next = line === 0 ? width : line + gap + width;
    if (next > available) {
      count += 1;
      line = width;
    } else {
      line = next;
    }
  }
  return count;
}

function chipHeight(chips, width) {
  if (chips === 0) {
    return 0;
  }
  const lines = wrapRows(Array(chips).fill(BOX.chipWidth), BOX.chipGap, width - 2 * BOX.padding.list);
  return lines * BOX.chipRow + (lines - 1) * BOX.chipGap;
}

/** The header block's height in each view, and what is left over for list or map. */
function budget(view, viewport, chips) {
  const available = viewport.height - BOX.headerOffset;
  const pad = BOX.padding[view];
  let header = 2 * pad + BOX.border + BOX.form;
  if (view === 'map') {
    // Only the search box and the chips are pinned over a map; mb-0 under the last chip row.
    header += BOX.mapGap + chipHeight(chips, viewport.width);
  } else {
    header += BOX.gap + BOX.heading + 8
      + (chips === 0 ? BOX.subtitle : chipHeight(chips, viewport.width)) + BOX.gap;
    const lines = wrapRows(BOX.filterWidths, BOX.filterGap, viewport.width - 2 * pad);
    header += lines * BOX.filterRow + (lines - 1) * BOX.filterGap;
  }
  return { available, header, rest: available - header };
}

const VIEWPORTS = {
  portrait: { width: 375, height: 667 },
  landscape: { width: 667, height: 375 },
};

test('below md the map view keeps at least half the screen for the map', () => {
  for (const [name, viewport] of Object.entries(VIEWPORTS)) {
    for (const chips of [0, 3]) {
      const { available, rest } = budget('map', viewport, chips);
      assert.ok(rest >= available / 2,
        `map view, ${name}, ${chips} chips: map ${rest}px of ${available}px available`);
    }
  }
  /* Which is only true because the heading and the filter row stand down there. */
  assert.match(html, /:class="mobileView === 'map' \? 'max-md:hidden' : ''" class="font-headline-sm/);
  assert.match(html, /:class="mobileView === 'map' \? 'max-md:hidden' : ''" class="flex flex-wrap gap-3"/);
  assert.match(html, /:class="mobileView === 'map' \? 'max-md:p-4' : ''"/);
  assert.match(html, /max-md:block max-md:h-auto max-md:flex-1 max-md:min-h-0/);
});

test('below md the list view can always be scrolled to the results', () => {
  for (const [name, viewport] of Object.entries(VIEWPORTS)) {
    for (const chips of [0, 3]) {
      const { header, rest } = budget('list', viewport, chips);
      /* Landscape has no room for this header at all, which is exactly why the column
         around the list — not the list — is the scroll surface below md. */
      assert.ok(rest > 0 || header > 0,
        `list view, ${name}, ${chips} chips: ${rest}px left of the column`);
    }
  }
  assert.ok(budget('list', VIEWPORTS.landscape, 3).rest < 0,
    'the landscape header is expected to overflow; the assertion below is what saves it');
  assert.match(html, /:class="mobileView === 'map' \? 'max-md:h-auto max-md:shrink-0' : 'max-md:overflow-y-auto'"/);
  assert.match(html, /'max-md:hidden' : 'max-md:overflow-visible'" class="flex-grow overflow-y-auto/);
  /* The clearance the floating switch used to get from main's own foot. */
  assert.match(html, /class="pt-24 flex-grow pb-section-gap max-md:pb-0/);
  assert.match(html, /p-6 md:p-8 max-md:pb-36 space-y-6/);
});

test('a pin opens a summary where there is no hover to preview it with', () => {
  assert.match(html, /var TOUCH = window\.matchMedia\('\(hover: none\)'\);/);
  assert.match(html, /if \(TOUCH\.matches\) \{\s*marker\.bindPopup\(popupHtml\(salon, self\.salonUrl\(salon\)\)\);/);
  assert.match(html, /\} else \{\s*marker\.on\('click', function \(\) \{ self\.openSalon\(salon\); \}\);/);
});

test('the empty message is gated on a genuinely successful response', () => {
  assert.match(html, /x-if="!loading &amp;&amp; !loadError &amp;&amp; !salons\.length"/);
  assert.match(html, /x-if="!loading &amp;&amp; loadError"/);
  assert.match(html, /@click="load\(\)"/);
});

test('the old salon list forwards to the search page, keyword and all', () => {
  assert.match(redirect, /url=ket-qua-tim-kiem\.html/);
  assert.match(redirect, /get\("q"\)/);
  assert.match(redirect, /location\.replace\("ket-qua-tim-kiem\.html"/);
  assert.doesNotMatch(redirect, /oakSalonDirectory/);
});

/* A search is the top of the booking funnel, and until now nothing counted one. These pin
   the two things that make the number readable: it is a search somebody asked for, not a
   filter being nudged, and it carries how many salons came back. */

test('a submitted search is counted once the answer is in, with the count it returned', async () => {
  const { state, oak } = searchPage(async () => rows);
  const events = [];
  oak.track = (name, meta) => events.push([name, meta]);

  await state.applyQuery();

  assert.equal(events.length, 1);
  assert.equal(events[0][0], 'search_submit');
  /* Read a field at a time: the meta object is built in the page's own realm. */
  assert.equal(events[0][1].total, 1);
});

test('a search that never got an answer is not counted as a search with no results', async () => {
  /* load() swallows its own failure, so applyQuery() resolves either way. Counting the
     zero it leaves behind would make a dead network look like a keyword nobody matches —
     the two things a search number most has to tell apart. */
  const { state, oak } = searchPage(async () => {
    throw new Error('Không kết nối được máy chủ.');
  });
  const events = [];
  oak.track = (name, meta) => events.push([name, meta]);

  await state.applyQuery();

  assert.equal(state.loadError, true);
  assert.deepEqual(events, []);
});

test('narrowing a filter is a refinement of the search, not another search', async () => {
  const { state, oak } = searchPage(async () => rows);
  const events = [];
  oak.track = (name, meta) => events.push([name, meta]);

  await state.load();
  state.setSort('rating');

  assert.deepEqual(events, []);
});

test('a browser whose oak-api.js has no track() still searches', async () => {
  /* The stub carries no track(), which is a page served from cache meeting an older
     script. Measurement that breaks the page it measures is worse than no measurement. */
  const { state, location } = searchPage(async () => rows);
  state.q = ' noi mi ';

  await assert.doesNotReject(() => state.applyQuery());
  assert.equal(state.q, 'noi mi');
  assert.equal(new URLSearchParams(location.search).get('q'), 'noi mi');
});
