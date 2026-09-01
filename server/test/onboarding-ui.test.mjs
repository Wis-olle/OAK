/*
 * Salon onboarding: the dashboard setup checklist, the "listed on OAK" switch and the
 * photo gallery on the settings page, and the two console affordances they link at.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { bookingStatus } from './booking-status.mjs';
import { readServer, readUi } from './lib/read-source.mjs';

/* A localStorage that can be told to throw, the way a browser with site data blocked does. */
function storage(broken) {
    const values = new Map();
    return {
        values,
        getItem(key) {
            if (broken) {
                throw new Error('storage disabled');
            }
            return values.has(key) ? values.get(key) : null;
        },
        setItem(key, value) {
            if (broken) {
                throw new Error('storage disabled');
            }
            values.set(key, value);
        },
    };
}

/* The dashboard factory is inline in the page; lift it out of its <script> to drive it here,
   stopping before the trailing oakPartnerChrome() call which needs a real document. */
function dashboard(api, store) {
    const html = readUi('tong-quan-doi-tac.html');
    const tail = html.slice(html.indexOf('var OAK_SEARCH_TYPES'));
    const script = tail.slice(0, tail.lastIndexOf('oakPartnerChrome();'));
    const context = {
        document: { title: 'Tổng quan', visibilityState: 'visible', addEventListener() {} },
        setInterval: () => {},
        localStorage: store || storage(false),
        OAK: { api, toast: () => {}, fmtDate: (iso) => String(iso), todayISO: () => '2026-08-21', bookingStatus },
    };
    vm.runInNewContext(`${script}\nresult = oakPartnerOverview();`, context);
    return context.result;
}

/* The settings factory, lifted the same way. Its script block declares only helpers and the
   factory, so nothing runs on load. */
function settings(api, toast, globals) {
    const html = readUi('cai-dat-salon.html');
    const script = html.slice(html.indexOf('var HCMC_DISTRICTS'), html.lastIndexOf('</script>'));
    const context = { OAK: { api, toast: toast || (() => {}) }, ...(globals || {}) };
    vm.runInNewContext(`${script}\nresult = salonSettings();`, context);
    return context.result;
}

/* The service console's factory, lifted the same way, stopping before its own chrome call. */
function services(api, toast) {
    const html = readUi('quan-ly-dich-vu.html');
    const tail = html.slice(html.indexOf('var OAK_CATEGORY_LABELS'));
    const script = tail.slice(0, tail.lastIndexOf('oakPartnerChrome();'));
    const context = { URLSearchParams, OAK: { api, toast: toast || (() => {}), qs: () => null } };
    vm.runInNewContext(`${script}
result = oakPartnerServices();`, context);
    return context.result;
}

/** The shape GET /api/partner/salon answers with, with the given fields overridden. */
function salonRow(overrides) {
    return {
        id: 7,
        slug: 'salon-moi',
        name: 'Salon Mới',
        address: null,
        image: null,
        lat: null,
        lng: null,
        hours: [],
        published: 0,
        ...overrides,
    };
}

function withMeta(rows, total, activeTotal) {
    const meta = { total, active_total: activeTotal === undefined ? total : activeTotal };
    Object.defineProperty(rows, 'meta', { value: meta, enumerable: false });
    return rows;
}

/* ---------------------------------------------------------------- dashboard checklist */

test('a brand-new salon scores 0/5 and every step links at the page that fixes it', async () => {
    const state = dashboard(async (route) => {
        if (route === '/api/partner/salon') {
            return salonRow({});
        }
        if (route.startsWith('/api/partner/services')) {
            return withMeta([], 0);
        }
        return withMeta([], 0);
    });

    await state.loadSetup();
    assert.equal(state.setupDone(), 0);
    assert.equal(state.showSetup(), true);
    // Joined rather than compared as arrays: the factory runs in its own realm, so the
    // objects it builds are never reference-equal to the ones written here.
    assert.equal(
        state.setupSteps().map((step) => step.href).join(' | '),
        [
            'cai-dat-salon.html#vi-tri',
            'cai-dat-salon.html#gio-mo-cua',
            'quan-ly-dich-vu.html?new=1',
            'quan-ly-nhan-vien.html?new=1',
            'cai-dat-salon.html#hien-thi',
        ].join(' | '),
    );
    assert.equal(state.setupSteps().every((step) => step.done === false), true);
});

