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

## What passes

Both runners pass all 130 conformance fixtures across all four suites, as
of the commit that added this directory:

| Suite | Passed | Runner(s) verified |
|---|---|---|
| `normalize` | 24 / 24 | Node, browser |
| `extract` | 64 / 64 | Node, browser |
| `claims` | 17 / 17 | Node, browser |
| `jcs` | 25 / 25 | Node, browser |
| **Total** | **130 / 130** | |

Verified independently for each runner (see "Running the tests" below);
the browser figure was observed via headless Chromium
(`/home/jason/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome
--headless --no-sandbox --dump-dom`), not assumed from the Node result.

No fixture required editing, and none was skipped. There is currently
nothing to report as a fixture-level implementation bug.

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

### Browser (DOMParser)

The page fetches fixtures over HTTP, so it needs a real server (not a
`file://` URL) rooted at the repository root, so that its relative fetches
to `../../conformance/...` resolve:

```sh
cd htmltrust-canonicalization   # repository root
python3 -m http.server 8000
```

Then open `http://localhost:8000/independent/javascript/browser-runner.html`
in any browser. It runs all 130 fixtures on load and renders a pass/fail
table plus a full list of any failing fixture with the expected and actual
output. `document.title` is set to `PASS 130/130 -- browser conformance` (or
`FAIL n/130 -- ...`) once finished, so headless tooling can read the result
without scraping the body:

```sh
CHROME=/home/jason/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome
"$CHROME" --headless --no-sandbox --dump-dom \
  "http://localhost:8000/independent/javascript/browser-runner.html" \
  | grep -o '<title>[^<]*</title>'
```

## How it is independent

- **No shared parser.** Node uses `parse5` (a from-scratch WHATWG HTML5
  parser, independent of `html5ever`, the Rust core's parser); the browser
  uses the engine's own `DOMParser`. `canonicalize.js` never imports either
  directly -- it takes a `parseFragment` function from a small adapter
  (`adapters/node-parse5.mjs` or `adapters/browser-domparser.js`), so the
  same tree-walk and normalization code runs unmodified on two unrelated
  parser implementations.
- **No shared portable-profile validator.** The hardest part of section
  4.1.1 is that a real HTML5 parser *silently repairs* the malformed input
  the profile has to reject (foster-parented table text, unclosed
  elements, duplicate attributes, ...), so neither parse5's nor a
  browser's resulting DOM carries any trace of what was wrong. Rather than
  special-case each engine's error-reporting API (parse5 exposes an
  `onParseError` hook; browsers expose nothing at all), this
  implementation has one hand-rolled scanner
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
  name that has been followed by more text (the "ambiguous reference" and
  "unterminated reference" fixtures), not to decode entities -- decoding
  is left entirely to parse5/DOMParser.

## Ambiguities found while implementing from spec text

The fixtures ultimately confirmed one reading in every case below, so
none of these caused a fixture failure. They are recorded here because
the spec prose alone did not settle them, and a future reader of the
draft (or a sixth implementation) will hit the same gap.

