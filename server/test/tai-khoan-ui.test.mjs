import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const page = (name) => fs.readFileSync(path.join(root, 'ui', name), 'utf8');

const bookingsHtml = page('lich-hen-cua-toi.html');
const notificationsHtml = page('thong-bao.html');
const reviewsHtml = page('danh-gia-cua-toi.html');
const favoritesHtml = page('yeu-thich.html');
const confirmationHtml = page('xac-nhan-dat-lich.html');

/* Each factory is inline in its page, so lift it out of its <script> and drive it here.
   `from` is the first line of the slice — everything the factory leans on sits below it. */
function factory(html, from, call, extra = {}) {
  const tail = html.slice(html.indexOf(from));
  const script = tail.slice(0, tail.indexOf('</script>'));
  const query = extra.query || {};
  const context = {
    toasts: [],
    location: { href: '' },
    OAK: {
      api: extra.api,
      toast: (message, type) => context.toasts.push([message, type]),
      requireLogin: async () => ({ id: 1, name: 'Ngọc Anh' }),
      fmtDate: (value) => String(value),
      fmtTime: (value) => String(value),
      qs: (name) => (name in query ? query[name] : null),
    },
  };
  vm.runInNewContext(`${script}\nresult = ${call};`, context);
  context.result.toasts = context.toasts;
  context.result.location = context.location;
  return context.result;
}

const myBookings = (api) =>
  factory(bookingsHtml, 'const OAK_BOOKING_STATUS =', 'oakMyBookings()', { api });
const myNotifications = (api) =>
  factory(notificationsHtml, 'var OAK_NOTIFICATION_ICONS =', 'oakNotifications()', { api });
const myReviews = (api) =>
  factory(reviewsHtml, 'const RATING_LABELS =', 'oakMyReviews()', { api });
const myConfirmation = (api, query) =>
  factory(confirmationHtml, 'function oakAddMinutes(', 'oakBookingConfirmation()', { api, query });

