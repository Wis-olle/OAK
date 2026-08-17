/* `node tools/i18n/build.js` — merges tools/i18n/parts/*.json into the dictionary that
   ui/assets/js/oak-i18n.js reads, ui/assets/js/oak-i18n-en.js. Parts are merged in sorted
   filename order, so a later part wins a key an earlier one already had; that is only ever
   worth knowing about when the two disagree, which is what the warnings below are. */

const fs = require('fs');
const path = require('path');

const parts = path.join(__dirname, 'parts');
const output = path.join(__dirname, '../../ui/assets/js/oak-i18n-en.js');

const files = fs.readdirSync(parts).filter((name) => name.endsWith('.json')).sort();

const dictionary = {};
const from = {};
let conflicts = 0;

for (const file of files) {
    const entries = JSON.parse(fs.readFileSync(path.join(parts, file), 'utf8'));
    for (const [vietnamese, english] of Object.entries(entries)) {
        if (from[vietnamese] !== undefined && dictionary[vietnamese] !== english) {
            conflicts += 1;
            console.warn(
                `conflict: "${vietnamese}"\n` +
                `  ${from[vietnamese]}: "${dictionary[vietnamese]}"\n` +
                `  ${file}: "${english}"  <- kept`
            );
        }
        dictionary[vietnamese] = english;
        from[vietnamese] = file;
    }
}

fs.writeFileSync(
    output,
    `window.OAK_I18N_EN = ${JSON.stringify(dictionary, null, 2)};\n`,
    'utf8'
);

console.log(
    `${Object.keys(dictionary).length} entries from ${files.length} parts -> ` +
    `ui/assets/js/oak-i18n-en.js${conflicts ? ` (${conflicts} conflicts)` : ''}`
);
