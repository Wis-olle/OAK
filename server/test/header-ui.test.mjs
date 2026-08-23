/*
 * The customer top bar, which ui/assets/js/oak-header.js writes into every page from one
 * place. Driven rather than read wherever it can be: the file is one IIFE over a shell
 * element, so a bare object with an innerHTML is enough to make it run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(root, 'ui/assets/js/oak-header.js'), 'utf8');

/** The six account pages, in the order their own rail and mobile strip carry them. */
const ACCOUNT_PAGES = [
  'lich-hen-cua-toi.html',
  'yeu-thich.html',
  'danh-gia-cua-toi.html',
  'thong-bao.html',
  'ho-so-ca-nhan.html',
  'cai-dat.html',
];

/**
 * Run the header into a stand-in document and hand back what it wrote, plus whatever it
 * registered for DOMContentLoaded — the two things it does are one paint apart.
 */
function header(pathname, extras = {}) {
  const shell = extras.shell ?? { innerHTML: '', insertAdjacentHTML() {} };
  const listeners = [];
  const context = {
    location: { pathname },
    document: {
      querySelector: (selector) => (selector === '[data-oak-header]' ? shell : extras[selector] ?? null),
      querySelectorAll: (selector) => extras.all?.[selector] ?? [],
      addEventListener: (name, run) => listeners.push([name, run]),
      createElement: extras.createElement ?? (() => ({})),
      body: extras.body ?? null,
    },
    /* The bar re-measures itself when the window changes size, so there has to be one. */
    window: { addEventListener: (name, run) => listeners.push([name, run]) },
    ...extras.globals,
  };
  vm.runInNewContext(source, context);
  return {
    markup: shell.innerHTML,
    ready: () => listeners.filter(([name]) => name === 'DOMContentLoaded').forEach(([, run]) => run()),
    resize: () => listeners.filter(([name]) => name === 'resize').forEach(([, run]) => run()),
  };
}

/** A stand-in element: enough of one for the bar to be built out of them and measured. */
function element(tag) {
  return {
    tag,
    className: '',
    href: '',
    innerHTML: '',
    textContent: '',
    children: [],
    offsetHeight: 36,
    appendChild(child) {
      this.children.push(child);
    },
  };
}

/** The href of every entry of the menu, in the order they were written. */
function hrefs(markup) {
  return [...markup.matchAll(/href="([^"]+)"/g)].map((hit) => hit[1]);
}

test('the account block of the menu is in the same order as the account pages themselves', () => {
  const { markup } = header('/kham-pha.html');
  const opened = markup.slice(markup.indexOf('<div class="hidden" data-oak-auth="user">'));
  const block = opened.slice(0, opened.indexOf('</div>'));

  assert.deepEqual(hrefs(block), ACCOUNT_PAGES);
});

test('the menu offers a way to search from a page that has no search box', () => {
  const { markup } = header('/dich-vu-nail.html');

  assert.ok(markup.includes('href="ket-qua-tim-kiem.html?focus=q">Tìm salon, dịch vụ</a>'));
  /* Not marked as where the reader is — it is an instruction, not a place. */
  const search = markup.slice(markup.indexOf('ket-qua-tim-kiem.html?focus=q'));
  assert.ok(!search.slice(0, search.indexOf('</a>')).includes('aria-current'));
});

test('the results page itself is still the entry that is marked, not the search one', () => {
  const { markup } = header('/ket-qua-tim-kiem.html');
  const marked = [...markup.matchAll(/href="([^"]+)"[^>]*aria-current="page"/g)].map((hit) => hit[1]);

  assert.deepEqual(marked, ['ket-qua-tim-kiem.html']);
});

test('the account tab strip scrolls to the tab the reader is on, and only when it has to', () => {
  /* Read a field at a time: the options object is built in the header's own realm. */
  const scrolled = [];
  const strip = (name, scrollWidth) => ({
    scrollWidth,
    clientWidth: 360,
    querySelector: () => ({
      scrollIntoView: (options) => scrolled.push([name, options.inline, options.block]),
    }),
  });

  const { ready } = header('/cai-dat.html', {
    all: { '[data-oak-account-tabs]': [strip('overflowing', 900), strip('fitting', 320)] },
  });
  ready();

  /* One call: the strip that overflows. A strip that fits has nowhere to scroll to, and
     scrolling it would move the page under a reader who asked for nothing. */
  assert.deepEqual(scrolled, [['overflowing', 'center', 'nearest']]);
});

test('the assistant is offered under one name, and that name does not claim to be an AI', () => {
  const { markup } = header('/kham-pha.html');

  assert.ok(markup.includes('href="tim-kiem-thong-minh.html">Trợ lý tìm salon</a>'));
  /* A whole word, so the NAIL and HAIR category entries are left out of it. */
  assert.ok(!/\bAI\b/.test(markup), 'the bar still calls the assistant an AI somewhere');
});

