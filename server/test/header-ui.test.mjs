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

/* The four pages a technician's own account is. The first three in the order her rail on
   lich-cua-toi.html carries them; Cài đặt is on no rail and is last here, as it is for the
   customer. A free-standing list, not one read off the rail — server/test/staff-persona.test.mjs
   is what holds the rail itself to its order. */
const STAFF_PAGES = [
  'lich-cua-toi.html',
  'ho-so-nhan-vien.html',
  'thong-bao.html',
  'cai-dat.html',
];

/** The href of every entry of the menu, in the order they were written. */
function hrefs(markup) {
  return [...markup.matchAll(/href="([^"]+)"/g)].map((hit) => hit[1]);
}

/** The group of the menu a piece of it sits in: the last persona opened above that point. */
function groupAt(markup, index) {
  const opened = [...markup.slice(0, index).matchAll(/data-oak-auth="([a-z]+)"/g)];
  return opened.length ? opened[opened.length - 1][1] : null;
}

/** One persona's group, which is flat and so ends at the first close after it. */
function groupOf(markup, persona) {
  const from = markup.indexOf(`<div class="hidden" data-oak-auth="${persona}">`);
  assert.notEqual(from, -1, `the menu carries no ${persona} group`);
  const opened = markup.slice(from);
  return opened.slice(0, opened.indexOf('</div>'));
}

test('the account block of the menu is in the same order as the account pages themselves', () => {
  const { markup } = header('/kham-pha.html');
  const opened = markup.slice(markup.indexOf('<div class="hidden" data-oak-auth="user">'));
  const block = opened.slice(0, opened.indexOf('</div>'));

  assert.deepEqual(hrefs(block), ACCOUNT_PAGES);
});

/* A technician meets this bar everywhere outside the console — on kham-pha.html, on a salon
   profile, on the blog — and until she had a group of her own she met the customer's six
   pages there, not one of which is hers. */
test("the technician block of the menu is in the same order as her own pages", () => {
  const { markup } = header('/kham-pha.html');

  assert.deepEqual(hrefs(groupOf(markup, 'staff')), STAFF_PAGES);
});

test('the technician block says whose account it is, in the same voice as the categories', () => {
  const { markup } = header('/kham-pha.html');

  /* Nothing else on the bar names the kind of account signed in, and a menu that offers
     "Lịch của tôi" without saying whose leaves a reader guessing which site they are on.
     The same caption the service list is led by, so the two read as one menu. */
  const caption = /<p class="px-5 pt-3 pb-1 font-caption text-caption uppercase tracking-widest text-on-surface-variant">([^<]+)<\/p>/g;
  assert.deepEqual([...markup.matchAll(caption)].map((hit) => hit[1]), ['Kỹ thuật viên', 'Dịch vụ']);
  assert.match(groupOf(markup, 'staff'), /^<div class="hidden" data-oak-auth="staff"><p /);
});

test('both notification rows name themselves the way oak-api.js looks for them', () => {
  const { markup } = header('/kham-pha.html');

  /* oak-api.js finds the bell by this name and hangs the unread mark where data-oak-dot
     says — across a full-width entry a corner lands nowhere near the words. The row is the
     same row in both menus, so it carries the same pair in both. */
  const rows = [...markup.matchAll(/<a[^>]*aria-label="Thông báo" data-oak-dot="([^"]+)"/g)];
  assert.deepEqual(
    rows.map((hit) => [groupAt(markup, hit.index), hit[1]]),
    [
      ['user', 'absolute right-4 top-1/2 -translate-y-1/2'],
      ['staff', 'absolute right-4 top-1/2 -translate-y-1/2'],
    ],
  );
});

test('each account signs out through the door it came in by', () => {
  const { markup } = header('/kham-pha.html');

  /* OAK.logout() reads its destination off the link that was pressed, so these two hrefs
     are the whole of the difference: a customer is put back on the site they were browsing,
     a technician on the staff sign-in page rather than a shop front she has no account for. */
  const out = [...markup.matchAll(/data-oak-logout href="([^"]+)"/g)];
  assert.deepEqual(
    out.map((hit) => [groupAt(markup, hit.index), hit[1]]),
    [['user', 'kham-pha.html'], ['staff', 'dang-nhap-nhan-vien.html']],
  );
});

test('the technician entries end the menu rather than parting the customer one', () => {
  const { markup } = header('/kham-pha.html');

  /* Both sign-outs sit after the categories, so whichever persona is reading finds it in
     the last place it has always been. The order was the thing at risk here: a group added
     anywhere else moves the customer's own sign-out up into the middle of the menu. */
  const where = (needle) => markup.indexOf(needle);
  assert.ok(where('data-oak-auth="staff"') > where('data-oak-auth="user"'));
  assert.ok(where('>Dịch vụ<') < where('href="kham-pha.html">Đăng xuất<'));
  assert.ok(
    where('href="kham-pha.html">Đăng xuất<') < where('href="dang-nhap-nhan-vien.html">Đăng xuất<'),
  );
});

