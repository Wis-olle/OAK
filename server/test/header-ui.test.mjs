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
  const shell = { innerHTML: '', insertAdjacentHTML() {} };
  const listeners = [];
  const context = {
    location: { pathname },
    document: {
      querySelector: (selector) => (selector === '[data-oak-header]' ? shell : extras[selector] ?? null),
      querySelectorAll: (selector) => extras.all?.[selector] ?? [],
      addEventListener: (name, run) => listeners.push([name, run]),
    },
  };
  vm.runInNewContext(source, context);
  return {
    markup: shell.innerHTML,
    ready: () => listeners.filter(([name]) => name === 'DOMContentLoaded').forEach(([, run]) => run()),
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
