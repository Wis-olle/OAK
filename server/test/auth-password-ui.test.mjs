import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { sendResetMail } from '../src/lib/mailer.js';

/* The bug the pinned assertion below guards is a calendar-day rollover, so the day has to be
   pinned as well as the instant: in UTC the buggy and the correct answer are the same string. */
process.env.TZ = 'Asia/Ho_Chi_Minh';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const page = (name) => fs.readFileSync(path.join(root, 'ui', name), 'utf8');

const loginHtml = page('dang-nhap-nguoi-dung.html');
const registerHtml = page('dang-ky.html');
const resetHtml = page('dat-lai-mat-khau.html');
const profileHtml = page('ho-so-ca-nhan.html');
const settingsHtml = page('cai-dat.html');
const sitemapHtml = page('sitemap.html');
const headerSource = fs.readFileSync(path.join(root, 'ui/assets/js/oak-header.js'), 'utf8');
const authSource = fs.readFileSync(path.join(root, 'server/src/routes/auth.js'), 'utf8');
const middlewareSource = fs.readFileSync(path.join(root, 'server/src/middleware/auth.js'), 'utf8');
const schemaSource = fs.readFileSync(path.join(root, 'server/src/db.js'), 'utf8');
const mailerSource = fs.readFileSync(path.join(root, 'server/src/lib/mailer.js'), 'utf8');

/* Each factory is inline in its page, so lift it out of its <script> and drive it here.
   `from` is the first line of the slice — everything the factory leans on sits below it. */
function factory(html, from, call, extra = {}) {
  const tail = html.slice(html.indexOf(from));
  const script = tail.slice(0, tail.indexOf('</script>'));
  const query = extra.query || {};
  const context = {
    toasts: [],
    replaced: [],
    langSet: [],
    location: { href: '', pathname: '/' + (extra.pathname || 'page.html') },
    history: { replaceState: (state, title, url) => context.replaced.push(url) },
    // The login page points its register link from module scope, outside any factory.
    document: { querySelector: () => ({ href: '' }) },
    // The settings page reads the language engine off `window`, which a fresh vm has none of.
    window: { OAKI18N: { lang: 'vi', set: (code) => context.langSet.push(code) } },
    // Only dang-ky.html reads it, and only to pick up what the wizard left behind. A page
    // given none meets the same ReferenceError a browser with site data blocked throws.
    ...(extra.stash === undefined ? {} : { sessionStorage: { getItem: () => extra.stash } }),
    OAK: {
      api: extra.api,
      toast: (message, type) => context.toasts.push([message, type]),
      me: async () => null,
      requireLogin: async () => ({ id: 1, name: 'Ngọc Anh' }),
      fmtDate: (value) => String(value),
      qs: (name) => (name in query ? query[name] : null),
    },
  };
  vm.runInNewContext(`${script}\nresult = ${call};`, context);
  context.result.toasts = context.toasts;
  context.result.replaced = context.replaced;
  context.result.langSet = context.langSet;
  return context.result;
}

const resetPage = (api, token) =>
  factory(resetHtml, 'function oakResetPassword(', 'oakResetPassword()', {
    api,
    pathname: 'dat-lai-mat-khau.html',
    query: token === undefined ? {} : { token },
  });
const loginPage = (api) =>
  factory(loginHtml, 'const OAK_NEXT_PAGE =', 'oakCustomerLogin()', { api });
const registerPage = (stash) =>
  factory(registerHtml, 'var OAK_NEXT_PAGE =', 'oakRegister()', { stash });
const settingsPage = (api) =>
  factory(settingsHtml, 'function oakSettings(', 'oakSettings()', { api });

/** A login form with its email box focusable, the way Alpine would supply x-ref. */
function loginWithRefs(api) {
  const state = loginPage(api);
  state.focused = 0;
  state.$refs = { email: { focus: () => { state.focused += 1; } } };
  return state;
}

// ------------------------------------------------------------------ dat-lai-mat-khau

test('a link with no token opens straight in the dead-link state, never in the form', () => {
  const state = resetPage(async () => assert.fail('no request may be made'));

  assert.equal(state.token, '');
  assert.equal(state.done, false);
  // The three states are mutually exclusive and all three are driven by `token`.
  assert.match(resetHtml, /x-show="!token \|\| tokenDead"/);
  assert.match(resetHtml, /x-show="token &amp;&amp; !tokenDead &amp;&amp; !done"/);
  assert.match(resetHtml, /href="dang-nhap-nguoi-dung\.html">Yêu cầu liên kết mới<\/a>/);
});

test('the token is taken out of the address bar once it is in state', () => {
  const state = resetPage(async () => ({ ok: true }), 'tok-123');

  state.init();

  // Still usable from state, gone from the URL, the history entry and any later Referer.
  assert.equal(state.token, 'tok-123');
  assert.deepEqual(state.replaced, ['/dat-lai-mat-khau.html']);
});