1. **Two different meanings of "text normalization" trimming.** Section
   4.4.3 says "Leading and trailing whitespace within each block ...
   MUST be removed", but section 4.4's four-phase `normalize_text`
   procedure (which the `normalize` conformance suite calls "the text
   after the eight normalization phases") is also used, per section 4.6,
   as the whole of claim-name/claim-value processing, and per section
   4.2, per Text node during extraction. Those three call sites cannot
   share one trimming rule: trimming every text node's leading/trailing
   space during extraction breaks `hello ` + `<em>world</em>` (the
   inter-node space in `inline-no-separator` would be eaten), but the
   `claims/empty-name-fails` fixture requires a claim name of a single
   space to normalize to the empty string, which only a real trim
   produces. This implementation resolves it by keeping
   `normalizeText()` untrimmed (used per text node during extraction,
   where trimming instead happens once, after the whole block-delimited
   buffer is assembled) and adding a separate `normalizeStandaloneText()`
   (`normalizeText` plus `.trim()`) for claim names/values and for the
   standalone `normalize` suite. The draft never names these as two
   different procedures; a future revision could make that explicit.

2. **Section 4.1.1's rejection list is not exhaustive.** The prose names
   six categories ("duplicate attributes ... unclosed or misnested
   elements, table foster parenting, foreign-content integration points,
   ambiguous character references, or malformed HTML comments"), but the
   fixture set also rejects raw C0/C1 control characters
   (`parser-control-c0`, `parser-control-c1`) and a non-void element's
   self-closing flag, including the whitespace-separated form
   (`parser-self-closing-nonvoid*`), neither of which appears in that
   list. These are real WHATWG HTML5 parse errors, so treating "conforms
   to the HTML Living Standard parser model" (also stated in section
   4.1.1) as the operative rule, rather than the six-item list as a
   closed set, is what the fixtures confirm.

3. **Foreign-content rejection is name-based, not namespace-based.** The
   `parser-foreign-object-standalone` fixture rejects a bare
   `<foreignObject>` even with no enclosing `<svg>` -- context in which a
   real HTML5 parser would not treat it as foreign content at all, just
   as an unrecognized ordinary HTML element (case-folded to
   `foreignobject`). Combined with `parser-foreign-content` (`<svg>` +
   `<foreignObject>`), the only reading both fixtures support is: reject
   on the element's local name being `svg`, `math`, or `foreignobject`,
   regardless of where in the tree it appears. This is stricter than
   actual SVG/MathML integration-point semantics, and worth confirming
   is the intended rule rather than an artifact of how the fixture was
   generated.

4. **"Ambiguous" and "unterminated" character references are the same
   mechanism.** `parser-ambiguous-reference` (`&notit;`) and
   `parser-unterminated-reference` (`&amp B`) read, from their names, like
   two different failure categories. Working through the WHATWG named-
   character-reference tokenizer state shows they are not: `&notit;`'s
   longest table match is the legacy (no-semicolon) entry `&not`, and
   because that match does not end in `;`, it is the identical
   "missing-semicolon-after-character-reference" condition that
   `&amp B`'s match against legacy `&amp` produces. `&#65` (no closing
   `;`) is a third instance of the same condition on the numeric-reference
   side. A reader could easily implement "ambiguous" and "unterminated"
   as two separate checks (as this implementation's first draft did,
   before simplifying); the spec would be clearer stating they are one
   rule with two example shapes.

## Known scope limits (not fixture failures)

`lib/portable-profile.js`'s header comment documents these, but they are
also worth surfacing here since they are gaps relative to full HTML5
tokenizer fidelity, not just implementation shortcuts:

- Character-reference ambiguity/termination checking runs on text-node
  content only, not inside attribute values. No fixture exercises an
  ambiguous reference inside `href`/`alt`/etc., so this is unverified
  either way.
- `<title>` and `<textarea>` (RCDATA content) are scanned the same as
  `<script>`/`<style>` (RAWTEXT): only their matching end tag is
  searched for, with no internal character-reference validation. Per the
  HTML Standard, RCDATA content does decode character references; no
  fixture depends on that distinction.
- The open-element stack requires an exact, explicit end tag for every
  non-void element. HTML5's implied-end-tag rules for elements like `p`,
  `li`, `td` (where a new sibling start tag implicitly closes the
  previous one) are not implemented, because every accepted fixture
  closes its elements explicitly. Content relying on tag omission would
  be over-rejected as "unclosed" by this implementation, even though a
  real browser accepts it.

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
adapters/browser-domparser.js  DOMParser -> generic tree, for browsers
conformance-runner.mjs      PROTOCOL.md JSON-Lines runner (Node)
browser-runner.html         fixture runner using DOMParser (any browser)
```
