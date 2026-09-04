# HTMLTrust Canonicalization for Rust

This crate is the sole canonicalization implementation for
`htmltrust-c14n-v1`. It normalizes text, extracts HTML, reads direct claims,
serializes claims, and canonicalizes strict JSON. Other language packages call
this code through the artifacts in [`../ffi/`](../ffi/).

**Author:** HTMLTrust contributors

**Date:** 2026-08-29

**Version:** 0.3.0 release candidate

**Status:** Rust reference crate, Linux amd64 validation lane

**Readers:** Rust developers and binding maintainers

**Reading time:** 3 minutes

## Prerequisites and shortest test

Install Rust 1.86 or newer. From the repository root:

```sh
cargo test --locked --manifest-path rust/Cargo.toml
```

The complete artifact-backed test is:

```sh
make test-docker
```

That command runs this crate, the FFI crate, and every adapter against one
Rust build. The native validation lane is Linux amd64.

## Install

During the 0.3.0 release candidate, use a path dependency from a checkout:

```toml
[dependencies]
htmltrust-canonicalization = { path = "../htmltrust-canonicalization/rust" }
```

Pin a reviewed tag or full commit for application releases. The retained Git
history includes the previous protocol tag `v0.2.2`; inspect it with
`git show v0.2.2`.

## API

The checked v1 functions are the application entry points:

- `try_normalize_text` and `try_normalize_text_v1` normalize UTF-8 text.
- `try_extract_canonical_text_with_options` extracts canonical HTML.
- `extract_claims_from_signed_section` reads direct claims from the first signed section.
- `canonicalize_claims_checked` serializes validated claims.
- `canonicalize_json_document` validates and serializes one JSON document.

Use the checked functions for protocol input. Text, HTML, JSON, and nonempty
base URLs have a 1 MiB limit. A missing base URL means relative signed links
cannot be resolved. The caller's source-snapshot layer resolves HTML `<base>`
processing and passes the resulting URL.

```rust
use std::collections::BTreeMap;
use htmltrust_canonicalization::{
    canonicalize_claims_checked, extract_claims_from_signed_section,
    try_extract_canonical_text_with_options, try_normalize_text, ExtractOptions,
};

let text = try_normalize_text("He said, \"Hello…\"", false)?;
let content = try_extract_canonical_text_with_options(
    "<p>Read <a href=\"/paper\">the paper</a>.</p>",
    ExtractOptions { preserve_whitespace: false, base_url: Some("https://example.org/article") },
)?;
let claims = BTreeMap::from([("License".to_string(), "CC-BY-4.0".to_string())]);
let claim_bytes = canonicalize_claims_checked(&claims)?;
let found = extract_claims_from_signed_section(
    "<signed-section><meta name=\"claim:License\" content=\"CC-BY-4.0\"></signed-section>"
)?;
# Ok::<(), String>(())
```

The safe URL profile accepts HTTPS URLs and rejects credentials, controls, and
unsupported schemes. Parser controls return `parser-profile-unsupported`.

## FFI and WebAssembly

The [`ffi`](../ffi/) crate exports the same checked behavior through C ABI v1
and generated `wasm-bindgen` modules. Go, Python, and PHP use an explicit
absolute path to the native library. JavaScript uses the packaged
`wasm-node/` or `wasm-web/` module and awaits its initializer in browser code.

Use `make core-artifacts` to build the native library, header, both WASM
layouts, and `MANIFEST.txt`. Use `make test-docker` to validate every consumer.
See the [shared-core integration guide](../docs/RUST-SHARED-CORE.md) for ABI
status and ownership rules.

Report a failure with the command, target, tool versions, artifact manifest,
and complete output in a GitHub issue.
