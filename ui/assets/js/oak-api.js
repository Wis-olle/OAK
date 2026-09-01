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
  var STAFF_LOGIN_PAGE = 'dang-nhap-nhan-vien.html';
  var STAFF_HOME_PAGE = 'lich-cua-toi.html';
  var PROFILE_PAGE = 'ho-so-ca-nhan.html';
  var NOTIFICATIONS_PAGE = 'thong-bao.html';
  var HOME_PAGE = 'kham-pha.html';

  var WEEKDAYS = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];

  /** The file name of the page being read. The server serves the home page at '/', where
      the last path segment is empty — every caller here wants the page it stands for. */
  function pageName() {
    return location.pathname.replace(/^.*\//, '') || HOME_PAGE;
  }

  /** The current page as a relative url, so it can ride in a ?next= parameter. */
  function currentUrl() {
    return pageName() + location.search;
  }

  function apiError(code, message) {
    var error = new Error(message);
    error.code = code;
    return error;
  }

  /* ---------------------------------------------------------------- cold start
   * The API sleeps after a quarter of an hour of quiet and takes half a minute to wake,
   * and the first request of a page load simply hangs while it does. Untreated that is a
   * skeleton that never fills or a blank page — the site looks broken at the moment it is
   * merely slow. So: a request is abandoned after eight seconds, the visitor is told what
   * is happening after three, and the call that failed is tried again and again until it
   * answers, at which point the page that never got its data asks for it again — once.
   */
  var REQUEST_TIMEOUT_MS = 8000;
  var COLD_START_AFTER_MS = 3000;
  // 3s, 6s, then every 12s: a cold start runs 30–60s, so the tail is what does the work.
  var WAKE_DELAYS_MS = [3000, 6000, 12000];
  // ~81 seconds of asking, past the longest cold start, and then we stop claiming it is
  // about to come back.
  var WAKE_ATTEMPTS = 8;
  // Remembers that the load happening right now has already spent its automatic reload.
  // Cleared as soon as a load succeeds, so a second cold start later in the same tab —
  // Render sleeps again after a quarter of an hour of reading — is treated as the new
  // event it is rather than as the loop the counter exists to stop.
  var WOKE_KEY = 'oak-woke';

  var COLD_START_MESSAGE = 'OAK đang khởi động, vui lòng đợi khoảng 30 giây…';
  // A sleeping or overloaded server is the likely cause here, not the visitor's own line,
  // so the wording says OAK has yet to answer rather than sending the reader to a router.
  var UNREACHABLE_MESSAGE = 'OAK chưa phản hồi, thử lại sau ít phút.';
  // Said when the server has just answered but the page cannot be reloaded under the
  // visitor: they have typed something, or the automatic reload is already spent.
  var READY_MESSAGE = 'Máy chủ đã sẵn sàng. Vui lòng tải lại trang để xem nội dung.';

  /* One strip across the top, reused: the waiting notice and the giving-up message are the
     same banner saying different things, and two of them would cover the page twice over.
     A banner rather than a toast, because the page behind it will not finish loading and
     the explanation has to outlive three seconds. */
  var BANNER_ID = 'oak-server-down';
  var BANNER_CLASS = 'fixed inset-x-0 top-0 z-50 px-6 py-3 font-body-md text-body-md text-center ';

  function showBanner(message, role, colors) {
    var banner = document.getElementById(BANNER_ID);
    if (!banner) {
      banner = document.createElement('div');
      banner.id = BANNER_ID;
      document.body.appendChild(banner);
    }
    // Waiting is progress and must not interrupt a screen reader mid-sentence; a server
    // that is not coming back is an interruption.
    banner.setAttribute('role', role);
    banner.className = BANNER_CLASS + colors;
    banner.textContent = message;
  }

  function hideBanner() {
    var banner = document.getElementById(BANNER_ID);
    if (banner) {
      banner.remove();
    }
  }

  // True while the retry loop below is running, which makes it the owner of the banner.
  var waking = false;

  /**
   * True once the visitor has put something into this page. Most of the site renders from
   * static markup, so a page whose data call failed is still perfectly usable — the
   * contact form, the sign-up form and the login form all work while the API is asleep —
   * and reloading it would throw away what was typed with no way back.
   *
   * What is recorded is the interaction, not the state of the fields: a page fills its own
   * fields in (ket-qua-tim-kiem.html puts ?q= into the search box before its first await)
   * and an untouched checkbox reads 'on' by spec, so judging by value would call almost
   * every page "typed into" and the automatic reload would never fire where it is needed
   * most — the first page of a cold start.
   */
  var visitorTyped = false;
  function markTyped() {
    visitorTyped = true;
  }
  // Capture phase: a handler that stops propagation must not also hide that somebody typed.
  document.addEventListener('input', markTyped, true);
  document.addEventListener('change', markTyped, true);

  /**
   * Reload, but only once per failed load and never under someone who is typing.
   * Reloading is the only way from here to replay a page's own init(), and it is also the
   * one thing that can loop: a server that answers the probe and then fails the reloaded
   * page's own request lands straight back in the wake loop, and a visitor cannot leave a
   * page that reloads every ten seconds. On that path nothing ever clears the counter, so
   * the second time round — and whenever there is text to lose — the banner says the
   * server is ready and the visitor decides when to reload.
   */
  function reloadOnce() {
    var spent;
    try {
      spent = sessionStorage.getItem(WOKE_KEY) !== null;
      if (!spent) {
        sessionStorage.setItem(WOKE_KEY, '1');
      }
    } catch (error) {
      // Storage blocked (private browsing): there is no counter to keep, so an automatic
      // reload here would be uncapped. One click is a cheaper price than a tab that
      // reloads itself every few seconds.
      spent = true;
    }
    if (spent || visitorTyped) {
      showBanner(READY_MESSAGE, 'status', 'bg-primary text-on-primary');
      return;
    }
    location.reload();
  }

  /** Ask until the API answers, then load the page that never got its data. */
  function startWake() {
    if (waking) {
      return;
    }
    waking = true;
    showBanner(COLD_START_MESSAGE, 'status', 'bg-primary text-on-primary');

    var attempt = 0;
    var retry = function () {
      if (attempt >= WAKE_ATTEMPTS) {
        waking = false;
        showBanner(UNREACHABLE_MESSAGE, 'alert', 'bg-error text-on-error');
        return;
      }
      setTimeout(ask, WAKE_DELAYS_MS[Math.min(attempt, WAKE_DELAYS_MS.length - 1)]);
    };
    var ask = function () {
      attempt += 1;
      // The call that actually failed, not /api/health: this way the probe is the page's
      // own request, on the page's own auth path and through api(), which gives it the
      // same eight-second ceiling as any other read — a connection that hangs rather than
      // fails cannot stall the loop on one attempt. A Render cold start cannot answer
      // either route before it is ready (db.js awaits the schema query at module load, so
      // the process does not listen until Postgres has answered), so what this buys over
      // /api/health is the shared ceiling and one code path, not a deeper check.
      api('/api/auth/me').then(function () {
        waking = false;
        hideBanner();
        // Each page fetches its own data in its own init(), and there is no way from here
        // to replay those calls; the page is asked for again instead. reloadOnce() is the
        // one that decides whether that is safe — the banner has been up for anywhere
        // between three and eighty seconds, which is long enough to have filled a form.
        reloadOnce();
      }, retry);
    };
    setTimeout(ask, WAKE_DELAYS_MS[0]);
  }

  /**
   * Watch the one request every page makes before it can draw. Past three seconds the
   * visitor is told the server is waking rather than left with an empty page; an answer
   * of any kind takes the notice back down.
   */
  function watchColdStart(promise) {
    var slow = setTimeout(function () {
      showBanner(COLD_START_MESSAGE, 'status', 'bg-primary text-on-primary');
    }, COLD_START_AFTER_MS);
    return promise.then(
      function (value) {
        clearTimeout(slow);
        hideBanner();
        // This load got its data, so the reload it may have spent getting here is spent
        // and done with. Without this the cap would be "one reload per tab, ever", and the
        // next cold start in the same tab would end on the give-up message — telling the
        // visitor their network is down at the moment the server answered.
        try {
          sessionStorage.removeItem(WOKE_KEY);
        } catch (error) {
          // Storage blocked: there was no counter to clear.
        }
        return value;
      },
      function (error) {
        clearTimeout(slow);
        // A failure takes the notice down too. Only a network failure means "asleep", and
        // startWake() puts the banner straight back up for that one; every other kind —
        // a 500 from a database still resuming, say — is not a cold start, and leaving
        // "OAK đang khởi động" pinned over a page that has finished rendering promises
        // something that is never going to happen.
        hideBanner();
        throw error;
      },
    );
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

    // A read that hangs forever is worse than one that fails: the page keeps its skeleton
    // and nothing ever says why. Reads only, though. Giving up on a write is not the same
    // act: the server may well go on and do it, and a booking that commits on a waking
    // instance after nine seconds would be reported to the customer as a failure to retry
    // — and the retry then collides with the row the first one wrote. Writes carry their
    // own spinner, and waiting is the safe answer for them.
    var controller = null;
    var timeout = 0;
    if (typeof AbortController === 'function' && init.method === 'GET') {
      controller = new AbortController();
      init.signal = controller.signal;
      timeout = setTimeout(function () {
        controller.abort();
      }, REQUEST_TIMEOUT_MS);
    }

    var payload;
    try {
      var response = await fetch(path, init);
      payload = await response.json();
    } catch (error) {
      // An abort lands here too, and reads the same way to the visitor: no answer.
      throw apiError('NETWORK_ERROR', 'Không kết nối được máy chủ, vui lòng thử lại.');
    } finally {
      clearTimeout(timeout);
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
        return redirectToLogin(loginPage);
      }
      throw apiError(
        envelope.code || 'UNKNOWN_ERROR',
        envelope.message || 'Đã có lỗi xảy ra, vui lòng thử lại sau.',
      );
    }

    // A fresh login counts as a session too, for pages that sign in without reloading —
    // and so does a registration, which issues the same cookie.
    if (
      (path === '/api/auth/login' || path === '/api/auth/register') &&
      payload.data &&
      payload.data.user
    ) {
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
  // Which login page this one belongs to. Three of them now, and a page cannot be sorted
  // into one by looking at it: the guard it calls is what says whose page it is, so
  // requirePartner and requireStaff each name their own and everything else keeps the
  // customer default.
  var loginPage = LOGIN_PAGE;

  /** The signed-in user, or null. Never redirects — a guest page must still render. */
  function me() {
    if (!mePromise) {
      mePromise = watchColdStart(api('/api/auth/me')).then(
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
          if (serverUnreachable) {
            // Most often the server is asleep rather than gone, so say so and keep asking.
            startWake();
          }
          return null;
        },
      );
    }
    return mePromise;
  }

  /**
   * Send the visitor to a login page carrying where they were headed, and hand back a
   * promise that never settles so the caller's `await` stops there. `next` names that
   * destination for a caller who wants to come back somewhere other than this very url.
   */
  function redirectToLogin(page, next) {
    location.href = page + '?next=' + encodeURIComponent(next || currentUrl());
    return new Promise(function () {});
  }

  /**
   * Say plainly that the backend is down, and stop the caller the same way a redirect
   * does. While the wake-up loop is still asking it owns the banner and is saying
   * something more useful than this — its own giving-up leaves this message behind.
   */
  function reportServerUnreachable() {
    if (!waking) {
      showBanner(UNREACHABLE_MESSAGE, 'alert', 'bg-error text-on-error');
    }
    return new Promise(function () {});
  }

  async function requireLogin(next) {
    var user = await me();
    if (serverUnreachable) {
      return reportServerUnreachable();
    }
    return user || redirectToLogin(LOGIN_PAGE, next);
  }

  async function requirePartner() {
    loginPage = PARTNER_LOGIN_PAGE;
    var user = await me();
    if (serverUnreachable) {
      return reportServerUnreachable();
    }
    return user && user.role === 'partner' ? user : redirectToLogin(PARTNER_LOGIN_PAGE);
  }

  /** The same gate for the technician's own pages, which belong to the staff login. */
  async function requireStaff() {
    loginPage = STAFF_LOGIN_PAGE;
    var user = await me();
    if (serverUnreachable) {
      return reportServerUnreachable();
    }
    return user && user.role === 'staff' ? user : redirectToLogin(STAFF_LOGIN_PAGE);
  }

  /** 350000 → "350.000đ". Empty string for anything that is not a number. */
  function fmtPrice(value) {
    var number = Number(value);
    if (value === null || value === undefined || value === '' || !isFinite(number)) {
      return '';
    }
    return number.toLocaleString('vi-VN') + 'đ';
  }

  /** 350000 → "Từ 350.000đ" for an opening price, "350.000đ" for an exact one. */
  function fmtPriceFrom(value, isFrom) {
    return (isFrom ? 'Từ ' : '') + fmtPrice(value);
  }

  /**
   * "2026-08-10" (or a full ISO string) → the Vietnamese date, in one of four shapes:
   *
   *   fmtDate(iso)              "Thứ Hai, 10/08/2026"   what every existing caller reads
   *   fmtDate(iso, 'long')      "10 Tháng 8, 2026"      a date standing on its own
   *   fmtDate(iso, 'short')     "10/08/2026"            a date inside a range
   *   fmtDate(iso, 'weekday')   "Thứ Hai"               the day name by itself
   *
   * The shapes are here rather than at the call sites because the same appointment was
   * being written three ways: the card on Lịch hẹn của tôi and the confirmation page each
   * spelled out "10 Tháng 8, 2026" by hand, and the partner calendar its own range.
   *
   * The two inputs are different kinds of thing and are read differently. A bare
   * 'YYYY-MM-DD' is a calendar date — a booking's day — and already says what it means.
   * A full timestamp is an instant, stored in UTC, and the reader's own clock decides
   * which day that instant fell on: a post written at 01:00 in Vietnam is stamped 18:00
   * the day before in UTC, and cutting the string at the 'T' would date it yesterday.
   *
   * Every shape is a pattern in the RULES list of oak-i18n.js, which is what turns the
   * weekday and the month into English; a fifth shape invented at a call site would not be.
   */
  function fmtDate(iso, mode) {
    if (!iso) {
      return '';
    }
    var text = String(iso);
    var year;
    var month;
    var day;
    if (text.indexOf('T') !== -1) {
      var stamp = new Date(text);
      if (isNaN(stamp.getTime())) {
        return text;
      }
      year = stamp.getFullYear();
      month = stamp.getMonth() + 1;
      day = stamp.getDate();
    } else {
      var parts = text.split('-');
      year = Number(parts[0]);
      month = Number(parts[1]);
      day = Number(parts[2]);
    }
    if (!year || !month || !day) {
      return text;
    }
    var weekday = WEEKDAYS[new Date(year, month - 1, day).getDay()];
    if (mode === 'weekday') {
      return weekday;
    }
    if (mode === 'long') {
      return day + ' Tháng ' + month + ', ' + year;
    }
    var pad = function (value) {
      return String(value).padStart(2, '0');
    };
    var numeric = pad(day) + '/' + pad(month) + '/' + year;
    return mode === 'short' ? numeric : weekday + ', ' + numeric;
  }

  /** Two dates as one span: "10/08/2026 – 16/08/2026". One dash, spelled once. */
  function fmtRange(from, to) {
    return fmtDate(from, 'short') + ' – ' + fmtDate(to, 'short');
  }

  /** Normalise a stored time to "HH:MM" ("9:0" and "14:00:00" both land on HH:MM). */
  function fmtTime(value) {
    if (!value) {
      return '';
    }
    var match = String(value).match(/^(\d{1,2}):(\d{1,2})/);
    return match ? match[1].padStart(2, '0') + ':' + match[2].padStart(2, '0') : String(value);
  }

  /**
    * Has this appointment begun? The line every screen draws before it offers to cancel or
    * to move one — and the server draws the same one, refusing both past it.
    *
    * The "upcoming" tab deliberately keeps a visit that has started, because a customer
    * sitting in the chair must be able to find the booking they are sitting in; what they
    * may still DO with it is this question, asked separately. Read in the READER'S clock,
    * like every other deadline on those screens (the cancel cutoff among them), so one card
    * cannot say two different things about one hour.
    */
  function hasStarted(booking) {
    var date = String(booking.date).split('-').map(Number);
    var at = fmtTime(booking.time).split(':').map(Number);
    return Date.now() >= new Date(date[0], date[1] - 1, date[2], at[0], at[1]).getTime();
  }

  function qs(name) {
    return new URLSearchParams(location.search).get(name);
  }

  /**
   * What to pass as `behavior` to scrollIntoView(). The reduced-motion rule in oak-utils.css
   * cannot answer for these calls — an explicit behavior option beats the `scroll-behavior`
   * property — so the four places that glide a step or an error into view ask
   * here instead of each testing the media query for itself.
   */
  function scrollBehavior() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'auto'
      : 'smooth';
  }

  /* Where each field of meta() lands. A page carries the tags it wants; the ones it left out
     are skipped rather than created, so a page that shipped no og: block stays without one. */
  var META_TAGS = {
    description: ['meta[name="description"]', 'meta[property="og:description"]'],
    image: ['meta[property="og:image"]'],
  };

  /** A description reads to about 160 characters, so a longer one is cut back to a space. */
  function summarise(text) {
    var flat = String(text).replace(/\s+/g, ' ').trim();
    if (flat.length <= 160) {
      return flat;
    }
    var cut = flat.slice(0, 157);
    var space = cut.lastIndexOf(' ');
    return (space > 0 ? cut.slice(0, space) : cut) + '…';
  }

  /**
   * Restate the <head> of a detail page around the thing it turned out to be about. The markup
   * is written before the salon, post or service is known, so it ships a sentence about the
   * kind of page it is and this replaces it once the fetch lands.
   *
   * It runs after oak-i18n.js has been over the head and that pass never comes back, so every
   * string it writes asks for its own English through translated(). Mostly that answers
   * nothing: a salon's name and a post's summary are the subject's own words, which the
   * English site leaves in Vietnamese too. It is the wording a page wraps around them — the
   * "Hồ sơ chuyên gia" in front of a staff name — that would otherwise be the one Vietnamese
   * left on an English page. A field with nothing behind it is left alone, and the page keeps
   * the standing sentence it shipped with, translated.
   */
  function meta(values) {
    if (values.title) {
      document.title = translated(values.title);
      setMetaTag('meta[property="og:title"]', document.title);
    }
    ['description', 'image'].forEach(function (field) {
      if (!values[field]) {
        return;
      }
      var value = field === 'image' ? values[field] : translated(summarise(values[field]));
      META_TAGS[field].forEach(function (selector) {
        setMetaTag(selector, value);
      });
    });
  }

  function setMetaTag(selector, value) {
    var tag = document.querySelector(selector);
    if (tag) {
      tag.setAttribute('content', value);
    }
  }

  var TOAST_COLORS = {
    success: 'bg-primary text-on-primary',
    error: 'bg-error text-on-error',
    // Not everything a toast says is good news. "Đã tải ảnh lên, nhớ bấm Lưu thay đổi."
    // is a reminder that the work is only half done, and it read as a success in the same
    // black as "Đã lưu". 4.52:1 for #703800 on #fda055, past AA for body text.
    info: 'bg-secondary-container text-on-secondary-container',
  };

  /* Two live regions, empty and already in the document, one per urgency. A screen reader
     subscribes to a live region when it enters the DOM; an element created, filled and
     appended in the same tick — which is what toast() used to do — can be added and
     announced before anything is listening, and several of them drop it. So the regions go
     in first and only ever change contents.

     Not one region with a switchable role: `role="alert"` is `aria-live="assertive"` by
     definition, and flipping the attribute on a node a reader is already subscribed to is
     the least reliably implemented thing in this corner of the spec.

     They carry no styling at all. The message itself is `position: fixed`, so which of the
     two holds it makes no difference to where it lands on screen.

     oak-header.js calls this while the customer bar is being written, well before any page
     code can raise a toast. The partner console has no such file, so initHeader() below —
     which runs on every page — calls it too. */
  var LIVE_SPECS = {
    status: { id: 'oak-live-status', role: 'status', live: 'polite' },
    alert: { id: 'oak-live-alert', role: 'alert', live: 'assertive' },
  };

  /** Both regions, made if this is the first ask, keyed the way LIVE_SPECS is. */
  function liveRegions() {
    var regions = {};
    Object.keys(LIVE_SPECS).forEach(function (key) {
      var spec = LIVE_SPECS[key];
      var region = document.getElementById(spec.id);
      if (!region) {
        region = document.createElement('div');
        region.id = spec.id;
        region.setAttribute('role', spec.role);
        region.setAttribute('aria-live', spec.live);
        document.body.appendChild(region);
      }
      regions[key] = region;
    });
    return regions;
  }

  /**
   * How long the message stays up. Three seconds reads "Đã lưu" but not a sentence saying
   * why something failed, and a message offering a choice has to outlive the reading of it,
   * so both start from five. Past 40 characters it buys 50ms of reading time each, to 8s.
   */
  function toastDuration(message, type, hasAction) {
    var base = type === 'error' || hasAction ? 5000 : 3000;
    return Math.min(8000, base + Math.max(0, String(message).length - 40) * 50);
  }

  // Focus leaving a message it had been holding does not start the clock over: it gets
  // whatever is left of its window, and never less than this.
  var TOAST_REARM_MIN = 2000;

  // One message at a time. Two of them stack on the same spot and read as one sentence,
  // and the second is the one the visitor just caused, so it takes the slot. The trade-off
  // is that this displaces a message holding keyboard focus too — an undo lost that way is
  // an undo the visitor stopped attending to.
  var activeToast = null;

  function closeToast(entry) {
    clearTimeout(entry.timer);
    entry.element.remove();
    if (activeToast === entry) {
      activeToast = null;
    }
  }

  /** Hand the keyboard back what it was on, if that is still something on the page. */
  function restoreToastFocus(anchor) {
    if (anchor && typeof anchor.focus === 'function' && document.contains(anchor)) {
      anchor.focus();
    }
  }

  /**
   * @param {string} [type] - 'error' paints it red and announces it as an alert.
   * @param {object} [action] - {actionLabel, onAction}: a button inside the message that
   *   runs onAction and dismisses. Callers that only report something leave it out.
   */
  function toast(message, type, action) {
    var withAction = Boolean(action && action.actionLabel && action.onAction);
    if (activeToast) {
      closeToast(activeToast);
    }

    // An error interrupts; anything else is progress the visitor asked for. The urgency
    // belongs to the region the message is put into, not to the message.
    var region = liveRegions()[type === 'error' ? 'alert' : 'status'];

    var element = document.createElement('div');
    // A page that pins its own booking bar to the bottom edge marks it, and the message
    // clears that bar (~68px tall) instead of landing on top of it. The bar is only laid
    // out on narrow screens and at some wizard steps, so ask whether it is rendered
    // (offsetParent) rather than whether the markup merely exists.
    var stickyBar = document.querySelector('[data-oak-sticky-cta]');
    var offset = stickyBar && stickyBar.offsetParent ? 'bottom-24' : 'bottom-6';
    element.className =
      'fixed ' + offset + ' left-1/2 -translate-x-1/2 z-50 max-w-[90vw] px-6 py-3 rounded-full ' +
      'shadow-lg font-body-md text-body-md text-center ' +
      (withAction ? 'flex items-center gap-4 ' : '') +
      (TOAST_COLORS[type] || TOAST_COLORS.success);
    element.textContent = message;

    var entry = { element: element, timer: 0 };
    var duration = toastDuration(message, type, withAction);
    var shownAt = Date.now();
    var arm = function (ms) {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(function () {
        closeToast(entry);
      }, ms);
    };
    arm(duration);

    if (withAction) {
      // Where the keyboard was when this appeared. Escape and the button itself hand it
      // back there, rather than dropping focus at the top of the document.
      var anchor = document.activeElement;

      var button = document.createElement('button');
      button.type = 'button';
      button.className =
        'shrink-0 min-h-[44px] px-2 underline font-label-md text-label-md uppercase tracking-wider';
      button.textContent = action.actionLabel;
      button.addEventListener('click', function () {
        closeToast(entry);
        action.onAction();
        restoreToastFocus(anchor);
      });
      element.appendChild(button);

      // A countdown running out under the visitor's own hands is a trap: while the message
      // holds focus it does not expire at all.
      element.addEventListener('focusin', function () {
        clearTimeout(entry.timer);
      });
      element.addEventListener('focusout', function () {
        arm(Math.max(TOAST_REARM_MIN, duration - (Date.now() - shownAt)));
      });
      element.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') {
          closeToast(entry);
          restoreToastFocus(anchor);
        }
      });
    }

    region.appendChild(element);
    activeToast = entry;
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
      // A technician's account is their schedule rather than the customer profile page.
      // Groundwork, not live behaviour: as the comment above says, this link belongs to
      // the partner console bar, and requirePartner keeps a technician off every page
      // that carries one — no staff-reachable page has an [aria-label="Tài khoản"] link
      // today. It is one line, and it is the line that will be wrong if one ever does.
      link.href = user.role === 'staff' ? STAFF_HOME_PAGE : PROFILE_PAGE;
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

  /**
   * Hang the unread mark on the bell, from the count /api/auth/me already answered with.
   *
   * It used to ask GET /api/notifications?count_only=true for that number itself, which made
   * a second round trip out of one integer the page had just been told. The endpoint is still
   * there and thong-bao.html and the two technician pages still read it — they refresh a
   * count after something is marked read, which this never does: the mark is drawn once, for
   * the load it belongs to.
   */
  function initNotificationBell(user) {
    // The customer menu and the technician menu each carry a row of this name, and only one
    // of the two is on screen. Taking the first in document order would hang the mark inside
    // the group initAuthMenu just put away, where nobody would ever see it — so the first one
    // outside a put-away group wins. The plain first behind it is for the cached page that
    // meets an older oak-header.js, whose one row is in a group no persona here matches: a
    // mark in the wrong row still says there is something to read, and none says nothing.
    // Safe by ordering: initHeader() settles the groups before this one is called, and
    // nothing here waits on anything, so the two cannot interleave.
    var bells = document.querySelectorAll('[aria-label="Thông báo"]');
    var bell = Array.prototype.filter.call(bells, function (node) {
      return !(node.closest && node.closest('.hidden'));
    })[0] || bells[0];
    if (!bell) {
      return;
    }
    if (bell.tagName === 'A') {
      bell.href = NOTIFICATIONS_PAGE;
    }

    // Absent on a page cached from before /me carried it, which reads as "nothing to see":
    // a missing mark is the same thing a reader with an empty inbox gets.
    if (!user.unread_count) {
      return;
    }

    bell.classList.add('relative');
    var dot = document.createElement('span');
    // The bells answering to this name are the two "Thông báo" entries oak-header.js writes
    // into the menu, one per persona, and each names its own spot through data-oak-dot:
    // across a full-width menu entry a corner lands nowhere near the words. The default
    // behind it is for a bell drawn as a lone glyph. Nothing in the partner console answers
    // here — it counts pending bookings on a bell of its own, further down.
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

  // The partner console's own bell, which counts something else entirely: bookings still
  // waiting for the owner's decision. It is found by a data attribute and not by a
  // Vietnamese aria-label, so initNotificationBell above can never claim it and send its
  // href back to the customer notifications page.
  var PENDING_BELL = '[data-oak-pending-bell]';
  var PENDING_BADGE = '[data-oak-pending-count]';
  var PENDING_LABEL = 'Lịch chờ xác nhận';
  var PENDING_MAX = 99;

  /** Today where the salon is. toISOString() is UTC — still yesterday here until 7am. */
  function todayISO() {
    var now = new Date();
    var pad = function (value) {
      return String(value).padStart(2, '0');
    };
    return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  }

  /**
   * Put a count on the console bell: the badge, and the bell's own name — a control with an
   * aria-label is announced by that label alone and never by what it holds.
   * Exported because the dashboard already reads that very list, and asking again for a
   * number it is holding would be a second request for nothing.
   */
  function setPendingBadge(total) {
    var bell = document.querySelector(PENDING_BELL);
    if (!bell) {
      return total;
    }
    bell.setAttribute(
      'aria-label',
      translated(total ? PENDING_LABEL + ': ' + total : PENDING_LABEL),
    );
    var badge = bell.querySelector(PENDING_BADGE);
    if (badge) {
      badge.textContent = total > PENDING_MAX ? PENDING_MAX + '+' : String(total);
      badge.classList.toggle('hidden', total === 0);
      badge.classList.toggle('flex', total > 0);
    }
    return total;
  }

  /** The one count request for the console pages that do not read that list themselves. */
  async function pendingBadge() {
    if (!document.querySelector(PENDING_BELL)) {
      return 0;
    }
    try {
      var rows = await api('/api/partner/bookings?status=pending&limit=1&from=' + todayISO());
      return setPendingBadge((rows.meta && rows.meta.total) || 0);
    } catch (error) {
      // A bell with no number is the honest reading of "could not ask".
      return 0;
    }
  }

  // Only reached when /api/salons cannot answer: an empty list of areas would be one more
  // control that does nothing, so the hero area field always has somewhere to go.
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

  // Resolved at most once per page load: kham-pha.html asks for these names as it starts,
  // to fill the area field of its hero, and any second caller is handed that same answer.
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
   * The menu ships all three readings of itself — the entries for a visitor who has not
   * signed in, the ones for a customer, and the ones for a technician — and this keeps
   * whichever the account calls for. Called only once a real user is known, so the markup
   * as authored is already the guest reading. Everyone who is not staff reads as 'user':
   * a partner meets this bar on the public side of the site, where the customer entries
   * are the ones that lead anywhere.
   *
   * A technician is only asked for once the page proves it has one to give. Both scripts are
   * unhashed and cached for five minutes apiece, so a reader can hold a header written before
   * the staff group existed while running this — and asking for a group nobody answers to
   * would put every group away, leaving an account with no entries and, worse, no way to sign
   * out of itself. The customer reading is the wrong menu for her; it is still a menu.
   */
  function initAuthMenu(user) {
    var wanted = user.role === 'staff' && document.querySelector('[data-oak-auth="staff"]')
      ? 'staff' : 'user';
    Array.prototype.forEach.call(document.querySelectorAll('[data-oak-auth]'), function (group) {
      group.classList.toggle('hidden', group.getAttribute('data-oak-auth') !== wanted);
    });
  }

  async function initHeader() {
    // Before the /api/auth/me await: a toast raised during the first fetch must already
    // have somewhere to be announced from.
    liveRegions();
    var user = await me();
    if (!user) {
      return;
    }
    initAccountLink(user);
    initAuthMenu(user);
    initNotificationBell(user);
  }

  /* --------------------------------------------------------------- measurement
   * One anonymous line per thing that happened: what it was, which page it was on and
   * where the visitor came from. No account, no cookie of its own, nothing a person could
   * be picked out of — `meta` is for counts and labels ('total', 'category'), and the
   * server drops anything in it that could be a phone number or an address.
   *
   * sendBeacon first: it survives the page being left, which is exactly when the last
   * event of a visit is sent. Not every browser here has it, so a keepalive fetch stands
   * behind it, and the whole thing is wrapped — measurement that breaks the thing it is
   * measuring is worse than no measurement.
   */
  function track(name, meta) {
    try {
      var body = JSON.stringify({
        name: name,
        page: pageName(),
        // Path only: a referring url's query string can carry someone's search terms.
        ref: String(document.referrer || '').split('?')[0].split('#')[0],
        meta: meta || undefined,
      });
      if (navigator.sendBeacon) {
        // As a Blob, so the body arrives with a Content-Type express.json() will parse.
        if (navigator.sendBeacon('/api/events', new Blob([body], { type: 'application/json' }))) {
          return;
        }
      }
      fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true,
      }).catch(function () {});
    } catch (error) {
      // Nothing to do and nobody to tell: an event that did not get sent is not the
      // visitor's problem.
    }
  }

  /* One booking, one vocabulary. Before this, the same appointment was an orange chip on
     "Lịch hẹn của tôi", a grey one on the partner dashboard and a coloured left edge on the
     console calendar — three answers to "what state is this in?" for one row of one table.
     Label, icon and chip tone therefore live here, beside the price and date formatters,
     and every page that paints a status reads them from here.

     `class` names the chip's own colours only; the shape (pill, padding, text size) belongs
     to the page, because a 12px chip on a card and a strip on a calendar are not the same
     object. `completed` is deliberately quiet: a finished appointment needs no colour to
     shout with. The English of each label lives in the dictionary of each page that shows
     it — the strings are ordinary text nodes by the time a reader sees them. */
  var BOOKING_STATUSES = ['pending', 'confirmed', 'completed', 'cancelled', 'no_show'];

  var BOOKING_STATUS = {
    pending: {
      label: 'Chờ xác nhận',
      icon: 'schedule',
      class: 'bg-secondary-container text-on-secondary-container',
    },
    confirmed: {
      label: 'Đã xác nhận',
      icon: 'check_circle',
      class: 'bg-success-container text-success',
    },
    completed: {
      label: 'Đã hoàn thành',
      icon: 'task_alt',
      class: 'bg-surface-container-high text-on-surface',
    },
    cancelled: {
      label: 'Đã hủy',
      icon: 'cancel',
      class: 'bg-error-container text-on-error-container',
    },
    // Absent is not cancelled: it keeps a tone of its own so the two never read alike.
    no_show: {
      label: 'Không đến',
      icon: 'person_off',
      class: 'bg-tertiary-container text-on-tertiary-container',
    },
  };

  /* A status the server has not taught this build about still has to render as something,
     so it renders as itself in the neutral tone rather than as a blank chip. */
  function bookingStatus(status) {
    return (
      BOOKING_STATUS[status] || {
        label: String(status || ''),
        icon: 'event',
        class: 'bg-surface-container-high text-on-surface',
      }
    );
  }

  /* A picture is shown a few hundred pixels wide and a phone camera hands over four
     thousand, so it is re-drawn to `maxEdge` and re-encoded before it leaves the browser.
     POST /api/uploads accepts one megabyte decoded, which is generous for what this
     produces and far under what an untouched camera file weighs, so every screen that
     uploads goes through here first.

     WebP is asked for and not assumed: `toDataURL` answers with PNG when it cannot write
     the type it was handed, and a PNG re-encode of a photograph is larger than the JPEG
     that came in. Whether this browser can write one is settled once, on a canvas one pixel
     square, and remembered — asked per picture, a browser without WebP would encode the
     whole photograph as a PNG and then throw that PNG away, which is the slowest thing this
     function could possibly do on the machines least able to afford it. Where the answer is
     no the canvas is encoded as JPEG, which every browser can write. But the name is read
     back off the bytes rather than off the probe, because the probe only settles what was
     worth asking for and a fallback can still happen on the picture itself — the server
     reads the extension and nothing else from it.

     null whenever this cannot honestly hand back a smaller picture: a file the browser could
     not decode, an image it decoded to nothing, a canvas it refused to draw on or to read
     back. The caller then posts the raw file and the server's own message explains anything
     it refuses — which is a worse outcome than compressing, and a far better one than
     posting whatever a broken canvas returned. A zero-sized canvas answers `toDataURL` with
     the string 'data:,' and nothing else in the chain would have questioned it: the server
     would have decoded it to three bytes and stored them, and the person would have got a
     blank square back for their photograph. So the encoded answer has to say it is an image
     before it is believed. */
  var COMPRESS_MAX_EDGE = 1600;
  var COMPRESS_QUALITY = 0.82;
  var webpSupport = null;

  function canWriteWebp() {
    if (webpSupport === null) {
      try {
        var probe = document.createElement('canvas');
        probe.width = 1;
        probe.height = 1;
        webpSupport = probe.toDataURL('image/webp').indexOf('data:image/webp') === 0;
      } catch (error) {
        webpSupport = false;
      }
    }
    return webpSupport;
  }

  function compressImage(file, options) {
    var settings = options || {};
    var maxEdge = settings.maxEdge || COMPRESS_MAX_EDGE;
    var quality = settings.quality || COMPRESS_QUALITY;
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var image = new Image();
      image.onload = function () {
        try {
          if (!image.width || !image.height) {
            URL.revokeObjectURL(url);
            resolve(null);
            return;
          }
          var scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
          var canvas = document.createElement('canvas');
          canvas.width = Math.round(image.width * scale);
          canvas.height = Math.round(image.height * scale);
          var context = canvas.getContext('2d');
          if (!context) {
            URL.revokeObjectURL(url);
            resolve(null);
            return;
          }
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          URL.revokeObjectURL(url);
          var data = canvas.toDataURL(canWriteWebp() ? 'image/webp' : 'image/jpeg', quality);
          if (data.indexOf('data:image/') !== 0) {
            resolve(null);
            return;
          }
          /* The probe decides what to ASK for; the bytes decide what it is CALLED. toDataURL
             is specified to fall back silently to another type it can write rather than to
             refuse, and a browser whose one-pixel probe managed WebP can still fall back on a
             real photograph. Naming the file from the probe would then post PNG bytes as
             .webp — storeImage reads that extension and nothing else, so Supabase would serve
             them under Content-Type image/webp and the salon would get a broken square for a
             picture that uploaded without a word of complaint. */
          var mime = data.slice(5, data.indexOf(';'));
          var names = {
            'image/webp': 'anh-oak.webp',
            'image/jpeg': 'anh-oak.jpg',
            'image/png': 'anh-oak.png',
          };
          if (!names[mime]) {
            resolve(null);
            return;
          }
          resolve({ filename: names[mime], data: data });
        } catch (error) {
          /* getContext can answer null, and drawImage and toDataURL both throw on a canvas
             the browser will not give back — one tainted by an image from elsewhere, or one
             larger than this device's limit. The raw file is still a picture; a thrown
             error here would have lost it. */
          URL.revokeObjectURL(url);
          resolve(null);
        }
      };
      image.onerror = function () {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      image.src = url;
    });
  }

  /* One set of promises, said the same way wherever they are said. They are claims about
     how OAK works — what it costs to change your mind, when a person answers — so a page
     that words them its own way is a page that quietly promises something else.
     Their English lives in the dictionary of each page that renders them. */
  var TRUST = {
    CANCEL_POLICY: 'Hủy/đổi miễn phí đến trước 2 tiếng',
    /**
     * The same promise, carrying the cutoff THIS salon set rather than the platform-wide
     * one. CANCEL_POLICY above is the fallback: before the salon has loaded, and for a
     * payload that does not carry the field. Lives here because the four pages of the
     * booking path all say it, and they must not be able to drift apart.
     */
    cancelPolicy: function (hours) {
      return hours ? 'Hủy/đổi miễn phí đến trước ' + hours + ' tiếng' : TRUST.CANCEL_POLICY;
    },
    PAYMENT: 'Thanh toán tại salon, không cần cọc',
    SUPPORT_HOURS: 'Phản hồi trong 1 ngày làm việc · hello@oakbeauty.vn',
    RESPONSE_SLA: '1 ngày làm việc',
  };

  window.OAK = {
    api: api,
    me: me,
    districts: loadDistricts,
    requireLogin: requireLogin,
    requirePartner: requirePartner,
    requireStaff: requireStaff,
    fmtPrice: fmtPrice,
    fmtPriceFrom: fmtPriceFrom,
    fmtDate: fmtDate,
    fmtRange: fmtRange,
    fmtTime: fmtTime,
    hasStarted: hasStarted,
    bookingStatus: bookingStatus,
    compressImage: compressImage,
    BOOKING_STATUSES: BOOKING_STATUSES,
    todayISO: todayISO,
    pendingBadge: pendingBadge,
    setPendingBadge: setPendingBadge,
    qs: qs,
    scrollBehavior: scrollBehavior,
    meta: meta,
    toast: toast,
    liveRegions: liveRegions,
    track: track,
    TRUST: TRUST,
    logout: logout,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initHeader);
  } else {
    initHeader();
  }
})();
