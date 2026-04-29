<?php
/**
 * Tests for HTMLTrust HTML -> canonical text extraction.
 */

namespace HTMLTrust\Canonicalization\Tests;

use PHPUnit\Framework\TestCase;
use HTMLTrust\Canonicalization\Canonicalize;

class ExtractCanonicalTextTest extends TestCase
{
    public function testStripsScriptStyleAndContents(): void
    {
        $html = '<p>Hello</p><script>alert("x")</script><style>p{color:red}</style><p>World</p>';
        $this->assertSame('Hello World', Canonicalize::extractCanonicalText($html));
    }

    public function testStripsMetaInsideSignedSection(): void
    {
        // Inside a signed-section, <meta> carries claim metadata, not content.
        $html = '<meta name="signed-at" content="2025-01-01T00:00Z"><p>Body</p>';
        $this->assertSame('Body', Canonicalize::extractCanonicalText($html));
    }

    public function testBlockBoundariesBecomeSpaces(): void
    {
        $html = '<p>A</p><p>B</p>';
        $this->assertSame('A B', Canonicalize::extractCanonicalText($html));
    }

    public function testInlineTagsDoNotAddSpaces(): void
    {
        // <p>hello <em>world</em></p> should canonicalize to "hello world"
        // — no separator inside the inline boundary.
        $html = '<p>hello <em>world</em></p>';
        $this->assertSame('hello world', Canonicalize::extractCanonicalText($html));
    }

    public function testDecodesNamedEntities(): void
    {
        $html = '<p>AT&amp;T &mdash; &ldquo;hello&rdquo;</p>';
        // mdash and curly quotes get normalized away by the text pipeline.
        $this->assertSame('AT&T - "hello"', Canonicalize::extractCanonicalText($html));
    }

    public function testDecodesNumericEntities(): void
    {
        // &#65; -> A, &#x42; -> B
        $html = '<p>&#65;&#x42;C</p>';
        $this->assertSame('ABC', Canonicalize::extractCanonicalText($html));
    }

    public function testNormalizationPipelineApplied(): void
    {
        // Curly quotes from HTML attribute-free content should be straightened.
        $html = "<p>\u{201C}Hello\u{201D}</p>";
        $this->assertSame('"Hello"', Canonicalize::extractCanonicalText($html));
    }

    public function testHandlesNestedInlineMarkup(): void
    {
        $html = '<p>This is <strong>very <em>important</em></strong>.</p>';
        $this->assertSame('This is very important.', Canonicalize::extractCanonicalText($html));
    }

    public function testStripsLinksButPreservesText(): void
    {
        $html = '<p>See <a href="https://example.com">our site</a> now.</p>';
        $this->assertSame('See our site now.', Canonicalize::extractCanonicalText($html));
    }

    public function testStripsImagesEntirely(): void
    {
        $html = '<p>Before<img src="x.png" alt="x">After</p>';
        // Void <img> stripped (becomes a space). Then inline text concatenates,
        // and whitespace collapses.
        $this->assertSame('Before After', Canonicalize::extractCanonicalText($html));
    }

    public function testEmptyAndAllMarkup(): void
    {
        $this->assertSame('', Canonicalize::extractCanonicalText(''));
        $this->assertSame('', Canonicalize::extractCanonicalText('<div></div>'));
    }
}
