# HTMLTrust Canonicalization for Python

This package implements the Python binding for `htmltrust-c14n-v1`. It
normalizes text, extracts signed content from HTML, canonicalizes claims, and
canonicalizes raw JSON under RFC 8785. The same shared fixtures run against the
JavaScript, Go, PHP, and Rust bindings.

Version: `0.3.0` release candidate
Python: 3.10 or newer

## Optional Rust shared-core adapter

`RustCore` calls the same Rust implementation used by the native C ABI. Pass an
exact absolute path to the shared library. The constructor checks ABI version 1 and the
required symbols before returning a usable adapter:

```python
from htmltrust_canonicalization import RustCore

core = RustCore("/opt/htmltrust/libhtmltrust_canonicalization_ffi.so")
canonical = core.normalize_text("A—B")
```

From the repository root, `make test-shared-core` builds the current Linux
x86-64 library, tests this adapter, and prints the artifact directory.

The initial validation lane supports Linux x86-64. The independent Python
functions remain available for compatibility checks and environments without a
Rust artifact. See the [shared-core guide](../docs/RUST-SHARED-CORE.md) for
artifact pinning, ownership, and release requirements.

## Test a fresh checkout

From the repository root, Docker runs the Python unit tests and every shared
conformance fixture:

```sh
docker compose -f compose.test.yml run --rm python
```

Run `./scripts/test-in-docker.sh` to test all five language bindings.

## Install

Install the package from this checkout:

```sh
python3 -m pip install -e 'python[dev]'
```

For Python-only development from this directory:

```sh
python3 -m pip install -e '.[dev]'
python3 -m pytest -q
```

Runtime dependency versions are pinned in `pyproject.toml` because parser and
serializer behavior affects signed bytes.

## Public API

- `normalize_text(text, preserve_whitespace=False)` applies the Unicode and
  punctuation normalization profile. `preserve_whitespace=True` is a legacy
  0.2 compatibility mode and is outside v1.
- `extract_canonical_text(html, preserve_whitespace=False, base_url=None)`
  parses HTML and emits signed text plus semantic attribute records. v1
  callers must leave `preserve_whitespace` false.
- `canonicalize_claims(claims)` emits the sorted and escaped claims byte
  sequence.
- `extract_claims_from_signed_section(html)` reads direct-child claim metadata.
- `canonicalize_json_document(document)` validates and canonicalizes one raw
  JSON document with duplicate-key detection and IEEE 754 number handling.

Each entry point is deterministic and performs no network or file I/O. Text,
HTML, JSON, and nonempty base URL inputs are limited to 1 MiB. A limit breach
raises `ValueError("resource-limit-exceeded")`.

## Example

```python
from htmltrust_canonicalization import (
    canonicalize_claims,
    canonicalize_json_document,
    extract_canonical_text,
    normalize_text,
)

canonical = normalize_text('He said, "Hello…"')
assert canonical == 'He said, "Hello..."'

content = extract_canonical_text(
    '<p>Read <a href="/paper">the paper</a>.</p>',
    base_url='https://example.org/article',
)

claims = canonicalize_claims({'License': 'CC-BY-4.0'})
assert claims == 'License:CC-BY-4.0\n'

payload = canonicalize_json_document('{"z":0,"a":1e30}')
assert payload == '{"a":1e+30,"z":0}'
```

Relative `href` and `src` attributes require `base_url`. The v1 safe-URL
profile accepts HTTPS URLs and rejects credentials, control characters, and
unsupported schemes.

`base_url=None` and `base_url=''` both mean that no base URL was supplied.

The caller's source-snapshot layer must compute the document base URL using the
HTML Standard, including any `<base>` element, and pass that resolved URL as
`base_url`. This binding does not discover `<base>` elements itself; relative
signed URLs are rejected when no base URL is supplied.

## Package scope

Signature verification and key resolution live in the HTMLTrust client and
server packages. This binding produces the canonical byte sequences those
packages hash and sign.

The normative protocol text is maintained in the
[HTMLTrust specification](https://github.com/HTMLTrust/htmltrust-spec/tree/main/ietf-draft).
The repository's shared fixtures are the executable cross-language contract.
