import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const html = fs.readFileSync(path.join(root, 'ui', 'dat-lich.html'), 'utf8');

/* The factory is inline in the page, so lift it out of its <script> to drive it here.
   The slice starts at oakToday() because loadSlots() leans on the helpers above it.

   `search` is the query string the page was opened with, and there is exactly ONE of it:
   OAK.qs() reads it and history.replaceState() writes it, the way the browser wires the
   two together. Keeping them apart — a frozen object to read, a list to write — is what
   let a bug through where the page rewrote the url and then read its own rewrite back.
   `state.urls` is the harness's record of every write, not part of the component.
   sessionStorage is stubbed because restoreForm() reads it during init().
   `location.href` and `state.toasts` are records of the same kind, for what submit() does
   at the end; setTimeout fires at once, so the pause that leaves a warning readable costs
   the test nothing. */
function bookingForm(api, search = '') {
  const tail = html.slice(html.indexOf('function oakToday()'));
  const script = tail.slice(0, tail.indexOf('</script>'));
  const context = {
    URLSearchParams,
    urls: [],
    toasts: [],
    location: { search, href: '' },
    setTimeout: (fn) => fn(),
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    OAK: {
      api,
      toast: (message, type) => context.toasts.push([message, type]),
      me: async () => null,
      qs: (name) => new URLSearchParams(context.location.search).get(name),
      // A reader who asked for less motion gets 'auto'; nothing here cares which.
      scrollBehavior: () => 'smooth',
      // The shipped one is driven by fmt-date-ui.test.mjs; here it only has to answer.
      hasStarted: (booking) =>
        Date.now() >= new Date(booking.date + 'T' + booking.time + ':00').getTime(),
    },
    // init() listens for the language switch so the note survives the reload it causes.
    window: { addEventListener: (name, handler) => context.listeners.push([name, handler]) },
    listeners: [],
  };
  context.history = {
    replaceState: (state, title, url) => {
      context.urls.push(url);
      const mark = String(url).indexOf('?');
      context.location.search = mark === -1 ? '' : String(url).slice(mark);
    },
  };
  vm.runInNewContext(`${script}\nresult = oakBookingForm();`, context);
  context.result.urls = context.urls;
  context.result.toasts = context.toasts;
  context.result.location = context.location;
  /* The page's own window.OAK, so a test can say what this browser has. It carries no
     track() by default — the browser served a page from cache that meets an oak-api.js
     from before measurement existed — which is the case every other test here runs in. */
  context.result.oak = context.OAK;
  context.result.listeners = context.listeners;
  context.result.storage = context.sessionStorage;
  /* Alpine's two magics this component uses: goTo() scrolls the wizard into view and then
     hands focus to the heading of the step it opened. A test that cares about either
     replaces them. */
  context.result.$root = { scrollIntoView: () => {}, querySelectorAll: () => [] };
  context.result.$nextTick = (fn) => fn();
  /* x-ref="authPanel" is step 4's own sign-in panel, which submit() brings to a signed-out
     visitor rather than leaving the page for. Both things it does to that node are recorded
     rather than performed, because neither has any meaning outside a browser. */
  const panel = {
    scrolled: [],
    focused: 0,
    scrollIntoView: (options) => panel.scrolled.push(options),
    querySelector: () => ({ focus: () => { panel.focused += 1; } }),
  };
  context.result.$refs = { authPanel: panel };
  return context.result;
}

/** A form filled in far enough for submit() to reach the POST. */
function readyToSubmit(state) {
  state.user = { id: 1, name: 'Ngọc Anh' };
  state.loading = false;
  state.salon = { id: 4 };
  state.service = { id: 7, name: 'Nail Gel Hàn Quốc', price: 350000 };
  state.date = '2099-01-01';
  state.time = '09:00';
  state.form = { name: 'Ngọc Anh', phone: '0901234567', note: '' };
  return state;
}

const pad = (value) => String(value).padStart(2, '0');

/** The appointment a ?reschedule visit is moving: live, and far enough off to be movable. */
function liveBooking(extra) {
  return {
    id: 55,
    code: 'OAK-ABC123',
    status: 'confirmed',
    date: '2099-08-23',
    time: '14:30',
    total_price: 280000,
    note: 'Ghi chú cũ',
    customer_name: 'Ngọc Anh',
    customer_phone: '0901234567',
    service: { id: 7, name: 'Nail Gel Hàn Quốc', duration_min: 60 },
    salon: { id: 4, name: 'Lala Nail Studio' },
    ...extra,
  };
}

/** Today the way the page computes it, so a stub can answer the day strip's own dates. */
function todayISO() {
  const now = new Date();
  return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
}