test('the checklist ticks each step off its own evidence and hides itself at 5/5', async () => {
    const store = storage(false);
    const state = dashboard(async (route) => {
        if (route === '/api/partner/salon') {
            return salonRow({
                address: '1 Lê Lợi',
                lat: 10.77,
                lng: 106.7,
                hours: [{ weekday: 0, is_off: 1 }, { weekday: 1, is_off: 0 }],
                published: 1,
            });
        }
        if (route.startsWith('/api/partner/services')) {
            return withMeta([{ id: 1 }], 4);
        }
        return withMeta([{ id: 2 }], 3);
    }, store);

    await state.loadSetup();
    assert.equal(state.setupDone(), 5);
    assert.equal(state.showSetup(), false);
    // Finished once, remembered per salon: unpublishing later must not bring the block back.
    assert.equal(store.values.get('oak_setup_done_7'), '1');
    // The last step turns into the way to the public page it just switched on.
    assert.equal(state.setupSteps()[4].href, 'salon-profile.html?salon=salon-moi');
});

test('the checklist counts the services a customer can book, not the ones on file', async () => {
    // One service, hidden. The settings page and the server both read the active count,
    // so the dashboard must not tick a row the publish switch will then refuse on.
    const state = dashboard(async (route) => {
        if (route === '/api/partner/salon') {
            return salonRow({ address: '1 Lê Lợi', lat: 10.77, lng: 106.7 });
        }
        if (route.startsWith('/api/partner/services')) {
            return withMeta([{ id: 1 }], 1, 0);
        }
        return withMeta([], 0);
    });

    await state.loadSetup();
    assert.equal(state.setup.services, 0);
    assert.equal(state.setupSteps().find((step) => step.key === 'services').done, false);
});

test('a salon that finished the list once never gets the block back', async () => {
    const store = storage(false);
    store.setItem('oak_setup_done_7', '1');
    const asked = [];
    const state = dashboard(async (route) => {
        asked.push(route);
        if (route === '/api/partner/salon') {
            return salonRow({ address: '1 Lê Lợi', lat: 10.77, lng: 106.7 });
        }
        return withMeta([], 0);
    }, store);

    await state.loadSetup();
    assert.equal(state.setupDone() < 5, true);
    assert.equal(state.showSetup(), false);
    // And it stops paying for a block it will not render: the salon read carries the id
    // the latch is keyed by, so the other two never go out.
    assert.deepEqual(asked, ['/api/partner/salon']);
});

test('storage that throws still renders the checklist', async () => {
    const state = dashboard(async (route) => {
        if (route === '/api/partner/salon') {
            return salonRow({});
        }
        return withMeta([], 0);
    }, storage(true));

    await state.loadSetup();
    assert.equal(state.setupHidden, false);
    assert.equal(state.showSetup(), true);
});

test('a failed read hides the checklist rather than scoring a salon it could not see', async () => {
    const state = dashboard(async () => {
        throw new Error('offline');
    });

    await state.loadSetup();
    assert.equal(state.setup, null);
    assert.equal(state.setupSteps().length, 0);
    assert.equal(state.showSetup(), false);
});

/* ------------------------------------------------------------------ the publish switch */

test('the publish conditions read the saved salon, not the form being typed into', async () => {
    const state = settings(async (route) => {
        if (route === '/api/partner/photos') {
            return [];
        }
        return withMeta([], 0);
    });
    state.original = salonRow({});
    await state.loadPhotos();
    await state.loadServiceCount();
    await state.loadBookableStaff();
    assert.equal(state.publishChecks().every((item) => item.done === false), true);
    assert.equal(state.publishChecks().length, 5);

    // Typing an address into the form must not tick the box the server reads from the row.
    state.form.address = '1 Lê Lợi';
    assert.equal(state.missingToPublish().length, 5);
});

/* The condition the other four hid: everything else can be filled in and the calendar still
   have nothing in it, because an hour is generated by a technician who is on the roster, on
   shift and linked to a live service. The list has to ask for all three, or it ticks its way
   to a salon that publishes itself and shows "không còn giờ trống" for a week. */
