# HTMLTrust Canonicalization -- Python

Python binding for the HTMLTrust canonical text normalization library. Must produce byte-identical output to the JavaScript, Go, PHP, and Rust implementations for every test vector in the shared conformance suite.

## Status

Scaffolded -- implementation pending.

## Scope

This package provides two functions:

1. **`normalize_text(text: str) -> str`** -- applies the 8-phase canonicalization defined in [`../spec.md`](../spec.md) to a UTF-8 string. Mirrors the existing JavaScript/Go/PHP signatures.
2. **`extract_canonical_text(html: str) -> str`** -- parses an HTML fragment, walks the DOM, emits text nodes in document order with single-space separators between block elements, and applies `normalize_text` to the result. This is the HTML -> canonical text extraction defined in the paper's §2.1.

Both are pure functions: no network, no file I/O, deterministic output for the same input.

## Planned dependencies

- `unicodedata` (stdlib) for NFKC normalization
- `beautifulsoup4` or `lxml` for HTML parsing in `extract_canonical_text`
- No other runtime dependencies

## Conformance

The package MUST pass every vector in `../conformance/vectors.json` (to be defined). A test runner at `tests/test_conformance.py` should load the shared vectors and assert byte-identical output.

## Installation (planned)

```bash
pip install htmltrust-canonicalization
# or for development:
cd python && pip install -e .
```

## Usage (planned)

```python
from htmltrust_canonicalization import normalize_text, extract_canonical_text

canonical = normalize_text('He said, "Hello\u2026"')
# -> 'He said, "Hello..."'

from_html = extract_canonical_text('<p>Hello <em>world</em>!</p>')
# -> 'Hello world!'
```
