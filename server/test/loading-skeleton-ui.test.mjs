import test from 'node:test';
import assert from 'node:assert/strict';
import { readUi } from './lib/read-source.mjs';

/* Every skeleton is gated on "loading and nothing to show yet", so a rerun keeps the
   results already on screen and a failed load keeps its own error state to itself —
   each of those is gated on the loading flag being clear. */
const GATES = [
  // Two halves of the featured bento, plus the newest-salons grid.
  ['kham-pha.html', 'x-if="loading &amp;&amp; !salons.length"', 3],
  ['ket-qua-tim-kiem.html', 'x-if="loading &amp;&amp; !salons.length"', 1],
  ['dat-lich.html', 'x-show="salonsLoading &amp;&amp; !salons.length"', 1],
  ['dat-lich.html', 'x-show="optionsLoading &amp;&amp; !options.length"', 1],
  ['dat-lich.html', 'x-show="slotsLoading &amp;&amp; !slots.length"', 1],
  // The service page has one body rather than a list, so its "nothing yet" is the service.
  ['chi-tiet-dich-vu.html', 'x-if="loading &amp;&amp; !service"', 1],
  // Its hour grid reloads on every date and technician press, so it keeps the hours already
  // read while the next set is on its way.
  ['chi-tiet-dich-vu.html', 'x-show="slotsLoading &amp;&amp; !slots.length"', 1],
  // The specialist page is one body too, and the offers page is a list of three cards.
  ['ho-so-chuyen-gia.html', 'x-if="loading &amp;&amp; !staff"', 1],
  ['uu-dai.html', 'x-if="loading &amp;&amp; !promotions.length"', 1],
];

test('a skeleton stands in only while there is nothing else to stand in for', () => {
  for (const [page, gate, count] of GATES) {
    const html = readUi(page);
    assert.equal(html.split(gate).length - 1, count, page + ' — ' + gate);
  }
});

test('the service page hands over the moment it has a service, not when the load ends', () => {
  const html = readUi('chi-tiet-dich-vu.html');
  // `loading` clears in a finally after four more requests, all of them fired once the
  // service itself is in hand. A skeleton gated on the flag alone would sit on top of the
  // page it stands in for for that whole window, and the handover would be a full-screen
  // jump. The two conditions are exclusive by construction: one wants a service, the
  // other wants none.
  assert.match(html, /<template x-if="loading &amp;&amp; !service">/);
  assert.doesNotMatch(html, /<template x-if="loading">/);
  assert.match(html, /<template x-if="service">/);
});

test('the skeleton never sits on top of the state that replaces it', () => {
  // Every empty and error message on these pages waits for the load to finish.
  const khamPha = readUi('kham-pha.html');
  assert.equal(khamPha.split('x-if="!loading &amp;&amp; !error &amp;&amp; !salons.length"').length - 1, 2);

  const results = readUi('ket-qua-tim-kiem.html');
  assert.match(results, /x-if="!loading &amp;&amp; loadError"/);
  assert.match(results, /x-if="!loading &amp;&amp; !loadError &amp;&amp; !salons\.length"/);

  const booking = readUi('dat-lich.html');
  assert.match(booking, /x-show="!salonsLoading &amp;&amp; !salonsError &amp;&amp; !salons\.length"/);
  assert.match(booking, /x-show="salon &amp;&amp; !optionsLoading &amp;&amp; !optionsError &amp;&amp; !options\.length"/);
  assert.match(booking, /x-show="!slotsLoading &amp;&amp; !slotsError &amp;&amp; !slots\.length"/);

  const detail = readUi('chi-tiet-dich-vu.html');
  assert.match(detail, /x-if="!loading &amp;&amp; !service"/);
  assert.match(detail, /x-show="!slotsLoading &amp;&amp; !slotsError &amp;&amp; !slots\.length"/);

  const offers = readUi('uu-dai.html');
  assert.match(offers, /x-if="!loading &amp;&amp; loadError"/);
  assert.match(offers, /x-if="!loading &amp;&amp; !loadError &amp;&amp; !promotions\.length"/);

  // The side column of the bento is a plain grid child rather than a template, so while
  // the skeleton stands in its place it would still claim a gutter row of empty height.
  assert.match(
    khamPha,
    /<div class="md:col-span-4 flex flex-col gap-gutter" x-show="salons\.length">/,
  );
});

/* The account lists are fetched once per visit and only ever re-fetched from their own
   error card, which is up exactly when the list is empty — so "loading" alone already
   means "nothing to show yet" there. My appointments is the exception: switching tabs
   re-runs the load, and a cached tab keeps its rows on screen. */
const ACCOUNT_GATES = [
  ['yeu-thich.html', 'x-show="loading"', 1],
  ['thong-bao.html', 'x-show="loading"', 1],
  ['danh-gia-cua-toi.html', 'x-show="loading"', 1],
  ['lich-hen-cua-toi.html', 'x-show="loading &amp;&amp; !bookings.length"', 1],
];

test('the account pages have a shape before their reply, and it is decoration', () => {
  for (const [page, gate, count] of ACCOUNT_GATES) {
    const html = readUi(page);
    assert.equal(html.split(gate).length - 1, count, page + ' — ' + gate);
    const around = html.slice(html.indexOf(gate) - 120, html.indexOf(gate) + 120);
    assert.ok(around.includes('aria-hidden="true"'), page + ' — ' + gate);
    // And it stands down for the states that replace it.
    assert.ok(html.includes('animate-pulse'), page + ' — no placeholder at all');
  }
});

test('a skeleton is decoration, so it is never read out as content', () => {
  // Every set of placeholders sits under one aria-hidden wrapper, on the gated element
  // itself or on the element the gated <template> holds. The two pages whose skeleton stands
  // for a single body announce the load instead, and are checked separately below.
  const ANNOUNCED = ['chi-tiet-dich-vu.html', 'ho-so-chuyen-gia.html'];
  for (const [page, gate] of GATES.filter(([name]) => !ANNOUNCED.includes(name))) {
    const html = readUi(page);
    let at = html.indexOf(gate);
    while (at !== -1) {
      const around = html.slice(at - 120, at + 120);
      assert.ok(around.includes('aria-hidden="true"'), page + ' — ' + gate);
      at = html.indexOf(gate, at + 1);
    }
  }
  // The service and specialist pages have no list to hide, so they announce the load
  // instead — the way the salon profile does.
  assert.match(
    readUi('chi-tiet-dich-vu.html'),
    /aria-label="Đang tải chi tiết dịch vụ"[^>]*role="status"/,
  );
  assert.match(
    readUi('ho-so-chuyen-gia.html'),
    /aria-label="Đang tải hồ sơ chuyên gia"[^>]*role="status"/,
  );
});
