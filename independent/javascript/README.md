# Independent JavaScript canonicalizer

This is a second, independent implementation of HTMLTrust canonicalization,
written directly from the specification text
(`htmltrust-spec/ietf-draft/draft-grey-htmltrust-00.md`, sections 4-6) and
from `conformance/PROTOCOL.md`. It does not import anything from
`javascript/` (the project's WASM binding over the Rust core), `rust/`, or
`ffi/`. Every reading of an ambiguous spec sentence was decided and
written down before this implementation was ever run against the
fixtures, then checked against them afterward.

**This is a differential-testing oracle, maintained to disagree with the
Rust core.** Its only purpose is to be a second opinion: if this
implementation and the Rust core ever produce different output for the
same input, that disagreement is a signal worth investigating, in either
direction. It has no key handling, no signature verification, and no
resource-limit tuning beyond what the conformance fixtures require, so it
has no production use signing or verifying real content.

An adversarial review of the first version of this implementation (130
fixtures) confirmed 31 findings and concluded the implementation is
genuinely independent of both the Rust core and the prior JavaScript port
it replaced. Nine were divergences where this oracle accepted input the
Rust core rejects; all nine are fixed, and the fixture set grew from 130
to 145 to hold each fix in place. The sections below describe both the
fixes and the four spec-text ambiguities the review confirmed, all now
resolved in the draft itself (see the draft's changelog, or search it for
`normalize_field`).

## What passes

Both runners pass all 145 conformance fixtures across all four suites:

| Suite | Passed | Runner(s) verified |
|---|---|---|
| `normalize` | 25 / 25 | Node, browser |
| `extract` | 77 / 77 | Node, browser |
| `claims` | 18 / 18 | Node, browser |
| `jcs` | 25 / 25 | Node, browser |
| **Total** | **145 / 145** | |

Verified independently for each runner (see "Running the tests" below);
the browser figure was observed via headless Chromium
(`/home/jason/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome
--headless --no-sandbox --virtual-time-budget=20000 --dump-dom`, not
assumed from the Node result). Also verified against the Rust core and
the Go and Python bindings via `conformance/run-all.sh` (see
"Cross-checking against the Rust core" below); PHP is not installed on
the machine this was verified on.

No fixture required editing (only new ones added), and none was skipped.

## Fixed since the first review

An adversarial review ran both this implementation and the Rust core on
probe inputs beyond the fixture set and found nine confirmed divergences,
all in `lib/portable-profile.js` or the browser adapter. Each is fixed,
and each got at least one new fixture (`conformance/fixtures/`) so a
future change can't reintroduce it silently:

1. **Character references inside attribute values were never
   validated.** `scanAttributes` used to find a quoted value's end with a
   plain `indexOf`, so `alt="&copy 2024"` (a legacy, unterminated
   reference) was accepted when the identical reference in text content
   was correctly rejected. `scanCharacterReference` now runs over quoted
   and unquoted attribute values too, carrying the one HTML Standard
   exception that is specific to attributes: a legacy match immediately
   followed by `=` or an alphanumeric is literal text, not an error (so
   `?a=1&copy=2` in an `href` stays literal). Fixtures:
   `parser-attribute-unterminated-reference`,
   `parser-attribute-historical-reference-literal`.

2. **RCDATA content (`<textarea>`, `<title>`) skipped character-reference
   validation.** It was lumped in with RAWTEXT (`<script>`, `<style>`,
   ...), whose content the tokenizer never decodes at all. RCDATA
   content, per the HTML Standard, *does* decode references, so
   `<textarea>a &amp b</textarea>` was silently accepted with parse5's
   repaired decoding. `RAWTEXT_ELEMENTS` and `RCDATA_ELEMENTS` are now
   separate sets; RCDATA content routes `&` through
   `scanCharacterReference` while still only recognizing its own closing
   tag. Fixtures: `parser-rcdata-unterminated-reference`,
   `rcdata-text-included`.

3. **Explicitly-closed but misnested or foster-parented elements were
   accepted.** The open-element stack only checked that an end tag
   matched the top of the stack; it had no model of the cases where
   HTML5 tree construction moves or implicitly closes an element even
   though the source's tags are syntactically paired: `<table><p>x</p>
   ...</table>` (foster parenting), `<p><div>x</div></p>` (a block start
   tag implicitly closes an open `<p>`), `<p><a>...<a>...</a></a></p>`
   (nested `<a>`, adoption agency), `<h1><h2>...` (a heading implicitly
   closes an open heading), and a bare `<td>` with no enclosing
   `<table>`. `handleTag` now checks all five before pushing a new
   element, using the HTML5 "in table" and "in body" insertion-mode
   rules those cases come from (not parse5's `onParseError`, which has
   no browser equivalent -- the whole point of this scanner is one
   validator both runners share). Fixtures:
   `parser-table-foster-parented-element`, `parser-block-inside-paragraph`,
   `parser-nested-anchor`.

4. **An unknown named reference (`&foo;`) and a digitless numeric
   reference (`&#;`, `&#x;`) were accepted.** Both are real WHATWG parse
   errors (unknown-named-character-reference and absence-of-digits-in-
   numeric-character-reference); the scanner treated "no table match" as
   always silent, which is only correct when no semicolon follows.
   `scanCharacterReference` now rejects a semicolon-terminated run that
   matches nothing in the entity table, and rejects `&#`/`&#x` with zero
   digits outright. This also caught a related, previously out-of-scope
   gap once the fix was in place: a numeric reference that *is*
   digits-then-`;` but decodes to a rejected code point (null, above
   U+10FFFF, a surrogate, a noncharacter, or a C0/C1 control other than
   tab/LF/FF/CR) -- draft section 4.1's prose describes decoding these
   (to U+FFFD, or through windows-1252), but the reference implementation
   rejects all of them, and this profile now follows that. Fixtures:
   `parser-unknown-named-reference`, `parser-numeric-reference-null`,
   `parser-numeric-reference-c1`.

5. **The browser adapter parsed a full document, not a fragment.**
   `DOMParser.parseFromString(html, 'text/html')` parses `html` as a
   complete document, so a leading `<title>` or `<base>` -- neither
   excluded per section 4.3.1 -- was inserted into a synthesized `<head>`
   and never reached `extract()`'s walk, while the Node adapter (parse5's
   default fragment context is `<template>`) and the Rust core both keep
   it in place. `adapters/browser-domparser.js` now parses via a detached
   `<template>` element's `innerHTML` setter, the standard's fragment-
   context parsing entry point, matching parse5. Fixture:
   `title-in-body-included`.

