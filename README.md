# HTMLTrust Canonicalization

HTMLTrust Canonicalization turns HTML and text into one stable byte sequence.
Use that sequence before hashing or signing content. The JavaScript, Go, PHP,
Python, and Rust bindings share the same fixtures and protocol rules.
The normative rules are maintained in the
[HTMLTrust IETF draft](https://github.com/HTMLTrust/htmltrust-spec/tree/main/ietf-draft).
The local [`spec.md`](spec.md) records the earlier text-only design for
historical reference.

Status: `0.3.0` release candidate for `htmltrust-c14n-v1`
Previous protocol release: `v0.2.2` (`79b0d52fecd958f8fc7ade713fe0799ca1e79626`)
Readers: binding users and contributors

## Test a fresh checkout

Docker is the shortest path to a complete result. This command installs each
binding in its own container, runs its unit tests, then checks every shared
fixture:

```sh
git clone https://github.com/HTMLTrust/htmltrust-canonicalization.git
cd htmltrust-canonicalization
./scripts/test-in-docker.sh
```

The script keeps dependency caches in Docker volumes scoped to the checkout's
absolute path. Concurrent worktrees do not share Cargo or language caches. Set
`HTMLTRUST_TEST_SESSION_ID` when concurrent test processes share one checkout.
Set `HTMLTRUST_CARGO_TARGET_MOUNT` to an absolute host directory when Cargo
artifacts must live outside Docker's volume store.

## Install a binding

Choose the binding that matches your application. Each binding declares its
runtime dependencies in its own manifest.

| Binding | Directory | Runtime requirements |
|---|---|---|
| JavaScript | [`javascript/`](javascript/) | Node.js 22 or newer; `parse5` is installed from `package.json` |
| Go | [`go/`](go/) | Go 1.25 or newer; dependencies are resolved from `go.mod` |
| PHP | [`php/`](php/) | PHP 8.5 or newer with `dom`, `intl`, `mbstring`, `json`, `openssl`, and `sodium`; Composer |
| Python | [`python/`](python/) | Python 3.10 or newer; dependencies include `pywhatwgurl` and `rfc8785` |
| Rust | [`rust/`](rust/) | Rust 1.86 or newer; Cargo uses the committed `Cargo.lock` |

### JavaScript

The root package is the installable package. From a checkout, install its
declared dependency and run a direct import:

```sh
npm ci
node --input-type=module -e \
  'import { normalizeText } from "./javascript/index.js"; console.log(normalizeText("A—B"))'
```

During the `0.3.0` review, another project can install the current main branch:

```sh
npm install github:HTMLTrust/htmltrust-canonicalization#main
```

### Go

```sh
cd go
go mod download
go test ./...
```

### PHP

```sh
cd php
composer install --no-interaction
composer test
```

The PHP API uses PHP 8.5's `Uri\WhatWg\Url` implementation for signed URL
attributes. Older PHP versions do not satisfy the package requirement.

### Python

```sh
python3 -m pip install -e 'python[dev]'
python3 -m pytest -q python/tests
```

### Rust

```sh
cargo test --locked --manifest-path rust/Cargo.toml
```

## Run the conformance suite

The conformance suite is the cross-language contract. It reads every JSON
fixture under `conformance/fixtures/` and compares the exact output from each
available runner.

```sh
make conformance
```

The command reports a missing toolchain as `MISSING` and continues with the
other runners. Require all five bindings in CI or before a release:

```sh
REQUIRE_ALL_LANGUAGES=1 make conformance
```

The current fixture count is derived at run time. To inspect it without
running the bindings:

```sh
find conformance/fixtures -mindepth 2 -maxdepth 2 -type f -name '*.json' | wc -l
```

See [`conformance/README.md`](conformance/README.md) for fixture format,
expected errors, and the review process for new cases.

## What gets canonicalized

`normalizeText` applies these phases in order:

1. Unicode NFKC normalization.
2. Unicode whitespace conversion to ASCII spaces, with runs collapsed.
3. Curly, guillemet, and CJK quotation marks converted to ASCII quotes.
4. Dash and hyphen variants converted to ASCII hyphen-minus.
5. The ellipsis character converted to three periods.
6. Invisible formatting and bidirectional-control characters removed.
7. ZWNJ and ZWJ preserved because they can carry meaning.

The `preserveWhitespace`/`preserve_whitespace` option is retained for 0.2
compatibility. It is outside the v1 profile, whose callers must use the
default `false` value; v1 does not bind verbatim whitespace inside `<pre>`.

`extractCanonicalText` parses HTML, excludes metadata and executable
elements, emits boundaries for block elements, and normalizes signed
`href`, `src`, `alt`, and `aria-label` attributes. Relative `href` and `src`
values require the document base URL. The portable profile rejects source
nesting deeper than 256 elements before canonical traversal.

The canonicalizer does not discover or apply an HTML `<base>` element. The
source-snapshot layer must compute the document base URL using the HTML
Standard, use the final response URL as its fallback, and pass that resolved
URL to the binding. A relative signed URL without that input is rejected.

`canonicalizeClaims` sorts claim names by UTF-8 byte order, normalizes names and
values, and returns the byte sequence used for signing. The JSON
canonicalization helper applies strict RFC 8785-style serialization to a raw
JSON document.

JavaScript, Go, and PHP expose v1 signing-payload helpers. These functions
derive URL or origin scope, validate the exact UTC timestamp form, and return
the RFC 8785 signing bytes. The older colon-joined binding helpers remain
available for 0.2 compatibility.

## Development container

Open the repository in a Dev Container to get Node.js, Go, PHP, Python, and
Rust. `.devcontainer/setup.sh` installs the root JavaScript package, Python
test dependencies, PHP Composer dependencies, and Cargo modules. The setup
script is safe to run again after a dependency change.

## Release and compatibility

Canonical output is protocol data. A change to it requires updates to every
binding and to the conformance fixtures in one change. Consumers that need
the previous published protocol can pin tag `v0.2.2` or commit
`79b0d52fecd958f8fc7ade713fe0799ca1e79626`. Release `0.3.0` contains the
normative v1 parser, URL, resource-limit, and JCS behavior. Tag it after all
five binding jobs pass.

Go callers must now handle the error returned by `CanonicalizeClaims`.
`CanonicalizeClaimsStrict` remains as an alias with the same fail-closed
behavior.

Related repositories:

- [HTMLTrust specification](https://github.com/HTMLTrust/htmltrust-spec)
- [Reference server](https://github.com/HTMLTrust/htmltrust-server-reference)
- [Reference browser extension](https://github.com/HTMLTrust/htmltrust-browser-reference)
- [Reference CMS plugins](https://github.com/HTMLTrust/htmltrust-cms-reference)

## License

This project is licensed under the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0).
