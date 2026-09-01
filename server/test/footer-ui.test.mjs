/* The footer is copied markup, not a file: the same block sits in every page of ui/. That is
   fine only while every copy is the same copy — a trust signal added to one page and missed on
   thirty others is worse than not adding it, because nobody can tell which page is lying. This
   pins the block byte for byte, pins what it has to contain, and pins what it must NOT claim:
   there is no legal entity behind OAK Beauty yet, so there is no tax code to print. */
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

/* The three pages that own a dialog bind `:inert` on the footer, so the page behind an open
   dialog leaves the tab order (WCAG 2.4.11 / 2.1.2). That attribute is the page's state, not
   the footer's copy, so it comes off before the copies are compared — everything else in the
   block still has to match to the byte. */
const DIALOG_INERT = / :inert="[A-Za-z]+ \|\| null"/;

function footerOf(source) {
  const from = source.indexOf('<footer');
  if (from === -1) return null;
  const to = source.indexOf('</footer>', from);
  assert.ok(to !== -1, 'a page opens <footer> and never closes it');
  return source.slice(from, to + '</footer>'.length).replace(DIALOG_INERT, '');
}

const withFooter = pages.filter((page) => footerOf(readUi(page)) !== null);
const block = footerOf(readUi(withFooter[0]));

test('every page carries the same footer, byte for byte', () => {
  // A floor rather than an exact count: a new page is expected to arrive with the footer,
  // and should join this test rather than fail it.
  assert.ok(withFooter.length >= 32, `only ${withFooter.length} pages carry a footer`);

  const shapes = new Map();
  for (const page of withFooter) {
    const digest = crypto.createHash('sha256').update(footerOf(readUi(page))).digest('hex');
    shapes.set(digest, [...(shapes.get(digest) ?? []), page]);
  }

  assert.equal(
    shapes.size,
    1,
    `the footer differs between pages: ${[...shapes.values()].map((group) => group.join(', ')).join(' | ')}`,
  );
});

test('the footer carries the channels this project can prove answer', () => {
  assert.match(block, /href="mailto:hello@oakbeauty\.vn"/, 'no email');
  assert.match(block, /Phản hồi trong 1 ngày làm việc/, 'the address does not say how soon it answers');
  assert.match(block, /Tầng 8, 72 Lê Thánh Tôn, Quận 1, TP\.HCM/, 'no office address');

  // D7-08 also asked for Zalo and Facebook. Nobody has confirmed an account for either, and a
  // guessed handle is a dead 'contact us' repeated on every page — the opposite of the trust
  // signal it is meant to be. They come back the day the real destinations do.
  assert.doesNotMatch(block, /zalo\.me|facebook\.com|m\.me/, 'the footer links an unverified account');
  // And the 1900 number went the same way and for the same reason: nobody staffs it, so on
  // 36 pages it was a channel that does not answer. It comes back with a phone behind it.
  assert.doesNotMatch(block, /tel:|1900 6035/, 'the footer prints a hotline again');
});

test('the footer links are a landmark, and Liên hệ leads the support column', () => {
  assert.match(block, /<nav aria-label="Chân trang"/);

  const support = block.slice(block.indexOf('>Hỗ trợ<'));
  const links = [...support.matchAll(/>([^<>]+)<\/a>/g)].map((match) => match[1]);
  assert.equal(links[0], 'Liên hệ');
  assert.ok(links.includes('Điều khoản đối tác'), 'the partner terms are not linked');
  assert.match(support, /href="dieu-khoan\.html#doi-tac"/);

  // A technician has her own sign-in page and nothing on the site led to it, so the only way
  // in was a link a salon owner had mailed her. The footer is where the salon side already
  // says where it lives, and the two belong beside each other: one door per persona.
  assert.match(support, /href="dang-nhap-nhan-vien\.html"/, 'the staff sign-in is not linked');
  assert.equal(links[links.indexOf('Trở thành đối tác') + 1], 'Dành cho kỹ thuật viên');
});

test('the footer claims no legal entity that does not exist', () => {
  // D7-08 asked for a tax code and a Bộ Công Thương registration. Both are facts about a
  // company nobody has registered yet; printing a plausible-looking one would be a lie
  // wearing the costume of a trust signal.
  for (const claim of [/Mã số thuế/i, /\bMST\b/, /Bộ Công Thương/i, /Giấy phép/i, /ĐKKD/]) {
    assert.doesNotMatch(block, claim, `the footer claims ${claim}`);
  }
});

test('every phrase in the footer has an English translation', () => {
  // The footer is shared chrome, so oak-i18n.js resolves it through _chrome.json alone —
  // a page part could never cover a string that went missing here.
  const chrome = JSON.parse(
    fs.readFileSync(path.join(root, 'tools/i18n/parts/_chrome.json'), 'utf8'),
  );

  // A brand name and a locale label read the same in both languages, so neither one is a
  // dictionary key — oak-i18n.js leaves a string it cannot find exactly as it stands.
  const SAME = new Set(['OAK Beauty', 'Blog', 'Vietnam (VN)']);

  const texts = [...block.matchAll(/>([^<>]+)</g)]
    .map((match) => match[1].replace(/\s+/g, ' ').trim())
    .filter((text) => text && !/^[\d\s.,©–-]*$/.test(text) && !text.includes('@'))
    .filter((text) => !SAME.has(text));

  for (const text of new Set(texts)) {
    assert.ok(chrome[text], `_chrome.json has no English for "${text}"`);
  }

  assert.ok(chrome['Chân trang'], 'the footer landmark label is untranslated');
});