test('a technician only ticks the roster condition when she is actually bookable', async () => {
    const roster = (members) =>
        settings(async (route) => {
            if (route === '/api/partner/photos') {
                return [];
            }
            if (route === '/api/partner/staff') {
                return members;
            }
            return withMeta([], 0);
        });
    const staffDone = async (members) => {
        const state = roster(members);
        state.original = salonRow({});
        await state.loadPhotos();
        await state.loadBookableStaff();
        return state.publishChecks().find((item) => item.key === 'staff').done;
    };

    const working = { active: 1, service_ids: [4], shift: null, next_shift: { date: '2026-08-24' } };
    assert.equal(await staffDone([working]), true);
    // On shift today is the other way a week says she works.
    assert.equal(
        await staffDone([{ ...working, shift: { is_off: 0 }, next_shift: null }]),
        true,
    );
    // A roster of one who does nothing, one who works no day, and one who has left.
    assert.equal(await staffDone([{ ...working, service_ids: [] }]), false);
    assert.equal(await staffDone([{ ...working, next_shift: null }]), false);
    assert.equal(await staffDone([{ ...working, active: 0 }]), false);
    assert.equal(await staffDone([]), false);
});

test('a cover photo alone satisfies the picture condition, and a gallery photo does too', async () => {
    const state = settings(async (route) =>
        route === '/api/partner/photos' ? [{ id: 3, image: 'a.webp', sort: 1 }] : withMeta([], 2),
    );
    state.original = salonRow({ image: null });
    await state.loadPhotos();
    await state.loadServiceCount();
    const byKey = Object.fromEntries(state.publishChecks().map((item) => [item.key, item.done]));
    assert.equal(byKey.photo, true);
    assert.equal(byKey.service, true);

    state.photos = [];
    state.original = salonRow({ image: 'bia.jpg' });
    assert.equal(state.publishChecks().find((item) => item.key === 'photo').done, true);
});

test('a hidden service does not tick the row the server refuses on', async () => {
    // The salon has one service on file and none the public side can see: the server
    // requires an active one, so this row must read as outstanding, not done.
    const state = settings(async (route) =>
        route === '/api/partner/photos' ? [] : withMeta([{ id: 1 }], 1, 0),
    );
    state.original = salonRow({});
    await state.loadPhotos();
    await state.loadServiceCount();
    assert.equal(state.serviceCount, 0);
    assert.equal(state.publishChecks().find((item) => item.key === 'service').done, false);
});

test('the settings page re-applies the checklist fragment once the form is on screen', async () => {
    const scrolled = [];
    const state = settings(async () => [], undefined, {
        location: { hash: '#gio-mo-cua' },
        document: {
            getElementById: (id) =>
                id === 'gio-mo-cua' ? { scrollIntoView: () => scrolled.push(id) } : null,
        },
    });

    state.jumpToHash();
    assert.deepEqual(scrolled, ['gio-mo-cua']);

    // Nothing to jump at is an ordinary visit, not an error.
    const plain = settings(async () => [], undefined, {
        location: { hash: '' },
        document: { getElementById: () => null },
    });
    plain.jumpToHash();
});

test('switching on sends published=1 and keeps unsaved form edits', async () => {
    const sent = [];
    const state = settings(async (route, options) => {
        sent.push([route, options]);
        return salonRow({ published: 1 });
    });
    state.original = salonRow({});
    state.form.name = 'Tên đang gõ dở';
    state.published = 0;

    await state.togglePublished();
    assert.equal(sent[0][0], '/api/partner/salon');
    assert.equal(sent[0][1].method, 'PATCH');
    assert.equal(JSON.stringify(sent[0][1].body), JSON.stringify({ published: 1 }));
    assert.equal(state.published, 1);
    assert.equal(state.form.name, 'Tên đang gõ dở');
});

test('a refusal from the server is shown, and the switch stays where it was', async () => {
    const state = settings(async () => {
        throw new Error('Salon chưa đủ điều kiện hiển thị trên OAK: còn thiếu giờ mở cửa.');
    });
    state.original = salonRow({});
    state.published = 0;

    // The browser has already ticked the box by the time the change handler runs, so a
    // refusal has to put it back or the switch would say the salon is listed when it is not.
    const box = { checked: true };
    await state.togglePublished({ target: box });
    assert.match(state.publishError, /giờ mở cửa/);
    assert.equal(state.published, 0);
    assert.equal(box.checked, false);
});

/* ------------------------------------------------------------------- the photo gallery */

