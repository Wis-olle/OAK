/* `node tools/i18n/check-rules.js` — the guard on the RULES list in ui/assets/js/oak-i18n.js.
   Exits 1 on any failure, so it can gate a commit; no dependencies, no network.

   The rules run on every text node the dictionary missed, and most of those carry the salon's
   own data — a promotion title, a review, a staff bio. That makes two properties load-bearing,
   and this file asserts both plus the page-scoping behaviour around them:

     1. every rule matches a whole node, `^` to `$`, and no rule is global;
     2. running the rules over their own output changes nothing (the characterData observer
        re-runs them over every edit the engine makes);
     3. each rule turns its catalogued input into the expected English;
     4. a page-scoped key wins on its own page, the bare key wins everywhere else, and shared
        chrome never sees a scoped key;
     5. nothing in server/src/seed.js is altered, and no rule disagrees with the dictionary on
        a string that is both a dictionary key and a composed shape. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const js = path.join(__dirname, '../../ui/assets/js');
const ui = path.join(__dirname, '../../ui');
const seedFile = path.join(__dirname, '../../server/src/seed.js');

/* ---- loading the real engine ------------------------------------------------------------ */

const dictionary = JSON.parse(
    fs.readFileSync(path.join(js, 'oak-i18n-en.js'), 'utf8')
        .replace(/^window\.OAK_I18N_EN = /, '')
        .replace(/;\s*$/, '')
);

const engineSource = fs.readFileSync(path.join(js, 'oak-i18n.js'), 'utf8');

