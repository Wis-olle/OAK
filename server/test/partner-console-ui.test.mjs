/* The console has to be able to answer a phone call: "can I come at four instead?",
   "we have to cancel, the technician is off", "who is this number that just rang?" and
   "someone left us one star". Until now every one of those ended in a booking being
   destroyed and recreated, a customer told nothing, or a question with nowhere to ask it.
   These drive the three console pages' own factories. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { bookingStatus, BOOKING_STATUSES } from './booking-status.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readUi = (name) => fs.readFileSync(path.join(root, 'ui', name), 'utf8');

const calendarHtml = readUi('quan-ly-lich-hen.html');
const dashboardHtml = readUi('tong-quan-doi-tac.html');
const reviewsHtml = readUi('danh-gia-salon.html');

/** A list the way OAK.api hands one back: rows, with meta hidden behind them. */
function withMeta(rows, meta) {
  Object.defineProperty(rows, 'meta', { value: meta, enumerable: false });
  return rows;
}

/** Lift a page's inline factory out of its <script> and drive it here. */
function factory(html, { from, until, create }, api) {
  const tail = html.slice(html.indexOf(from));
  const script = tail.slice(0, tail.lastIndexOf(until));
  const context = {
    URLSearchParams,
    document: {
      title: 'OAK',
      visibilityState: 'visible',
      activeElement: null,
      getElementById: () => null,
      addEventListener: () => {},
      querySelectorAll: () => [],
      querySelector: () => null,
    },
    setInterval: () => {},
    OAK: {
      api,
      toast: (message, tone) => context.toasts.push({ message, tone }),
      fmtDate: (iso) => String(iso),
      fmtPrice: (value) => String(value),
      todayISO: () => '2026-08-21',
      qs: () => null,
      pendingBadge: async () => 0,
      setPendingBadge: () => {},
      requirePartner: async () => {},
      me: async () => ({ name: 'Thu Trang' }),
      bookingStatus,
      BOOKING_STATUSES,
    },
    toasts: [],
  };
  vm.runInNewContext(`${script}\nresult = ${create};`, context);
  // Alpine supplies these two; nothing here needs a real DOM behind them.
  context.result.$nextTick = (fn) => fn();
  context.result.$refs = {};
  context.result.toasts = context.toasts;
  return context.result;
}

const calendar = (api) =>
  factory(
    calendarHtml,
    { from: 'var OAK_BOOKING_CLASSES', until: 'oakPartnerChrome();', create: 'oakPartnerBookings()' },
    api,
  );

const dashboard = (api) =>
  factory(
    dashboardHtml,
    { from: 'var OAK_SEARCH_TYPES', until: 'oakPartnerChrome();', create: 'oakPartnerOverview()' },
    api,
  );

const reviewsConsole = (api) =>
  factory(
    reviewsHtml,
    { from: 'var OAK_REVIEW_PAGE', until: '</script>', create: 'oakPartnerReviews()' },
    api,
  );

const BOOKING = {
  id: 7,
  code: 'OAK-7',
  date: '2026-08-22',
  time: '10:00',
  status: 'confirmed',
  note: 'Khách muốn ngồi ghế trong cùng',
  customer: { name: 'Ngọc Anh', phone: '0901234567', vip: false, no_show_count: 0 },
  service: { id: 4, name: 'Sơn Gel', duration_min: 60, price: 250000 },
  staff: { id: 2, name: 'Lan Khuê' },
};

/* ------------------------------------------------------------ reschedule */

test('a booking still ahead can be moved; a finished one is a record, not a plan', () => {
  const state = calendar(async () => BOOKING);
  for (const [status, movable] of [
    ['pending', true],
    ['confirmed', true],
    ['completed', false],
    ['cancelled', false],
    ['no_show', false],
  ]) {
    state.detail = { ...BOOKING, status };
    assert.equal(state.canReschedule(), movable, status);
  }
  assert.match(calendarHtml, /@click="openEdit\(\)"/);
  assert.match(calendarHtml, /x-show="canReschedule\(\)"/);
});

