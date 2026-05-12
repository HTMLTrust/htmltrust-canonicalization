# HTMLTrust Canonicalization -- Rust

Rust crate for the HTMLTrust canonical text normalization library. Produces byte-identical output to the JavaScript, Go, PHP, and Python implementations for every test vector in the shared conformance suite.

## Status

Implemented. The 18-case normalization conformance suite from the JavaScript reference (`javascript/test.js`) passes, along with parity tests for `extract_canonical_text` and `canonicalize_claims`.

Out of scope for this crate: signature verification and key resolution. Those will arrive in a follow-up PR alongside the Python binding once the JavaScript surface area lands on `main`.

## Scope

This crate provides three functions:

1. **`normalize_text(text: &str, preserve_whitespace: bool) -> String`** -- applies the 8-phase canonicalization defined in [`../spec.md`](../spec.md) to a UTF-8 string.
2. **`extract_canonical_text(html: &str) -> String`** -- parses an HTML fragment with `scraper` (html5ever), walks the DOM, emits text nodes in document order with single-space separators between block elements, and applies `normalize_text` to the result.
3. **`canonicalize_claims(claims: &BTreeMap<String, String>) -> String`** -- serializes a claim map to the canonical, hashable string used by the `claims-hash` field of the signature binding.

All three are pure functions: no I/O, deterministic output for the same input.

## Dependencies

- `unicode-normalization` for NFKC
- `scraper` (html5ever-backed) for HTML parsing in `extract_canonical_text`
- `ego-tree` for the DOM walk types re-exported by scraper

## Conformance

`tests/conformance.rs` runs all 18 normalization vectors from `javascript/test.js`, plus `extract_canonical_text` and `canonicalize_claims` parity cases. Output MUST stay byte-identical to the JavaScript / Go / PHP / Python bindings.

## Installation

```toml
[dependencies]
htmltrust-canonicalization = "0.1"
```

## Usage

```rust
use std::collections::BTreeMap;
use htmltrust_canonicalization::{
    normalize_text, extract_canonical_text, canonicalize_claims,
};

let canonical = normalize_text("He said, \"Hello\u{2026}\"", false);
// -> "He said, \"Hello...\""

let from_html = extract_canonical_text("<p>Hello <em>world</em>!</p>");
// -> "Hello world!"

let mut claims = BTreeMap::new();
claims.insert("License".to_string(), "CC-BY-4.0".to_string());
claims.insert("AIAssistance".to_string(), "None".to_string());
let claims_str = canonicalize_claims(&claims);
// -> "AIAssistance=None\nLicense=CC-BY-4.0"
```

## Tests

```bash
cargo test
```