/** The engine as `page` sees it, with its internals handed back rather than re-implemented. */
function load(page) {
    let captured = null;
    const source = engineSource.replace(
        'window.OAKI18N = { lang: lang, set: set, label: label };',
        'window.__probe({ ruled: ruled, lookup: lookup, RULES: RULES });'
    );
    const sandbox = {
        window: { OAK_I18N_EN: dictionary, __probe: (api) => { captured = api; } },
        localStorage: { getItem: () => 'en', setItem: () => {} },
        location: { pathname: '/' + page, reload: () => {} },
        document: {
            documentElement: {},
            readyState: 'loading',
            addEventListener: () => {},
            querySelector: () => null,
            createElement: () => ({
                setAttribute() {}, addEventListener() {}, appendChild() {}, style: {},
            }),
            body: { appendChild: () => {} },
            title: '',
        },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    if (captured === null) {
        throw new Error('oak-i18n.js no longer exposes its internals where this harness patches');
    }
    /* What a node ends up as: null out of ruled() means the engine leaves it alone. */
    captured.en = (text, bare) => {
        const english = captured.ruled(text, bare);
        return english === null ? text : english;
    };
    return captured;
}

const engine = load('kham-pha.html');
const { RULES } = engine;

let failed = 0;
function fail(message) {
    failed += 1;
    console.log(message);
}

/* ---- 3. each rule on its catalogued input ------------------------------------------------ */

const cases = [
    // dates
    ['Thứ Hai, 10/08/2026', 'Monday, 10/08/2026'],
    ['Thứ Ba, 11/08/2026', 'Tuesday, 11/08/2026'],
    ['Thứ Tư, 12/08/2026', 'Wednesday, 12/08/2026'],
    ['Thứ Năm, 13/08/2026', 'Thursday, 13/08/2026'],
    ['Thứ Sáu, 14/08/2026', 'Friday, 14/08/2026'],
    ['Thứ Bảy, 15/08/2026', 'Saturday, 15/08/2026'],
    ['Chủ Nhật, 16/08/2026', 'Sunday, 16/08/2026'],
    // cumulative: the prefix rule and the weekday inside it, on one node
    ['Thành viên từ Thứ Hai, 10/08/2026', 'Member since Monday, 10/08/2026'],
    ['Lịch trống Thứ Sáu, 14/08/2026', 'Available on Friday, 14/08/2026'],
    ['12 Tháng 8, 2026', 'August 12, 2026'],
    ['Tuần 10/08/2026 – 16/08/2026', 'Week of 10/08/2026 – 16/08/2026'],
    ['Ngày mở cửa cần giờ mở sớm hơn giờ đóng: Thứ 2.',
        'An open day needs an opening time earlier than its closing time: Monday.'],
    ['Ngày mở cửa cần giờ mở sớm hơn giờ đóng: Chủ Nhật.',
        'An open day needs an opening time earlier than its closing time: Sunday.'],
    // durations
    ['45 phút', '45 min'],
    ['90 phút trải nghiệm', '90-minute experience'],
    ['Dịch vụ • 90 phút', 'Service • 90 min'],
    // cumulative: the piece lookup, then the duration rule
    ['Nối mi • 60 phút', 'Eyelash extensions • 60 min'],
    ['60 phút • Chăm sóc da', '60 min • Skincare'],
    // relative time
    ['5 phút trước', '5 min ago'],
    ['3 giờ trước', '3 hr ago'],
    ['1 ngày trước', '1 day ago'],
    ['4 ngày trước', '4 days ago'],
    // counts
    ['30 ngày', '30 days'],
    ['1 ngày', '1 day'],
    ['Khoảng thời gian tối đa là 366 ngày.', 'The maximum range is 366 days.'],
    ['5 năm kinh nghiệm', '5 years of experience'],
    ['1 năm kinh nghiệm', '1 year of experience'],
    ['(24 đánh giá)', '(24 reviews)'],
    ['(1 đánh giá)', '(1 review)'],
    ['Dựa trên 24 đánh giá', 'Based on 24 reviews'],
    ['Xem tất cả 24 đánh giá', 'See all 24 reviews'],
    ['/ 5 · 24 đánh giá', '/ 5 · 24 reviews'],
    ['Xem tất cả (18) trong Quản lý lịch hẹn', 'See all 18 in Appointment management'],
    ['5 sao', '5 stars'],
    ['1 sao', '1 star'],
    ['+7 Ảnh', '+7 photos'],
    ['3 lịch sắp tới', '3 upcoming appointments'],
    ['6 ưu đãi đang áp dụng', '6 offers running'],
    ['Bạn có 2 thông báo chưa đọc.', 'You have 2 unread notifications.'],
    ['Tìm thấy 12 salon', 'Found 12 salons'],
    ['Tìm thấy 1 salon', 'Found 1 salon'],
    ['Bình luận (4)', 'Comments (4)'],
    ['Tất cả (12)', 'All (12)'],
    ['Nối mi (3)', 'Eyelash extensions (3)'],
    ['12.5% doanh thu', '12.5% of revenue'],
    // prices
    ['Từ 350.000đ', 'From 350.000đ'],
    ['Giảm 20%', 'Save 20%'],
    ['Giảm 100.000đ', 'Save 100.000đ'],
    // the piece-by-piece lines
    ['Tiêu chí: Chăm sóc da • Quận 1 • dưới 500.000đ',
        'Criteria: Skincare • District 1 • under 500.000đ'],
    ['Tiêu chí: Quận 1', 'Criteria: District 1'],
    // the typed query is the visitor's own words: quoted, and copied across as it stands
    ['Tiêu chí: "cắt tóc nam" • Quận 1 • Đang mở cửa',
        'Criteria: "cắt tóc nam" • District 1 • Open now'],
    // the rating and distance pieces are the filter chips' own labels, so pieced() resolves
    // them straight out of the dictionary rather than needing a rule apiece
    ['Tiêu chí: "cắt tóc" • Quận 1 • Từ 4.5 sao • Trong 3km • Đang mở cửa',
        'Criteria: "cắt tóc" • District 1 • 4.5 stars and up • Within 3km • Open now'],
    ['Tiêu chí: Chăm sóc da • Thứ Hai, 10/08/2026', 'Criteria: Skincare • Monday, 10/08/2026'],
    ['Quận 1 • 2.5km', 'District 1 • 2.5km'],
    ['Quận 1 • từ 350.000đ', 'District 1 • from 350.000đ'],
    ['Quận 1 • 2.5km • từ 350.000đ', 'District 1 • 2.5km • from 350.000đ'],
    // offers
    ['Hạn dùng đến 31/12/2026', 'Valid until 31/12/2026'],
    ['Đến 31/12/2026', 'Until 31/12/2026'],
    ['Giảm 20% • Đến 31/12/2026', 'Save 20% • Until 31/12/2026'],
    ['Giảm 20% • Giảm 100.000đ • Đến 31/12/2026', 'Save 20% • Save 100.000đ • Until 31/12/2026'],
    ['Đã sao chép mã OAK20', 'Copied code OAK20'],
    ['Không sao chép được mã, vui lòng chép thủ công: OAK20',
        'The code could not be copied, please copy it by hand: OAK20'],
    ['Xoá ưu đãi "Chào mừng thành viên mới"?', 'Delete offer "Chào mừng thành viên mới"?'],
    ['Xoá dịch vụ "Gội massage đầu"?', 'Delete service "Gội massage đầu"?'],
    // appointments
    ['Mã đặt chỗ: OAK-2026-0012', 'Booking code: OAK-2026-0012'],
    ['Số điện thoại salon: 0901 234 567', 'Salon phone number: 0901 234 567'],
    ['Bạn chắc chắn muốn hủy lịch hẹn OAK-12? Thao tác này không thể hoàn tác.',
        'Are you sure you want to cancel appointment OAK-12? This cannot be undone.'],
    ['Đã hủy lịch hẹn OAK-12.', 'Appointment OAK-12 cancelled.'],
    ['Đã cập nhật lịch hẹn OAK-12.', 'Appointment OAK-12 updated.'],
    ['Đã tạo lịch hẹn OAK-12.', 'Appointment OAK-12 created.'],
    // partner console
    ['Tới 14:30', 'Until 14:30'],
    ['Kế tiếp 15:00', 'Next 15:00'],
    ['Ngọc Anh (đã nghỉ)', 'Ngọc Anh (inactive)'],
    ['Toạ độ: 10.776, 106.700', 'Coordinates: 10.776, 106.700'],
    // salon profile and packages
    ['Chuyên gia: Ngọc Anh', 'Specialist: Ngọc Anh'],
    ['Xem ảnh: Không gian tiếp đón', 'View photo: Không gian tiếp đón'],
    ['Bản đồ vị trí Lala Nail Studio', 'Map of Lala Nail Studio'],
    ['Những đôi tay tài hoa tại Lala Nail Studio', 'The talented hands at Lala Nail Studio'],
    ['Tại Lala Nail Studio, Quận 1', 'At Lala Nail Studio, District 1'],
    ['14:30 (Kín)', '14:30 (Full)'],
    ['Không tải được salon nổi bật. Network error',
        'Could not load the featured salons. Network error'],
    ['Không tải được salon mới. Network error',
        'Could not load the new salons. Network error'],
    // server data and English output: neither may be touched
    ['Chào mừng thành viên mới - Giảm 20%', 'Chào mừng thành viên mới - Giảm 20%'],
    ['Nhớ mang theo mã đặt chỗ. Vui lòng đến sớm 10 phút.',
        'Nhớ mang theo mã đặt chỗ. Vui lòng đến sớm 10 phút.'],
    ['Chuyên viên nail với 5 năm kinh nghiệm, yêu thích phong cách tối giản.',
        'Chuyên viên nail với 5 năm kinh nghiệm, yêu thích phong cách tối giản.'],
    ['Không gian đẹp, nhân viên nhiệt tình. Mình đã chờ 15 phút nhưng rất đáng.',
        'Không gian đẹp, nhân viên nhiệt tình. Mình đã chờ 15 phút nhưng rất đáng.'],
    ['Tại nhà, dưới 500.000đ', 'Tại nhà, dưới 500.000đ'],
    ['Cước phí 1.000đ/phút.', 'Cước phí 1.000đ/phút.'],
    ['Thời lượng (phút)', 'Thời lượng (phút)'],
    ['Giảm giá', 'Giảm giá'],
    ['Từ 4.0 sao', 'Từ 4.0 sao'],
    ['Book now', 'Book now'],
    ['60 min • Eyelash extensions', '60 min • Eyelash extensions'],
    ['Save 20% • Until 31/12/2026', 'Save 20% • Until 31/12/2026'],
    ['Based on 24 reviews', 'Based on 24 reviews'],
    ['All (12)', 'All (12)'],
];

for (const [input, expected] of cases) {
    const actual = engine.en(input);
    if (actual !== expected) {
        fail(`rule\n  in:   ${input}\n  got:  ${actual}\n  want: ${expected}`);
    }
}

/* ---- 1. anchoring -------------------------------------------------------------------- */

for (const [pattern] of RULES) {
    if (!pattern.source.startsWith('^') || !pattern.source.endsWith('$')) {
        fail(`unanchored rule (must run ^ to $): ${pattern}`);
    }
    if (pattern.global) {
        fail(`global rule (a whole-node rule matches once): ${pattern}`);
    }
}

/* ---- 2. idempotence ------------------------------------------------------------------ */

for (const [input] of cases) {
    const once = engine.en(input);
    const twice = engine.en(once);
    if (once !== twice) {
        fail(`not idempotent\n  in:    ${input}\n  once:  ${once}\n  twice: ${twice}`);
    }
}

/* A dictionary value that is itself a key with a different value would make the piece
   lookups drift on a second pass, which is the same failure by another route. */
for (const [key, value] of Object.entries(dictionary)) {
    if (dictionary[value] !== undefined && dictionary[value] !== value) {
        fail(`dictionary cycle: "${key}" -> "${value}" -> "${dictionary[value]}"`);
    }
}

/* Every rule has to be covered by a case, or the list above rots as the rules change. */
const fired = new Set();
for (const [input] of cases) {
    let text = input;
    RULES.forEach((rule, index) => {
        const next = text.replace(rule[0], rule[1]);
        if (next !== text) {
            fired.add(index);
        }
        text = next;
    });
}
RULES.forEach((rule, index) => {
    if (!fired.has(index)) {
        fail(`rule with no case above: ${rule[0]}`);
    }
});

/* ---- 4. page scope and the chrome exemption ------------------------------------------ */

/* [page, key, English in page content, English in shared chrome] */
const scope = [
    ['xac-nhan-dat-lich.html', 'Đặt lịch', 'Booking', 'Book now'],
    ['xac-nhan-dat-lich.html', 'Lịch hẹn', 'Appointment', 'Appointments'],
    ['xac-nhan-dat-lich.html', 'thành công!', 'confirmed!', 'confirmed!'],
    ['xac-nhan-dat-lich.html', 'đã hủy', 'cancelled', 'cancelled'],
    ['xac-nhan-dat-lich.html', 'đã hoàn thành', 'completed', 'completed'],
    ['ket-qua-tim-kiem.html', 'Đánh giá', 'Rating', 'Reviews'],
    ['lich-hen-cua-toi.html', 'Đánh giá', 'Review', 'Reviews'],
    ['lich-hen-cua-toi.html', 'Ngày', 'Date', 'Day'],
    ['dang-nhap-doi-tac.html', 'Chính sách bảo mật', 'Privacy Policy.', 'Privacy Policy'],
    // The consent line is page content, so the period rides on "Chính sách bảo mật" above and
    // this fragment disappears. The bare entry it falls back to is the one check-coverage.js
    // needs to see the string as covered at all.
    ['dang-nhap-doi-tac.html', 'của chúng tôi.', '', '.'],
    // a page with no scoped entry of its own answers from the bare key either way
    ['kham-pha.html', 'Đặt lịch', 'Book now', 'Book now'],
    ['kham-pha.html', 'Lịch hẹn', 'Appointments', 'Appointments'],
    ['quan-ly-lich-hen.html', 'Ngày', 'Day', 'Day'],
    ['bao-mat.html', 'Chính sách bảo mật', 'Privacy Policy', 'Privacy Policy'],
];

for (const [page, key, content, chrome] of scope) {
    const scoped = load(page);
    if (scoped.lookup(key) !== content) {
        fail(`scope ${page} :: ${key}\n  got:  ${JSON.stringify(scoped.lookup(key))}` +
            `\n  want: ${JSON.stringify(content)}`);
    }
    if (scoped.lookup(key, true) !== chrome) {
        fail(`chrome ${page} :: ${key}\n  got:  ${JSON.stringify(scoped.lookup(key, true))}` +
            `\n  want: ${JSON.stringify(chrome)}`);
    }
}

/* The `bare` flag has to reach the piece lookups too, not just the direct dictionary hit:
   a composed line inside chrome must not pick up a page-scoped piece. */
const pieceScope = load('lich-hen-cua-toi.html');
if (pieceScope.en('Đánh giá (3)') !== 'Review (3)') {
    fail(`scoped piece in content: got ${JSON.stringify(pieceScope.en('Đánh giá (3)'))}`);
}
if (pieceScope.en('Đánh giá (3)', true) !== 'Reviews (3)') {
    fail(`scoped piece leaked into chrome: got ${JSON.stringify(pieceScope.en('Đánh giá (3)', true))}`);
}

/* ---- 5. the sweep over data the rules must never touch -------------------------------- */

const seed = fs.readFileSync(seedFile, 'utf8');
const seedStrings = new Set();
for (const match of seed.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`([^`]*)`/g)) {
    const text = (match[1] ?? match[2] ?? match[3]).replace(/\\n/g, ' ').replace(/\\'/g, "'");
    const key = text.replace(/\s+/g, ' ').trim();
    if (key) {
        seedStrings.add(key);
    }
}

const pages = fs.readdirSync(ui).filter((name) => name.endsWith('.html'));
const engines = pages.map((page) => [page, load(page)]);

for (const text of seedStrings) {
    for (const [page, scoped] of engines) {
        const after = scoped.ruled(text);
        if (after !== null) {
            fail(`seed data altered on ${page}\n  in:  ${text}\n  out: ${after}`);
            break;
        }
    }
}

/* The page copy is the largest sample of Vietnamese prose in the repo. Every string in it is
   a dictionary key, so the engine never reaches the rules with one — but a rule that would
   nonetheless produce a DIFFERENT answer than the dictionary is a rule loose enough to hurt a
   sentence. Agreeing with the dictionary is fine; disagreeing is the failure. */
for (const key of Object.keys(dictionary)) {
    if (key.includes('::') || seedStrings.has(key)) {
        continue;
    }
    for (const [page, scoped] of engines) {
        const after = scoped.ruled(key);
        if (after !== null && after !== dictionary[key]) {
            fail(`rule disagrees with the dictionary on ${page}\n  in:   ${key}` +
                `\n  rule: ${after}\n  dict: ${dictionary[key]}`);
            break;
        }
    }
}

/* ---- verdict -------------------------------------------------------------------------- */

if (failed) {
    console.log(`\n${failed} failures.`);
    process.exit(1);
}
console.log(
    `${cases.length} rule cases, ${RULES.length} rules, ${scope.length} pages scoped, ` +
    `${seedStrings.size} seed strings, ${Object.keys(dictionary).length} dictionary entries` +
    ' — all pass.'
);
