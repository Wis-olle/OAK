/* `node tools/i18n/check-coverage.js` — advisory: lists every Vietnamese string in a wired
   page that the merged dictionary has no entry for, i.e. everything that would stay
   Vietnamese on the English site. It reads tools/i18n/parts/ directly, so it answers whether
   the parts are complete regardless of whether build.js has been run.

   It is a text scan, not a parser: it sees the page the way a reader does (the text between
   tags, plus the attributes ui/assets/js/oak-i18n.js translates — its description among them,
   which a search engine reads rather than a person), which is close enough to the real text
   nodes to be useful and always exits 0. Strings a page builds in JavaScript
   are invisible to it — except the customer top bar, which is nothing but such strings and
   is scanned out of ui/assets/js/oak-header.js at the end. */

const fs = require('fs');
const path = require('path');

const parts = path.join(__dirname, 'parts');
const ui = path.join(__dirname, '../../ui');

const DIACRITICS = /[àảãáạăằẳẵắặâầẩẫấậèẻẽéẹêềểễếệìỉĩíịòỏõóọôồổỗốộơờởỡớợùủũúụưừửữứựỳỷỹýỵđ]/i;
const ATTRIBUTES = /\s(?:placeholder|aria-label|title|alt)="([^"]*)"/g;
/* translateHead() in oak-i18n.js looks up the page description as well as its <title>, and
   that string sits in an attribute of a <meta> that the tag scan below discards along with
   every other tag. The og: twin of the same sentence is left out on purpose: nothing
   translates it, so asking for an entry it can never use would be a gap that cannot close. */
const DESCRIPTION = /<meta\b[^>]*\bname="description"[^>]*>/gi;
const CONTENT = /\bcontent="([^"]*)"/;
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

/** The text a reader sees in a run of markup, plus the attributes oak-i18n.js translates. */
function textOf(markup) {
    // A NUL stands in for every tag, so splitting on it lands on the real text nodes.
    const strings = markup.replace(TAG, '\u0000').split('\u0000').map(key);
    for (const match of markup.matchAll(ATTRIBUTES)) {
        strings.push(key(match[1]));
    }
    return strings;
}

/** The description a page hands a search engine, which oak-i18n.js translates in place. */
function descriptionOf(markup) {
    return (markup.match(DESCRIPTION) || [])
        .map((tag) => tag.match(CONTENT))
        .filter((content) => content !== null)
        .map((content) => key(content[1]));
}

let missing = 0;

/** Report, and count, the strings of one file that no part covers. */
function report(file, strings) {
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

for (const file of fs.readdirSync(ui).filter((name) => name.endsWith('.html')).sort()) {
    const source = fs.readFileSync(path.join(ui, file), 'utf8');
    if (!source.includes('assets/js/oak-i18n.js')) {
        continue;
    }

    const html = source
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<script\b[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[\s\S]*?<\/style>/gi, '');

    report(file, [...textOf(html), ...descriptionOf(html)]);
}

/* The customer top bar is in no page: ui/assets/js/oak-header.js writes it, so its copy sits
   in string literals. Each literal is one fragment of that markup, and a tag may open in one
   fragment and close in another — so the half-tag at either end of a fragment is dropped
   before the markup scan runs, along with any attribute it carried, which has already been
   read for a translatable value of its own. */
const HEADER = 'assets/js/oak-header.js';
const LITERAL = /'((?:[^'\\]|\\.)*)'/g;
const TAG_TAIL = /^[^<>]*>/;
const TAG_HEAD = /<[^<>]*$/;
const ATTRIBUTE = /[\w@:.-]+="[^"]*"/g;

// Comments first: prose apostrophes would otherwise read as string literals of their own.
const header = fs
    .readFileSync(path.join(ui, HEADER), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const headerStrings = [];
for (const match of header.matchAll(LITERAL)) {
    const fragment = match[1].replace(/\\(.)/g, '$1');
    for (const attribute of fragment.matchAll(ATTRIBUTES)) {
        headerStrings.push(key(attribute[1]));
    }
    const markup = fragment.replace(TAG_TAIL, '').replace(TAG_HEAD, '').replace(ATTRIBUTE, '');
    headerStrings.push(...textOf(markup));
}
report(HEADER, headerStrings);

console.log(missing ? `\n${missing} strings without an entry.` : '\nEvery Vietnamese string is covered.');
