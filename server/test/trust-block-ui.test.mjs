/*
 * One set of promises, said the same way wherever it is said, and never said louder than
 * the code behind it. Everything asserted here was, before this slice, a page telling the
 * reader something the server does not do: a booking "confirmed" while it sat at 'pending',
 * support "24/7" against office hours, a "verified" badge every salon carries by default.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { bookingStatus } from './booking-status.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readUi = (name) => fs.readFileSync(path.join(root, 'ui', name), 'utf8');

const confirmation = readUi('xac-nhan-dat-lich.html');
const salon = readUi('salon-profile.html');
const service = readUi('chi-tiet-dich-vu.html');
const wizard = readUi('dat-lich.html');
const api = fs.readFileSync(path.join(root, 'ui/assets/js/oak-api.js'), 'utf8');

/* The factory is inline in the page, so lift it out of its <script> to drive it here. */
const TRUST_CANCEL_POLICY = 'Hủy/đổi miễn phí đến trước 2 tiếng';

function bookingConfirmation(booking) {
  const tail = confirmation.slice(confirmation.indexOf('function oakAddMinutes('));
  const script = tail.slice(0, tail.indexOf('</script>'));
  const context = {
    OAK: {
      bookingStatus,
      fmtDate: (iso) => iso,
      TRUST: {
        CANCEL_POLICY: TRUST_CANCEL_POLICY,
        cancelPolicy: (hours) =>
          (hours ? `Hủy/đổi miễn phí đến trước ${hours} tiếng` : TRUST_CANCEL_POLICY),
      },
    },
  };
  vm.runInNewContext(`${script}\nresult = oakBookingConfirmation();`, context);
  context.result.booking = booking;
  return context.result;
}

const PENDING = {
  code: 'OAK123',
  status: 'pending',
  date: '2099-03-04',
  time: '14:30',
  // The salon's own booking settings ride along on every booking payload.
  salon: { cancel_cutoff_hours: 2, cancel_policy_text: null },
};

test('the confirmation page reports the status the server actually wrote', () => {
  // POST /api/bookings inserts 'confirmed' for a salon with auto_confirm on and 'pending'
  // for one that decides by hand. Announcing "Đặt lịch thành công!" for both said the
  // salon had agreed when it had not yet been asked.
  const pending = bookingConfirmation(PENDING);
  assert.equal(pending.view().title + ' ' + pending.view().subtitle, 'Đã gửi yêu cầu đặt lịch');
  assert.match(pending.view().message, /Thông báo/);
  assert.match(pending.view().message, /Lịch hẹn của tôi/);

  const confirmed = bookingConfirmation({ ...PENDING, status: 'confirmed' });
  assert.equal(confirmed.view().subtitle, 'đã xác nhận');
  assert.notEqual(confirmed.view().title, pending.view().title);
  // The glyph is the shared one, and it is read lazily: the map is built while the page's
  // own inline script runs, so nothing in it may touch window.OAK before Alpine boots.
  assert.equal(pending.view().icon, bookingStatus('pending').icon);
  assert.equal(confirmed.view().icon, bookingStatus('confirmed').icon);
});

test('the timeline marks how far along the booking is, and hides for one that left it', () => {
  assert.deepEqual(Array.from(bookingConfirmation(PENDING).steps()), ['Chờ xác nhận', 'Đã xác nhận', 'Hoàn tất']);
  assert.equal(bookingConfirmation(PENDING).stepIndex(), 0);
  assert.equal(bookingConfirmation({ ...PENDING, status: 'confirmed' }).stepIndex(), 1);
  assert.equal(bookingConfirmation({ ...PENDING, status: 'completed' }).stepIndex(), 2);
  assert.equal(bookingConfirmation({ ...PENDING, status: 'cancelled' }).stepIndex(), -1);
  assert.equal(bookingConfirmation(null).stepIndex(), -1);
});

