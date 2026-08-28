<?php

namespace HTMLTrust\Canonicalization\Tests;

use HTMLTrust\Canonicalization\Canonicalize;
use InvalidArgumentException;
use PHPUnit\Framework\TestCase;

class CanonicalizeJcsTest extends TestCase
{
    public function testCanonicalizesRawDocument(): void
    {
        $this->assertSame(
            '{"a":1e+30,"b":4.5,"😀":2,"":1}',
            Canonicalize::canonicalizeJsonDocument('{"a":1e30,"b":4.50,"😀":2,"":1}')
        );
    }

    public function testNumberFormattingIgnoresSerializePrecision(): void
    {
        $previous = ini_get('serialize_precision');
        ini_set('serialize_precision', '3');
        try {
            $this->assertSame(
                '[0,5e-324,1e+23,0.000001,333333333.33333325]',
                Canonicalize::canonicalizeJsonDocument('[0,5e-324,1e23,1e-6,333333333.33333325]')
            );
        } finally {
            if ($previous !== false) ini_set('serialize_precision', $previous);
        }
    }

    public function testRejectsExcessiveJsonNesting(): void
    {
        $this->expectException(InvalidArgumentException::class);
        $this->expectExceptionMessage('resource-limit-exceeded');
        Canonicalize::canonicalizeJsonDocument(str_repeat('[', 257) . '0' . str_repeat(']', 257));
    }

    /** @dataProvider unsafeJsonProvider */
    public function testRejectsUnsafeRawDocument(string $document, string $reason): void
    {
        try {
            Canonicalize::canonicalizeJsonDocument($document);
            $this->fail('Expected strict JCS rejection');
        } catch (InvalidArgumentException $error) {
            $this->assertStringContainsString($reason, $error->getMessage());
        }
    }

    public static function unsafeJsonProvider(): array
    {
        return [
            ['{"a":1,"a":2}', 'jcs-duplicate-key'],
            ['"\\uD800"', 'jcs-invalid-surrogate'],
            ['{"n":1e400}', 'jcs-number'],
            ['{"n":-0}', 'jcs-number'],
            ['{"n":-1e-400}', 'jcs-number'],
            ['{"value":"\\uD800', 'jcs-invalid-json'],
        ];
    }
}
