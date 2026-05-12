# HTMLTrust Canonicalization -- Python

Python binding for the HTMLTrust canonical text normalization library. Produces byte-identical output to the JavaScript, Go, PHP, and Rust implementations for every test vector in the shared conformance suite.

## Status

Implemented. The 18-case normalization conformance suite from the JavaScript reference (`javascript/test.js`) passes. `extract_canonical_text` and `canonicalize_claims` have parity tests against the JavaScript / Go / PHP reference behaviour.

Out of scope for this package: signature verification and key resolution. Those live in the higher-level HTMLTrust client libraries (and will arrive in a follow-up PR for the Python binding once the JS surface area lands on `main`).

## Scope

This package provides three functions:

1. **`normalize_text(text: str, preserve_whitespace: bool = False) -> str`** -- applies the 8-phase canonicalization defined in [`../spec.md`](../spec.md) to a UTF-8 string. Mirrors the existing JavaScript/Go/PHP signatures.
2. **`extract_canonical_text(html: str, preserve_whitespace: bool = False) -> str`** -- parses an HTML fragment with BeautifulSoup, walks the DOM, emits text nodes in document order with single-space separators between block elements, and applies `normalize_text` to the result. This is the HTML -> canonical text extraction defined in the paper's §2.1.
3. **`canonicalize_claims(claims: Mapping[str, object]) -> str`** -- serializes a claim map to the canonical, hashable string used by the `claims-hash` field of the signature binding (each entry normalized, sorted lexically by name, joined with `\n` as `name=value`).

All three are pure functions: no network, no file I/O, deterministic output for the same input.

## Dependencies

- `unicodedata` (stdlib) for NFKC normalization
- `beautifulsoup4 >= 4.12` for HTML parsing in `extract_canonical_text`
- No other runtime dependencies

## Conformance

`tests/test_normalize.py` runs all 18 normalization vectors from `javascript/test.js`. `tests/test_extract.py` and `tests/test_claims.py` cover the HTML extraction and claim canonicalization contracts. Output MUST stay byte-identical to the JavaScript / Go / PHP / Rust bindings.

## Installation

```bash
pip install htmltrust-canonicalization
# or for development:
cd python && pip install -e '.[dev]'
```

## Usage

```python
from htmltrust_canonicalization import (
    normalize_text,
    extract_canonical_text,
    canonicalize_claims,
)

canonical = normalize_text('He said, "Hello…"')
# -> 'He said, "Hello..."'

from_html = extract_canonical_text('<p>Hello <em>world</em>!</p>')
# -> 'Hello world!'

claims_str = canonicalize_claims({
    'License': 'CC-BY-4.0',
    'AIAssistance': 'None',
})
# -> 'AIAssistance=None\nLicense=CC-BY-4.0'
```

## Tests

```bash
pip install -e '.[dev]'
pytest
```
