# HTMLTrust Canonicalization -- Rust

Rust crate for the HTMLTrust canonical text normalization library. Must produce byte-identical output to the JavaScript, Go, PHP, and Python implementations for every test vector in the shared conformance suite.

## Status

Scaffolded -- implementation pending.

## Scope

This crate provides two functions:

1. **`normalize_text(text: &str) -> String`** -- applies the 8-phase canonicalization defined in [`../spec.md`](../spec.md) to a UTF-8 string.
2. **`extract_canonical_text(html: &str) -> String`** -- parses an HTML fragment, walks the DOM, emits text nodes in document order with single-space separators between block elements, and applies `normalize_text` to the result.

Both are pure functions: no network, no file I/O, deterministic output for the same input.

## Planned dependencies

- `unicode-normalization` for NFKC
- `scraper` or `html5ever` for HTML parsing in `extract_canonical_text`
- Minimal `regex` for the whitespace and punctuation phases
- No other runtime dependencies

## Conformance

The crate MUST pass every vector in `../conformance/vectors.json`. A test at `tests/conformance.rs` should load the shared vectors and assert byte-identical output.

## Installation (planned)

```toml
[dependencies]
htmltrust-canonicalization = "0.1"
```

## Usage (planned)

```rust
use htmltrust_canonicalization::{normalize_text, extract_canonical_text};

let canonical = normalize_text("He said, \"Hello\u{2026}\"");
// -> "He said, \"Hello...\""

let from_html = extract_canonical_text("<p>Hello <em>world</em>!</p>");
// -> "Hello world!"
```
