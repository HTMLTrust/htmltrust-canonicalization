# HTMLTrust Canonicalization

Canonical text normalization for the HTMLTrust content signing framework. Produces a stable, deterministic text representation so that the same content always hashes to the same value — regardless of which CMS, editor, or platform produced it.

All implementations follow the same [specification](spec.md) and pass the same verification test suite.

## Project status

The current immutable release is **v0.2.2**, commit
`79b0d52fecd958f8fc7ade713fe0799ca1e79626`. It is the version used by the
HTMLTrust server, browser, CMS, and Hugo reference projects. The repository
contains the shared conformance fixtures plus five bindings. Changes to the
canonical output are protocol changes and must update every binding and the
conformance suite together.

For reproducible builds, pin the release tag or full commit. For example:

```sh
git clone https://github.com/HTMLTrust/htmltrust-canonicalization.git
cd htmltrust-canonicalization
git checkout 79b0d52fecd958f8fc7ade713fe0799ca1e79626
```

The JavaScript package can be installed from the same immutable commit:

```sh
npm install https://github.com/HTMLTrust/htmltrust-canonicalization/archive/79b0d52fecd958f8fc7ade713fe0799ca1e79626.tar.gz
```

## Why Canonicalization?

Content management systems silently transform text in ways that break naive hashing:

- WordPress converts `"straight quotes"` to `"curly quotes"`
- Google Docs converts `--` to em dashes `—`
- Rich text editors swap `...` for the ellipsis character `…`
- Copy-paste introduces invisible Unicode characters (ZWSP, BOM, bidi marks)
- CJK editors interchange fullwidth and halfwidth forms

Without canonicalization, the same authored content produces different hashes depending on which tool touched it last. This library normalizes all of these variations to a single canonical form.

## Implementations

| Language | Path | Dependencies | Usage |
|---|---|---|---|
| **JavaScript** | [`javascript/`](javascript/) | None (browser + Node.js) | Browser extension, Hugo signing script |
| **Go** | [`go/`](go/) | `golang.org/x/text` (NFKC) | Hugo module |
| **PHP** | [`php/`](php/) | `ext-intl`, `ext-mbstring` | WordPress plugin |
| **Python** | [`python/`](python/) | `beautifulsoup4` | Tooling, tests |
| **Rust** | [`rust/`](rust/) | `scraper`, `unicode-normalization`, `url` | Conformance implementation |

All implementations produce identical output for the same input.

## Protocol Helpers

The signing helpers use the legacy field name `domain`, but the value is a serialized Web origin such as `https://example.org` or `https://example.org:8443`, not a bare hostname. Helpers that build signature bindings reject host-only values.

Hashes and signatures are encoded as canonical unpadded standard Base64. This is not base64url; conforming verification rejects padding, whitespace, `-`, and `_`.

Canonical content includes signed semantic attribute records for `href`, `src`, `alt`, and `aria-label` across the JavaScript, Go, PHP, Python, and Rust HTML extraction helpers. Relative `href` and `src` values require the signed document base URL to canonicalize correctly.

## The 8 Phases

| Phase | What It Does |
|---|---|
| **1. NFKC** | Unicode NFKC normalization — handles ligatures, fullwidth/halfwidth, presentation forms, superscripts, CJK compatibility, Jamo composition |
| **2. Whitespace** | All Unicode whitespace (30+ characters) → ASCII space; collapse runs; trim |
| **3. Quotation Marks** | Curly quotes, guillemets, CJK corner brackets → ASCII straight quotes |
| **4. Dashes** | En dash, em dash, figure dash, non-breaking hyphen → ASCII hyphen-minus |
| **5. Punctuation** | Ellipsis `…` → `...`; minus sign → hyphen-minus |
| **6. Strip Invisibles** | Remove soft hyphens, zero-width spaces, BOM, variation selectors, bidi controls, Arabic tatweel |
| **7. Bidi** | Remove all bidi control characters (rely on HTML `dir` attribute instead) |
| **8. Language-Specific** | Preserve ZWNJ (semantic in Persian/Kurdish), ZWJ (semantic in Indic/emoji), Arabic diacritics, Hebrew nikud |

## Quick Start

### JavaScript (Browser / Node.js)

```js
import { normalizeText } from '@htmltrust/canonicalization';

const canonical = normalizeText('He said, \u201CHello\u2026\u201D');
// → 'He said, "Hello..."'
```

### Go

```go
import "github.com/HTMLTrust/htmltrust-canonicalization/go"

canonical := canonicalize.Normalize("He said, \u201CHello\u2026\u201D")
// → "He said, \"Hello...\""
```

### PHP

```php
use HTMLTrust\Canonicalization\Canonicalize;

$canonical = Canonicalize::normalize("He said, \u{201C}Hello\u{2026}\u{201D}");
// → 'He said, "Hello..."'
```

## Verification Checklist

