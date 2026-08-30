# HTMLTrust Rust FFI

This crate exposes the Rust `htmltrust-c14n-v1` implementation through a
versioned C ABI and generated WebAssembly. Go, Python, and PHP use the native
library. JavaScript uses the packaged Node.js or browser WebAssembly layout.

**Author:** HTMLTrust contributors

**Date:** 2026-08-30

**Version:** 0.3.0 release candidate

**Status:** Required Rust boundary for adapter builds

**Readers:** FFI maintainers and application integrators

**Reading time:** 3 minutes

## Prerequisites and shortest test

Install Rust 1.86 or newer, a C compiler, and `wasm-bindgen-cli` for
WebAssembly output. From the repository root, the complete supported path uses
Docker:

```sh
make core-artifacts
make test-docker
```

`make core-artifacts` prints the disk-backed artifact directory. The output
contains the native library, static library, public header, `wasm-node/`,
`wasm-web/`, and `MANIFEST.txt`.

## Platform artifact lanes

The primary desktop runtime targets are Linux, macOS, and Windows on x86_64
and ARM64. Linux i686 and Windows i686 provide C ABI compatibility checks.
Android API 21 with NDK r27d produces raw `jniLibs` and a Prefab AAR for
`arm64-v8a`, `armeabi-v7a`, `x86_64`, and `x86`. iOS 12 produces a static
XCFramework with arm64 device and arm64 plus x86_64 simulator slices. Every
mobile ABI or slice gets a C link check.

Run the desktop builders from the repository root:

```sh
bash scripts/build-native-unix.sh <target> <absolute-output> <version> [abi-version]
```

```powershell
.\scripts\build-native-windows.ps1 -Target <target> -OutputRoot <absolute-output> -Version <version>
```

Both scripts require a private absolute `CARGO_TARGET_DIR` and use
`cargo build --locked --release`. Android uses
`scripts/build-android-artifacts.sh` with `ANDROID_NDK`, optional
`ANDROID_API_LEVEL`, `HTMLTRUST_CARGO_TARGET_ROOT`,
`HTMLTRUST_ANDROID_ARTIFACTS`, and `HTMLTRUST_TEST_SESSION_ID`. iOS uses
`scripts/build-apple-mobile-artifacts.sh` with `IPHONEOS_DEPLOYMENT_TARGET`,
`HTMLTRUST_CARGO_TARGET_ROOT`, `HTMLTRUST_IOS_ARTIFACTS`, and
`HTMLTRUST_TEST_SESSION_ID`.

The scripts stage target libraries, headers, checksums, and manifests. CI
artifacts are unsigned and unpublished. See the [platform artifact guide](../docs/PLATFORM-ARTIFACTS.md)
for target maps, exact output names, and mobile support limits.

For native crate development:

```sh
cargo test --locked --manifest-path ffi/Cargo.toml
cargo build --locked --release --manifest-path ffi/Cargo.toml
```

## Native ABI

New integrations use the length-based declarations in
[`include/htmltrust_canonicalization.h`](include/htmltrust_canonicalization.h):

- `htmltrust_abi_version_v1`
- `htmltrust_normalize_text_v1`
- `htmltrust_extract_canonical_text_options_v1`
- `htmltrust_extract_claims_from_signed_section_v1`
- `htmltrust_canonicalize_claims_v1`
- `htmltrust_canonicalize_json_document_v1`
- `htmltrust_bytes_free`

Inputs carry a pointer and byte length, so embedded NUL bytes are valid. A
zero-length input may use a null pointer. Status `0` returns canonical UTF-8.
Status `1` returns an allocated UTF-8 machine error code. Status `2` reports
an invalid pointer argument and allocates no output. Release every allocated
output with `htmltrust_bytes_free`.

The direct-claims operation returns a JSON object for claims found on direct
children of the first signed section. It follows the same status and ownership
contract. The v1 profile limits input and output to 1 MiB and returns stable
machine error codes.

## WebAssembly output

The maintained build generates both targets from the same Rust input:

```sh
rustup target add wasm32-unknown-unknown
cargo install --locked --version 0.2.126 wasm-bindgen-cli
export CARGO_TARGET_DIR=/path/to/private/cargo-target
(cd ffi && cargo build --locked --release --target wasm32-unknown-unknown)
wasm-bindgen --target nodejs --out-dir /path/to/wasm-node \
  "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/htmltrust_canonicalization_ffi.wasm"
wasm-bindgen --target web --out-dir /path/to/wasm-web \
  "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/htmltrust_canonicalization_ffi.wasm"
```

Keep both generated directories from one build. JavaScript calls
`initializeNodeWasm()` or `initializeBrowserWasm()` before synchronous
operations when using the low-level adapter. The package entry points use the
corresponding packaged directories.

## Ownership and errors

The caller owns every output buffer returned with status `0` or `1` and must
release it with the exported free function. The C boundary catches Rust panics
and reports `core-internal-error`. Process abort and memory exhaustion remain
process failures. Adapters validate ABI version 1 and required symbols before
processing application data.

See [`src/lib.rs`](src/lib.rs) and the [shared-core integration guide](../docs/RUST-SHARED-CORE.md)
for the complete contract. Use `make test-docker` after changing the Rust
boundary. Report failures with the command, artifact manifest, target, and
complete output in a GitHub issue.
