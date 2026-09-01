/* The console has to be able to answer a phone call: "can I come at four instead?",
   "we have to cancel, the technician is off", "who is this number that just rang?" and
   "someone left us one star". Until now every one of those ended in a booking being
   destroyed and recreated, a customer told nothing, or a question with nowhere to ask it.
   These drive the three console pages' own factories. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';

import { bookingStatus, BOOKING_STATUSES } from './booking-status.mjs';
import { readUi } from './lib/read-source.mjs';

const calendarHtml = readUi('quan-ly-lich-hen.html');
const dashboardHtml = readUi('tong-quan-doi-tac.html');
const reviewsHtml = readUi('danh-gia-salon.html');

/** A list the way OAK.api hands one back: rows, with meta hidden behind them. */
function withMeta(rows, meta) {
  Object.defineProperty(rows, 'meta', { value: meta, enumerable: false });
  return rows;
}

/**
 * Lift a page's inline factory out of its <script> and drive it here.
 *
 * `confirmed` is the answer the counter gives to the one browser dialog the console raises —
 * a clash it may overrule. The questions it was asked come back on `state.confirmations`.
 */
function factory(html, { from, until, create }, api, confirmed = false) {
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
    confirmations: [],
  };
  context.window = {
    confirm: (question) => {
      context.confirmations.push(question);
      return confirmed;
    },
  };
  vm.runInNewContext(`${script}\nresult = ${create};`, context);
  // Alpine supplies these two; nothing here needs a real DOM behind them.
  context.result.$nextTick = (fn) => fn();
  context.result.$refs = {};
  context.result.toasts = context.toasts;
  context.result.confirmations = context.confirmations;
  return context.result;
}