test('the free-cancellation deadline is the appointment less the salon cutoff, in local time', () => {
  assert.equal(bookingConfirmation(PENDING).cancelDeadline(), '12:30, 04/03');
  // Two hours before 00:30 is the previous day, and the date has to move with it.
  assert.equal(
    bookingConfirmation({ ...PENDING, date: '2099-03-04', time: '00:30' }).cancelDeadline(),
    '22:30, 03/03',
  );
  // A salon that asks for a whole day gets a deadline a whole day earlier — the same
  // number the server refuses the cancel against.
  assert.equal(
    bookingConfirmation({
      ...PENDING,
      salon: { cancel_cutoff_hours: 24, cancel_policy_text: null },
    }).cancelDeadline(),
    '14:30, 03/03',
  );
  // Nothing left to cancel, so nothing is promised about cancelling it.
  assert.equal(bookingConfirmation({ ...PENDING, status: 'cancelled' }).cancelDeadline(), '');
  assert.equal(bookingConfirmation({ ...PENDING, status: 'completed' }).cancelDeadline(), '');
});

test('the cancellation promise names this salon hours, and falls back to the platform one', () => {
  const withCutoff = bookingConfirmation({
    ...PENDING,
    salon: { cancel_cutoff_hours: 24, cancel_policy_text: 'Gọi trước giúp salon.' },
  });
  assert.equal(withCutoff.cancelPolicy(), 'Hủy/đổi miễn phí đến trước 24 tiếng');
  assert.equal(withCutoff.cancelPolicyNote(), 'Gọi trước giúp salon.');
  // Before the booking has loaded there is no salon to ask, so the platform default holds.
  assert.equal(bookingConfirmation(null).cancelPolicy(), TRUST_CANCEL_POLICY);
  assert.equal(bookingConfirmation(null).cancelPolicyNote(), '');
});

