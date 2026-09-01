/* The page side of phase 4, item 4: what the browser is told to fetch, and when.
 *
 * Four things here are copied markup, one per page, so the only thing keeping them true is a
 * test that reads all of them:
 *   - the font preloads. A preload naming a file no @font-face asks for is worse than no
 *     preload at all: the bytes are fetched, held for nothing, and the console warns. The
 *     hashes come from oak-fonts.css and the material stylesheet, so those two files are the
 *     only source this test will accept for them.
 *   - fetchpriority on the one image that is the LCP element of the page it opens, and the
 *     preload that names that same image in the head — without it the parser only discovers
 *     the image far below, behind the ~170KB of font bytes preloaded above.
 *   - decoding and nominal size on the card images Alpine fills in. decoding is on all of them;
 *     a nominal size is written only where the box declares one viewport-stable aspect ratio,
 *     because a pair that disagrees with the box the CSS draws would add the layout shift it is
 *     there to remove — so every pair written is checked against the ratio of its own box, and
 *     an image in a pixel-height or grid-sized box (ket-qua-tim-kiem.html's result card, the
 *     ho-so-chuyen-gia portrait) is left alone until real intrinsic sizes are known for it.
 *   - the heavy thing that is not needed for the first screen: the blur behind the fixed top
 *     bar on a phone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readRepo as read } from './lib/read-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ui = path.join(root, 'ui');

const pages = fs.readdirSync(ui).filter((name) => name.endsWith('.html')).sort();
const source = new Map(pages.map((page) => [page, read(`ui/${page}`)]));

const FONTS_CSS = 'assets/css/oak-fonts.css';
const MATERIAL_CSS = 'assets/css/gf-material-symbols-outlined-de9b7b5eb5.css';
const wired = pages.filter((page) => source.get(page).includes(FONTS_CSS));

/** The pages that open with a photograph, and therefore have an LCP image worth hurrying. */
const HERO_PAGES = [
  'cham-soc-da.html', 'dich-vu-mi.html', 'dich-vu-nail.html', 'dich-vu-toc-chuyen-sau.html',
  'gioi-thieu.html', 'kham-pha.html', 'lien-he.html', 'spa-massage.html', 'uu-dai.html',
];

const preloadsOf = (html) => [...html.matchAll(/<link[^>]*rel="preload"[^>]*>/g)].map((m) => m[0]);
const fontsOf = (html) => preloadsOf(html).filter((tag) => tag.includes('as="font"'));
const imagesOf = (html) => preloadsOf(html).filter((tag) => tag.includes('as="image"'));
const hrefOf = (tag) => tag.match(/href="([^"]*)"/)[1];

test('every wired page preloads the same five faces, and no page is missed', () => {
  assert.ok(wired.length > 30, `only ${wired.length} pages load the shared fonts`);

  const shapes = new Map();
  for (const page of wired) {
    const block = fontsOf(source.get(page)).join('\n');
    assert.equal(fontsOf(source.get(page)).length, 5, `${page} preloads a different number of faces`);
    const digest = crypto.createHash('sha256').update(block).digest('hex');
    shapes.set(digest, [...(shapes.get(digest) ?? []), page]);
  }

  assert.equal(
    shapes.size,
    1,
    `the preloads differ between pages: ${[...shapes.values()].map((g) => g.join(', ')).join(' | ')}`,
  );

  // A page with no stylesheet to preload for would fetch fonts it never uses.
  for (const page of pages.filter((name) => !wired.includes(name))) {
    assert.equal(preloadsOf(source.get(page)).length, 0, `${page} preloads fonts it does not load`);
  }
});

test('every preloaded file is one the stylesheets actually ask for', () => {
  const declared = new Set(
    [...`${read(`ui/${FONTS_CSS}`)}\n${read(`ui/${MATERIAL_CSS}`)}`.matchAll(/url\(\.\.\/([^)]+)\)/g)]
      .map((match) => `assets/${match[1]}`),
  );

  for (const tag of fontsOf(source.get(wired[0]))) {
    const href = hrefOf(tag);
    assert.ok(fs.existsSync(path.join(ui, href)), `preloaded ${href} is not in ui/`);
    assert.ok(declared.has(href), `preloaded ${href} is named by no @font-face — it would be fetched for nothing`);
    assert.match(tag, /as="font"/, `${href} is preloaded without as="font"`);
    assert.match(tag, /crossorigin/, `${href} is preloaded without crossorigin — the font would be fetched twice`);
  }
});

test('the preloaded faces are the ones the first screen is painted with', () => {
  /* Each @font-face in oak-fonts.css is preceded by the subset it covers, as a comment. Reading
     the family and that comment back off the file is what makes this a check on the preloads
     rather than a restatement of them: the headings are Fraunces, the body is Inter, and a
     Vietnamese page needs the latin and the vietnamese cut of both to paint one sentence. */
  const wanted = new Set(['Fraunces latin', 'Fraunces vietnamese', 'Inter latin', 'Inter vietnamese']);
  const ICONS = 'assets/fonts/font-material-subset.woff2';

  const faces = [...read(`ui/${FONTS_CSS}`).matchAll(/\/\* ([a-z-]+) \*\/\s*@font-face \{([^}]*)\}/g)]
    .map(([, subset, body]) => ({
      key: `${body.match(/font-family: '([^']+)'/)[1]} ${subset}`,
      url: `assets/${body.match(/url\(\.\.\/([^)]+)\)/)[1]}`,
    }));
  assert.ok(faces.length > 20, `only ${faces.length} faces read out of oak-fonts.css`);

  const hrefs = fontsOf(source.get(wired[0])).map(hrefOf);

  for (const href of hrefs.filter((url) => url !== ICONS)) {
    const keys = new Set(faces.filter((face) => face.url === href).map((face) => face.key));
    assert.ok(keys.size, `${href} is preloaded but declared by no @font-face in oak-fonts.css`);
    for (const key of keys) {
      assert.ok(wanted.has(key), `${href} is preloaded, and it carries ${key} — not a first-screen face`);
    }
  }

  for (const key of wanted) {
    const declared = faces.filter((face) => face.key === key);
    assert.ok(declared.length, `oak-fonts.css no longer declares ${key}`);
    assert.ok(declared.some((face) => hrefs.includes(face.url)), `${key} is painted but not preloaded`);
  }

  assert.ok(hrefs.includes(ICONS), 'the icon font is not preloaded, and every page draws icons above the fold');
  assert.equal(hrefs.length, wanted.size + 1, 'the preload list has drifted from the four faces plus the icons');
});

