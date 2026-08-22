import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readUi = (name) => fs.readFileSync(path.join(root, 'ui', name), 'utf8');

const CONSOLE_PAGES = [
  'tong-quan-doi-tac.html',
  'quan-ly-lich-hen.html',
  'quan-ly-dich-vu.html',
  'quan-ly-nhan-vien.html',
  'bao-cao-doanh-thu.html',
  'cai-dat-salon.html',
];

/* The dashboard factory is inline in the page, so lift it out of its <script> to drive it
   here. The slice stops before the trailing oakPartnerChrome() call, which only wires the
   header up against a real document. */
function dashboard(api, setPendingBadge) {
  const html = readUi('tong-quan-doi-tac.html');
  const tail = html.slice(html.indexOf('var OAK_STATUS_LABELS'));
  const script = tail.slice(0, tail.lastIndexOf('oakPartnerChrome();'));
  const context = {
    OAK: {
      api,
      toast: () => {},
      fmtDate: (iso) => String(iso),
      todayISO: () => '2026-08-21',
      setPendingBadge: setPendingBadge || (() => {}),
    },
  };
  vm.runInNewContext(`${script}\nresult = oakPartnerOverview();`, context);
  return context.result;
}

function pendingRows(rows, total) {
  Object.defineProperty(rows, 'meta', { value: { page: 1, limit: 10, total }, enumerable: false });
  return rows;
}

test('the pending queue asks for every upcoming waiting booking, soonest first', async () => {
  const asked = [];
  const state = dashboard(async (path) => {
    asked.push(path);
    return pendingRows([{ id: 4, status: 'pending', time: '09:00', date: '2026-08-22' }], 1);
  });

  await state.loadPending();
  assert.equal(asked.length, 1);
  assert.match(asked[0], /status=pending/);
  assert.match(asked[0], /order=asc/);
  // Not date=, which is what pinned the old table to today alone.
  assert.match(asked[0], /&from=\d{4}-\d{2}-\d{2}$/);
  assert.equal(state.pending.length, 1);
  assert.equal(state.pendingTotal, 1);
  assert.equal(state.pendingError, '');
  assert.equal(state.pendingLoading, false);
});

test('a failed queue load raises pendingError instead of the empty state, and retrying clears it', async () => {
  let failing = true;
  const state = dashboard(async () => {
    if (failing) {
      throw new Error('Không kết nối được máy chủ.');
    }
    return pendingRows([{ id: 4, status: 'pending' }], 1);
  });

  await state.loadPending();
  assert.equal(state.pendingError, 'Không kết nối được máy chủ.');
  assert.equal(state.pending.length, 0);
  assert.equal(state.pendingTotal, 0);
  assert.equal(state.pendingLoading, false);

  failing = false;
  await state.loadPending();
  assert.equal(state.pendingError, '');
  assert.equal(state.pending.length, 1);

  const html = readUi('tong-quan-doi-tac.html');
  assert.match(html, /x-show="!pendingLoading && !pendingError && pending\.length === 0"/);
  assert.match(html, /@click="loadPending\(\)"/);
});

test('confirming from the dashboard patches the booking and refreshes what it contradicts', async () => {
  const calls = [];
  const painted = [];
  let waiting = [{ id: 4, code: 'OAK-4', status: 'pending' }];
  const state = dashboard(async (path, options) => {
    calls.push({ path, method: (options && options.method) || 'GET', body: options && options.body });
    if (options && options.method === 'PATCH') {
      waiting = [];
      return { id: 4, code: 'OAK-4', status: 'confirmed' };
    }
    if (path === '/api/partner/overview') {
      return { date: '2026-08-21', upcoming_count: 2, staff_status: [{ id: 1, name: 'An' }] };
    }
    if (path.indexOf('status=pending') === -1) {
      return pendingRows([], 0);
    }
    return pendingRows(waiting.slice(), waiting.length);
  }, (total) => painted.push(total));

  // A loaded overview is what makes the refresh branch real: the metric cards count the
  // very rows this changes, so a cancellation must not leave "lịch sắp tới" behind.
  state.overview = { date: '2026-08-21', upcoming_count: 3, staff_status: [] };
  await state.loadPending();
  await state.decide(state.pending[0], 'confirmed');

  // Field by field: the body is built inside the vm, so it is not the test realm's Object.
  assert.equal(calls[1].path, '/api/partner/bookings/4');
  assert.equal(calls[1].method, 'PATCH');
  assert.equal(calls[1].body.status, 'confirmed');
  const paths = calls.map((call) => call.path);
  assert.ok(paths.filter((path) => path.includes('status=pending')).length === 2);
  assert.ok(paths.includes('/api/partner/overview'));
  assert.ok(paths.some((path) => path.includes('date=2026-08-21')));
  assert.equal(state.overview.upcoming_count, 2);
  assert.equal(state.staffStatus.length, 1);
  assert.equal(state.pending.length, 0);
  assert.equal(state.pendingTotal, 0);
  assert.equal(state.acting, 0);
  // The bell is painted from the queue this page already holds, never a second request.
  assert.deepEqual(painted, [1, 0]);
});

