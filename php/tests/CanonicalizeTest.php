<?php
/**
 * Tests for HTMLTrust Canonical Text Normalization.
 *
 * Uses the verification checklist from the spec.
 */

namespace HTMLTrust\Canonicalization\Tests;

use PHPUnit\Framework\TestCase;
use HTMLTrust\Canonicalization\Canonicalize;

class CanonicalizeTest extends TestCase
{
    /**
     * Test pairs from the spec verification checklist.
     *
     * @return array
     */
    public function specTestPairsProvider(): array
    {
        return [
            'Curly double quotes → straight' => [
                "\u{201C}Hello\u{201D}", '"Hello"', true,
            ],
            'Precomposed vs combining (NFKC)' => [
                "caf\u{00E9}", "cafe\u{0301}", true,
            ],
            'fi ligature (NFKC)' => [
                "\u{FB01}nd", 'find', true,
            ],
            'Em dash → hyphen-minus' => [
                "word \u{2014} word", 'word - word', true,
            ],
            'Guillemets → double quotes' => [
                "\u{00AB}Bonjour\u{00BB}", '"Bonjour"', true,
            ],
            'CJK corner brackets → double quotes' => [
                "\u{300C}\u{6771}\u{4EAC}\u{300D}", "\"\u{6771}\u{4EAC}\"", true,
            ],
            'ZWNJ is semantic (Persian)' => [
                "\u{0645}\u{06CC}\u{200C}\u{062E}\u{0648}\u{0627}\u{0647}\u{0645}",
                "\u{0645}\u{06CC}\u{062E}\u{0648}\u{0627}\u{0647}\u{0645}",
                false,
            ],
            'Arabic tatweel stripped' => [
                "\u{0643}\u{062A}\u{0640}\u{0640}\u{0640}\u{0627}\u{0628}",
                "\u{0643}\u{062A}\u{0627}\u{0628}",
                true,
            ],
            'Fullwidth ASCII (NFKC)' => [
                "\u{FF21}\u{FF11}", 'A1', true,
            ],
            'Circled digit (NFKC)' => [
                "\u{2460}", '1', true,
            ],
            'ZWSP stripped' => [
                "word\u{200B}word", 'wordword', true,
            ],
            'ZWNJ preserved (different)' => [
                "word\u{200C}word", 'wordword', false,
            ],
            'Ellipsis → three dots' => [
                "Hello\u{2026}", 'Hello...', true,
            ],
            'Curly single quotes → straight' => [
                "\u{2018}Hello\u{2019}", "'Hello'", true,
            ],
            'Low-9 quotes → straight' => [
                "\u{201A}German\u{201C}", '"German"', true,
            ],
            'No-break space → space' => [
                "a\u{00A0}b", 'a b', true,
            ],
            'Ideographic space → space' => [
                "a\u{3000}b", 'a b', true,
            ],
            'Whitespace collapse' => [
                "a  \t  b", 'a b', true,
            ],
        ];
    }

    /**
     * @dataProvider specTestPairsProvider
     */
    public function testSpecVerificationChecklist(string $inputA, string $inputB, bool $shouldMatch): void
    {
        $a = Canonicalize::normalizeText($inputA);
        $b = Canonicalize::normalizeText($inputB);

        if ($shouldMatch) {
            $this->assertSame($a, $b, "Expected normalized forms to match.\n  A: " . json_encode($a) . "\n  B: " . json_encode($b));
        } else {
            $this->assertNotSame($a, $b, "Expected normalized forms to differ.\n  A: " . json_encode($a) . "\n  B: " . json_encode($b));
        }
    }

    /**
     * Test the convenience normalize() method trims whitespace.
     */
    public function testNormalizeTrimming(): void
    {
        $this->assertSame('hello world', Canonicalize::normalize("  hello   world  "));
    }

    /**
     * Test preserveWhitespace option.
     */
    public function testPreserveWhitespace(): void
    {
        $result = Canonicalize::normalizeText("a   b\n\tc", true);
        // Whitespace should NOT be collapsed, but other normalizations apply
        $this->assertStringContainsString('   ', $result);
    }
}