test('with no token there is nothing to strip, and the address is left alone', () => {
  const state = resetPage(async () => ({ ok: true }));

  state.init();

  assert.deepEqual(state.replaced, []);
});

test('a too-short or mismatched password is refused before any request', async () => {
  let calls = 0;
  const state = resetPage(async () => {
    calls += 1;
    return { ok: true };
  }, 'abc123');

  state.password = 'short';
  state.confirm = 'short';
  await state.submit();
  assert.equal(calls, 0);
  assert.equal(state.errors.password, 'Mật khẩu phải có ít nhất 8 ký tự.');

  state.password = 'longenough1';
  state.confirm = 'longenough2';
  await state.submit();
  assert.equal(calls, 0);
  assert.equal(state.errors.confirm, 'Mật khẩu xác nhận không khớp.');
  assert.equal(state.errors.password, undefined);
});

test('a good reset posts the token with the password and ends on the sign-in card', async () => {
  const calls = [];
  const state = resetPage(async (path, options) => {
    calls.push([path, options.method, options.body]);
    return { ok: true };
  }, 'tok-123');

  state.password = 'longenough1';
  state.confirm = 'longenough1';
  await state.submit();

  assert.equal(calls[0][0], '/api/auth/reset-password');
  assert.equal(calls[0][1], 'POST');
  // The body is built inside the vm, so it is compared field by field, not by identity.
  assert.equal(calls[0][2].token, 'tok-123');
  assert.equal(calls[0][2].password, 'longenough1');
  assert.equal(state.done, true);
  assert.equal(state.busy, false);
  assert.match(resetHtml, /href="dang-nhap-nguoi-dung\.html">Đăng nhập ngay<\/a>/);
});

test('a spent or expired token retires the form instead of showing a field error', async () => {
  const state = resetPage(async () => {
    const error = new Error('Liên kết đặt lại không hợp lệ hoặc đã hết hạn.');
    error.code = 'INVALID_RESET_TOKEN';
    throw error;
  }, 'tok-dead');

  state.password = 'longenough1';
  state.confirm = 'longenough1';
  await state.submit();

  assert.equal(state.tokenDead, true);
  // Nothing typed into the form can fix this, so it is not raised as a form error.
  assert.equal(state.error, '');
  assert.equal(state.done, false);
});

test('any other failure stays a form error, so the reader can retry the same link', async () => {
  const state = resetPage(async () => {
    const error = new Error('Không kết nối được máy chủ, vui lòng thử lại.');
    error.code = 'NETWORK_ERROR';
    throw error;
  }, 'tok-123');

  state.password = 'longenough1';
  state.confirm = 'longenough1';
  await state.submit();

  assert.equal(state.tokenDead, false);
  assert.equal(state.error, 'Không kết nối được máy chủ, vui lòng thử lại.');
});

test('the new page carries the same head and shell contract as the other auth pages', () => {
  for (const tag of [
    '<script src="assets/js/oak-api.js"></script>',
    '<script src="assets/js/oak-i18n.js"></script>',
    '<script src="assets/js/oak-header.js"></script>',
    '<header class="glass-nav fixed top-0 w-full z-50 transition-colors" data-oak-header></header>',
    '<title>Đặt lại mật khẩu - OAK Beauty</title>',
  ]) {
    assert.ok(resetHtml.includes(tag), 'missing ' + tag);
  }
  // The lazy English dictionary loader is byte-identical to the one on the login page,
  // so a later sweep over the head format catches this page with the rest.
  const loader = /<script>\n\(function \(\) \{[\s\S]*?\}\)\(\);\n<\/script>/;
  assert.equal(resetHtml.match(loader)[0], loginHtml.match(loader)[0]);
});

// ------------------------------------------------------------------ dang-nhap-nguoi-dung

test('"Quên mật khẩu?" with an empty box answers on the field and makes no request', async () => {
  const state = loginWithRefs(async () => assert.fail('no request may be made'));

  await state.forgotPassword();

  assert.equal(state.errors.email, 'Vui lòng nhập email để nhận liên kết đặt lại.');
  assert.equal(state.focused, 1);
  assert.equal(state.forgotBusy, false);
  assert.deepEqual(state.toasts, []);
});