Two more fixes came out of applying the spec-ambiguity resolutions below
to this implementation, not from the divergence list itself, since both
ambiguities turned out to have a JS-oracle-side bug once resolved:

6. **`alt`/`aria-label` were not trimmed; the standalone `normalize` suite
   was.** Both were backwards relative to the Rust core (see ambiguity 1
   below). `extract.js` now trims `alt`/`aria-label` (via
   `normalizeStandaloneText`); `canonicalize.js`'s `normalizeChecked`
   (the `normalize` suite's entry point) now calls untrimmed
   `normalizeText`. Fixtures: `attr-alt-trimmed`, `leading-trailing-space`,
   `claims/name-and-value-trimmed` (this one already passed --
   claim fields were already trimmed correctly -- and is there so the
   choice stays enforced).

## Running the tests

### Node (parse5)

```sh
cd independent/javascript
npm install
python3 ../../conformance/run-external.py --verify-fixtures -v -- \
  node ./conformance-runner.mjs
```

`npm test`-style shortcut: `npm run conformance` (defined in
`package.json`) runs the same command.

### Browser (a detached `<template>`'s HTML parser)

The page fetches fixtures over HTTP, so it needs a real server (not a
`file://` URL) rooted at the repository root, so that its relative fetches
to `../../conformance/...` resolve:

```sh
cd htmltrust-canonicalization   # repository root
python3 -m http.server 8000
```

Then open `http://localhost:8000/independent/javascript/browser-runner.html`
in any browser. It runs all 145 fixtures on load (hashing every fixture
body with `crypto.subtle` against `fixtures.sha256` first) and renders a
pass/fail table plus a full list of any failing fixture with the expected
and actual output. `document.title` is set to
`PASS 145/145 -- browser conformance` (or `FAIL n/145 -- ...`) once
finished, so headless tooling can read the result without scraping the
body. **The dump must wait for the page's fetch loop to finish, or it
captures the static "Loading fixtures…" state**: pass
`--virtual-time-budget`, generously (145 fixtures fetched serially is
comfortably done within 5 seconds on this machine; the budget below
leaves headroom):

```sh
CHROME=/home/jason/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome
"$CHROME" --headless --no-sandbox --virtual-time-budget=20000 --dump-dom \
  "http://localhost:8000/independent/javascript/browser-runner.html" \
  | grep -o '<title>[^<]*</title>'
```

### Cross-checking against the Rust core

`conformance/run-all.sh` runs every language's runner, including this
one, against the same fixtures. It needs a built native library and WASM
package:

```sh
cd htmltrust-canonicalization   # repository root
export HTMLTRUST_SHARED_CORE_ARTIFACTS=~/tmp/htmltrust-canon-artifacts
bash scripts/build-shared-core-artifacts.sh   # needs cargo, wasm-bindgen-cli, cc
export HTMLTRUST_RUST_CORE_LIB="$HTMLTRUST_SHARED_CORE_ARTIFACTS/libhtmltrust_canonicalization_ffi.so"
export HTMLTRUST_WASM_PKG="$HTMLTRUST_SHARED_CORE_ARTIFACTS/wasm-node/htmltrust_canonicalization_ffi.js"
bash conformance/run-all.sh
```

`wasm-bindgen-cli` must match the `wasm-bindgen` crate version in
`ffi/Cargo.lock` exactly (`cargo install wasm-bindgen-cli --version
<that version> --locked`) or the build fails outright rather than
producing a mismatched artifact.

## How it is independent

- **No shared parser.** Node uses `parse5` (a from-scratch WHATWG HTML5
  parser, independent of `html5ever`, the Rust core's parser); the browser
  uses its own HTML parser via a detached `<template>` element (fragment
  context, matching parse5's default -- see "Fixed since the first
  review", item 5, for why that specific entry point matters).
  `canonicalize.js` never imports either directly -- it takes a
  `parseFragment` function from a small adapter (`adapters/node-parse5.mjs`
  or `adapters/browser-domparser.js`), so the same tree-walk and
  normalization code runs unmodified on two unrelated parser
  implementations.
- **No shared portable-profile validator.** The hardest part of section
  4.1.1 is that a real HTML5 parser *silently repairs* the malformed input
  the profile has to reject (foster-parented table text, unclosed
  elements, duplicate attributes, ...), so neither parse5's nor a
  browser's resulting DOM carries any trace of what was wrong. Rather than
  special-case each engine's error-reporting API (parse5 exposes an
  `onParseError` hook; browsers expose nothing at all -- and this
  project's own production package does lean on parse5's `onParseError`
  for its portable-profile lint, in `javascript/portable-authoring.js`;
  this implementation deliberately does not reuse that approach, or share
  any code with it), this implementation has one hand-rolled scanner
  (`lib/portable-profile.js`), modeled directly on the WHATWG tokenizer
  states named in the spec, that runs identically in Node and the browser
  and rejects before either real parser ever sees the input. See that
  file's header comment for the reasoning and its documented scope limits.
- **No shared data beyond what the standard itself fixes.** Unicode NFKC
  comes from the JS engine's own `String.prototype.normalize`, ECMAScript
  number-to-string formatting (which RFC 8785 mandates verbatim) comes
  from the JS engine's own `Number` coercion, and URL parsing/serialization
  comes from the JS engine's own `URL` class (a WHATWG URL Standard
  implementation). `lib/entities-data.js` is a direct machine-readable
  fetch of `https://html.spec.whatwg.org/entities.json`, the HTML
  Standard's own named-character-reference table; it is used only inside
  the portable-profile scanner, to recognize a legacy no-semicolon entity
  name that has been followed by more text, or an unknown but
  semicolon-terminated name, not to decode entities -- decoding is left
  entirely to parse5/DOMParser.

## Spec ambiguities found (now resolved in the draft)

An adversarial review confirmed all four ambiguities below and wrote
replacement text for each, now applied to
`draft-grey-htmltrust-00.md`. They are kept here, historically, because
the reasoning is still useful context for why this implementation is
shaped the way it is; each entry now also says how the draft settled it.

1. **Two different meanings of "text normalization" trimming -- wider
   than first found.** Section 4.4.3 said "Leading and trailing
   whitespace within each block ... MUST be removed", but section 4.4's
   four-phase `normalize_text` procedure is reused, by reference, for
   several fields without saying which trim. The review found this
   implementation had gotten the split backwards in two places invisible
   to the 130-fixture set: `alt`/`aria-label` (section 4.3.2) needed
   trimming and didn't get it, and the standalone `normalize` suite
   needed to NOT trim and did (both confirmed against the Rust core; see
   "Fixed since the first review", item 6). The draft now defines
   `normalize_field(s)` as `normalize_text(s)` with leading/trailing
   U+0020 removed, states `normalize_text` performs no trimming at all,
   and cites `normalize_field` at every field that trims: `alt`/
   `aria-label`, and claim name/content. Per-node extraction and the
   `normalize` suite both use plain `normalize_text`. This implementation
   matches: `normalizeStandaloneText()` is this draft's `normalize_field`
   (used for `alt`/`aria-label` and claim fields);
   `normalizeChecked()` (the `normalize` suite entry point) and
   per-node extraction use plain `normalizeText()`.

2. **Section 4.1.1's rejection list was not exhaustive.** The prose named
   six categories, but the fixture set also rejected raw C0/C1 control
   characters and a non-void element's self-closing flag, neither of
   which was in that list. The draft now states the rule in two parts: no
   input for which the HTML Standard's tokenizer or tree construction
   reports a parse error (the six categories are now explicitly examples,
   not a closed list), plus a short list of profile-specific
   restrictions that are not HTML parse errors at all (omitting the end
   tag of any non-void element, including ones the HTML Standard makes
   optional; the foreign-content name check in ambiguity 3; the
   character-reference rule in ambiguity 4). This implementation does not
   claim to model the *first* part in full generality -- the review found
   real WHATWG parse errors it still accepts (an unquoted attribute value
   containing a stray quote, a DOCTYPE mid-fragment, a bare `<` followed
   by whitespace); see `lib/portable-profile.js`'s header comment for the
   list. It does model the second part, including the specific
   optional-end-tag cases a fixture pins
   (`parser-optional-end-tag-omitted`: `<ul><li>a<li>b</ul>`, rejected
   even though tag omission is not itself an HTML parse error).

3. **Foreign-content rejection is by tag name, not namespace.** A bare
   `<foreignObject>` (no enclosing `<svg>`) is rejected even though a
   real HTML5 parser would not treat it as foreign content there at all.
   The draft now says so explicitly: a start tag whose ASCII-lowercased
   name is `svg`, `math`, or `foreignobject` is rejected wherever it
   appears, checked on the source tag name rather than the element's
   namespace after tree construction. `math` was this implementation's
   own inference by analogy with `svg` (no fixture forced it); the draft
   confirms it as intentional.

4. **"Ambiguous character reference" now has one definition, on source
   bytes, for text and attribute values alike -- and it is stricter than
   plain WHATWG.** This implementation's finding that `&notit;` and
   `&amp B` are the same tokenizer condition (a legacy no-semicolon match
   that isn't terminated) was correct as far as it went, but the review
   found the reference implementation rejects more than that: a bare
   `&name` with no table match and no semicolon is fine in WHATWG HTML
   (`AT&T`) but was being rejected by the Rust core (a Rust bug, not a
   spec question -- left as-is here, see "Disagreements" below); more
   relevantly, a numeric reference that decodes to U+0000, above
   U+10FFFF, a surrogate, a noncharacter, or most C0/C1 controls is
   rejected by Rust even though draft section 4.1 described decoding
   those forms. The draft's Section 4.1.1 now gives one rule covering
   both text and attribute values: a named reference must be a
   semicolon-terminated table entry (case-sensitive), and a numeric
   reference must decode to a value outside all of the rejected
   categories above; the HTML Standard's attribute-value exception for a
   legacy match followed by `=` or an alphanumeric is kept (this
   implementation already had it right there -- see "Fixed since the
   first review", item 1). This implementation's numeric-reference-value
   rejection is new; see item 4 there.

## Known scope limits (not fixture failures)

`lib/portable-profile.js`'s header comment documents these, but they are
also worth surfacing here since they are gaps relative to full HTML5
tokenizer fidelity, not just implementation shortcuts:

- The open-element stack requires an exact, explicit end tag for every
  non-void element, and models only the specific implicit-closing cases
  ambiguity 2 above pins with a fixture (p-closing block starts, nested
  `<a>`, nested headings, table-structure elements outside a table, table
  foster parenting). The full HTML5 optional-end-tag list (`dt`/`dd`,
  `option`, `colgroup`, and a few others) still requires an explicit end
  tag here even though the HTML Standard permits omitting it; content
  relying on tag omission in one of the unmodeled cases would be
  over-rejected as "unclosed" by this implementation, even though a real
  browser accepts it.
- The wider set of WHATWG tokenizer parse errors ambiguity 2 above
  describes (an unquoted attribute value containing a stray quote, a
  DOCTYPE appearing mid-fragment, a bare `<` followed by whitespace, an
  end tag carrying attributes or a trailing solidus) is not modeled.
  Implementing the full parse-error set is a larger, separate piece of
  work.

## Disagreements

One review finding is a bug in the Rust core, not in this
implementation, and is not fixed here: `<p>AT&T rocks</p>` is accepted by
this implementation (matching the HTML Standard -- `&T` matches no
character-reference table entry and is not semicolon-terminated, so it
is the silent "ambiguous ampersand" case, not a parse error) and rejected
by the Rust core's source preflight, which treats any `&` followed by an
alphanumeric as needing a terminating `;` regardless of whether it
matched anything. Fixing it is a Rust-core change outside this PR's
scope; no fixture was added for it; `AT&T rocks`-shaped content is common
enough in real prose that it is worth a look.

## Layout

```
canonicalize.js            entry point: extract(), normalizeText(),
                            canonicalizeClaims(), canonicalizeJCS()
lib/text-normalize.js       section 4.4, plain-text normalization
lib/portable-profile.js     section 4.1.1, portable-parser-profile scanner
lib/url-policy.js           section 5.2, htmltrust-safe-url-v1
lib/extract.js              sections 4.1-4.5, walk and block structure
lib/claims.js               section 4.6, canonical claims
lib/jcs.js                  RFC 8785, JSON Canonicalization Scheme
lib/entities-data.js        HTML Standard named-character-reference names
lib/errors.js               HTMLTrustError and small shared helpers
adapters/node-parse5.mjs    parse5 -> generic tree, for Node
adapters/browser-domparser.js  browser HTML parser -> generic tree
conformance-runner.mjs      PROTOCOL.md JSON-Lines runner (Node)
browser-runner.html         fixture runner using the browser's own parser
```
