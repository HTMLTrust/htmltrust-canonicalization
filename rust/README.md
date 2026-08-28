# HTMLTrust Canonicalization for Rust

This crate implements the Rust binding for `htmltrust-c14n-v1`. It normalizes
text, extracts signed content from HTML, canonicalizes claims, and
canonicalizes raw JSON under RFC 8785. The shared fixtures require the same
bytes from the JavaScript, Go, PHP, Python, and Rust bindings.

Version: `0.3.0` release candidate
Rust: 1.86 or newer

## Test a fresh checkout

From the repository root, Docker runs the Rust unit tests, native FFI tests,
and every shared conformance fixture:

```sh
docker compose -f compose.test.yml run --rm rust
```

Run `./scripts/test-in-docker.sh` to test all five language bindings.

With Rust installed locally:

```sh
cargo test --locked --manifest-path rust/Cargo.toml
cargo test --locked --manifest-path ffi/Cargo.toml
```

## Install

Use the repository while `0.3.0` is under review:

```toml
[dependencies]
htmltrust-canonicalization = { git = "https://github.com/HTMLTrust/htmltrust-canonicalization", rev = "<commit>" }
```

After the crate is published, use the release series:

```toml
[dependencies]
htmltrust-canonicalization = "0.3"
```

## Profile-v1 API

- `try_normalize_text` normalizes a UTF-8 `str` and enforces the 1 MiB source
  and output limits.
- `try_normalize_text_v1` accepts bytes and also rejects invalid UTF-8.
- `try_extract_canonical_text_with_options` parses HTML with explicit
  compatibility whitespace and base URL options. Profile-v1 callers use
  `preserve_whitespace: false`; the portable profile rejects nesting deeper
  than 256 elements.
- `canonicalize_claims_checked` validates, sorts, escapes, and serializes
  claim metadata.
- `canonicalize_json_document` validates and canonicalizes one raw JSON
  document, including duplicate-key checks.

The infallible normalization, extraction, and claims functions remain for
`0.2` callers that enforce their own limits. New signing code should use the
fallible functions above.

## Example

```rust
use std::collections::BTreeMap;
use htmltrust_canonicalization::{
    canonicalize_claims_checked,
    try_extract_canonical_text_with_options,
    try_normalize_text,
    ExtractOptions,
};

let canonical = try_normalize_text("He said, \"Hello\u{2026}\"", false)?;
assert_eq!(canonical, "He said, \"Hello...\"");

let content = try_extract_canonical_text_with_options(
    "<p>Read <a href=\"/paper\">the paper</a>.</p>",
    ExtractOptions {
        preserve_whitespace: false,
        base_url: Some("https://example.org/article"),
    },
)?;

let claims = BTreeMap::from([
    ("License".to_string(), "CC-BY-4.0".to_string()),
]);
let claim_bytes = canonicalize_claims_checked(&claims)?;
assert_eq!(claim_bytes, "License:CC-BY-4.0\n");
# Ok::<(), String>(())
```

Relative `href` and `src` attributes require an HTTPS base URL. The safe URL
profile rejects credentials, control characters, and unsupported schemes.

## Native FFI

The `ffi/` crate exposes length-based `*_v1` functions for normalization and
extraction. Status `0` means success, status `1` returns an allocated UTF-8
error code, and status `2` reports an invalid pointer. Every valid output
pointer is cleared before input decoding. Release returned byte buffers with
`htmltrust_bytes_free`.

The normative protocol text is maintained in the
[HTMLTrust specification](https://github.com/HTMLTrust/htmltrust-spec/tree/main/ietf-draft).
The repository's shared fixtures are the executable cross-language contract.