test('the four pages of the booking path state the same three conditions', () => {
  // One sentence, written once for all four pages, so a per-salon cutoff cannot turn into
  // four different promises — and OAK.TRUST is still what it falls back to.
  assert.match(
    api,
    /return hours \? 'Hủy\/đổi miễn phí đến trước ' \+ hours \+ ' tiếng' : TRUST\.CANCEL_POLICY;/,
  );
  for (const page of [salon, service, wizard, confirmation]) {
    assert.match(page, /OAK\.TRUST\.cancelPolicy\(/);
    // The bare constant would say two hours for every salon.
    assert.doesNotMatch(page, /x-text="OAK\.TRUST\.CANCEL_POLICY"/);
    assert.match(page, /x-text="OAK\.TRUST\.PAYMENT"/);
    assert.match(page, /href="dieu-khoan\.html#huy-lich"/);
    assert.match(page, /Điều kiện đặt lịch/);
  }

  /* The third condition is the one that differs, because what the page knows differs. Before
     the booking exists none of these three holds an auto_confirm flag — the wizard's `salon`
     is a card and the service page's is a card inside a service — so they promise only the
     half that is true either way. "Salon xác nhận lịch" promised a step that a salon with
     auto_confirm on has already taken by the time the reader reaches the next screen. */
  for (const page of [salon, service, wizard]) {
    assert.match(page, /Bạn được báo trong mục Thông báo ngay khi lịch được xác nhận/);
    assert.doesNotMatch(page, /Salon xác nhận lịch, bạn được báo/);
  }

  // And the confirmation page does know: POST /api/bookings wrote 'confirmed' or 'pending'.
  assert.match(confirmation, /x-text="confirmNote\(\)"/);
  assert.equal(
    bookingConfirmation({ ...PENDING, status: 'confirmed' }).confirmNote(),
    'Lịch đã được xác nhận, bạn được báo trong mục Thông báo',
  );
  assert.equal(
    bookingConfirmation(PENDING).confirmNote(),
    'Salon sẽ xác nhận lịch, bạn được báo trong mục Thông báo',
  );
  // Nothing loaded yet is not "confirmed": the waiting half of the pair is the safe one.
  assert.equal(
    bookingConfirmation(null).confirmNote(),
    'Salon sẽ xác nhận lịch, bạn được báo trong mục Thông báo',
  );

  /* And a booking that left the line is told neither. There is no confirmation still coming
     for an hour that was cancelled, and none was ever agreed for one recorded as not
     attended — so the sentence is empty and x-show takes the whole row off the list, rather
     than leaving a bullet standing beside nothing. */
  for (const status of ['cancelled', 'no_show']) {
    assert.equal(bookingConfirmation({ ...PENDING, status }).confirmNote(), '', status);
  }
  assert.match(confirmation, /<li[^>]*x-show="confirmNote\(\)"/, 'the empty note keeps its bullet');
});

test('no page promises what the codebase does not do', () => {
  for (const name of fs.readdirSync(path.join(root, 'ui')).filter((f) => f.endsWith('.html'))) {
    const page = readUi(name);
    // No tier exists anywhere in the schema; no salon is screened before it goes live;
    // nobody answers at 3am; and a booking is not confirmed the moment it is made.
    assert.doesNotMatch(page, /hạng thẻ/, name);
    assert.doesNotMatch(page, /Hỗ trợ 24\/7/, name);
    assert.doesNotMatch(page, /xác nhận ngay/, name);
    assert.doesNotMatch(page, /Đã xác minh/, name);
    assert.doesNotMatch(page, /xét duyệt/, name);
  }
});

test('the support block names how soon somebody answers, and a way to reach them', () => {
  assert.match(confirmation, /x-text="OAK\.TRUST\.SUPPORT_HOURS"/);
  // One channel, because one is what answers. The 1900 number had nobody behind it, and
  // office hours for a line nobody picks up were the same empty promise twice over.
  assert.match(api, /SUPPORT_HOURS: 'Phản hồi trong 1 ngày làm việc · hello@oakbeauty\.vn'/);
  assert.doesNotMatch(confirmation, /href="tel:19006035"/);
  assert.match(confirmation, /href="lien-he\.html"/);
  // "encrypted" claimed a mechanism; these three are what bao-mat.html can actually show.
  assert.match(confirmation, /Kết nối HTTPS, mật khẩu được băm, salon chỉ thấy thông tin lịch bạn đặt\./);
});

test('call and Zalo render only for a salon that published a number', () => {
  for (const [page, source] of [[salon, 'salon.phone'], [service, 'service.salon.phone']]) {
    assert.match(page, new RegExp('x-if="' + source.replace('.', '\\.') + '"'));
    assert.match(page, /:href="'tel:' \+ digits\(/);
    assert.match(page, /:href="zaloUrl\(\)"/);
    assert.match(page, /rel="noopener noreferrer" style="text-decoration:none" target="_blank"/);
  }
});

test('a Vietnamese number reaches zalo.me in the international form it wants', () => {
  // '0901 234 567' is how a salon writes it; tel: wants digits and zalo.me wants 84…
  const digits = (phone) => String(phone).replace(/\D/g, '');
  const zalo = (phone) => 'https://zalo.me/' + digits(phone).replace(/^0/, '84');
  assert.equal(digits('0901 234 567'), '0901234567');
  assert.equal(zalo('0901 234 567'), 'https://zalo.me/84901234567');
  // Both pages carry this rule; if either one edits it, this pins what it has to produce.
  for (const page of [salon, service]) {
    assert.match(page, /replace\(\/\^0\/, '84'\)/);
  }
});

test('the service page says which salon performs the service', () => {
  // service.salon has arrived with the payload all along; the page named none of it.
  assert.match(service, /Thực hiện tại/);
  assert.match(service, /salon-profile\.html\?salon='/);
  assert.match(service, /<a class="hover:text-primary" href="danh-sach-salon\.html">Salon<\/a>/);
  assert.match(service, /<span>Đánh giá về<\/span> <span x-text="service\.salon\.name"><\/span>/);
  assert.doesNotMatch(service, /Đánh Giá Về Salon/);
});

test('the search card badges what the reviews earned, not what every row carries', () => {
  const results = readUi('ket-qua-tim-kiem.html');
  assert.match(results, /Được yêu thích/);
  assert.match(results, /salon\.review_count &gt;= 10 &amp;&amp; salon\.rating &gt;= 4\.7/);
});

test('the salon badge claims only that the salon signed up with OAK', () => {
  assert.match(salon, /aria-label="Đối tác OAK"/);
});