test('the reset reply becomes a standing panel, and the demo link rides in it', async () => {
  const state = loginWithRefs(async () => ({
    message: 'Nếu email tồn tại, chúng tôi đã gửi liên kết đặt lại — kiểm tra hộp thư, kể cả mục Spam.',
    demo_reset_url: 'dat-lai-mat-khau.html?token=tok-123',
  }));
  state.email = '  Ngoc@example.com  ';

  await state.forgotPassword();

  assert.equal(state.forgotNotice, 'Nếu email tồn tại, chúng tôi đã gửi liên kết đặt lại — kiểm tra hộp thư, kể cả mục Spam.');
  assert.equal(state.forgotDemoUrl, 'dat-lai-mat-khau.html?token=tok-123');
  // A panel, not a toast: on this demo it holds the only copy of the link.
  assert.deepEqual(state.toasts, []);
  assert.match(loginHtml, /x-show="forgotNotice"/);
  assert.match(loginHtml, /:href="forgotDemoUrl"/);
});

test('an address with no account gets the panel and no link, which reads the same either way', async () => {
  const state = loginWithRefs(async () => ({
    message: 'Nếu email tồn tại, chúng tôi đã gửi liên kết đặt lại — kiểm tra hộp thư, kể cả mục Spam.',
  }));
  state.email = 'nobody@example.com';

  await state.forgotPassword();

  assert.equal(state.forgotDemoUrl, '');
  assert.match(loginHtml, /x-show="forgotDemoUrl"/);
});

test('an empty sign-in is refused per field, before the round trip', async () => {
  let calls = 0;
  const state = loginWithRefs(async () => {
    calls += 1;
    return { user: { role: 'customer' } };
  });

  await state.submit();

  assert.equal(calls, 0);
  assert.equal(state.errors.email, 'Vui lòng nhập email.');
  assert.equal(state.errors.password, 'Vui lòng nhập mật khẩu.');
  assert.equal(state.busy, false);
});

test('the sign-in boxes name what they hold, and the failure announces itself', () => {
  assert.match(loginHtml, /id="identifier"[^>]*type="email"/);
  assert.match(loginHtml, /autocomplete="email"[^>]*id="identifier"/);
  assert.match(loginHtml, /autocomplete="current-password"[^>]*id="password"/);
  assert.match(loginHtml, /<p class="[^"]*text-error" role="alert"/);
  // A stale error may not outlive the keystroke that fixes it.
  assert.match(loginHtml, /@input="delete errors\.email"/);
  assert.match(loginHtml, /@input="delete errors\.password"/);
});

// ------------------------------------------------------------------ dang-ky

test('sign-up hands the browser every field it can fill, and marks the optional one', () => {
  for (const pattern of [
    /autocomplete="name"[^>]*id="name"/,
    /autocomplete="email"[^>]*id="email"/,
    /autocomplete="tel"[^>]*id="phone"/,
    /autocomplete="new-password"[^>]*id="password"/,
    /autocomplete="new-password"[^>]*id="confirm"/,
  ]) {
    assert.match(registerHtml, pattern);
  }
  assert.match(registerHtml, /for="phone">Số điện thoại \(không bắt buộc\)<\/label>/);
});

test('sign-up starts from what the wizard already asked for, and survives having none', () => {
  /* A guest who filled in the wizard's contact fields and was sent here to make an account
     must not be asked for the same name and phone twice (WCAG 3.3.7). The wizard stashes
     them under its own key on the way out and picks them up again on the way back, so this
     page only reads: removing them here would empty the fields the visitor returns to. */
  const filled = registerPage(JSON.stringify({ name: 'Ngọc Anh', phone: '0901234567' }));
  assert.equal(filled.name, 'Ngọc Anh');
  assert.equal(filled.phone, '0901234567');
  assert.equal(filled.email, '');

  // Nothing stashed, unreadable storage, and a browser that has none at all: all empty.
  assert.equal(registerPage(null).name, '');
  assert.equal(registerPage('not json').phone, '');
  assert.equal(registerPage(undefined).name, '');
});

test('the consent line points at the two documents it names, in a new tab', () => {
  assert.match(
    registerHtml,
    /href="dieu-khoan\.html" rel="noopener noreferrer" target="_blank">Điều khoản sử dụng<\/a>/,
  );
  assert.match(
    registerHtml,
    /href="bao-mat\.html" rel="noopener noreferrer" target="_blank">Chính sách bảo mật<\/a>/,
  );
});

// ------------------------------------------------------------------ cai-dat

test('the security form validates its three boxes before it asks the server', async () => {
  let calls = 0;
  const state = settingsPage(async () => {
    calls += 1;
    return { ok: true };
  });

  await state.changePassword();
  assert.equal(calls, 0);
  assert.equal(state.passwordErrors.current, 'Vui lòng nhập mật khẩu hiện tại.');
  assert.equal(state.passwordErrors.next, 'Mật khẩu mới phải có ít nhất 8 ký tự.');

  state.currentPassword = 'oldpassword';
  state.newPassword = 'longenough1';
  state.confirmPassword = 'longenough2';
  await state.changePassword();
  assert.equal(calls, 0);
  assert.equal(state.passwordErrors.confirm, 'Mật khẩu xác nhận không khớp.');
});