const calendar = (api, confirmed) =>
  factory(
    calendarHtml,
    { from: 'var OAK_BOOKING_CLASSES', until: 'oakPartnerChrome();', create: 'oakPartnerBookings()' },
    api,
    confirmed,
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
  /* And the technician, who did not change, is NOT in it. The modal shows every field of the
     booking and used to post them all back, which made every save look to the server like a
     move onto the same chair — see the diffing test below for what that cost. */
  assert.equal(Object.hasOwn(patch.body, 'staff_id'), false);
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
        value: {
          warning_code: 'OUTSIDE_HOURS',
          warning: 'Giờ hẹn nằm ngoài giờ mở cửa của salon.',
        },
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

  /* Chosen on meta.warning_code, never on the server's Vietnamese. The page used to compare
     that sentence word for word, so rewording it in partner.js would have silently dropped
     the counter back to "Đã tạo lịch hẹn OAK-9." with no warning at all. */
  assert.match(calendarHtml, /meta\.warning_code === 'OUTSIDE_HOURS'/);
  assert.doesNotMatch(calendarHtml, /warning === 'Giờ hẹn nằm ngoài/);
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
    /* Linked to nothing, which is now a disqualification and not a state of being
       unconfigured: the server refuses the booking (STAFF_NOT_LINKED) because every slot
       list is built from the same links, so offering her here would only produce a 400 —
       and a technician is linked to the whole menu the day she is added. */
    { id: 5, name: 'Tân binh', active: 1, service_ids: [] },
  ];

  // Nothing to filter by yet, so the whole active roster stands.
  state.form = { service_id: '', staff_id: '' };
  assert.deepEqual(state.staffForService().map((member) => member.id), [1, 2, 5]);

  state.form.service_id = '4';
  assert.deepEqual(state.staffForService().map((member) => member.id), [2]);

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

/* ------------------------------------------------------------ booking over a clash */

/** A walk-in POST that refuses the first time and saves when the body carries force. */
function clashingCounter(sent) {
  return async (path, options) => {
    const method = (options && options.method) || 'GET';
    if (method === 'POST' && path === '/api/partner/bookings') {
      sent.push(options.body);
      if (!options.body.force) {
        const refusal = new Error('Kỹ thuật viên đã có lịch chồng giờ, vui lòng chọn giờ khác.');
        refusal.code = 'SLOT_TAKEN';
        throw refusal;
      }
      const created = {
        id: 11,
        code: 'OAK-11',
        date: '2026-08-21',
        time: '10:30',
        status: 'confirmed',
        customer: { name: 'Khách vãng lai' },
      };
      Object.defineProperty(created, 'meta', {
        value: {
          warning_code: 'FORCED_CONFLICT',
          warning: 'Kỹ thuật viên đã có lịch chồng giờ, vui lòng chọn giờ khác.',
        },
        enumerable: false,
      });
      return created;
    }
    if (path.endsWith('/history')) {
      return [];
    }
    return withMeta([], { total: 0 });
  };
}

test('a clash the counter overrules is asked once and then saved', async () => {
  const sent = [];
  const state = calendar(clashingCounter(sent), true);

  state.resetForm();
  state.form.service_id = '4';
  state.form.time = '10:30';
  await state.submitBooking();

  // The server's own sentence is the question — it is the half that says WHAT would be
  // booked over, and the page has no way to know which of the two rules answered.
  assert.equal(state.confirmations.length, 1, 'asked once, never in a loop');
  assert.match(state.confirmations[0], /chồng giờ.*Vẫn lưu\?$/);
  assert.equal(sent.length, 2, 'the same save goes out twice: once asked, once forced');
  assert.equal(sent[0].force, undefined, 'the first attempt must not force anything');
  assert.equal(sent[1].force, true);
  // Compared as sorted entries: the page builds these objects in the vm's own realm, so a
  // deep-equal against one of ours compares prototypes, and the key order differs anyway.
  const fields = (body) => JSON.stringify(Object.entries({ ...body }).sort());
  assert.equal(
    fields({ ...sent[0], force: true }),
    fields(sent[1]),
    'and the forced save is the same booking, not a second one typed again',
  );

  assert.equal(state.detail.id, 11, 'the booking is made');
  assert.equal(state.formError, '');
  assert.equal(state.saving, false);
  /* The forced save carries a meta.warning like an out-of-hours one does, but under a
     different warning_code, and it must not borrow that sentence: the counter has just been
     asked about the clash and answered it. */
  const said = state.toasts.at(-1);
  assert.equal(said.message, 'Đã tạo lịch hẹn OAK-11.');
  assert.notEqual(said.tone, 'error');
});

test('a clash the counter declines leaves the appointment where it was', async () => {
  const sent = [];
  const state = calendar(clashingCounter(sent), false);

  state.resetForm();
  state.form.service_id = '4';
  state.form.time = '10:30';
  await state.submitBooking();

  assert.equal(state.confirmations.length, 1);
  assert.equal(sent.length, 1, 'a no is a no: nothing is forced behind the counter’s back');
  assert.match(state.formError, /chồng giờ/, 'and the reason stays on screen to act on');
  assert.equal(state.saving, false);
});

/* --------------------------------------------------- an edit posts only what it changed */

test('an edit posts the fields that changed and leaves the rest out', async () => {
  const bodies = [];
  const patching = async (path, options) => {
    const method = (options && options.method) || 'GET';
    if (method === 'PATCH') {
      bodies.push(options.body);
      return BOOKING;
    }
    if (path.startsWith('/api/partner/availability')) {
      return { date: '2026-08-22', slots: [] };
    }
    if (path.endsWith('/history')) {
      return [];
    }
    return withMeta([], { total: 0 });
  };

  /* A note correction and nothing else. The hour, the day and the chair are all exactly as
     they were, so the server is never asked to weigh this booking against a calendar — which
     is what stopped a booking already forced onto a busy hour from asking "Vẫn lưu?" every
     time anybody touched its note. */
  const noteOnly = calendar(patching);
  noteOnly.detail = BOOKING;
  noteOnly.openEdit();
  noteOnly.form.note = 'Khách xin đổi ghế';
  await noteOnly.submitBooking();
  assert.deepEqual(Object.keys(bodies[0]).sort(), ['note']);
  assert.equal(bodies[0].note, 'Khách xin đổi ghế');

  // A chair that really did change is sent, and on its own.
  const restaffed = calendar(patching);
  restaffed.detail = BOOKING;
  restaffed.openEdit();
  restaffed.form.staff_id = '5';
  await restaffed.submitBooking();
  assert.deepEqual(Object.keys(bodies[1]).sort(), ['note', 'staff_id']);
  assert.equal(bodies[1].staff_id, 5);

  // Cleared back to "Bất kỳ" is a change too, and null is how it is said.
  const unassigned = calendar(patching);
  unassigned.detail = BOOKING;
  unassigned.openEdit();
  unassigned.form.staff_id = '';
  await unassigned.submitBooking();
  assert.equal(bodies[2].staff_id, null);

  /* Nothing changed at all still posts the note: a PATCH with an empty body is refused by
     the server, and the counter pressing Lưu expects the panel to close rather than an
     error about there being nothing to update. */
  const untouched = calendar(patching);
  untouched.detail = BOOKING;
  untouched.openEdit();
  await untouched.submitBooking();
  assert.deepEqual(Object.keys(bodies[3]).sort(), ['note']);
  assert.equal(untouched.createOpen, false);
});

/* ------------------------------------------------- the wall that cannot be talked round */

test('the very same minute is not offered as something to overrule', async () => {
  const sent = [];
  const state = calendar(async (path, options) => {
    const method = (options && options.method) || 'GET';
    if (method === 'POST' && path === '/api/partner/bookings') {
      sent.push(options.body);
      const refusal = new Error('Kỹ thuật viên đã có lịch đúng giờ này; chọn phút khác.');
      refusal.code = 'SLOT_OCCUPIED';
      throw refusal;
    }
    return withMeta([], { total: 0 });
  }, true);

  state.resetForm();
  state.form.service_id = '4';
  state.form.time = '10:00';
  await state.submitBooking();

  /* idx_bookings_slot will refuse that row however the counter answers, so asking would be
     the console offering a save it cannot make: the counter says yes and gets an error. The
     confirm is for SLOT_TAKEN, which is a judgement about a day, and for nothing else. */
  assert.deepEqual(state.confirmations, [], 'a wall is not a question');
  assert.equal(sent.length, 1, 'and it is not tried twice');
  assert.match(state.formError, /chọn phút khác/);
  assert.equal(state.saving, false);
});

/* ------------------------------------------------------ the calendar on a phone */

/* The grid is 80px of hours plus three 200px columns, held to a 800px minimum — behind a
   phone-sized window that is most of a day off to the right, and the only way to find that
   out was to drag. So below md the page opens on the list of what is still ahead, which
   fits and says the same things, and the grid stays one tap away behind the toggle the
   "sắp tới" view already had. */
test('on a phone the console calendar opens on the list, and the grid keeps its scrollbar', () => {
  // The breakpoint is read before anything asks it: `narrow` decides the opening view.
  assert.match(calendarHtml, /this\.watchViewport\(\);\n\s+try \{/);
  assert.match(calendarHtml, /if \(this\.narrow\) \{\n\s+this\.upcoming = true;/);
  assert.match(calendarHtml, /var wide = window\.matchMedia\('\(min-width: 768px\)'\);/);
  // And the way back to the grid is the toggle that was already there.
  assert.match(calendarHtml, /@click="exitUpcoming\(\)"/);
  /* Nothing hides the sideways scrollbar on a phone any more — it is the one thing saying
     the columns carry on past the edge. Above md, where there is room, it still goes. */
  assert.doesNotMatch(calendarHtml, /hide-scrollbar/);
  assert.match(calendarHtml, /@media \(min-width: 768px\) \{\n\s+\.calendar-scroll \{/);
  assert.match(calendarHtml, /class="[^"]*overflow-x-auto calendar-scroll/);
});