test('rescheduling patches the booking that exists instead of creating a second one', async () => {
  const calls = [];
  const state = calendar(async (path, options) => {
    calls.push({ path, method: (options && options.method) || 'GET', body: options && options.body });
    if (options && options.method === 'PATCH') {
      return { ...BOOKING, date: '2026-08-25', time: '16:00' };
    }
    if (path.startsWith('/api/partner/availability')) {
      return { date: '2026-08-25', slots: [] };
    }
    if (path.endsWith('/history')) {
      return [];
    }
    return withMeta([], { total: 0 });
  });

  state.detail = BOOKING;
  state.openEdit();
  // The form arrives filled in: nobody should have to retype an appointment to move it.
  assert.equal(state.editingId, 7);
  assert.equal(state.form.date, '2026-08-22');
  assert.equal(state.form.time, '10:00');
  assert.equal(state.form.staff_id, '2');
  assert.equal(state.form.note, 'Khách muốn ngồi ghế trong cùng');

  state.form.time = '16:00';
  state.form.date = '2026-08-25';
  await state.submitBooking();

  const patch = calls.find((call) => call.method === 'PATCH');
  assert.ok(patch, 'expected a PATCH');
  assert.equal(patch.path, '/api/partner/bookings/7');
  assert.equal(patch.body.time, '16:00');
  assert.equal(patch.body.date, '2026-08-25');
  assert.equal(patch.body.staff_id, 2);
  // The code, the customer and the account behind them all survive the move.
  assert.equal(calls.some((call) => call.method === 'POST'), false);
  assert.equal(state.createOpen, false);
});

test('moving a booking moves the hour and leaves the service — and its price — alone', async () => {
  const calls = [];
  const state = calendar(async (path, options) => {
    calls.push({ path, method: (options && options.method) || 'GET', body: options && options.body });
    if (options && options.method === 'PATCH') {
      return { ...BOOKING, time: '16:00' };
    }
    if (path.startsWith('/api/partner/availability')) {
      return { date: '2026-08-22', slots: [] };
    }
    if (path.endsWith('/history')) {
      return [];
    }
    return withMeta([], { total: 0 });
  });

  state.detail = BOOKING;
  state.openEdit();
  state.form.time = '16:00';
  await state.submitBooking();

  // The server takes the price from the service row when a booking is created; a PATCH
  // that swapped the service without it would leave the old total on the row for every
  // revenue figure to read.
  const patch = calls.find((call) => call.method === 'PATCH');
  assert.equal(Object.hasOwn(patch.body, 'service_id'), false);
  assert.match(calendarHtml, /:disabled="editingId"[^>]*id="create-service"/);

  // Creating one still names the service, because that is where the price comes from.
  const created = calendar(async (path, options) => {
    calls.push({ path, method: (options && options.method) || 'GET', body: options && options.body });
    if (options && options.method === 'POST') {
      return BOOKING;
    }
    if (path.endsWith('/history')) {
      return [];
    }
    return withMeta([], { total: 0 });
  });
  created.form = { service_id: '4', staff_id: '', date: '2026-08-22', time: '10:00', note: '' };
  await created.submitBooking();
  assert.equal(calls.find((call) => call.method === 'POST').body.service_id, 4);
});

test('an hour that is already taken is said so in the form, which stays open', async () => {
  const state = calendar(async (path, options) => {
    if (options && options.method === 'PATCH') {
      throw new Error('Khung giờ này đã có lịch hẹn khác của kỹ thuật viên, vui lòng chọn giờ khác.');
    }
    if (path.startsWith('/api/partner/availability')) {
      return { date: '2026-08-22', slots: [] };
    }
    return withMeta([], { total: 0 });
  });

  state.detail = BOOKING;
  state.openEdit();
  await state.submitBooking();

  assert.match(state.formError, /Khung giờ này đã có lịch hẹn khác/);
  assert.equal(state.createOpen, true, 'the modal must not close on a clash');
  assert.equal(state.saving, false);
  assert.match(calendarHtml, /role="alert"[^>]*x-ref="createError"/);
});

/* ------------------------------------------------------------ cancelling with a reason */

