/* `node tools/i18n/check-coverage.js` — advisory: lists every Vietnamese string in a wired
   page that the merged dictionary has no entry for, i.e. everything that would stay
   Vietnamese on the English site. It reads tools/i18n/parts/ directly, so it answers whether
   the parts are complete regardless of whether build.js has been run.

   It is a text scan, not a parser: it sees the page the way a reader does (the text between
   tags, plus the attributes ui/assets/js/oak-i18n.js translates), which is close enough to
   the real text nodes to be useful and always exits 0. Strings a page builds in JavaScript
   are invisible to it. */

const fs = require('fs');
const path = require('path');

const parts = path.join(__dirname, 'parts');
const ui = path.join(__dirname, '../../ui');

const DIACRITICS = /[àảãáạăằẳẵắặâầẩẫấậèẻẽéẹêềểễếệìỉĩíịòỏõóọôồổỗốộơờởỡớợùủũúụưừửữứựỳỷỹýỵđ]/i;
const ATTRIBUTES = /\s(?:placeholder|aria-label|title|alt)="([^"]*)"/g;
// Attribute values may hold '>' (Alpine expressions do), so quoted runs are matched first.
const TAG = /<\/?[a-zA-Z!][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/g;
const ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    larr: '←', rarr: '→', mdash: '—', ndash: '–', copy: '©',
};

const dictionary = {};
for (const file of fs.readdirSync(parts).filter((name) => name.endsWith('.json')).sort()) {
    Object.assign(dictionary, JSON.parse(fs.readFileSync(path.join(parts, file), 'utf8')));
}

function decode(text) {
    return text
        .replace(/&#(\d+);/g, (all, code) => String.fromCharCode(Number(code)))
        .replace(/&([a-zA-Z]+);/g, (all, name) => (ENTITIES[name] === undefined ? all : ENTITIES[name]));
}

/** The dictionary key for a string — the same normalisation ui/assets/js/oak-i18n.js uses. */
function key(text) {
    return decode(text).replace(/\s+/g, ' ').trim();
}

let missing = 0;

for (const file of fs.readdirSync(ui).filter((name) => name.endsWith('.html')).sort()) {
    const source = fs.readFileSync(path.join(ui, file), 'utf8');
    if (!source.includes('assets/js/oak-i18n.js')) {
        continue;
    }

    const html = source
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<script\b[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[\s\S]*?<\/style>/gi, '');

    const strings = [];
    // A NUL stands in for every tag, so splitting on it lands on the real text nodes.
    for (const text of html.replace(TAG, '\u0000').split('\u0000')) {
        strings.push(key(text));
    }
    for (const match of html.matchAll(ATTRIBUTES)) {
        strings.push(key(match[1]));
    }

    const unknown = strings.filter((text, index) =>
        text &&
        DIACRITICS.test(text) &&
        dictionary[text] === undefined &&
        strings.indexOf(text) === index);

    if (unknown.length) {
        missing += unknown.length;
        console.log(`\n${file} — ${unknown.length} untranslated`);
        unknown.forEach((text) => console.log(`  ${text}`));
    }
}

console.log(missing ? `\n${missing} strings without an entry.` : '\nEvery Vietnamese string is covered.');
