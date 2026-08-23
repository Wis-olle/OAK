/* Cache-Control for the static site (phase 4, item 4).
 *
 * The rule in app.js splits everything under ui/ three ways, and getting a file into the wrong
 * bucket fails in opposite directions: a page or a bare-name bundle cached for a year ships a
 * deploy that some readers never see, while a hashed asset revalidated on every navigation puts
 * back the ~25 conditional requests the rule exists to remove.
 *
 * So the shipped setHeaders is lifted out and driven over the real tree. The inventory of files
 * that must NOT be cached forever is written out here by hand: a new bundle added to ui/assets
 * without a hash in its name fails this test until somebody decides which bucket it belongs in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import express from 'express';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ui = path.resolve(root, '../ui');
const uploads = path.resolve(root, 'uploads');
/* Newlines normalised because the assertions below match code across line breaks and this repo
   checks out with core.autocrlf=true — a fresh clone lands app.js with CRLF, and a bare \n in a
   pattern would then match nothing, failing a test whose subject is perfectly intact. */
const source = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');
const appJs = source('src', 'app.js');

const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';
const SHORT = 'public, max-age=300';
const NO_STORE = 'no-store';

/* One mount's source, run with a stand-in for express so the options object it is called with
   can be caught. Both markers are code rather than prose, so rewording the comments around them
   cannot change what is under test. */
function setHeaders(open, close, dir, name) {
  const from = appJs.indexOf(open);
  const to = appJs.indexOf(close, from);
  assert.ok(from !== -1 && to > from, `app.js no longer mounts ${name} with a Cache-Control rule`);

  const context = {
    uiDir: ui,
    uploadsDir: uploads,
    caught: null,
    app: { use() {} },
    express: {
      static(served, options) {
        context.caught = { served, options };
      },
    },
  };
  vm.runInNewContext(appJs.slice(from, to), context);

  assert.equal(context.caught.served, dir, `the rule is mounted on some directory other than ${name}`);
  const fn = context.caught.options && context.caught.options.setHeaders;
  assert.equal(typeof fn, 'function', `express.static(${name}) carries no setHeaders`);

  return (filePath) => {
    const headers = {};
    fn({ setHeader: (key, value) => { headers[key] = value; } }, filePath);
    return headers;
  };
}

const uiHeaders = setHeaders('const HASHED_ASSET', '// Anything still unmatched', ui, 'ui/');
const header = (filePath) => uiHeaders(filePath)['Cache-Control'];

const uploaded = setHeaders("app.use(\n  '/uploads'", "app.get('/'", uploads, 'uploads/');

/** Every file the server can hand out, as a path relative to ui/, with '/' separators. */
function tree(dir = ui, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const here = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? tree(path.join(dir, entry.name), here) : [here];
  });
}

const files = tree();

/*
 * Everything under ui/ that does not carry a content hash in its name, and what each one is
 * allowed to be cached as. The pages load the first nine by a bare name, so a new build reuses
 * the name and five minutes is the longest a reader can be left on the old bytes. The images
 * are referenced by bare name from the markup for the same reason — hero-banner.webp among them,
 * which is why the home page's LCP image revalidates while every img-<hash>.jpg beside it does
 * not. The icon subset belongs here and not with the frozen fonts: tools/icons rewrites that one
 * file in place every time icon-names.txt grows (DEPLOY.md §5), so a reader still holding the old
 * bytes would draw the newly added glyph as a blank for as long as the header let them keep it.
 *
 * Editing this map is part of adding or removing a file, not a sign something is wrong: a new
 * asset the pages load by a bare name goes in with SHORT, and a file that stops being a file —
 * sitemap.xml becomes a route under phase-4 item 6 — comes out. Both are one line.
 */