test('the console cancel needs a reason, and sends it where the customer can read it', async () => {
  const calls = [];
  const state = calendar(async (path, options) => {
    calls.push({ path, method: (options && options.method) || 'GET', body: options && options.body });
    if (options && options.method === 'PATCH') {
      return { ...BOOKING, status: 'cancelled' };
    }
    if (path.endsWith('/history')) {
      return [];
    }
    return withMeta([], { total: 0 });
  });

  state.detail = BOOKING;
  state.askCancel(BOOKING);
  assert.equal(state.cancelTarget.id, 7);

  // No reason chosen: nothing goes anywhere.
  await state.confirmCancel();
  assert.equal(calls.some((call) => call.method === 'PATCH'), false);

  state.cancelReason = 'Nhân viên nghỉ';
  state.cancelNote = 'KTV Lan Khuê nghỉ ốm';
  await state.confirmCancel();

  const patch = calls.find((call) => call.method === 'PATCH');
  assert.ok(patch, 'expected a PATCH');
  assert.equal(patch.body.status, 'cancelled');
  // The customer's own request survives; the reason is appended under the marker the
  // server reads back when it writes the notification.
  assert.match(patch.body.note, /^Khách muốn ngồi ghế trong cùng\n/);
  assert.match(patch.body.note, /Lý do hủy: Nhân viên nghỉ — KTV Lan Khuê nghỉ ốm/);
  assert.equal(state.cancelTarget, null);

  // The dialog says whose appointment it is before it destroys it.
  assert.match(calendarHtml, /id="cancel-title"/);
  assert.match(calendarHtml, /x-text="cancelSubject\(\)"/);
  assert.match(calendarHtml, /:disabled="!cancelReason \|\| acting"/);
  assert.match(calendarHtml, /@click="askCancel\(detail\)"/);
});

test('a double tap on a console action sends one request, not two', async () => {
  let inFlight = 0;
  let peak = 0;
  const state = calendar(async (path, options) => {
    if (options && options.method === 'PATCH') {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(setImmediate);
      inFlight -= 1;
      return { ...BOOKING, status: 'completed' };
    }
    if (path.endsWith('/history')) {
      return [];
    }
    return withMeta([], { total: 0 });
  });

  state.detail = BOOKING;
  await Promise.all([state.setStatus('completed'), state.setStatus('completed')]);
  assert.equal(peak, 1);
  assert.equal(state.acting, false);
  assert.match(calendarHtml, /:disabled="acting" @click="setStatus\('confirmed'\)"/);
});

test('the dashboard queue cancels through the same dialog, with the same reason', async () => {
  const calls = [];
  const waiting = { id: 4, code: 'OAK-4', status: 'pending', date: '2026-08-22', time: '09:00', note: null, customer: { name: 'Ngọc Anh' } };
  const state = dashboard(async (path, options) => {
    calls.push({ path, method: (options && options.method) || 'GET', body: options && options.body });
    if (options && options.method === 'PATCH') {
      return { ...waiting, status: 'cancelled' };
    }
    if (path === '/api/partner/overview') {
      return { date: '2026-08-21', staff_status: [], unanswered_reviews: 0 };
    }
    return withMeta([], { page: 1, limit: 10, total: 0 });
  });

  state.askCancel(waiting);
  await state.confirmCancel();
  assert.equal(calls.some((call) => call.method === 'PATCH'), false, 'no reason, no request');

  state.cancelReason = 'Salon kín lịch';
  await state.confirmCancel();
  const patch = calls.find((call) => call.method === 'PATCH');
  assert.ok(patch, 'expected a PATCH');
  assert.equal(patch.body.status, 'cancelled');
  assert.equal(patch.body.note, 'Lý do hủy: Salon kín lịch');
  assert.equal(state.acting, 0);
  assert.match(dashboardHtml, /@click="askCancel\(booking\)"/);
  assert.doesNotMatch(dashboardHtml, /@click="decide\(booking, 'cancelled'\)"/);
});

/* ------------------------------------------------------------ the walk-in form */

