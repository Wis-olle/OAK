import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readUi = (name) => fs.readFileSync(path.join(root, 'ui', name), 'utf8');

const clientJs = fs.readFileSync(path.join(root, 'ui', 'assets', 'js', 'oak-api.js'), 'utf8');
const favoritesHtml = readUi('yeu-thich.html');

// ------------------------------------------------------------------ OAK.toast

/* toast() lives inside the oak-api.js IIFE, which builds a header on load. Only the message
   functions are under test, so they are lifted out and driven against the smallest DOM they
   touch. `made` collects every element the run created, newest last; `body` holds the ones
   currently on the page. */
function toastHarness() {
  const from = clientJs.indexOf('var TOAST_COLORS = {');
  const script = clientJs.slice(from, clientJs.indexOf('  // Where signing out lands.'));

  const made = [];
  const body = {
    children: [],
    appendChild(child) {
      this.children.push(child);
      child.inDom = true;
    },
  };

  const doc = {
    createElement: () => element(),
    querySelector: () => null,
    contains: (node) => Boolean(node && node.inDom),
    activeElement: null,
    body,
  };

  const element = () => {
    const node = {
      attributes: {},
      children: [],
      handlers: {},
      className: '',
      textContent: '',
      removed: false,
      inDom: false,
      focused: 0,
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      appendChild(child) {
        this.children.push(child);
      },
      addEventListener(name, handler) {
        (this.handlers[name] = this.handlers[name] || []).push(handler);
      },
      focus() {
        this.focused += 1;
        doc.activeElement = this;
      },
      remove() {
        this.removed = true;
        this.inDom = false;
        const at = body.children.indexOf(this);
        if (at !== -1) {
          body.children.splice(at, 1);
        }
      },
    };
    made.push(node);
    return node;
  };

  const timers = new Map();
  let nextTimer = 0;
  const context = {
    document: doc,
    setTimeout(fn, delay) {
      nextTimer += 1;
      timers.set(nextTimer, { fn, delay });
      return nextTimer;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    Date,
    Math,
    String,
    Boolean,
  };
  vm.runInNewContext(`${script}\ntoastFn = toast;`, context);

  const fire = (node, name, event = {}) =>
    (node.handlers[name] || []).forEach((handler) => handler(event));
  const armed = () => [...timers.values()];
  return { call: context.toastFn, made, body, doc, timers, fire, armed };
}

/** A page control for focus to have been on when a message appeared. */
const anchor = () => ({ inDom: true, focused: 0, focus() { this.focused += 1; } });

test('a message stays up long enough to be read, and longer when it carries a choice', () => {
  const short = 'Đã lưu.';
  const long = 'x'.repeat(100);

  const a = toastHarness();
  a.call(short);
  assert.equal([...a.timers.values()][0].delay, 3000);

  // 5s floor for a failure, since it has to say why.
  const b = toastHarness();
  b.call(short, 'error');
  assert.equal([...b.timers.values()][0].delay, 5000);

  // 50ms of reading time per character past 40: 3000 + 60 * 50 = 6000.
  const c = toastHarness();
  c.call('y'.repeat(100));
  assert.equal([...c.timers.values()][0].delay, 6000);

  // …to a ceiling of 8s, however long the sentence.
  const d = toastHarness();
  d.call(long, 'error');
  assert.equal([...d.timers.values()][0].delay, 8000);

  // A choice has to outlive the reading of it, so it starts from the same floor.
  const e = toastHarness();
  e.call(short, 'success', { actionLabel: 'Hoàn tác', onAction() {} });
  assert.equal([...e.timers.values()][0].delay, 5000);
});

test('only a failure interrupts the screen reader', () => {
  const a = toastHarness();
  a.call('Đã lưu.');
  assert.equal(a.made[0].attributes.role, 'status');

  const b = toastHarness();
  b.call('Hỏng rồi.', 'error');
  assert.equal(b.made[0].attributes.role, 'alert');
});

test('the action button runs its handler once and takes the message with it', () => {
  const harness = toastHarness();
  const was = anchor();
  harness.doc.activeElement = was;
  let ran = 0;
  harness.call('Đã bỏ khỏi danh sách yêu thích.', 'success', {
    actionLabel: 'Hoàn tác',
    onAction: () => (ran += 1),
  });

  const [message, button] = harness.made;
  assert.equal(message.children.length, 1);
  assert.equal(button.textContent, 'Hoàn tác');
  assert.equal(button.type, 'button');

  harness.fire(button, 'click');
  assert.equal(ran, 1);
  assert.equal(message.removed, true);
  // The dismissal timer is cancelled, so nothing tries to remove it a second time.
  assert.equal(harness.timers.size, 0);
  // …and the keyboard is back where the visitor left it, not at the top of the document.
  assert.equal(was.focused, 1);
});

test('a caller that only reports something gets no button and no third argument', () => {
  const harness = toastHarness();
  harness.call('Đã lưu.');
  assert.equal(harness.made.length, 1);
  assert.equal(harness.made[0].children.length, 0);
  assert.doesNotMatch(harness.made[0].className, /flex/);
});

test('a second message takes the slot, timer and all, rather than stacking on the first', () => {
  const harness = toastHarness();
  harness.call('Đã lưu.');
  const first = harness.made[0];
  assert.equal(harness.body.children.length, 1);
  assert.equal(harness.timers.size, 1);

  harness.call('Đã bỏ khỏi danh sách yêu thích.', 'error');
  assert.equal(first.removed, true);
  assert.equal(harness.body.children.length, 1);
  assert.equal(harness.body.children[0], harness.made[1]);
  // One armed timer, and it belongs to the message still on screen.
  assert.equal(harness.timers.size, 1);
  assert.equal(harness.armed()[0].delay, 5000);
});

test('an expired message frees the slot without dragging its successor out with it', () => {
  const harness = toastHarness();
  harness.call('Đã lưu.');
  harness.armed()[0].fn();
  assert.equal(harness.made[0].removed, true);
  assert.equal(harness.timers.size, 0);

  harness.call('Đã lưu lần nữa.');
  assert.equal(harness.body.children.length, 1);
  assert.equal(harness.made[1].removed, false);
});

test('a message holding the keyboard does not expire under the visitor', () => {
  const harness = toastHarness();
  harness.call('Đã bỏ khỏi danh sách yêu thích.', 'success', {
    actionLabel: 'Hoàn tác',
    onAction() {},
  });
  const [message] = harness.made;

  harness.fire(message, 'focusin');
  assert.equal(harness.timers.size, 0, 'no countdown while it is focused');

  // Leaving re-arms it with what is left of the original window, floored at two seconds.
  harness.fire(message, 'focusout');
  assert.equal(harness.timers.size, 1);
  assert.ok(harness.armed()[0].delay >= 2000);
  assert.ok(harness.armed()[0].delay <= 5000);
});

test('Escape closes a message from the keyboard and hands focus back', () => {
  const harness = toastHarness();
  const was = anchor();
  harness.doc.activeElement = was;
  let ran = 0;
  harness.call('Đã bỏ khỏi danh sách yêu thích.', 'success', {
    actionLabel: 'Hoàn tác',
    onAction: () => (ran += 1),
  });
  const [message] = harness.made;

  harness.fire(message, 'keydown', { key: 'a' });
  assert.equal(message.removed, false, 'only Escape closes it');

  harness.fire(message, 'keydown', { key: 'Escape' });
  assert.equal(message.removed, true);
  assert.equal(harness.timers.size, 0);
  assert.equal(was.focused, 1);
  // Escape dismisses; it does not silently take the action the visitor did not choose.
  assert.equal(ran, 0);
});

test('focus is not forced back onto an anchor the page no longer has', () => {
  const harness = toastHarness();
  const was = anchor();
  harness.doc.activeElement = was;
  harness.call('Đã bỏ khỏi danh sách yêu thích.', 'success', {
    actionLabel: 'Hoàn tác',
    onAction() {},
  });

  // The undo re-rendered the list, so the card that was focused is gone.
  was.inDom = false;
  harness.fire(harness.made[1], 'click');
  assert.equal(was.focused, 0);
});

// ------------------------------------------------------------------ yeu-thich.html

function favorites(api) {
  const tail = favoritesHtml.slice(favoritesHtml.indexOf('function oakFavorites()'));
  const script = tail.slice(0, tail.indexOf('</script>'));
  const context = {
    toasts: [],
    OAK: {
      api,
      toast: (message, type, action) => context.toasts.push({ message, type, action }),
      requireLogin: async () => ({ id: 1 }),
      fmtPrice: (value) => String(value),
    },
  };
  vm.runInNewContext(`${script}\nresult = oakFavorites();`, context);
  context.result.toasts = context.toasts;
  return context.result;
}

const salon = (id) => ({ id, name: 'Salon ' + id, slug: 's' + id });

test('undoing a removal puts the card back where it was and asks for it again', async () => {
  const calls = [];
  const state = favorites(async (path, init) => {
    calls.push([path, init]);
    return { ok: true };
  });
  state.salons = [salon(1), salon(2), salon(3)];

  await state.remove('salons', state.salons[1]);
  assert.deepEqual(
    state.salons.map((entry) => entry.id),
    [1, 3],
  );
  assert.equal(calls[0][0], '/api/favorites?salon_id=2');
  assert.equal(calls[0][1].method, 'DELETE');

  const [message] = state.toasts;
  assert.equal(message.message, 'Đã bỏ khỏi danh sách yêu thích.');
  assert.equal(message.action.actionLabel, 'Hoàn tác');

  await message.action.onAction();
  // Back at index 1, not appended to the end.
  assert.deepEqual(
    state.salons.map((entry) => entry.id),
    [1, 2, 3],
  );
  assert.equal(calls[1][0], '/api/favorites');
  assert.equal(calls[1][1].method, 'POST');
  assert.equal(calls[1][1].body.salon_id, 2);
});

test('a service is undone through its own key', async () => {
  const calls = [];
  const state = favorites(async (path, init) => {
    calls.push([path, init]);
    return { ok: true };
  });
  state.services = [{ id: 7, name: 'Nail' }];

  await state.remove('services', state.services[0]);
  await state.toasts[0].action.onAction();
  assert.equal(calls[1][0], '/api/favorites');
  assert.equal(calls[1][1].body.service_id, 7);
});

test('a refused undo leaves the list as the server has it, and says so', async () => {
  const state = favorites(async (path, init) => {
    if (init && init.method === 'POST') {
      throw new Error('Không kết nối được máy chủ, vui lòng thử lại.');
    }
    return { ok: true };
  });
  state.salons = [salon(1), salon(2)];

  await state.remove('salons', state.salons[0]);
  await state.toasts[0].action.onAction();
  assert.deepEqual(
    state.salons.map((entry) => entry.id),
    [2],
  );
  assert.equal(state.toasts[1].type, 'error');
});

test('a refused load is held on the page instead of reading as an empty list', async () => {
  let calls = 0;
  const state = favorites(async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error('Không kết nối được máy chủ, vui lòng thử lại.');
    }
    return { salons: [salon(1)], services: [] };
  });

  await state.init();
  assert.equal(state.error, 'Không kết nối được máy chủ, vui lòng thử lại.');
  assert.equal(state.loading, false);
  // Not a toast: three seconds later there would be nothing left but "Bạn chưa lưu salon nào".
  assert.deepEqual(state.toasts, []);

  // The error card asks for the same load again.
  await state.load();
  assert.equal(state.error, '');
  assert.equal(state.salons.length, 1);
});