/** Every entry marked as where the reader is, in the order they were written. */
function marked(markup) {
  return [...markup.matchAll(/href="([^"]+)"[^>]*aria-current="page"/g)].map((hit) => hit[1]);
}

/**
 * The menu as one persona actually meets it: every other persona's group taken out, so what
 * is left is what that reader can reach. Depth-counted rather than sliced to the first
 * close, because the two sign-out groups each wrap a rule of their own.
 */
function reading(markup, persona) {
  var out = markup;
  for (;;) {
    const group = /<div(?: class="hidden")? data-oak-auth="([a-z]+)">/.exec(out);
    if (!group) {
      return out;
    }
    let at = group.index + group[0].length;
    for (let depth = 1; depth > 0; ) {
      const open = out.indexOf('<div', at);
      const close = out.indexOf('</div>', at);
      assert.notEqual(close, -1, 'a group of the menu is never closed');
      if (open !== -1 && open < close) {
        depth += 1;
        at = open + '<div'.length;
      } else {
        depth -= 1;
        at = close + '</div>'.length;
      }
    }
    /* Unwrapped rather than kept, so the next turn of the loop finds the next group. */
    const body = group[1] === persona ? out.slice(group.index + group[0].length, at - '</div>'.length) : '';
    out = out.slice(0, group.index) + body + out.slice(at);
  }
}

test('exactly one entry the reader can reach is marked as the page they are on', () => {
  /* thong-bao.html and cai-dat.html are each written twice now, once per account group, so
     the raw markup does stamp two anchors on those two pages. Only one group is ever on
     screen, so the invariant is one mark per reading — and the mark has to be there in both
     readings, because either persona can be the one standing on the page. Driven on an
     account page and not only on uu-dai.html: a page in no account group at all cannot see
     a duplicate, which is why the old reading of this test would have passed through one. */
  for (const page of ['uu-dai.html', 'cai-dat.html', 'thong-bao.html']) {
    const { markup } = header('/' + page);
    for (const persona of ['user', 'staff']) {
      assert.deepEqual(marked(reading(markup, persona)), [page], `${page} read as ${persona}`);
    }
  }
});

test('Blog is a menu entry rather than a bar entry, and an article still marks it', () => {
  const { markup } = header('/blog-chi-tiet.html');

  /* One of them, inside the panel: the bar gave its place up to the language. */
  assert.deepEqual(hrefs(markup).filter((href) => href === 'blog.html'), ['blog.html']);
  assert.ok(markup.indexOf('href="blog.html"') > markup.indexOf('id="oak-menu"'));
  assert.match(markup, /href="blog\.html" aria-current="page"/);
});

test('the language is on the bar at every width, and says which one is in force', () => {
  const { markup } = header('/kham-pha.html');

  /* No md: gate on it — folded into the menu it would be hardest to reach on the phone
     where a reader is most likely to want the other language. */
  const trigger = markup.slice(markup.indexOf('aria-controls="oak-lang-menu"'));
  assert.ok(!trigger.slice(0, trigger.indexOf('>')).includes('md:'));
  /* The slot oak-i18n.js writes its two named options into, marked for that shape. */
  assert.match(markup, /id="oak-lang-menu" data-oak-lang="menu"/);
  /* Read with no storage to read from at all, the way a sandboxed frame leaves it. The
     name says the language too: an aria-label is announced instead of the "VI", not
     alongside it, so a bare "Ngôn ngữ" would leave the answer unsaid. */
  assert.match(markup, /aria-label="Ngôn ngữ: Tiếng Việt"/);
  assert.match(markup, /data-icon="language">language<\/span>VI<\/button>/);

  const asked = header('/kham-pha.html', { globals: { localStorage: { getItem: () => 'en' } } });
  assert.match(asked.markup, /aria-label="Ngôn ngữ: English"/);
  assert.match(asked.markup, /data-icon="language">language<\/span>EN<\/button>/);
});

test('opening either dropdown of the bar shuts the other', () => {
  const { markup } = header('/kham-pha.html');

  /* One scope over the pair. Each trigger stops its own click, and a stopped click never
     reaches the other's @click.outside, so nothing but these two assignments closes what
     the reader is not looking at — and both panels standing open puts the menu over the
     language options, where a tap on "English" lands on the link behind it. */
  assert.match(markup, /<nav [^>]*x-data="\{ langOpen: false, menuOpen: false \}"/);
  assert.equal(markup.match(/x-data=/g).length, 1);
  assert.match(markup, /@click\.stop="langOpen = !langOpen; menuOpen = false"/);
  assert.match(markup, /@click\.stop="menuOpen = !menuOpen; langOpen = false"/);
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