test('a walk-in needs neither a name nor a number to be recorded', async () => {
  const calls = [];
  const state = calendar(async (path, options) => {
    calls.push({ path, method: (options && options.method) || 'GET', body: options && options.body });
    if (options && options.method === 'POST') {
      return { id: 9, code: 'OAK-9', date: '2026-08-21', time: '09:00', status: 'confirmed', customer: { name: 'Khách vãng lai' } };
    }
    if (path.endsWith('/history')) {
      return [];
    }
    return withMeta([], { total: 0 });
  });

  state.resetForm();
  state.form.service_id = '4';
  state.form.date = '2026-08-21';
  state.form.time = '09:00';
  await state.submitBooking();

  const post = calls.find((call) => call.method === 'POST');
  assert.ok(post, 'expected a POST');
  assert.equal(post.body.customer_name, null);
  assert.equal(post.body.customer_phone, null);
  // Nothing on the form is marked required except the service, the day and the hour.
  assert.doesNotMatch(calendarHtml, /id="create-name" required/);
  assert.doesNotMatch(calendarHtml, /id="create-phone" required/);
});

test('a booking made outside the salon hours is saved, and said out loud', async () => {
  const state = calendar(async (path, options) => {
    if (options && options.method === 'POST') {
      const created = { id: 9, code: 'OAK-9', date: '2026-08-21', time: '23:30', status: 'confirmed', customer: { name: 'Khách vãng lai' } };
      Object.defineProperty(created, 'meta', {
        value: { warning: 'Giờ hẹn nằm ngoài giờ mở cửa của salon.' },
        enumerable: false,
      });
      return created;
    }
    if (path.endsWith('/history')) {
      return [];
    }
    return withMeta([], { total: 0 });
  });

  state.resetForm();
  state.form.service_id = '4';
  state.form.time = '23:30';
  await state.submitBooking();

  assert.equal(state.detail.id, 9, 'the booking is made either way');
  const said = state.toasts.find((toast) => /ngoài giờ mở cửa/.test(toast.message));
  assert.ok(said, 'expected the warning to reach the counter');
  // The page's own sentence, not the server's — that is the one with an English twin.
  assert.equal(said.message, 'Lịch hẹn đã lưu, ngoài giờ mở cửa của salon.');
  // And in the success colour: the booking was saved, nothing failed.
  assert.notEqual(said.tone, 'error');
});

test('a walk-in with no hour is refused out loud, not swallowed', async () => {
  const calls = [];
  const state = calendar(async (path, options) => {
    calls.push({ method: (options && options.method) || 'GET' });
    return withMeta([], { total: 0 });
  });

  state.resetForm();
  state.form.service_id = '4';
  state.form.date = '2026-08-21';
  await state.submitBooking();

  assert.equal(calls.some((call) => call.method === 'POST'), false, 'nothing to post yet');
  assert.match(state.formError, /giờ trống/);
  // The hour input is only required while it is the visible one: a hidden control that
  // still carries the attribute blocks the submit with nothing on screen to explain it.
  assert.match(calendarHtml, /:required="customTime"[^>]*id="create-time"/);
  assert.doesNotMatch(calendarHtml, /id="create-time" required/);
});

test('a number the salon already knows fills its own name in', async () => {
  let match = [{ key: '1', name: 'Ngọc Anh', phone: '0901234567', visits: 4, vip: true }];
  const state = calendar(async (path) => {
    if (path.startsWith('/api/partner/customers')) {
      return match;
    }
    return withMeta([], { total: 0 });
  });

  state.resetForm();
  state.form.customer_phone = '090';
  await state.lookupCustomer();
  assert.equal(state.knownCustomer, null, 'three digits is not a lookup');

  state.form.customer_phone = '0901 234 567';
  await state.lookupCustomer();
  assert.equal(state.knownCustomer.name, 'Ngọc Anh');
  assert.equal(state.form.customer_name, 'Ngọc Anh');

  // The number goes on and finds somebody else: the name that was filled in follows it
  // rather than staying behind on the wrong customer.
  match = [{ key: '2', name: 'Thu Hà', phone: '0901239999', visits: 1, vip: false }];
  state.form.customer_phone = '0901239999';
  await state.lookupCustomer();
  assert.equal(state.form.customer_name, 'Thu Hà');

  // And when it finds nobody at all, it goes away with the match.
  match = [];
  state.form.customer_phone = '0999999999';
  await state.lookupCustomer();
  assert.equal(state.knownCustomer, null);
  assert.equal(state.form.customer_name, '');

  // A name already typed is the counter's own and must not be overwritten.
  match = [{ key: '1', name: 'Ngọc Anh', phone: '0901234567', visits: 4, vip: true }];
  state.form.customer_name = 'Chị Anh (bạn của Hằng)';
  await state.lookupCustomer();
  assert.equal(state.form.customer_name, 'Chị Anh (bạn của Hằng)');

  // …not even when the match then disappears.
  match = [];
  await state.lookupCustomer();
  assert.equal(state.form.customer_name, 'Chị Anh (bạn của Hằng)');
});