test('a change posts the snake_case pair and clears the three boxes on success', async () => {
  const calls = [];
  const state = settingsPage(async (path, options) => {
    calls.push([path, options.method, options.body]);
    return { ok: true };
  });
  await state.init();
  state.currentPassword = 'oldpassword';
  state.newPassword = 'longenough1';
  state.confirmPassword = 'longenough1';

  await state.changePassword();

  assert.equal(calls[0][0], '/api/auth/change-password');
  assert.equal(calls[0][1], 'POST');
  assert.equal(calls[0][2].current_password, 'oldpassword');
  assert.equal(calls[0][2].new_password, 'longenough1');
  assert.equal(state.currentPassword, '');
  assert.equal(state.newPassword, '');
  assert.equal(state.passwordNotice, 'Đã đổi mật khẩu.');
  // Inline, not a toast: the outcome belongs beside the fields it is about.
  assert.deepEqual(state.toasts, []);
  assert.match(settingsHtml, /x-text="passwordNotice"/);
});

test('a wrong current password keeps the two new ones, so only that box is retyped', async () => {
  const state = settingsPage(async () => {
    throw new Error('Mật khẩu hiện tại không đúng.');
  });
  state.currentPassword = 'wrong';
  state.newPassword = 'longenough1';
  state.confirmPassword = 'longenough1';

  await state.changePassword();

  assert.equal(state.passwordError, 'Mật khẩu hiện tại không đúng.');
  assert.equal(state.newPassword, 'longenough1');
  assert.equal(state.confirmPassword, 'longenough1');
  assert.equal(state.passwordBusy, false);
});

test('the security block lives on the settings page, outside both nav blocks', () => {
  // The rail and the tab strip are byte-compared across six pages by tai-khoan-ui;
  // this only asserts the block landed outside both of them.
  const security = settingsHtml.indexOf('<h2 class="font-headline-sm text-headline-sm text-primary mb-2">Bảo mật</h2>');
  assert.ok(security > settingsHtml.indexOf('data-oak-account-tabs=""'));
  assert.ok(security > settingsHtml.indexOf('data-oak-account-nav=""'));
});

test('the profile page kept none of it — one page changes a password, not two', () => {
  assert.equal(profileHtml.includes('/api/auth/change-password'), false);
  assert.equal(profileHtml.includes('changePassword('), false);
  assert.equal(
    profileHtml.includes('<h2 class="font-headline-sm text-headline-sm text-primary mb-2">Bảo mật</h2>'),
    false,
  );
});

test('the settings page carries the same head and shell contract as the other pages', () => {
  for (const tag of [
    '<script src="assets/js/oak-api.js"></script>',
    '<script src="assets/js/oak-i18n.js"></script>',
    '<script src="assets/js/oak-header.js"></script>',
    '<header class="glass-nav fixed top-0 w-full z-50 transition-colors" data-oak-header></header>',
    '<title>Cài đặt - OAK Beauty</title>',
  ]) {
    assert.ok(settingsHtml.includes(tag), 'missing ' + tag);
  }
  const loader = /<script>\n\(function \(\) \{[\s\S]*?\}\)\(\);\n<\/script>/;
  assert.equal(settingsHtml.match(loader)[0], loginHtml.match(loader)[0]);
});

// ------------------------------------------------------------------ the language section

test('choosing the other language hands it to the engine, which stores it and reloads', () => {
  const state = settingsPage(async () => assert.fail('no request may be made'));

  assert.equal(state.lang, 'vi');
  state.setLang('en');
  assert.deepEqual(state.langSet, ['en']);
});

test('choosing the language already in use does nothing, so the page does not reload', () => {
  const state = settingsPage(async () => assert.fail('no request may be made'));

  state.setLang('vi');
  assert.deepEqual(state.langSet, []);
});

test('both choices are buttons that say which one is in force', () => {
  assert.match(settingsHtml, /:aria-pressed="lang === 'vi'"[\s\S]*?>Tiếng Việt<\/button>/);
  assert.match(settingsHtml, /:aria-pressed="lang === 'en'"[\s\S]*?>English<\/button>/);
  assert.match(settingsHtml, /@click="setLang\('vi'\)"/);
  assert.match(settingsHtml, /@click="setLang\('en'\)"/);
  assert.match(settingsHtml, /role="group"/);
});

