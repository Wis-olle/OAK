/* A review is only worth reading if the reader can tell when it was written, that the
   person writing it actually sat in the chair, and — where there are enough of them —
   what the one-star ones say. And the invitation to write one has to reach only the people
   the server would accept a review from: it used to greet everyone and end, three steps
   later, in a toast saying no. These drive the two pages' own factories. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readUi = (name) => fs.readFileSync(path.join(root, 'ui', name), 'utf8');

const salonHtml = readUi('salon-profile.html');
const serviceHtml = readUi('chi-tiet-dich-vu.html');

const withMeta = (rows, meta) => Object.assign(rows, { meta });

const SALON = {
  id: 4,
  slug: 'lala-nail-studio',
  name: 'Lala Nail Studio',
  description: 'Nail studio',
  district: 'Quận 1',
  city: 'TP.HCM',
  image: 'a.webp',
  rating: 4.5,
  review_count: 7,
  price_from: 250000,
  verified: true,
  amenities: [],
  social_links: {},
  hours: [],
  open_time: '09:00',
  close_time: '21:00',
  lat: null,
  lng: null,
};

const review = (id, rating) => ({
  id,
  rating,
  comment: 'ổn',
  created_at: '2026-07-0' + id + 'T00:00:00.000Z',
  user: { name: 'Khách' },
  staff: null,
  service_name: 'Sơn Gel Cơ Bản',
});

const BREAKDOWN = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 3 };

const REVIEW_PAGE = withMeta([review(1, 5), review(2, 4), review(3, 1)], {
  page: 1,
  limit: 10,
  total: 7,
  all_total: 7,
  average: 3.6,
  breakdown: BREAKDOWN,
});

const THIN_REVIEWS = withMeta([review(1, 5)], {
  page: 1,
  limit: 10,
  total: 1,
  all_total: 1,
  average: 5,
  breakdown: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 },
});

/** Every /api/salons/:id/reviews URL the page asked for, in order. `reviewsApi`, when
    given, answers those reads itself so a test can settle two of them out of order. */
async function salonPage({ reviews = REVIEW_PAGE, reviewsApi = null, user = null, completed = [], mine = [] } = {}) {
  const asked = [];
  const context = {
    URL,
    URLSearchParams,
    location: { href: 'https://oak.test/salon-profile.html?salon=lala-nail-studio', pathname: '/salon-profile.html', search: '?salon=lala-nail-studio' },
    history: { replaceState: () => {} },
    navigator: {},
    OAK: {
      qs: (name) => (name === 'salon' ? 'lala-nail-studio' : null),
      me: async () => user,
      meta: () => {},
      fmtTime: (value) => value,
      fmtDate: (value) => value,
      fmtPrice: (value) => String(value),
      fmtPriceFrom: (value) => String(value),
      toast: () => {},
      api: async (url) => {
        if (url.includes('/reviews?') || url.endsWith('/reviews')) {
          asked.push(url);
          return reviewsApi ? reviewsApi(url) : reviews;
        }
        if (url.startsWith('/api/promotions')) return [];
        if (url.startsWith('/api/favorites')) return { salons: [], services: [] };
        if (url.startsWith('/api/bookings/mine')) {
          return withMeta(completed, { total: completed.length });
        }
        if (url.startsWith('/api/reviews/mine')) return mine;
        if (url.endsWith('/photos') || url.endsWith('/services') || url.endsWith('/staff')) return [];
        return SALON;
      },
    },
  };
  const tail = salonHtml.slice(salonHtml.indexOf('const OAK_CATEGORY_LABELS'));
  vm.runInNewContext(`${tail.slice(0, tail.indexOf('</script>'))}\nresult = oakSalonProfile();`, context);
  await context.result.init();
  context.result.asked = asked;
  return context.result;
}

