# HTMLTrust Canonicalization FFI

This crate exposes the Rust `htmltrust-c14n-v1` implementation through a C ABI
and WebAssembly. The other language directories in this repository remain
independent implementations and use the shared conformance fixtures.

## Test and build

From the repository root:

```sh
cargo test --locked --manifest-path ffi/Cargo.toml
cargo build --locked --release --manifest-path ffi/Cargo.toml
```

Build the WebAssembly target after installing it with `rustup`:

```sh
rustup target add wasm32-unknown-unknown
cargo build --locked --release --target wasm32-unknown-unknown \
  --manifest-path ffi/Cargo.toml
```

## Native API

New integrations should use the length-based `*_v1` functions. They accept
explicit byte lengths, reject invalid UTF-8, and clear output pointers before
returning an error. Release returned buffers with `htmltrust_bytes_free`.

The older C-string functions remain available for compatibility. Release their
returned strings with `htmltrust_string_free`.

See the exported functions and status-code contracts in [`src/lib.rs`](src/lib.rs).
