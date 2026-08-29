# Use the Rust shared core for canonical HTMLTrust bytes

- **Author:** HTMLTrust maintainers
- **Date:** 2026-08-29
- **Version:** 0.1 implementation decision
- **Reading time:** 6 minutes
- **Written for:** binding maintainers, package maintainers, and application integrators
- **Status:** core and adapters implemented; release packaging remains

## Decision

Rust owns the executable implementation of the `htmltrust-c14n-v1` byte
contract. JavaScript calls it through WebAssembly. Go, Python, and PHP call the
same code through a versioned C application binary interface (ABI). Rust
applications call the crate directly.

The IETF draft remains the normative protocol text. The Rust core is the
reference implementation that releases must execute. Shared fixtures remain
the reviewable examples of the protocol rules.

Independent language implementations stay in this repository during the
migration. They provide compatibility coverage and an independent check on the
specification. They do not define expected output for new fixtures.

## Why this decision matters

Study 1 tested 4,846 Common Crawl News regions. The independent ports agreed on
acceptance or rejection for 4,777 regions, or 98.6 percent. Adapters backed by
one Rust core agreed for all 4,846 regions. All 174 regions accepted by every
shared-core adapter produced matching digests.

Canonical bytes are protocol data. A one-byte difference can invalidate a
stored hash or signature. One executable core removes parser, Unicode, URL, and
JSON drift from the language boundary.

## Warning before integration

Treat the native library and WebAssembly module as release artifacts. Pin their
version and checksum. A wrapper must reject an ABI version it does not support.

The initial native validation lane targets Linux on x86-64. PHP also needs its
FFI extension enabled. Go builds need cgo. Browser and extension packages need
a locally packaged WebAssembly file and an explicit startup step. These limits
must appear in any package release notes.

## The boundary

The shared core performs four deterministic, offline operations:

1. Normalize UTF-8 text.
2. Extract canonical text from HTML with an explicit document base URL.
3. Serialize a JSON object of string claims.
4. Canonicalize one strict JSON document.

Signing, signature verification, key resolution, revocation checks, and
endorsement processing remain language-native. Those operations involve
platform cryptography or network policy. They consume bytes produced by the
shared core.

```text
IETF protocol text
        |
shared fixtures
        |
Rust canonicalization crate
   |                 |
C ABI v1        WebAssembly v1
   |                 |
Go  Python  PHP    JavaScript
        |
hashing, signing, verification, and resolution in each application
```

## Native ABI v1

The public header is [`ffi/include/htmltrust_canonicalization.h`](../ffi/include/htmltrust_canonicalization.h).
ABI version 1 exposes these operations:

| Operation | Symbol |
| --- | --- |
| Read ABI version | `htmltrust_abi_version_v1` |
| Normalize text | `htmltrust_normalize_text_v1` |
| Extract HTML | `htmltrust_extract_canonical_text_options_v1` |
| Serialize claims | `htmltrust_canonicalize_claims_v1` |
| Canonicalize JSON | `htmltrust_canonicalize_json_document_v1` |
| Release output | `htmltrust_bytes_free` |

Every input uses a pointer and a byte length. Inputs may contain an embedded
NUL byte. A null pointer with a zero length represents an empty input. A
zero-length optional base URL means no base URL with either a null or non-null
pointer.

Every operation initializes valid output fields before reading input. Status
`0` returns canonical UTF-8. Status `1` returns an allocated UTF-8 error code.
Status `2` reports an invalid ABI argument and allocates no output. The caller
must release every allocated result with `htmltrust_bytes_free`.

The ABI catches an unwinding Rust panic and returns `core-internal-error` with
status `1`. Builds must retain panic unwinding for this behavior. Process aborts
and memory exhaustion remain process failures.

## Language adapters

Each adapter keeps its language's normal error style and requires an explicit
artifact during this migration:

| Language | Adapter contract |
| --- | --- |
| Rust | Call the checked crate functions directly. |
| JavaScript | Initialize `rust-wasm` once, then call its synchronous methods. |
| Go | Open an exact native-library path with `NewRustCore`, then close it. |
| Python | Construct `RustCore` with an exact native-library path. |
| PHP | Construct the Rust-core adapter with an exact native-library path. |

Absolute paths make artifact selection visible in application configuration.
The adapters do not search the current directory or a system library path.

The public adapters apply the same edge-input contract:

- A null or empty base URL means that no base URL was supplied. Relative
  signed URLs then fail because they cannot be resolved.
