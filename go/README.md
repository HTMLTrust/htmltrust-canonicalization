# HTMLTrust Canonicalization for Go

This module provides the Go adapter for the Rust implementation of
`htmltrust-c14n-v1`. Rust is the sole canonicalization implementation. The Go
package loads its versioned C ABI from an explicit native library path.

**Author:** HTMLTrust contributors

**Date:** 2026-08-30

**Version:** 0.3.0 release candidate

**Status:** Desktop C ABI adapter

**Readers:** Go developers and service integrators

**Reading time:** 3 minutes

## Prerequisites and shortest test

Install Go 1.25 or newer. Unix builds also need cgo and a C compiler. Windows
AMD64 and ARM64 use the native Win32 loader and work with `CGO_ENABLED=0`.
Build the Rust library first, then run the package tests with its absolute
path:

```sh
make core-artifacts
export HTMLTRUST_RUST_CORE_LIB=/absolute/path/to/libhtmltrust_canonicalization_ffi.so
cd go
go mod download
go test ./...
```

The complete Docker path performs this setup automatically:

```sh
make test-docker
```

## Use the adapter

Construct `RustCore` with the exact absolute native library path. Construction
checks ABI version 1 and every required symbol. Close the handle when the
application no longer needs it.

```go
core, err := canonicalize.NewRustCore(
    "/absolute/path/to/libhtmltrust_canonicalization_ffi.so",
)
if err != nil {
    return err
}
defer core.Close()

baseURL := "https://example.org/article"
text, err := core.NormalizeText("A—B", false)
content, err := core.ExtractCanonicalText(
    `<a href="/paper">Paper</a>`, false, &baseURL,
)
claims, err := core.CanonicalizeClaims(map[string]string{"License": "CC-BY-4.0"})
jsonBytes, err := core.CanonicalizeJSONDocument([]byte(`{"z":0,"a":1}`))
```

The package also exposes direct claim extraction, signing payload, and
endorsement methods on the same handle. Handle every returned error before
hashing or signing bytes. `HTMLTRUST_RUST_CORE_LIB` is the integration setting
used by tests and conformance runners.

Endorsements must be decoded with `core.DecodeEndorsement`. Calling
`json.Unmarshal` directly on `Endorsement` returns an error because standard
JSON decoding cannot enforce the duplicate-key and canonical JSON checks used
for signed data:

```go
endorsement, err := core.DecodeEndorsement(documentBytes)
if err != nil {
    return err
}
```

The adapter does not search the executable directory, current directory, or
system library paths. The library and its `MANIFEST.txt` should be selected by
application configuration as one reviewed artifact set.

## Platform artifacts

The primary desktop runtime targets are Linux, macOS, and Windows on x86_64
and ARM64. Linux i686 and Windows i686 are C ABI compatibility lanes. Use the
target-specific archive from the [platform artifact guide](../docs/PLATFORM-ARTIFACTS.md)
and pass its absolute native library path to `NewRustCore`.

On supported Unix systems, the adapter uses cgo with `dlopen` and `dlsym`.
Windows AMD64 and ARM64 use `LoadLibraryW` and `GetProcAddress` through Go's
native Windows support. The Go adapter does not support Windows i686; that
archive is for direct C ABI consumers.

The adapter does not choose or download an archive. Keep the archive's
`manifest.json` and checksum beside the application release configuration.
CI artifacts are unsigned and unpublished. Android, iOS, and JavaScript have
separate package layouts described in the platform guide.

## C ABI behavior

The adapter uses length-based C functions. Inputs can contain NUL bytes. Status
and ownership follow the [shared-core guide](../docs/RUST-SHARED-CORE.md):
status `0` is canonical UTF-8, status `1` is a stable machine error, status
`2` is an invalid ABI argument. Rust output buffers are released through the
library's free function.

The v1 profile limits text, HTML, JSON, and nonempty base URLs to 1 MiB. A
missing base URL cannot resolve relative signed links. The caller supplies the
resolved document URL.

## Package and support

For a reviewed application release, pin the module to a reviewed tag or full
commit. The repository keeps its earlier Git history, including protocol tag
`v0.2.2`, which can be inspected with `git show v0.2.2`.

See the [root README](../README.md), [FFI README](../ffi/README.md), and
[conformance README](../conformance/README.md). Report a failure with the
command, target, tool versions, artifact manifest, and complete output in a
GitHub issue.
