/*
 * OAK Beauty — runtime Vietnamese → English for the whole static site.
 *
 * Loaded WITHOUT `defer` on every wired page, immediately after oak-api.js and after its own
 * dictionary (assets/js/oak-i18n-en.js, generated — see tools/i18n/README.md). It must not be
 * deferred: `<html lang>` is settled while the document is still parsing, so the page is never
 * announced in the wrong language. The body itself is translated at DOMContentLoaded, so a
 * reader on a slow connection can still catch a moment of Vietnamese before the pass lands.
 *
 * The markup stays Vietnamese. English is produced in the browser by looking every static
 * string up in an exact-match dictionary keyed on the string with its whitespace collapsed,
 * so a page only has to include this file: no per-page wiring. A key may be prefixed with a
 * page — "xac-nhan-dat-lich.html::Lịch hẹn" — for the words whose English depends on where
 * they are read; the scoped entry is tried first, the bare one second. The language toggle it
 * injects is selector-based and null-checked in the same spirit as oak-api.js's header init,
 * because the partner console carries a different header and sitemap.html carries none at all.
 *
 * NOTE: this file is one of the content globs in tools/tailwind/tailwind.build.config.js, and
 * that scanner reads the comments as well as the code. Any word here that also names a
 * utility emits a dead rule into the built CSS — much of the ordinary vocabulary of layout
 * and typography does. Reach for a synonym, and `npm run check:css` will tell you if one slips
 * through. (This warning names no examples for exactly that reason.)
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'oak_lang';
  var DICTIONARY = window.OAK_I18N_EN || {};
  var PAGE = location.pathname.split('/').pop() || 'index.html';

  /* A sandboxed iframe throws on both of these rather than returning null, and a language
     toggle is not worth taking the page down for: it just stops remembering the choice. */
  function stored() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      return null;
    }
  }

  function store(value) {
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch (error) {
      /* nothing to do — the choice lasts until the reload below and no longer */
    }
  }

  var lang = stored() === 'en' ? 'en' : 'vi';

  /* The weekday names in play: the ones OAK.fmtDate() puts in front of a date, and the ones
     cai-dat-salon.html numbers in its own table. Both spellings are dictionary keys on their
     own; here they arrive inside a longer string. */
  var WEEKDAYS = {
    'Chủ Nhật': 'Sunday', 'Thứ Hai': 'Monday', 'Thứ Ba': 'Tuesday', 'Thứ Tư': 'Wednesday',
    'Thứ Năm': 'Thursday', 'Thứ Sáu': 'Friday', 'Thứ Bảy': 'Saturday',
    'Thứ 2': 'Monday', 'Thứ 3': 'Tuesday', 'Thứ 4': 'Wednesday', 'Thứ 5': 'Thursday',
    'Thứ 6': 'Friday', 'Thứ 7': 'Saturday',
  };

  /* "Thứ Hai, 10/08/2026" — the one shape OAK.fmtDate() returns, and the thing several of the
     composed strings below are built around. Spelled once, spliced into each of them. */
  var DATE = '(Chủ Nhật|Thứ Hai|Thứ Ba|Thứ Tư|Thứ Năm|Thứ Sáu|Thứ Bảy), (\\d{2}/\\d{2}/\\d{4})';

  function around(before, after) {
    return new RegExp('^' + before + DATE + (after || '') + '$');
  }

  /** The replacement for a rule built by `around()`: the weekday, then the date untouched. */
  function dated(prefix) {
    return function (all, weekday, date) {
      return prefix + WEEKDAYS[weekday] + ', ' + date;
    };
  }

  var MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  /**
   * Tried only after an exact match fails, so a string a page assembled around runtime data —
   * a date, a count, a price, a booking code — still lands in English. Every rule is tried, in
   * order, on the result of the one before it, which is what lets a piece-by-piece rule hand
   * its work on ("Nối mi • 60 phút" is one rule for the pieces and one for the duration).
   *
   * Every rule matches a WHOLE node, `^` to `$`, and nothing less. `ruled()` runs on every
   * node the dictionary missed, and most of those are server data — a promotion title, a
   * review, a staff bio. A rule anchored on a fragment ("5 năm kinh nghiệm", "Giảm 20%") finds
   * that fragment inside a Vietnamese sentence and leaves half of it in English; anchored on
   * the whole node it can only fire on the composed shape it was written for. The cost of the
   * anchoring is that a shape nobody catalogued stays Vietnamese, which is the safe failure.
   *
   * The other standing rule: an English output must match no rule, this one included, so the
   * characterData observer can run the list over the engine's own edit without the text
   * drifting. `node tools/i18n/check-rules.js` asserts both properties, and sweeps the rules
   * over server/src/seed.js to prove none of them touches the salon's own data.
   */
  var RULES = [
    /* -- dates ------------------------------------------------------------------------- */
    [around(''), dated('')],
    [around('Thành viên từ '), dated('Member since ')],
    [around('Lịch trống '), dated('Available on ')],
    // "12 Tháng 8, 2026" — dateLabel() on lich-hen-cua-toi and xac-nhan-dat-lich.
    [/^(\d+) Tháng (\d+), (\d+)$/, function (all, day, month, year) {
      return MONTHS[Number(month) - 1] + ' ' + day + ', ' + year;
    }],
    // "Tuần 10/08/2026 – 16/08/2026" — the week heading of the partner calendar.
    [/^Tuần (\d{2}\/\d{2}\/\d{4}) – (\d{2}\/\d{2}\/\d{4})$/, 'Week of $1 – $2'],
    [/^Ngày mở cửa cần giờ mở sớm hơn giờ đóng: (Chủ Nhật|Thứ [2-7])\.$/,
      function (all, weekday) {
        return 'An open day needs an opening time earlier than its closing time: ' +
          WEEKDAYS[weekday] + '.';
      }],

    /* -- durations and the service meta lines they sit in ------------------------------- */
    [/^(\d+) phút$/, '$1 min'],
    [/^(\d+) phút trải nghiệm$/, '$1-minute experience'],
    [/^Dịch vụ • (\d+) phút$/, 'Service • $1 min'],
    [/^(.+) • (\d+) phút$/, function (all, label, minutes) {
      return labelled(label) + ' • ' + minutes + ' min';
    }],
    [/^(\d+) phút • (.+)$/, function (all, minutes, label) {
      return minutes + ' min • ' + labelled(label);
    }],

    /* -- relative time, thong-bao.html -------------------------------------------------- */
    [/^(\d+) phút trước$/, '$1 min ago'],
    [/^(\d+) giờ trước$/, '$1 hr ago'],
    [/^(\d+) ngày trước$/, function (all, days) {
      return plural(days, 'day ago', 'days ago');
    }],

    /* -- counts ------------------------------------------------------------------------ */
    [/^(\d+) ngày$/, function (all, days) {
      return plural(days, 'day', 'days');
    }],
    [/^Khoảng thời gian tối đa là (\d+) ngày\.$/, function (all, days) {
      return 'The maximum range is ' + plural(days, 'day', 'days') + '.';
    }],
    [/^(\d+) năm kinh nghiệm$/, function (all, years) {
      return plural(years, 'year of experience', 'years of experience');
    }],
    [/^\((\d+) đánh giá\)$/, function (all, count) {
      return '(' + plural(count, 'review', 'reviews') + ')';
    }],
    [/^Dựa trên (\d+) đánh giá$/, function (all, count) {
      return 'Based on ' + plural(count, 'review', 'reviews');
    }],
    [/^Xem tất cả (\d+) đánh giá$/, function (all, count) {
      return 'See all ' + plural(count, 'review', 'reviews');
    }],
    [/^\/ 5 · (\d+) đánh giá$/, function (all, count) {
      return '/ 5 · ' + plural(count, 'review', 'reviews');
    }],
    [/^Xem tất cả \((\d+)\) trong Quản lý lịch hẹn$/, 'See all $1 in Appointment management'],
    [/^(\d+) sao$/, function (all, stars) {
      return plural(stars, 'star', 'stars');
    }],
    [/^\+(\d+) Ảnh$/, function (all, count) {
      return '+' + plural(count, 'photo', 'photos');
    }],
    [/^(\d+) lịch sắp tới$/, function (all, count) {
      return plural(count, 'upcoming appointment', 'upcoming appointments');
    }],
    [/^(\d+) ưu đãi đang áp dụng$/, function (all, count) {
      return plural(count, 'offer running', 'offers running');
    }],
    [/^Bạn có (\d+) thông báo chưa đọc\.$/, function (all, count) {
      return 'You have ' + plural(count, 'unread notification', 'unread notifications') + '.';
    }],
    [/^Tìm thấy (\d+) salon phù hợp với yêu cầu của bạn$/, function (all, count) {
      return 'Found ' + plural(count, 'salon', 'salons') + ' matching your request';
    }],
    [/^Bình luận \((\d+)\)$/, 'Comments ($1)'],
    // The filter chips of the partner console: "Tất cả (12)", "Nối mi (3)".
    [/^(.+) \((\d+)\)$/, function (all, label, count) {
      return labelled(label) + ' (' + count + ')';
    }],
    [/^([\d.]+)% doanh thu$/, '$1% of revenue'],

    /* -- prices, always "350.000đ" out of OAK.fmtPrice() -------------------------------- */
    [/^Từ ([\d.]+đ)$/, 'From $1'],
    [/^Giảm ([\d.]+[%đ])$/, 'Save $1'],

    /* -- the two lines assembled piece by piece. Each piece is a label the dictionary knows
          on its own, a date, or a price behind its own small prefix; a piece that is none of
          those is data and is copied across untouched. ---------------------------------- */
    [/^Tiêu chí: (.+)$/, function (all, body) {
      return 'Criteria: ' + pieced(body);
    }],
    [/^([^•]+) • ([\d.]+km)$/, function (all, district, distance) {
      return labelled(district) + ' • ' + distance;
    }],
    [/^([^•]+) • (từ [\d.]+đ)$/, function (all, district, price) {
      return labelled(district) + ' • ' + pieced(price);
    }],
    [/^([^•]+) • ([\d.]+km) • (từ [\d.]+đ)$/, function (all, district, distance, price) {
      return labelled(district) + ' • ' + distance + ' • ' + pieced(price);
    }],

    /* -- offers ------------------------------------------------------------------------ */
    [/^Hạn dùng đến (\d{2}\/\d{2}\/\d{4})$/, 'Valid until $1'],
    // promotionMeta(): none, one or two "Giảm …" pieces, always closing on "Đến <date>".
    [/^(?:(.+) • )?Đến (\d{2}\/\d{2}\/\d{4})$/, function (all, head, date) {
      var until = 'Until ' + date;
      return head === undefined ? until : pieced(head) + ' • ' + until;
    }],
    [/^Đã sao chép mã (.+)$/, 'Copied code $1'],
    [/^Không sao chép được mã, vui lòng chép thủ công: (.+)$/,
      'The code could not be copied, please copy it by hand: $1'],
    [/^Xoá ưu đãi "(.+)"\?$/, 'Delete offer "$1"?'],
    [/^Xoá dịch vụ "(.+)"\?$/, 'Delete service "$1"?'],

    /* -- appointments ------------------------------------------------------------------ */
    [/^Mã đặt chỗ: (.+)$/, 'Booking code: $1'],
    [/^Số điện thoại salon: (.+)$/, 'Salon phone number: $1'],
    [/^Bạn chắc chắn muốn hủy lịch hẹn (.+)\? Thao tác này không thể hoàn tác\.$/,
      'Are you sure you want to cancel appointment $1? This cannot be undone.'],
    [/^Đã hủy lịch hẹn (.+)\.$/, 'Appointment $1 cancelled.'],
    [/^Đã cập nhật lịch hẹn (.+)\.$/, 'Appointment $1 updated.'],
    [/^Đã tạo lịch hẹn (.+)\.$/, 'Appointment $1 created.'],

    /* -- partner console --------------------------------------------------------------- */
    [/^Tới (\d{1,2}:\d{2})$/, 'Until $1'],
    [/^Kế tiếp (\d{1,2}:\d{2})$/, 'Next $1'],
    [/^(.+) \(đã nghỉ\)$/, '$1 (inactive)'],
    [/^Toạ độ: (.+)$/, 'Coordinates: $1'],

    /* -- salon profile and packages ----------------------------------------------------- */
    [/^Chuyên gia: (.+)$/, 'Specialist: $1'],
    [/^Xem ảnh: (.+)$/, 'View photo: $1'],
    [/^Bản đồ vị trí (.+)$/, 'Map of $1'],
    [/^Những đôi tay tài hoa tại (.+)$/, 'The talented hands at $1'],
    // "Tại <salon>, <district>" — both halves are the salon's own data, so the shape alone
    // cannot tell this apart from a sentence that opens "Tại …, …". It fires only when the
    // tail is a place the dictionary knows, which a sentence's second clause is not.
    [/^Tại ([^,]+), (.+)$/, function (all, salon, district) {
      return entry(district, ruledBare) === undefined ? all : 'At ' + salon + ', ' + labelled(district);
    }],
    [/^(\d{1,2}:\d{2}) \(Kín\)$/, '$1 (Full)'],

    [/^Không tải được salon nổi bật\. (.+)$/, 'Could not load the featured salons. $1'],
  ];

  // NOSCRIPT is markup, not text, until scripting is off — and if it were off none of this
  // would run anyway. The icon spans hold Material Symbols ligature names ("expand_more"),
  // which are addresses into the font rather than words.
  var SKIP_TAGS = { SCRIPT: true, STYLE: true, NOSCRIPT: true };
  var ICON_CLASS = 'material-symbols-outlined';

  var ATTRIBUTES = ['placeholder', 'title', 'alt'];
  var VALUE_TYPES = { submit: true, button: true };

  // aria-label is translated one beat after everything else: oak-api.js finds the notification
  // bell, the region button and the account link by their Vietnamese aria-label, and it does
  // so only once /api/auth/me has answered. Renaming the labels before that pass would make
  // those querySelector calls miss, and the unread dot and the saved-district label would
  // quietly stop appearing on the English site.
  var ariaReady = false;

  function has(key) {
    return Object.prototype.hasOwnProperty.call(DICTIONARY, key);
  }

  /**
   * The dictionary's English for `key`, or undefined when it has none. A page-scoped entry —
   * "xac-nhan-dat-lich.html::Lịch hẹn" — wins over the bare key, which is how one Vietnamese
   * word can read as "Appointments" in the header and "Appointment" in a banner without the
   * flat dictionary having to choose. `bare` skips the scoped entry: see `shared()`.
   */
  function entry(key, bare) {
    if (bare !== true && has(PAGE + '::' + key)) {
      return DICTIONARY[PAGE + '::' + key];
    }
    return has(key) ? DICTIONARY[key] : undefined;
  }

  /**
   * True when a node sits in chrome every page shares, where a page-scoped entry must not
   * reach it: the header CTA is the same button on all 37 pages and cannot be relabelled by
   * something one page needed for its own copy. A scoped entry is a statement about a page's
   * content, and only its content.
   *
   * The selector is what the markup actually nests: both header CTAs and the mobile menu live
   * inside <header>, the customer footer is <footer>, and the partner console's chrome is a
   * <nav> directly under <body> rather than a header. The account sidebar of
   * lich-hen-cua-toi.html is an <aside> inside <main>, so it counts as content, not chrome.
   */
  var CHROME = 'header, footer, body > nav';

  /* Only a page that carries a scoped entry pays for the closest() call. */
  var pageScoped = Object.keys(DICTIONARY).some(function (key) {
    return key.indexOf(PAGE + '::') === 0;
  });

  function shared(node) {
    if (!pageScoped) {
      return false;
    }
    var element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return element !== null && element.closest(CHROME) !== null;
  }

  /*
   * Set for the duration of ruled() and read by the piece lookups below. The rules reach those
   * lookups through String.replace, which decides the arguments they are called with, so the
   * flag travels here instead. Everything in between is synchronous: there is never a second
   * ruled() in flight to read the wrong value.
   */
  var ruledBare = false;

  /** The dictionary's English for one piece of a composed string, or the piece unchanged. */
  function labelled(text) {
    var english = entry(text, ruledBare);
    return english === undefined ? text : english;
  }

  /**
   * The pieces of a ' • '-joined line, each translated on its own. A piece the dictionary
   * knows becomes its English; a date, and a price behind a small prefix of its own, are the
   * two shapes built rather than written, so they are spelled out here; anything else is the
   * salon's own data and is copied across as it stands.
   */
  function pieced(body) {
    return body.split(' • ').map(function (text) {
      var date = text.match(around(''));
      if (date) {
        return WEEKDAYS[date[1]] + ', ' + date[2];
      }
      var price = text.match(/^(từ|dưới) ([\d.]+đ)$/);
      if (price) {
        return (price[1] === 'từ' ? 'from ' : 'under ') + price[2];
      }
      var discount = text.match(/^Giảm ([\d.]+[%đ])$/);
      return discount ? 'Save ' + discount[1] : labelled(text);
    }).join(' • ');
  }

  /** `count` is the digits a rule captured, so it is compared as the string it is. */
  function plural(count, one, many) {
    return count + ' ' + (count === '1' ? one : many);
  }

  /** The English the rules together make of `key`, or null when none of them applies. */
  function ruled(key, bare) {
    var english = key;
    ruledBare = bare === true;
    for (var index = 0; index < RULES.length; index += 1) {
      english = english.replace(RULES[index][0], RULES[index][1]);
    }
    ruledBare = false;
    return english === key ? null : english;
  }

  /**
   * The English for `text`, keeping its original leading and trailing whitespace so an inline
   * node keeps the spacing its neighbours were laid out with. null when nothing matched.
   * The key is the text with its whitespace collapsed — the same normalisation the parts
   * under tools/i18n/parts/ are written against.
   */
  function lookup(text, bare) {
    var key = text.replace(/\s+/g, ' ').trim();
    if (!key) {
      return null;
    }
    var english = entry(key, bare);
    if (english === undefined) {
      english = ruled(key, bare);
    }
    if (english === null || english === undefined) {
      return null;
    }
    return text.match(/^\s*/)[0] + english + text.match(/\s*$/)[0];
  }

  function translateText(node) {
    var english = lookup(node.nodeValue, shared(node));
    // Only ever write a real change: that is what keeps the observer below from re-entering
    // on its own edits, on top of English no longer matching a Vietnamese key.
    if (english !== null && english !== node.nodeValue) {
      node.nodeValue = english;
    }
  }

  function translateAttribute(element, name) {
    var value = element.getAttribute(name);
    var english = value === null ? null : lookup(value, shared(element));
    if (english !== null && english !== value) {
      element.setAttribute(name, english);
    }
  }

  function translateAttributes(element) {
    ATTRIBUTES.forEach(function (name) {
      translateAttribute(element, name);
    });
    if (ariaReady) {
      translateAttribute(element, 'aria-label');
    }
    // The label of a submit or button input is its value; anywhere else the value is data.
    if (element.tagName === 'INPUT' && VALUE_TYPES[element.type] === true) {
      translateAttribute(element, 'value');
    }
  }

  function skipped(element) {
    return SKIP_TAGS[element.tagName] === true || element.classList.contains(ICON_CLASS);
  }

  /** Translate a node and everything under it. Anything but an element or text is left alone. */
  function translate(root) {
    if (root.nodeType === Node.TEXT_NODE) {
      translateText(root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE || skipped(root)) {
      return;
    }
    translateAttributes(root);

    // FILTER_REJECT, not FILTER_SKIP: a skipped element takes its whole subtree with it.
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        return node.nodeType === Node.ELEMENT_NODE && skipped(node)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    });
    var node = walker.nextNode();
    while (node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        translateAttributes(node);
      } else {
        translateText(node);
      }
      node = walker.nextNode();
    }
  }

  function translateHead() {
    var title = lookup(document.title);
    if (title !== null) {
      document.title = title;
    }
    var description = document.querySelector('meta[name="description"]');
    if (description) {
      translateAttribute(description, 'content');
    }
  }

  /**
   * Everything Alpine renders and everything oak-api.js inserts — toasts, the server-down
   * banner, the region menu, the mobile account links — arrives after the pass above, so it
   * is translated as it lands.
   */
  function observe() {
    var observer = new MutationObserver(function (records) {
      records.forEach(function (record) {
        if (record.type === 'characterData') {
          translateText(record.target);
          return;
        }
        Array.prototype.forEach.call(record.addedNodes, function (node) {
          translate(node);
        });
      });
    });
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  }

  function translateAriaLabels() {
    ariaReady = true;
    translate(document.body);
  }

  /*
   * Two skins for one control. Inside a header it borrows the header's own type scale from
   * oak-tailwind.css; the fallback pill is styled inline because the only page without a
   * header — sitemap.html — is hand-written and does not load Tailwind at all.
   */
  var HEADER_SKIN = {
    group: 'flex items-center gap-1 font-label-md text-label-md shrink-0',
    current: 'font-bold text-primary',
    other: 'text-on-surface-variant hover:text-primary transition-colors',
    divider: 'text-on-surface-variant',
  };

  var PILL_BUTTON = 'background:none;border:0;padding:0;font:inherit;color:inherit;cursor:pointer;';
  var PILL_SKIN = {
    inline: true,
    group: 'position:fixed;left:1rem;bottom:1rem;z-index:40;display:flex;align-items:center;' +
      'gap:.4rem;padding:.4rem .9rem;border-radius:999px;background:#fff;' +
      'box-shadow:0 2px 10px rgba(0,0,0,.18);',
    current: PILL_BUTTON + 'font-weight:700;',
    other: PILL_BUTTON + 'opacity:.55;',
    divider: 'opacity:.35;',
  };

  function skin(element, style, value) {
    if (style.inline) {
      element.style.cssText = value;
    } else {
      element.className = value;
    }
  }

  /** "VI" and "EN" carry no diacritics, so the engine never translates its own toggle. */
  function langButton(code, label, style) {
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute('aria-pressed', code === lang ? 'true' : 'false');
    skin(button, style, code === lang ? style.current : style.other);
    if (code !== lang) {
      button.addEventListener('click', function () {
        set(code);
      });
    }
    return button;
  }

  function langToggle(style) {
    var group = document.createElement('div');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Ngôn ngữ');
    skin(group, style, style.group);

    var divider = document.createElement('span');
    divider.setAttribute('aria-hidden', 'true');
    divider.textContent = '|';
    skin(divider, style, style.divider);

    group.appendChild(langButton('vi', 'VI', style));
    group.appendChild(divider);
    group.appendChild(langButton('en', 'EN', style));
    return group;
  }

  /**
   * Both headers on the site — the customer top bar and the partner console's — end in a flex
   * row of controls whose last item is the account link, which is where the language pair
   * belongs and where it stays visible at every breakpoint. sitemap.html has no header and
   * gets the pill instead.
   */
  function initToggle() {
    var account = document.querySelector('header a[aria-label="Tài khoản"]');
    if (account) {
      account.parentNode.insertBefore(langToggle(HEADER_SKIN), account);
      return;
    }
    document.body.appendChild(langToggle(PILL_SKIN));
  }

  function set(next) {
    store(next === 'en' ? 'en' : 'vi');
    location.reload();
  }

  function start() {
    // Before any translation, so the Vietnamese aria-label it looks for still matches.
    initToggle();
    if (lang !== 'en') {
      return;
    }
    translateHead();
    translate(document.body);
    observe();
    // See `ariaReady`. oak-api.js attached its own handler to this promise first — its script
    // tag comes first — so its header pass has already run by the time this one does.
    if (window.OAK) {
      window.OAK.me().then(translateAriaLabels);
    } else {
      translateAriaLabels();
    }
  }

  if (lang === 'en') {
    document.documentElement.lang = 'en';
  }

  window.OAKI18N = { lang: lang, set: set };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
