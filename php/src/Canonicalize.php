<?php
/**
 * HTMLTrust Canonical Text Normalization
 *
 * Implements all 8 phases of the HTMLTrust canonicalization spec.
 * Requires PHP 7.2+ with the intl extension (for Normalizer::normalize).
 *
 * Spec: https://github.com/HTMLTrust/htmltrust-canonicalization
 *
 * @package HTMLTrust\Canonicalization
 */

namespace HTMLTrust\Canonicalization;

class Canonicalize
{
    /**
     * Phase 6+7: Invisible/formatting/bidi characters to strip.
     * Preserves ZWNJ (U+200C) and ZWJ (U+200D) — semantic in Persian, Indic, emoji.
     */
    private const STRIP_PATTERN =
        '/[\x{00AD}\x{200B}\x{200E}\x{200F}\x{2060}\x{FEFF}\x{034F}\x{061C}\x{180E}\x{0640}'
        . '\x{FE00}-\x{FE0F}'
        . '\x{202A}-\x{202E}'
        . '\x{2066}-\x{2069}'
        . '\x{2061}-\x{2064}'
        . '\x{FFF9}-\x{FFFC}'
        . '\x{E0001}-\x{E007F}'
        . '\x{E0100}-\x{E01EF}'
        . ']/u';

    /**
     * Phase 2: All Unicode whitespace → U+0020.
     */
    private const WHITESPACE_PATTERN =
        '/[\x{0009}-\x{000D}\x{0020}\x{0085}\x{00A0}\x{1680}\x{2000}-\x{200A}'
        . '\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}]/u';

    /**
     * Phase 3: Single quotes → U+0027 APOSTROPHE.
     */
    private const SINGLE_QUOTE_PATTERN =
        '/[\x{2018}\x{2019}\x{201B}\x{2039}\x{203A}\x{0060}\x{00B4}\x{2032}]/u';

    /**
     * Phase 3: Double quotes → U+0022 QUOTATION MARK.
     */
    private const DOUBLE_QUOTE_PATTERN =
        '/[\x{201A}\x{201C}\x{201D}\x{201E}\x{201F}\x{00AB}\x{00BB}\x{2033}\x{301D}\x{301E}\x{301F}]/u';

    /**
     * Phase 3: CJK quotation marks → U+0022.
     */
    private const CJK_QUOTE_PATTERN =
        '/[\x{300C}\x{300D}\x{300E}\x{300F}\x{FE41}-\x{FE44}]/u';

    /**
     * Phase 4: Dashes → U+002D HYPHEN-MINUS (includes minus sign U+2212).
     */
    private const DASH_PATTERN =
        '/[\x{2010}-\x{2015}\x{2212}\x{FE58}\x{FE63}]/u';

    /**
     * Phase 5: Ellipsis → three periods.
     */
    private const ELLIPSIS_PATTERN = '/\x{2026}/u';

    /**
     * Normalize text content for canonical signing.
     *
     * Apply AFTER extracting text from DOM, BEFORE hashing.
     *
     * Implements all 8 phases of the HTMLTrust canonicalization spec:
     *   1. NFKC normalization
     *   2. Whitespace normalization
     *   3. Quotation mark normalization
     *   4. Dash/hyphen normalization
     *   5. Other punctuation normalization
     *   6. Strip invisible/formatting characters
     *   7. Bidi control removal (handled by phase 6)
     *   8. Language-specific handling (NFKC + preserve ZWNJ/ZWJ)
     *
     * @param string $text Raw text content.
     * @param bool   $preserveWhitespace Set true for <pre> content.
     * @return string Normalized text.
     */
    public static function normalizeText(string $text, bool $preserveWhitespace = false): string
    {
        // Phase 1: Unicode NFKC normalization.
        // Handles ligatures, fullwidth/halfwidth, presentation forms,
        // superscripts, CJK compatibility, Jamo composition, etc.
        if (class_exists('Normalizer')) {
            $text = \Normalizer::normalize($text, \Normalizer::FORM_KC);
        }

        // Phase 6+7: Strip invisible/formatting/bidi characters.
        $text = preg_replace(self::STRIP_PATTERN, '', $text);

        // Phase 2: Whitespace normalization.
        if (!$preserveWhitespace) {
            $text = preg_replace(self::WHITESPACE_PATTERN, ' ', $text);
            $text = preg_replace('/ {2,}/', ' ', $text);
        }

        // Phase 3: Quotation mark normalization.
        $text = preg_replace(self::SINGLE_QUOTE_PATTERN, "'", $text);
        $text = preg_replace(self::DOUBLE_QUOTE_PATTERN, '"', $text);
        $text = preg_replace(self::CJK_QUOTE_PATTERN, '"', $text);

        // Phase 4: Dash and hyphen normalization.
        $text = preg_replace(self::DASH_PATTERN, '-', $text);

        // Phase 5: Other punctuation.
        $text = preg_replace(self::ELLIPSIS_PATTERN, '...', $text);

        return $text;
    }