/** A local 'YYYY-MM-DD'/'HH:MM' pair `hours` from now, the shape a booking carries. */
function bookingIn(hours) {
  const at = new Date(Date.now() + hours * 60 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  return {
    id: 12,
    code: 'OAK-4K7P2M',
    date: at.getFullYear() + '-' + pad(at.getMonth() + 1) + '-' + pad(at.getDate()),
    time: pad(at.getHours()) + ':' + pad(at.getMinutes()),
    service: { id: 7 },
    // cancel_cutoff_hours is what the salon set; every deadline here is read from it.
    salon: { id: 4, phone: '0901 234 567', cancel_cutoff_hours: 2, cancel_policy_text: null },
  };
}

// ------------------------------------------------------------------ shared account nav

const ACCOUNT_PAGES = [
  'lich-hen-cua-toi.html',
  'yeu-thich.html',
  'danh-gia-cua-toi.html',
  'thong-bao.html',
  'ho-so-ca-nhan.html',
  'cai-dat.html',
];

/** One nav block, with the active marker normalised away so the six can be compared. */
function navBlock(html, startPattern, end) {
  const match = html.match(startPattern);
  assert.ok(match, 'no block matching ' + startPattern);
  const stop = html.indexOf(end, match.index) + end.length;
  return html.slice(match.index, stop);
}

for (const [kind, startPattern, end] of [
  ['desktop', /<aside class="[^"]*" data-oak-account-nav="">/, '</aside>'],
  ['mobile', /<nav aria-label="[^"]*" class="[^"]*" data-oak-account-tabs="">/, '</nav>'],
]) {
  test(`the ${kind} account nav is the same markup on all six pages`, () => {
    const blocks = ACCOUNT_PAGES.map((name) => navBlock(page(name), startPattern, end));

    blocks.forEach((block, index) => {
      const active = [...block.matchAll(/<a aria-current="page" class="[^"]*" href="([^"]*)"/g)];
      // Exactly one entry is marked, and it is the page the block sits on.
      assert.deepEqual(active.map((hit) => hit[1]), [ACCOUNT_PAGES[index]]);
    });

    const normalised = new Set(blocks.map((block) => block.replaceAll(' aria-current="page"', '')));
    assert.equal(normalised.size, 1, 'the six blocks are not byte-identical');
  });
}

test('every account page links to all six destinations under one set of names', () => {
  const block = navBlock(page('yeu-thich.html'), /<aside class="[^"]*" data-oak-account-nav="">/, '</aside>');
  for (const name of ACCOUNT_PAGES) {
    assert.ok(block.includes(`href="${name}"`), 'missing link to ' + name);
  }
  // One name per destination, everywhere: the profile page is never "Tài khoản của tôi".
  assert.ok(block.includes('Hồ sơ cá nhân'));
  assert.match(
    block,
    /href="cai-dat\.html">\s*<span[^>]*data-icon="settings">settings<\/span>\s*Cài đặt\s*<\/a>/,
  );
});

// ------------------------------------------------------------------ lich-hen-cua-toi

test('switching tabs drops the previous tab\'s rows before the new ones are asked for', async () => {
  let release;
  const state = myBookings(() => new Promise((resolve) => { release = resolve; }));
  state.bookings = [{ id: 1 }, { id: 2 }];

  // 'cancelled', not 'completed': that tab chases /api/reviews/mine as well, and this stub
  // hands out one reply at a time.
  const pending = state.show('cancelled');
  // Not after the reply: while the request is in flight those rows would read as this tab's.
  assert.equal(state.bookings.length, 0);
  assert.equal(state.loading, true);

  release(Object.assign([{ id: 3 }], { meta: { total: 1 } }));
  await pending;
  // Compared field by field: the rows are built inside the vm, so they are never
  // reference-equal to a literal written out here.
  assert.equal(state.bookings.length, 1);
  assert.equal(state.bookings[0].id, 3);
});

test('a cached tab is still served without a request', async () => {
  let calls = 0;
  const state = myBookings(async () => {
    calls += 1;
    return [{ id: 3 }];
  });

  await state.show('cancelled');
  await state.show('cancelled');
  assert.equal(calls, 1);
});

test('each status chip gets a readable pair of tokens, completed staying neutral', () => {
  const state = myBookings(async () => []);
  assert.equal(state.statusClass('pending'), 'bg-secondary-container text-on-secondary-container');
  assert.equal(state.statusClass('confirmed'), 'bg-primary-container text-on-primary');
  assert.equal(state.statusClass('cancelled'), 'bg-error-container text-on-error-container');
  assert.equal(state.statusClass('completed'), 'bg-tertiary-fixed text-on-tertiary-fixed');
  // An unknown status falls back rather than rendering an empty class attribute.
  assert.equal(state.statusClass('nonsense'), 'bg-tertiary-fixed text-on-tertiary-fixed');
});

test('a booking the salon never closed out says so on its own card', () => {
  // The server sets `auto` when GET /api/bookings/mine swept the booking itself; the card
  // reads it beside the status so "Đã hoàn thành" is not mistaken for somebody's decision.
  assert.match(
    bookingsHtml,
    /x-show="booking\.auto &amp;&amp; booking\.status === 'completed'">Tự động hoàn tất</,
  );
  assert.match(
    bookingsHtml,
    /x-show="booking\.auto &amp;&amp; booking\.status === 'cancelled'">Salon không xác nhận</,
  );
  // Both readings are in the markup, so the dictionary can find them.
  const dictionary = JSON.parse(
    fs.readFileSync(path.join(root, 'tools', 'i18n', 'parts', 'lich-hen-cua-toi.json'), 'utf8'),
  );
  assert.ok(dictionary['Tự động hoàn tất']);
  assert.ok(dictionary['Salon không xác nhận']);
});

test('the sweep that sets that flag runs before the list is read, once per booking', () => {
  const route = fs.readFileSync(
    path.join(root, 'server', 'src', 'routes', 'bookings.js'),
    'utf8',
  );
  // Before the count and the page query, so a stranded booking lands in a tab at all.
  assert.match(route, /await closePastBookings\(req\.user\.id\);/);
  assert.ok(
    route.indexOf('await closePastBookings(req.user.id);') < route.indexOf('const filter ='),
  );
  // Only yesterday and earlier, and only what the salon left open.
  assert.match(route, /b\.date < \? AND b\.status IN \('pending', 'confirmed'\)/);
  // The UPDATE names the status it read, so a second concurrent list writes nothing and
  // therefore queues no second invitation to review.
  assert.match(
    route,
    /UPDATE bookings SET status = \?, note = \?, auto_closed = 1 WHERE id = \? AND status = \?/,
  );
  assert.match(route, /if \(changes > 0 && completed\)/);
  // The flag is a column the sweep writes, not a phrase read back out of the note: `note`
  // also carries the customer's own words, and a customer may type anything into it.
  assert.match(route, /auto: Boolean\(row\.auto_closed\),/);
  assert.equal(route.includes('AUTO_NOTES'), false);
});

test('the salon owner is told about a booking the customer made or dropped', () => {
  const route = fs.readFileSync(
    path.join(root, 'server', 'src', 'routes', 'bookings.js'),
    'utf8',
  );
  // The owner id comes off the salon join, never off the request body.
  assert.match(route, /s\.owner_id AS salon_owner_id,/);
  assert.equal(route.split('booking.salon_owner_id').length - 1, 2);
  assert.match(route, /'Lịch hẹn mới cần xác nhận',/);
  assert.match(route, /'Khách đã huỷ lịch hẹn',/);
});

test('"Đổi lịch" reopens the same wizard, naming the appointment it replaces', () => {
  const state = myBookings(async () => []);
  const booking = bookingIn(48);
  assert.equal(
    state.rescheduleUrl(booking),
    'dat-lich.html?service_id=7&salon_id=4&reschedule=12',
  );
});

test('the cancel dialog names the free-cancellation deadline, two hours before the start', () => {
  const state = myBookings(async () => []);
  state.cancelTarget = bookingIn(5);

  assert.equal(state.cancelExpired(), false);
  const deadline = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  assert.equal(
    state.cancelDeadline(),
    pad(deadline.getHours()) + ':' + pad(deadline.getMinutes())
      + ', ' + pad(deadline.getDate()) + '/' + pad(deadline.getMonth() + 1),
  );
});

test('inside the cancellation window the dialog still opens, and offers the phone instead', () => {
  const state = myBookings(async () => []);
  state.cancelTarget = bookingIn(1);

  assert.equal(state.cancelExpired(), true);
  // The dialog is where the explanation lives, so opening it is never blocked...
  assert.match(bookingsHtml, /@click="cancel\(booking\)"/);
  // ...the red button is simply not the thing on offer any more.
  assert.match(bookingsHtml, /x-show="!cancelExpired\(\) &amp;&amp; cancelReason !== 'Muốn đổi giờ\/KTV'"/);
  assert.match(bookingsHtml, /Đã quá hạn hủy online — vui lòng liên hệ salon\./);
  // The only thing that still works past the deadline, and only with a number to dial.
  assert.match(bookingsHtml, /x-show="cancelExpired\(\) &amp;&amp; salonPhone\(\)"/);
  assert.match(bookingsHtml, /Gọi salon để hủy/);
  assert.equal(state.salonPhone(), '0901234567');
  // The salon phone is free text, so an international prefix has to survive the strip.
  state.cancelTarget.salon.phone = '+84 28 3822 1456';
  assert.equal(state.salonPhone(), '+842838221456');
});

test('the deadline is the cutoff THIS salon set, not a platform-wide two hours', () => {
  const state = myBookings(async () => []);
  // Six hours out: inside a 24h cutoff, outside the 2h default.
  const booking = bookingIn(6);
  assert.equal(state.canCancel(booking), true);
  booking.salon.cancel_cutoff_hours = 24;
  assert.equal(state.canCancel(booking), false);
  // A salon whose settings never reached the payload keeps the platform default.
  delete booking.salon.cancel_cutoff_hours;
  assert.equal(state.canCancel(booking), true);
});

test('the cancel dialog asks why, and turns into the way to keep the appointment', () => {
  const state = myBookings(async () => []);
  assert.deepEqual(Array.from(state.cancelReasons), [
    'Bận đột xuất', 'Muốn đổi giờ/KTV', 'Tìm được nơi khác', 'Khác',
  ]);
  // Opening the dialog starts the answer over, so the last cancellation's reason cannot
  // ride along with the next one.
  state.cancelReason = 'Khác';
  state.cancelNote = 'ghi chú cũ';
  state.cancel(bookingIn(5));
  assert.equal(state.cancelReason, 'Bận đột xuất');
  assert.equal(state.cancelNote, '');
  // "Muốn đổi giờ/KTV" is not a cancellation: the red button gives way to the wizard.
  assert.match(bookingsHtml, /x-show="!cancelExpired\(\) &amp;&amp; cancelReason === 'Muốn đổi giờ\/KTV'"/);
  assert.match(bookingsHtml, /Đổi lịch thay vì hủy/);
  // The free-text box belongs to "Khác" alone.
  assert.match(bookingsHtml, /x-show="cancelReason === 'Khác'"/);
});

test('the reason reaches the server as the body of the cancel request', async () => {
  const sent = [];
  const state = myBookings(async (path, options) => {
    sent.push({ path, options });
    return [];
  });
  state.cancelTarget = bookingIn(5);
  state.cancelReason = 'Khác';
  state.cancelNote = '  đổi ý  ';
  await state.confirmCancel();

  const cancel = sent.find((call) => call.path.endsWith('/cancel'));
  assert.ok(cancel, 'expected a PATCH to the cancel endpoint');
  assert.equal(cancel.options.method, 'PATCH');
  assert.equal(cancel.options.body.reason, 'Khác: đổi ý');
});

test('the reason the dialog assembles always fits the 200-character cap the server enforces', async () => {
  const sent = [];
  const state = myBookings(async (path, options) => {
    sent.push({ path, options });
    return [];
  });
  // The box stops where the request would: 200 less the "Khác: " prefix it will carry.
  assert.match(bookingsHtml, /maxlength="194"[^>]*x-model="cancelNote"/);
  state.cancelTarget = bookingIn(5);
  state.cancelReason = 'Khác';
  state.cancelNote = 'x'.repeat(500);
  await state.confirmCancel();

  const cancel = sent.find((call) => call.path.endsWith('/cancel'));
  assert.equal(cancel.options.body.reason.length, 200);
});

test('a note typed under "Khác" is dropped when the reason is switched away from it', async () => {
  const sent = [];
  const state = myBookings(async (path, options) => {
    sent.push({ path, options });
    return [];
  });
  state.cancelTarget = bookingIn(5);
  state.cancelReason = 'Khác';
  state.cancelNote = 'salon quá xa nhà';
  // The box hides with the reason, so the salon must not read what it hid.
  state.cancelReason = 'Bận đột xuất';
  await state.confirmCancel();

  const cancel = sent.find((call) => call.path.endsWith('/cancel'));
  assert.equal(cancel.options.body.reason, 'Bận đột xuất');
});

test('a booking that has already started offers no cancel button at all', () => {
  const state = myBookings(async () => []);
  assert.equal(state.hasStarted(bookingIn(1)), false);
  assert.equal(state.hasStarted(bookingIn(-1)), true);
  assert.match(
    bookingsHtml,
    /x-show="tab === 'upcoming' &amp;&amp; !hasStarted\(booking\)"/,
  );
});

test('an appointment the salon recorded as absent is labelled, not left as an enum', () => {
  const state = myBookings(async () => []);
  assert.equal(state.statusLabel('no_show'), 'Không đến');
  assert.equal(state.statusIcon('no_show'), 'person_off');
  assert.notEqual(state.statusClass('no_show'), state.statusClass('cancelled'));
});

test('the past tab is the one an absence can be reached through', async () => {
  // The three tabs are the only lists this page ever asks for, so a status none of them
  // selects is invisible however well the chip beside it is labelled: 'past' is the filter
  // that covers both ways an appointment closes out.
  const asked = [];
  const state = myBookings(async (path) => {
    asked.push(path);
    return path.startsWith('/api/reviews')
      ? []
      : Object.assign([{ id: 9, status: 'no_show', service: { id: 7 }, salon: {} }], {
        meta: { total: 1 },
      });
  });

  await state.show('past');
  assert.ok(asked.includes('/api/bookings/mine?status=past&limit=50'));
  assert.equal(state.bookings[0].status, 'no_show');
  assert.equal(state.statusLabel(state.bookings[0].status), 'Không đến');
  // And it is not offered as something to review: nobody attended it.
  assert.equal(state.canReview(state.bookings[0]), false);

  // The tab strip has to point at that same filter, or the list is never asked for.
  assert.match(bookingsHtml, /@click="show\('past'\)"[^>]*>Đã qua</);
  // And the tab keeps a line of its own when it is empty, rather than falling through to ''.
  assert.notEqual(state.emptyMessage(), '');
});

test('the empty list is a card with a way out of it, not a bare line', () => {
  assert.match(bookingsHtml, /data-icon="calendar_month">calendar_month<\/span>/);
  assert.match(bookingsHtml, /x-text="emptyMessage\(\)"/);
  assert.match(bookingsHtml, /href="kham-pha\.html">Khám phá salon<\/a>/);
  assert.match(bookingsHtml, /x-show="loading &amp;&amp; !bookings\.length"/);
});

// ------------------------------------------------------------------ thong-bao

test('a notification about a booking points the arrow at that booking', () => {
  const state = myNotifications(async () => []);
  assert.equal(
    state.destination({ type: 'booking', booking_id: 12 }),
    'xac-nhan-dat-lich.html?id=12',
  );
  assert.equal(
    state.destination({ type: 'reminder', booking_id: 12 }),
    'xac-nhan-dat-lich.html?id=12',
  );
});

test('every other notification keeps the destination its type always had', () => {
  const state = myNotifications(async () => []);
  // A review asks the reader to write, so it lands on the review page despite its booking.
  assert.equal(state.destination({ type: 'review', booking_id: 12 }), 'danh-gia-cua-toi.html');
  assert.equal(state.destination({ type: 'promotion', booking_id: null }), 'uu-dai.html');
  // Rows written before the server carried booking_id fall back the same way.
  assert.equal(state.destination({ type: 'booking', booking_id: null }), 'lich-hen-cua-toi.html');
  assert.equal(state.destination({ type: 'nonsense', booking_id: null }), '');
});

test('the row marks read and nothing else; the arrow beside it is what navigates', async () => {
  const asked = [];
  const state = myNotifications(async (path, options) => {
    asked.push(path + ' ' + options.method);
    return { ok: true };
  });
  const item = { id: 3, type: 'booking', booking_id: 12, read: false };

  await state.markRead(item);
  assert.deepEqual(asked, ['/api/notifications/3/read PATCH']);
  assert.equal(item.read, true);

  // Already read: no second request, and no navigation ever came from this handler —
  // markRead is the row's whole job; open() below it is the arrow's.
  await state.markRead(item);
  assert.equal(asked.length, 1);
  assert.equal(state.location.href, '');
  assert.match(notificationsHtml, /@click="markRead\(item\)"/);
  assert.match(notificationsHtml, /:href="destination\(item\)"/);
});

// ------------------------------------------------------------------ danh-gia-cua-toi

test('editing a review reopens the composer over its own rating and comment', () => {
  const state = myReviews(async () => []);
  state.bookingId = 9;
  state.notice = 'Bạn đã đánh giá lịch hẹn này rồi.';
  state.$nextTick = (fn) => fn();
  state.$refs = { composer: { scrollIntoView: () => {} } };

  state.startEdit({ id: 41, rating: 4, comment: 'Rất ưng ý.' });

  assert.equal(state.editingId, 41);
  assert.equal(state.rating, 4);
  assert.equal(state.comment, 'Rất ưng ý.');
  // The two paths share one form, so the "write" state has to be cleared with it.
  assert.equal(state.bookingId, null);
  assert.equal(state.booking, null);
  assert.equal(state.notice, '');
});

test('submitting an edit PATCHes that review and never creates a second one', async () => {
  const calls = [];
  const state = myReviews(async (path, options) => {
    calls.push([path, options && options.method, options && options.body]);
    return [];
  });
  state.editingId = 41;
  state.rating = 5;
  state.comment = '  Tuyệt vời.  ';

  await state.submit();

  assert.equal(calls[0][0], '/api/reviews/41');
  assert.equal(calls[0][1], 'PATCH');
  // The body is built inside the vm, so it is compared by its fields, not by identity.
  assert.equal(calls[0][2].rating, 5);
  assert.equal(calls[0][2].comment, 'Tuyệt vời.');
  assert.equal('booking_id' in calls[0][2], false);
  assert.equal(calls.some((call) => call[0] === '/api/reviews' && call[1] === 'POST'), false);
  assert.equal(state.editingId, null);
  assert.equal(state.rating, 0);
  assert.deepEqual(state.toasts[0], ['Đã cập nhật đánh giá.', undefined]);
});

test('an edit with no stars chosen is refused before any request', async () => {
  let calls = 0;
  const state = myReviews(async () => {
    calls += 1;
    return [];
  });
  state.editingId = 41;
  state.rating = 0;

  await state.submit();

  assert.equal(calls, 0);
  assert.equal(state.error, 'Vui lòng chọn số sao trước khi gửi.');
});

test('the composer opens for a booking or for an edit, and only the write path shows a booking', () => {
  assert.match(reviewsHtml, /x-show="bookingId \|\| editingId"/);
  assert.match(reviewsHtml, /<template x-if="booking \|\| editingId">/);
  assert.match(reviewsHtml, /<template x-if="booking">/);
  assert.match(reviewsHtml, /@click="startEdit\(review\)"/);
});

// ------------------------------------------------------- reviewer follow-ups (round 2)

test('"Đổi lịch" is withdrawn once the appointment can no longer be cancelled', () => {
  const state = myBookings(async () => []);

  assert.equal(state.canCancel(bookingIn(5)), true);
  assert.equal(state.canCancel(bookingIn(1)), false);
  // Rescheduling ends in a cancel of this same booking, so the button may not outlive it:
  // otherwise the customer ends up holding two live appointments.
  assert.match(bookingsHtml, /x-show="tab === 'upcoming' &amp;&amp; canCancel\(booking\)"/);
  // "Hủy lịch" deliberately stays until the appointment actually starts: its dialog is
  // where the explanation — and the phone number — lives.
  assert.match(
    bookingsHtml,
    /@click="cancel\(booking\)"[^>]*x-show="tab === 'upcoming' &amp;&amp; !hasStarted\(booking\)"/,
  );
});

test('cancelExpired is the same rule as canCancel, read from the open dialog', () => {
  const state = myBookings(async () => []);

  state.cancelTarget = bookingIn(5);
  assert.equal(state.cancelExpired(), false);
  state.cancelTarget = bookingIn(1);
  assert.equal(state.cancelExpired(), true);
  // No target at all is not "expired": the dialog is shut.
  state.cancelTarget = null;
  assert.equal(state.cancelExpired(), false);
});

test('a slow tab reply cannot land after a newer tab has been opened', async () => {
  const replies = [];
  const state = myBookings(() => new Promise((resolve) => replies.push(resolve)));

  const first = state.show('upcoming');
  const second = state.show('cancelled');
  // The slow first request answers only AFTER the second tab was asked for.
  replies[1](Object.assign([{ id: 3 }], { meta: { total: 1 } }));
  await second;
  replies[0](Object.assign([{ id: 9 }], { meta: { total: 1 } }));
  await first;

  assert.equal(state.tab, 'cancelled');
  assert.equal(state.bookings.length, 1);
  assert.equal(state.bookings[0].id, 3);
  // And the stale reply may not be cached under its tab either.
  assert.equal(state.cache.upcoming, undefined);
  assert.equal(state.loading, false);
});

test('a stale tab failure cannot raise an error over the tab that did load', async () => {
  const replies = [];
  const state = myBookings(
    () => new Promise((resolve, reject) => replies.push({ resolve, reject })),
  );

  const first = state.show('upcoming');
  const second = state.show('cancelled');
  replies[1].resolve(Object.assign([{ id: 3 }], { meta: { total: 1 } }));
  await second;
  replies[0].reject(new Error('Quá hạn.'));
  await first;

  assert.equal(state.error, '');
  assert.equal(state.bookings.length, 1);
  assert.equal(state.loading, false);
});

test('the stranded old appointment reaches the confirmation page as a standing banner', async () => {
  const state = myConfirmation(async () => ({ id: 91, status: 'pending' }), {
    id: '91',
    reschedule_failed: '55',
  });

  await state.init();

  assert.equal(state.rescheduleFailed, 55);
  // A banner, not a toast: it has to still be there when the reader looks for it.
  assert.match(confirmationHtml, /x-show="rescheduleFailed"/);
  assert.match(
    confirmationHtml,
    /Lịch mới đã được đặt, nhưng lịch cũ chưa hủy được — vui lòng liên hệ salon hoặc kiểm tra Lịch hẹn của tôi\./,
  );
  // Both ways out are offered, because which one applies depends on why the cancel failed.
  assert.match(confirmationHtml, /href="lich-hen-cua-toi\.html">Xem lịch hẹn của tôi<\/a>/);
  assert.match(confirmationHtml, /:href="'xac-nhan-dat-lich\.html\?id=' \+ rescheduleFailed"/);
});

test('an ordinary confirmation shows no banner', async () => {
  const state = myConfirmation(async () => ({ id: 91, status: 'pending' }), { id: '91' });

  await state.init();

  assert.equal(state.rescheduleFailed, 0);
});

test('the arrow marks the notification read before it navigates', async () => {
  const asked = [];
  const state = myNotifications(async (path, options) => {
    asked.push(path + ' ' + options.method);
    return { ok: true };
  });
  const item = { id: 3, type: 'booking', booking_id: 12, read: false, title: 'Lịch hẹn' };

  await state.open(item);

  assert.deepEqual(asked, ['/api/notifications/3/read PATCH']);
  assert.equal(item.read, true);
  assert.equal(state.location.href, 'xac-nhan-dat-lich.html?id=12');
});

test('the row button is never [disabled], so a read notification stays selectable', () => {
  // A disabled button swallows text selection, and a booking code is exactly the kind of
  // thing a reader copies out of a notification.
  assert.equal(notificationsHtml.includes(':disabled="item.read"'), false);
  assert.match(notificationsHtml, /:class="item\.read \? 'cursor-default' : ''"/);
  assert.match(notificationsHtml, /:aria-label="'Xem chi tiết: ' \+ item\.title"/);
  assert.match(notificationsHtml, /@click\.prevent="open\(item\)"/);
});

test('a load that never answered is not an empty list, and says so with a way out', () => {
  assert.match(bookingsHtml, /<template x-if="!loading &amp;&amp; error">/);
  assert.match(bookingsHtml, /@click="show\(tab\)"[^>]*>Thử lại</);
  assert.match(bookingsHtml, /x-if="!loading &amp;&amp; !error &amp;&amp; !bookings\.length"/);

  assert.match(notificationsHtml, /<template x-if="!loading &amp;&amp; error">/);
  assert.match(notificationsHtml, /@click="load\(\)"[^>]*>Thử lại</);
  assert.match(notificationsHtml, /x-show="!loading &amp;&amp; !error &amp;&amp; !items\.length"/);

  assert.match(favoritesHtml, /<template x-if="!loading &amp;&amp; error">/);
  assert.match(favoritesHtml, /x-if="!loading &amp;&amp; !error &amp;&amp; !salons\.length"/);
  assert.match(favoritesHtml, /x-if="!loading &amp;&amp; !error &amp;&amp; !services\.length"/);

  // The reviews page already spends `error` on the composer's star warning, so the load
  // carries its own name rather than overwriting a message about the form.
  assert.match(reviewsHtml, /<template x-if="!loading &amp;&amp; loadError">/);
  assert.match(reviewsHtml, /@click="reload\(\)"[^>]*>Thử lại</);
  assert.match(reviewsHtml, /x-if="!loading &amp;&amp; !loadError &amp;&amp; !reviews\.length"/);
});

test('a refused notifications load is held on the page and retried from it', async () => {
  let calls = 0;
  const state = myNotifications(async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error('Không kết nối được máy chủ, vui lòng thử lại.');
    }
    return [{ id: 1, read: false }];
  });

  await state.init();
  assert.equal(state.error, 'Không kết nối được máy chủ, vui lòng thử lại.');
  assert.equal(state.loading, false);
  // Not a toast: three seconds later there would be nothing left but an empty inbox.
  assert.deepEqual(state.toasts, []);

  await state.load();
  assert.equal(state.error, '');
  assert.equal(state.items.length, 1);
});