test('the technician list holds only the ones who do the chosen service', () => {
  const state = calendar(async () => withMeta([], { total: 0 }));
  state.staff = [
    { id: 1, name: 'Minh Hằng', active: 1, service_ids: [2, 3] },
    { id: 2, name: 'Lan Khuê', active: 1, service_ids: [4] },
    { id: 3, name: 'Đã nghỉ', active: 0, service_ids: [4] },
    // Hired this morning, linked to nothing yet: unconfigured, not disqualified.
    { id: 5, name: 'Tân binh', active: 1, service_ids: [] },
  ];

  state.form = { service_id: '', staff_id: '' };
  assert.deepEqual(state.staffForService().map((member) => member.id), [1, 2, 5]);

  state.form.service_id = '4';
  assert.deepEqual(state.staffForService().map((member) => member.id), [2, 5]);

  // A technician who does not do the new service cannot stay selected.
  state.form.staff_id = '1';
  state.onServiceChange();
  assert.equal(state.form.staff_id, '');
});

test('the hour is picked from the free ones, with a way out for the exception', async () => {
  const asked = [];
  const state = calendar(async (path) => {
    if (path.startsWith('/api/partner/availability')) {
      asked.push(path);
      return {
        date: '2026-08-22',
        slots: [
          { time: '09:00', available: true },
          { time: '09:30', available: false },
          { time: '10:00', available: true },
        ],
      };
    }
    return withMeta([], { total: 0 });
  });

  state.form = { service_id: '4', staff_id: '2', date: '2026-08-22', time: '' };
  await state.loadSlots();
  assert.equal(asked.length, 1);
  assert.match(asked[0], /service_id=4/);
  assert.match(asked[0], /date=2026-08-22/);
  assert.match(asked[0], /staff_id=2/);
  assert.deepEqual(state.freeSlots().map((slot) => slot.time), ['09:00', '10:00']);

  // Without a service there is nothing to ask about, so nothing is asked.
  state.form.service_id = '';
  await state.loadSlots();
  assert.equal(asked.length, 1);
  assert.equal(state.slots.length, 0);

  assert.match(calendarHtml, /@click="customTime = true"/);
  assert.match(calendarHtml, />Nhập giờ khác</);
  assert.match(calendarHtml, /@click="customTime = false"/);
});

/* ------------------------------------------------------------ the customer file */

test('the panel says what this customer had here before', async () => {
  const asked = [];
  const state = calendar(async (path) => {
    asked.push(path);
    if (path.endsWith('/history')) {
      return [{ id: 3, date: '2026-07-18', status: 'completed', service: { name: 'Sơn Gel' } }];
    }
    return BOOKING;
  });

  await state.open(7);
  assert.ok(asked.includes('/api/partner/bookings/7/history'));
  // Fired, not awaited — below md the panel is a sheet over an inert page, so the caret
  // moves first. It is cleared on the way in, so the previous customer's never shows.
  await Promise.resolve();
  assert.equal(state.history.length, 1);
  assert.match(calendarHtml, />Lịch sử tại salon</);
  assert.match(calendarHtml, /x-show="history\.length > 0"/);
});

/* ------------------------------------------------------------ reviews in the console */