test('moving a photo swaps the two positions and refuses to walk off either end', async () => {
    const calls = [];
    const state = settings(async (route, options) => {
        calls.push([route, options]);
        return route === '/api/partner/photos' ? [] : {};
    });
    state.photos = [
        { id: 11, sort: 1 },
        { id: 12, sort: 2 },
    ];

    await state.movePhoto(0, -1);
    assert.equal(calls.length, 0, 'the first photo cannot move earlier');
    await state.movePhoto(1, 1);
    assert.equal(calls.length, 0, 'the last photo cannot move later');

    await state.movePhoto(0, 1);
    assert.equal(
        JSON.stringify(calls.slice(0, 2)),
        JSON.stringify([
            ['/api/partner/photos/11', { method: 'PATCH', body: { sort: 2 } }],
            ['/api/partner/photos/12', { method: 'PATCH', body: { sort: 1 } }],
        ]),
    );
    assert.equal(calls[2][0], '/api/partner/photos');
});

test('a photo swap that only half lands re-reads what the server actually holds', async () => {
    let patches = 0;
    const state = settings(async (route, options) => {
        if (options && options.method === 'PATCH') {
            patches += 1;
            if (patches === 2) {
                throw new Error('Mất kết nối.');
            }
            return {};
        }
        return [{ id: 12, sort: 1 }, { id: 11, sort: 2 }];
    });
    state.photos = [
        { id: 11, sort: 1 },
        { id: 12, sort: 2 },
    ];

    await state.movePhoto(0, 1);
    assert.match(state.photoError, /Mất kết nối/);
    // Not the order the swap was aiming for, but the one the server answers with.
    assert.deepEqual(state.photos.map((photo) => photo.id), [12, 11]);
});

test('deleting a photo re-reads the gallery and reports a failure in place', async () => {
    let deleted = 0;
    const state = settings(async (route, options) => {
        if (options && options.method === 'DELETE') {
            deleted += 1;
            throw new Error('Không tìm thấy ảnh này.');
        }
        return [];
    });
    state.photos = [{ id: 11, sort: 1 }];

    await state.removePhoto(state.photos[0]);
    assert.equal(deleted, 1);
    assert.match(state.photoError, /Không tìm thấy ảnh này/);
    assert.equal(state.photoBusy, false);
});

/* ------------------------------------------------------------------------- the markup */

test('the settings page carries the anchors the checklist links at', () => {
    const html = readUi('cai-dat-salon.html');
    for (const id of ['vi-tri', 'gio-mo-cua', 'hien-thi']) {
        assert.match(html, new RegExp(`id="${id}"`));
    }
    assert.match(html, /Thư viện ảnh/);
    assert.match(html, /multiple type="file"/);
    assert.match(html, /@change="uploadPhotos\(\$event\)"/);
    // The switch cannot be turned on while a condition is outstanding.
    assert.match(html, /missingToPublish\(\)\.length > 0/);
    // …and the deep link is applied again once the form has a box to scroll to.
    assert.match(html, /this\.initMap\(\);\s+this\.jumpToHash\(\);/);
});

test('the reorder arrows only appear on the whole menu, never on a filtered list', async () => {
    const state = services(async () => withMeta([{ id: 1, sort_order: 1 }], 1));
    assert.equal(state.canReorder(), true);

    state.category = 'hair';
    assert.equal(state.canReorder(), false, 'a category tab shows two rows out of the menu');
    state.category = '';
    state.query = '  gội  ';
    assert.equal(state.canReorder(), false, 'a search does the same');
});

test('a service swap that only half lands re-reads the menu the server holds', async () => {
    let patches = 0;
    const state = services(async (route, options) => {
        if (options && options.method === 'PATCH') {
            patches += 1;
            if (patches === 2) {
                throw new Error('Mất kết nối.');
            }
            return {};
        }
        return withMeta([{ id: 2, sort_order: 1 }, { id: 1, sort_order: 2 }], 2);
    });
    state.services = [
        { id: 1, sort_order: 1 },
        { id: 2, sort_order: 2 },
    ];

    await state.moveService(0, 1);
    assert.equal(patches, 2);
    // Whatever landed, the cards now show what the server answers with.
    assert.deepEqual(state.services.map((service) => service.id), [2, 1]);
    assert.equal(state.moving, false);
});

test('the service form offers "giá từ" and the cards can be reordered', () => {
    const html = readUi('quan-ly-dich-vu.html');
    assert.match(html, /x-model="serviceForm\.price_is_from"/);
    assert.match(html, /OAK\.fmtPriceFrom\(service\.price, service\.price_is_from\)/);
    assert.match(html, /moveService\(index, -1\)/);
    assert.match(html, /moveService\(index, 1\)/);
    // Menu order is only meaningful on the whole menu, so a filter puts the arrows away.
    assert.match(html, /x-show="canReorder\(\)"/);
    assert.match(html, /price_is_from: this\.serviceForm\.price_is_from \? 1 : 0/);
});