- HTML input and a nonempty base URL each have a 1 MiB ceiling.
- Raw HTML parser controls are rejected as `parser-profile-unsupported`.
  Horizontal tab, line feed, form feed, and carriage return remain accepted
  whitespace.
- ABI and adapter errors expose one bare machine code. Parser diagnostics are
  kept out of the returned code.
- Invalid Unicode in a claims map is `claim-malformed`. A lone surrogate in a
  raw JCS string is `jcs-invalid-surrogate` when the surrounding JSON is valid.

Whitespace preservation is a 0.2 compatibility option in native adapters. It
is outside `htmltrust-c14n-v1`; v1 signing callers use `false`. The JavaScript
WASM v1 normalization entry point rejects `preserveWhitespace: true`.

## Current artifact status

| Consumer | Validated path | Current limit |
| --- | --- | --- |
| Rust | Direct crate API on Rust 1.86 | Crate release is still pending. |
| Node.js | Packed npm adapter plus generated `wasm-bindgen` module | The generated module remains a separate artifact. |
| Go | C ABI on Linux x86-64 with cgo | No released static-link or bundled-library strategy yet. |
| Python | Wheel-installed adapter plus C ABI on Linux x86-64 | No platform wheel contains the native library yet. |
| PHP | Composer-installed adapter plus C ABI on Linux x86-64 with `ext-ffi` | A web SAPI needs `ffi.enable=true`; no native PHP extension or bundled library exists yet. |

The maintained build currently produces a Linux x86-64 native artifact and a
Node.js WebAssembly artifact. Browser WebAssembly output, macOS, Windows, ARM,
and package-bundled native artifacts are not release-supported yet.

## Migration sequence

### Phase 1: complete the core interface (complete)

- Expose all four operations through C ABI v1 and WebAssembly v1.
- Contain Rust panics at the C boundary.
- Publish a C header and stable ownership rules.

### Phase 2: prove every adapter (complete in repository validation)

- Run all four fixture suites through Rust, JavaScript, Go, Python, and PHP.
- Test embedded NUL input, empty buffers, bad UTF-8, missing symbols, and ABI
  mismatch.
- Build the native and WebAssembly artifacts in a pinned container.

### Phase 3: package supported platforms (remaining)

- Publish checksummed native artifacts for each supported operating system and
  architecture.
- Publish a WebAssembly package for Node.js and browsers.
- Add Python wheels. Decide whether PHP ships a native extension or documents
  FFI as an advanced deployment.
- Define the cgo link strategy for released Go applications.

### Phase 4: migrate applications (remaining)

- Move the browser client and extension to the WebAssembly adapter.
- Move server, Hugo, and CMS integrations to their shared-core adapters.
- Keep the independent ports in conformance CI until two stable releases have
  completed the migration.

## Release gates

Repository validation now covers these gates:

- The Rust crate and ABI tests run with the minimum supported Rust version.
- Every adapter runs all four fixture suites against one built artifact.
- Startup tests reject missing symbols and an unsupported ABI version.
- Native artifacts record their target, toolchain, checksum, and ABI version.

These gates remain before a published release can call the shared core
authoritative for deployed applications:

- Package-install tests must load the native or WebAssembly artifact from its
  final installed package layout.
- A downstream browser build and one native application must complete their
  normal integration tests.
- Fuzzing must cover the four byte-oriented ABI functions and the strict JSON
  claims input.
- Each additional operating system and architecture needs its own pinned build,
  checksum, and adapter test lane.

Platform support must be stated as an explicit matrix. A package must fail at
startup with a stable error when its artifact or ABI is unavailable.

## What maintainers need to do

Core maintainers own canonical output, error codes, the ABI, and release
artifacts. Binding maintainers own marshaling, package installation, and
language-specific errors. Application maintainers own artifact pinning and
startup initialization.

Before merging a core change, run the repository Docker test entry point. Add
or update fixtures whenever output or an error code changes. Review any output
change as a protocol-version decision.

## Related documents

- [`README.md`](../README.md), for checkout, install, and test commands.
- [`ffi/README.md`](../ffi/README.md), for native and WebAssembly build details.
- [`conformance/README.md`](../conformance/README.md), for fixture format and review rules.
- `htmltrust-study1/results/v03/README.md`, for the independent-port and shared-core measurements in the sibling study repository.
- [HTMLTrust IETF draft](https://github.com/HTMLTrust/htmltrust-spec/tree/main/ietf-draft), for the normative protocol text.
