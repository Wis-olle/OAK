/* The accessibility work of phase 4, item 5, and the live region of item 3.
 *
 * Four things a reader can lose without anything else noticing:
 *   - a live region added at the same moment as the text it should read (several screen
 *     readers drop that announcement entirely);
 *   - focus scrolled under the fixed top bar or the pinned booking bar;
 *   - a dialog that leaves the page behind it in the tab order;
 *   - motion, and a half-written paragraph, for a reader who asked for neither.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { readRepo as read } from './lib/read-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const apiJs = read('ui/assets/js/oak-api.js');
const headerJs = read('ui/assets/js/oak-header.js');
const utilsCss = read('ui/assets/css/oak-utils.css');

/* The tokens, read the way tools/tailwind/tailwind.build.config.js reads them. */
const tokenContext = { tailwind: {} };
vm.runInNewContext(read('ui/assets/js/oak-tailwind-config.js'), tokenContext);
const COLORS = tokenContext.tailwind.config.theme.extend.colors;

/** The source between two declarations, so the tests drive the shipped functions. */
function between(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from !== -1, `the source no longer contains ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to !== -1, `${start} is no longer followed by ${end}`);
  return source.slice(from, to);
}

/* ---------------------------------------------------------------- a tiny DOM ---------- */

function fakeDom() {
  const body = node('body');
  function node(tag) {
    return {
      tag,
      id: '',
      attributes: {},
      className: '',
      textContent: '',
      children: [],
      parent: null,
      classList: {
        added: [],
        add(name) { this.added.push(name); },
        remove(name) { this.added = this.added.filter((entry) => entry !== name); },
      },
      setAttribute(name, value) { this.attributes[name] = value; },
      appendChild(child) { this.children.push(child); child.parent = this; },
      addEventListener() {},
      focus() { document.activeElement = this; },
      remove() {
        const siblings = this.parent ? this.parent.children : [];
        siblings.splice(siblings.indexOf(this), 1);
        this.parent = null;
      },
    };
  }
  const document = {
    body,
    activeElement: null,
    createElement: (tag) => node(tag),
    querySelector: () => null,
    getElementById: (id) => body.children.find((child) => child.id === id) || null,
    contains: () => true,
  };
  return { document, body };
}

/** TOAST_COLORS, liveRegions() and toast(), lifted out of the oak-api.js IIFE. */
function messages() {
  const script = between(apiJs, 'var TOAST_COLORS = {', '  // Where signing out lands.');
  const { document, body } = fakeDom();
  const context = {
    document,
    setTimeout: () => 1,
    clearTimeout: () => {},
    Date,
    Math,
    String,
    Boolean,
  };
  vm.runInNewContext(`${script}
liveRegionsFn = liveRegions; toastFn = toast; colours = TOAST_COLORS;`, context);
  return {
    liveRegions: context.liveRegionsFn,
    toast: context.toastFn,
    colours: context.colours,
    body,
  };
}

test('the regions a message is read from are in the page before any message is', () => {
  const page = messages();
  assert.deepEqual(page.body.children, [], 'nothing is in the page yet');

  const regions = page.liveRegions();
  assert.deepEqual(page.body.children.map((child) => child.id),
    ['oak-live-status', 'oak-live-alert']);
  // One per urgency, rather than one region whose role is flipped under a reader already
  // subscribed to it.
  assert.equal(regions.status.attributes.role, 'status');
  assert.equal(regions.status.attributes['aria-live'], 'polite');
  assert.equal(regions.alert.attributes.role, 'alert');
  assert.equal(regions.alert.attributes['aria-live'], 'assertive');

  // Asking twice does not make a second pair — the customer header asks at parse time and
  // initHeader() asks again on a page that has no such header.
  page.liveRegions();
  assert.equal(page.body.children.length, 2);
});

test('a message changes the contents of a region that was already there', () => {
  const page = messages();
  const regions = page.liveRegions();

  page.toast('Đã lưu.');
  assert.equal(regions.status.children.length, 1);
  assert.equal(regions.status.children[0].textContent, 'Đã lưu.');
  // The pill itself carries no role: the region it went into is what says how urgent it is.
  assert.equal(regions.status.children[0].attributes.role, undefined);
  assert.equal(regions.alert.children.length, 0);
  // And nothing new was hung off <body> beside the two regions.
  assert.equal(page.body.children.length, 2);
});

test('a reminder is neither a success nor a failure', () => {
  const { colours } = messages();
  // "Đã tải ảnh lên, nhớ bấm Lưu thay đổi." is a job half done, and read as "Đã lưu" in the
  // same black. #703800 on #fda055 is 4.52:1, past AA for body text.
  assert.equal(colours.info, 'bg-secondary-container text-on-secondary-container');
  assert.ok(read('ui/cai-dat-salon.html')
    .includes("OAK.toast('Đã tải ảnh lên, nhớ bấm Lưu thay đổi.', 'info')"));
});

test('both files that own a top bar put the regions in before page code runs', () => {
  // The customer bar, written at parse time…
  assert.match(headerJs, /OAK\.liveRegions\(\)/);
  // …and every page, including the partner console, which carries no such file.
  assert.match(between(apiJs, 'async function initHeader()', 'var user = await me();'),
    /liveRegions\(\);/);
});

/* ---------------------------------------------------------------- focus and motion ----- */

test('the hero search kills the focus ring, so it has to paint a substitute', () => {
  const hero = read('ui/kham-pha.html');

  // The reset that takes the plugin's ring away. Whatever replaces it has to be found below,
  // or the three segments of the bar are focusable with nothing to show for it.
  assert.match(hero, /input\.oak-search-field:focus, select\.oak-search-field:focus \{\s*outline: none;/);

  // The substitute: a tint on the segment holding the caret. Keyed off :focus and not
  // :focus-visible on purpose — Chromium matches :focus-visible on a text field for a mouse
  // press too, so the near-black outline this replaced was drawn on a plain click.
  assert.doesNotMatch(hero, /oak-search-field:focus-visible/,
    'the outline that a mouse press used to draw is back');
  // Two rules, not one selector list: a list is all-or-nothing, so pairing the plain-field
  // half with the :has() half would take the fallback down wherever :has() cannot be parsed.
  assert.doesNotMatch(hero, /:has\(> \.oak-search-field:focus\),/,
    'the :has() branch shares a selector list again, so the fallback dies with it');

  // surface-container, the token, rather than a colour typed in by hand: light enough to
  // read as a tint on the white pill and dark enough to be seen against it.
  assert.equal(COLORS['surface-container'], '#ffebd3');
  // Not between(): the same selector opens the reset block higher up, so the rule is pinned
  // by its own body instead. [^}]* cannot cross into the next rule.
  assert.match(hero,
    /input\.oak-search-field:focus, select\.oak-search-field:focus \{[^}]*background-color: #ffebd3;/);

  // The strip, not just the field, so the icon beside it is tinted as one segment.
  assert.match(hero,
    /\.oak-search-bar > div:has\(> \.oak-search-field:focus\) \{[^}]*background-color: #ffebd3;[^}]*border-radius: 9999px;/);

  // And the bar as a whole still answers, which is what says "this search box has focus"
  // when the tint alone says only which of the three segments holds the caret.
  assert.match(hero, /\.oak-search-bar:focus-within \{ border-color: #171818; \}/);
});

test('the scroll port keeps clear of the bars pinned over it', () => {
  // 80px of fixed header plus a margin. On the root element: scroll-padding is not one of
  // the properties that propagate from <body> to the viewport.
  assert.match(utilsCss, /^html \{\n {4}scroll-padding-top: 6rem;\n\}/m);
  // And the same for the four pages that pin a booking bar to the bottom edge, keyed off
  // the attribute the toast already looks for — but only at the widths the bar is drawn
  // at. The marker element stays in the DOM at a desktop width with display:none on it, so
  // an unscoped rule would push every anchor and every focused field 5rem up for nothing.
  assert.match(utilsCss,
    /@media \(max-width: 767px\) \{\n {4}html:has\(\[data-oak-sticky-cta\]:not\(\[style\*="display: none"\]\)\) \{\n {8}scroll-padding-bottom: 5rem;/);
  // The wizard keeps its bar one breakpoint further out than the other three, and asks for
  // the padding over that range on its own.
  assert.match(utilsCss,
    /@media \(min-width: 768px\) and \(max-width: 1023px\) \{\n {4}html:has\(\[data-oak-sticky-cta\]\.lg\\:hidden:not\(\[style\*="display: none"\]\)\)/);
  // …and inside those widths the wizard's own bar is itself conditional: it appears from
  // step 2, and x-show hides it by writing display:none inline, which the same :not() reads.
  assert.match(read('ui/dat-lich.html'),
    /data-oak-sticky-cta x-cloak="" x-show="service &amp;&amp; step > 1 &amp;&amp; !rescheduleClosed"/);
  const pinned = fs.readdirSync(path.join(root, 'ui'))
    .filter((name) => name.endsWith('.html') && read(`ui/${name}`).includes('data-oak-sticky-cta'));
  assert.ok(pinned.length >= 4, `only ${pinned.length} pages pin a booking bar`);
});

test('a reader who asked for less motion gets it site-wide', () => {
  const block = between(utilsCss, '@media (prefers-reduced-motion: reduce)', '\n}\n');
  assert.match(block, /animation-duration: 0\.01ms !important/);
  assert.match(block, /transition-duration: 0\.01ms !important/);
  assert.match(block, /scroll-behavior: auto !important/);
  // A skeleton frozen at full opacity reads as content that finished arriving.
  assert.match(block, /\.animate-pulse \{\n {8}animation: none !important;\n {8}opacity: 0\.7;/);
  assert.match(block, /\.img-hover-zoom:hover img,/);
  // The press and hover scales are written inline on around ninety elements. A zeroed
  // duration only makes their movement instant — a jump rather than no motion.
  assert.match(block, /\[class\*="active:scale"\]:active,/);
  assert.match(block, /\.group:hover \[class\*="group-hover:scale"\] \{\n {8}transform: none !important;/);
});

test('every glide into view asks first, because CSS cannot answer for these', () => {
  // An explicit `behavior` option beats the scroll-behavior property, so the rule above
  // cannot reach these four; they go through one helper instead of four media queries.
  assert.match(between(apiJs, 'function scrollBehavior()', '\n  }'),
    /prefers-reduced-motion: reduce.*\n.*'auto'/);
  const callers = ['ui/dat-lich.html', 'ui/danh-gia-cua-toi.html'];
  for (const page of callers) {
    const html = read(page);
    assert.doesNotMatch(html, /behavior: 'smooth'/, `${page} still glides unconditionally`);
    assert.match(html, /behavior: OAK\.scrollBehavior\(\)/);
  }
});

test('one press animation, so a converted button does not feel dead beside the rest', () => {
  const odd = fs.readdirSync(path.join(root, 'ui'))
    .filter((name) => name.endsWith('.html') && read(`ui/${name}`).includes('active:scale-[0.98]'));
  assert.deepEqual(odd, []);
});

/* ---------------------------------------------------------------- the two dialogs ------ */

/* Each of these is a dialog that used to leave the page behind it in the tab order: Tab
   walked out of the viewer into the gallery under it. quan-ly-lich-hen.html had already
   solved it with :inert on the landmarks, and these two now follow that. */
const DIALOGS = [
  { page: 'ui/salon-profile.html', flag: 'lightbox', component: 'oakSalonProfile()', guard: 'salon' },
  { page: 'ui/ho-so-chuyen-gia.html', flag: 'lightbox', component: 'oakStaffProfile()', guard: 'staff' },
];

test('an open dialog takes the whole page behind it out of the tab order', () => {
  for (const dialog of DIALOGS) {
    const html = read(dialog.page);
    // `|| null` rather than the bare flag: `inert` is not in Alpine's boolean-attribute
    // list, so `false` would be written out as inert="false" — still present, still inert.
    const inert = ` :inert="${dialog.flag} || null"`;
    for (const landmark of ['<header ', '<main ', '<footer ']) {
      const at = html.indexOf(landmark);
      assert.ok(at !== -1, `${dialog.page} has no ${landmark.trim()}>`);
      const tag = html.slice(at, html.indexOf('>', at) + 1);
      assert.ok(tag.includes(inert), `${dialog.page}: ${landmark.trim()}> is never made inert`);
    }
    // Which is only possible because the component moved up to <body> and the dialog moved
    // out of <main> — inert on <main> would otherwise take the dialog with it.
    assert.match(html, new RegExp(`<body [^>]*x-data="${dialog.component.replace('()', '\\(\\)')}"`));
    const after = html.slice(html.indexOf('</main>'));
    const at = after.indexOf(`x-show="${dialog.flag}"`);
    assert.ok(at !== -1, `${dialog.page}: the dialog is still inside <main>`);
    // Coming out of <main> took the two photo viewers out of the `x-if` that had been
    // guarding them, and every binding in them reads the record the page is still loading:
    // `x-show` defers nothing, so they ran against null on each load and threw. The guard
    // comes with them.
    if (dialog.guard) {
      const guard = after.indexOf(`<template x-if="${dialog.guard}">`);
      assert.ok(guard !== -1 && guard < at,
        `${dialog.page}: the dialog reads ${dialog.guard} before the page has one`);
      const rest = after.slice(at);
      assert.ok(rest.indexOf('</template>') < rest.indexOf('<footer'),
        `${dialog.page}: the guard swallows the footer`);
    }
  }
});

test('the way out of the top bar is not the way out of an open dialog', () => {
  // The skip link is injected ahead of <header>, so it is the one focusable thing left
  // outside the three landmarks a dialog makes inert — and it points at <main>, inert at
  // that moment, so Tab would reach a link that moves focus nowhere.
  assert.match(headerJs, /data-oak-skip href="#main"/);
  assert.match(utilsCss, /body\.overflow-hidden \[data-oak-skip\] \{\n {4}display: none;/);
  /* The partner console does not take the injected bar, so its pages write the same link by
     hand — and the rule above reaches an attribute, not a class, so it passes them by unless
     each one carries it. The count is part of adding a console page, not a sign of trouble. */
  const handWritten = fs.readdirSync(path.join(root, 'ui'))
    .filter((name) => name.endsWith('.html'))
    .filter((name) => read(`ui/${name}`).includes('href="#main">Bỏ qua đến nội dung</a>'));
  assert.equal(handWritten.length, 6, 'a page stopped writing its own skip link, or a new one started');
  for (const page of handWritten) {
    assert.match(read(`ui/${page}`), /data-oak-skip href="#main">Bỏ qua đến nội dung<\/a>/, page);
  }
  // Which is only a complete answer while both dialogs lock the page's scroll that way.
  for (const dialog of DIALOGS) {
    assert.match(read(dialog.page), /document\.body\.classList\.add\('overflow-hidden'\)/, dialog.page);
  }
});

test('opening a dialog moves the caret inside it and stops the page scrolling under it', () => {
  // The two photo viewers land the caret on their own close button.
  for (const page of ['ui/salon-profile.html', 'ui/ho-so-chuyen-gia.html']) {
    const html = read(page);
    assert.match(html, /x-ref="lightboxClose"/);
    assert.match(html, /this\.\$refs\.lightboxClose && this\.\$refs\.lightboxClose\.focus\(\)/);
    assert.match(html, /document\.body\.classList\.add\('overflow-hidden'\)/);
    // Escape and the scrim run the same teardown as the button, rather than flipping the
    // flag and leaving the page locked.
    assert.doesNotMatch(html, /="lightbox = false"/);
    // Guarded like the two arrow handlers beside it: a window-level listener sees every
    // Escape on the page, and an unguarded one would run the teardown — the scroll lock
    // included — with no viewer open.
    assert.match(html, /@keydown\.escape\.window="lightbox &amp;&amp; closeLightbox\(\)"/);
  }
});

test('the same wait guards the two photo viewers and the console sheet', () => {
  // Their components live in the pages, so the pairing is read where it is written: the
  // flag drops, then the restore waits a tick before touching the opener.
  for (const page of ['ui/salon-profile.html', 'ui/ho-so-chuyen-gia.html']) {
    const close = between(read(page), 'closeLightbox() {', '\n            },');
    assert.match(close, /this\.lightbox = false;[\s\S]*this\.\$nextTick\(\(\) => \{[\s\S]*opener\.focus\(\)/,
      `${page}: the caret is handed back before inert is lifted`);
  }
  // quan-ly-lich-hen.html is the page the three copied the :inert pattern from, and it
  // carried the same synchronous restore.
  const detail = between(read('ui/quan-ly-lich-hen.html'), 'closeDetail() {', '\n            },');
  assert.match(detail, /this\.detail = null;[\s\S]*this\.\$nextTick\([\s\S]*opener\.focus\(\)/);
});

/* ---------------------------------------------------------------- the language switch -- */

test('the one page still holding a half-written field stashes it on the switch', () => {
  // The contact fields and note of the booking wizard, through the stash the login round
  // trip already used, which restoreForm() reads in init().
  const wizard = read('ui/dat-lich.html');
  assert.match(wizard,
    /oak:lang-change[\s\S]{0,240}sessionStorage\.setItem\(OAK_BOOKING_FORM_KEY/);
});
