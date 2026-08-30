<?php

declare(strict_types=1);

namespace HTMLTrust\Canonicalization;

/** Error returned by the versioned Rust canonicalization ABI. */
final class RustCoreError extends \InvalidArgumentException
{
    public function __construct(
        public readonly string $canonicalCode,
        public readonly int $status = 1,
    ) {
        parent::__construct($canonicalCode);
    }
}
