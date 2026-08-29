# HTMLTrust Canonicalization FFI

This crate exposes the Rust `htmltrust-c14n-v1` implementation through a C ABI
and WebAssembly. The other language directories contain independent
compatibility implementations plus adapters that can call this shared core.
The [shared-core guide](../docs/RUST-SHARED-CORE.md) defines the migration
boundary and release rules.

## Test and build

From the repository root, this builds the native library, static library,
public header, and generated Node.js WebAssembly module. It then runs the four
language adapters against that artifact set:

```sh
make test-shared-core
```

The command prints the artifact directory and writes `MANIFEST.txt` with the
ABI version, target, tool versions, and checksums.

For a native-only developer build:

```sh
cargo test --locked --manifest-path ffi/Cargo.toml
cargo build --locked --release --manifest-path ffi/Cargo.toml
```

For a manual Node.js WebAssembly build, install the target and the exact CLI
version recorded in `ffi/Cargo.lock`, then generate the JavaScript loader:

```sh
rustup target add wasm32-unknown-unknown
cargo install --locked --version 0.2.126 wasm-bindgen-cli
export CARGO_TARGET_DIR=/path/to/a/private/cargo-target
(cd ffi && cargo build --locked --release --target wasm32-unknown-unknown)
wasm-bindgen --target nodejs --out-dir path/to/wasm-node \
  "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/htmltrust_canonicalization_ffi.wasm"
```

The maintained build script currently emits Node.js bindings. Browser output
and browser package installation remain release work.

## Native API

New integrations should use the length-based v1 functions declared in
[`include/htmltrust_canonicalization.h`](include/htmltrust_canonicalization.h).
They accept explicit byte lengths, reject invalid UTF-8, and clear output
pointers before returning an error. Release every status-0 or status-1 buffer
with `htmltrust_bytes_free`. A zero-length base URL means that no base URL was
supplied, regardless of whether its pointer is null.

The ABI version is 1. Status 0 means canonical UTF-8 output. Status 1 means an
allocated UTF-8 error code. Status 2 means invalid pointer arguments and no
allocation. The versioned operations catch Rust panics and return
`core-internal-error` with status 1. Memory exhaustion remains a process
failure. Status-1 results contain a bare machine code without parser detail.

Older C-string symbols remain in the crate for existing callers. They are
outside the public v1 header and should not be used by new integrations.

## WebAssembly API

Build the generated module with `wasm-bindgen`, then pass its exact module
object to the JavaScript package's `initializeRustWasm` function. The adapter
checks `abiVersion()` and all four operation exports before it accepts calls.
Keep module initialization explicit so an application can pin and audit the
artifact it loads.

See the exported functions and status-code contracts in [`src/lib.rs`](src/lib.rs).