/** Local, like the page's own date helpers: toISOString() would roll over in UTC+7. */
function addDaysISO(iso, days) {
  const date = new Date(iso + 'T00:00:00');
  date.setDate(date.getDate() + days);
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
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

test('every selection change writes the url, so a reload comes back to the same wizard', async () => {
  const state = bookingForm(async () => ({ slots: [{ time: '09:00', available: true }] }));

  state.chooseSalon({ id: 4, name: 'Lala Nail Studio' });
  assert.equal(state.urls.at(-1), 'dat-lich.html?salon_id=4');

  state.service = { id: 7, name: 'Nail Gel Hàn Quốc', price: 350000 };
  // A future date, so today's "hour already started" clamp cannot filter the slot away.
  state.date = '2099-01-01';
  await state.loadSlots();
  assert.equal(state.urls.at(-1), 'dat-lich.html?service_id=7&salon_id=4&date=2099-01-01');

  state.pickTime('09:00');
  assert.equal(
    state.urls.at(-1),
    'dat-lich.html?service_id=7&salon_id=4&date=2099-01-01&time=09%3A00',
  );
});

test('a time carried in from another page that is no longer free is named, not dropped', async () => {
  const state = bookingForm(
    async (path) => {
      if (path.startsWith('/api/salons?')) {
        return Object.assign([], { meta: { total: 0 } });
      }
      if (path === '/api/services/7') {
        return { id: 7, name: 'Nail Gel Hàn Quốc', price: 350000, salon: { id: 4 } };
      }
      if (path === '/api/services/7/availability?date=2099-01-01') {
        return { slots: [{ time: '09:00', available: false }, { time: '10:00', available: true }] };
      }
      if (path.includes('availability')) {
        // ?days is the day strip asking; the bare ?date is the slot grid.
        return path.includes('days=') ? { week: [] } : { slots: [] };
      }
      return [];
    },
    '?service_id=7&salon_id=4&date=2099-01-01&time=09%3A00',
  );

  await state.init();

  assert.equal(state.time, '');
  assert.equal(state.step, 3);
  assert.equal(state.stepError, 'Khung giờ bạn chọn không còn trống, vui lòng chọn giờ khác.');
  // The url that F5 would reload no longer carries the time that just went away.
  assert.equal(state.urls.at(-1).includes('time='), false);
});

test('the day strip marks a day with nothing bookable as full', async () => {
  const today = todayISO();
  const tomorrow = addDaysISO(today, 1);
  const asked = [];
  // Both endpoints answer ?days in the week shape, so one stub serves either branch.
  const state = bookingForm(async (path) => {
    asked.push(path);
    return {
      week: Array.from({ length: 7 }, (all, offset) => {
        const date = addDaysISO(today, offset);
        return { date, slots: [{ time: '09:00', available: date !== tomorrow }] };
      }),
    };
  });
  state.service = { id: 7, name: 'Nail Gel Hàn Quốc', price: 350000 };

  await state.loadDayChips();

  assert.equal(state.dayChips.length, 7);
  // One round trip for the whole strip, not one per day.
  assert.equal(asked.length, 1);
  assert.equal(asked[0], '/api/services/7/availability?days=7&from=' + today);
  assert.equal(state.dayChips[0].weekday, 'Hôm nay');
  assert.equal(state.dayChips[1].date, tomorrow);
  assert.equal(state.dayChips[1].full, true);
  assert.equal(state.dayChips[2].full, false);

  // A chosen technician swaps the endpoint, not the shape or the number of requests.
  asked.length = 0;
  state.staffId = 3;
  await state.loadDayChips();
  assert.equal(asked.length, 1);
  assert.equal(
    asked[0],
    '/api/staff/3/availability?days=7&from=' + today + '&service_id=7',
  );
});

test('a guest is warned before the final click, without changing the submit path', () => {
  assert.match(html, /x-show="!loading &amp;&amp; !user"/);
  assert.match(html, /Đăng nhập &amp; xác nhận/);
  // The url + sessionStorage handover is what makes the warning safe to act on.
  assert.match(html, /history\.replaceState\(null, '', this\.selectionUrl\(\)\)/);
  assert.match(html, /sessionStorage\.setItem\(OAK_BOOKING_FORM_KEY/);
});

test('the last click of the funnel stays inside the funnel when nobody is signed in', async () => {
  const calls = [];
  const state = readyToSubmit(bookingForm(async (path) => {
    calls.push(path);
    return { id: 91 };
  }));
  state.user = null;
  let leftThePage = 0;
  state.oak.requireLogin = async () => { leftThePage += 1; };

  await state.submit();

  /* Step 4 signs a visitor in where they are standing, and the two confirm buttons are a
     screenful from that panel. Sending them to the login page instead was the last click
     of the funnel navigating out of the funnel — and back through a round trip whose only
     job was to return them to this same step. */
  assert.equal(leftThePage, 0);
  assert.equal(calls.length, 0);
  assert.equal(state.$refs.authPanel.scrolled.length, 1);
  assert.equal(state.$refs.authPanel.scrolled[0].behavior, 'smooth');
  assert.equal(state.$refs.authPanel.focused, 1);
  // The selection still goes into the url, because the panel keeps one door that does
  // leave the page: a forgotten password needs the mail round trip the full page owns.
  assert.match(state.urls.at(-1), /service_id=7/);
  assert.match(html, /href="dang-nhap-nguoi-dung\.html">Quên mật khẩu\?<\/a>/);
});

test('the reschedule id and the promo code both survive the url the page rewrites', async () => {
  const state = bookingForm(
    async (path) => {
      if (path.startsWith('/api/salons?')) {
        return Object.assign([], { meta: { total: 0 } });
      }
      if (path === '/api/services/7') {
        return { id: 7, name: 'Nail Gel Hàn Quốc', price: 350000, salon: { id: 4 } };
      }
      if (path.includes('availability')) {
        return path.includes('days=') ? { week: [] } : { slots: [] };
      }
      if (path === '/api/bookings/55') {
        return liveBooking();
      }
      return [];
    },
    '?service_id=7&salon_id=4&promo=OAKNEW20&reschedule=55',
  );

  await state.init();

  assert.equal(state.reschedule, 55);
  assert.equal(state.promo, 'OAKNEW20');
  // init() rewrites location.search several times over; neither value may be lost there,
  // because the url is the only thing that carries them across a login round trip.
  assert.match(state.location.search, /reschedule=55/);
  assert.match(state.location.search, /promo=OAKNEW20/);
  assert.match(state.selectionUrl(), /reschedule=55/);
});

test('a booking that is not a reschedule cancels nothing', async () => {
  const calls = [];
  const state = readyToSubmit(bookingForm(async (path, options) => {
    calls.push(path + ' ' + ((options && options.method) || 'GET'));
    return { id: 91 };
  }));

  await state.submit();

  assert.deepEqual(calls, ['/api/bookings POST']);
  assert.equal(state.location.href, 'xac-nhan-dat-lich.html?id=91');
});

test('a reschedule is one request against the appointment it replaces, and never a cancel', async () => {
  const calls = [];
  const state = readyToSubmit(bookingForm(async (path, options) => {
    calls.push({ path, options });
    return { id: 91, replaced_booking_id: 55 };
  }));
  state.reschedule = 55;
  state.staffId = 3;

  await state.submit();

  /* One call, and it is the move. This used to POST the new appointment and then PATCH a
     cancel onto the old one — and the salon's own cancel window could refuse that second
     call, leaving the visitor holding two live appointments and no way to drop either. */
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/bookings/55/reschedule');
  assert.equal(calls[0].options.method, 'PATCH');
  /* Only the hour. The service, the note and the price already agreed come off the old
     appointment on the server, so sending them here would be the client restating them.
     Read key by key: the body is built inside the vm's own realm, and a deep-equal against
     one of ours compares prototypes rather than what was sent. */
  const sent = calls[0].options.body;
  assert.deepEqual(Object.keys(sent).sort(), ['date', 'note', 'staff_id', 'time']);
  assert.equal(sent.date, '2099-01-01');
  assert.equal(sent.time, '09:00');
  assert.equal(sent.staff_id, 3);
  // staff_id is always sent, and the note with it: absent would mean "leave the technician
  // alone", which is not what a wizard that has just drawn a technician picker means.
  assert.equal(sent.note, null);
  assert.equal(state.location.href, 'xac-nhan-dat-lich.html?id=91');
});

test('nothing in the page still knows how to strand an appointment', () => {
  // The two-request move is gone, and so is everything that existed to explain its middle
  // outcome: no cancel from here, and nothing handed to the confirmation page about one.
  assert.doesNotMatch(html, /dropOldBooking|reschedule_failed/);
});

test('the reschedule notice is gated on the state the url sets, not on a step', () => {
  assert.match(html, /x-show="reschedule"/);
  assert.match(html, /Bạn đang đổi lịch hẹn — lịch cũ sẽ được hủy sau khi bạn xác nhận lịch mới\./);
});

test('reschedule survives a whole chain of interactions, each of which rewrites the url', async () => {
  const state = bookingForm(
    async () => ({ slots: [{ time: '09:00', available: true }] }),
    '?reschedule=55',
  );
  // Set the way init() sets it; that init() reads it from the url is the test above.
  state.reschedule = 55;

  // Every one of these calls syncUrl(), and syncUrl() overwrites location.search whole.
  state.chooseSalon({ id: 4, name: 'Lala Nail Studio' });
  state.service = { id: 7, name: 'Nail Gel Hàn Quốc', price: 350000 };
  state.date = '2099-01-01';
  await state.loadSlots();
  state.pickTime('09:00');
  state.goTo(4);
  state.goTo(3);

  for (const url of state.urls) {
    assert.match(url, /reschedule=55/, 'dropped from ' + url);
  }
  // And the url the page would be reloaded from still carries it.
  assert.match(state.location.search, /reschedule=55/);
});

test('the wizard states the booking terms it actually has, and no membership tier', () => {
  // There is no tier, no points table and no loyalty endpoint anywhere in the codebase,
  // so threatening one at the moment of commitment was a threat about nothing.
  assert.doesNotMatch(html, /hạng thẻ/);
  // The three conditions are spelled once per page and identically, so the salon page, the
  // service page, the wizard and the confirmation page cannot word the same promise four
  // different ways — and the cutoff inside it is the one this salon set.
  assert.equal(
    html.split('x-text="OAK.TRUST.cancelPolicy(salon ? salon.cancel_cutoff_hours : 0)"').length - 1,
    2,
  );
  assert.equal(html.split('x-text="OAK.TRUST.PAYMENT"').length - 1, 3);
  assert.match(html, /Điều kiện đặt lịch/);
  assert.match(html, /href="dieu-khoan\.html#huy-lich"/);
});

test('payment is stated rather than offered as a choice that has none', () => {
  // One label, no input, a radio drawn in <div>s: the control could not be operated and
  // the page hard-codes payment_method anyway.
  assert.doesNotMatch(html, /Phương thức thanh toán/);
  assert.doesNotMatch(html, /rounded-full border-2 border-primary/);
  assert.match(html, /payment_method: 'at_salon'/);
});

test('the wizard carries its own copy of the total and the button that acts on it', () => {
  /* Below lg the sidebar — the total, and the only button that confirms — sits after the
     whole form, a screenful past the choice being made. So the pair is pinned to the
     bottom edge as well. data-oak-sticky-cta is what a toast reads to sit above it. */
  assert.match(html, /class="fixed bottom-0 inset-x-0 z-40 lg:hidden[^"]*" data-oak-sticky-cta/);
  // Nothing to pin until there is something to pay for, and step 1 has no button to offer
  // — nor when the move this page opened for is already over and the wizard is not drawn.
  assert.match(html, /x-show="service &amp;&amp; step > 1 &amp;&amp; !rescheduleClosed"/);
  // The three things it says, each its own text node so English needs no rule for a
  // sentence assembled at runtime.
  assert.match(html, /x-text="service \? service\.name : ''"/);
  assert.match(html, /x-text="service \? service\.duration_min \+ ' phút' : ''"/);
  assert.match(html, /x-text="quote \? OAK\.fmtPrice\(quote\.total\) : '—'"/);
  // The sidebar's own controls, not new ones: the same calls, the same busy states.
  assert.match(html, /@click="next\(\)"[^>]*x-show="step !== 4"/);
  assert.match(html, /@click="submit\(\)"[^>]*x-show="step === 4"/);
  /* And the room it needs, so the last thing on the page is never underneath it: <main>
     already ends in 120px of section gap, which clears the ~68px bar on its own. */
  assert.match(html, /<main class="pt-24 flex-grow pb-section-gap/);
});

test('a step 3 that refuses to advance says so where the tap happened', async () => {
  /* The sticky button is reachable from any scroll position, including a screenful below
     the error paragraph, so setting stepError is not on its own visible feedback. */
  const state = bookingForm(async () => []);
  const scrolls = [];
  const flush = [];
  state.$nextTick = (fn) => flush.push(fn);
  state.$refs = { stepError: { scrollIntoView: (options) => scrolls.push(options) } };
  state.step = 3;
  state.date = '2099-01-01';
  state.time = null;

  state.next();

  assert.equal(state.step, 3);
  assert.equal(state.stepError, 'Vui lòng chọn ngày và giờ hẹn.');
  /* Not yet: x-show still has the paragraph at display:none until Alpine flushes, and an
     element with no box does not scroll — which is the very first tap this is for. */
  assert.equal(scrolls.length, 0);
  flush.forEach((fn) => fn());
  assert.equal(scrolls.length, 1);
  assert.equal(scrolls[0].block, 'center');
});

test('everything picked at a decision point is at least 44px tall', () => {
  /* An hour chip mis-tapped is an appointment at the wrong time. The day strip above it
     was already 44px; the hours below it were 32. */
  assert.match(html, /class="min-h-\[44px\] px-5 py-2 border rounded-full[^"]*" type="button" x-text="slot\.time"/);
  // At 360px four full step names crowd into one row, so only the current one keeps its.
  assert.match(html, /'hidden sm:inline font-caption text-caption text-on-surface-variant'/);
  /* Which leaves the step buttons with nothing visible to name them below sm — a done step
     shows only an aria-hidden tick — and nothing to give them height. Both are put back on
     the button itself, so hiding the label costs neither a name nor a target. */
  assert.match(html, /:aria-label="item\.label"/);
  assert.match(html, /class="flex flex-col items-center justify-center gap-2 min-h-\[44px\] bg-background px-4"/);
});

test('a wizard opened and a booking made are counted; nothing else is', async () => {
  const state = bookingForm(async (path) => {
    if (path.startsWith('/api/salons?')) {
      return Object.assign([], { meta: { total: 0 } });
    }
    if (path === '/api/bookings') {
      return { id: 91 };
    }
    return [];
  });
  const events = [];
  state.oak.track = (name) => events.push(name);

  await state.init();
  assert.deepEqual(events, ['wizard_start']);

  readyToSubmit(state);
  await state.submit();

  assert.deepEqual(events, ['wizard_start', 'booking_submit']);
  assert.equal(state.location.href, 'xac-nhan-dat-lich.html?id=91');
});

test('a booking the server refused is not counted as a booking', async () => {
  const state = readyToSubmit(bookingForm(async () => {
    throw new Error('Khung giờ này vừa có người đặt.');
  }));
  const events = [];
  state.oak.track = (name) => events.push(name);

  await state.submit();

  assert.deepEqual(events, []);
});

test('a browser whose oak-api.js has no track() still books', async () => {
  /* Every other test in this file already runs without track(); this one says so out
     loud, because measurement that breaks a booking is worse than no measurement. */
  const state = readyToSubmit(bookingForm(async () => ({ id: 91 })));
  assert.equal(state.oak.track, undefined);

  await assert.doesNotReject(() => state.submit());
  assert.equal(state.location.href, 'xac-nhan-dat-lich.html?id=91');
});

test('a technician chosen with the chip on her card is counted, and "Bất kỳ" is not', () => {
  /* Every picker card carries `claimed` — whether a real OAK account stands behind the chair
     — and the ✓ chip that marks it is what this counts having been chosen by. The service
     page's own picker fires the same event; track() sends the page, so one name serves both. */
  const state = bookingForm(async () => Object.assign([], { meta: { total: 0 } }));
  const events = [];
  state.oak.track = (name, meta) => events.push([name, meta]);
  state.staffList = [
    { id: 7, name: 'Mai Chi', claimed: true, title: 'KTV', rating: 4.8 },
    { id: 8, name: 'Chị Hoa', claimed: false, title: 'KTV', rating: 4.6 },
  ];

  state.setStaff(7);
  assert.deepEqual(events, [['staff_verified_pick', undefined]]);

  // A row the salon typed into its roster carries no chip, and "Bất kỳ" is not a person.
  state.setStaff(8);
  state.setStaff(null);
  assert.equal(events.length, 1);
});

test('a wizard whose oak-api.js has no track() still picks a technician', () => {
  const state = bookingForm(async () => []);
  assert.equal(state.oak.track, undefined);
  state.staffList = [{ id: 7, name: 'Mai Chi', claimed: true }];

  assert.doesNotThrow(() => state.setStaff(7));
  assert.equal(state.staffId, 7);
});

test('"Bất kỳ" says what it will do, and every technician is a card with a face', () => {
  /* A booking that names nobody now reserves somebody, so the chip has to stop reading as
     "no technician" — and the people it is chosen against need more than a name. */
  assert.match(html, /Hệ thống sẽ xếp kỹ thuật viên rảnh/);
  assert.match(html, /data-icon="group"/);
  assert.match(html, /x-text="staffMeta\(member\)"/);
  // The fallback for a technician with no photo, and the note that explains a pre-pick.
  assert.match(html, /<template x-if="!member\.image">/);
  assert.match(html, /x-show="rebookStaffId &amp;&amp; staffId === rebookStaffId"/);
});

test('a technician arriving in the url is remembered as a rebook only when marked', async () => {
  const stub = async (path) => {
    if (path.startsWith('/api/salons?')) {
      return Object.assign([], { meta: { total: 0 } });
    }
    if (path === '/api/services/7') {
      return { id: 7, name: 'Nail Gel Hàn Quốc', price: 350000, salon: { id: 4 } };
    }
    if (path === '/api/services/7/staff') {
      return [{ id: 3, name: 'Minh Hằng', title: 'Chuyên viên Nail', rating: 4.8 }];
    }
    if (path.includes('availability')) {
      return path.includes('days=') ? { week: [] } : { slots: [] };
    }
    return [];
  };

  /* A specialist's profile and a salon's team strip both link here with a staff_id, and
     their visitor may never have booked at OAK. Pre-selecting them is right; telling them
     they were here before is not, so the note waits for the marker "Đặt lại" adds. */
  const fromProfile = bookingForm(stub, '?service_id=7&salon_id=4&staff_id=3');
  await fromProfile.init();
  assert.equal(fromProfile.staffId, 3);
  assert.equal(fromProfile.rebookStaffId, null);
  assert.equal(
    fromProfile.staffMeta({ title: 'Chuyên viên Nail', rating: 4.8 }),
    'Chuyên viên Nail · 4.8',
  );

  const state = bookingForm(stub, '?service_id=7&salon_id=4&staff_id=3&rebook=1');
  await state.init();
  assert.equal(state.staffId, 3);
  assert.equal(state.rebookStaffId, 3);
  // Picking somebody else drops the note without dropping the record of how they arrived.
  state.setStaff(null);
  assert.equal(state.rebookStaffId, 3);
  assert.equal(state.staffId, null);
});

test('the hours are split by part of the day, and empty parts are left out', () => {
  const state = bookingForm(async () => []);
  state.slots = [
    { time: '09:00', available: true },
    { time: '11:30', available: false },
    { time: '17:00', available: true },
    { time: '19:30', available: true },
  ];

  // Array.from, because the component builds its arrays inside the vm and a strict
  // deepEqual compares prototypes as well as contents.
  const groups = Array.from(state.slotGroups());
  assert.deepEqual(groups.map((group) => group.label), ['Sáng', 'Tối']);
  assert.deepEqual(Array.from(groups[0].slots, (slot) => slot.time), ['09:00', '11:30']);
  // 17:00 is the first evening hour, not the last afternoon one.
  assert.deepEqual(Array.from(groups[1].slots, (slot) => slot.time), ['17:00', '19:30']);
});

test('a day with nothing left offers the nearest day that has something', () => {
  const state = bookingForm(async () => []);
  state.date = '2099-01-01';
  state.dayChips = [
    { date: '2099-01-01', weekday: 'Hôm nay', day: '01/01', full: true },
    { date: '2099-01-02', weekday: 'Thứ 6', day: '02/01', full: true },
    { date: '2099-01-03', weekday: 'Thứ 7', day: '03/01', full: false },
  ];

  assert.equal(state.nextFreeDay().date, '2099-01-03');
  // The day on screen is never offered as the way off itself, full or not.
  state.date = '2099-01-03';
  assert.equal(state.nextFreeDay(), null);
  assert.match(html, /Ngày gần nhất còn chỗ/);
  assert.match(html, /@click="pickDate\(nextFreeDay\(\)\.date\)"/);
});

test('an hour dropped by a new service or technician is named; one dropped by a new day is not', async () => {
  let free = true;
  const state = bookingForm(async () => ({
    slots: [{ time: '09:00', available: free }, { time: '10:00', available: true }],
  }));
  state.service = { id: 7, name: 'Nail Gel Hàn Quốc', price: 350000 };
  state.date = '2099-01-01';
  state.time = '09:00';

  // The same hour, still on offer: nothing to say.
  await state.loadSlots();
  assert.equal(state.time, '09:00');
  assert.equal(state.stepError, '');

  // Gone, and not because the day changed — the grid looks the same, so it has to be said.
  free = false;
  await state.loadSlots();
  assert.equal(state.time, '');
  assert.equal(state.stepError, 'Khung giờ bạn chọn không còn trống, vui lòng chọn giờ khác.');

  // A different day is expected to have different hours, so losing one is not news.
  state.time = '09:00';
  state.stepError = '';
  await state.loadSlots(true);
  assert.equal(state.time, '');
  assert.equal(state.stepError, '');

  // And a request that never arrived knows nothing about the hour: the retry line is the
  // only true thing to say, so it is not joined by a claim that the hour went.
  const offline = bookingForm(async () => {
    throw new Error('offline');
  });
  offline.service = { id: 7, name: 'Nail Gel Hàn Quốc', price: 350000 };
  offline.date = '2099-01-01';
  offline.time = '09:00';
  await offline.loadSlots();
  assert.equal(offline.slotsError, 'Không tải được khung giờ trống.');
  assert.equal(offline.time, '');
  assert.equal(offline.stepError, '');
});

test('moving between steps hands focus to the heading of the step that opened', () => {
  /* Step 3 marks two headings — the technician picker, then the clock below it — so the
     one focus lands on is the first that is actually rendered, not the first in source
     order and not always the last. `offsetParent` is how a hidden one says so. */
  const focused = [];
  const state = bookingForm(async () => []);
  const heading = (name, shown) => ({
    name,
    offsetParent: shown ? {} : null,
    focus: () => focused.push(name),
  });
  let rendered = [heading('staff', true), heading('time', true)];
  state.$root = {
    scrollIntoView: () => {},
    querySelectorAll: (selector) =>
      selector === '[data-step-heading="3"]' ? rendered : [],
  };
  state.salon = { id: 4 };
  state.service = { id: 7 };

  state.goTo(3);
  assert.deepEqual(focused, ['staff']);

  // A salon with no roster hides the picker, and the clock takes the focus instead.
  rendered = [heading('staff', false), heading('time', true)];
  state.goTo(2);
  state.goTo(3);
  assert.deepEqual(focused, ['staff', 'time']);

  // Which only works if there is something to focus: one marked heading per step.
  for (const step of [1, 2, 3, 4]) {
    assert.match(html, new RegExp('data-step-heading="' + step + '" tabindex="-1"'));
  }
});

test('the reschedule banner names the appointment being replaced, and survives not knowing', async () => {
  const state = bookingForm(
    async (path) => {
      if (path.startsWith('/api/salons?')) {
        return Object.assign([], { meta: { total: 0 } });
      }
      if (path === '/api/bookings/55') {
        return liveBooking();
      }
      return [];
    },
    '?reschedule=55',
  );

  await state.init();

  assert.equal(state.rescheduleOld.code, 'OAK-ABC123');
  assert.equal(state.oldWhenLabel(), '23/08 14:30');
  // Each half is its own node, so English needs no rule for a sentence built at runtime.
  assert.match(html, /<span>Đang đổi lịch<\/span>/);
  assert.match(html, /x-text="oldWhenLabel\(\)"/);
  /* And what the move carries over rather than asking twice: the details the salon was
     already given for this visit, and the words written with it. The note goes into the
     box, because it is the one of the three that stays editable. */
  assert.equal(state.form.name, 'Ngọc Anh');
  assert.equal(state.form.phone, '0901234567');
  assert.equal(state.form.note, 'Ghi chú cũ');
  /* Locked, because they are being carried over rather than asked for — but only once
     there is something to lock: a booking that somehow carries no number would otherwise
     leave the reader in front of a required field they cannot fill. */
  assert.ok(html.includes(':readonly="!!(reschedule &amp;&amp; form.name)"'));
  assert.ok(html.includes(':readonly="!!(reschedule &amp;&amp; form.phone)"'));

  // A booking that cannot be read leaves the standing notice alone rather than erroring.
  const blind = bookingForm(async () => {
    throw new Error('Không tìm thấy lịch hẹn.');
  }, '?reschedule=55');
  blind.reschedule = 55;
  await blind.loadRescheduleOld();
  assert.equal(blind.rescheduleOld, null);
  assert.equal(blind.rescheduleClosed, false);
});

test('an appointment that can no longer be moved gets the refusal instead of a wizard', async () => {
  for (const gone of [{ status: 'cancelled' }, { date: '2000-01-01', time: '09:00' }]) {
    const asked = [];
    const state = bookingForm(
      async (path) => {
        asked.push(path);
        if (path === '/api/bookings/55') {
          return liveBooking(gone);
        }
        return path.includes('availability') ? { slots: [] } : [];
      },
      '?service_id=7&salon_id=4&reschedule=55',
    );

    await state.init();

    /* The salon settled it, or it has begun. Either way every hour this page could go on to
       offer is an hour the server is going to refuse, so the wizard is not drawn at all —
       and nothing is fetched for it. Finding this out after four steps and a confirm is
       finding it out in the worst place there is. */
    assert.equal(state.rescheduleClosed, true);
    assert.equal(state.loading, false);
    assert.deepEqual(asked, ['/api/bookings/55']);
  }
  // The standing banner that takes the wizard's place, and the one way on from it.
  assert.match(html, /x-show="rescheduleClosed"/);
  assert.match(html, /Lịch hẹn này không thể đổi giờ nữa\./);
  assert.match(html, /href="lich-hen-cua-toi\.html">Xem lịch hẹn của tôi<\/a>/);
});

test('the grids a move reads leave the appointment being moved out of them', async () => {
  const asked = [];
  const state = bookingForm(async (path) => {
    asked.push(path);
    if (path.startsWith('/api/bookings/55')) {
      return liveBooking();
    }
    return path.includes('days=') ? { week: [] } : { slots: [] };
  });
  state.service = { id: 7, name: 'Nail Gel Hàn Quốc', price: 350000, duration_min: 60 };
  state.date = '2099-01-01';
  state.reschedule = 55;

  await state.loadSlots();
  await state.loadDayChips();

  /* A 60-minute booking at 10:00 covers 10:30, so a grid that still counted it would mark
     the half-hour beside it taken — by the very person asking to move onto it. The server
     honours ?except only for the customer whose booking it is, so the grid the hour is
     picked from and the answer at the end are the same answer. */
  assert.ok(asked.every((path) => path.includes('&except=55')), asked.join(' '));

  // …and a booking that is not a move asks for nothing of the sort.
  const plain = [];
  const fresh = bookingForm(async (path) => {
    plain.push(path);
    return path.includes('days=') ? { week: [] } : { slots: [] };
  });
  fresh.service = { id: 7, name: 'Nail Gel Hàn Quốc', price: 350000, duration_min: 60 };
  fresh.date = '2099-01-01';
  await fresh.loadSlots();
  assert.ok(plain.every((path) => !path.includes('except')), plain.join(' '));
});

test('a move is priced at what was already agreed, and offers no second discount', async () => {
  const asked = [];
  const state = bookingForm(async (path) => {
    asked.push(path);
    return [];
  });
  state.user = { id: 1, name: 'Ngọc Anh' };
  state.service = { id: 7, name: 'Nail Gel Hàn Quốc', price: 350000 };
  state.reschedule = 55;
  state.rescheduleOld = liveBooking();

  await state.loadQuote();

  /* The quote endpoint would answer today's list price, which is the wrong number for
     anybody whose first booking was bought with a code — that code is not on the row to
     apply a second time, and the server prices the move at the figure already settled. */
  assert.deepEqual(asked, []);
  assert.equal(state.quote.total, 280000);
  assert.equal(state.quote.items.length, 1);
  assert.equal(state.quote.items[0].amount, 280000);
  // So there is nothing for a promo box to do, and it is not drawn.
  assert.match(html, /<div x-cloak="" x-show="!reschedule">\n<label[^>]*for="promo-code"/);
});

test('the service of a move is stated rather than offered', () => {
  // A different service is a different appointment — and the price riding along is the
  // price of THIS work, so step 2 has nothing to ask.
  assert.match(html, /<div class="space-y-8" x-cloak="" x-show="reschedule">/);
  assert.match(html, /<div class="space-y-8" x-show="!reschedule">/);
  // Its own heading, because goTo() hands focus to whichever of a step's headings is on
  // screen — the picker's would be the hidden one.
  assert.equal(html.match(/data-step-heading="2"/g).length, 2);
  assert.match(html, /Giữ nguyên dịch vụ của lịch cũ/);
});

test('a guest signs up inside the wizard and lands on the confirmation, never on another page', async () => {
  const calls = [];
  let registerBody = null;
  const state = readyToSubmit(bookingForm(async (path, options) => {
    calls.push(path);
    if (path === '/api/auth/register') {
      registerBody = options.body;
      return { user: { id: 9, name: 'Ngọc Anh' } };
    }
    if (path.startsWith('/api/bookings/quote')) {
      return { items: [], total: 350000 };
    }
    return { id: 91 };
  }));
  state.user = null;
  state.authTab = 'register';
  state.auth = { email: 'ngocanh@example.com', password: 'Oak@1234' };
  // Written the way a person writes it; the account and the booking both get the digits.
  state.form.phone = '090 123.4567';
  // The same affirmative consent dang-ky.html asks for. Without it the panel refuses and
  // never reaches the server, which is what the case below pins.
  state.authConsent = true;

  await state.authSubmit();

  assert.deepEqual(calls, [
    '/api/auth/register',
    '/api/bookings/quote?service_id=7',
    '/api/bookings',
  ]);
  // POST /api/auth/register refuses a body with no consent (CONSENT_REQUIRED), so the
  // wizard's own sign-up has to carry it — this is the one path that used to send none.
  assert.equal(registerBody.consent, true);
  assert.equal(registerBody.marketing_opt_in, false);
  assert.equal(state.user.id, 9);
  assert.equal(state.authError, '');
  assert.equal(state.authBusy, false);
  // The password is not left lying in the component once it has been spent.
  assert.equal(state.auth.password, '');
  assert.equal(state.location.href, 'xac-nhan-dat-lich.html?id=91');
});

test('the wizard will not create an account without consent, and says so', async () => {
  const state = readyToSubmit(bookingForm(async () => assert.fail('no request may be made')));
  state.user = null;
  state.authTab = 'register';
  state.auth = { email: 'ngocanh@example.com', password: 'Oak@1234' };

  await state.authSubmit();

  assert.equal(state.authError, 'Vui lòng đồng ý với Điều khoản và Chính sách bảo mật.');
  assert.equal(state.user, null);
  // The box is only asked for on the register tab; signing in takes no new consent.
  assert.match(html, /x-model="authConsent"/);
  assert.match(html, /x-show="authTab === 'register'"/);
});

test('a refused sign-in stays on the wizard with the reason, and books nothing', async () => {
  const calls = [];
  const state = readyToSubmit(bookingForm(async (path) => {
    calls.push(path);
    throw new Error('Email hoặc mật khẩu không đúng.');
  }));
  state.user = null;
  state.auth = { email: 'ngocanh@example.com', password: 'wrong' };

  await state.authSubmit();

  assert.deepEqual(calls, ['/api/auth/login']);
  assert.equal(state.authError, 'Email hoặc mật khẩu không đúng.');
  assert.equal(state.user, null);
  assert.equal(state.location.href, '');
});

test('the contact form asks for a phone the way a phone asks for one', () => {
  assert.match(
    html,
    /autocapitalize="words" autocomplete="name"[^>]*enterkeyhint="next" id="customer-name"/,
  );
  assert.match(html, /autocomplete="tel"[^>]*id="customer-phone" inputmode="tel"/);
  // And says why, next to the box, rather than leaving the reader to guess.
  assert.match(html, /Salon dùng số này để xác nhận lịch/);
  assert.match(html, /aria-describedby="customer-phone-help customer-phone-error"/);
  assert.match(html, /enterkeyhint="done"[^>]*rows="3"/);
});

test('a number written with spaces and dots is accepted and sent as digits', async () => {
  const bodies = [];
  const state = readyToSubmit(bookingForm(async (path, options) => {
    bodies.push(options && options.body);
    return { id: 91 };
  }));
  state.form.phone = '090 123.4567';

  await state.submit();

  assert.equal(state.fieldErrors.phone, '');
  assert.equal(bodies[0].customer_phone, '0901234567');
});

test('step 2 prices and groups a service the way the salon menu does', () => {
  const state = bookingForm(async () => []);
  state.options = [
    { id: 1, name: 'Sơn Gel', category: 'nail' },
    { id: 2, name: 'Uốn tóc', category: 'hair' },
    { id: 3, name: 'Sơn Gel Cơ Bản', category: 'nail' },
  ];

  const groups = Array.from(state.optionGroups());
  assert.deepEqual(groups.map((group) => group.label), ['Nails', 'Tóc']);
  assert.deepEqual(Array.from(groups[0].options, (option) => option.id), [1, 3]);
  // "Từ 350.000đ" rather than a figure that will not be charged, and the menu's own words.
  assert.match(html, /x-text="OAK\.fmtPriceFrom\(option\.price, option\.price_is_from\)"/);
  assert.match(html, /line-clamp-2"[^>]*x-text="option\.description"/);
});

test('an opening price turns the sidebar total into an estimate', () => {
  const state = bookingForm(async () => []);
  assert.equal(state.estimated(), false);
  state.service = { id: 7, price: 350000, price_is_from: false };
  assert.equal(state.estimated(), false);
  state.service = { id: 7, price: 350000, price_is_from: true };
  assert.equal(state.estimated(), true);

  assert.match(html, /x-show="!estimated\(\) &amp;&amp; !reschedule">Tổng cộng</);
  assert.match(html, /x-show="estimated\(\) &amp;&amp; !reschedule">Tạm tính</);
  assert.match(html, /x-show="estimated\(\) &amp;&amp; !reschedule">Giá cuối salon chốt theo thực tế</);
  // A move is not a new sale: the figure beside it is the one already settled, and it is
  // named as that rather than as a total this page just worked out.
  assert.match(html, /x-show="reschedule">Giá đã chốt</);
});

test('the help block is the same block, in the same order, as the confirmation page carries', () => {
  const confirmation = fs.readFileSync(path.join(root, 'ui', 'xac-nhan-dat-lich.html'), 'utf8');
  for (const source of [html, confirmation]) {
    // WCAG 2.2 SC 3.2.6: the same help, in the same place, at every step of the process.
    assert.match(source, /Cần hỗ trợ\?/);
    assert.ok(source.indexOf('Gọi salon') < source.indexOf('Liên hệ OAK'));
    assert.match(source, /href="lien-he\.html"/);
  }
  // The salon's number is dialled and shown, never announced into a toast nobody kept.
  assert.doesNotMatch(confirmation, /Số điện thoại salon/);
  assert.match(confirmation, /x-show="booking &amp;&amp; booking\.salon\.phone"/);
});
