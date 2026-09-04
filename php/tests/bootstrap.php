<?php

declare(strict_types=1);

require dirname(__DIR__) . '/vendor/autoload.php';

use HTMLTrust\Canonicalization\Canonicalize;
use HTMLTrust\Canonicalization\RustCore;

$libraryPath = getenv('HTMLTRUST_RUST_CORE_LIB');
if (is_string($libraryPath) && $libraryPath !== '') {
    Canonicalize::configureRustCore(new RustCore($libraryPath));
}
