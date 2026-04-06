<?php
/**
 * HTMLTrust Canonical Text Normalization
 *
 * Implements all 8 phases of the HTMLTrust canonicalization spec.
 * Requires PHP 7.2+ with the intl extension (for Normalizer::normalize).
 *
 * Spec: https://github.com/ArcadeLabsInc/htmltrust-canonicalization
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
        '/[\x{2018}\x{2019}\x{201A}\x{201B}\x{2039}\x{203A}\x{0060}\x{00B4}\x{2032}]/u';

    /**
     * Phase 3: Double quotes → U+0022 QUOTATION MARK.
     */
    private const DOUBLE_QUOTE_PATTERN =
        '/[\x{201C}\x{201D}\x{201E}\x{201F}\x{00AB}\x{00BB}\x{2033}\x{301D}\x{301E}\x{301F}]/u';

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
}