All implementations must produce identical output for these test pairs:

| Input A | Input B | Same After Normalization? |
|---|---|---|
| `"Hello"` (curly quotes) | `"Hello"` (straight) | ✅ Yes |
| `café` (precomposed) | `café` (combining) | ✅ Yes |
| `ﬁnd` (fi ligature) | `find` | ✅ Yes |
| `word — word` (em dash) | `word - word` | ✅ Yes |
| `«Bonjour»` (guillemets) | `"Bonjour"` | ✅ Yes |
| `「東京」` (CJK brackets) | `"東京"` | ✅ Yes |
| `می‌خواهم` (with ZWNJ) | `میخواهم` (without) | ❌ No — ZWNJ is semantic |
| `كتـــاب` (with tatweel) | `كتاب` | ✅ Yes |
| `Ａ１` (fullwidth) | `A1` | ✅ Yes |
| `word​word` (with ZWSP) | `wordword` | ✅ Yes |
| `word‌word` (with ZWNJ) | `wordword` | ❌ No — ZWNJ is semantic |

## Prerequisites

The root JavaScript binding needs Node.js 22 or newer. The Go binding needs
Go 1.25 or newer. The PHP binding needs PHP 7.2 or newer with `intl`,
`mbstring`, `json`, `openssl`, and `sodium`, plus Composer. The Python
binding needs Python 3.10 or newer and pip. The Rust binding needs Rust 1.74
or newer. The full conformance command requires all five toolchains.

## Running tests

From the repository root, run the language-specific tests as needed:

```sh
# JavaScript, no install step is needed
node javascript/test.js

# Go
(cd go && go test -v ./...)

# PHP
(cd php && composer install --no-interaction && composer test)

# Python
(cd python && python3 -m pip install -e '.[dev]' && python3 -m pytest)

# Rust
(cd rust && cargo test)
```

Run the public cross-language contract with one command:

```sh
REQUIRE_ALL_LANGUAGES=1 make conformance
```

Without `REQUIRE_ALL_LANGUAGES=1`, the runner reports unavailable toolchains
as `SKIP`. Use `make conformance-<language>` when iterating on one binding.
See [`conformance/README.md`](conformance/README.md) for fixture authoring
and update rules.

## Compatibility matrix

| Consumer | Compatible release | Canonicalization source |
|---|---|---|
| JavaScript, server, CMS | `v0.2.2` | `79b0d52fecd958f8fc7ade713fe0799ca1e79626` |
| Browser client `@htmltrust/browser-client` | `v0.1.2` | `v0.2.2` |
| Hugo signer | current `main` | Go binding at the `v0.2.2` release commit |

The browser client and server manifests pin the v0.2.2 release archive. Go
consumers should pin the corresponding commit and keep the resulting
pseudo-version in `go.mod`; do not replace it with an unconstrained branch.

## Companion Repositories

| Repository | Description |
|---|---|
| [htmltrust-spec](https://github.com/HTMLTrust/htmltrust-spec) | The HTMLTrust specification and paper |
| [htmltrust-server-reference](https://github.com/HTMLTrust/htmltrust-server-reference) | Reference trust directory API server |
| [htmltrust-browser-reference](https://github.com/HTMLTrust/htmltrust-browser-reference) | Reference browser extension |
| [htmltrust-cms-reference](https://github.com/HTMLTrust/htmltrust-cms-reference) | Reference CMS plugins (WordPress, Hugo) |
| [htmltrust-website](https://github.com/HTMLTrust/htmltrust-website) | Project website |

## License


This project is licensed under the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0). You may use, modify, and share the software for any noncommercial purpose with attribution. Commercial use requires a separate agreement with the licensor.

## Origin & Contributions

HTMLTrust is an idea I (Jason Grey) have been chewing on since 2024. I'm not an academic — I'm an engineer with a day job and a family — so the spec, the reference implementations, and most of this prose have been written with significant help from AI tools acting as research assistant, technical writer, and pair programmer. I wrote the original architectural sketches and reviewed every line; the assistants filled in the gaps and saved me from re-typing the same explanation for the hundredth time.

**Contributions are welcome — human or AI-assisted, doesn't matter to me.** What matters is whether the code, the spec text, or the conformance vectors move the project forward. Open a PR.

What this project is **not** a forum for:

- Debates about whether AI should be used to write code or specifications.
- Opinions on who is or isn't trustworthy on the web.
- Politics, religion, professional practice, or personal philosophy.

HTMLTrust is a mechanism — a way for *anyone* to sign content they publish and for *anyone* to decide whom they trust, on their own terms. The project takes no position on what the right answers are; it just provides the tools. If you want to debate the answers, there are entire continents of the internet better suited to it.

If this work is useful to you and you'd like to support it, see [GitHub Sponsors](https://github.com/sponsors/jt55401) or the other channels in [`.github/FUNDING.yml`](.github/FUNDING.yml).