async function servicePage({ user = null, completed = [], mine = [] } = {}) {
  const context = {
    URL,
    URLSearchParams,
    location: { href: 'https://oak.test/chi-tiet-dich-vu.html?id=4' },
    navigator: {},
    OAK: {
      qs: (name) => (name === 'id' ? '4' : null),
      me: async () => user,
      meta: () => {},
      fmtDate: (value) => value,
      fmtPrice: (value) => String(value),
      fmtPriceFrom: (value) => String(value),
      toast: () => {},
      api: async (url) => {
        if (url.startsWith('/api/services/4/availability')) return { date: '2026-08-24', slots: [] };
        if (url.includes('/availability')) return { week: [] };
        if (url.includes('/reviews?limit=4')) return withMeta([review(1, 5)], { total: 7, average: 3.6 });
        if (url.startsWith('/api/favorites')) return { salons: [], services: [] };
        if (url.startsWith('/api/bookings/mine')) {
          return withMeta(completed, { total: completed.length });
        }
        if (url.startsWith('/api/reviews/mine')) return mine;
        if (url === '/api/services/4') {
          return {
            id: 4,
            name: 'Sơn Gel Cơ Bản',
            description: 'x',
            image: 'a.webp',
            price: 250000,
            price_is_from: false,
            duration_min: 45,
            salon: { id: 4, slug: 'lala-nail-studio', name: 'Lala Nail Studio', address: 'x', image: 'b.webp', rating: 4.5, review_count: 7 },
          };
        }
        return [];
      },
    },
  };
  const tail = serviceHtml.slice(serviceHtml.indexOf('function oakTodayISO('));
  vm.runInNewContext(`${tail.slice(0, tail.indexOf('</script>'))}\nresult = oakServiceDetail();`, context);
  await context.result.init();
  return context.result;
}

const booking = (id, serviceId) => ({
  id,
  date: '2026-08-14',
  salon: { id: 4 },
  service: { id: serviceId },
});

test('a guest is told who may write a review instead of being sent to find out', async () => {
  const page = await salonPage();
  assert.equal(page.reviewGate.href, '');
  for (const html of [salonHtml, serviceHtml]) {
    assert.match(html, /Chỉ khách đã hoàn tất lịch hẹn qua OAK mới đánh giá được/);
    // The dead end this replaces: sign in, come back, two requests, a toast saying no.
    assert.doesNotMatch(html, /writeReview\(\)/);
  }
});

test('a customer with a finished appointment here is invited, and told which one', async () => {
  const page = await salonPage({ user: { id: 1 }, completed: [booking(31, 4)] });
  assert.equal(page.reviewGate.href, 'danh-gia-cua-toi.html?booking_id=31');
  assert.equal(page.reviewGate.date, '14/08');

  // One already reviewed is not offered again.
  const done = await salonPage({
    user: { id: 1 },
    completed: [booking(31, 4)],
    mine: [{ booking_id: 31 }],
  });
  assert.equal(done.reviewGate.href, '');

  // A customer with no appointment at this salon reads the same line a guest does.
  const stranger = await salonPage({ user: { id: 1 }, completed: [] });
  assert.equal(stranger.reviewGate.href, '');
});

test('the service page offers the booking of this very service before any other', async () => {
  // Two unreviewed bookings at the salon; only one of them is for the service being read.
  const page = await servicePage({
    user: { id: 1 },
    completed: [booking(30, 9), booking(31, 4)],
  });
  assert.equal(page.reviewGate.href, 'danh-gia-cua-toi.html?booking_id=31');
  assert.equal(page.reviewGate.date, '14/08');

  const guest = await servicePage();
  assert.equal(guest.reviewGate.href, '');
});

test('pressing a star filters the list and pressing it again clears the filter', async () => {
  const page = await salonPage();
  // The first load takes the endpoint's own defaults: newest first, every star.
  assert.doesNotMatch(page.asked.at(-1), /rating=/);

  page.filterReviews(4);
  await new Promise(setImmediate);
  assert.match(page.asked.at(-1), /rating=4/);
  assert.equal(page.reviewFilter, 4);

  page.filterReviews(4);
  await new Promise(setImmediate);
  assert.doesNotMatch(page.asked.at(-1), /rating=/);
  assert.equal(page.reviewFilter, 0);

  // The sort travels with the filter rather than resetting it.
  page.reviewSort = 'lowest';
  page.filterReviews(1);
  await new Promise(setImmediate);
  assert.match(page.asked.at(-1), /sort=lowest/);
  assert.match(page.asked.at(-1), /rating=1/);
});

