/*
 * OAK Beauty — shared browser client for the /api backend.
 *
 * Loaded WITHOUT `defer` on every wired page, immediately after the deferred Alpine
 * tag, and exposes `window.OAK`. It must not be deferred: Alpine starts in a microtask
 * as soon as its own script runs, so `window.OAK` must already exist by then for each
 * page's x-data init() blocks to call OAK.* — deferring this file would let Alpine boot
 * first and every init() would throw a ReferenceError.
 * The header auto-init at the bottom is selector-based so a page only has to include
 * this file: no per-page wiring, and every selector is null-checked because the
 * partner pages carry a different header entirely.
 */
(function () {
  'use strict';

  var LOGIN_PAGE = 'dang-nhap-nguoi-dung.html';
  var PARTNER_LOGIN_PAGE = 'dang-nhap-doi-tac.html';
  var PROFILE_PAGE = 'ho-so-ca-nhan.html';
  var NOTIFICATIONS_PAGE = 'thong-bao.html';
  var HOME_PAGE = 'kham-pha.html';
  var SEARCH_PAGE = 'ket-qua-tim-kiem.html';

  var WEEKDAYS = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];

  /** The current page as a relative url, so it can ride in a ?next= parameter. */
  function currentUrl() {
    return location.pathname.replace(/^.*\//, '') + location.search;
  }

  function apiError(code, message) {
    var error = new Error(message);
    error.code = code;
    return error;
  }

  /**
   * Call the API and unwrap the {success, data} envelope.
   * Resolves with `data`; rejects with an Error carrying `.code` and a Vietnamese
   * `.message` on either a success:false envelope or a network/parse failure.
   */
  async function api(path, options) {
    var opts = options || {};
    var init = { method: opts.method || 'GET', credentials: 'same-origin' };
    if (opts.body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(opts.body);
    }

    var payload;
    try {
      var response = await fetch(path, init);
      payload = await response.json();
    } catch (error) {
      throw apiError('NETWORK_ERROR', 'Không kết nối được máy chủ, vui lòng thử lại.');
    }

    if (!payload || payload.success !== true) {
      var envelope = (payload && payload.error) || {};
      if (envelope.code === 'UNAUTHENTICATED' && sessionSeen) {
        // The session expired while the page was open: every later click would raise the
        // same toast on a page that still looks signed in, so sign in again from here and
        // come back. Only once a session has actually been seen: /api/auth/me is optional
        // auth and answers {user:null} for a guest, so `sessionSeen` is only ever set by a
        // real user, and an anonymous visitor on a public page is never bounced from here.
        sessionSeen = false;
        return redirectToLogin(partnerPage ? PARTNER_LOGIN_PAGE : LOGIN_PAGE);
      }
      throw apiError(
        envelope.code || 'UNKNOWN_ERROR',
        envelope.message || 'Đã có lỗi xảy ra, vui lòng thử lại sau.',
      );
    }

    // A fresh login counts as a session too, for pages that sign in without reloading.
    if (path === '/api/auth/login' && payload.data && payload.data.user) {
      sessionSeen = true;
    }

    // Pagination totals and breakdowns ride along on the resolved data as a
    // non-enumerable `meta`, so callers keep getting plain `data` (spreads, x-for
    // and JSON.stringify are unaffected) while `result.meta.total` still works.
    if (payload.meta && payload.data !== null && typeof payload.data === 'object') {
      Object.defineProperty(payload.data, 'meta', {
        value: payload.meta,
        enumerable: false,
        configurable: true,
      });
    }
    return payload.data;
  }

  // One request per page load, shared by the header init and by page code.
  var mePromise = null;
  // True once /api/auth/me failed to reach the server at all. A dead backend and a
  // signed-out visitor both leave us without a user, but they need opposite treatment:
  // bouncing to the login page when the server is down strands the visitor on a page whose
  // own login call cannot work either, which reads as "every click does nothing".
  var serverUnreachable = false;
  // True once this page load has seen a real session. UNAUTHENTICATED then means the session
  // expired rather than "never signed in", which is what makes the redirect in api() safe.
  var sessionSeen = false;
  // True on the partner console: only those pages gate themselves with requirePartner(), and
  // they belong to the partner login page, not the customer one.
  var partnerPage = false;

  /** The signed-in user, or null. Never redirects — a guest page must still render. */
  function me() {
    if (!mePromise) {
      mePromise = api('/api/auth/me').then(
        function (data) {
          // /api/auth/me is optional-auth: a guest resolves to {user:null}.
          var user = data ? data.user : null;
          if (user) {
            sessionSeen = true;
          }
          return user;
        },
        function (error) {
          // Still null, so public pages render as they always have — but the reason is
          // remembered, and requireLogin/requirePartner below act on it instead of
          // treating an unreachable server as a guest.
          serverUnreachable = error.code === 'NETWORK_ERROR';
          return null;
        },
      );
    }
    return mePromise;
  }

  /**
   * Send the visitor to a login page carrying where they were headed, and hand back a
   * promise that never settles so the caller's `await` stops there.
   */
  function redirectToLogin(page) {
    location.href = page + '?next=' + encodeURIComponent(currentUrl());
    return new Promise(function () {});
  }

  /**
   * Say plainly that the backend is down, and stop the caller the same way a redirect
   * does. A banner rather than a toast: the page behind it will never finish loading, so
   * the explanation has to outlive three seconds.
   */
  function reportServerUnreachable() {
    if (!document.getElementById('oak-server-down')) {
      var banner = document.createElement('div');
      banner.id = 'oak-server-down';
      banner.setAttribute('role', 'alert');
      banner.className =
        'fixed inset-x-0 top-0 z-50 px-6 py-3 bg-error text-on-error ' +
        'font-body-md text-body-md text-center';
      banner.textContent =
        'Không kết nối được máy chủ. Vui lòng kiểm tra server đang chạy rồi tải lại trang.';
      document.body.appendChild(banner);
    }
    return new Promise(function () {});
  }

  async function requireLogin() {
    var user = await me();
    if (serverUnreachable) {
      return reportServerUnreachable();
    }
    return user || redirectToLogin(LOGIN_PAGE);
  }

  async function requirePartner() {
    partnerPage = true;
    var user = await me();
    if (serverUnreachable) {
      return reportServerUnreachable();
    }
    return user && user.role === 'partner' ? user : redirectToLogin(PARTNER_LOGIN_PAGE);
  }

  /** 350000 → "350.000đ". Empty string for anything that is not a number. */
  function fmtPrice(value) {
    var number = Number(value);
    if (value === null || value === undefined || value === '' || !isFinite(number)) {
      return '';
    }
    return number.toLocaleString('vi-VN') + 'đ';
  }

  /** "2026-08-10" (or a full ISO string) → "Thứ Hai, 10/08/2026". */
  function fmtDate(iso) {
    if (!iso) {
      return '';
    }
    var parts = String(iso).split('T')[0].split('-');
    var year = Number(parts[0]);
    var month = Number(parts[1]);
    var day = Number(parts[2]);
    if (!year || !month || !day) {
      return String(iso);
    }
    var weekday = WEEKDAYS[new Date(year, month - 1, day).getDay()];
    var pad = function (value) {
      return String(value).padStart(2, '0');
    };
    return weekday + ', ' + pad(day) + '/' + pad(month) + '/' + year;
  }

  /** Normalise a stored time to "HH:MM" ("9:0" and "14:00:00" both land on HH:MM). */
  function fmtTime(value) {
    if (!value) {
      return '';
    }
    var match = String(value).match(/^(\d{1,2}):(\d{1,2})/);
    return match ? match[1].padStart(2, '0') + ':' + match[2].padStart(2, '0') : String(value);
  }

  function qs(name) {
    return new URLSearchParams(location.search).get(name);
  }

  var TOAST_COLORS = {
    success: 'bg-primary text-on-primary',
    error: 'bg-error text-on-error',
  };

  function toast(message, type) {
    var element = document.createElement('div');
    element.setAttribute('role', 'status');
    // A page that pins its own booking bar to the bottom edge marks it, and the message
    // clears that bar (~68px tall) instead of landing on top of it.
    var offset = document.querySelector('[data-oak-sticky-cta]') ? 'bottom-24' : 'bottom-6';
    element.className =
      'fixed ' + offset + ' left-1/2 -translate-x-1/2 z-50 max-w-[90vw] px-6 py-3 rounded-full ' +
      'shadow-lg font-body-md text-body-md text-center ' +
      (TOAST_COLORS[type] || TOAST_COLORS.success);
    element.textContent = message;
    document.body.appendChild(element);
    setTimeout(function () {
      element.remove();
    }, 3000);
  }

  // Where signing out lands. A page's own [data-oak-logout] link already names it — the
  // partner console points its links at the partner login page — but the page handlers call
  // OAK.logout() without arguments, so the href is picked up here, in the capture phase,
  // before those handlers run.
  var logoutHref = null;
  document.addEventListener(
    'click',
    function (event) {
      var link = event.target.closest ? event.target.closest('a[data-oak-logout]') : null;
      if (link) {
        logoutHref = link.getAttribute('href');
      }
    },
    true,
  );

  async function logout() {
    var destination = logoutHref || HOME_PAGE;
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      location.href = destination;
    }
  }

  function initAccountLink(user) {
    // The partner console hangs its photo off an account link; the customer bar hangs the
    // same photo off the menu button, which carries no such link, so there the two data
    // attributes are the only way in. Only the link is searched loosely for an <img> — a
    // page-wide loose search would find the first picture of the article instead.
    var link = document.querySelector('a[aria-label="Tài khoản"]');
    var image = link
      ? link.querySelector('[data-oak-avatar-img], img')
      : document.querySelector('[data-oak-avatar-img]');
    var icon = (link || document).querySelector('[data-oak-avatar-icon]');
    if (link) {
      link.href = PROFILE_PAGE;
    }
    if (image && user.avatar) {
      image.onerror = function () {
        image.classList.add('hidden');
        if (icon) {
          icon.classList.remove('hidden');
        }
      };
      image.src = user.avatar;
      image.classList.remove('hidden');
      if (icon) {
        icon.classList.add('hidden');
      }
    }
  }

  // What the menu button is called once something is waiting to be read.
  var UNREAD_MENU = 'Menu — có thông báo mới';

  /** English for a name written after oak-i18n.js has made its pass; Vietnamese otherwise. */
  function translated(text) {
    return window.OAKI18N && window.OAKI18N.label ? window.OAKI18N.label(text) : text;
  }

  async function initNotificationBell() {
    var bell = document.querySelector('[aria-label="Thông báo"]');
    if (!bell) {
      return;
    }
    if (bell.tagName === 'A') {
      bell.href = NOTIFICATIONS_PAGE;
    }

    var unread;
    try {
      unread = (await api('/api/notifications?count_only=true')).unread_count;
    } catch (error) {
      return;
    }
    if (!unread) {
      return;
    }

    bell.classList.add('relative');
    var dot = document.createElement('span');
    // A corner suits an icon, which is what the partner console gives this. A full-width row
    // says where it wants the mark instead, because a corner there lands nowhere near it.
    dot.className = (bell.getAttribute('data-oak-dot') || 'absolute top-0 right-0') +
      ' w-2 h-2 rounded-full bg-error';
    dot.setAttribute('aria-label', 'Có thông báo mới');
    bell.appendChild(dot);

    // On the customer bar the bell itself lives inside the menu, so news of an unread note
    // would only ever be seen once the reader opened it. The mark on the button says so
    // while the menu is still shut — and the button's own name has to say it too, because a
    // control with an aria-label is announced by that label alone and never by what it holds.
    Array.prototype.forEach.call(document.querySelectorAll('[data-oak-unread]'), function (mark) {
      mark.classList.remove('hidden');
      var owner = mark.closest ? mark.closest('[aria-label]') : null;
      if (owner) {
        owner.setAttribute('aria-label', translated(UNREAD_MENU));
      }
    });
  }

  function initLocationLabel(user) {
    var button = document.querySelector('button[aria-label="Chọn khu vực"]');
    if (!button || !user.district || !user.city) {
      return;
    }
    // The icon spans carry the material-symbols class; the plain one is the label.
    var label = button.querySelector('span:not(.material-symbols-outlined)');
    if (label) {
      label.textContent = user.district + ', ' + user.city;
    }
  }

  // Mirrors server/src/lib/locations.js (and the selects in ho-so-ca-nhan.html): PATCH
  // /api/users/me rejects a district that does not belong to the stored city, so a pick
  // from another city is navigated to but never saved.
  var CITY_DISTRICTS = {
    'TP.HCM': ['Quận 1', 'Quận 2', 'Quận 3', 'Quận 4', 'Quận 5', 'Quận 6', 'Quận 7', 'Quận 8',
      'Quận 9', 'Quận 10', 'Quận 11', 'Quận 12', 'Quận Bình Thạnh', 'Quận Bình Tân',
      'Quận Gò Vấp', 'Quận Phú Nhuận', 'Quận Tân Bình', 'Quận Tân Phú', 'Thủ Đức',
      'Huyện Bình Chánh', 'Huyện Cần Giờ', 'Huyện Củ Chi', 'Huyện Hóc Môn', 'Huyện Nhà Bè'],
    'Hà Nội': ['Quận Ba Đình', 'Quận Hoàn Kiếm', 'Quận Tây Hồ', 'Quận Long Biên',
      'Quận Cầu Giấy', 'Quận Đống Đa', 'Quận Hai Bà Trưng', 'Quận Hoàng Mai',
      'Quận Thanh Xuân', 'Quận Hà Đông', 'Quận Nam Từ Liêm', 'Quận Bắc Từ Liêm'],
    'Đà Nẵng': ['Quận Hải Châu', 'Quận Thanh Khê', 'Quận Sơn Trà', 'Quận Ngũ Hành Sơn',
      'Quận Liên Chiểu', 'Quận Cẩm Lệ', 'Huyện Hòa Vang'],
  };

  // Only reached when /api/salons cannot answer: an empty dropdown would be one more
  // control that does nothing, so the picker always opens with somewhere to go.
  var FALLBACK_DISTRICTS = ['Quận 1', 'Quận 3', 'Quận 7', 'Quận 10', 'Quận Bình Thạnh',
    'Quận Phú Nhuận', 'Quận Tân Bình', 'Thủ Đức'];

  /** Numbered districts in numeric order, then the named ones alphabetically. */
  function compareDistricts(a, b) {
    var left = Number((a.match(/^Quận (\d+)$/) || [])[1]);
    var right = Number((b.match(/^Quận (\d+)$/) || [])[1]);
    if (left && right) {
      return left - right;
    }
    if (left || right) {
      return left ? -1 : 1;
    }
    return a.localeCompare(b, 'vi');
  }

  // Resolved at most once per page load. The header waits for the first press, so a dropdown
  // nobody has asked for costs nothing; kham-pha.html needs the same names for its own area
  // field and asks as it starts, which warms this memo for the header too.
  var districtsPromise = null;

  function loadDistricts() {
    if (!districtsPromise) {
      districtsPromise = api('/api/salons?limit=50').then(
        function (salons) {
          var names = salons
            .map(function (salon) {
              return salon.district;
            })
            .filter(function (name, index, all) {
              return name && all.indexOf(name) === index;
            });
          return names.length ? names.sort(compareDistricts) : FALLBACK_DISTRICTS.slice();
        },
        function () {
          return FALLBACK_DISTRICTS.slice();
        },
      );
    }
    return districtsPromise;
  }

  /**
   * Go to the results page for a district — '' means every area. The page copies its whole
   * query string into GET /api/search/salons, where `district` is an exact-match filter.
   * A signed-in visitor also has the pick saved, so the header label and their profile
   * agree from the next page on; that save is best-effort and never blocks the search.
   */
  async function chooseDistrict(district) {
    var user = await me();
    var districts = user && CITY_DISTRICTS[user.city];
    if (user && district && (!districts || districts.indexOf(district) !== -1)) {
      try {
        await api('/api/users/me', { method: 'PATCH', body: { district: district } });
      } catch (error) {
        // Saving is a convenience; the search still has to happen.
      }
    }
    location.href = district ? SEARCH_PAGE + '?district=' + encodeURIComponent(district) : SEARCH_PAGE;
  }

  // Same shape as the entries of the header menu it opens inside, one step further in, and
  // on the same 44px floor they keep.
  var MENU_ITEM_CLASS =
    'flex items-center w-full text-left min-h-[44px] px-8 py-2 font-body-md text-body-md ' +
    'text-on-surface-variant hover:text-primary hover:bg-surface-container-low transition-colors';

  /** A real <button>, so the option is tab-reachable and Enter/Space activate it. */
  function districtOption(label, district) {
    var option = document.createElement('button');
    option.type = 'button';
    option.className = MENU_ITEM_CLASS;
    // textContent, not innerHTML: district names come from the API.
    option.textContent = label;
    option.addEventListener('click', function () {
      chooseDistrict(district);
    });
    return option;
  }

  function initRegionPicker() {
    var button = document.querySelector('button[aria-label="Chọn khu vực"]');
    if (!button) {
      return;
    }

    // The button is one row of the header menu, so the wrapper only has to be a positioning
    // context around it — no width or breakpoint of its own.
    var wrapper = document.createElement('div');
    wrapper.className = 'relative';
    button.replaceWith(wrapper);
    wrapper.appendChild(button);

    // The areas open as a nested part of that menu rather than as a second card floating
    // beside it: the menu clips whatever leaves its bounds, so a card would be cut off.
    var panel = document.createElement('div');
    panel.className =
      'hidden bg-surface-container-low py-1 max-h-[40vh] overflow-y-auto overscroll-contain';
    wrapper.appendChild(panel);

    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');

    function close() {
      panel.classList.add('hidden');
      button.setAttribute('aria-expanded', 'false');
    }

    function open() {
      panel.classList.remove('hidden');
      button.setAttribute('aria-expanded', 'true');
      // Filled once, on the first open; the panel is already visible while it loads.
      if (!panel.childElementCount) {
        panel.appendChild(districtOption('Tất cả khu vực', ''));
        loadDistricts().then(function (districts) {
          districts.forEach(function (district) {
            panel.appendChild(districtOption(district, district));
          });
        });
      }
    }

    button.addEventListener('click', function () {
      if (panel.classList.contains('hidden')) {
        open();
      } else {
        close();
      }
    });

    // In the capture phase: the header pill stops the press from bubbling (@click.stop), so a
    // listener on the way back up never hears the press that shuts the menu around this list,
    // and the list would be left open behind a closed menu.
    document.addEventListener('click', function (event) {
      if (!wrapper.contains(event.target)) {
        close();
      }
    }, true);

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !panel.classList.contains('hidden')) {
        close();
        // Focus may be on an option that just became display:none; hand it back.
        button.focus();
      }
    });
  }

  /**
   * The customer menu ships both readings of itself — the entries for a visitor who has not
   * signed in, and the ones for a reader who has — and this keeps whichever applies. Called
   * only once a real user is known, so the markup as authored is already the guest reading.
   */
  function initAuthMenu() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-oak-auth]'), function (group) {
      group.classList.toggle('hidden', group.getAttribute('data-oak-auth') !== 'user');
    });
  }

  async function initHeader() {
    // Before the /api/auth/me await: the picker is for guests too.
    initRegionPicker();
    var user = await me();
    if (!user) {
      return;
    }
    initAccountLink(user);
    initLocationLabel(user);
    initAuthMenu();
    initNotificationBell();
  }

  window.OAK = {
    api: api,
    me: me,
    districts: loadDistricts,
    requireLogin: requireLogin,
    requirePartner: requirePartner,
    fmtPrice: fmtPrice,
    fmtDate: fmtDate,
    fmtTime: fmtTime,
    qs: qs,
    toast: toast,
    logout: logout,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initHeader);
  } else {
    initHeader();
  }
})();