test('a refused reviews load never reads as a warning about the form', async () => {
  const state = myReviews(async () => {
    throw new Error('Không kết nối được máy chủ, vui lòng thử lại.');
  });

  await state.init();
  assert.equal(state.loadError, 'Không kết nối được máy chủ, vui lòng thử lại.');
  assert.equal(state.error, '');
  assert.equal(state.loading, false);
  assert.deepEqual(state.toasts, []);
});

test('the heading and the tab strip stand before the session answers', () => {
  for (const name of ['ho-so-ca-nhan.html', 'cai-dat.html']) {
    const html = page(name);
    const gate = html.indexOf('<template x-if="user">');
    assert.ok(gate !== -1, name + ': no session gate at all');
    // Neither of them reads the session, so neither may wait on it.
    assert.ok(html.indexOf('<h1') < gate, name + ': the heading waits on the session');
    assert.ok(html.indexOf('data-oak-account-tabs') < gate, name + ': the strip waits on it');
  }
  // Notifications gated its whole <main>; only the rows do now.
  assert.doesNotMatch(notificationsHtml, /<main[^>]*x-show="user"/);
  assert.match(notificationsHtml, /<div class="flex flex-col gap-3" x-cloak="" x-show="user">/);
  // Its empty state is an x-show div rather than a template, so without x-cloak it would
  // paint "Chưa có thông báo nào" over a full inbox until Alpine boots.
  assert.match(
    notificationsHtml,
    /<div class="bg-surface-container-low rounded-lg py-16 px-6 text-center" x-cloak="" x-show="!loading &amp;&amp; !error &amp;&amp; !items\.length">/,
  );
});