    /**
     * Convenience: normalize and trim.
     *
     * @param string $text Raw text content.
     * @return string Normalized, trimmed text.
     */
    public static function normalize(string $text): string
    {
        return trim(self::normalizeText($text));
    }

    // ====================================================================
    // HTML -> canonical text extraction.
    //
    // Mirrors the JS reference implementation in javascript/index.js. The
    // regexes below are written to be as close to the JS source as PCRE
    // syntax allows, so the two implementations should agree byte-for-byte
    // on well-formed CMS-style input.
    // ====================================================================

    /**
     * Elements whose text content is NEVER part of the signed content.
     * These are stripped (with their contents) before extracting text.
     * `<meta>` is excluded because inside a signed-section it carries claim
     * metadata, not signed content.
     */
    private const EXCLUDED_ELEMENTS_PATTERN =
        '#<(script|style|meta|link|head|noscript)\b[^>]*>[\s\S]*?</\1\s*>'
        . '|<(meta|link|br|hr|img|input|source|track|wbr)\b[^>]*/?>(?!\s*</\2>)#i';

    /**
     * Self-closing/void elements that carry no text content.
     */
    private const VOID_ELEMENTS_PATTERN =
        '#<(meta|link|br|hr|img|input|source|track|wbr|area|base|col|embed|param)\b[^>]*/?>#i';

    /**
     * Block-level element names whose boundaries become whitespace separators.
     * Inline elements (em, strong, a, span, ...) do NOT get separators.
     */
    private const BLOCK_ELEMENT_NAMES =
        'address|article|aside|blockquote|canvas|dd|div|dl|dt|fieldset|figcaption'
        . '|figure|footer|form|h[1-6]|header|hr|li|main|nav|noscript|ol|output|p'
        . '|pre|section|table|tfoot|thead|tr|td|th|ul|video';

    /**
     * Any remaining HTML tag (inline elements stripped without adding whitespace).
     */
    private const ANY_TAG_PATTERN = '#</?[a-z][a-z0-9-]*\b[^>]*>#i';

    /**
     * HTML named-entity decoding table. Numeric entities are handled separately.
     *
     * @var array<string, string>
     */
    private const NAMED_ENTITIES = [
        '&amp;'    => '&',
        '&lt;'     => '<',
        '&gt;'     => '>',
        '&quot;'   => '"',
        '&apos;'   => "'",
        '&nbsp;'   => "\u{00A0}",
        '&ndash;'  => "\u{2013}",
        '&mdash;'  => "\u{2014}",
        '&lsquo;'  => "\u{2018}",
        '&rsquo;'  => "\u{2019}",
        '&ldquo;'  => "\u{201C}",
        '&rdquo;'  => "\u{201D}",
        '&hellip;' => "\u{2026}",
        '&copy;'   => "\u{00A9}",
        '&reg;'    => "\u{00AE}",
        '&trade;'  => "\u{2122}",
    ];

