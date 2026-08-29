# HTMLTrust Canonicalization for PHP

This Composer package implements `htmltrust-c14n-v1` and includes an optional
FFI adapter for the Rust shared core.

- Version: `0.3.0` release candidate
- PHP: 8.5 or newer

## Install and test a checkout

The required PHP extensions are listed in `composer.json`.

```sh
cd php
composer install --no-interaction
composer test
```

## Independent PHP API

```php
<?php

require __DIR__ . '/vendor/autoload.php';

use HTMLTrust\Canonicalization\Canonicalize;

$text = Canonicalize::normalizeText('A—B');
$content = Canonicalize::extractCanonicalText(
    '<a href="/paper">Paper</a>',
    false,
    'https://example.org/article',
);
$claims = Canonicalize::canonicalizeClaims(['License' => 'CC-BY-4.0']);
$json = Canonicalize::canonicalizeJsonDocument('{"z":0,"a":1}');
```

A null or empty base URL means that no base URL was supplied. A nonempty base
URL has a 1 MiB UTF-8 ceiling.

## Rust shared-core adapter

The adapter also requires `ext-ffi`. PHP's default `ffi.enable=preload` setting
allows the direct constructor in CLI processes. Calling it from a web SAPI
requires a system-level `ffi.enable=true` setting. Read the
[PHP FFI runtime configuration](https://www.php.net/manual/en/ffi.configuration.php)
before enabling it in a server process.

The maintained native lane uses Linux x86-64. From the repository root, build
the library and run all adapter fixtures:

```sh
make test-shared-core
```

Use the absolute library path printed by that command:

```php
<?php

require __DIR__ . '/vendor/autoload.php';

use HTMLTrust\Canonicalization\RustCore;

$core = new RustCore('/path/to/libhtmltrust_canonicalization_ffi.so');
$text = $core->normalizeText('A—B');
```

Construction checks ABI version 1 and every required operation. The adapter
does not search the current directory or the system library path.

See the [shared-core guide](../docs/RUST-SHARED-CORE.md) for artifact ownership
and the current platform matrix.