test('both pages the checklist sends a new salon to open their form on ?new=1', () => {
    for (const page of ['quan-ly-dich-vu.html', 'quan-ly-nhan-vien.html']) {
        assert.match(readUi(page), /if \(OAK\.qs\('new'\)\)/, page);
    }
});

test('the console pages this slice touches carry the Nội dung entry point', () => {
    for (const page of [
        'tong-quan-doi-tac.html',
        'cai-dat-salon.html',
        'quan-ly-dich-vu.html',
        'quan-ly-nhan-vien.html',
    ]) {
        assert.match(readUi(page), /href="blog\.html\?compose=1"/, page);
    }
});

/* The server's own copy of the rule, in the two places it is written: the gate every
   PATCH published=1 runs through, and the boot-time backfill that lifted the salons which
   predate the column. A backfill on weaker terms would list a salon that could not then
   pass its own gate — its owner could not save the settings form at all. */
/* The server's clause is sv.active = 1, and GET /partner/staff deliberately serves links to
   hidden services as well (the roster editor needs them), so the page has to do the
   intersection itself or tick a row the server then refuses to publish on. */
test('a technician linked only to a hidden service does not tick the roster row', async () => {
    const listed = (services, roster) =>
        settings(async (route) => {
            if (route === '/api/partner/photos') {
                return [];
            }
            if (route === '/api/partner/staff') {
                return roster;
            }
            // A fresh array per call: withMeta defines a non-configurable `meta`, so handing
            // the same one back twice throws where the page can only see a failed load.
            return withMeta(
                services.slice(),
                services.length,
                services.filter((service) => service.active === 1).length,
            );
        });
    const staffDone = async (services, roster) => {
        const state = listed(services, roster);
        state.original = salonRow({});
        await state.loadPhotos();
        await state.loadServiceCount();
        await state.loadBookableStaff();
        return state.publishChecks().find((item) => item.key === 'staff').done;
    };
    const working = { active: 1, shift: null, next_shift: { date: '2026-08-24' } };
    const menu = [{ id: 1, active: 1 }, { id: 2, active: 0 }];

    assert.equal(await staffDone(menu, [{ ...working, service_ids: [1] }]), true);
    assert.equal(await staffDone(menu, [{ ...working, service_ids: [2] }]), false);
    assert.equal(await staffDone(menu, [{ ...working, service_ids: [2, 1] }]), true);

    /* Past the endpoint's ceiling this page holds only a first page of the menu, so it stops
       intersecting rather than calling a technician unbookable over a service it cannot see.
       Generous where it cannot be exact: the server still has the last word on publishing. */
    const wholePage = Array.from({ length: 50 }, (unused, index) => ({ id: index + 1, active: 1 }));
    assert.equal(await staffDone(wholePage, [{ ...working, service_ids: [999] }]), true);
});

test('the publish gate and the boot backfill ask the same thing of a roster', () => {
    const readSrc = (...parts) => readServer(parts.join('/'));
    const flat = (text) => text.replace(/\s+/g, ' ');
    const partnerJs = readSrc('routes', 'partner.js');
    const gate = flat(partnerJs.slice(partnerJs.indexOf('const PUBLISH_READINESS_SQL')));
    const dbJs = readSrc('db.js');
    const backfill = flat(dbJs.slice(dbJs.indexOf('UPDATE salons SET published = 1')));

    // The checklist row, in the words both the refusal and the console list use.
    assert.match(
        partnerJs,
        /\['has_bookable_staff', 'ít nhất một kỹ thuật viên có lịch làm việc và dịch vụ'\]/,
    );

    for (const clause of [
        // On the roster,
        'FROM staff st WHERE st.salon_id',
        'AND st.active = 1',
        // working some day of the week,
        'SELECT 1 FROM staff_schedule sch WHERE sch.staff_id = st.id AND sch.is_off = 0',
        // and linked to something the public side can actually book.
        'FROM staff_services ss JOIN services sv2 ON sv2.id = ss.service_id AND sv2.active = 1',
    ]) {
        assert.ok(gate.includes(clause), `the publish gate is missing "${clause}"`);
        assert.ok(backfill.includes(clause), `the boot backfill is missing "${clause}"`);
    }
});