const UNHASHED = {
  'assets/css/oak-fonts.css': SHORT,
  'assets/css/oak-tailwind.css': SHORT,
  'assets/css/oak-utils.css': SHORT,
  'assets/js/oak-api.js': SHORT,
  'assets/js/oak-blog.js': SHORT,
  'assets/js/oak-header.js': SHORT,
  'assets/js/oak-i18n-en.js': SHORT,
  'assets/js/oak-i18n.js': SHORT,
  'assets/js/oak-tailwind-config.js': SHORT,
  'assets/images/beauty-map-face.webp': SHORT,
  'assets/images/beauty-map-hand.webp': SHORT,
  'assets/images/favicon.png': SHORT,
  'assets/images/hero-banner.webp': SHORT,
  // The two the manifest names, under names it names them by: a hash in either would have
  // to be written into manifest.webmanifest by hand every time they were redrawn.
  'assets/images/icon-192.png': SHORT,
  'assets/images/icon-512.png': SHORT,
  'manifest.webmanifest': SHORT,
  'robots.txt': SHORT,
  'sitemap.xml': SHORT,
  'assets/fonts/font-material-subset.woff2': SHORT,
};

test('the three bundles the pages name without a hash go stale within five minutes', () => {
  for (const bundle of ['assets/js/oak-api.js', 'assets/js/oak-i18n.js', 'assets/css/oak-tailwind.css']) {
    assert.ok(files.includes(bundle), `${bundle} is gone — the rule below is describing nothing`);
    assert.equal(header(path.join(ui, ...bundle.split('/'))), SHORT, bundle);
  }
});

test('a page is revalidated on every visit, and the home page with it', () => {
  const pages = files.filter((name) => name.endsWith('.html'));
  assert.ok(pages.length > 30, `only ${pages.length} pages found under ui/`);

  for (const page of pages) {
    assert.equal(header(path.join(ui, ...page.split('/'))), REVALIDATE, page);
  }

  // '/' answers with kham-pha.html through sendFile, which never reaches the static handler.
  assert.match(
    appJs,
    /app\.get\('\/', \(req, res\) => \{\n\s*res\.setHeader\('Cache-Control', 'no-cache'\);/,
    "the home page is served past the static rule without a Cache-Control of its own",
  );
});

test('an uploaded photo is frozen, because its name is a UUID nothing reuses', () => {
  /* The one thing that makes a year safe there: routes/uploads.js builds every stored name out
     of randomUUID(), so no name is ever reused for different bytes. Read off the route rather
     than restated, because the day that changes is the day this header becomes wrong. */
  const route = source('src', 'routes', 'uploads.js');
  assert.ok(
    route.includes('const storedName = `${randomUUID()}${extension}`;'),
    'an uploaded file no longer gets a name nothing else can have — /uploads must stop freezing it',
  );

  const headers = uploaded(path.join(uploads, '9a1f0c3e-59b4-4f7d-8c21-6d0e2b7a4f13.jpg'));
  assert.equal(headers['Cache-Control'], IMMUTABLE);
  assert.equal(
    headers['X-Content-Type-Options'],
    'nosniff',
    'caller-supplied bytes are served without telling the browser to stop guessing at their type',
  );
});

test('an API answer is not stored at all, not even for the Back button', () => {
  /* The third bucket: a page revalidates and an asset is frozen, but a booking, a favourite
     or a notification is nobody's to keep — a shared device would let the next account's Back
     button redraw the previous one's page. Read off app.js like the two rules above, because
     the app itself cannot be imported without a live Postgres. */
  const marker = "app.use('/api', (req, res, next) => {";
  const from = appJs.indexOf(marker);
  assert.ok(from !== -1, 'app.js no longer gives /api a Cache-Control of its own');
  assert.ok(
    from < appJs.indexOf("app.use('/api/uploads'"),
    'the /api rule is mounted below an API route, so that route answers without it',
  );

  const context = {
    caught: null,
    app: { use: (mount, fn) => { context.caught = { mount, fn }; } },
  };
  vm.runInNewContext(appJs.slice(from, appJs.indexOf('});', from) + 3), context);
  assert.equal(context.caught.mount, '/api');

  const headers = {};
  let passed = false;
  context.caught.fn(
    {},
    { setHeader: (key, value) => { headers[key] = value; } },
    () => { passed = true; },
  );
  assert.equal(headers['Cache-Control'], NO_STORE);
  assert.ok(passed, 'the rule never calls next(), so nothing behind it would answer at all');
});

test('every asset is cached forever unless its name is one a new build reuses', () => {
  const unhashed = [];

  for (const name of files) {
    if (name.endsWith('.html')) continue;
    const value = header(path.join(ui, ...name.split('/')));

    if (name in UNHASHED) {
      assert.equal(value, UNHASHED[name], name);
      unhashed.push(name);
      continue;
    }

    assert.equal(
      value,
      IMMUTABLE,
      `${name} is not in the hand-written inventory, so it is being cached for a year — ` +
        'give it a content hash in its name, or add it to UNHASHED with the policy it should have',
    );
  }

  assert.deepEqual(
    unhashed.sort(),
    Object.keys(UNHASHED).sort(),
    'UNHASHED names a file that is no longer in ui/',
  );
});

/* One GET, asked for with a chosen Accept-Encoding, answered with the headers and the byte count
   as they came off the socket — the same thing `curl -I -H 'Accept-Encoding: …'` shows, except it
   runs here instead of against a deploy nobody can reproduce. */
function get(port, urlPath, encoding) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { port, path: urlPath, headers: { 'Accept-Encoding': encoding } },
      (response) => {
        let bytes = 0;
        response.on('data', (chunk) => { bytes += chunk.length; });
        response.on('end', () => resolve({ headers: response.headers, bytes }));
      },
    );
    request.on('error', reject);
  });
}

