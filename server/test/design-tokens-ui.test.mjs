/*
 * The design system, pinned where it is now single: one radius scale with a real pill at the
 * top, one booking-status vocabulary, one button grammar, one dialog shell, one star, one
 * field — and colour pairs that clear WCAG rather than merely looking calm.
 *
 * The contrast numbers here are computed from ui/assets/js/oak-tailwind-config.js with the
 * WCAG 2.x relative-luminance formula, not copied from a report: a token nudged for looks
 * fails the test that says what it is for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { bookingStatus, BOOKING_STATUSES } from './booking-status.mjs';
import { readUi } from './lib/read-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pages = fs.readdirSync(path.join(root, 'ui')).filter((name) => name.endsWith('.html'));

const utils = readUi('assets/css/oak-utils.css');
const client = readUi('assets/js/oak-api.js');

/* The tokens, read the way tools/tailwind/tailwind.build.config.js reads them. */
const tokenContext = { tailwind: {} };
vm.runInNewContext(
  readUi('assets/js/oak-tailwind-config.js'),
  tokenContext,
);
const TOKENS = tokenContext.tailwind.config.theme.extend;
const COLORS = TOKENS.colors;

// ------------------------------------------------------------------ contrast

const channel = (value) => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG 2.x relative luminance of a '#rrggbb' string. */
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The contrast ratio between two '#rrggbb' strings. */
function ratioHex(foreground, background) {
  const [hi, lo] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/** The contrast ratio between two tokens, by token name. */
function ratio(foreground, background) {
  const fg = COLORS[foreground];
  const bg = COLORS[background];
  assert.ok(fg, 'no token ' + foreground);
  assert.ok(bg, 'no token ' + background);
  return ratioHex(fg, bg);
}

/** A token at `/NN`, composited on what is behind it — what the eye actually gets. */
function blend(foreground, alpha, background) {
  const fg = COLORS[foreground];
  const bg = COLORS[background];
  assert.ok(fg, 'no token ' + foreground);
  assert.ok(bg, 'no token ' + background);
  const mix = [1, 3, 5].map((i) => {
    const f = parseInt(fg.slice(i, i + 2), 16);
    const b = parseInt(bg.slice(i, i + 2), 16);
    return Math.round((f * alpha) / 100 + (b * (100 - alpha)) / 100);
  });
  return '#' + mix.map((v) => v.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------------ the radius scale

test('rounded-full is a pill, so nothing has to spell 9999px out by hand', () => {
  assert.equal(TOKENS.borderRadius.full, '9999px');
  // The avatar, the stepper ring, the FAB and every chip ride on this one utility; two pages
  // had already given up on it and written the value inline.
  for (const name of pages) {
    assert.doesNotMatch(readUi(name), /rounded-\[9999px\]/, name);
  }
  const css = readUi('assets/css/oak-tailwind.css');
  assert.ok(css.includes('.rounded-full{border-radius:9999px}'), 'the built CSS is stale');
});

// ------------------------------------------------------------------ one status vocabulary

test('one booking has one label, one glyph and one chip tone, wherever it is drawn', () => {
  // Spread first: the table is evaluated in its own vm realm, so its Array is not ours.
  assert.deepEqual([...BOOKING_STATUSES], ['pending', 'confirmed', 'completed', 'cancelled', 'no_show']);
  assert.equal(bookingStatus('pending').label, 'Chờ xác nhận');
  assert.equal(bookingStatus('confirmed').label, 'Đã xác nhận');
  assert.equal(bookingStatus('completed').label, 'Đã hoàn thành');
  assert.equal(bookingStatus('cancelled').label, 'Đã hủy');
  assert.equal(bookingStatus('no_show').label, 'Không đến');
  assert.deepEqual(
    [...BOOKING_STATUSES].map((status) => bookingStatus(status).icon),
    ['schedule', 'check_circle', 'task_alt', 'cancel', 'person_off'],
  );
  // Absent is not cancelled: two terminal states that must never be painted alike.
  assert.notEqual(bookingStatus('no_show').class, bookingStatus('cancelled').class);
  // A status this build has not been taught still renders, in the neutral tone.
  const unknown = bookingStatus('nonsense');
  assert.equal(unknown.label, 'nonsense');
  assert.equal(unknown.icon, 'event');
  assert.ok(unknown.class);
});

test('every page that paints a status reads it from oak-api.js', () => {
  for (const name of [
    'lich-hen-cua-toi.html',
    'tong-quan-doi-tac.html',
    'quan-ly-lich-hen.html',
    'xac-nhan-dat-lich.html',
  ]) {
    assert.match(readUi(name), /OAK\.bookingStatus\(/, name);
  }
  // …and none of them keeps a private copy of the table any more.
  for (const name of pages) {
    const html = readUi(name);
    assert.doesNotMatch(html, /OAK_STATUS_LABELS|OAK_STATUS_ICONS|OAK_STATUS_CLASSES/, name);
    assert.doesNotMatch(html, /OAK_BOOKING_STATUS(_CLASS)? = \{/, name);
  }
});

test('each status chip is readable: its text clears 4.5:1 on its own background', () => {
  for (const status of BOOKING_STATUSES) {
    const [background, foreground] = bookingStatus(status).class.split(' ');
    const measured = ratio(foreground.replace(/^text-/, ''), background.replace(/^bg-/, ''));
    assert.ok(measured >= 4.5, `${status}: ${measured.toFixed(2)}:1`);
  }
});

test('the confirmed chip is a token pair, not a hex a designer typed once', () => {
  assert.equal(COLORS.success, '#2e7d32');
  assert.equal(COLORS['success-container'], '#e8f5e9');
  assert.equal(bookingStatus('confirmed').class, 'bg-success-container text-success');
  // The partner console was the only place naming this pair by hand — the confirmed chip,
  // the checklist ticks, the busy dot. (The two hero tints elsewhere are not this item.)
  for (const name of pages) {
    assert.doesNotMatch(readUi(name), /\[#(2e7d32|e8f5e9|d32f2f)\]/i, name);
  }
});

// ------------------------------------------------------------------ contrast tokens

test('the caption colour that replaced text-outline is readable at 12px', () => {
  // 'Mã đặt chỗ', 'Thời gian', 'Cập nhật lần cuối': 12px text, so SC 1.4.3 asks 4.5:1.
  assert.ok(ratio('on-surface-variant', 'surface') >= 4.5);
  assert.ok(ratio('on-surface-variant', 'surface-container-low') >= 4.5);
  assert.ok(ratio('on-surface-variant', 'surface-container-highest') >= 4.5);
  for (const name of pages) {
    assert.doesNotMatch(readUi(name), /text-outline(?![-\w])/, name);
  }
});

test('a control boundary clears the 3:1 of SC 1.4.11 on every surface it sits on', () => {
  assert.equal(COLORS.outline, '#5e6262');
  for (const surface of [
    'surface',
    'surface-container-lowest',
    'surface-container-low',
    'surface-container',
    'surface-container-high',
    'surface-container-highest',
  ]) {
    const measured = ratio('outline', surface);
    assert.ok(measured >= 3, `outline on ${surface}: ${measured.toFixed(2)}:1`);
  }
});

test('no input, select or textarea draws its border with the divider token', () => {
  // outline-variant is a hairline for dividers and card edges; at 2.58:1 on the cream
  // surface it is not a control boundary, however dark it got.
  assert.equal(COLORS['outline-variant'], '#9a9e9e');
  for (const name of pages) {
    for (const tag of readUi(name).match(/<(input|select|textarea)\b[^>]*>/g) || []) {
      assert.doesNotMatch(tag, /border-outline-variant/, `${name}: ${tag.slice(0, 90)}`);
    }
  }
});

test('a control border written at partial opacity is measured, not assumed', () => {
  // `border-token/NN` is not the token: it is that colour composited on whatever sits
  // behind it, which is why the sweep that darkened `outline` could not reach the promo
  // field on the near-black cost panel. Every such control is declared here with its
  // backdrop, and the blend is computed.
  const BLENDED = [{ page: 'dat-lich.html', token: 'on-tertiary', alpha: 50, behind: 'tertiary' }];
  for (const name of pages) {
    for (const tag of readUi(name).match(/<(input|select|textarea)\b[^>]*>/g) || []) {
      for (const match of tag.matchAll(/border-([a-z-]+)\/(\d+)/g)) {
        const [, token, alpha] = match;
        const declared = BLENDED.find(
          (entry) => entry.page === name && entry.token === token && entry.alpha === Number(alpha),
        );
        assert.ok(declared, `${name}: border-${token}/${alpha} with no backdrop declared here`);
        const measured = ratioHex(blend(token, declared.alpha, declared.behind), COLORS[declared.behind]);
        assert.ok(measured >= 3, `${name}: border-${token}/${alpha} = ${measured.toFixed(2)}:1`);
      }
    }
  }
});

test('no page <style> block keeps a boundary at the values the tokens retired', () => {
  // The class sweep was blind to a border written in CSS: the review composer's textarea
  // held #c4c7c7 (1.70:1 on its own white fill) through the whole of it, and three more
  // blocks kept the pre-slice pair alive inside otherwise live rules.
  for (const name of pages) {
    for (const block of readUi(name).match(/<style>[\s\S]*?<\/style>/g) || []) {
      assert.doesNotMatch(block, /#(c4c7c7|747878)/i, name);
    }
  }
  // The one page-local field left is on the same token as every shared one.
  assert.match(readUi('danh-gia-cua-toi.html'), /\.review-textarea \{[^}]*border: 1px solid #5e6262;/);
});

test('one focus colour, and placeholders no fainter than /70', () => {
  for (const name of pages) {
    const html = readUi(name);
    for (const match of html.matchAll(/focus:border-([a-z-]+)/g)) {
      // The promo field on the near-black panel is the one exception: #171818 there would
      // be the absence of a focus state rather than a louder one.
      assert.ok(['primary', 'on-tertiary'].includes(match[1]), `${name}: focus:border-${match[1]}`);
    }
    for (const match of html.matchAll(/placeholder:text-[a-z-]+\/(\d+)/g)) {
      assert.ok(Number(match[1]) >= 70, `${name}: placeholder at /${match[1]}`);
    }
  }
});

// ------------------------------------------------------------------ shared components

test('the four button roles and the dialog shell are declared once, in oak-utils.css', () => {
  for (const role of ['.btn-primary', '.btn-secondary', '.btn-ghost', '.btn-danger']) {
    assert.ok(utils.includes(role + ' {') || utils.includes(role + ',\n'), role);
  }
  // One pill, one 44px target for all four — the point of the exercise.
  const shared = utils.slice(utils.indexOf('.btn-primary,'), utils.indexOf('.btn-primary {'));
  assert.match(shared, /min-height: 44px;/);
  assert.match(shared, /border-radius: 9999px;/);
  // …and one press, so a converted button does not feel dead beside an inline active:scale-95.
  assert.ok(utils.includes('.btn-danger:active {'));
  assert.match(utils, /\.oak-dialog \{/);
});

test('every confirm dialog wears the shared shell and the shared buttons', () => {
  const DIALOGS = {
    'lich-hen-cua-toi.html': 1,
    'cai-dat.html': 1,
    'cai-dat-salon.html': 2,
    'quan-ly-dich-vu.html': 3,
    'quan-ly-lich-hen.html': 2,
    'quan-ly-nhan-vien.html': 2,
    'tong-quan-doi-tac.html': 1,
  };
  for (const [name, count] of Object.entries(DIALOGS)) {
    const html = readUi(name);
    assert.equal((html.match(/class="oak-dialog\b/g) || []).length, count, name);
    // Nothing in these pages still hand-draws the old panel or the old square button.
    assert.doesNotMatch(html, /bg-surface-container-lowest text-left shadow-\[0_20px_40px/, name);
    assert.doesNotMatch(html, /text-primary border border-outline-variant hover:bg-surface-container-highest/, name);
  }
});

test('the appointment card stopped mixing square secondaries with a pill primary', () => {
  const html = readUi('lich-hen-cua-toi.html');
  assert.equal((html.match(/class="btn-secondary flex-1 md:flex-none"/g) || []).length, 5);
  assert.equal((html.match(/class="btn-primary flex-1 md:flex-none"/g) || []).length, 1);
  // Its chips are pills like every other chip on the site.
  assert.doesNotMatch(html, /px-2 py-1 rounded-sm/);
});

test('one star: filled, empty, three sizes, declared once', () => {
  assert.match(utils, /\.oak-star \{[^}]*color: #924c00;/);
  assert.match(utils, /\.oak-star-empty \{[^}]*color: #9a9e9e;/);
  for (const size of ['sm', 'md', 'lg']) {
    assert.match(utils, new RegExp('\\.material-symbols-outlined\\.oak-star-' + size + ' \\{'));
  }
  // A filled star is readable against the card it sits on; the empty one is decoration
  // beside a number, and only has to be visible at all (it used to be 1.29:1).
  assert.ok(ratio('secondary', 'surface-container-lowest') >= 4.5);
  assert.ok(ratio('outline-variant', 'surface-container-lowest') >= 2);
  for (const name of ['ket-qua-tim-kiem.html', 'kham-pha.html', 'salon-profile.html']) {
    assert.match(readUi(name), /class="material-symbols-outlined oak-star oak-star-/, name);
  }
});

test('the rating picker is a target a thumb can hit', () => {
  // WCAG 2.2 SC 2.5.8 asks 24x24; the glyph was 24px with nothing around it.
  const html = readUi('danh-gia-cua-toi.html');
  assert.match(html, /min-w-\[44px\] min-h-\[44px\][^"]*"[^>]*type="button"/);
});

test('no page re-declares a shared component in a <style> block of its own', () => {
  for (const name of pages) {
    const html = readUi(name);
    for (const block of html.match(/<style>[\s\S]*?<\/style>/g) || []) {
      assert.doesNotMatch(block, /\.input-minimal \{/, name);
      assert.doesNotMatch(block, /\.floating-label \{/, name);
      assert.doesNotMatch(block, /\.tab-button \{/, name);
      // …and the partner gate's own sizing block no longer draws a boundary of its own.
      assert.doesNotMatch(block, /\.oak-field(:focus)? \{[^}]*border(-color)?:/, name);
    }
  }
  // …because oak-utils.css holds all three, with the field border at the readable token.
  assert.match(utils, /\.input-minimal \{[^}]*border-bottom: 1px solid #5e6262;/);
  assert.match(utils, /\.floating-label \{/);
  assert.match(utils, /\.tab-button \{/);
  assert.match(utils, /input\.oak-field \{[^}]*border: 1px solid #5e6262;/);
  assert.ok(client.includes('bookingStatus: bookingStatus,'), 'oak-api.js exports bookingStatus');
});
