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
  /* Every restatement of the <head>, in order. */
  const head = [];
  const context = {
    URLSearchParams,
    encodeURIComponent,
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
      /* The head is restated once the criteria are known; what it was asked to say is
         handed back so a test can read it. */
      meta: (values) => { head.push(values); },
      fmtDate: (iso) => iso,
      fmtPrice: (value) => String(value),
      /* The page reads today from the API layer rather than keeping its own copy of it. */
      todayISO: () => isoAhead(0),
      /* A guest, which is what most readers of this page are: no favourites are fetched. */
      me: async () => null,
      districts: async () => ['Quận 1', 'Quận 3'],
    },
  };
  vm.runInNewContext(`${script}\nresult = oakSearchResults();`, context);
  const state = context.result;
  /* Alpine's own, and the only things init() needs that a plain object has not got. */
  state.$watch = () => {};
  state.$nextTick = (run) => run();
  state.$refs = { keyword: { focused: false, focus() { this.focused = true; } } };
  /* `oak` is the page's own window.OAK. It is handed back so a test can decide what this
     browser has: the stub carries no track() by default, which is the browser served a
     cached page from before measurement existed. */
  return { state, location, oak: context.OAK, head };
}

test('a search for a category in a district says so in the tab and the share card', async () => {
  /* The page ships one <title> for every search it can run, so a link to the nail salons of
     Quận 1 is shared and indexed as "Tìm salon". Once the criteria are read out of the URL,
     the head can say which list this is — and it waits for the areas the page offers, so
     both halves of that sentence are values this page itself put on screen. */
  const nail = searchPage(async () => rows, '?category=nail&district=Qu%E1%BA%ADn%201');
  nail.state.init();
  await new Promise(setImmediate);
  const head = nail.head;
  assert.equal(head.length, 1);
  assert.match(head[0].title, /Quận 1/);
  assert.match(head[0].title, /Nail/);
  assert.match(head[0].title, /OAK Beauty/);
  assert.match(head[0].description, /Quận 1/);

  // A district nobody offers is not what a shared link previews as: the sentence falls back
  // to the city, the same way a category the page does not run is dropped.
  const crafted = searchPage(async () => rows, '?category=nail&district=' + encodeURIComponent('<b>Quận 99'));
  crafted.state.init();
  await new Promise(setImmediate);
  assert.equal(crafted.head.length, 1);
  assert.match(crafted.head[0].title, /TP\.HCM/);
  assert.doesNotMatch(crafted.head[0].title, /Quận 99/);

  // Nothing to add to what the page already says: the head is left as it shipped.
  const anywhere = searchPage(async () => rows, '?open_now=1');
  anywhere.state.init();
  await new Promise(setImmediate);
  assert.equal(anywhere.head.length, 0);
});

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
 * main is h-[100dvh] with pt-24 and, below md, no bottom padding (max-md:pb-0).
 */