test('the distribution keeps its own scale while one of its stars is filtering', async () => {
  const page = await salonPage();
  // meta.total follows the filter; the bars are drawn over every review of the salon.
  assert.equal(page.reviewAllTotal(), 7);
  assert.deepEqual(
    [...page.breakdownRows()].map((row) => [row.rating, row.count]),
    [[5, 3], [4, 1], [3, 1], [2, 1], [1, 1]],
  );
  // Baymard: under six reviews a distribution says less than the reviews themselves do.
  const thin = await salonPage({ reviews: THIN_REVIEWS });
  assert.equal(thin.reviewAllTotal(), 1);
  assert.match(salonHtml, /x-show="reviewAllTotal\(\) &gt; 5"/);
  assert.match(salonHtml, /:aria-pressed="reviewFilter === row.rating"/);
});

test('the pressed star and the rows under it never name different filters', async () => {
  const fiveStar = withMeta([review(9, 5)], { page: 1, limit: 10, total: 3, all_total: 7, average: 5, breakdown: BREAKDOWN });
  const oneStar = withMeta([review(8, 1)], { page: 1, limit: 10, total: 1, all_total: 7, average: 1, breakdown: BREAKDOWN });
  let releaseFive;
  const page = await salonPage({
    reviewsApi: (url) => {
      if (url.includes('rating=5')) {
        return new Promise((resolve) => { releaseFive = () => resolve(fiveStar); });
      }
      return Promise.resolve(url.includes('rating=1') ? oneStar : REVIEW_PAGE);
    },
  });

  // Five pressed, then one before five came back: the slow reply is the stale one.
  page.filterReviews(5);
  await new Promise(setImmediate);
  page.filterReviews(1);
  await new Promise(setImmediate);
  assert.equal(page.reviewFilter, 1);
  assert.deepEqual([...page.reviews].map((row) => row.id), [8]);

  releaseFive();
  await new Promise(setImmediate);
  assert.equal(page.reviewFilter, 1);
  assert.deepEqual([...page.reviews].map((row) => row.id), [8]);

  // And a read that failed leaves the old rows up, so the star goes back to them.
  const failing = await salonPage({
    reviewsApi: (url) => (url.includes('rating=2')
      ? Promise.reject(new Error('Không tải được đánh giá.'))
      : Promise.resolve(REVIEW_PAGE)),
  });
  failing.filterReviews(2);
  await new Promise(setImmediate);
  assert.equal(failing.reviewFilter, 0);
  assert.equal(failing.reviews.length, 3);
});

test('page two of the reviews never lands on a list it was not read for', async () => {
  const page2 = withMeta([review(4, 5), review(5, 5)], {
    page: 2, limit: 10, total: 7, all_total: 7, average: 3.6, breakdown: BREAKDOWN,
  });
  const oneStar = withMeta([review(8, 1)], {
    page: 1, limit: 10, total: 1, all_total: 7, average: 1, breakdown: BREAKDOWN,
  });
  let releasePage2;
  const page = await salonPage({
    reviewsApi: (url) => {
      if (url.includes('page=2')) {
        return new Promise((resolve) => { releasePage2 = () => resolve(page2); });
      }
      return Promise.resolve(url.includes('rating=1') ? oneStar : REVIEW_PAGE);
    },
  });

  // "Xem thêm" pressed, then a star before page two arrived: those rows were read for
  // the old filter, so appending them would show ratings the pressed star excludes.
  page.loadMoreReviews();
  await new Promise(setImmediate);
  page.filterReviews(1);
  await new Promise(setImmediate);
  assert.deepEqual([...page.reviews].map((row) => row.id), [8]);

  releasePage2();
  await new Promise(setImmediate);
  assert.deepEqual([...page.reviews].map((row) => row.id), [8]);
  assert.equal(page.reviewPage, 1);
});