test('the queue offers only transitions the backend accepts, one request at a time', async () => {
  let resolvePatch;
  const patched = [];
  const state = dashboard(async (path, options) => {
    if (options && options.method === 'PATCH') {
      patched.push(path);
      return new Promise((resolve) => {
        resolvePatch = () => resolve({ id: 4, code: 'OAK-4', status: 'confirmed' });
      });
    }
    return pendingRows([], 0);
  });

  // completed is terminal: OAK_TRANSITIONS lists nothing for it.
  await state.decide({ id: 9, status: 'completed' }, 'confirmed');
  assert.equal(patched.length, 0);

  const booking = { id: 4, status: 'pending' };
  const first = state.decide(booking, 'confirmed');
  assert.equal(state.acting, 4);
  // A second tap while the first is still in flight would send a transition the backend
  // has already left behind.
  await state.decide(booking, 'cancelled');
  assert.equal(patched.length, 1);
  resolvePatch();
  await first;
  assert.equal(state.acting, 0);
});

test('the console bell stays in the console and is filled from one shared helper', () => {
  const client = fs.readFileSync(path.join(root, 'ui', 'assets', 'js', 'oak-api.js'), 'utf8');
  for (const page of CONSOLE_PAGES) {
    const html = readUi(page);
    assert.doesNotMatch(html, /thong-bao\.html/, page);
    assert.match(html, /data-oak-pending-bell href="quan-ly-lich-hen\.html\?status=pending"/, page);
    assert.match(html, /data-oak-pending-count/, page);
    // A name before the count arrives, and no per-page copy of the fetch or the label.
    assert.match(html, /aria-label="Lịch chờ xác nhận"/, page);
    assert.doesNotMatch(html, /bellLabel\(\)/, page);
    assert.doesNotMatch(html, /function oakTodayISO/, page);
  }
  // The dashboard already holds the number; the other five ask for it.
  assert.match(readUi('tong-quan-doi-tac.html'), /OAK\.setPendingBadge\(this\.pendingTotal\)/);
  for (const page of CONSOLE_PAGES.filter((name) => name !== 'tong-quan-doi-tac.html')) {
    assert.match(readUi(page), /OAK\.pendingBadge\(\)/, page);
  }
  assert.match(client, /todayISO: todayISO,\s*pendingBadge: pendingBadge,\s*setPendingBadge: setPendingBadge,/);
  // Found by data attribute, so the customer bell above cannot claim it and reset its href.
  assert.match(client, /var PENDING_BELL = '\[data-oak-pending-bell\]';/);
});

test('arriving with ?status opens the same window the bell counted, and says so', () => {
  const html = readUi('quan-ly-lich-hen.html');
  assert.match(html, /Object\.prototype\.hasOwnProperty\.call\(OAK_STATUS_LABELS, status\)/);
  assert.match(html, /this\.upcoming = true;/);
  // No date bound at all: the grid cannot draw that, so it gives way to a list.
  assert.match(html, /if \(this\.upcoming\) \{[\s\S]*?params\.set\('from', OAK\.todayISO\(\)\);[\s\S]*?params\.set\('order', 'asc'\);/);
  assert.match(html, /x-show="upcoming"/);
  assert.match(html, /x-show="!upcoming"/);
  assert.match(html, /Đang xem: lịch sắp tới từ hôm nay/);
  assert.match(html, /@click="exitUpcoming\(\)"/);
});

test('both console search boxes are reachable below the lg breakpoint', () => {
  for (const page of ['tong-quan-doi-tac.html', 'quan-ly-lich-hen.html']) {
    const html = readUi(page);
    assert.match(html, /@click\.stop="openMobileSearch\(\)"/, page);
    assert.match(html, /x-ref="searchInput"/, page);
    assert.match(html, /@keydown\.escape="closeSearch\(\)"/, page);
    // The field itself, not a second search: one query, one request path.
    assert.equal(html.split('x-model="query"').length - 1, 1, page);
    // Above lg the field is back in the header, so the overlay must not stay over it.
    assert.match(html, /matchMedia\('\(min-width: 1024px\)'\)/, page);
  }
  // On the calendar the term is a filter: closing the overlay on it would leave an
  // invisible filter reading as "no bookings today".
  assert.match(readUi('quan-ly-lich-hen.html'), /this\.query = '';\s*this\.load\(\);/);
});

test('salon settings warns before an unsaved edit is navigated away from', () => {
  const html = readUi('cai-dat-salon.html');
  assert.match(html, /x-show="dirty"/);
  assert.match(html, /Có thay đổi chưa lưu/);
  assert.match(html, /form="salon-form" type="submit"/);
  assert.match(html, /addEventListener\('beforeunload'/);
  assert.match(html, /event\.stopPropagation\(\);\s*pendingLink = link;/);
  // `leaving` is what lets the replayed click through instead of re-asking — and the
  // bfcache would otherwise leave it latched on for the rest of the visit.
  assert.match(html, /!this\.leaving && this\.snapshot !== ''/);
  assert.match(html, /if \(event\.persisted\) \{\s*self\.leaving = false;/);
  // A modified click opens a new tab and takes nothing away from this one.
  assert.match(html, /event\.button !== 0 \|\|\s*event\.metaKey/);
});

/* A change detector, not a behaviour test: without a database this can only pin the shape
   of the clause. The real round trip (order=asc actually reversing the page) belongs in
   test/api-smoke.mjs, which needs Postgres — backlog. */
test('the bookings list keeps its newest-first default and never binds the sort direction', () => {
  const route = fs.readFileSync(path.join(root, 'server', 'src', 'routes', 'partner.js'), 'utf8');
  assert.match(route, /const direction = req\.query\.order === 'asc' \? 'ASC' : 'DESC';/);
  assert.match(route, /ORDER BY b\.date \$\{direction\}, b\.time \$\{direction\}, b\.id \$\{direction\}/);
});
