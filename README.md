# HTMLTrust Canonicalization

HTMLTrust Canonicalization produces the stable UTF-8 bytes that HTMLTrust
applications hash and sign. Rust is the sole canonicalization implementation.
The language packages call that implementation through its native C ABI or its
packaged WebAssembly build.

**Author:** HTMLTrust contributors

**Date:** 2026-08-30

**Version:** 0.3.0 release candidate

**Status:** Release candidate, desktop and mobile artifact lanes

**Readers:** Application integrators and binding contributors

**Reading time:** 5 minutes

## Start here

Prerequisites are Git and Docker Engine with the Compose plugin. A complete
checkout test is:

```sh
git clone https://github.com/HTMLTrust/htmltrust-canonicalization.git
cd htmltrust-canonicalization
make test-docker
```

The pipeline builds Rust and the FFI crate first. It stores the native library,
Node.js and browser WebAssembly layouts, a staged npm package, the header, and
the manifest in a disk-backed artifact directory. It then tests every adapter
against those artifacts.

To build only the shared artifacts:

```sh
make core-artifacts
```

The command prints the absolute artifact directory. `make test-shared-core` is
an alias for the complete Docker pipeline. Set
`HTMLTRUST_SHARED_CORE_ARTIFACTS_MOUNT` to choose the artifact directory and
`HTMLTRUST_TEST_SESSION_ID` when concurrent sessions share a checkout. Each
session receives private Cargo target directories.

## Choose a package

| Package | Prerequisites | Test command after dependency install |
| --- | --- | --- |
| JavaScript | Node.js 22 or newer, `npm ci` | `HTMLTRUST_WASM_PKG=/absolute/wasm-node/htmltrust_canonicalization_ffi.js npm test` |
| Go | Go 1.25 or newer; cgo and a C compiler on Unix | `(cd go && HTMLTRUST_RUST_CORE_LIB=/absolute/lib.so go test ./...)` |
| Python | Python 3.10 or newer, `python3 -m pip install -e 'python[dev]'` | `HTMLTRUST_RUST_CORE_LIB=/absolute/lib.so python3 -m pytest -q python/tests` |
| PHP | PHP 8.5 or newer, Composer install in `php/`, `ext-ffi`, `ext-uri`, Linux amd64 | `(cd php && HTMLTRUST_RUST_CORE_LIB=/absolute/lib.so composer test)` |
| Rust | Rust 1.86 or newer | `cargo test --locked --manifest-path rust/Cargo.toml` |

Go, Python, and PHP require `HTMLTRUST_RUST_CORE_LIB` or an equivalent
explicit absolute path in application code. Build it with `make
core-artifacts`, then use `libhtmltrust_canonicalization_ffi.so` from the
printed directory. PHP configures the shared handle with
`Canonicalize::configureRustCore` during process startup. See each package
README for a complete example.

JavaScript uses the packaged Node.js and browser WebAssembly modules. Node
imports the package entry point, which initializes its packaged module. Browser
applications call `initializeBrowserWasm()` before synchronous operations.

## What the core does

The core provides text normalization, HTML extraction, direct claim extraction
from the first signed section, claims serialization, and strict JSON
canonicalization. It performs no network or file I/O. Signing, verification,
key resolution, and application policy remain above this byte-producing API.
The JavaScript, Go, and PHP key resolvers implement period-scoped key
selection (draft §9.10): a `did:web` fragment selects one `verificationMethod`
by exact id, a bare keyid selects the first non-period entry, and revoked or
expired entries are returned rather than skipped so the caller can decide.

The normative protocol text is the [HTMLTrust IETF
draft](https://github.com/HTMLTrust/htmltrust-spec/tree/main/ietf-draft).
The JSON fixtures under [`conformance/fixtures/`](conformance/fixtures/) are
the repository's byte-level contract.

## Conformance

The default Docker path runs Rust first and passes its artifacts to every
adapter. After `make core-artifacts`, a local conformance run needs the
absolute native library and packaged Node WebAssembly path:

```sh
export HTMLTRUST_RUST_CORE_LIB=/absolute/path/to/libhtmltrust_canonicalization_ffi.so
export HTMLTRUST_WASM_PKG=/absolute/path/to/wasm-node/htmltrust_canonicalization_ffi.js
make conformance
```

Per-language runners are available through `make conformance-js`,
`conformance-go`, `conformance-python`, `conformance-php`, and
`conformance-rust`. The adapter runners require the artifact configuration
shown above where their binding needs it. Use `make conformance-update` only
when a Rust output change has been reviewed as a protocol change.

## Protocol details

`normalizeText` applies Unicode NFKC, whitespace, punctuation, and control
character rules. `extractCanonicalText` parses HTML and requires an explicit
resolved base URL for relative signed links. `extractClaimsFromSignedSection`
reads direct claim metadata from the first signed section. Claims and JSON are
serialized into deterministic UTF-8 bytes.

Inputs and outputs have a 1 MiB limit in the v1 profile. A missing base URL
means that relative links cannot be resolved. The caller's source-snapshot
layer computes the document base URL, including HTML `<base>` processing.

## Platform and release support

The primary desktop runtime lanes cover Linux, macOS, and Windows on x86_64
and ARM64. Linux i686 and Windows i686 are C ABI compatibility lanes. Android
API 21 uses NDK r27d and produces four ABI libraries plus a Prefab AAR. iOS 12
produces an arm64 device and arm64 plus x86_64 simulator static XCFramework.
Each mobile ABI or slice receives a C link check.

CI artifacts are unsigned and unpublished. Signing, notarization, mobile
runtime tests, SwiftPM and Maven publication, and release policy remain future
work. See the [platform artifact guide](docs/PLATFORM-ARTIFACTS.md) for exact
scripts, environment variables, archive contents, and support limits.

The current PR checks run the Linux amd64 shared-core lane and the platform
artifact matrix. The platform jobs upload unsigned target archives for the
desktop, Android, and Apple mobile lanes. The [platform artifact guide](docs/PLATFORM-ARTIFACTS.md)
lists their CI names and local commands.

Go uses cgo on supported Unix systems. Its Windows AMD64 and ARM64 loader uses
the native Win32 API and works with `CGO_ENABLED=0`. PHP uses FFI and requires
`ffi.enable` for the SAPI that loads the library. The JavaScript package
contains both `wasm-node/` and `wasm-web/` generated artifact layouts.

The removed JavaScript, Go, Python, and PHP implementations remain in Git
history. For example, use `git log --all -- go/extract.go` or `git show
v0.2.2`. The previous release is also available at commit
`79b0d52fecd958f8fc7ade713fe0799ca1e79626`.

## Glossary

- **Canonical bytes:** The exact UTF-8 output used for hashing or signing.
- **C ABI:** The versioned binary function interface used by Go, Python, and PHP.
- **Conformance fixture:** A JSON input with an expected output or stable error.
- **WASM:** WebAssembly, used by the JavaScript package in Node and browsers.

## Contributing and support

Run `make test-docker` before submitting a core or adapter change. For an
issue, open a GitHub issue with the command, platform, tool versions, artifact
manifest, and complete error output so another contributor can reproduce it.

Related guides: [Rust shared core](docs/RUST-SHARED-CORE.md), [FFI](ffi/README.md),
[conformance](conformance/README.md), and the package READMEs in
[`javascript/`](javascript/), [`go/`](go/), [`python/`](python/), [`php/`](php/),
and [`rust/`](rust/).

## License

This project is licensed under the [PolyForm Noncommercial License
1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0).
