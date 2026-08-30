# Rust shared core integration guide

This guide explains how an application loads the one Rust implementation of
HTMLTrust canonicalization. It covers the C ABI, WebAssembly startup, artifact
ownership, and adapter checks.

**Author:** HTMLTrust contributors

**Date:** 2026-08-30

**Version:** 0.3.0 release candidate

**Status:** Required for adapter and release changes

**Readers:** Binding maintainers and application integrators

**Reading time:** 6 minutes

## Shortest supported path

The repository's complete check uses Docker:

```sh
make core-artifacts
make test-docker
```

`make core-artifacts` builds Rust, the native library, the public header, and
Node and browser WebAssembly layouts. It prints the disk-backed artifact
directory and writes `MANIFEST.txt`. `make test-docker` builds that same set,
runs Rust and FFI tests, then runs all adapter tests. Use the printed absolute
path when integrating outside Docker.

The build gives each session a private Cargo target directory. Set
`HTMLTRUST_TEST_SESSION_ID` for concurrent sessions and
`HTMLTRUST_SHARED_CORE_ARTIFACTS_MOUNT` to select the artifact directory.

The [platform artifact guide](PLATFORM-ARTIFACTS.md) covers local desktop,
Android, and iOS builders. The primary desktop runtime matrix covers Linux,
macOS, and Windows on x86_64 and ARM64. Linux and Windows i686 are C ABI
compatibility lanes. Android and iOS are link-checked package lanes.

The current PR checks cover the Linux amd64 shared-core artifact and the
platform artifact matrix. The platform jobs upload unsigned desktop and mobile
archives with target-specific manifests and checksums.

## Decision and boundary

Rust owns the executable `htmltrust-c14n-v1` implementation. Rust applications
call the crate directly. Go, Python, and PHP load the native C ABI from an
explicit absolute path. JavaScript loads the generated WebAssembly module from
the package's `wasm-node/` or `wasm-web/` layout.

The core produces canonical bytes for text, HTML, direct claims, claim
serialization, and strict JSON. Signing, verification, key resolution, and
network policy consume those bytes in the application layer.

```text
HTMLTrust protocol and fixtures
              |
       Rust canonicalization
          /            \
       C ABI v1      WebAssembly
      /   |   \       /       \
    Go Python PHP   Node    Browser
```

## Native C ABI v1

The declarations are in [`../ffi/include/htmltrust_canonicalization.h`](../ffi/include/htmltrust_canonicalization.h).
The public symbols are:

| Operation | Symbol |
| --- | --- |
| ABI version | `htmltrust_abi_version_v1` |
| Normalize text | `htmltrust_normalize_text_v1` |
| Extract canonical HTML | `htmltrust_extract_canonical_text_options_v1` |
| Extract direct claims | `htmltrust_extract_claims_from_signed_section_v1` |
| Serialize claims | `htmltrust_canonicalize_claims_v1` |
| Canonicalize JSON | `htmltrust_canonicalize_json_document_v1` |
| Free output | `htmltrust_bytes_free` |

Every input has a pointer and byte length. Embedded NUL bytes are valid input.
A zero-length input may use a null pointer. The caller clears and owns output
pointers until it calls `htmltrust_bytes_free`.

Status `0` returns canonical UTF-8. Status `1` returns an allocated UTF-8
machine error code. Status `2` means an invalid ABI argument and allocates no
output. A Rust panic at the boundary becomes `core-internal-error`; process
abort and memory exhaustion remain process failures.

The direct-claims operation returns a UTF-8 JSON object containing the claims
read from direct children of the first signed section. It does not include
nested metadata. Its output uses the same status and ownership rules.

Each adapter validates ABI version 1 and all symbols it needs before use. An
application must keep the library path and artifact checksum with its release
configuration. The adapters do not search the current directory or a system
library path.

## Adapter startup

Go uses an absolute path. Supported Unix systems load it through cgo; Windows
AMD64 and ARM64 use Go's native Win32 loader:

```go
core, err := canonicalize.NewRustCore("/absolute/libhtmltrust_canonicalization_ffi.so")
if err != nil { return err }
defer core.Close()
```

Python uses the same path:

```python
from htmltrust_canonicalization import RustCore
core = RustCore("/absolute/libhtmltrust_canonicalization_ffi.so")
```

PHP needs `ext-ffi` and configures the process facade during startup:

