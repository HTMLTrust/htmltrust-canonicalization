<?php

declare(strict_types=1);

namespace HTMLTrust\Canonicalization;

/** Explicit-path PHP FFI adapter for the Rust canonicalization core. */
final class RustCore
{
    public const ABI_VERSION = 1;
    private const MAX_OUTPUT_BYTES = 1024 * 1024;

    private const DECLARATIONS = <<<'CDEF'
        uint32_t htmltrust_abi_version_v1(void);
        int32_t htmltrust_normalize_text_v1(const uint8_t *, size_t, bool, uint8_t **, size_t *);
        int32_t htmltrust_extract_canonical_text_options_v1(const uint8_t *, size_t, const uint8_t *, size_t, bool, uint8_t **, size_t *);
        int32_t htmltrust_canonicalize_claims_v1(const uint8_t *, size_t, uint8_t **, size_t *);
        int32_t htmltrust_extract_claims_from_signed_section_v1(const uint8_t *, size_t, uint8_t **, size_t *);
        int32_t htmltrust_canonicalize_json_document_v1(const uint8_t *, size_t, uint8_t **, size_t *);
        void htmltrust_bytes_free(uint8_t *, size_t);
        CDEF;

    /** @var mixed FFI instance; PHP does not expose an application-safe type here. */
    private $ffi;

    public function __construct(string $libraryPath)
    {
        if ($libraryPath === '') {
            throw new \InvalidArgumentException('htmltrust Rust core library path must not be empty');
        }
        if (!self::isAbsolutePath($libraryPath)) {
            throw new \InvalidArgumentException('htmltrust Rust core library path must be absolute');
        }
        if (!class_exists('FFI')) {
            throw new \RuntimeException('PHP FFI extension is required for the Rust core adapter');
        }
        try {
            $this->ffi = \FFI::cdef(self::DECLARATIONS, $libraryPath);
            $version = (int) $this->ffi->htmltrust_abi_version_v1();
        } catch (\Throwable $error) {
            throw new \RuntimeException('unable to load the HTMLTrust Rust core: ' . $error->getMessage(), 0, $error);
        }
        if ($version !== self::ABI_VERSION) {
            throw new \RuntimeException("unsupported htmltrust Rust core ABI version {$version}; expected " . self::ABI_VERSION);
        }
    }

    public function abiVersion(): int
    {
        return (int) $this->ffi->htmltrust_abi_version_v1();
    }

    private static function isAbsolutePath(string $path): bool
    {
        return str_starts_with($path, '/')
            || str_starts_with($path, '\\\\')
            || preg_match('/^[A-Za-z]:[\\\\\\/]/D', $path) === 1;
    }

    public function normalizeText(string $text, bool $preserveWhitespace = false): string
    {
        [$input, $length] = $this->input($text);
        return $this->call(fn ($out, $outLength) => $this->ffi->htmltrust_normalize_text_v1(
            $input, $length, $preserveWhitespace, \FFI::addr($out), \FFI::addr($outLength)
        ));
    }

    public function extractCanonicalText(string $html, bool $preserveWhitespace = false, ?string $baseUrl = null): string
    {
        [$input, $length] = $this->input($html);
        [$base, $baseLength] = $baseUrl === null || $baseUrl === ''
            ? [$this->nullInput(), 0]
            : $this->input($baseUrl);
        return $this->call(fn ($out, $outLength) => $this->ffi->htmltrust_extract_canonical_text_options_v1(
            $input, $length, $base, $baseLength, $preserveWhitespace, \FFI::addr($out), \FFI::addr($outLength)
        ));
    }

    /** @param array<string|int, string> $claims */
    public function canonicalizeClaims(array $claims): string
    {
        foreach ($claims as $name => $value) {
            if ((!is_string($name) && !is_int($name)) || !is_string($value)) {
                throw new RustCoreError('claim-malformed');
            }
        }
        try {
            // Force object encoding: PHP turns numeric string keys into ints,
            // and an array-shaped JSON value is not a claims object.
            $json = json_encode((object) $claims, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        } catch (\Throwable $error) {
            throw new RustCoreError('claim-malformed', 1);
        }
        [$input, $length] = $this->input($json);
        return $this->call(fn ($out, $outLength) => $this->ffi->htmltrust_canonicalize_claims_v1(
            $input, $length, \FFI::addr($out), \FFI::addr($outLength)
        ));
    }

    /** @return array<string|int, string> */
    public function extractClaimsFromSignedSection(string $html): array
    {
        [$input, $length] = $this->input($html);
        $json = $this->call(fn ($out, $outLength) => $this->ffi->htmltrust_extract_claims_from_signed_section_v1(
            $input, $length, \FFI::addr($out), \FFI::addr($outLength)
        ));
        try {
            $claims = json_decode($json, true, 512, JSON_THROW_ON_ERROR);
        } catch (\Throwable $error) {
            throw new RustCoreError('invalid-output', 0);
        }
        if (!is_array($claims)) {
            throw new RustCoreError('invalid-output', 0);
        }
        foreach ($claims as $name => $value) {
            if ((!is_string($name) && !is_int($name)) || !is_string($value)) {
                throw new RustCoreError('invalid-output', 0);
            }
        }
        return $claims;
    }

    public function canonicalizeJsonDocument(string $document): string
    {
        [$input, $length] = $this->input($document);
        return $this->call(fn ($out, $outLength) => $this->ffi->htmltrust_canonicalize_json_document_v1(
            $input, $length, \FFI::addr($out), \FFI::addr($outLength)
        ));
    }

    /** @return array{mixed, int} */
    private function input(string $value): array
    {
        $length = strlen($value);
        $buffer = $this->ffi->new("uint8_t[" . max(1, $length) . "]");
        if ($length > 0) {
            \FFI::memcpy($buffer, $value, $length);
        }
        return [$buffer, $length];
    }

    private function nullInput()
    {
        return $this->ffi->cast('uint8_t *', 0);
    }

    /** @param callable(mixed, mixed): int $invoke */
    private function call(callable $invoke): string
    {
        $out = $this->ffi->new('uint8_t *');
        $outLength = $this->ffi->new('size_t');
        $status = (int) $invoke($out, $outLength);
        $length = (int) $outLength->cdata;
        try {
            if ($length < 0 || $length > self::MAX_OUTPUT_BYTES) {
                throw new RustCoreError('invalid-output', $status);
            }
            if ($length > 0 && \FFI::isNull($out)) {
                throw new RustCoreError('invalid-output', $status);
            }
            $data = $length === 0 ? '' : \FFI::string($out, $length);
            if ($status === 0) {
                return $data;
            }
            if ($status === 1) {
                throw new RustCoreError($data, $status);
            }
            throw new RustCoreError('invalid-argument', $status);
        } finally {
            if (!\FFI::isNull($out)) {
                $this->ffi->htmltrust_bytes_free($out, $length);
            }
        }
    }
}
