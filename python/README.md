# HTMLTrust Canonicalization for Python

This package provides Python access to the Rust implementation of
`htmltrust-c14n-v1`. Rust is the sole canonicalization implementation. Python
loads the versioned C ABI through `RustCore` and an explicit absolute library
path.

**Author:** HTMLTrust contributors

**Date:** 2026-08-29

**Version:** 0.3.0 release candidate

**Status:** Linux amd64 native-library validation lane

**Readers:** Python developers and application integrators

**Reading time:** 3 minutes

## Prerequisites and shortest test

Install Python 3.10 or newer. Build the Rust artifact, install the package's
development dependencies, then run tests with the absolute library path:

```sh
make core-artifacts
python3 -m pip install -e 'python[dev]'
HTMLTRUST_RUST_CORE_LIB=/absolute/path/to/libhtmltrust_canonicalization_ffi.so \
  python3 -m pytest -q python/tests
```

The complete Docker path builds the artifact and runs the package and
conformance checks:

```sh
make test-docker
```

## Use `RustCore`

Pass the exact absolute path to the native library. Construction checks ABI
version 1 and every required operation before returning a usable adapter.

```python
from htmltrust_canonicalization import RustCore

core = RustCore("/absolute/path/to/libhtmltrust_canonicalization_ffi.so")
text = core.normalize_text("A—B")
content = core.extract_canonical_text(
    '<a href="/paper">Paper</a>',
    base_url="https://example.org/article",
)
claims = core.canonicalize_claims({"License": "CC-BY-4.0"})
found = core.extract_claims_from_signed_section(
    '<signed-section><meta name="claim:License" content="CC-BY-4.0"></signed-section>'
)
document = core.canonicalize_json_document('{"z":0,"a":1}')
```

`HTMLTRUST_RUST_CORE_LIB` is the required integration and conformance setting.
The adapter does not search the current directory, environment paths, or a
system library path. Application configuration should select the library and
its `MANIFEST.txt` from one reviewed build.

## Input and error behavior

Text, HTML, JSON, and nonempty base URLs have a 1 MiB limit. A missing base URL
means relative signed links cannot be resolved. The source-snapshot layer
passes the resolved document URL. Adapter failures raise `RustCoreError` or a
Python `ValueError` with the stable machine error code.

The package's direct claim method reads metadata from direct children of the
first signed section. Signing, verification, key resolution, and network
policy belong to the consuming HTMLTrust application.

## Conformance and history

The vector generator also needs the same library setting:

```sh
HTMLTRUST_RUST_CORE_LIB=/absolute/path/to/libhtmltrust_canonicalization_ffi.so \
  python tools/gen-test-vectors.py --check
```

See the [root README](../README.md), [shared-core guide](../docs/RUST-SHARED-CORE.md),
and [conformance README](../conformance/README.md). The maintained native lane
is Linux amd64. The retained Git history includes `v0.2.2`, available with
`git show v0.2.2`.

Report failures with the command, target, tool versions, artifact manifest,
and complete output in a GitHub issue.