test('a preload is discovered before the stylesheet that would reveal the same file', () => {
  for (const page of wired) {
    const html = source.get(page);
    const last = html.lastIndexOf(preloadsOf(html).at(-1));
    for (const sheet of [FONTS_CSS, MATERIAL_CSS]) {
      assert.ok(
        last < html.indexOf(`href="${sheet}"`),
        `${page} preloads its fonts after ${sheet}, which is the thing the preload is meant to beat`,
      );
    }
  }
});

test('exactly the nine pages that open with a photograph hurry that one image', () => {
  for (const page of pages) {
    const html = source.get(page);
    const hits = [...html.matchAll(/<img[^>]*fetchpriority="high"[^>]*>/g)].map((m) => m[0]);
    const expected = HERO_PAGES.includes(page) ? 1 : 0;
    assert.equal(hits.length, expected, `${page} marks ${hits.length} images as high priority`);
    assert.equal(imagesOf(html).length, expected, `${page} preloads ${imagesOf(html).length} images`);

    for (const tag of hits) {
      assert.ok(!/loading="lazy"/.test(tag), `${page} hurries an image it also defers`);
      assert.match(tag, /\ssrc="assets\/images\//, `${page} hurries an image whose source is not on the page`);
      assert.match(tag, /\swidth="\d+" height="\d+"/, `${page} hurries an image with no size reserved for it`);

      /* A preload naming anything but this image would spend the head start on the wrong bytes. */
      const preload = imagesOf(html)[0];
      assert.equal(
        hrefOf(preload),
        tag.match(/\ssrc="([^"]*)"/)[1],
        `${page} preloads an image other than the one it opens with`,
      );
      assert.match(preload, /fetchpriority="high"/, `${page} preloads its hero at the ordinary priority`);
      assert.ok(
        html.indexOf(preload) < html.indexOf(fontsOf(html)[0]),
        `${page} asks for its hero after the five faces, which are ~170KB of the same priority`,
      );
    }
  }
});

test('every card image Alpine fills in decodes off the main thread', () => {
  for (const page of pages) {
    for (const tag of source.get(page).match(/<img\b[^>]*\s:src=[^>]*>/g) ?? []) {
      assert.match(tag, /decoding="async"/, `${page}: ${tag.slice(0, 70)}…`);
    }
  }
});

test('a nominal size on a card image is the ratio of the box the CSS draws', () => {
  const RATIO = /aspect-(?:\[(\d+)\/(\d+)\]|square)/g;
  let checked = 0;

  for (const page of pages) {
    const lines = source.get(page).split('\n');

    lines.forEach((line, index) => {
      if (!/<img\b[^>]*\s:src=/.test(line)) return;
      const size = line.match(/\swidth="(\d+)" height="(\d+)"/);
      if (!size) return;

      /* The nearest box above the image that states a ratio — the image's own class first. */
      let box = null;
      for (let back = index; back >= Math.max(0, index - 8) && !box; back -= 1) {
        const all = [...new Set(lines[back].match(RATIO) ?? [])];
        if (all.length) box = all;
      }

      assert.ok(box, `${page}:${index + 1} carries a nominal size with no aspect box to match`);
      assert.equal(box.length, 1, `${page}:${index + 1} sits in a box whose ratio changes with the viewport`);

      const parsed = box[0].match(/aspect-(?:\[(\d+)\/(\d+)\]|square)/);
      const [wide, tall] = parsed[1] ? [Number(parsed[1]), Number(parsed[2])] : [1, 1];
      assert.equal(
        Number(size[1]) * tall,
        Number(size[2]) * wide,
        `${page}:${index + 1} is ${size[1]}×${size[2]} inside a ${box[0]} box — the attributes would move the layout`,
      );
      checked += 1;
    });
  }

  assert.ok(checked > 12, `only ${checked} card images carry a nominal size`);
});

test('the blur behind the top bar waits for a reason to run', () => {
  const utils = read('ui/assets/css/oak-utils.css');
  const nav = utils.slice(utils.indexOf('.glass-nav {'));
  const plain = nav.slice(0, nav.indexOf('}'));
  assert.ok(
    !/backdrop-filter/.test(plain),
    'the fixed top bar blurs on a phone, where it repaints the page behind it on every scrolled frame',
  );
  assert.match(plain, /background-color: rgba\(255, 248, 244, 0\.96\)/, 'the unblurred bar is see-through');
  assert.match(
    nav,
    /@media \(min-width: 768px\) \{\s*\.glass-nav \{[^}]*backdrop-filter: blur\(20px\)/,
    'the blur is gone entirely rather than kept for the screens that can afford it',
  );
});
