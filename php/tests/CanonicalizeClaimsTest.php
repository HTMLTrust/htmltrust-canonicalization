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
        $this->assertSame("a=2\nm=3\nz=1", Canonicalize::canonicalizeClaims($claims));
    }

    public function testNormalizesNamesAndValues(): void
    {
        // Curly quotes in either name or value should be straightened before
        // serialization, so equivalent metadata produces an equivalent hash.
        $claims = ['title' => "\u{201C}Hello\u{201D}"];
        $this->assertSame('title="Hello"', Canonicalize::canonicalizeClaims($claims));
    }

    public function testStringifiesNonStringValues(): void
    {
        $claims = ['count' => 42, 'flag' => true];
        // PHP coerces true to "1", 42 to "42".
        $this->assertSame("count=42\nflag=1", Canonicalize::canonicalizeClaims($claims));
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
