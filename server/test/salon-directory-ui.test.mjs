import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const html = fs.readFileSync(path.join(root, 'ui', 'danh-sach-salon.html'), 'utf8');

/* The factory is inline in the page, so lift it out of its <script> to drive it here. */
function salonDirectory(api) {
  const tail = html.slice(html.indexOf('function oakSalonDirectory()'));
  const script = tail.slice(0, tail.indexOf('</script>'));
  const context = { URLSearchParams, OAK: { api, toast: () => {} } };
  vm.runInNewContext(`${script}\nresult = oakSalonDirectory();`, context);
  return context.result;
}

test('a failed salon page raises loadError instead of the empty state, and retrying clears it', async () => {
  const rows = [{ id: 4, name: 'Lala Nail Studio', slug: 'lala-nail-studio' }];
  rows.meta = { page: 1, limit: 12, total: 1 };
  let failing = true;
  const state = salonDirectory(async () => {
    if (failing) {
      throw new Error('Không kết nối được máy chủ.');
    }
    return rows;
  });

  await state.load(1);
  assert.equal(state.loadError, true);
  assert.equal(state.salons.length, 0);
  assert.equal(state.total, 0);

  failing = false;
  await state.load(1);
  assert.equal(state.loadError, false);
  assert.equal(state.salons.length, 1);
});

test('a failed "Xem thêm" keeps the loaded salons, the page number and the non-error state', async () => {
  const rows = [{ id: 4, name: 'Lala Nail Studio', slug: 'lala-nail-studio' }];
  rows.meta = { page: 1, limit: 12, total: 30 };
  let failing = false;
  const state = salonDirectory(async () => {
    if (failing) {
      throw new Error('Máy chủ bận.');
    }
    return rows;
  });

  await state.load(1);
  failing = true;
  await state.loadMore();
  assert.equal(state.salons.length, 1);
  assert.equal(state.loadError, false);
  assert.equal(state.page, 1);
});

test('the empty message is gated on a genuinely successful response', () => {
  assert.match(html, /x-if="!loading &amp;&amp; !loadError &amp;&amp; !salons\.length"/);
  assert.match(html, /x-if="!loading &amp;&amp; loadError"/);
  assert.match(html, /@click="load\(1\)"/);
});
