# tools/i18n — the English dictionary

The site ships Vietnamese markup. English is produced in the browser by
`ui/assets/js/oak-i18n.js`, which looks every string up in `ui/assets/js/oak-i18n-en.js` —
a generated file. Edit the parts, not the generated file.

```
tools/i18n/parts/*.json   hand-written, one file per page (+ _chrome.json for header/footer)
        |  node tools/i18n/build.js
        v
ui/assets/js/oak-i18n-en.js   window.OAK_I18N_EN = { "vi": "en", ... }
```

## How the dictionary reaches the browser

The generated file is the largest script the site ships and only an English reader has any use
for it, so no page loads it with a plain `<script src>`. Each one carries the same short inline
loader instead: it reads `oak_lang` out of `localStorage` behind the same `try`/`catch`
`oak-i18n.js` uses, and `document.write`s the tag only when the answer is `en`.

`document.write` rather than anything tidier because the tag has to land *before*
`oak-i18n.js`, and neither script may be deferred (the reason is at the top of `oak-i18n.js`).
Written during parsing, that is what `document.write` guarantees and an injected element does
not. For a Vietnamese reader nothing is fetched at all and `DICTIONARY` is `{}` — the ordinary
state of that reader, not a failure.

The loader is copied markup rather than a file, so it can drift. It must stay **byte-identical
on every page**; `server/test/i18n-loader-ui.test.mjs` compares the digest of every copy and
fails on the first one that differs, on a page that carries the engine without it, and on any
page that goes back to loading the dictionary unconditionally.

## Adding or changing a translation

1. Edit (or add) a part under `parts/`. A part is a flat JSON object, UTF-8, mapping the
   Vietnamese string to its English:

   ```json
   { "Đặt lịch ngay": "Book now" }
   ```

   The key is the string **with its whitespace collapsed** — `text.replace(/\s+/g, ' ').trim()`
   — because that is the key `oak-i18n.js` builds from each text node. One key per text node:
   markup inside a paragraph (a `<br>`, a `<strong>`) splits it into several.

2. `node tools/i18n/build.js` and commit the regenerated `ui/assets/js/oak-i18n-en.js`
   together with the part.

Parts are merged in sorted filename order, so a page part overrides `_chrome.json` on a key
both define. That is intentional — a page may need its own wording — but the build warns
whenever two parts disagree, so an accidental override is visible.

## Page-scoped keys

The dictionary is flat, so one Vietnamese string gets one English string everywhere. When two
pages need different English for the same words, prefix the key with the page file name and
`::`:

```json
{
  "Lịch hẹn": "Appointments",
  "xac-nhan-dat-lich.html::Lịch hẹn": "Appointment"
}
```

`oak-i18n.js` tries `<page>::<key>` before the bare `<key>`, where `<page>` is the last
segment of `location.pathname`. Keep the scoped entry in that page's own part.

**The shared chrome never sees a scoped key.** A node inside `header`, `footer` or the partner
console's `body > nav` resolves through the bare key only. That chrome is the same markup on
all 37 pages, so it must read the same on all of them: without the exemption, a scoped entry a
page needed for its own copy would relabel the header CTA, which is exactly what
`xac-nhan-dat-lich.html::Đặt lịch` did to "Book now". Everything else counts as content,
including the account sidebar of `lich-hen-cua-toi.html` (an `<aside>` inside `<main>`) and the
consent line of `dang-nhap-doi-tac.html`.

Two limits worth knowing. The mechanism separates pages, not places within a page — if the
same string needs two readings in the *content* of one page, the dictionary cannot tell them
apart and the markup has to. And a page's `<title>` is resolved without a node, so scoped
entries do apply to it.

## Checking what is left

```
node tools/i18n/check-coverage.js
```

Advisory, never fails: it lists every Vietnamese string in a wired page that no part covers,
i.e. everything that would stay Vietnamese on the English site. It is a text scan, so strings
a page builds in JavaScript are invisible to it and a few of its hits are markup rather than
copy.

It reads a page's `<meta name="description">` as well as its visible text, because
`translateHead()` translates that attribute and a sentence nobody sees on screen is otherwise
the easiest kind to leave in Vietnamese. Its `og:` twin is deliberately not scanned: nothing
translates the Open Graph tags, so an entry for one could never be used.

It scans `ui/*.html` plus `ui/assets/js/oak-header.js`, whose string literals hold the whole
customer top bar — copy that is in no page at all, and so had no gate before.

## What is not in the dictionary

`oak-i18n.js` carries a list of regex rules for strings a page assembles around runtime data,
which can never be dictionary keys: the weekday `OAK.fmtDate()` puts in front of a date
("Thứ Hai, 10/08/2026"), a duration next to a count ("60 phút"), a price behind a prefix
("Từ 350.000đ"), a booking code inside a sentence. Add to `RULES` there, not here.

Every rule is tried, in order, on the result of the one before it, so a node can need two
("Nối mi • 60 phút" takes one rule for the pieces and one for the duration).

Two things a new rule has to hold to:

- **It matches a whole node, `^` to `$`.** The rules run on every node the dictionary missed,
  and most of those are the salon's own data — a promotion title, a review, a staff bio. A
  rule anchored on a fragment finds that fragment inside a Vietnamese sentence and leaves half
  of it in English. Anchored on the whole node it can only fire on the shape it was written
  for, and a shape nobody catalogued stays Vietnamese, which is the safe failure.
- **Its English output matches no rule, its own included**, because the observer runs the list
  again over every edit the engine makes.

## Checking the rules

```
node tools/i18n/check-rules.js
```

Exits non-zero on any failure, so it can gate a commit. It loads the real `oak-i18n.js` and
asserts that every rule is anchored `^`…`$` and non-global; that running the rules over their
own output changes nothing; that each rule turns its catalogued input into the expected
English and that no rule lacks a case; that page-scoped keys resolve on their own page, bare
keys everywhere else, and shared chrome never sees a scoped key; and that sweeping every rule
over every string in `server/src/seed.js` changes none of them.

Add a case when you add a rule — the harness fails on a rule no case covers.