test('a change stamps the same cut-off the server did, so the line above the form is right', async () => {
  const state = settingsPage(async () => ({ ok: true }));
  await state.init();
  state.currentPassword = 'oldpassword';
  state.newPassword = 'longenough1';
  state.confirmPassword = 'longenough1';

  const before = Math.floor(Date.now() / 1000);
  await state.changePassword();

  // Epoch seconds, the unit the users row and the JWT iat are both compared in.
  assert.ok(state.user.password_changed_at >= before);
  assert.ok(state.user.password_changed_at <= Math.floor(Date.now() / 1000));
  // Pinned, because comparing the method to a rebuild of itself would pass on any rule.
  // 1787342400 is 2026-08-21T20:00Z — 03:00 on the 22nd in ICT, the small hours a UTC
  // calendar day reports as the day before. The stub echoes its argument, so what comes
  // back is the ISO string fmtDate was handed.
  const pinned = 1787342400;
  state.user.password_changed_at = pinned;
  assert.equal(state.lastPasswordChange().split('T')[0], '2026-08-22');
  assert.match(settingsHtml, /x-text="lastPasswordChange\(\)"/);
  assert.match(settingsHtml, /x-show="user\.password_changed_at"/);
});

test('the settings page is reachable from the account menu and the sitemap', () => {
  const mine = headerSource.slice(
    headerSource.indexOf("entry('thong-bao.html'"),
    headerSource.indexOf('var signOut ='),
  );
  assert.match(mine, /entry\('cai-dat\.html', 'Cài đặt'\)/);
  assert.ok(sitemapHtml.includes('href="cai-dat.html">Cài đặt</a>'));
});

// ------------------------------------------------------------------ the toggle and its icon

test('every password box on the four pages can be revealed, and the icon is subsetted', () => {
  // Four: the three auth pages and the settings page. The profile page has none left.
  // Trimmed per line, the way tools/icons/subset_icons.py reads the same file.
  const names = fs
    .readFileSync(path.join(root, 'tools/icons/icon-names.txt'), 'utf8')
    .split('\n')
    .map((line) => line.trim());
  // The toggle swaps the ligature at runtime, so neither name reaches icon-names.txt
  // through a data-icon attribute; the subset only holds them because they are listed.
  assert.ok(names.includes('visibility'));
  assert.ok(names.includes('visibility_off'));

  const toggles = (html) => html.match(/x-text="show\w+ \? 'visibility_off' : 'visibility'"/g) || [];
  assert.equal(toggles(loginHtml).length, 1);
  assert.equal(toggles(registerHtml).length, 2);
  assert.equal(toggles(resetHtml).length, 2);
  assert.equal(toggles(profileHtml).length, 0);
  assert.equal(toggles(settingsHtml).length, 3);
});

// ------------------------------------------------------------------ the server contract