```php
Canonicalize::configureRustCore(
    new RustCore('/absolute/libhtmltrust_canonicalization_ffi.so')
);
```

The web SAPI needs a system `ffi.enable=true` setting. CLI configuration must
also permit FFI calls.

JavaScript's Node package entry point initializes the packaged Node module
during import. Browser applications await `initializeBrowserWasm()` before
calling synchronous canonicalization methods:

```js
import { initializeBrowserWasm, normalizeText } from
  "@htmltrust/canonicalization/browser";

await initializeBrowserWasm();
const bytes = normalizeText("A—B");
```

The lower-level `rust-wasm` entry point exposes explicit Node and browser
initializers when an application controls module loading. Calls before a
successful initializer raise `rust-wasm-not-initialized`.

## Upgrade to 0.3

Version 0.3 removes the language-specific canonicalizers. Existing callers
need these changes:

| Language | Required caller change |
| --- | --- |
| JavaScript | Import the package's Node entry point, or initialize the browser or low-level WASM entry point before a canonicalization call. |
| Go | Construct `RustCore` and call canonicalization, signing-payload, and endorsement methods on it. Decode signed endorsements with `core.DecodeEndorsement`; ordinary `json.Unmarshal` returns an error. |
| Python | Construct `RustCore` with an absolute library path and call its methods. The former module-level canonicalization functions are gone. |
| PHP | Construct `RustCore` with an absolute library path and call `Canonicalize::configureRustCore` during startup. |

Go's endorsement decoding change prevents duplicate JSON members from being
discarded before Rust validates the signed document. The removed source files
remain available at tag `v0.2.2` and through normal Git history.

## Input and error rules

The v1 profile limits text, HTML, JSON, and nonempty base URLs to 1 MiB. A
missing base URL means that relative signed links cannot be resolved. The
source-snapshot layer resolves HTML `<base>` processing and passes the final
URL to the core.

Invalid UTF-8, unsupported parser controls, unsafe URLs, malformed claims, and
invalid JSON return stable machine codes. Adapters preserve those codes in
their language error types. Parser details stay out of the ABI error string.

The `preserveWhitespace` option is a compatibility field in native APIs. v1
callers use `false`; WebAssembly v1 does not accept the compatibility behavior.

## Artifacts and review

The native and mobile builders are documented in
[Platform artifacts](PLATFORM-ARTIFACTS.md). They use the same Rust core and
the same public header. CI artifacts are unsigned and unpublished. Signing,
notarization, release policy, mobile runtime tests, SwiftPM publication, and
Maven publication remain future release-matrix work.

The artifact directory contains:

| Path | Use |
| --- | --- |
| `libhtmltrust_canonicalization_ffi.so` | Linux dynamic C ABI in the current shared-core artifact layout |
| `libhtmltrust_canonicalization_ffi.a` | Static C ABI linking |
| `htmltrust_canonicalization.h` | Public declarations |
| `wasm-node/` | Node.js `wasm-bindgen` module and `.wasm` file |
| `wasm-web/` | Browser `wasm-bindgen` module and `.wasm` file |
| `npm-package/` | Staged npm package tree with both WASM layouts |
| `npm-dist/` | Tested npm tarball and checksum after `make test-docker` |
| `MANIFEST.txt` | ABI, toolchain, target, and checksums in the shared-core artifact layout |

Keep the native library and WebAssembly files from one build. Review the
manifest before publishing a package. Desktop archive manifests also record
source, toolchain, file size, and SHA-256 metadata. Mobile manifests describe
their ABI or slice outputs. The platform guide lists the exact archive files.

## Glossary

- **ABI:** The binary function contract between an adapter and the native library.
- **Artifact:** A built library, WebAssembly module, header, or manifest used by an adapter.
- **Canonical bytes:** Exact UTF-8 output used for hashing and signing.
- **WASM:** WebAssembly, the JavaScript runtime format in this release.

## Maintainer action

Run `make test-docker` after any core, ABI, artifact, or adapter change. When
reporting a failure, include the command, Linux amd64 details, tool versions,
`MANIFEST.txt`, and the complete error output in a GitHub issue. Review output
changes as protocol changes and add a conformance fixture for each changed
rule.

Related documents: [repository README](../README.md), [FFI README](../ffi/README.md),
and [conformance README](../conformance/README.md). The retained Git history
is available with `git log --oneline --all`; the previous protocol tag is
`v0.2.2`.
