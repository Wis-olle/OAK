/*
 * OAK Beauty — the customer top bar, written into every page from one place.
 *
 * Each customer page carries an empty `<header data-oak-header>` followed immediately by a
 * plain (never deferred) tag for this file, so the shell is already parsed when this runs and
 * the bar is on screen in the same paint as the rest of the page — no late swap, no flicker.
 * Ordering is what makes the rest of the site keep working unchanged: Alpine is deferred, so
 * it starts after this and picks up the x-data below; oak-api.js and oak-i18n.js do their
 * header passes at DOMContentLoaded, later still, and find the whole bar in place.
 *
 * The trade this makes: with scripting turned off there is no way through the site at all,
 * because the bar is the only way through and it is written by script. That is accepted here
 * rather than worked around — every page already draws its own body through Alpine and asks
 * oak-api.js for the data to fill it, so a reader without scripting has nothing to read.
 *
 * Five things elsewhere reach into this markup by attribute, and renaming any of them breaks
 * that page silently:
 *   data-oak-avatar-icon / data-oak-avatar-img  oak-api.js swaps in the reader's photo
 *   data-oak-unread                             oak-api.js reveals the unread mark
 *   data-oak-dot                                where oak-api.js puts the mark on a row
 *   data-oak-auth="guest" | "user" | "staff"    oak-api.js picks the one that applies
 *   data-oak-lang="menu"                        the language dropdown on the bar: oak-i18n.js
 *                                               writes its two named options in here, and the
 *                                               "menu" value is what asks for that shape
 *                                               rather than the VI/EN pair it writes elsewhere
 *
 * NOTE: this file is one of the content globs in tools/tailwind/tailwind.build.config.js, and
 * that scanner reads comments as well as code. A word here that also names a utility ends up
 * as a dead rule in the built CSS — much of the ordinary vocabulary of layout and type does.
 * Reach for a synonym, and `npm run check:css` reports one that slips past.
 */
