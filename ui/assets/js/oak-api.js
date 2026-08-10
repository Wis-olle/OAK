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
      throw apiError(
        envelope.code || 'UNKNOWN_ERROR',
        envelope.message || 'Đã có lỗi xảy ra, vui lòng thử lại sau.',
      );
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

  /** The signed-in user, or null. Never redirects — a guest page must still render. */
  function me() {
    if (!mePromise) {
      mePromise = api('/api/auth/me').then(
        function (data) {
          // /api/auth/me is optional-auth: a guest resolves to {user:null}.
          return data ? data.user : null;
        },
        function () {
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

  async function requireLogin() {
    var user = await me();
    return user || redirectToLogin(LOGIN_PAGE);
  }

  async function requirePartner() {
    var user = await me();
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
    element.className =
      'fixed bottom-6 left-1/2 -translate-x-1/2 z-50 max-w-[90vw] px-6 py-3 rounded-full ' +
      'shadow-lg font-body-md text-body-md text-center ' +
      (TOAST_COLORS[type] || TOAST_COLORS.success);
    element.textContent = message;
    document.body.appendChild(element);
    setTimeout(function () {
      element.remove();
    }, 3000);
  }

  async function logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      location.href = HOME_PAGE;
    }
  }

  function initAccountLink(user) {
    var link = document.querySelector('a[aria-label="Tài khoản"]');
    if (!link) {
      return;
    }
    link.href = PROFILE_PAGE;
    var image = link.querySelector('img');
    if (image && user.avatar) {
      image.src = user.avatar;
    }
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
    dot.className = 'absolute top-0 right-0 w-2 h-2 rounded-full bg-error';
    dot.setAttribute('aria-label', 'Có thông báo mới');
    bell.appendChild(dot);
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

  function initMobileMenu() {
    var link = document.querySelector('#mobile-menu a[href="' + LOGIN_PAGE + '"]');
    if (!link) {
      return;
    }

    // Cloned so both replacements keep the menu item styling of the link they replace.
    var account = link.cloneNode(false);
    account.href = PROFILE_PAGE;
    account.textContent = 'Tài khoản của tôi';

    var signOut = link.cloneNode(false);
    signOut.href = '#';
    signOut.textContent = 'Đăng xuất';
    signOut.addEventListener('click', function (event) {
      event.preventDefault();
      logout();
    });

    link.replaceWith(account, signOut);
  }

  async function initHeader() {
    var user = await me();
    if (!user) {
      return;
    }
    initAccountLink(user);
    initLocationLabel(user);
    initMobileMenu();
    initNotificationBell();
  }

  window.OAK = {
    api: api,
    me: me,
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