test('the salon answer sits under the review it answers, on both pages that show one', () => {
  for (const html of [salonHtml, serviceHtml]) {
    // Indented under the comment, labelled with the salon's name, and absent until there
    // is an answer — a reply floating free would read as a second review.
    assert.match(html, /x-show="review\.reply"/);
    assert.match(html, /x-text="review\.reply \? review\.reply\.text : ''"/);
    assert.match(html, />Phản hồi từ</);
    assert.ok(
      html.indexOf('x-text="review.comment"') < html.indexOf('x-show="review.reply"'),
      'the answer must come after the comment it answers',
    );
  }
});

test('every review carries the date it was written and the booking behind it', () => {
  for (const html of [salonHtml, serviceHtml]) {
    assert.match(html, /x-text="OAK\.fmtDate\(review\.created_at\)"/);
    assert.match(html, /<span>Đã đặt qua OAK<\/span>/);
    assert.match(html, /x-show="review\.service_name" x-text="review\.service_name"/);
  }
  // Four fit on the service page; the rest are read where the distribution is.
  assert.match(serviceHtml, /salonUrl\(\) \+ '#danh-gia'/);
  assert.match(salonHtml, /id="danh-gia"/);
});

test('the specialist page carries the hour only when a service travels with it', async () => {
  // Without a service the week grid is sized by this technician's longest one, so an hour
  // picked from it can stop fitting the moment a shorter service is chosen in the wizard.
  const html = readUi('ho-so-chuyen-gia.html');
  const tail = html.slice(html.indexOf('function oakTodayISO('));
  const context = {
    URLSearchParams,
    location: { href: 'https://oak.test/ho-so-chuyen-gia.html?id=1' },
    navigator: {},
    window: {},
    OAK: {
      qs: (name) => (name === 'id' ? '1' : null),
      meta: () => {},
      fmtDate: (value) => value,
      toast: () => {},
      api: async (url) => {
        if (url.includes('/availability')) return { week: [{ date: '2026-08-24', slots: [{ time: '10:00', available: true }] }] };
        if (url.includes('/reviews')) return withMeta([], { total: 0, average: 0 });
        if (url.endsWith('/services')) return [{ id: 9, name: 'Sơn Gel Cơ Bản' }];
        return { id: 1, name: 'Minh Anh', title: 'KTV', specialty: '', bio: '', image: 'a.webp', rating: 4.9, years_experience: 6, portfolio: [], salon: { id: 4, slug: 'lala', name: 'Lala' } };
      },
    },
  };
  vm.runInNewContext(`${tail.slice(0, tail.indexOf('</script>'))}\nresult = oakStaffProfile();`, context);
  const page = context.result;
  await page.init();

  page.pick('2026-08-24', '10:00');
  assert.equal(page.bookingUrl(), 'dat-lich.html?salon_id=4&staff_id=1&date=2026-08-24');
  assert.doesNotMatch(page.bookingUrl(), /time=/);

  // Choosing the service here resizes the grid, and then the hour is safe to carry.
  page.pickService(9);
  await new Promise(setImmediate);
  page.pick('2026-08-24', '10:00');
  assert.equal(
    page.bookingUrl(),
    'dat-lich.html?salon_id=4&staff_id=1&service_id=9&date=2026-08-24&time=10%3A00',
  );
  assert.match(html, /Chọn dịch vụ ở bước sau để chốt giờ/);
});

