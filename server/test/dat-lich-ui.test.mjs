import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const html = fs.readFileSync(path.join(root, 'ui', 'dat-lich.html'), 'utf8');

/* The factory is inline in the page, so lift it out of its <script> to drive it here.
   The slice starts at oakToday() because loadSlots() leans on the helpers above it. */
function bookingForm(api) {
  const tail = html.slice(html.indexOf('function oakToday()'));
  const script = tail.slice(0, tail.indexOf('</script>'));
  const context = { URLSearchParams, OAK: { api, toast: () => {} } };
  vm.runInNewContext(`${script}\nresult = oakBookingForm();`, context);
  return context.result;
}

test('a failed service load raises optionsError instead of the empty state, and retrying clears it', async () => {
  let failing = true;
  const state = bookingForm(async () => {
    if (failing) {
      throw new Error('Không kết nối được máy chủ.');
    }
    return [{ id: 7, name: 'Nail Gel Hàn Quốc', price: 350000, duration_min: 60 }];
  });

  await state.loadOptions(4);
  assert.equal(state.optionsError, 'Không tải được danh sách dịch vụ.');
  assert.equal(state.options.length, 0);
  assert.equal(state.optionsLoading, false);

  failing = false;
  await state.loadOptions(4);
  assert.equal(state.optionsError, '');
  assert.equal(state.options.length, 1);
});

test('a failed slot load raises slotsError instead of the empty state, and retrying clears it', async () => {
  let failing = true;
  const state = bookingForm(async () => {
    if (failing) {
      throw new Error('Máy chủ bận.');
    }
    return { slots: [{ time: '09:00', available: true }] };
  });

  // A future date, so today's "hour already started" clamp cannot filter the slot away.
  state.service = { id: 7, name: 'Nail Gel Hàn Quốc', price: 350000 };
  state.date = '2099-01-01';

  await state.loadSlots();
  assert.equal(state.slotsError, 'Không tải được khung giờ trống.');
  assert.equal(state.slots.length, 0);
  assert.equal(state.slotsLoading, false);

  failing = false;
  await state.loadSlots();
  assert.equal(state.slotsError, '');
  assert.equal(state.slots.length, 1);
});

test('a stale reply cannot overwrite the newest one, and the flags still settle', async () => {
  const replies = [];
  const state = bookingForm(() => new Promise((resolve, reject) => replies.push({ resolve, reject })));

  const first = state.loadOptions(4);
  const second = state.loadOptions(5);
  // The slow first request fails AFTER the second one already answered.
  replies[1].resolve([{ id: 7, name: 'Nail Gel Hàn Quốc' }]);
  await second;
  replies[0].reject(new Error('Quá hạn.'));
  await first;

  assert.equal(state.optionsError, '');
  assert.equal(state.options.length, 1);
  assert.equal(state.optionsLoading, false);
});

test('both empty-state messages are gated on a genuinely successful response', () => {
  assert.match(html, /x-show="salon &amp;&amp; !optionsLoading &amp;&amp; !optionsError &amp;&amp; !options\.length"/);
  assert.match(html, /x-show="!slotsLoading &amp;&amp; !slotsError &amp;&amp; !slots\.length"/);
  assert.match(html, /@click="loadOptions\(salon\.id\)"/);
  assert.match(html, /@click="loadSlots\(\)"/);
});

test('a guest is warned before the final click, without changing the submit path', () => {
  assert.match(html, /x-show="!loading &amp;&amp; !user"/);
  assert.match(html, /Đăng nhập &amp; xác nhận/);
  // The url + sessionStorage handover is what makes the warning safe to act on.
  assert.match(html, /history\.replaceState\(null, '', this\.selectionUrl\(\)\)/);
  assert.match(html, /sessionStorage\.setItem\(OAK_BOOKING_FORM_KEY/);
});
