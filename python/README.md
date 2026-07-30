# HTMLTrust Canonicalization -- Python

Python binding for the HTMLTrust canonical text normalization library. Produces byte-identical output to the JavaScript, Go, PHP, and Rust implementations for every test vector in the shared conformance suite.

## Status

Implemented. The shared conformance suite passes for normalization, extraction, and claims. `extract_canonical_text` includes the current signed semantic attribute allowlist (`href`, `src`, `alt`, `aria-label`) when a base URL is available for relative URLs.

Out of scope for this package: signature verification and key resolution. Those live in the higher-level HTMLTrust client libraries (and will arrive in a follow-up PR for the Python binding once the JS surface area lands on `main`).

## Scope

This package provides four functions:

1. **`normalize_text(text: str, preserve_whitespace: bool = False) -> str`** -- applies the 8-phase canonicalization defined in [`../spec.md`](../spec.md) to a UTF-8 string. Mirrors the existing JavaScript/Go/PHP signatures.
2. **`extract_canonical_text(html: str, preserve_whitespace: bool = False, base_url: str | None = None) -> str`** -- parses an HTML fragment with BeautifulSoup, walks the DOM, emits text nodes and signed semantic attributes in document order, and applies `normalize_text` to text/attribute values.
3. **`canonicalize_claims(claims: Mapping[str, object]) -> str`** -- serializes a claim map to the canonical, hashable string used by the `claims-hash` field of the signature binding (each entry normalized, sorted lexically by name, emitted as `name:content\n`).
4. **`extract_claims_from_signed_section(html: str) -> dict[str, str]`** -- extracts all direct child `<meta name content>` claims from a `<signed-section>` or signed-section inner fragment, including `author` and `signed-at`, and rejects duplicate normalized names.

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
    extract_claims_from_signed_section,
)

canonical = normalize_text('He said, "Hello…"')
# -> 'He said, "Hello..."'

from_html = extract_canonical_text('<p>Hello <em>world</em>!</p>')
# -> 'Hello world!'

claims_str = canonicalize_claims({
    'License': 'CC-BY-4.0',
    'AIAssistance': 'None',
})
# -> 'AIAssistance:None\nLicense:CC-BY-4.0\n'
```

## Tests

```bash
pip install -e '.[dev]'
pytest
```