test('the site answers a text asset compressed, and app.js is where that happens', async () => {
  /* Half of the claim is that the middleware is mounted above everything it has to cover — put it
     below a static mount and that mount's files go out raw. Read off the source, because the app
     itself cannot be imported without a live Postgres (db.js queries at module scope). */
  assert.match(appJs, /^import compression from 'compression';$/m);
  const mounted = appJs.indexOf('app.use(compression());');
  assert.ok(mounted !== -1, 'app.js no longer mounts the compression middleware');
  assert.ok(
    mounted < appJs.indexOf("app.use(\n  '/uploads'"),
    'compression is mounted below the uploads static mount, so uploaded files skip it',
  );
  assert.ok(
    mounted < appJs.indexOf('express.static(uiDir'),
    'compression is mounted below the ui/ static mount, so every page and bundle goes out raw',
  );
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies.compression, 'compression is not a declared dependency — a clean install would not have it');

  /* The other half is that it actually shrinks this repo's own bytes. Same two lines as app.js,
     over the real ui/ tree, so the numbers below are the site's and not a fixture's. */
  const probe = express();
  probe.use(compression());
  probe.use(express.static(ui));
  const server = probe.listen(0);
  await once(server, 'listening');

  try {
    const { port } = server.address();
    const asset = '/assets/css/oak-tailwind.css';

    const compressed = await get(port, asset, 'gzip, deflate, br');
    assert.ok(
      ['br', 'gzip'].includes(compressed.headers['content-encoding']),
      `${asset} came back as '${compressed.headers['content-encoding']}' — the acceptance criterion is br or gzip`,
    );

    const raw = await get(port, asset, 'identity');
    assert.equal(raw.headers['content-encoding'], undefined);
    assert.ok(
      compressed.bytes * 2 < raw.bytes,
      `${asset}: ${compressed.bytes} B compressed vs ${raw.bytes} B raw — less than half the saving expected`,
    );

    // An image is already compressed; running deflate over it again would cost CPU for nothing.
    const image = await get(port, '/assets/images/hero-banner.webp', 'gzip, deflate, br');
    assert.equal(image.headers['content-encoding'], undefined, 'a webp is being compressed a second time');
  } finally {
    server.close();
    await once(server, 'close');
  }
});