    /**
     * Decode HTML entities (named + numeric decimal + numeric hex).
     */
    private static function decodeEntities(string $text): string
    {
        // Named entities (case-insensitive lookup).
        $text = preg_replace_callback(
            '/&[a-z]+;/i',
            static function (array $m): string {
                $key = strtolower($m[0]);
                return self::NAMED_ENTITIES[$key] ?? $m[0];
            },
            $text
        );

        // Numeric decimal entities.
        $text = preg_replace_callback(
            '/&#(\d+);/',
            static function (array $m): string {
                return self::codepointToUtf8((int) $m[1]);
            },
            $text
        );

        // Numeric hex entities.
        $text = preg_replace_callback(
            '/&#x([0-9a-f]+);/i',
            static function (array $m): string {
                return self::codepointToUtf8((int) hexdec($m[1]));
            },
            $text
        );

        return $text;
    }

    /**
     * Convert a Unicode codepoint to a UTF-8 string. Mirrors
     * String.fromCodePoint() semantics: out-of-range codepoints produce
     * an empty string rather than throwing.
     */
    private static function codepointToUtf8(int $cp): string
    {
        if ($cp < 0 || $cp > 0x10FFFF) {
            return '';
        }
        // mb_chr is the cleanest portable path; it exists when ext-mbstring
        // is loaded (a hard composer.json requirement).
        $chr = mb_chr($cp, 'UTF-8');
        return $chr === false ? '' : $chr;
    }

    /**
     * Extract canonical text from an HTML fragment for signing or verification.
     *
     * Mirrors javascript/index.js:extractCanonicalText. See spec §2.1.
     *
     * @param string $html HTML fragment to canonicalize.
     * @param bool   $preserveWhitespace Forwarded to normalizeText (use true
     *               for `<pre>` content that must retain whitespace).
     * @return string Canonical text, ready to be hashed.
     */
    public static function extractCanonicalText(string $html, bool $preserveWhitespace = false): string
    {
        // Step 1: Strip excluded elements and their contents.
        $text = preg_replace(self::EXCLUDED_ELEMENTS_PATTERN, ' ', $html);
        $text = preg_replace(self::VOID_ELEMENTS_PATTERN, ' ', $text);

        // Step 2: Convert block boundaries to whitespace.
        $blockOpen  = '#<(' . self::BLOCK_ELEMENT_NAMES . ')\b[^>]*>#i';
        $blockClose = '#</(' . self::BLOCK_ELEMENT_NAMES . ')\s*>#i';
        $text = preg_replace($blockOpen, ' ', $text);
        $text = preg_replace($blockClose, ' ', $text);

        // Step 3: Strip any remaining (inline) tags.
        $text = preg_replace(self::ANY_TAG_PATTERN, '', $text);

        // Step 4: Decode HTML entities.
        $text = self::decodeEntities($text);

        // Step 5: Apply full text normalization, then trim.
        return trim(self::normalizeText($text, $preserveWhitespace));
    }

    /**
     * Compute a canonical claims string from a name->value map.
     *
     * Claims are serialized as a sorted list of "name=value" pairs, joined
     * by newlines. Both names and values are pushed through normalizeText so
     * that visually-equivalent representations (e.g. NFKC variants, curly vs
     * straight quotes) hash identically.
     *
     * Mirrors javascript/index.js:canonicalizeClaims.
     *
     * @param array<string, scalar|\Stringable> $claims
     * @return string Canonical serialized string ready to be hashed.
     */
    public static function canonicalizeClaims(array $claims): string
    {
        $entries = [];
        foreach ($claims as $name => $value) {
            $entries[] = [
                self::normalizeText((string) $name),
                self::normalizeText((string) $value),
            ];
        }

        // Sort by canonicalized name (lexicographic, byte order — matches JS
        // string comparison for ASCII names; both sides should normalize
        // the same way for non-ASCII names).
        usort($entries, static function (array $a, array $b): int {
            return strcmp($a[0], $b[0]);
        });

        $lines = [];
        foreach ($entries as [$name, $value]) {
            $lines[] = $name . '=' . $value;
        }
        return implode("\n", $lines);
    }
}
