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

require_once __DIR__ . '/Entities.php';

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
     * Boundary-producing element names. A boundary-producing element emits a
     * line feed after its descendants have contributed text. Inline elements
     * (em, strong, a, span, ...) do NOT get separators.
     */
    private const BLOCK_ELEMENT_NAMES =
        'address|article|aside|blockquote|details|dialog|div|dl|fieldset|figcaption'
        . '|figure|footer|form|h[1-6]|header|hgroup|hr|li|main|nav|ol|p'
        . '|pre|section|table|tr|td|th|ul';

    /**
     * Any remaining HTML tag (inline elements stripped without adding whitespace).
     */
    private const ANY_TAG_PATTERN = '#</?[a-z][a-z0-9-]*\b[^>]*>#i';

    /**
     * Full HTML5 named-entity table lives in Entities::NAMED (generated by
     * tools/gen-entities.py). Lookups are case-sensitive per the HTML Living
     * Standard.
     *
     * windows-1252 mapping for numeric references in the C1 range (0x80-0x9F),
     * per the HTML5 "numeric character reference end" state.
     *
     * @var array<int, int>
     */
    private const C1_REPLACEMENTS = [
        0x80 => 0x20AC, 0x82 => 0x201A, 0x83 => 0x0192, 0x84 => 0x201E, 0x85 => 0x2026,
        0x86 => 0x2020, 0x87 => 0x2021, 0x88 => 0x02C6, 0x89 => 0x2030, 0x8A => 0x0160,
        0x8B => 0x2039, 0x8C => 0x0152, 0x8E => 0x017D, 0x91 => 0x2018, 0x92 => 0x2019,
        0x93 => 0x201C, 0x94 => 0x201D, 0x95 => 0x2022, 0x96 => 0x2013, 0x97 => 0x2014,
        0x98 => 0x02DC, 0x99 => 0x2122, 0x9A => 0x0161, 0x9B => 0x203A, 0x9C => 0x0153,
        0x9E => 0x017E, 0x9F => 0x0178,
    ];

    /**
     * Apply the HTML5 numeric-reference rules: null/out-of-range/surrogate
     * collapse to U+FFFD; C1 controls map via windows-1252; else the literal
     * code point.
     */
    private static function numericCharRef(int $n): string
    {
        if ($n === 0 || $n > 0x10FFFF || ($n >= 0xD800 && $n <= 0xDFFF)) {
            return "\u{FFFD}";
        }
        if (isset(self::C1_REPLACEMENTS[$n])) {
            $n = self::C1_REPLACEMENTS[$n];
        }
        return self::codepointToUtf8($n);
    }

    /**
     * Decode HTML entities (named + numeric decimal + numeric hex).
     */
    private static function decodeEntities(string $text): string
    {
        // Named references (case-sensitive, semicolon-terminated).
        $text = preg_replace_callback(
            '/&[a-zA-Z][a-zA-Z0-9]*;/',
            static function (array $m): string {
                return Entities::NAMED[$m[0]] ?? $m[0];
            },
            $text
        );

        // Numeric decimal references.
        $text = preg_replace_callback(
            '/&#([0-9]+);/',
            static function (array $m): string {
                return self::numericCharRef((int) $m[1]);
            },
            $text
        );

        // Numeric hex references.
        $text = preg_replace_callback(
            '/&#[xX]([0-9a-fA-F]+);/',
            static function (array $m): string {
                return self::numericCharRef((int) hexdec($m[1]));
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
     * @param string|null $baseUrl Signed document URL used to resolve relative
     *               href/src signed semantic attributes.
     * @return string Canonical text, ready to be hashed.
     */
    public static function extractCanonicalText(string $html, bool $preserveWhitespace = false, ?string $baseUrl = null): string
    {
        $parts = [];
        $index = 0;
        $excludedDepth = 0;
        $tokenPattern = '#<!--[\s\S]*?-->|<![^>]*>|</?[a-z][a-z0-9-]*(?:\s[^<>]*)?\s*/?>#i';
        preg_match_all($tokenPattern, $html, $matches, PREG_OFFSET_CAPTURE);

        foreach ($matches[0] as $match) {
            [$token, $offset] = $match;
            if ($offset > $index && $excludedDepth === 0) {
                self::appendCanonicalPart(
                    $parts,
                    self::normalizeText(self::decodeEntities(substr($html, $index, $offset - $index)), $preserveWhitespace)
                );
            }
            $index = $offset + strlen($token);

            if (!preg_match('#^</?\s*([a-z][a-z0-9-]*)#i', $token, $nameMatch)) {
                continue;
            }
            $name = strtolower($nameMatch[1]);
            $trimmed = trim($token);
            $closing = strpos($trimmed, '</') === 0;
            $selfClosing = preg_match('#/\s*>$#', $trimmed) === 1 || self::isVoidElement($name);
            $excluded = self::isExcludedElement($name);

            if ($closing) {
                if ($excluded && $excludedDepth > 0) {
                    $excludedDepth--;
                    continue;
                }
                if ($excludedDepth > 0) {
                    continue;
                }
                if (self::isBlockElement($name)) {
                    self::appendCanonicalPart($parts, "\n");
                }
                continue;
            }

            if ($excluded) {
                if (!$selfClosing) {
                    $excludedDepth++;
                }
                continue;
            }
            if ($excludedDepth > 0) {
                continue;
            }

            self::appendAttributeRecords($parts, $name, self::parseAttributes($token), $baseUrl);
            if ($name === 'br') {
                self::appendCanonicalPart($parts, "\n");
            }
            if ($selfClosing && self::isBlockElement($name)) {
                self::appendCanonicalPart($parts, "\n");
            }
        }

        if ($index < strlen($html) && $excludedDepth === 0) {
            self::appendCanonicalPart(
                $parts,
                self::normalizeText(self::decodeEntities(substr($html, $index)), $preserveWhitespace)
            );
        }

        return self::finalizeCanonicalParts($parts);
    }

    /**
     * @param array<int, string> $parts
     */
    private static function appendCanonicalPart(array &$parts, string $value): void
    {
        if ($value !== '') {
            $parts[] = $value;
        }
    }

    /**
     * @param array<int, string> $parts
     */
    private static function finalizeCanonicalParts(array $parts): string
    {
        $text = implode('', $parts);
        while (strpos($text, '  ') !== false) {
            $text = str_replace('  ', ' ', $text);
        }
        $text = preg_replace('/[ \t]*\n[ \t]*/', "\n", $text);
        while (strpos($text, "\n\n") !== false) {
            $text = str_replace("\n\n", "\n", $text);
        }
        return trim($text, " \n");
    }

    /**
     * @return array<string, string>
     */
    private static function parseAttributes(string $token): array
    {
        $body = preg_replace('#^</?\s*[a-z][a-z0-9-]*#i', '', $token);
        $body = preg_replace('#/?>$#', '', trim($body));
        preg_match_all(
            '#([^\s"\'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s"\'=<>`]+)))?#',
            $body,
            $matches,
            PREG_SET_ORDER
        );
        $attrs = [];
        foreach ($matches as $m) {
            $value = $m[2] ?? $m[3] ?? $m[4] ?? '';
            $attrs[strtolower($m[1])] = self::decodeEntities($value);
        }
        return $attrs;
    }

    /**
     * @param array<int, string> $parts
     * @param array<string, string> $attrs
     */
    private static function appendAttributeRecords(array &$parts, string $elementName, array $attrs, ?string $baseUrl): void
    {
        foreach (['href', 'src', 'alt', 'aria-label'] as $attrName) {
            if (!array_key_exists($attrName, $attrs)) {
                continue;
            }
            $value = $attrs[$attrName];
            if ($attrName === 'href' || $attrName === 'src') {
                if ($baseUrl === null && !preg_match('#^[a-z][a-z0-9+.-]*:#i', $value)) {
                    // Relative URL with no base cannot be resolved: MUST fail
                    // rather than silently skip (draft §4.3.2).
                    throw new \InvalidArgumentException('attribute-canonicalization-failed');
                }
                $value = self::normalizeUrlAttribute($value, $baseUrl);
            } else {
                $value = trim(self::normalizeText($value));
            }
            if (strpos($value, "\n") !== false) {
                throw new \InvalidArgumentException('attribute-canonicalization-failed');
            }
            if (!empty($parts)) {
                $last = $parts[count($parts) - 1];
                if ($last !== '' && substr($last, -1) !== ' ' && substr($last, -1) !== "\n") {
                    $parts[] = "\n";
                }
            }
            $parts[] = '@attr:' . $elementName . ':' . $attrName . ':' . $value . "\n";
        }
    }

    private static function normalizeUrlAttribute(string $value, ?string $baseUrl): string
    {
        $value = trim($value);
        if (preg_match('#^[a-z][a-z0-9+.-]*:#i', $value)) {
            $absolute = $value;
        } elseif ($baseUrl !== null) {
            $absolute = self::resolveUrl($value, $baseUrl);
        } else {
            throw new \InvalidArgumentException('attribute-canonicalization-failed');
        }

        $parts = parse_url($absolute);
        if ($parts === false || empty($parts['scheme'])) {
            throw new \InvalidArgumentException('attribute-canonicalization-failed');
        }
        if (empty($parts['host'])) {
            // Opaque URL with no authority (mailto:, tel:, javascript:, data:,
            // about:, sms:, ...). The WHATWG URL parser accepts these; serialize
            // scheme + opaque remainder verbatim (scheme lowercased), matching
            // new URL().href. No host/port/dot-segment normalization applies.
            $colon = strpos($absolute, ':');
            return strtolower(substr($absolute, 0, $colon)) . ':' . substr($absolute, $colon + 1);
        }
        $scheme = strtolower($parts['scheme']);
        $host = strtolower($parts['host']);
        // IDNA/punycode non-ASCII hosts to match the WHATWG URL serializer.
        if (preg_match('/[^\x00-\x7F]/', $host)) {
            $ascii = idn_to_ascii($host, IDNA_DEFAULT, INTL_IDNA_VARIANT_UTS46);
            if ($ascii === false) {
                throw new \InvalidArgumentException('attribute-canonicalization-failed');
            }
            $host = $ascii;
        }
        $port = isset($parts['port']) ? (int) $parts['port'] : null;
        $authority = $host;
        if ($port !== null && !(($scheme === 'http' && $port === 80) || ($scheme === 'https' && $port === 443))) {
            $authority .= ':' . $port;
        }
        $path = self::removeDotSegments($parts['path'] ?? '/');
        if ($path === '') {
            $path = '/';
        }
        $query = isset($parts['query']) ? '?' . $parts['query'] : '';
        $fragment = isset($parts['fragment']) ? '#' . $parts['fragment'] : '';
        return $scheme . '://' . $authority . $path . $query . $fragment;
    }

    /**
     * RFC 3986 §5.2.4 remove_dot_segments, matching the WHATWG URL path
     * normalization the reference JS/Rust bindings perform via `new URL`.
     */
    private static function removeDotSegments(string $path): string
    {
        $out = '';
        $in = $path;
        while ($in !== '') {
            if (strpos($in, '../') === 0) {
                $in = substr($in, 3);
            } elseif (strpos($in, './') === 0) {
                $in = substr($in, 2);
            } elseif (strpos($in, '/./') === 0) {
                $in = '/' . substr($in, 3);
            } elseif ($in === '/.') {
                $in = '/';
            } elseif (strpos($in, '/../') === 0) {
                $in = '/' . substr($in, 4);
                $pos = strrpos($out, '/');
                $out = $pos !== false ? substr($out, 0, $pos) : '';
            } elseif ($in === '/..') {
                $in = '/';
                $pos = strrpos($out, '/');
                $out = $pos !== false ? substr($out, 0, $pos) : '';
            } elseif ($in === '.' || $in === '..') {
                $in = '';
            } else {
                $start = strpos($in, '/') === 0 ? 1 : 0;
                $slash = strpos($in, '/', $start);
                if ($slash === false) {
                    $out .= $in;
                    $in = '';
                } else {
                    $out .= substr($in, 0, $slash);
                    $in = substr($in, $slash);
                }
            }
        }
        return $out;
    }

    /**
     * Resolve a relative reference against a base URL using the RFC 3986 §5.2
     * transform-reference algorithm (the same algorithm the JS/Go/Python/Rust
     * bindings get from `new URL` / `ResolveReference` / `urljoin`). The naive
     * "strip last segment and append" resolver this replaces mishandled
     * fragment-only (`#x`), query-only (`?x`), and empty references, silently
     * truncating the path.
     */
    private static function resolveUrl(string $relative, string $baseUrl): string
    {
        $b = parse_url($baseUrl);
        if ($b === false || empty($b['scheme']) || empty($b['host'])) {
            throw new \InvalidArgumentException('attribute-canonicalization-failed');
        }
        $r = parse_url($relative);
        if ($r === false) {
            throw new \InvalidArgumentException('attribute-canonicalization-failed');
        }
        $bAuthority = strtolower($b['host'])
            . (isset($b['port']) ? ':' . (int) $b['port'] : '');
        $bPath = $b['path'] ?? '';

        if (isset($r['host'])) {
            // Protocol-relative //host/path form.
            $authority = strtolower($r['host']) . (isset($r['port']) ? ':' . (int) $r['port'] : '');
            $path = self::removeDotSegments($r['path'] ?? '');
            $query = $r['query'] ?? null;
        } else {
            $authority = $bAuthority;
            $rPath = $r['path'] ?? '';
            if ($rPath === '') {
                $path = $bPath;
                $query = $r['query'] ?? ($b['query'] ?? null);
            } else {
                if ($rPath[0] === '/') {
                    $path = self::removeDotSegments($rPath);
                } else {
                    // merge(base, ref): base path up to and including last '/'
                    $merged = ($bPath === '' ? '/' : substr($bPath, 0, strrpos($bPath, '/') + 1)) . $rPath;
                    $path = self::removeDotSegments($merged);
                }
                $query = $r['query'] ?? null;
            }
        }
        $scheme = strtolower($b['scheme']);
        $out = $scheme . '://' . $authority . $path;
        if ($query !== null) {
            $out .= '?' . $query;
        }
        if (isset($r['fragment'])) {
            $out .= '#' . $r['fragment'];
        }
        return $out;
    }

    private static function isVoidElement(string $name): bool
    {
        return in_array($name, ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'], true);
    }

    private static function isExcludedElement(string $name): bool
    {
        return in_array($name, ['script', 'style', 'template', 'noscript', 'iframe', 'head', 'meta', 'link'], true);
    }

    private static function isBlockElement(string $name): bool
    {
        return preg_match('#^(' . self::BLOCK_ELEMENT_NAMES . ')$#i', $name) === 1;
    }

    /**
     * Compute a canonical claims string from a name->value map.
     *
     * Claims are serialized as sorted "name:content\n" records. Both names
     * and values are pushed through normalizeText so
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
        $seen = [];
        foreach ($claims as $name => $value) {
            $normName = trim(self::normalizeText((string) $name));
            $normValue = trim(self::normalizeText((string) $value));
            if ($normName === '') {
                throw new \InvalidArgumentException('claim-malformed');
            }
            if (isset($seen[$normName])) {
                throw new \InvalidArgumentException('claim-duplicate');
            }
            $seen[$normName] = true;
            $entries[] = [$normName, $normValue];
        }

        // Sort by normalized name in UTF-8 byte order (strcmp), matching the
        // other bindings (draft §4.6).
        usort($entries, static function (array $a, array $b): int {
            return strcmp($a[0], $b[0]);
        });

        $out = '';
        foreach ($entries as [$name, $value]) {
            $out .= $name . ':' . $value . "\n";
        }
        return $out;
    }
}
