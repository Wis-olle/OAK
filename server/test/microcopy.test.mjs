/* One word for one thing, everywhere a reader meets it.
 *
 * Vietnamese writes "hủy" and "huỷ" — and "xóa" and "xoá" — either way, and OAK shipped
 * both at once: the partner console said "Huỷ", the customer side "Hủy", and the server
 * wrote the console's spelling into the notification the customer read after cancelling on
 * a button that said the other. Three dots and an ellipsis were mixed the same way, inside
 * otherwise identical busy labels ("Đang lưu…" beside "Đang lưu...").
 *
 * `node tools/i18n/check-rules.js` is the gate that keeps it settled; this test states the
 * rule independently of that file, so a gate quietly narrowed still fails here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/** Every file whose strings a reader can end up looking at. */
function surfaces() {
  const files = [];
  const add = (dir, keep) => {
    for (const name of fs.readdirSync(path.join(root, dir)).sort()) {
      if (keep(name)) {
        files.push(`${dir}/${name}`);
      }
    }
  };
  add('ui', (name) => name.endsWith('.html'));
  // Not the vendored bundles: minified output is nothing but spread syntax.
  add('ui/assets/js', (name) => name.endsWith('.js') && !/-[0-9a-f]{8,}\.js$/.test(name));
  add('tools/i18n/parts', (name) => name.endsWith('.json'));
  // Not server/src/seed.js: that is the salon's and the blog's own prose, not product copy.
  add('server/src/routes', (name) => name.endsWith('.js'));
  add('server/src/lib', (name) => name.endsWith('.js'));
  add('server/src/middleware', (name) => name.endsWith('.js'));
  add('server/src', (name) => name === 'app.js' || name === 'db.js');
  return files;
}

test('one spelling of "hủy" and "xóa", on every surface a reader meets', () => {
  const offenders = [];
  for (const file of surfaces()) {
    read(file).split('\n').forEach((line, index) => {
      if (/[Hh]uỷ|[Xx]oá/.test(line)) {
        offenders.push(`${file}:${index + 1}`);
      }
    });
  }
  assert.deepEqual(offenders, [], 'the settled spellings are "hủy" and "xóa"');
});

test('one ellipsis character, not three dots', () => {
  const offenders = [];
  for (const file of surfaces()) {
    read(file).split('\n').forEach((line, index) => {
      // Three dots ENDING a word is a busy label; a spread or a rest element is always
      // preceded by a bracket, a comma or a space.
      if (/[\p{L}\p{N}]\.\.\./u.test(line)) {
        offenders.push(`${file}:${index + 1}`);
      }
    });
  }
  assert.deepEqual(offenders, [], 'the settled ellipsis is "…"');
});

test('the gate that keeps it settled is still in tools/i18n', () => {
  const gate = read('tools/i18n/check-rules.js');
  assert.match(gate, /\[\/Huỷ\//, 'check-rules.js no longer rejects "Huỷ"');
  assert.match(gate, /\[\/Xoá\//, 'check-rules.js no longer rejects "Xoá"');
  assert.match(gate, /\\\.\\\.\\\./, 'check-rules.js no longer rejects three dots');
  // Scanning the parts as well is what keeps the English dictionary's keys in step with the
  // pages: a key nobody updated is a string that silently stops translating.
  assert.match(gate, /add\(path\.join\(__dirname, 'parts'\)/);
  // Every server directory a reader-facing sentence can be written in, not only the routes.
  for (const dir of ['routes', 'lib', 'middleware']) {
    assert.match(gate, new RegExp(`server/src/${dir}'`), `check-rules.js stopped reading ${dir}`);
  }
});

test('the two booking CTAs are sentence case like every other button', () => {
  for (const page of ['ui/salon-profile.html', 'ui/chi-tiet-dich-vu.html']) {
    const html = read(page);
    assert.doesNotMatch(html, /Đặt Lịch Ngay/, `${page} still shouts its CTA in title case`);
    assert.match(html, /Đặt lịch ngay/, `${page} lost its booking CTA`);
  }
});

/* The cancellation reason is written by four places and read back by one. Respelling one
   of the writers would not break a test anywhere else — the note would simply stop being
   shown to the customer, which is the failure this pins. The reader takes both spellings
   of the word because the rows written before Phase 4 settled it carry the older one. */
test('everything that writes a cancellation reason spells it the way partner.js reads it', () => {
  const settled = 'Lý do hủy:';
  const legacy = 'Lý do huỷ:'; // the same word, dấu on the other vowel, still in the table

  const source = read('server/src/routes/partner.js').match(/CANCEL_REASON_MATCH = \/(.+)\/;/);
  assert.ok(source, 'partner.js no longer names the prefix it parses');
  const reader = new RegExp(source[1]);
  assert.ok(reader.test(`${settled} kẹt xe`), 'partner.js stopped reading what it writes');
  assert.ok(reader.test(`${legacy} kẹt xe`), 'cancellations already in the table lost their reason');

  assert.ok(read('server/src/routes/bookings.js').includes(`${settled} \${reason}`));
  for (const page of ['ui/quan-ly-lich-hen.html', 'ui/tong-quan-doi-tac.html']) {
    assert.ok(read(page).includes(`'${settled} ' + reason`), `${page} writes another prefix`);
  }
});

test('the one word of copy that lives in rows is reconciled, not only rewritten in source', () => {
  // Every other string the sweep touched is read out of source on each request, so changing
  // it changed what every reader sees. This one was written into users.name and
  // bookings.customer_name when an account was erased, so rows from before the sweep would
  // keep the old spelling and a console list would show both at once.
  const users = read('server/src/routes/users.js');
  const erased = 'Người dùng đã xóa';
  assert.ok(users.includes(`SET name = '${erased}'`));
  assert.ok(users.includes(`UPDATE bookings SET customer_name = '${erased}'`));

  // db.js brings the older rows over at boot, keyed on deleted_at rather than on a search
  // for the old spelling — so it needs no second spelling of its own — and skipping rows
  // already carrying the settled one, which is what makes it a no-op from boot two on.
  const boot = read('server/src/db.js');
  assert.ok(boot.includes(`const ERASED_NAME = '${erased}';`));
  assert.match(boot,
    /UPDATE users SET name = \$1 WHERE deleted_at IS NOT NULL AND name <> \$1/);
  assert.match(boot,
    /UPDATE bookings SET customer_name = \$1\n\s*WHERE customer_name <> \$1\n\s*AND user_id IN \(SELECT id FROM users WHERE deleted_at IS NOT NULL\)/);
});
