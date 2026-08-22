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
 *   data-oak-auth="guest" | "user"              oak-api.js picks the pair that applies
 *   data-oak-lang                               oak-i18n.js writes its VI/EN pair in here
 * The area button is found by its Vietnamese aria-label instead — see initRegionPicker().
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

  var PAGE = location.pathname.split('/').pop() || 'index.html';

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
   */
  var SKIP =
    'sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[60] ' +
    'focus:px-5 focus:py-3 focus:rounded-full focus:bg-surface focus:text-primary ' +
    'focus:border focus:border-outline-variant focus:shadow-lg font-body-md text-body-md';

  shell.insertAdjacentHTML(
    'beforebegin',
    '<a class="' + SKIP + '" href="#main">Bỏ qua đến nội dung</a>',
  );

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

  /*
   * oak-api.js takes this over: it writes the saved district into the middle span, wraps the
   * button so a list of areas can hang under it, and fills that list on the first press. It
   * carries no Alpine of its own on purpose — oak-api.js moves it into that wrapper, and
   * closing the menu is asked of each entry that leads somewhere, which this one does not.
   */
  var area =
    '<button aria-label="Chọn khu vực" class="w-full ' + ITEM + ' gap-3" type="button">' +
      '<span aria-hidden="true" class="material-symbols-outlined text-[20px]" ' +
        'data-icon="location_on">location_on</span>' +
      '<span>Chọn khu vực</span>' +
      '<span aria-hidden="true" class="material-symbols-outlined text-[16px] ml-auto">' +
        'expand_more</span>' +
    '</button>';

  var everyone =
    entry('dat-lich.html', 'Đặt lịch') +
    /* One page finds salons — list and map are a switch inside it, not two entries here. */
    entry('ket-qua-tim-kiem.html', 'Tất cả salon') +
    entry('uu-dai.html', 'Ưu đãi') +
    entry('tim-kiem-thong-minh.html', 'Trợ lý tìm kiếm AI') +
    area;

  var categories =
    '<p class="px-5 pt-3 pb-1 font-caption text-caption uppercase tracking-widest ' +
      'text-on-surface-variant">Dịch vụ</p>' +
    entry('dich-vu-nail.html', 'NAIL', CATEGORY, CATEGORY_HERE) +
    entry('dich-vu-toc-chuyen-sau.html', 'HAIR', CATEGORY, CATEGORY_HERE) +
    entry('cham-soc-da.html', 'SKINCARE', CATEGORY, CATEGORY_HERE) +
    entry('spa-massage.html', 'SPA &amp; MASSAGE', CATEGORY, CATEGORY_HERE) +
    entry('dich-vu-mi.html', 'EYELASH', CATEGORY, CATEGORY_HERE);

  /* Both pairs ship in the markup; oak-api.js keeps the one that matches the reader and
     puts the other one away once /api/auth/me answers. */
  var guest =
    '<div data-oak-auth="guest">' +
      entry('dang-nhap-nguoi-dung.html', 'Đăng nhập', ITEM_STRONG) +
      entry('dang-ky.html', 'Đăng ký') +
    '</div>';

  var mine =
    '<div class="hidden" data-oak-auth="user">' +
      entry('ho-so-ca-nhan.html', 'Hồ sơ cá nhân') +
      entry('lich-hen-cua-toi.html', 'Lịch hẹn của tôi') +
      entry('yeu-thich.html', 'Yêu thích') +
      entry('danh-gia-cua-toi.html', 'Đánh giá của tôi') +
      /* The mark oak-api.js adds belongs at the end of this row, not over its first word. */
      entry('thong-bao.html', 'Thông báo', null, null,
        ' aria-label="Thông báo" data-oak-dot="absolute right-4 top-1/2 -translate-y-1/2"') +
    '</div>';

  /* Signing out is not a place, so it never counts as where the reader is. */
  var signOut =
    '<div class="hidden" data-oak-auth="user">' + RULE +
      '<a @click.prevent="OAK.logout()" class="' + ITEM + '" data-oak-logout ' +
        'href="kham-pha.html">Đăng xuất</a>' +
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
      /* The two bar entries repeat in here for the widths that cannot show them up there. */
      '<div class="md:hidden">' +
        entry('blog.html', 'Blog') +
        entry('dang-nhap-doi-tac.html', 'Dành cho salon') +
        RULE +
      '</div>' +
      guest + mine + RULE + everyone + RULE + categories + signOut + RULE +
      '<div class="flex items-center min-h-[44px] px-5 py-2" data-oak-lang></div>' +
    '</div>';

  var pill =
    '<button :aria-expanded="menuOpen" @click.stop="menuOpen = !menuOpen" ' +
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

  shell.innerHTML =
    '<div class="flex justify-between items-center gap-4 h-20 px-margin-mobile ' +
      'md:px-margin-desktop max-w-container-max mx-auto">' +
      '<a class="font-headline-md text-headline-md font-bold text-primary ' +
        'hover:opacity-80 transition-opacity shrink-0" href="kham-pha.html">OAK Beauty</a>' +
      '<nav aria-label="Điều hướng chính" class="flex items-center gap-2 md:gap-6">' +
        topEntry('blog.html', 'Blog') +
        topEntry('dang-nhap-doi-tac.html', 'Dành cho salon') +
        /* Escape is read on the way down, before the area list gets the same press on the way
           back up: while that list is open the press belongs to it alone, and the menu around
           it stays. The list is the one thing inside the menu that reports being open. */
        '<div @click.outside="menuOpen = false" ' +
          '@keydown.escape.window.capture="if (menuOpen && ' +
          '!$el.querySelector(\'#oak-menu button[aria-expanded=true]\')) ' +
          '{ menuOpen = false; $refs.pill.focus() }" ' +
          'class="relative" x-data="{ menuOpen: false }">' + pill + panel + '</div>' +
      '</nav>' +
    '</div>';
})();
