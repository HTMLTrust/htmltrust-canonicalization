<?php
/**
 * Tests for HTMLTrust canonical claims serialization.
 */

namespace HTMLTrust\Canonicalization\Tests;

use PHPUnit\Framework\TestCase;
use HTMLTrust\Canonicalization\Canonicalize;

class CanonicalizeClaimsTest extends TestCase
{
    public function testSortsLexicographicallyByName(): void
    {
        $claims = ['z' => '1', 'a' => '2', 'm' => '3'];
        $this->assertSame("a:2\nm:3\nz:1\n", Canonicalize::canonicalizeClaims($claims));
    }

    public function testNormalizesNamesAndValues(): void
    {
        // Curly quotes in either name or value should be straightened before
        // serialization, so equivalent metadata produces an equivalent hash.
        $claims = ['title' => "\u{201C}Hello\u{201D}"];
        $this->assertSame("title:\"Hello\"\n", Canonicalize::canonicalizeClaims($claims));
    }

    public function testRejectsNonStringValues(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('claim-malformed');
        Canonicalize::canonicalizeClaims(['count' => 42]);
    }

    /** @dataProvider invalidUtf8ClaimProvider */
    public function testRejectsInvalidUtf8ClaimFieldsAsMalformed(array $claims): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('claim-malformed');
        Canonicalize::canonicalizeClaims($claims);
    }

    public static function invalidUtf8ClaimProvider(): array
    {
        return [
            'invalid name' => [["bad\xFF" => 'value']],
            'invalid value' => [['name' => "bad\xFF"]],
        ];
    }

    public function testEmptyClaimsProducesEmptyString(): void
    {
        $this->assertSame('', Canonicalize::canonicalizeClaims([]));
    }

    public function testStableUnderInputOrdering(): void
    {
        $a = Canonicalize::canonicalizeClaims(['b' => '1', 'a' => '2', 'c' => '3']);
        $b = Canonicalize::canonicalizeClaims(['c' => '3', 'a' => '2', 'b' => '1']);
        $this->assertSame($a, $b);
    }
}