const BOX = {
  headerOffset: 96,            // main's pt-24, clearing the fixed top bar
  padding: { list: 24, map: 16 },   // the header block's p-6, and its max-md:p-4 over a map
  border: 1,                   // border-b under the header block
  gap: 24,                     // mb-6 between the header's rows
  mapGap: 12,                  // the form's max-md:mb-3 over a map
  form: 52,                    // input: py-3 + 1px borders + 16px/1.6 line
  heading: 26,                 // h1: text-lg below md, 18px/1.4
  subtitle: 26,                // the "all salons" line: 16px/1.6
  chipRow: 32,                 // chip: py-1 around a 24px close button
  filterRow: 36,               // filter button: py-2 + a 14px label
  filterGap: 12,               // gap-3 between filter rows
  // Below md only these two are out of the fold: "Bộ lọc (n)" and the order.
  filterWidths: [104, 196],
  card: 128,                   // the first card's image, h-32
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

/* One line whatever the count: the row scrolls sideways rather than wrapping downwards. */
function chipHeight(chips) {
  return chips === 0 ? 0 : BOX.chipRow;
}

/** The header block's height in each view, and what is left over for list or map. */
function budget(view, viewport, chips) {
  const available = viewport.height - BOX.headerOffset;
  const pad = BOX.padding[view];
  let header = 2 * pad + BOX.border + BOX.form;
  if (view === 'map') {
    // Only the search box and the chips are pinned over a map; mb-0 under the last chip row.
    header += BOX.mapGap + chipHeight(chips);
  } else {
    header += BOX.gap + BOX.heading + 8
      + (chips === 0 ? BOX.subtitle : chipHeight(chips)) + BOX.gap;
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
  assert.match(html, /:class="mobileView === 'map' \? 'max-md:hidden' : ''" aria-atomic="true" aria-live="polite" class="font-headline-sm/);
  assert.match(html, /:class="mobileView === 'map' \? 'max-md:hidden' : ''" class="flex flex-wrap gap-3"/);
  assert.match(html, /:class="mobileView === 'map' \? 'max-md:p-4' : ''"/);
  assert.match(html, /max-md:block max-md:h-auto max-md:flex-1 max-md:min-h-0/);
});

test('below md the list view can always be scrolled to the results', () => {
  for (const [name, viewport] of Object.entries(VIEWPORTS)) {
    for (const chips of [0, 3]) {
      const { available, header, rest } = budget('list', viewport, chips);
      /* The control block is one screen at most, in either orientation: the pills fold
         behind one button and the criteria scroll sideways on one line. */
      assert.ok(header <= available,
        `list view, ${name}, ${chips} chips: ${header}px of header in ${available}px`);
      assert.ok(rest > 0,
        `list view, ${name}, ${chips} chips: ${rest}px left of the column`);
    }
  }
  /* Portrait — the phone this page is read on — keeps the first card on the first screen. */
  assert.ok(budget('list', VIEWPORTS.portrait, 3).rest >= BOX.card,
    'the first result must be reachable without scrolling past the controls');
  /* Which is only true because the pills are folded away and the chips are one line. */
  assert.match(html, /x-text="filterButtonLabel"/);
  assert.match(html, /:class="filtersOpen \? '' : 'max-md:hidden'" class="contents"/);
  assert.match(html, /class="flex flex-nowrap overflow-x-auto gap-2 mb-6"/);
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

/*
 * Changing a criterion where it is being read, instead of going back to the home page to
 * start again. The category, the area and the day used to arrive from the URL and could
 * only ever be dropped.
 */

test('the new pills write the criterion they name and the address bar follows', () => {
  const { state, location } = searchPage(async () => rows, '?q=nail');
  state.init();

  state.setCriterion('category', 'hair');
  assert.equal(new URLSearchParams(location.search).get('category'), 'hair');
  assert.equal(state.chips.find((chip) => chip.key === 'category').label, 'Tóc');
  /* The dropdown closes behind the choice. */
  assert.equal(state.openFilter, null);

  state.setCriterion('district', 'Quận 3');
  assert.equal(new URLSearchParams(location.search).get('district'), 'Quận 3');
  /* The keyword the search started from is still the search. */
  assert.equal(new URLSearchParams(location.search).get('q'), 'nail');
});

/** The local calendar day `days` ahead, in the ISO shape the search filters by. */
function isoAhead(days) {
  const day = new Date();
  day.setDate(day.getDate() + days);
  return [
    day.getFullYear(),
    String(day.getMonth() + 1).padStart(2, '0'),
    String(day.getDate()).padStart(2, '0'),
  ].join('-');
}

test('the day pill sets a real date, and "any time" takes the hours with it', () => {
  const { state, location } = searchPage(async () => rows, '?time_from=18:00');
  state.init();

  state.setDate(1);
  assert.equal(new URLSearchParams(location.search).get('date'), isoAhead(1));

  state.setDate(null);
  const params = new URLSearchParams(location.search);
  assert.equal(params.has('date'), false);
  assert.equal(params.has('time_from'), false);
});

test('"clear all" drops every criterion except the keyword', () => {
  const { state, location } = searchPage(async () => rows,
    '?q=nail&category=nail&district=Qu%E1%BA%ADn%201&date=2026-08-21&open_now=1&price_max=300000');
  state.init();
  assert.ok(state.chips.length > 1);

  state.clearAll();

  const params = new URLSearchParams(location.search);
  assert.equal(params.get('q'), 'nail');
  assert.deepEqual([...params.keys()], ['q']);
  assert.deepEqual(Array.from(state.chips, (chip) => chip.key), ['q']);
  /* And the row only offers it while there is more than one thing to undo. */
  assert.match(html, /x-show="chips\.length &gt; 1"/);
});

test('the filter button counts what is folded behind it, and the keyword is not one of them', () => {
  const { state } = searchPage(async () => rows, '?q=nail&category=nail&price_max=300000');
  state.init();

  assert.equal(state.filterButtonLabel, 'Bộ lọc (2)');
});

test('the filter button counts the location, which folds away without ever being a chip', () => {
  const { state } = searchPage(async () => rows, '?lat=10.7&lng=106.7');
  state.init();

  assert.equal(state.chips.length, 0);
  assert.equal(state.filterButtonLabel, 'Bộ lọc (1)');
});

/*
 * What the card carries into the wizard. The search already knows the service, the day and
 * the hour; the booking link used to drop all three.
 */

test('the booking link carries the matched service, the day and the hour', () => {
  const { state } = searchPage(async () => rows, '?category=hair&date=2026-08-21&time_from=18:00');
  state.init();

  const matched = { id: 7, name: 'Uốn xoăn', price: 350000, category: 'hair' };
  const url = new URLSearchParams(state.bookingUrl({ id: 4, matched_service: matched }).split('?')[1]);
  assert.equal(url.get('salon_id'), '4');
  assert.equal(url.get('service_id'), '7');
  assert.equal(url.get('date'), '2026-08-21');
  assert.equal(url.get('time'), '18:00');

  /* No matched service: the wizard opens on the salon, not on nothing. */
  const plain = new URLSearchParams(state.bookingUrl({ id: 4, matched_service: null }).split('?')[1]);
  assert.equal(plain.has('service_id'), false);
  assert.equal(plain.get('salon_id'), '4');
  /* And the button says which service it is booking. */
  assert.match(html, /<span>Đặt <span x-text="salon\.matched_service\.name"><\/span><\/span>/);
});

test('an hour with no day to sit in does not ride along either', () => {
  const { state } = searchPage(async () => rows, '?time_from=18:00');
  state.init();

  const url = new URLSearchParams(state.bookingUrl({ id: 4 }).split('?')[1]);
  assert.equal(url.has('time'), false);
  assert.equal(url.has('date'), false);
});

/* "Tải thêm": the heading promises N salons and the page only ever showed the first 12. */

test('loading more appends the next page and never the same salon twice', async () => {
  const pages = {
    1: Object.assign([{ id: 1 }, { id: 2 }], { meta: { page: 1, limit: 2, total: 3 } }),
    /* Salon 2 slipped down a rank between the two requests and arrives again. */
    2: Object.assign([{ id: 2 }, { id: 3 }], { meta: { page: 2, limit: 2, total: 3 } }),
  };
  const { state } = searchPage(async (url) => pages[new URLSearchParams(url.split('?')[1]).get('page') || 1]);

  await state.load();
  assert.equal(state.page, 1);
  assert.equal(state.moreLabel, 'Tải thêm (1)');

  const pending = state.more();
  /* The button says it is working and refuses a second tap while it is. */
  assert.equal(state.loadingMore, true);
  await pending;
  assert.equal(state.loadingMore, false);
  assert.deepEqual(Array.from(state.salons, (salon) => salon.id), [1, 2, 3]);
  assert.equal(state.page, 2);
  /* Disabled while a reload is in flight too: more() refuses then, so the button must say so
     rather than looking live and swallowing the tap. */
  assert.match(html, /:disabled="loading \|\| loadingMore"/);
  /* Nothing left to ask for, and the button is gated on exactly that. */
  assert.equal(state.salons.length, state.total);
  assert.match(html, /x-show="salons\.length &lt; total"/);
});

test('a page holding only salons already on screen retires the button', async () => {
  const pages = {
    /* Everything on page 2 slipped up into page 1's tail, so page 2 adds nothing. Without
       the guard the count stays under the total and the button asks for ever. */
    1: Object.assign([{ id: 1 }, { id: 2 }], { meta: { page: 1, limit: 2, total: 3 } }),
    2: Object.assign([{ id: 2 }], { meta: { page: 2, limit: 2, total: 3 } }),
  };
  const { state } = searchPage(async (url) => pages[new URLSearchParams(url.split('?')[1]).get('page') || 1]);

  await state.load();
  await state.more();

  assert.deepEqual(Array.from(state.salons, (salon) => salon.id), [1, 2]);
  assert.equal(state.total, 2);
});

test('a new search starts again at page one', async () => {
  const { state } = searchPage(async () => rows);
  await state.load();
  state.page = 3;

  await state.load();
  assert.equal(state.page, 1);
});

/* The empty state: a way out of it rather than a sentence about it. */

test('an empty page after a search for today says so, and offers the next day', () => {
  const { state, location } = searchPage(async () => Object.assign([], { meta: { total: 0 } }),
    `?q=nail&date=${isoAhead(0)}`);
  state.init();

  assert.equal(state.emptyMessage, 'Hôm nay đã hết lịch phù hợp.');
  assert.equal(state.canTryNextDay, true);
  state.tryNextDay();
  assert.equal(new URLSearchParams(location.search).get('date'), isoAhead(1));
});

test('an empty page with no date reads as an ordinary miss', () => {
  const { state } = searchPage(async () => rows, '?q=nail');
  state.init();

  assert.equal(state.emptyMessage,
    'Không tìm thấy salon nào phù hợp. Bạn thử nới rộng bộ lọc nhé.');
  assert.equal(state.canTryNextDay, false);
});

test('"try tomorrow" stays hidden on a search that is already set to tomorrow', () => {
  const { state } = searchPage(async () => rows, `?date=${isoAhead(1)}`);
  state.init();

  /* It adds a day to whatever is set, so on a tomorrow search it would offer the day after. */
  assert.equal(state.canTryNextDay, false);
  assert.match(html, /x-show="canTryNextDay"/);
});

test('the way out of an empty page drops what narrows and keeps what was asked for', () => {
  const { state, location } = searchPage(async () => rows,
    '?q=nail&category=nail&district=Qu%E1%BA%ADn%201&price_max=300000&rating_min=4&radius_km=3&lat=10.7&lng=106.7');
  state.init();
  assert.equal(state.hasNarrowing, true);

  state.clearNarrowing();
  const params = new URLSearchParams(location.search);
  assert.equal(params.has('price_max'), false);
  assert.equal(params.has('rating_min'), false);
  assert.equal(params.has('radius_km'), false);
  assert.equal(params.get('q'), 'nail');
  assert.equal(params.get('category'), 'nail');
  assert.equal(params.get('district'), 'Quận 1');
  assert.equal(state.hasNarrowing, false);

  /* And the assistant is handed the sentence rather than a blank page. */
  assert.equal(state.assistantUrl, 'tim-kiem-thong-minh.html?q=nail');
});

test('the empty block is the shared one, with an icon and its ways out', () => {
  /* OAK-EMPTY marks the markup lifted from yeu-thich.html, so the two cannot drift. */
  assert.match(html, /OAK-EMPTY/);
  assert.match(html, /class="bg-surface-container-low rounded-lg py-16 px-6 text-center"/);
  assert.match(html, /data-icon="search_off"/);
  assert.match(html, /@click="tryNextDay\(\)"/);
  assert.match(html, /@click="clearNarrowing\(\)"/);
  assert.match(html, /@click="removeCriterion\('district'\)"/);
  assert.match(html, /:href="assistantUrl"/);
});

/* Saving a salon from the results, and being sent to sign in without losing the search. */

test('the heart reads the saved list once and toggles against it', async () => {
  const calls = [];
  const { state, oak } = searchPage(async (url, options) => {
    calls.push([url, options && options.method]);
    if (url === '/api/favorites' && !options) {
      return { salons: [{ id: 4 }], services: [] };
    }
    return { ok: true };
  });
  oak.me = async () => ({ id: 1 });
  oak.requireLogin = async () => ({ id: 1 });

  await state.loadFavorites();
  assert.equal(state.isFavorite({ id: 4 }), true);
  assert.equal(state.isFavorite({ id: 5 }), false);

  await state.toggleFavorite({ id: 4 });
  assert.equal(state.isFavorite({ id: 4 }), false);
  assert.deepEqual(calls[1], ['/api/favorites?salon_id=4', 'DELETE']);

  await state.toggleFavorite({ id: 4 });
  assert.equal(state.isFavorite({ id: 4 }), true);
  assert.deepEqual(calls[2], ['/api/favorites', 'POST']);
});

test('a guest is sent to sign in before anything is saved', async () => {
  let asked = false;
  const { state, oak } = searchPage(async () => {
    throw new Error('the guest must never reach the API');
  });
  oak.requireLogin = async () => {
    asked = true;
    /* The real one never settles: the page it redirects away from must stop here. */
    return new Promise(() => {});
  };

  state.toggleFavorite({ id: 4 });
  await Promise.resolve();
  assert.equal(asked, true);
  assert.equal(state.favorites.length, 0);
});

test('a guest fetches no list of favourites at all', async () => {
  const { state } = searchPage(async () => {
    throw new Error('a guest has no favourites to fetch');
  });

  await assert.doesNotReject(() => state.loadFavorites());
  assert.deepEqual(Array.from(state.favorites), []);
});

/* A deep link with no producer in the product: see the note on the handler it guards. */

test('?focus=q puts the caret in the keyword box and never reaches the request', () => {
  const { state } = searchPage(async () => rows, '?focus=q&q=nail');
  state.init();

  assert.equal(state.$refs.keyword.focused, true);
  assert.equal(new URLSearchParams(state.query()).has('focus'), false);
  assert.equal(new URLSearchParams(state.query()).get('q'), 'nail');
});

test('the keyword box tells a phone keyboard it searches', () => {
  assert.match(html, /enterkeyhint="search"/);
  assert.match(html, /autocomplete="off"/);
});

/* The map: a pin a thumb can tell from its neighbour, with its price on it. */

test('a pin is drawn for what the salon does, and its label carries a price', () => {
  assert.match(html, /\['nail', 'brush'\]/);
  assert.match(html, /\['hair', 'content_cut'\]/);
  assert.match(html, /\['skincare', 'face'\]/);
  assert.match(html, /\['eyelash', 'visibility'\]/);
  assert.match(html, /pinIcon\(salon\)/);
  /* Its own node, so the dictionary reads the price on its own. The label wins when the
     search swapped the price for a service's, since nothing beside a pin explains it. */
  assert.match(html, /var priceText = salon\.price_from_label/);
  assert.match(html, /'Từ ' \+ OAK\.fmtPrice\(salon\.price_from\)/);
  assert.match(html, /escapeHtml\(priceText\)/);
  /* Labels stand open on a small set, because a touch screen has no hover to open them. */
  assert.match(html, /labelsPinned \? 'opacity-100' : 'opacity-0'/);
  assert.match(html, /length <= PINNED_LABELS_MAX/);
});

test('the card meta line says which service a swapped price belongs to', () => {
  const { state } = searchPage(async () => rows);

  /* No label: the number is the salon's own floor and reads as it always did. */
  assert.equal(
    state.locationOf({ district: 'Quận 1', price_from: 300000, price_from_label: null }),
    'Quận 1 • từ 300000',
  );
  /* With one: the search quoted a service, and the line names it. */
  assert.equal(
    state.locationOf({
      district: 'Quận 1',
      price_from: 350000,
      price_from_label: 'Nối mi từ 350.000đ',
    }),
    'Quận 1 • Nối mi từ 350.000đ',
  );
});

test('a result card answers a keyboard the way the link it is would', () => {
  assert.match(html, /<article [^>]*tabindex="0"/);
  /* .self, or Enter on the heart inside it would navigate away as well. */
  assert.match(html, /@keydown\.enter\.self="openSalon\(salon\)"/);
  /* No link role on it: it holds the heart and two links, and axe's nested-interactive
     forbids focusable children inside a widget role. */
  assert.doesNotMatch(html, /<article [^>]*role=/);
});

test('every filter dropdown says whether it is open', () => {
  const buttons = html.match(/<button [^>]*@click="openFilter = openFilter === '\w+'/g) || [];
  assert.equal(buttons.length, 8);
  for (const button of buttons) {
    assert.match(button, /:aria-expanded="openFilter === '\w+'"/);
  }
  assert.equal((html.match(/aria-haspopup="(listbox|dialog)"/g) || []).length, 8);
});

/*
 * The hero of kham-pha.html, which is where most searches start. Its chips used to paste a
 * word into the box and wait to be pressed again — and one of them, "Spa & Massage", is a
 * category no salon or service is named after, so as a keyword it landed on an empty page.
 */

const heroHtml = fs.readFileSync(path.join(root, 'ui', 'kham-pha.html'), 'utf8');

function heroBox(options = {}) {
  const tail = heroHtml.slice(heroHtml.indexOf('function oakSearchBox()'));
  /* Stop at the next factory in the same script. */
  const script = tail.slice(0, tail.indexOf('\n    function oak', 1));
  const location = { href: '', search: '', pathname: '/kham-pha.html' };
  const toasts = [];
  const store = new Map(Object.entries(options.stored || {}));
  const context = {
    URLSearchParams,
    encodeURIComponent,
    location,
    /* A browser set to block site data throws outright on both, rather than answering null. */
    localStorage: options.hostile
      ? {
        getItem() { throw new Error('access denied'); },
        setItem() { throw new Error('access denied'); },
      }
      : {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => store.set(key, String(value)),
      },
    navigator: options.navigator || {},
    OAK: {
      api: async () => ({ chips: [] }),
      districts: async () => ['Quận 1'],
      toast: (message) => toasts.push(message),
      track: () => {},
    },
  };
  vm.runInNewContext(`${script}\nresult = oakSearchBox();`, context);
  return { state: context.result, location, store, toasts };
}

test('a suggestion chip goes straight to the results it stands for', () => {
  const { state } = heroBox();
  state.district = 'Quận 1';
  state.when = 'tomorrow';

  const category = new URLSearchParams(
    state.chipUrl({ label: 'Spa & Massage', type: 'category', key: 'spa' }).split('?')[1],
  );
  assert.equal(category.get('category'), 'spa');
  /* Whatever the pickers hold rides along: the chip narrows this search, not a new one. */
  assert.equal(category.get('district'), 'Quận 1');
  assert.ok(category.get('date'));

  const area = new URLSearchParams(
    state.chipUrl({ label: 'Quận 3', type: 'district', key: 'Quận 3' }).split('?')[1],
  );
  assert.equal(area.get('district'), 'Quận 3');
  assert.equal(area.has('category'), false);

  /* And it is a link, so it reads as one and can be opened in its own tab. */
  assert.match(heroHtml, /<a :href="chipUrl\(chip\)"[^>]*x-text="chip\.label"><\/a>/);
});

test('"today, open now" is one choice and sends both parameters', () => {
  const { state, location } = heroBox();
  state.when = 'today_open';

  state.submit();

  const params = new URLSearchParams(location.href.split('?')[1]);
  assert.equal(params.get('open_now'), '1');
  assert.equal(params.get('date'), isoAhead(0));
});

test('"near me" searches around the browser position, and searches anyway when refused', () => {
  const granted = heroBox({
    navigator: {
      geolocation: {
        getCurrentPosition: (ok) => ok({ coords: { latitude: 10.77, longitude: 106.7 } }),
      },
    },
  });
  granted.state.district = 'near';
  granted.state.submit();

  const params = new URLSearchParams(granted.location.href.split('?')[1]);
  assert.equal(params.get('lat'), '10.77');
  assert.equal(params.get('lng'), '106.7');
  assert.equal(params.get('radius_km'), '3');
  assert.equal(params.get('sort'), 'distance');
  /* "near" is not an area, so it never travels as one. */
  assert.equal(params.has('district'), false);

  const refused = heroBox({
    navigator: { geolocation: { getCurrentPosition: (ok, fail) => fail({ code: 1 }) } },
  });
  refused.state.district = 'near';
  refused.state.q = 'nail';
  refused.state.submit();

  assert.equal(refused.location.href, 'ket-qua-tim-kiem.html?q=nail');
  assert.equal(refused.toasts.length, 1);
});

test('a browser with no geolocation at all still searches', () => {
  const { state, location, toasts } = heroBox();
  state.district = 'near';
  state.submit();

  assert.equal(location.href, 'ket-qua-tim-kiem.html');
  assert.equal(toasts.length, 1);
});

test('the last five keywords are remembered, newest first and never twice', () => {
  const { state, store } = heroBox();
  for (const keyword of ['nail', 'tóc', 'spa', 'nail', 'massage', 'mi', 'da']) {
    state.q = keyword;
    state.submit();
  }

  assert.deepEqual(JSON.parse(store.get('oak_recent')), ['da', 'mi', 'massage', 'nail', 'spa']);
});

test('what was searched for last comes back on the next visit', async () => {
  const { state } = heroBox({ stored: { oak_recent: JSON.stringify(['nail', 'spa']) } });
  await state.init();

  assert.deepEqual(Array.from(state.recent), ['nail', 'spa']);
  assert.match(heroHtml, /x-show="recent\.length"/);
});

test('a browser that refuses storage searches all the same', async () => {
  const { state, location } = heroBox({ hostile: true });
  await state.init();
  assert.deepEqual(Array.from(state.recent), []);

  state.q = 'nail';
  assert.doesNotThrow(() => state.submit());
  assert.equal(location.href, 'ket-qua-tim-kiem.html?q=nail');
});
