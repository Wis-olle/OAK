/* Build-time Tailwind config for ui/assets/css/oak-tailwind.css.
   Replaces the Play CDN runtime JIT that used to compile the same CSS in the browser.

   The design tokens are NOT duplicated here: assets/js/oak-tailwind-config.js stays the
   single source of truth and is evaluated below against a fake `tailwind` global, exactly
   like the browser did.

   The two plugins are the ones the vendored Play CDN bundle baked in unconditionally
   (`plugins: [...formsPlugin, ...containerQueriesPlugin, ...config.plugins]`), so they
   have to stay on for the output to match what the pages were built against —
   @tailwindcss/forms in particular is what assets/css/oak-utils.css compensates for. */

const fs = require('fs');
const path = require('path');

const ui = __dirname.replace(/\\/g, '/');

const tailwind = {};
new Function('tailwind', fs.readFileSync(path.join(__dirname, 'assets/js/oak-tailwind-config.js'), 'utf8'))(tailwind);

module.exports = {
    ...tailwind.config,
    content: [
        `${ui}/*.html`,
        // The only hand-written JS that builds class strings; the vendored bundles
        // (alpine, leaflet, tailwind) are deliberately not scanned.
        `${ui}/assets/js/oak-api.js`,
    ],
    plugins: [
        require('@tailwindcss/forms'),
        require('@tailwindcss/container-queries'),
    ],
};
