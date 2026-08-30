# Cross-language conformance

This directory defines the byte-level contract for HTMLTrust
Canonicalization. Rust produces the canonical result. The JavaScript, Go,
Python, and PHP runners load the Rust artifact and compare their adapter
output with the checked-in fixtures.

**Author:** HTMLTrust contributors

**Date:** 2026-08-29

**Version:** 0.3.0 release candidate

**Status:** Required for core and adapter changes

**Readers:** Binding contributors and release reviewers

**Reading time:** 4 minutes

## Run the suite

Docker builds Rust and the FFI library before starting the adapter services:

```sh
./scripts/test-in-docker.sh
```

This is the supported complete path. For a local run, build artifacts first and
set both paths:

```sh
make core-artifacts
export HTMLTRUST_RUST_CORE_LIB=/absolute/path/to/libhtmltrust_canonicalization_ffi.so
export HTMLTRUST_WASM_PKG=/absolute/path/to/wasm-node/htmltrust_canonicalization_ffi.js
make conformance
```

`make conformance` requires Rust, Node.js, Go with cgo, Python, PHP with FFI,
and the configured artifacts. A missing toolchain or artifact is an error.
Per-language commands are `make conformance-js`, `make conformance-go`,
`make conformance-php`, `make conformance-python`, and
`make conformance-rust`.

The Python vector check uses the same `HTMLTRUST_RUST_CORE_LIB` path:

```sh
HTMLTRUST_RUST_CORE_LIB=/absolute/path/to/libhtmltrust_canonicalization_ffi.so \
  python tools/gen-test-vectors.py --check
```

## Fixture format

Fixtures live under `fixtures/normalize`, `fixtures/extract`,
`fixtures/claims`, and `fixtures/jcs`. Each file has a matching `name`, an
`input`, and either `expected` or a stable `error` code.

```json
{
  "name": "curly-double-quotes",
  "description": "Curly quotes become ASCII quotation marks.",
  "input": "“Hello”",
  "expected": "\"Hello\""
}
```

`baseURL` supplies the resolved document URL for relative HTML links. `repeat`
tests resource limits without storing a large input. Use `\\uXXXX` escapes
when a fixture depends on an invisible or combining code point. Error values
are machine codes such as `resource-limit-exceeded` and
`url-policy-violation`.

The four fixture suites cover text normalization, HTML extraction, claims
serialization, and strict JSON canonicalization. Adapter unit tests cover the
direct-claims operation, which reads metadata from direct children of the
first signed section.

## Update a fixture

Rust is the source for expected bytes. After changing a rule, run:

```sh
make conformance-update
```

The update requires the Rust toolchain and configured native and Node WASM
artifacts. Inspect every changed fixture, then run `make test-docker` before
submitting the change. A fixture expected value must never hide an adapter
disagreement.

## Runner output

Each runner reports the fixture path and result:

```text
PASS conformance/fixtures/normalize/basic-ascii.json
PASS conformance/fixtures/extract/url-http-rejected.json  (expected error url-policy-violation)
```

Exit status `0` means every fixture passed. Exit status `1` means output or an
expected error differed. Other statuses identify a runner or setup failure.

## Repository layout

```text
conformance/
  fixtures/{normalize,extract,claims,jcs}/
  runners/run-javascript.mjs
  runners/run-go.go
  runners/run-php.php
  runners/run-python.py
  runners/run-rust/
```

The runners import the checkout under review. They do not download a released
package. The maintained native test lane is Linux amd64. The same artifact
directory also contains `wasm-node/` and `wasm-web/` for JavaScript package
layout checks.

For a failure, report the command, target, tool versions, artifact
`MANIFEST.txt`, fixture path, and complete output in a GitHub issue. See the
[shared-core guide](../docs/RUST-SHARED-CORE.md) for ABI and ownership rules.
