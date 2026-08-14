/* `npm run check:css` — fails if ui/assets/css/oak-tailwind.css is stale.
   Rebuilds into a temp file and compares; nothing on disk in ui/ is touched. */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const committed = path.join(__dirname, '../../ui/assets/css/oak-tailwind.css');
const temp = path.join(os.tmpdir(), 'oak-tailwind.check.css');

execFileSync(process.execPath, [
    path.join(__dirname, 'node_modules/tailwindcss/lib/cli.js'),
    '-c', path.join(__dirname, 'tailwind.build.config.js'),
    '-i', path.join(__dirname, 'tailwind.input.css'),
    '-o', temp,
    '--minify',
], { stdio: 'inherit' });

const fresh = fs.readFileSync(temp);
const shipped = fs.readFileSync(committed);
fs.unlinkSync(temp);

if (!fresh.equals(shipped)) {
    console.error(
        `\nui/assets/css/oak-tailwind.css is STALE (${shipped.length} bytes committed, ${fresh.length} bytes rebuilt).\n` +
        'Run `npm run build:css` in tools/tailwind and commit the result.'
    );
    process.exit(1);
}

console.log('\nui/assets/css/oak-tailwind.css is up to date.');
