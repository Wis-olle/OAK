/* The English dictionary is the largest script the site ships and only an English reader has
   any use for it, so every page pulls it in behind a small inline loader instead of a plain
   <script src>. The loader has to be the same on all of them — it is copied markup, not a
   file, and a page that drifts loses its English quietly, with nothing on screen to say so.

   The second half drives the one control the engine builds for itself, which wears a
   different shape depending on which of its three homes it lands in. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ui = path.join(root, 'ui');
const pages = fs.readdirSync(ui).filter((name) => name.endsWith('.html')).sort();
const readUi = (name) => fs.readFileSync(path.join(ui, name), 'utf8');

const ENGINE = '<script src="assets/js/oak-i18n.js"></script>';
const UNCONDITIONAL = '<script src="assets/js/oak-i18n-en.js"></script>';
const LOADER = /<!-- The English dictionary[\s\S]*?<\/script>/;

test('the dictionary loader sits on exactly the pages that run the engine', () => {
  const withEngine = pages.filter((page) => readUi(page).includes(ENGINE));
  const withLoader = pages.filter((page) => LOADER.test(readUi(page)));
  // A floor, so that two empty lists can never agree their way past this.
  assert.ok(withEngine.length > 30, `only ${withEngine.length} pages load oak-i18n.js`);
  assert.deepEqual(withLoader, withEngine);
});

test('every copy of the loader is the same markup, ahead of the engine that reads it', () => {
  const shapes = new Map();

  for (const page of pages.filter((name) => LOADER.test(readUi(name)))) {
    const source = readUi(page);
    const loader = source.match(LOADER)[0];

    const digest = crypto.createHash('sha256').update(loader).digest('hex');
    shapes.set(digest, [...(shapes.get(digest) ?? []), page]);

    assert.ok(
      source.indexOf(loader) < source.indexOf(ENGINE),
      `${page} loads the dictionary after the engine that reads it`,
    );
  }

  assert.equal(
    shapes.size,
    1,
    `the loader differs between pages: ${[...shapes.values()].map((group) => group.join(', ')).join(' | ')}`,
  );
});

test('no page pulls the English dictionary in for a Vietnamese reader', () => {
  for (const page of pages) {
    assert.ok(
      !readUi(page).includes(UNCONDITIONAL),
      `${page} loads the dictionary for every reader, not just an English one`,
    );
  }
});

/** A stand-in element: enough of one for the toggle to be built out of them and read back. */
function element() {
  return {
    className: '',
    style: {},
    textContent: '',
    attributes: {},
    children: [],
    clicks: [],
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    getAttribute(name) {
      return name in this.attributes ? this.attributes[name] : null;
    },
    appendChild(child) {
      this.children.push(child);
    },
    addEventListener(name, run) {
      this.clicks.push(run);
    },
  };
}

/**
 * Lift initToggle() out of oak-i18n.js and run it over a stand-in slot. The customer bar
 * marks its slot "menu" and gets a shape of its own — each language under its own name,
 * one row above the other — while every other home keeps the pair of codes.
 */
function toggle(marked) {
  const source = fs.readFileSync(path.join(root, 'ui', 'assets', 'js', 'oak-i18n.js'), 'utf8');
  const from = source.indexOf('var HEADER_SKIN = {');
  const to = source.indexOf('function set(next) {');
  assert.ok(from !== -1 && to > from, 'oak-i18n.js no longer builds the toggle here');

  const slot = element();
  slot.setAttribute('data-oak-lang', marked);
  const switched = [];
  const context = {
    lang: 'vi',
    /* Declared below the slice, so the lifted realm has to supply it. */
    set: (code) => switched.push(code),
    document: {
      createElement: () => element(),
      querySelector: (selector) =>
        (selector === 'header [data-oak-lang]' ? slot : null),
    },
  };

  vm.runInNewContext(`${source.slice(from, to)}
initToggle();`, context);
  return { group: slot.children[0], switched };
}

test('the bar dropdown offers each language by its own name, and says it once', () => {
  const { group, switched } = toggle('menu');

  /* Written the way its own speakers write it, so "Tiếng Việt" stays Vietnamese on the
     English site — a reader looking for their language reads for it, not for a code. Two
     rows and no divider between them: they sit one above the other, not side by side. */
  assert.deepEqual(group.children.map((row) => row.textContent), ['Tiếng Việt', 'English']);
  assert.deepEqual(group.children.map((row) => row.getAttribute('aria-pressed')),
    ['true', 'false']);
  /* The button that opens the panel is already named "Ngôn ngữ: …" — see the customer bar
     in assets/js/oak-header.js — and a second copy in here would be read out twice. */
  assert.equal(group.getAttribute('aria-label'), null);
  assert.equal(group.getAttribute('role'), null);

  group.children[1].clicks.forEach((run) => run());
  assert.deepEqual(switched, ['en']);
});

test('every other home keeps the pair of codes, named and divided', () => {
  const { group } = toggle('');

  assert.deepEqual(group.children.map((row) => row.textContent), ['VI', '|', 'EN']);
  assert.equal(group.getAttribute('role'), 'group');
  assert.equal(group.getAttribute('aria-label'), 'Ngôn ngữ');
});