test('"Đặt lại" keeps the technician the appointment named, and "Đổi lịch" with it', () => {
  const state = myBookings(async () => []);
  const booking = bookingIn(48);

  // A booking without one is unchanged: staff is LEFT JOINed on the server.
  assert.equal(state.rebookUrl(booking), 'dat-lich.html?service_id=7&salon_id=4');

  // The rebook marker is what lets the wizard say "Lần trước bạn làm với Mai": arriving with
  // a staff_id from a profile link or a salon's team strip is not a return visit, so the
  // note is silent there and only a genuine "Đặt lại" turns it on.
  booking.staff = { id: 3, name: 'Mai' };
  assert.equal(
    state.rebookUrl(booking),
    'dat-lich.html?service_id=7&salon_id=4&staff_id=3&rebook=1',
  );
  // A reschedule is a return visit with the same person, so it inherits the marker.
  assert.equal(
    state.rescheduleUrl(booking),
    'dat-lich.html?service_id=7&salon_id=4&staff_id=3&rebook=1&reschedule=12',
  );

  // And the completed card names that technician, so the preselection is not a surprise.
  assert.match(
    bookingsHtml,
    /x-show="booking\.staff &amp;&amp; booking\.status === 'completed'"><span>KTV:<\/span>/,
  );
  const dictionary = JSON.parse(
    fs.readFileSync(path.join(root, 'tools', 'i18n', 'parts', 'lich-hen-cua-toi.json'), 'utf8'),
  );
  assert.ok(dictionary['KTV:']);
});

test('the empty cards carry the marker of the pattern they were lifted from', () => {
  // yeu-thich.html is where that pattern started, so it is marked there too.
  assert.equal(favoritesHtml.split('<!-- OAK-EMPTY -->').length - 1, 2);
  assert.equal(bookingsHtml.split('<!-- OAK-EMPTY -->').length - 1, 1);
  assert.equal(reviewsHtml.split('<!-- OAK-EMPTY -->').length - 1, 1);
  assert.equal(notificationsHtml.split('<!-- OAK-EMPTY -->').length - 1, 1);
});

test('the account rail is static markup on every page, gated by nothing', () => {
  for (const name of ACCOUNT_PAGES) {
    const html = page(name);
    const rail = html.indexOf('<aside class="hidden md:block w-72');
    const template = html.lastIndexOf('<template', rail);
    // Either there is no template before the rail at all, or it was already closed:
    // the rail must never sit inside an x-if that waits on the session.
    const open = template === -1 ? -1 : html.indexOf('</template>', template);
    assert.ok(template === -1 || (open !== -1 && open < rail), name + ': rail is inside a template');
  }
});