test('the tab counters stay quiet until the reply is in', () => {
  // '(0)' before the first reply is a claim about a list nobody has read yet.
  assert.match(favoritesHtml, /x-text="loading \? '' : '\(' \+ salons\.length \+ '\)'"/);
  assert.match(favoritesHtml, /x-text="loading \? '' : '\(' \+ services\.length \+ '\)'"/);
});

test('a saved card is one tap from the wizard, not two pages away', () => {
  assert.match(favoritesHtml, /:href="'dat-lich\.html\?salon_id=' \+ salon\.id"/);
  assert.match(
    favoritesHtml,
    /:href="'dat-lich\.html\?service_id=' \+ service\.id \+ '&amp;salon_id=' \+ service\.salon\.id"/,
  );
  // Eight saved salons would otherwise be eight links all named "Đặt lịch"; the card
  // heading is what tells them apart, so each pill points at its own.
  assert.match(favoritesHtml, /:aria-describedby="'fav-salon-' \+ salon\.id"/);
  assert.match(favoritesHtml, /:id="'fav-salon-' \+ salon\.id"/);
  assert.match(favoritesHtml, /:aria-describedby="'fav-service-' \+ service\.id"/);
  assert.match(favoritesHtml, /:id="'fav-service-' \+ service\.id"/);
  assert.equal(favoritesHtml.split('data-icon="event_available"').length - 1, 2);
});

test('a removal the server refuses is rolled back without offering an undo', async () => {
  const state = favorites(async () => {
    throw new Error('Không xóa được.');
  });
  state.salons = [salon(1), salon(2)];

  await state.remove('salons', state.salons[1]);
  assert.deepEqual(
    state.salons.map((entry) => entry.id),
    [1, 2],
  );
  assert.equal(state.toasts[0].type, 'error');
  assert.equal(state.toasts[0].action, undefined);
});
