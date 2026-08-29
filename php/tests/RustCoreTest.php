<?php

declare(strict_types=1);

namespace HTMLTrust\Canonicalization\Tests;

use HTMLTrust\Canonicalization\RustCore;
use HTMLTrust\Canonicalization\RustCoreError;
use PHPUnit\Framework\TestCase;

final class RustCoreTest extends TestCase
{
    public function testPathMustBeExplicitAndNonEmpty(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new RustCore('');
    }

    public function testPathMustBeAbsolute(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('must be absolute');
        new RustCore('libhtmltrust_canonicalization_ffi.so');
    }

    public function testConstructorRejectsWrongAbiFixture(): void
    {
        if (PHP_OS_FAMILY !== 'Linux' || !class_exists('FFI')) {
            $this->markTestSkipped('Linux PHP FFI fixture is not supported');
        }
        $path = getenv('HTMLTRUST_RUST_CORE_WRONG_ABI_LIB');
        if (!is_string($path) || $path === '') {
            $this->markTestSkipped('HTMLTRUST_RUST_CORE_WRONG_ABI_LIB is not set');
        }
        $this->expectExceptionMessage('unsupported htmltrust Rust core ABI version 999');
        new RustCore($path);
    }

    public function testConstructorRejectsMissingOperationFixture(): void
    {
        if (PHP_OS_FAMILY !== 'Linux' || !class_exists('FFI')) {
            $this->markTestSkipped('Linux PHP FFI fixture is not supported');
        }
        $path = getenv('HTMLTRUST_RUST_CORE_MISSING_OPERATION_LIB');
        if (!is_string($path) || $path === '') {
            $this->markTestSkipped('HTMLTRUST_RUST_CORE_MISSING_OPERATION_LIB is not set');
        }
        $this->expectExceptionMessage('htmltrust_canonicalize_json_document_v1');
        new RustCore($path);
    }

    public function testAllOperationsAndEdgeInputs(): void
    {
        if (!class_exists('FFI')) {
            $this->markTestSkipped('ext-ffi is not installed');
        }
        $path = getenv('HTMLTRUST_RUST_CORE_LIB');
        if (!is_string($path) || $path === '') {
            $this->markTestSkipped('HTMLTRUST_RUST_CORE_LIB is not set');
        }
        $core = new RustCore($path);
        self::assertSame('A-B', $core->normalizeText('A—B'));
        self::assertSame("a\0b", $core->normalizeText("a\0b"));
        self::assertSame('', $core->normalizeText(''));
        self::assertSame('A', $core->extractCanonicalText('<p>A</p>', false, null));
        self::assertSame('A', $core->extractCanonicalText('<p>A</p>', false, ''));
        self::assertSame('A', $core->extractCanonicalText('<p>A</p>', false, 'https://example.com/'));
        self::assertSame("a:1\nz:2\n", $core->canonicalizeClaims(['z' => '2', 'a' => '1']));
        self::assertSame('', $core->canonicalizeClaims([]));
        self::assertSame('{"a":1,"z":0}', $core->canonicalizeJsonDocument('{"z":0,"a":1}'));
    }

    public function testClaimsNumericNameIsEncodedAsAnObject(): void
    {
        if (!class_exists('FFI')) {
            $this->markTestSkipped('ext-ffi is not installed');
        }
        $path = getenv('HTMLTRUST_RUST_CORE_LIB');
        if (!is_string($path) || $path === '') {
            $this->markTestSkipped('HTMLTRUST_RUST_CORE_LIB is not set');
        }
        $core = new RustCore($path);
        self::assertSame("0:value\n", $core->canonicalizeClaims(['0' => 'value']));
    }

    public function testInvalidJcsErrorIsMapped(): void
    {
        if (!class_exists('FFI')) {
            $this->markTestSkipped('ext-ffi is not installed');
        }
        $path = getenv('HTMLTRUST_RUST_CORE_LIB');
        if (!is_string($path) || $path === '') {
            $this->markTestSkipped('HTMLTRUST_RUST_CORE_LIB is not set');
        }
        $core = new RustCore($path);
        $this->expectException(RustCoreError::class);
        $this->expectExceptionMessage('jcs-invalid-json');
        $core->canonicalizeJsonDocument('{');
    }

    public function testLoneSurrogateJcsErrorIsMapped(): void
    {
        if (!class_exists('FFI')) {
            $this->markTestSkipped('ext-ffi is not installed');
        }
        $path = getenv('HTMLTRUST_RUST_CORE_LIB');
        if (!is_string($path) || $path === '') {
            $this->markTestSkipped('HTMLTRUST_RUST_CORE_LIB is not set');
        }
        $core = new RustCore($path);
        $this->expectException(RustCoreError::class);
        $this->expectExceptionMessage('jcs-invalid-surrogate');
        $core->canonicalizeJsonDocument('"\\uD800"');
    }
}