test('the reviews page reads the salon\'s own reviews and can narrow them', async () => {
  const asked = [];
  const state = reviewsConsole(async (path) => {
    if (path.startsWith('/api/partner/reviews')) {
      asked.push(path);
      return withMeta([{ id: 1, rating: 1, comment: 'Chờ lâu', user: { name: 'Ngọc Anh' }, reply_text: null }], {
        page: 1,
        limit: 20,
        total: 1,
        unanswered: 3,
      });
    }
    return { id: 1, name: 'Lala Nail Studio' };
  });

  await state.load();
  assert.equal(state.reviews.length, 1);
  assert.equal(state.unanswered, 3);

  state.setFilter('1', false);
  await new Promise(setImmediate);
  assert.match(asked[asked.length - 1], /rating=1/);

  state.setFilter('', true);
  await new Promise(setImmediate);
  assert.match(asked[asked.length - 1], /unanswered=1/);
});

test('answering a review posts it, counts it, and can be taken back down', async () => {
  const calls = [];
  const review = { id: 1, rating: 1, comment: 'Chờ lâu', user: { name: 'Ngọc Anh' }, reply_text: null, reply_at: null };
  const state = reviewsConsole(async (path, options) => {
    calls.push({ path, method: (options && options.method) || 'GET', body: options && options.body });
    if (options && options.method === 'PATCH') {
      const text = options.body.reply_text;
      return { id: 1, reply_text: text || null, reply_at: text ? '2026-08-23T00:00:00.000Z' : null };
    }
    if (path.startsWith('/api/partner/reviews')) {
      return withMeta([review], { page: 1, limit: 20, total: 1, unanswered: 1 });
    }
    return { id: 1, name: 'Lala Nail Studio' };
  });

  await state.load();
  state.startReply(state.reviews[0]);
  assert.equal(state.replyingId, 1);

  state.replyText = '   ';
  await state.saveReply(state.reviews[0]);
  assert.equal(calls.some((call) => call.method === 'PATCH'), false, 'an empty answer is not an answer');

  state.replyText = 'Xin lỗi bạn, hôm đó salon quá tải.';
  await state.saveReply(state.reviews[0]);
  const patch = calls.find((call) => call.method === 'PATCH');
  assert.equal(patch.path, '/api/partner/reviews/1/reply');
  assert.equal(patch.body.reply_text, 'Xin lỗi bạn, hôm đó salon quá tải.');
  assert.equal(state.reviews[0].reply_text, 'Xin lỗi bạn, hôm đó salon quá tải.');
  assert.equal(state.unanswered, 0, 'one fewer review owes an answer');
  assert.equal(state.replyingId, null);

  // Editing an answer is not answering a second review.
  state.startReply(state.reviews[0]);
  state.replyText = 'Xin lỗi bạn, chúng tôi đã tăng thêm nhân sự.';
  await state.saveReply(state.reviews[0]);
  assert.equal(state.unanswered, 0);

  await state.removeReply(state.reviews[0]);
  assert.equal(state.reviews[0].reply_text, null);
  assert.equal(state.unanswered, 1);
});

test('the rating card is the way into the reviews, and carries what is still owed', () => {
  assert.match(dashboardHtml, /href="danh-gia-salon\.html"/);
  assert.match(dashboardHtml, /x-show="unansweredReviews\(\) > 0"/);
  assert.match(dashboardHtml, />đánh giá chưa trả lời</);
  // The count comes from the overview the page already reads, not a request of its own.
  assert.match(dashboardHtml, /this\.overview\.unanswered_reviews/);
});

test('the reviews page wears the console shell, and answers under the salon name', () => {
  // Copied from a console page rather than invented: same skip link, same rails.
  assert.match(reviewsHtml, /href="#main">Bỏ qua đến nội dung</);
  assert.match(reviewsHtml, /<nav class="hidden md:flex flex-col h-screen w-64 fixed left-0 top-0/);
  assert.match(reviewsHtml, /<nav class="md:hidden fixed bottom-0 w-full/);
  assert.match(reviewsHtml, /id="main" tabindex="-1"/);
  // The rail entry for this page is the one marked as the page on screen — styled as
  // current on every other console page, and said out loud here too.
  assert.match(
    reviewsHtml,
    /<a aria-current="page"[^>]*href="danh-gia-salon\.html"/,
  );
  assert.equal(reviewsHtml.match(/aria-current="page"/g).length, 1, 'exactly one current item');
  assert.match(reviewsHtml, />Phản hồi từ</);
});