test('forgot-password answers 200 whether or not the address is known', () => {
  const handler = authSource.slice(authSource.indexOf("router.post('/forgot-password'"));
  const body = handler.slice(0, handler.indexOf("router.post('/reset-password'"));

  // Four exits — unknown/throttled, demo, no origin declared, production — and all four
  // send the identical envelope, so no branch can be told from another by the reply it
  // writes.
  const sends = body.match(/res\.json\([^)]*\)/g) || [];
  assert.equal(sends.length, 4);
  for (const send of sends) {
    assert.equal(send, 'res.json({ success: true, data })');
  }
  // ...and `data` is built once, before any branch can reach it.
  assert.equal((body.match(/const data = \{ message: 'Nếu email tồn tại/g) || []).length, 1);
});

test('the demo reset link can never be emitted by a production deploy', () => {
  const handler = authSource.slice(authSource.indexOf("router.post('/forgot-password'"));
  const body = handler.slice(0, handler.indexOf("router.post('/reset-password'"));

  const gate = body.indexOf(
    "if (!process.env.RESEND_API_KEY && process.env.NODE_ENV !== 'production') {",
  );
  const field = body.indexOf('data.demo_reset_url =');
  const gateEnds = body.indexOf('res.json({ success: true, data });\n    return mintReset(');
  assert.ok(gate !== -1 && field > gate && field < gateEnds, 'the field escapes the demo gate');
  assert.match(body, /data\.demo_reset_url = `dat-lai-mat-khau\.html\?token=\$\{token\}`;/);
  // Exactly one place builds it, so the guard cannot be bypassed elsewhere.
  assert.equal((authSource.match(/demo_reset_url/g) || []).length, 1);
});

test('a reset token is spent by the same statement that redeems it, inside the transaction', () => {
  assert.match(
    authSource,
    /UPDATE password_resets SET used = 1 WHERE token = \? AND used = 0/,
  );
  const handler = authSource.slice(authSource.indexOf("router.post('/reset-password'"));
  const body = handler.slice(0, handler.indexOf("router.post('/change-password'"));
  // The conditional spend and the password write are one transaction, so a link that
  // loses the race changes nothing at all.
  const transaction = body.slice(body.indexOf('db.withTransaction'));
  assert.ok(transaction.indexOf('SPEND_PASSWORD_RESET') < transaction.indexOf('UPDATE_PASSWORD'));
  assert.match(transaction, /spent\.changes !== 1/);
});

test('changing a password from a session needs the session and the old password', () => {
  const handler = authSource.slice(authSource.indexOf("router.post('/change-password'"));
  assert.match(handler, /router\.post\('\/change-password', requireAuth,/);
  assert.match(handler, /bcrypt\.compare\(currentPassword, credentials\.password_hash\)/);
  assert.match(handler, /Mật khẩu hiện tại không đúng\./);
  // The account changed is always the caller's own; no id is read from the body.
  assert.match(handler, /tx\.run\(UPDATE_PASSWORD, passwordHash, changedAt, req\.user\.id\)/);
  assert.doesNotMatch(handler, /req\.body[^\n]*id/);
});

// ------------------------------------------------- one live reset link per account

test('asking again retires the previous link, and does so before minting the new one', () => {
  // Both callers go through mintReset, so the order lives in one place.
  const mint = authSource.slice(
    authSource.indexOf('async function mintReset('),
    authSource.indexOf("router.post('/forgot-password'"),
  );
  const retire = mint.indexOf('retireUserResets.run(userId)');
  const insert = mint.indexOf('insertPasswordReset.run(');
  assert.ok(retire !== -1, 'the previous links are never retired');
  // The other order would retire the row that was just written.
  assert.ok(retire < insert, 'the new token is minted before the old ones are retired');
  // No second copy of the pair anywhere.
  assert.equal((authSource.match(/insertPasswordReset\.run\(/g) || []).length, 1);
});

test('a completed reset closes every other link the account was still holding', () => {
  const handler = authSource.slice(authSource.indexOf("router.post('/reset-password'"));
  const body = handler.slice(0, handler.indexOf("router.post('/change-password'"));
  const transaction = body.slice(body.indexOf('db.withTransaction'));

  // All three writes are one transaction: spend this link, retire the rest, set the password.
  assert.ok(transaction.includes('tx.run(RETIRE_USER_RESETS, reset.user_id)'));
  assert.ok(transaction.indexOf('SPEND_PASSWORD_RESET') < transaction.indexOf('RETIRE_USER_RESETS'));
  assert.ok(transaction.indexOf('RETIRE_USER_RESETS') < transaction.indexOf('UPDATE_PASSWORD'));
});

test('changing the password from a session kills any reset link still outstanding', () => {
  const handler = authSource.slice(authSource.indexOf("router.post('/change-password'"));
  const transaction = handler.slice(handler.indexOf('db.withTransaction'));

  // Same transaction as the password write: a changed password that left an old link live
  // would let that link change it straight back.
  assert.ok(transaction.includes('tx.run(RETIRE_USER_RESETS, req.user.id)'));
  assert.ok(transaction.indexOf('UPDATE_PASSWORD') < transaction.indexOf('RETIRE_USER_RESETS'));
});

test('retiring is always scoped to one account and only ever touches live rows', () => {
  assert.match(
    authSource,
    /const RETIRE_USER_RESETS = 'UPDATE password_resets SET used = 1 WHERE user_id = \? AND used = 0';/,
  );
  // One statement text behind all three callers — the declaration, the prepared handle
  // the non-transactional caller uses, and the two tx.run sites — so no second spelling
  // of the rule can drift from it.
  assert.equal((authSource.match(/RETIRE_USER_RESETS/g) || []).length, 4);
  assert.match(authSource, /const retireUserResets = db\.prepare\(RETIRE_USER_RESETS\);/);
  assert.equal((authSource.match(/UPDATE password_resets SET used = 1/g) || []).length, 2);
});

// ------------------------------------------------- a password change ends the old sessions

test('the cut-off is stored in the same unit a JWT stamps iat with', () => {
  // Epoch seconds on both sides, so the comparison needs no parsing and no timezone.
  assert.match(schemaSource, /password_changed_at BIGINT/);
  assert.match(schemaSource, /ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at BIGINT;/);
  assert.match(authSource, /function epochSeconds\(\) \{\s*return Math\.floor\(Date\.now\(\) \/ 1000\);/);
  assert.match(
    authSource,
    /'UPDATE users SET password_hash = \?, password_changed_at = \? WHERE id = \?'/,
  );
});

test('both password writes stamp the cut-off, in the same statement as the hash', () => {
  // One statement text for both paths, so a hash can never land without its cut-off.
  assert.equal((authSource.match(/tx\.run\(UPDATE_PASSWORD, passwordHash, /g) || []).length, 2);
  assert.match(authSource, /tx\.run\(UPDATE_PASSWORD, passwordHash, epochSeconds\(\), reset\.user_id\)/);
  assert.match(authSource, /tx\.run\(UPDATE_PASSWORD, passwordHash, changedAt, req\.user\.id\)/);
});

test('requireAuth and the /me probe apply that cut-off through one shared rule', () => {
  assert.match(
    middlewareSource,
    /export function sessionOutlivedPassword\(payload, user\) \{\s*return user\.password_changed_at != null && payload\.iat < user\.password_changed_at;/,
  );
  // requireAuth rejects; /me downgrades to a guest rather than 401-ing a page load.
  assert.match(middlewareSource, /if \(sessionOutlivedPassword\(payload, user\)\) \{/);
  assert.match(authSource, /if \(user && sessionOutlivedPassword\(payload, user\)\) \{\s*user = null;/);
  // The column has to be selected, or the rule silently never fires.
  assert.match(middlewareSource, /SELECT id, name, email[^']*password_changed_at[^']*FROM users WHERE id = \?/);
});

test('changing a password re-issues the caller its own session, killing only the others', () => {
  const handler = authSource.slice(authSource.indexOf("router.post('/change-password'"));
  // Signed after the write, so its iat cannot fall before the cut-off it must survive.
  assert.ok(handler.indexOf('db.withTransaction') < handler.indexOf('issueCookie(res, req.user)'));
  // The reset path deliberately does NOT re-issue: nobody is signed in there.
  const reset = authSource.slice(
    authSource.indexOf("router.post('/reset-password'"),
    authSource.indexOf("router.post('/change-password'"),
  );
  assert.doesNotMatch(reset, /issueCookie/);
});

// ------------------------------------------------------------- forgot-password hardening

test('the throttle refuses the work but never changes the answer', () => {
  const handler = authSource.slice(authSource.indexOf("router.post('/forgot-password'"));
  const body = handler.slice(0, handler.indexOf("router.post('/reset-password'"));

  // Keyed on the address and the caller together.
  assert.match(body, /forgotRateLimited\(`\$\{normalised\}\|\$\{req\.ip\}`\)/);
  // Same envelope as every other outcome — the throttle may not become a new oracle.
  assert.match(body, /if \(!account \|\| forgotRateLimited\([^)]*\)\) \{\s*return res\.json\(\{ success: true, data \}\);/);
  // ...and no token is minted on that path.
  const refused = body.slice(0, body.indexOf('const token ='));
  assert.doesNotMatch(refused, /mintReset|insertPasswordReset|retireUserResets/);
});

test('the window is a fixed 15 minutes at three attempts, swept without a timer', () => {
  assert.match(authSource, /const FORGOT_WINDOW_MS = 15 \* 60 \* 1000;/);
  assert.match(authSource, /const FORGOT_MAX_ATTEMPTS = 3;/);
  assert.match(authSource, /entry\.count > FORGOT_MAX_ATTEMPTS/);
  // Pruned inside the call, so an idle process keeps nothing alive.
  assert.match(authSource, /forgotAttempts\.delete\(seen\)/);
  assert.doesNotMatch(authSource, /setInterval|setTimeout/);
});

test('in production the reply goes out before the write, so timing says nothing', () => {
  const handler = authSource.slice(authSource.indexOf("router.post('/forgot-password'"));
  const body = handler.slice(0, handler.indexOf("router.post('/reset-password'"));

  const demo = body.indexOf('if (!process.env.RESEND_API_KEY');
  const production = body.indexOf('res.json({ success: true, data });\n    return mintReset(');
  assert.ok(production > demo, 'the production path is not the one after the demo branch');
  // Already replied: a failed write may not be thrown into next().
  assert.match(
    body,
    /return mintReset\(token, account\.id, expiresAt\)\s*\.then\([\s\S]*?\)\s*\.catch\(\(error\) => \{/,
  );
  // The demo branch is the reverse order on purpose — it has to know the token first.
  const demoBranch = body.slice(demo, production);
  assert.ok(demoBranch.indexOf('await mintReset(') < demoBranch.indexOf('data.demo_reset_url ='));
});

test('the reset link table is indexed for the lookup that retires by account', () => {
  assert.match(
    schemaSource,
    /CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets\(user_id\)\s*WHERE used = 0;/,
  );
});

// ------------------------------------------------------------------ the reset mail channel

/** Drive sendResetMail with fetch and console.error captured, then put both back. */
async function withTransport(answer, run) {
  const requests = [];
  const logged = [];
  const realFetch = globalThis.fetch;
  const realError = console.error;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  };
  console.error = (...args) => logged.push(args.map(String).join(' '));
  try {
    return { result: await run(), requests, logged };
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
  }
}

/** Run `body` with RESEND_API_KEY set to `key` (or unset when null), then restore it. */
async function withKey(key, body) {
  const previous = process.env.RESEND_API_KEY;
  if (key === null) {
    delete process.env.RESEND_API_KEY;
  } else {
    process.env.RESEND_API_KEY = key;
  }
  try {
    return await body();
  } finally {
    if (previous === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = previous;
    }
  }
}

test('with no key configured no mail is attempted and nothing is logged as a failure', async () => {
  const { result, requests, logged } = await withKey(null, () =>
    withTransport(new Error('no request may be made'), () =>
      sendResetMail('khach@oak.vn', 'https://oak.example/dat-lai-mat-khau.html?token=t'),
    ),
  );

  assert.equal(result, false);
  assert.deepEqual(requests, []);
  assert.deepEqual(logged, []);
});

test('with a key the link is posted to Resend, and the From is configurable', async () => {
  const previousFrom = process.env.RESET_MAIL_FROM;
  delete process.env.RESET_MAIL_FROM;
  const link = 'https://oak.example/dat-lai-mat-khau.html?token=tok-123';
  const { result, requests } = await withKey('re_fake', () =>
    withTransport({ ok: true, status: 200, text: async () => '' }, () =>
      sendResetMail('khach@oak.vn', link),
    ),
  );

  assert.equal(result, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.resend.com/emails');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer re_fake');
  const sent = JSON.parse(requests[0].options.body);
  assert.equal(sent.to, 'khach@oak.vn');
  assert.equal(sent.from, 'OAK Beauty <no-reply@oakbeauty.vn>');
  // The link is the whole message; without it the mail is worthless.
  assert.ok(sent.text.includes(link));

  process.env.RESET_MAIL_FROM = 'OAK <reset@example.vn>';
  const configured = await withKey('re_fake', () =>
    withTransport({ ok: true, status: 200, text: async () => '' }, () =>
      sendResetMail('khach@oak.vn', link),
    ),
  );
  assert.equal(JSON.parse(configured.requests[0].options.body).from, 'OAK <reset@example.vn>');
  if (previousFrom === undefined) {
    delete process.env.RESET_MAIL_FROM;
  } else {
    process.env.RESET_MAIL_FROM = previousFrom;
  }
});

test('a refusal and an unreachable Resend are logged, never thrown, and never name the address', async () => {
  const refused = await withKey('re_fake', () =>
    withTransport({ ok: false, status: 403, text: async () => 'domain is not verified' }, () =>
      sendResetMail('khach@oak.vn', 'https://oak.example/dat-lai-mat-khau.html?token=t'),
    ),
  );
  assert.equal(refused.result, false);
  assert.equal(refused.logged.length, 1);
  assert.match(refused.logged[0], /403/);

  const offline = await withKey('re_fake', () =>
    withTransport(new Error('getaddrinfo ENOTFOUND'), () =>
      sendResetMail('khach@oak.vn', 'https://oak.example/dat-lai-mat-khau.html?token=t'),
    ),
  );
  assert.equal(offline.result, false);
  assert.equal(offline.logged.length, 1);

  // The endpoint is built so that not even its timing says who has an account; a log line
  // holding the address would give that away to anyone reading the Render console.
  for (const line of [...refused.logged, ...offline.logged]) {
    assert.doesNotMatch(line, /khach@oak\.vn/);
  }
});

test('the reset mail is the only thing this channel can send', () => {
  // One export, one endpoint: anything wanting to mail something else has to add a file,
  // which is a change worth noticing rather than one line worth missing.
  assert.equal((mailerSource.match(/^export /gm) || []).length, 1);
  assert.match(mailerSource, /export async function sendResetMail\(to, url\)/);
  assert.equal((mailerSource.match(/https:\/\/api\.resend\.com/g) || []).length, 1);
  // A rejection here would land as an unhandled rejection: the reply is already sent.
  assert.match(mailerSource, /catch \(error\) \{\s*console\.error\(/);
});

test('the mailed link is absolute and prefers the origin Render publishes', () => {
  const handler = authSource.slice(authSource.indexOf("router.post('/forgot-password'"));
  const body = handler.slice(0, handler.indexOf("router.post('/reset-password'"));

  // A forged Host header must not be able to point the mail at another server: the origin
  // is declared by the deploy, and in production a deploy that declared none mails nothing
  // rather than falling back to what the caller sent.
  assert.match(
    body,
    /const declaredOrigin = process\.env\.RENDER_EXTERNAL_URL \|\| process\.env\.PUBLIC_BASE_URL;/,
  );
  assert.match(body, /if \(!declaredOrigin && process\.env\.NODE_ENV === 'production'\) \{/);
  const guard = body.indexOf('!declaredOrigin');
  assert.ok(guard !== -1 && guard < body.indexOf("req.get('host')"));
  assert.match(body, /sendResetMail\(normalised, `\$\{origin\}\/dat-lai-mat-khau\.html\?token=\$\{token\}`\)/);
});