/**
 * Drive the bar with an account whose next appointment is `booking`, and hand back the row
 * it appended to the header (if any) and the padding it gave back to the page.
 */
async function nextBookingBar(booking) {
  const shell = { innerHTML: '', insertAdjacentHTML() {}, children: [], appendChild(child) { this.children.push(child); } };
  const body = { style: {} };
  const asked = [];
  const OAK = {
    me: async () => ({ id: 1, role: 'customer' }),
    api: async (path) => {
      asked.push(path);
      return booking ? [booking] : [];
    },
  };

  const { ready, resize } = header('/kham-pha.html', {
    shell,
    body,
    createElement: element,
    globals: {
      /* <body> carries no padding of its own on any page; the bar is cleared by <main>. */
      getComputedStyle: () => ({ paddingTop: '0px' }),
      OAK,
    },
  });
  ready();
  /* The bar is two awaits deep — /api/auth/me, then the booking list. */
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  return { bar: shell.children[0] ?? null, body, asked, resize, OAK };
}

/* Tomorrow, read the way the bar reads it — from the browser's own clock, so the test
   cannot go stale on a fixed date. */
function inDays(days) {
  const day = new Date();
  day.setDate(day.getDate() + days);
  return day.toLocaleDateString('en-CA');
}

/* A function, not a constant: computed once at module load it went stale when the clock
   rolled past midnight mid-run, and "ngày mai" became "hôm nay" under the assertion. */
const tomorrow = () => ({
  date: inDays(1),
  time: '10:00',
  salon: { name: 'Lala Nail Studio' },
});

test("the bar says when and where the reader's next appointment is", async () => {
  const { bar, body, asked } = await nextBookingBar(tomorrow());

  assert.deepEqual(asked, ['/api/bookings/mine?status=upcoming&limit=1']);
  assert.equal(bar.href, 'lich-hen-cua-toi.html');
  /* One word per element: a sentence assembled around an hour and a salon name is in no
     dictionary, and each of these pieces is. */
  assert.deepEqual(bar.children.map((part) => part.textContent), [
    'Bạn có lịch',
    '10:00',
    'ngày mai',
    'tại',
    'Lala Nail Studio',
  ]);
  /* The header is fixed, so whatever the row takes is given back to the page — to <body>,
     so the account rail beside the reading column moves down with it. */
  assert.equal(body.style.paddingTop, '36px');
});

test('the page is measured again when the window changes size', async () => {
  const { bar, body, resize } = await nextBookingBar(tomorrow());

  assert.equal(body.style.paddingTop, '36px');
  /* A narrower viewport wraps the row onto a second line: the padding written at the width
     it was first measured at would leave that line under the bar. */
  bar.offsetHeight = 72;
  resize();

  assert.equal(body.style.paddingTop, '72px');
});

/* kham-pha.html shows the same appointment in its "Lịch kế tiếp" band, and reads it through
   this. GET /api/bookings/mine also closes out yesterday's appointments, so two copies of
   the request on one page would put two of those sweeps in flight at once. */
test('the next appointment is read once, however many places show it', async () => {
  const { asked, OAK } = await nextBookingBar(tomorrow());

  assert.deepEqual(asked, ['/api/bookings/mine?status=upcoming&limit=1']);
  assert.equal((await OAK.nextBooking()).salon.name, 'Lala Nail Studio');
  assert.deepEqual(asked, ['/api/bookings/mine?status=upcoming&limit=1']);
});

test('an appointment further off than tomorrow is not worth a bar', async () => {
  const { bar } = await nextBookingBar({ ...tomorrow(), date: inDays(4) });

  assert.equal(bar, null);
});

test('a reader with no appointment at all gets no bar', async () => {
  const { bar } = await nextBookingBar(null);

  assert.equal(bar, null);
});

test('nothing is asked of the server for a visitor who is not signed in', async () => {
  const shell = { innerHTML: '', insertAdjacentHTML() {}, children: [], appendChild() {} };
  const asked = [];
  const { ready } = header('/kham-pha.html', {
    shell,
    globals: { OAK: { me: async () => null, api: async (path) => asked.push(path) } },
  });
  ready();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(asked, []);
});

/* The scroll runs once at DOMContentLoaded, so it only ever reaches a strip that is in the
   page's own static markup — not one Alpine builds later from <template x-if="user">. This
   test proves the attribute is on all six pages, NOT that the scroll fires on all six:
   ho-so-ca-nhan.html and cai-dat.html still hold theirs inside that template, and the scroll
   is inert there until item 12's page work lifts the strip out of it. */
test('every account page carries the strip the scroll looks for', () => {
  for (const name of ACCOUNT_PAGES) {
    const html = fs.readFileSync(path.join(root, 'ui', name), 'utf8');
    assert.match(html, /data-oak-account-tabs/, name + ' has no account tab strip');
  }
});
