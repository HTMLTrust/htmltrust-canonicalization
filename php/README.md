# HTMLTrust Canonicalization for PHP

This Composer package provides PHP access to the Rust implementation of
`htmltrust-c14n-v1`. Rust is the sole canonicalization implementation. PHP
loads the versioned C ABI through FFI and an explicit absolute library path.

**Author:** HTMLTrust contributors

**Date:** 2026-08-29

**Version:** 0.3.0 release candidate

**Status:** Linux amd64 FFI validation lane

**Readers:** PHP developers and service integrators

**Reading time:** 3 minutes

## Prerequisites and shortest test

Install PHP 8.5 or newer, Composer, `ext-ffi`, and `ext-uri`. PHP 8.5 ships the
URI extension used by the signing helpers. The maintained native lane is Linux
amd64. Build the Rust artifact, install dependencies, and run the full Composer
suite with its absolute library path:

```sh
make core-artifacts
cd php
composer install --no-interaction
HTMLTRUST_RUST_CORE_LIB=/absolute/path/to/libhtmltrust_canonicalization_ffi.so \
  composer test
```

The complete Docker path performs the same setup and checks the installed
package layout:

```sh
make test-docker
```

## Configure at startup

Applications must create one `RustCore` handle and configure the facade during
process startup. The path must be absolute:

```php
<?php

require __DIR__ . '/vendor/autoload.php';

use HTMLTrust\Canonicalization\Canonicalize;
use HTMLTrust\Canonicalization\RustCore;

$libraryPath = '/absolute/path/to/libhtmltrust_canonicalization_ffi.so';
Canonicalize::configureRustCore(new RustCore($libraryPath));

$text = Canonicalize::normalizeText('A—B');
$content = Canonicalize::extractCanonicalText(
    '<a href="/paper">Paper</a>',
    false,
    'https://example.org/article',
);
$claims = Canonicalize::canonicalizeClaims(['License' => 'CC-BY-4.0']);
$found = Canonicalize::extractClaimsFromSignedSection(
    '<signed-section><meta name="claim:License" content="CC-BY-4.0"></signed-section>'
);
```

`Canonicalize` raises `htmltrust-rust-core-not-configured` until startup
configuration succeeds. `RustCore` checks ABI version 1 and every required
operation while it loads the library. It does not search the current directory
or system library paths.

PHP's web SAPI needs a system `ffi.enable=true` setting. Confirm the setting
before deploying a service. The test bootstrap reads
`HTMLTRUST_RUST_CORE_LIB` and calls `Canonicalize::configureRustCore` for the
Composer suite.

## Input and errors

Text, HTML, JSON, and nonempty base URLs have a 1 MiB limit. A missing base URL
means relative signed links cannot be resolved. The caller passes the
resolved document URL. Stable Rust error codes are preserved in the adapter's
exceptions.

The direct claim method reads metadata from direct children of the first signed
section. Signing, verification, key resolution, and network policy belong to
the consuming HTMLTrust application.

## Artifacts, package, and history

Run `make core-artifacts` to create the native library, public header, Node and
browser WebAssembly directories, and `MANIFEST.txt`. Keep the PHP library and
manifest from one build. See the [shared-core guide](../docs/RUST-SHARED-CORE.md),
[FFI README](../ffi/README.md), and [conformance README](../conformance/README.md).

The retained Git history includes the previous protocol tag `v0.2.2`, available
with `git show v0.2.2`. Report failures with the command, target, PHP version,
artifact manifest, and complete output in a GitHub issue.
