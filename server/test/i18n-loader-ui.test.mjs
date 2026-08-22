/* The English dictionary is the largest script the site ships and only an English reader has
   any use for it, so every page pulls it in behind a small inline loader instead of a plain
   <script src>. The loader has to be the same on all of them — it is copied markup, not a
   file, and a page that drifts loses its English quietly, with nothing on screen to say so. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