test('the specialist week says a failed read is not a week without room in it', async () => {
  const html = readUi('ho-so-chuyen-gia.html');
  const tail = html.slice(html.indexOf('function oakTodayISO('));
  let failWeek = false;
  const context = {
    URLSearchParams,
    location: { href: 'https://oak.test/ho-so-chuyen-gia.html?id=1' },
    navigator: {},
    window: {},
    OAK: {
      qs: (name) => (name === 'id' ? '1' : null),
      meta: () => {},
      fmtDate: (value) => value,
      toast: () => {},
      api: async (url) => {
        if (url.includes('/availability')) {
          if (failWeek) throw new Error('offline');
          return { week: [{ date: '2026-08-24', slots: [{ time: '10:00', available: true }] }] };
        }
        if (url.includes('/reviews')) return withMeta([], { total: 0, average: 0 });
        if (url.endsWith('/services')) return [{ id: 9, name: 'Sơn Gel Cơ Bản' }];
        return { id: 1, name: 'Minh Anh', title: 'KTV', specialty: '', bio: '', image: 'a.webp', rating: 4.9, years_experience: 6, portfolio: [], salon: { id: 4, slug: 'lala', name: 'Lala' } };
      },
    },
  };
  vm.runInNewContext(`${tail.slice(0, tail.indexOf('</script>'))}
result = oakStaffProfile();`, context);
  const page = context.result;
  await page.init();
  assert.equal(page.weekError, '');

  // Choosing a service reads the week again, and this time the read fails.
  failWeek = true;
  await page.loadWeek();
  assert.equal(page.weekError, 'Không tải được lịch trống.');
  assert.equal([...page.week].length, 0);

  failWeek = false;
  await page.loadWeek();
  assert.equal(page.weekError, '');
  assert.match(html, /x-if="!weekLoading &amp;&amp; !weekError &amp;&amp; !workingDays\(\).length"/);
  assert.match(html, /x-show="weekError"[\s\S]{0,400}?>Thử lại</);

  // The note about picking a service belongs to the hour, not to the chips: a failed read
  // of the chip list must not take the only explanation of the missing hour away with it.
  const noteThenGrid = /<\/div>\s*<p class="font-caption[^"]*" x-show="!serviceId &amp;&amp; time">Chọn dịch vụ ở bước sau để chốt giờ<\/p>\s*<div class="flex flex-col gap-6">/;
  assert.match(html, noteThenGrid);
});

test('the specialist week grid always belongs to the chip that is lit', async () => {
  /* Two chips pressed in a row settle out of order: the first, slower reply would paint a
     week sized for a service nobody has selected, and the hour picked from it would reach
     the wizard with the other service_id and be dropped there. */
  const html = readUi('ho-so-chuyen-gia.html');
  const tail = html.slice(html.indexOf('function oakTodayISO('));
  const release = {};
  const week = (time) => ({ week: [{ date: '2026-08-24', slots: [{ time, available: true }] }] });
  const context = {
    URLSearchParams,
    location: { href: 'https://oak.test/ho-so-chuyen-gia.html?id=1' },
    navigator: {},
    window: {},
    OAK: {
      qs: (name) => (name === 'id' ? '1' : null),
      meta: () => {},
      fmtDate: (value) => value,
      toast: () => {},
      api: async (url) => {
        if (url.includes('service_id=9')) {
          return new Promise((resolve) => { release.nine = () => resolve(week('09:00')); });
        }
        if (url.includes('service_id=10')) return week('10:30');
        if (url.includes('/availability')) return week('08:00');
        if (url.includes('/reviews')) return withMeta([], { total: 0, average: 0 });
        if (url.endsWith('/services')) {
          return [{ id: 9, name: 'Sơn Gel Cơ Bản' }, { id: 10, name: 'Thiết Kế Nail Art' }];
        }
        return { id: 1, name: 'Minh Anh', title: 'KTV', specialty: '', bio: '', image: 'a.webp', rating: 4.9, years_experience: 6, portfolio: [], salon: { id: 4, slug: 'lala', name: 'Lala' } };
      },
    },
  };
  vm.runInNewContext(`${tail.slice(0, tail.indexOf('</script>'))}
result = oakStaffProfile();`, context);
  const page = context.result;
  await page.init();

  page.pickService(9);
  await new Promise(setImmediate);
  page.pickService(10);
  await new Promise(setImmediate);
  assert.equal(page.serviceId, 10);
  assert.deepEqual([...page.week][0].slots.map((slot) => slot.time), ['10:30']);

  // The overtaken reply arrives last and is dropped, chip and grid still agreeing.
  release.nine();
  await new Promise(setImmediate);
  assert.equal(page.serviceId, 10);
  assert.deepEqual([...page.week][0].slots.map((slot) => slot.time), ['10:30']);
  assert.equal(page.weekLoading, false);
});
