/* The "paste your salon URL" card on the partner settings page. It writes straight to the
   salon on one request, so the two things worth pinning down in static markup are that the
   card is there at all and that nothing is sent before the owner has ticked the consent box
   — and that every line it says has English, since the console is bilingual. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readUi } from './lib/read-source.mjs';

const page = readUi('cai-dat-salon.html');

const dictionaryJs = readUi('assets/js/oak-i18n-en.js');
const dictionary = JSON.parse(dictionaryJs.replace(/^window\.OAK_I18N_EN = /, '').trim().replace(/;$/, ''));

/* Every Vietnamese line the card can show. All of them are static markup: a failure is
   whatever the route said about it, so the script writes no sentence of its own. */
const STRINGS = [
  'Nhập từ web có sẵn',
  'Link trang của bạn',
  'Tôi là chủ trang này và đồng ý cho OAK đọc trang để điền sẵn hồ sơ salon.',
  'Ghi đè dữ liệu đã có bằng thông tin từ trang (kể cả ảnh)',
  'Tên salon, ảnh, giờ mở cửa và thông tin liên hệ hiện tại sẽ bị thay thế; điểm ghim bản đồ có thể bị gỡ nếu OAK không định vị được địa chỉ mới. Dịch vụ bạn tự thêm vẫn được giữ.',
  'Nhập tự động',
  'Đang đọc trang của bạn…',
  'Đã nhập từ trang KiotViet của bạn',
  'Đã điền sẵn được một phần từ trang của bạn',
  'Đã lưu link mạng xã hội của bạn — điền các mục còn lại giúp OAK nhé',
  'Đã cập nhật hồ sơ theo dữ liệu từ trang của bạn',
  'mục thông tin salon đã điền',
  'dịch vụ',
  'ảnh',
  'link mạng xã hội',
  'mục bạn đã điền từ trước được giữ nguyên',
  'Giờ mở cửa được áp cùng một khung cho cả tuần — bạn kiểm tra lại nhé.',
  'OAK đã tự xếp nhóm dịch vụ — kiểm tra lại giúp.',
  'Chưa định vị được bản đồ — bạn tìm địa chỉ ở mục Vị trí.',
  'Vị trí bản đồ mới định theo khu vực, bạn kéo lại điểm ghim cho đúng nhé.',
  'Trang của bạn có nhiều chi nhánh — OAK lấy chi nhánh đầu tiên, bạn xem lại địa chỉ nhé.',
  'Một vài ảnh chưa tải về được — bạn thêm nốt ở mục Thư viện ảnh.',
  'Trang của bạn có nhiều ảnh — OAK lấy 6 ảnh đầu tiên, bạn thêm ảnh khác ở mục Thư viện ảnh.',
  'Trang này không cho OAK đọc nội dung — bạn điền các mục bên dưới bằng tay giúp nhé.',
  'Tải lại để xem dữ liệu',
];

test('the import card opens the settings page and posts to the import endpoint', () => {
  assert.match(page, /id="nhap-tu-web"/);
  assert.match(page, /x-data="salonImport\(\)"/);
  // First card on the page: the owner is meant to try this before filling anything by hand.
  assert.ok(page.indexOf('id="nhap-tu-web"') < page.indexOf('id="hien-thi"'));
  assert.match(page, /const body = \{ url: this\.url\.trim\(\), consent: true \};/);
  assert.match(page, /OAK\.api\('\/api\/partner\/import', \{ method: 'POST', body \}\)/);
});

test('the overwrite box is a second tick, off unless the owner asks for it', () => {
  // Default off in the component, so a partner who ticks only consent gets the import that
  // fills blanks — and the field is on the request only when the box is ticked.
  assert.match(page, /overwrite: false,/);
  assert.match(page, /<input class="mt-1" type="checkbox" x-model="overwrite"\/>/);
  assert.match(page, /if \(overwrite\) \{\s*body\.overwrite = true;\s*\}/);
  // And the box says what the mode actually replaces — the name and the pin included, both
  // of which it can take away.
  assert.ok(page.includes('Tên salon, ảnh, giờ mở cửa'));
  assert.ok(page.includes('điểm ghim bản đồ có thể bị gỡ'));
  // The "kept as you had it" line follows the answer rather than the box: an overwrite still
  // reports a skip whenever it refused a half-stated location or a pin it could not place.
  assert.match(page, /x-show="result\.skipped\.length"/);
});

test('nothing is sent until the owner has ticked consent and pasted a link', () => {
  assert.match(page, /:disabled="busy \|\| !consent \|\| !url\.trim\(\)"/);
  // The guard again in the handler: Enter in the field reaches runImport() directly.
  assert.match(page, /if \(this\.busy \|\| !this\.consent \|\| !this\.url\.trim\(\)\) \{/);
  assert.match(page, /@keydown\.enter\.prevent="runImport\(\)"/);
});

test('each of the three outcomes says which one it was, and a social link is one of them', () => {
  for (const mode of ['kiotviet', 'generic', 'social']) {
    assert.match(page, new RegExp(`x-show="result\\.mode === '${mode}'"`));
  }
  for (const code of [
    'hours_single_window',
    'category_guessed',
    'geocode_failed',
    'geocode_approximate',
    'multiple_branches',
    'images_partial',
    'images_capped',
    'nothing_found',
  ]) {
    assert.match(page, new RegExp(`warned\\('${code}'\\)`));
  }
});

test('every line the card can show has English', () => {
  for (const vietnamese of STRINGS) {
    assert.ok(page.includes(vietnamese), `cai-dat-salon.html no longer says "${vietnamese}"`);
    assert.ok(dictionary[vietnamese], `no English for "${vietnamese}"`);
  }
});
