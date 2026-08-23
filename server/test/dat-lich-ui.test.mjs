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
    },
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
  state.$root = { scrollIntoView: () => {} };

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

test('a reschedule cancels the appointment it replaces, but only once the new one exists', async () => {
  const calls = [];
  const state = readyToSubmit(bookingForm(async (path, options) => {
    calls.push(path + ' ' + ((options && options.method) || 'GET'));
    return { id: 91 };
  }));
  state.reschedule = 55;

  await state.submit();

  assert.deepEqual(calls, ['/api/bookings POST', '/api/bookings/55/cancel PATCH']);
  // Nothing is stranded, so the confirmation page is not told to warn about anything.
  assert.equal(state.location.href, 'xac-nhan-dat-lich.html?id=91');
});

test('a cancel that fails hands the stranded appointment to the confirmation page', async () => {
  const state = readyToSubmit(bookingForm(async (path) => {
    if (path === '/api/bookings') {
      return { id: 91 };
    }
    throw new Error('Vui lòng huỷ trước giờ hẹn ít nhất 2 tiếng.');
  }));
  state.reschedule = 55;

  await state.submit();

  // The new appointment is real, so the confirmation page is still where this ends — but
  // it is told which old appointment is still standing, because a toast would not survive
  // the navigation and this is the one thing left for the reader to act on.
  assert.equal(state.location.href, 'xac-nhan-dat-lich.html?id=91&reschedule_failed=55');
  assert.equal(state.toasts.length, 0);
  assert.equal(state.formError, '');
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
  state.$root = { scrollIntoView: () => {} };
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
  // The three conditions come from OAK.TRUST, so the salon page, the service page, the
  // wizard and the confirmation page cannot word the same promise four different ways.
  assert.equal(html.split('x-text="OAK.TRUST.CANCEL_POLICY"').length - 1, 2);
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
  // Nothing to pin until there is something to pay for, and step 1 has no button to offer.
  assert.match(html, /x-show="service &amp;&amp; step > 1"/);
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
  state.$root = { scrollIntoView: () => {} };

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