(function () {
  'use strict';

  var shell = document.querySelector('[data-oak-header]');
  if (!shell) {
    return;
  }

  /* The server serves the home page at '/', where the last segment is empty. */
  var PAGE = location.pathname.split('/').pop() || 'kham-pha.html';

  /*
   * The bar is the first thing every keyboard reader meets, and on a phone its menu holds
   * around twenty entries, so a way past it goes in ahead of it. Off-screen until it takes
   * focus, then pinned over the bar (which is itself fixed at z-50).
   *
   * No customer page carries an id on its <main>, and stamping one here costs a line where
   * a codemod over thirty files would not. It waits for DOMContentLoaded because this file
   * is a plain tag halfway down the body — <main> is written after it and does not exist
   * yet. tabIndex = -1 is what makes the jump actually move focus: without it the browser
   * scrolls to the target and leaves the caret behind in the link, so the next Tab goes
   * back into the bar.
   *
   * data-oak-skip is what oak-utils.css takes it out of the tab order by while a dialog
   * is open: it sits outside the three landmarks a dialog makes inert, and it points at
   * one of them, so left alone it would be a link that moves focus nowhere.
   */
  var SKIP =
    'sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[60] ' +
    'focus:px-5 focus:py-3 focus:rounded-full focus:bg-surface focus:text-primary ' +
    'focus:border focus:border-primary focus:shadow-lg font-body-md text-body-md';

  shell.insertAdjacentHTML(
    'beforebegin',
    '<a class="' + SKIP + '" data-oak-skip href="#main">Bỏ qua đến nội dung</a>',
  );

  /*
   * What a phone needs before it will offer "Thêm vào màn hình chính": the manifest, the
   * colour its own chrome takes around the page, and the icon iOS uses (it reads no
   * manifest). Written from here rather than into the <head> of every page for the same
   * reason the bar itself is — one copy that cannot drift — and the addresses are relative
   * like every other asset a page asks for, so they resolve under any path the site is
   * served from. Guarded: this file is also run head-less by its own test.
   */
  if (document.head) {
    [
      ['link', { rel: 'manifest', href: 'manifest.webmanifest' }],
      ['link', { rel: 'apple-touch-icon', href: 'assets/images/icon-192.png' }],
      /* The same paint the bar itself is: assets/css/oak-utils.css .glass-nav. */
      ['meta', { name: 'theme-color', content: '#fff8f4' }],
    ].forEach(function (spec) {
      var tag = document.createElement(spec[0]);
      Object.keys(spec[1]).forEach(function (name) {
        tag.setAttribute(name, spec[1][name]);
      });
      document.head.appendChild(tag);
    });
  }

  /* The two empty regions OAK.toast() announces from. They go in here, at parse time,
     because a live region has to be in the document before the text it is meant to read
     arrives in it — see the comment on liveRegions() in oak-api.js. Guarded because a
     cached page can meet an older oak-api.js, and a missing announcement is not a reason
     to leave the page without a top bar. */
  if (typeof OAK !== 'undefined' && OAK.liveRegions) {
    OAK.liveRegions();
  }

  document.addEventListener('DOMContentLoaded', function () {
    var content = document.querySelector('main');
    if (content && !content.id) {
      content.id = 'main';
      content.tabIndex = -1;
    }
  });

  /** Is this where the reader already is? An article counts as its own feed. */
  function isHere(href) {
    return href === PAGE || (href === 'blog.html' && PAGE === 'blog-chi-tiet.html');
  }

  var TOP_BASE =
    'hidden md:inline-flex items-center h-11 px-2 font-body-md text-body-md ' +
    'transition-colors active:scale-95 duration-200 ';
  var TOP = TOP_BASE + 'text-on-surface-variant hover:text-primary';
  var TOP_HERE = TOP_BASE + 'text-primary font-bold border-b-2 border-primary';

  /* Every entry is its own tap target of at least 44px, and none of them is dimmed:
     on-surface-variant at full strength is what clears AA on this surface. */
  var ITEM_BASE =
    'flex items-center min-h-[44px] px-5 py-2 font-body-md text-body-md ' +
    'hover:text-primary hover:bg-surface-container-low transition-colors ';
  var ITEM = ITEM_BASE + 'text-on-surface-variant';
  /* Both for the entry that leads the menu and for whichever one the reader is on. */
  var ITEM_STRONG = ITEM_BASE + 'font-bold text-primary';

  var CATEGORY_BASE =
    'flex items-center min-h-[44px] px-5 py-2 font-label-md text-label-md uppercase ' +
    'tracking-wider hover:text-primary hover:bg-surface-container-low transition-colors ';
  var CATEGORY = CATEGORY_BASE + 'text-on-surface-variant';
  var CATEGORY_HERE = CATEGORY_BASE + 'font-bold text-primary';

  var RULE = '<div class="border-t border-outline-variant/30 my-1"></div>';

  /** An entry of the menu: following it shuts the menu behind you. */
  function entry(href, label, rest, here, extra) {
    var mine = isHere(href);
    return '<a @click="menuOpen = false" class="' + (mine ? here || ITEM_STRONG : rest || ITEM) +
      '" href="' + href + '"' + (mine ? ' aria-current="page"' : '') + (extra || '') + '>' +
      label + '</a>';
  }

  /** An entry of the bar itself, which sits outside the menu and so has nothing to shut. */
  function topEntry(href, label) {
    var mine = isHere(href);
    return '<a class="' + (mine ? TOP_HERE : TOP) + '" href="' + href + '"' +
      (mine ? ' aria-current="page"' : '') + '>' + label + '</a>';
  }

  var everyone =
    entry('dat-lich.html', 'Đặt lịch') +
    entry('uu-dai.html', 'Ưu đãi') +
    /* One name for the assistant, here and on the hero, the title and the H1 of its own
       page: it is a rule-based helper for finding a salon, and three names for it (two of
       them promising "AI") is what makes a reader expect something it is not. */
    entry('tim-kiem-thong-minh.html', 'Trợ lý tìm salon') +
    entry('blog.html', 'Blog');

  var categories =
    '<p class="px-5 pt-3 pb-1 font-caption text-caption uppercase tracking-widest ' +
      'text-on-surface-variant">Dịch vụ</p>' +
    entry('dich-vu-nail.html', 'NAIL', CATEGORY, CATEGORY_HERE) +
    entry('dich-vu-toc-chuyen-sau.html', 'HAIR', CATEGORY, CATEGORY_HERE) +
    entry('cham-soc-da.html', 'SKINCARE', CATEGORY, CATEGORY_HERE) +
    entry('spa-massage.html', 'SPA &amp; MASSAGE', CATEGORY, CATEGORY_HERE) +
    entry('dich-vu-mi.html', 'EYELASH', CATEGORY, CATEGORY_HERE);

  /* All three readings ship in the markup; oak-api.js keeps the one that matches the reader
     and puts the others away once /api/auth/me answers. */
  var guest =
    '<div data-oak-auth="guest">' +
      entry('dang-nhap-nguoi-dung.html', 'Đăng nhập', ITEM_STRONG) +
      entry('dang-ky.html', 'Đăng ký') +
    '</div>';

  /* Same order as the rail and the mobile strip those six pages carry: two orders for one
     set of pages is what makes a reader hunt for the entry they used yesterday. */
  var mine =
    '<div class="hidden" data-oak-auth="user">' +
      entry('lich-hen-cua-toi.html', 'Lịch hẹn của tôi') +
      entry('yeu-thich.html', 'Yêu thích') +
      entry('danh-gia-cua-toi.html', 'Đánh giá của tôi') +
      /* The mark oak-api.js adds belongs at the end of this row, not over its first word. */
      entry('thong-bao.html', 'Thông báo', null, null,
        ' aria-label="Thông báo" data-oak-dot="absolute right-4 top-1/2 -translate-y-1/2"') +
      entry('ho-so-ca-nhan.html', 'Hồ sơ cá nhân') +
      entry('cai-dat.html', 'Cài đặt') +
    '</div>';

  /* The third reading of the same menu. A technician signed in on a public page was being
     offered the customer's six pages, none of which is hers, and no way to the four that
     are; the caption leads them because nothing else on the bar says which kind of account
     is signed in. The first three in the order her own rail carries them, for the same
     reason `mine` follows the customer's. Cài đặt is on no rail — it is reached from a menu
     and nowhere else — so it comes last, which is where `mine` ends on it too. */
  var staff =
    '<div class="hidden" data-oak-auth="staff">' +
      '<p class="px-5 pt-3 pb-1 font-caption text-caption uppercase tracking-widest ' +
        'text-on-surface-variant">Kỹ thuật viên</p>' +
      entry('lich-cua-toi.html', 'Lịch của tôi') +
      entry('ho-so-nhan-vien.html', 'Hồ sơ của tôi') +
      /* The mark oak-api.js adds belongs at the end of this row, not over its first word. */
      entry('thong-bao.html', 'Thông báo', null, null,
        ' aria-label="Thông báo" data-oak-dot="absolute right-4 top-1/2 -translate-y-1/2"') +
      entry('cai-dat.html', 'Cài đặt') +
    '</div>';

  /* Signing out is not a place, so it never counts as where the reader is. */
  var signOut =
    '<div class="hidden" data-oak-auth="user">' + RULE +
      '<a @click.prevent="OAK.logout()" class="' + ITEM + '" data-oak-logout ' +
        'href="kham-pha.html">Đăng xuất</a>' +
    '</div>';

  /* The same door she came in by. OAK.logout() reads the destination off the link that was
     pressed, in a capture-phase listener, so this address is the whole of the difference. */
  var staffSignOut =
    '<div class="hidden" data-oak-auth="staff">' + RULE +
      '<a @click.prevent="OAK.logout()" class="' + ITEM + '" data-oak-logout ' +
        'href="dang-nhap-nhan-vien.html">Đăng xuất</a>' +
    '</div>';

  var panel =
    '<div class="absolute right-0 top-full mt-2 z-50 ' +
      'w-[min(20rem,calc(100vw-2rem))] max-h-[calc(100dvh-6rem)] overflow-y-auto overscroll-contain ' +
      'bg-surface rounded-2xl border border-outline-variant/30 shadow-lg py-2" id="oak-menu" ' +
      'x-cloak="" x-show="menuOpen" ' +
      'x-transition:enter="transition ease-out duration-200" ' +
      'x-transition:enter-start="opacity-0 -translate-y-2" ' +
      'x-transition:enter-end="opacity-100 translate-y-0" ' +
      'x-transition:leave="transition ease-in duration-150" ' +
      'x-transition:leave-start="opacity-100 translate-y-0" ' +
      'x-transition:leave-end="opacity-0 -translate-y-2">' +
      /* The salon entry repeats in here for the widths that cannot show it up there. */
      '<div class="md:hidden">' +
        entry('dang-nhap-doi-tac.html', 'Dành cho salon') +
        RULE +
      '</div>' +
      guest + mine + staff + RULE + everyone + RULE + categories + signOut + staffSignOut +
    '</div>';

  var pill =
    '<button :aria-expanded="menuOpen" @click.stop="menuOpen = !menuOpen; langOpen = false" ' +
      'aria-controls="oak-menu" aria-expanded="false" aria-haspopup="true" aria-label="Menu" ' +
      'class="relative flex items-center gap-2 h-11 pl-3 pr-2 rounded-full bg-surface ' +
      'border border-outline-variant/60 text-on-surface-variant hover:text-primary ' +
      'hover:shadow-md transition-all active:scale-95 duration-200" type="button" ' +
      'x-ref="pill">' +
      '<span aria-hidden="true" class="material-symbols-outlined text-[20px]" ' +
        'data-icon="menu">menu</span>' +
      '<span class="flex items-center justify-center w-8 h-8 rounded-full bg-surface-variant ' +
        'overflow-hidden shrink-0">' +
        '<span aria-hidden="true" class="material-symbols-outlined text-[20px] ' +
          'text-on-surface-variant" data-oak-avatar-icon>person</span>' +
        '<img alt="Ảnh đại diện người dùng" class="w-full h-full object-cover hidden" ' +
          'data-oak-avatar-img>' +
      '</span>' +
      /* Sits on the pill itself, so news of an unread note survives the menu being shut. It
         says nothing when read aloud, which is why oak-api.js renames the button as well. */
      '<span aria-hidden="true" class="hidden absolute top-1 right-1 w-2.5 h-2.5 rounded-full ' +
        'bg-error ring-2 ring-surface" data-oak-unread></span>' +
    '</button>';

  /*
   * The language, on the bar itself at every width rather than at the foot of the menu: a
   * reader who wants the other one is most often on a phone, where the menu is where it
   * would be hardest to find. The button says which language is in force; the two named
   * options are written into the panel by oak-i18n.js, which owns the switch.
   */
  function langCode() {
    /* The same question oak-i18n.js asks of storage, behind the same guard: a sandboxed
       frame throws here rather than answering, and the bar is not worth taking down. */
    try {
      return localStorage.getItem('oak_lang') === 'en' ? 'EN' : 'VI';
    } catch (error) {
      return 'VI';
    }
  }

  var LANG_TRIGGER =
    'flex items-center gap-1 h-11 px-2 font-body-md text-body-md text-on-surface-variant ' +
    'hover:text-primary transition-colors active:scale-95 duration-200';

  /* A control carrying an aria-label is announced by that label alone and never by what it
     holds — the same rule oak-api.js keeps for the unread mark, at initNotificationBell. A
     bare "Ngôn ngữ" would therefore hide the "VI" beside it, and a reader who cannot see
     the two letters would have to open the panel to learn which language is in force. Whole
     attribute per entry, leading space and all, so that tools/i18n reads each name as the
     dictionary key it is rather than as the half of one that concatenation would leave. */
  var LANG_LABEL = {
    VI: ' aria-label="Ngôn ngữ: Tiếng Việt"',
    EN: ' aria-label="Ngôn ngữ: English"',
  };
  var langNow = langCode();

  var langPill =
    '<button :aria-expanded="langOpen" @click.stop="langOpen = !langOpen; menuOpen = false" ' +
      'aria-controls="oak-lang-menu" aria-expanded="false" aria-haspopup="true"' +
      LANG_LABEL[langNow] + ' class="' + LANG_TRIGGER + '" ' +
      'type="button" x-ref="langPill">' +
      '<span aria-hidden="true" class="material-symbols-outlined text-[20px]" ' +
        'data-icon="language">language</span>' +
      langNow +
    '</button>';

  /* A press anywhere in the panel shuts it: the option already in force has no listener of
     its own, and picking the other one reloads — either way the panel's work is done. */
  var langPanel =
    '<div @click="langOpen = false" class="absolute right-0 top-full mt-2 z-50 min-w-[200px] ' +
      'bg-surface rounded-2xl border border-outline-variant/30 shadow-lg py-2" ' +
      'id="oak-lang-menu" data-oak-lang="menu" x-cloak="" x-show="langOpen" ' +
      'x-transition:enter="transition ease-out duration-200" ' +
      'x-transition:enter-start="opacity-0 -translate-y-2" ' +
      'x-transition:enter-end="opacity-100 translate-y-0" ' +
      'x-transition:leave="transition ease-in duration-150" ' +
      'x-transition:leave-start="opacity-100 translate-y-0" ' +
      'x-transition:leave-end="opacity-0 -translate-y-2"></div>';

  shell.innerHTML =
    '<div class="flex justify-between items-center gap-4 h-20 px-margin-mobile ' +
      'md:px-margin-desktop max-w-container-max mx-auto">' +
      '<a class="font-headline-md text-headline-md font-bold text-primary ' +
        'hover:opacity-80 transition-opacity shrink-0" href="kham-pha.html">OAK Beauty</a>' +
      /* One x-data over both dropdowns of the bar, because each has to shut the other by
         name. A trigger stops the click that opens it, or the same click would carry on to
         the document and shut what it just opened; but a stopped click never reaches the
         other dropdown's @click.outside either, so without the two lines below both panels
         stand open at once and the menu, later here and at the same z-50, is drawn over the
         languages — a reader aiming at "English" lands on a link behind it instead. */
      '<nav aria-label="Điều hướng chính" class="flex items-center gap-2 md:gap-6" ' +
        'x-data="{ langOpen: false, menuOpen: false }">' +
        topEntry('dang-nhap-doi-tac.html', 'Dành cho salon') +
        /* Its own Escape, guarded on its own flag the way the menu's is. */
        '<div @click.outside="langOpen = false" ' +
          '@keydown.escape.window.capture="if (langOpen) ' +
          '{ langOpen = false; $refs.langPill.focus() }" ' +
          'class="relative">' + langPill + langPanel + '</div>' +
        /* Escape is read on the way down, before the area list gets the same press on the way
           back up: while that list is open the press belongs to it alone, and the menu around
           it stays. The list is the one thing inside the menu that reports being open. */
        '<div @click.outside="menuOpen = false" ' +
          '@keydown.escape.window.capture="if (menuOpen && ' +
          '!$el.querySelector(\'#oak-menu button[aria-expanded=true]\')) ' +
          '{ menuOpen = false; $refs.pill.focus() }" ' +
          'class="relative">' + pill + panel + '</div>' +
      '</nav>' +
    '</div>';

  /*
   * The next appointment, said in the bar itself when it is today's or tomorrow's.
   *
   * The bell already carries a mark for the reminder the server writes a day ahead, but a
   * mark says only "something happened" — the hour and the salon are what a reader is
   * actually checking for, and every page is where they check. Guests and partners see
   * nothing: nothing is requested for them at all.
   *
   * The bar is fixed, so the row is added to it and the same height is given back to the
   * page as padding on <body> — every page already leaves room for a bar of one height, and
   * this moves all of it down together. On the six account pages the rail beside the reading
   * column has to move with it, which padding on <main> alone would not do.
   */
  var NOTICE =
    'flex items-center justify-center gap-2 px-margin-mobile md:px-margin-desktop py-2 ' +
    'bg-tertiary-container text-on-tertiary-container font-caption text-caption ' +
    'border-t border-outline-variant/30 hover:underline transition-colors';

  /** Local parts, never toISOString(): that one reads the day in UTC. */
  function isoDay(daysAhead) {
    var day = new Date();
    day.setDate(day.getDate() + daysAhead);
    return day.getFullYear() + '-' +
      String(day.getMonth() + 1).padStart(2, '0') + '-' +
      String(day.getDate()).padStart(2, '0');
  }

  /** 'hôm nay' / 'ngày mai', or null for a date that is neither and needs no bar. */
  function dayWord(date) {
    if (date === isoDay(0)) {
      return 'hôm nay';
    }
    return date === isoDay(1) ? 'ngày mai' : null;
  }

  /* One word per element, so oak-i18n.js can look each of them up: a whole sentence with
     an hour and a salon name in the middle of it is in no dictionary. */
  function say(tag, text) {
    var node = document.createElement(tag);
    node.textContent = text;
    return node;
  }

  /*
   * One request for the two places that name the next appointment: this bar, and the "Lịch
   * kế tiếp" band under the hero on kham-pha.html. GET /api/bookings/mine also closes out
   * the appointments whose day is over (bookings.js closePastBookings), so a second copy of
   * the request on one page is not merely wasteful — the two sweeps would race each other.
   * Memoized the way oak-api.js memoizes OAK.me(), and hung off OAK for the same reason:
   * the band is Alpine, which starts after this file has already run.
   */
  function nextBooking() {
    if (!OAK.nextBookingPromise) {
      OAK.nextBookingPromise = OAK.me().then(function (user) {
        if (!user || user.role !== 'customer') {
          return null;
        }
        return OAK.api('/api/bookings/mine?status=upcoming&limit=1').then(function (list) {
          return (list && list[0]) || null;
        });
      });
    }
    return OAK.nextBookingPromise;
  }

  if (typeof OAK !== 'undefined' && OAK.me) {
    OAK.nextBooking = nextBooking;
  }

  /*
   * The row arrives a request or two after the page has painted, so the page does move down
   * under the reader once. Accepted rather than reserved for: the row exists only for a
   * reader who has an appointment today or tomorrow, and an empty strip held open on every
   * page for everybody else costs more than the one jump does. What is not accepted is a
   * padding frozen at the width it was measured at — a rotation that wraps the row onto a
   * second line would leave the page under the bar — so it is measured again on resize.
   */
  function padPage(notice) {
    var page = document.body;
    if (!page) {
      return;
    }
    var base = parseFloat(getComputedStyle(page).paddingTop) || 0;
    var apply = function () {
      page.style.paddingTop = base + notice.offsetHeight + 'px';
    };
    apply();
    window.addEventListener('resize', apply);
  }

  function showNextBooking(booking) {
    var when = dayWord(booking.date);
    var notice = document.createElement('a');
    notice.className = NOTICE;
    notice.href = 'lich-hen-cua-toi.html';
    notice.innerHTML =
      '<span aria-hidden="true" class="material-symbols-outlined text-[16px] shrink-0" ' +
        'data-icon="event">event</span>';
    [
      say('span', 'Bạn có lịch'),
      say('strong', booking.time),
      say('span', when),
      say('span', 'tại'),
      say('strong', booking.salon.name),
    ].forEach(function (part) {
      notice.appendChild(part);
    });
    shell.appendChild(notice);
    padPage(notice);
  }

  document.addEventListener('DOMContentLoaded', function () {
    /* A cached page can meet an oak-api.js older than this file, and the header must still
       be a header when it does. */
    if (typeof OAK === 'undefined' || !OAK.me) {
      return;
    }
    nextBooking()
      .then(function (next) {
        if (next && dayWord(next.date)) {
          showNextBooking(next);
        }
      })
      .catch(function () {
        /* nothing to say about an appointment we could not read */
      });
  });

  /*
   * The six account pages carry a strip of tabs that is wider than a phone, and the page a
   * reader is on can be the fifth or sixth of them — off screen on arrival, so the strip
   * says nothing about where they are. Only when it really does overflow: on a strip that
   * fits, this would scroll a row that has nowhere to go. block:'nearest' keeps the page
   * itself still — only the strip moves.
   */
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-oak-account-tabs]').forEach(function (tabs) {
      var current = tabs.querySelector('[aria-current="page"]');
      if (current && tabs.scrollWidth > tabs.clientWidth) {
        current.scrollIntoView({ inline: 'center', block: 'nearest' });
      }
    });
  });
})();
