# HTMLTrust Canonicalization

Canonical text normalization for the HTMLTrust content signing framework. Produces a stable, deterministic text representation so that the same content always hashes to the same value — regardless of which CMS, editor, or platform produced it.

All implementations follow the same [specification](spec.md) and pass the same verification test suite.

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

All implementations produce identical output for the same input.

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
import "github.com/ArcadeLabsInc/htmltrust-canonicalization/go"

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

## Running Tests

```sh
# JavaScript
cd javascript && node test.js

# Go
cd go && go test -v ./...

# PHP
cd php && composer install && composer test
```

## Companion Repositories

| Repository | Description |
|---|---|
| [htmltrust-spec](https://github.com/ArcadeLabsInc/htmltrust-spec) | The HTMLTrust specification and paper |
| [htmltrust-server-reference](https://github.com/ArcadeLabsInc/htmltrust-server-reference) | Reference trust directory API server |
| [htmltrust-browser-reference](https://github.com/ArcadeLabsInc/htmltrust-browser-reference) | Reference browser extension |
| [htmltrust-cms-reference](https://github.com/ArcadeLabsInc/htmltrust-cms-reference) | Reference CMS plugins (WordPress, Hugo) |
| [htmltrust-website](https://github.com/ArcadeLabsInc/htmltrust-website) | Project website |

## License

MIT# htmltrust-canonicalization
