<?php
/**
 * HTMLTrust Canonical Text Normalization
 *
 * Implements all 8 phases of the HTMLTrust canonicalization spec.
 * Requires PHP 8.5+ with DOM and the built-in WHATWG URL API.
 *
 * Spec: https://github.com/HTMLTrust/htmltrust-canonicalization
 *
 * @package HTMLTrust\Canonicalization
 */

namespace HTMLTrust\Canonicalization;

require_once __DIR__ . '/Entities.php';

class Canonicalize
{
    private const MAX_RESOURCE_BYTES = 1048576;

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
        if (strlen($text) > self::MAX_RESOURCE_BYTES) {
            throw new \InvalidArgumentException('resource-limit-exceeded');
        }

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

        if (strlen($text) > self::MAX_RESOURCE_BYTES) {
            throw new \InvalidArgumentException('resource-limit-exceeded');
        }

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
        . '|pre|section|signed-section|table|tr|td|th|ul';

    /**
     * Any remaining HTML tag (inline elements stripped without adding whitespace).
     */
    private const ANY_TAG_PATTERN = '#</?[a-z][^\t\n\f\r />]*\b[^>]*>#i';

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
        self::preflightHtmlSource($html);
        // Validate the document base independently of the presence of href or
        // src attributes. This keeps malformed bases from being silently
        // accepted merely because this fragment has no URL-bearing element.
        $baseUrl = self::validateBaseUrl($baseUrl);
        if ($html === '') return '';
        $doc = new \DOMDocument('1.0', 'UTF-8');
        $old = libxml_use_internal_errors(true);
        // libxml's HTML parser otherwise treats the first fragment element as
        // the root and reparents following siblings.  The encoding PI also
        // prevents its ISO-8859-1 default from corrupting UTF-8 text.
        $ok = $doc->loadHTML('<?xml encoding="UTF-8">' . $html, LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD);
        libxml_clear_errors();
        libxml_use_internal_errors($old);
        if (!$ok) {
            throw new \InvalidArgumentException('parser-profile-unsupported');
        }
        $parts = [];
        foreach ($doc->childNodes as $child) {
            self::walkDomNode($child, $parts, $preserveWhitespace, $baseUrl);
        }
        return self::finalizeCanonicalParts($parts);
    }

    private static function preflightHtmlSource(string $html): void
    {
        if (strlen($html) > self::MAX_RESOURCE_BYTES || preg_match('//u', $html) !== 1) {
            throw new \InvalidArgumentException(strlen($html) > self::MAX_RESOURCE_BYTES ? 'resource-limit-exceeded' : 'parser-profile-unsupported');
        }
        $scan = preg_replace_callback(
            '#(<\s*(script|style|iframe)\b(?:[^>"\']+|"[^"]*"|\'[^\']*\')*>)[\s\S]*?(</\s*\2\s*>)#i',
            static function (array $match): string { return $match[1] . $match[3]; },
            $html
        );
        if ($scan === null) {
            throw new \InvalidArgumentException('parser-profile-unsupported');
        }
        if (preg_match('#<\s*(?:svg|math|foreignObject)\b#i', $scan)) {
            throw new \InvalidArgumentException('parser-profile-unsupported');
        }
        // Reject ambiguous/unterminated references. HTML's error recovery
        // would otherwise make `&amp!` and `&#65!` differ by parser.
        if (preg_match('/&(?:[A-Za-z][A-Za-z0-9]*|#\d+|#[xX][0-9A-Fa-f]+)(?!;)(?=[^A-Za-z0-9]|$)/', $scan)) {
            throw new \InvalidArgumentException('parser-profile-unsupported');
        }
        preg_match_all('/&([A-Za-z][A-Za-z0-9]*);/', $scan, $entities);
        foreach ($entities[0] as $entity) {
            if (!array_key_exists($entity, Entities::NAMED)) {
                throw new \InvalidArgumentException('parser-profile-unsupported');
            }
        }
        // Validate comments/declarations before libxml can repair them. An
        // HTML comment cannot contain `--`, and declarations are outside the
        // signed fragment profile.
        preg_match_all('/<!--/', $scan, $commentStarts);
        preg_match_all('/-->/', $scan, $commentEnds);
        if (count($commentStarts[0]) !== count($commentEnds[0])) {
            throw new \InvalidArgumentException('parser-profile-unsupported');
        }
        preg_match_all('/<!--([\s\S]*?)-->/', $scan, $comments);
        foreach ($comments[1] as $comment) {
            if (strpos($comment, '--') !== false || str_ends_with($comment, '-')) {
                throw new \InvalidArgumentException('parser-profile-unsupported');
            }
        }
        $withoutComments = preg_replace('/<!--[\s\S]*?-->/', '', $scan);
        if (!is_string($withoutComments) || preg_match('/<!/', $withoutComments) === 1) {
            throw new \InvalidArgumentException('parser-profile-unsupported');
        }
        // Validate source-level nesting and reject duplicate attributes before
        // DOMDocument can discard or repair them. Keep the text gaps in this
        // pass as well: text while the table insertion mode is active is
        // foster-parented by HTML parsers and therefore outside the portable
        // profile, including text after a closed row/cell.
        preg_match_all('#<!--[\\s\\S]*?-->|</?[a-z][^\t\n\f\r />]*(?:[\t\n\f\r ]+(?:[^>"\']+|"[^"]*"|\'[^\']*\')*)?\s*/?>#i', $scan, $matches, PREG_OFFSET_CAPTURE);
        $stack = [];
        $index = 0;
        foreach ($matches[0] as $match) {
            [$token, $offset] = $match;
            $text = substr($scan, $index, $offset - $index);
            if ($stack && end($stack) === 'table' && trim($text) !== '') {
                throw new \InvalidArgumentException('parser-profile-unsupported');
            }
            $index = $offset + strlen($token);
            if (strpos($token, '<!--') === 0) {
                // Preserve the existing strict profile for comments in a
                // table, whose placement can also be changed by recovery.
                if ($stack && in_array('table', $stack, true)) {
                    throw new \InvalidArgumentException('parser-profile-unsupported');
                }
                continue;
            }
            if (!preg_match('#^</?\s*([a-z][^\t\n\f\r />]*)#i', $token, $m)) {
                continue;
            }
            $name = strtolower($m[1]);
            $trimmed = trim($token);
            if (strpos($trimmed, '</') === 0) {
                if (!$stack || array_pop($stack) !== $name) {
                    throw new \InvalidArgumentException('parser-profile-unsupported');
                }
                continue;
            }
            $attrs = self::parseAttributes($token);
            $raw = preg_replace('#^</?\s*[a-z][^\t\n\f\r />]*|/?>$#i', '', trim($token));
            preg_match_all('#([^\s"\'<>/=]+)(?:\s*=\s*(?:"[^"]*"|\'[^\']*\'|[^\s"\'=<>`]+))?#', $raw, $am);
            $seen = [];
            foreach ($am[1] as $attr) {
                $key = strtolower($attr);
                if (isset($seen[$key])) {
                    throw new \InvalidArgumentException('parser-profile-unsupported');
                }
                $seen[$key] = true;
            }
            if (!self::isVoidElement($name) && preg_match('#/\s*>$#', $trimmed) !== 1) {
                if (count($stack) >= 256) {
                    throw new \InvalidArgumentException('resource-limit-exceeded');
                }
                $stack[] = $name;
            }
        }
        $text = substr($scan, $index);
        if ($stack && end($stack) === 'table' && trim($text) !== '') {
            throw new \InvalidArgumentException('parser-profile-unsupported');
        }
        if ($stack) {
            throw new \InvalidArgumentException('parser-profile-unsupported');
        }
    }

    private static function walkDomNode(\DOMNode $node, array &$parts, bool $preserveWhitespace, ?string $baseUrl): void
    {
        if ($node->nodeType === XML_TEXT_NODE) {
            self::appendCanonicalPart($parts, str_replace('@', '@@', self::normalizeText($node->nodeValue ?? '', $preserveWhitespace)));
            return;
        }
        if ($node->nodeType !== XML_ELEMENT_NODE) {
            return;
        }
        $name = strtolower($node->localName ?: $node->nodeName);
        if (self::isExcludedElement($name)) {
            return;
        }
        $attrs = [];
        if ($node->hasAttributes()) {
            foreach ($node->attributes as $attr) {
                $attrs[strtolower($attr->name)] = $attr->value;
            }
        }
        self::appendAttributeRecords($parts, $name, $attrs, $baseUrl);
        if ($name === 'br') {
            self::appendCanonicalPart($parts, "\n");
        } else {
            foreach ($node->childNodes as $child) {
                self::walkDomNode($child, $parts, $preserveWhitespace, $baseUrl);
            }
        }
        if (self::isBlockElement($name)) {
            self::appendCanonicalPart($parts, "\n");
        }
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
        if (strlen($text) > self::MAX_RESOURCE_BYTES) {
            throw new \InvalidArgumentException('resource-limit-exceeded');
        }
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
        $body = preg_replace('#^</?\s*[a-z][^\t\n\f\r />]*#i', '', $token);
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

    private static function validateBaseUrl(?string $baseUrl): ?string
    {
        if ($baseUrl === null || $baseUrl === '') {
            return null;
        }
        try {
            $base = \Uri\WhatWg\Url::parse($baseUrl);
        } catch (\Throwable $e) {
            throw new \InvalidArgumentException('attribute-canonicalization-failed');
        }
        if ($base === null) {
            throw new \InvalidArgumentException('attribute-canonicalization-failed');
        }
        if (strtolower($base->getScheme()) !== 'https'
            || $base->getAsciiHost() === null
            || $base->getAsciiHost() === ''
            || $base->getUsername() !== null
            || $base->getPassword() !== null) {
            throw new \InvalidArgumentException('url-policy-violation');
        }
        return $base->toAsciiString();
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
            $value = str_replace('@', '@@', $value);
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
        for ($i = 0; $i < strlen($value); $i++) {
            $ord = ord($value[$i]);
            if ($ord <= 0x1F || $ord === 0x7F) {
                throw new \InvalidArgumentException('url-policy-violation');
            }
        }
        $base = null;
        if ($baseUrl !== null) {
            $base = \Uri\WhatWg\Url::parse($baseUrl);
            if ($base === null) {
                throw new \InvalidArgumentException('attribute-canonicalization-failed');
            }
            if (strtolower($base->getScheme()) !== 'https'
                || $base->getUsername() !== null
                || $base->getPassword() !== null) {
                throw new \InvalidArgumentException('url-policy-violation');
            }
        }
        $url = \Uri\WhatWg\Url::parse($value, $base);
        if ($url === null) {
            throw new \InvalidArgumentException('attribute-canonicalization-failed');
        }
        if (strtolower($url->getScheme()) !== 'https'
            || $url->getUsername() !== null
            || $url->getPassword() !== null) {
            throw new \InvalidArgumentException('url-policy-violation');
        }
        if ($url->getAsciiHost() === null || $url->getAsciiHost() === '') {
            throw new \InvalidArgumentException('attribute-canonicalization-failed');
        }
        return $url->toAsciiString();
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
        if (count($claims) > 64) {
            throw new \InvalidArgumentException('resource-limit-exceeded');
        }
        $entries = [];
        $seen = [];
        foreach ($claims as $name => $value) {
            if (!is_string($name) || !is_string($value)) {
                throw new \InvalidArgumentException('claim-malformed');
            }
            $normName = trim(self::normalizeText((string) $name));
            $normValue = trim(self::normalizeText($value));
            if (strlen($normName) > 4096 || strlen($normValue) > 4096) {
                throw new \InvalidArgumentException('resource-limit-exceeded');
            }
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
            $escape = static function (string $v): string {
                return str_replace(["\\", ":", "\n"], ["\\\\", "\\:", "\\n"], $v);
            };
            $out .= $escape($name) . ':' . $escape($value) . "\n";
        }
        if (strlen($out) > self::MAX_RESOURCE_BYTES) {
            throw new \InvalidArgumentException('resource-limit-exceeded');
        }
        return $out;
    }

    /** Extract direct-child claim metadata from a signed-section snapshot. */
    public static function extractClaimsFromSignedSection(string $html): array
    {
        if ($html === '') return [];
        self::preflightHtmlSource($html);
        $doc = new \DOMDocument('1.0', 'UTF-8');
        @$doc->loadHTML('<?xml encoding="UTF-8">' . $html, LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD);
        $section = null;
        foreach ($doc->getElementsByTagName('signed-section') as $candidate) {
            $section = $candidate;
            break;
        }
        $parent = $section ?: $doc;
        $claims = [];
        foreach ($parent->childNodes as $child) {
            if (!($child instanceof \DOMElement) || strtolower($child->tagName) !== 'meta') continue;
            if (!$child->hasAttribute('name') || !$child->hasAttribute('content')) {
                throw new \InvalidArgumentException('claim-malformed');
            }
            if (count($claims) >= 64) throw new \InvalidArgumentException('resource-limit-exceeded');
            $name = trim(self::normalizeText($child->getAttribute('name')));
            $value = trim(self::normalizeText($child->getAttribute('content')));
            if ($name === '') throw new \InvalidArgumentException('claim-malformed');
            if (strlen($name) > 4096 || strlen($value) > 4096) {
                throw new \InvalidArgumentException('resource-limit-exceeded');
            }
            if (array_key_exists($name, $claims)) throw new \InvalidArgumentException('claim-duplicate');
            $claims[$name] = $value;
        }
        return $claims;
    }

    /** Strict RFC 8785 canonicalization of one raw JSON document. */
    public static function canonicalizeJsonDocument(string $document): string
    {
        if (strlen($document) > self::MAX_RESOURCE_BYTES) {
            throw new \InvalidArgumentException('resource-limit-exceeded');
        }
        $pos = 0;
        self::scanJsonValue($document, $pos, 0);
        self::skipJsonWhitespace($document, $pos);
        if ($pos !== strlen($document)) {
            throw new \InvalidArgumentException('jcs-invalid-json');
        }
        try {
            // Decode objects as stdClass so `{}` and objects with numeric
            // member names cannot collapse into PHP list arrays.
            $value = json_decode($document, false, 512, JSON_THROW_ON_ERROR);
            // JSON numbers are IEEE-754 binary64 values in RFC 8785. PHP's
            // decoder keeps some of them as integers, which would otherwise
            // make the result depend on the host integer width and bypass
            // the ECMAScript number serializer used by the package.
            $value = self::coerceJsonNumbersToFloat($value);
            if (is_object($value) || is_array($value) || is_scalar($value) || $value === null) {
                $canonical = self::serializeJcsValue($value);
                if (strlen($canonical) > self::MAX_RESOURCE_BYTES) {
                    throw new \InvalidArgumentException('resource-limit-exceeded');
                }
                return $canonical;
            }
        } catch (\Throwable $e) {
            $message = $e->getMessage();
            if ($message === 'resource-limit-exceeded') {
                throw $e;
            }
            if (strpos($message, 'UTF-8') !== false || strpos($message, 'surrogate') !== false) {
                throw new \InvalidArgumentException('jcs-invalid-surrogate', 0, $e);
            }
            throw new \InvalidArgumentException('jcs-number', 0, $e);
        }
        throw new \InvalidArgumentException('jcs-invalid-json');
    }

    /** @param mixed $value */
    private static function serializeJcsValue($value): string
    {
        if ($value === null) return 'null';
        if (is_bool($value)) return $value ? 'true' : 'false';
        if (is_int($value)) return self::serializeJcsNumber((float) $value);
        if (is_float($value)) return self::serializeJcsNumber($value);
        if (is_string($value)) {
            return json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        }
        if (is_array($value)) {
            $items = [];
            foreach ($value as $item) {
                $items[] = self::serializeJcsValue($item);
            }
            return '[' . implode(',', $items) . ']';
        }
        if (is_object($value)) {
            $members = get_object_vars($value);
            uksort($members, static function (string $left, string $right): int {
                return strcmp(
                    mb_convert_encoding($left, 'UTF-16BE', 'UTF-8'),
                    mb_convert_encoding($right, 'UTF-16BE', 'UTF-8')
                );
            });
            $items = [];
            foreach ($members as $key => $item) {
                $items[] = json_encode((string) $key, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
                    . ':' . self::serializeJcsValue($item);
            }
            return '{' . implode(',', $items) . '}';
        }
        throw new \InvalidArgumentException('jcs-invalid-json');
    }

    private static function serializeJcsNumber(float $number): string
    {
        if (is_nan($number) || is_infinite($number)) {
            throw new \InvalidArgumentException('jcs-number');
        }
        if ($number == 0.0) return '0';
        $previousPrecision = ini_get('serialize_precision');
        // json_encode otherwise inherits a process-wide precision setting,
        // which must not affect a signed RFC 8785 payload.
        @ini_set('serialize_precision', '-1');
        try {
            $encoded = json_encode($number, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
        } finally {
            if ($previousPrecision !== false) {
                @ini_set('serialize_precision', $previousPrecision);
            }
        }
        if (strpos($encoded, 'e') === false && strpos($encoded, 'E') === false) {
            return $encoded;
        }
        $encoded = strtolower($encoded);
        [$mantissa, $exponent] = explode('e', $encoded, 2);
        $exponent = (int) $exponent;
        $sign = '';
        if ($mantissa[0] === '-') {
            $sign = '-';
            $mantissa = substr($mantissa, 1);
        }
        $digits = str_replace('.', '', $mantissa);
        // PHP emits an insignificant trailing zero for integral doubles in
        // scientific notation (for example `1.0e-6`).
        $digits = rtrim($digits, '0');
        $decimalPosition = 1 + $exponent;
        // ECMAScript uses decimal notation for 1e-6 <= abs(x) < 1e21.
        if ($exponent >= -6 && $exponent < 21) {
            if ($decimalPosition <= 0) {
                return $sign . '0.' . str_repeat('0', -$decimalPosition) . $digits;
            }
            if ($decimalPosition >= strlen($digits)) {
                return $sign . $digits . str_repeat('0', $decimalPosition - strlen($digits));
            }
            return $sign . substr($digits, 0, $decimalPosition) . '.' . substr($digits, $decimalPosition);
        }
        $digits = rtrim($digits, '0');
        $mantissa = $digits[0] . (strlen($digits) > 1 ? '.' . substr($digits, 1) : '');
        $expSign = $exponent < 0 ? '-' : '+';
        return $sign . $mantissa . 'e' . $expSign . abs($exponent);
    }

    private static function skipJsonWhitespace(string $s, int &$i): void
    {
        while ($i < strlen($s) && strpos(" \t\r\n", $s[$i]) !== false) $i++;
    }

    private static function scanJsonString(string $s, int &$i): string
    {
        $start = $i++;
        $escaped = false;
        while ($i < strlen($s)) {
            $c = $s[$i++];
            if ($escaped) { $escaped = false; continue; }
            if ($c === '\\') { $escaped = true; continue; }
            if ($c === '"') {
                $decoded = json_decode(substr($s, $start, $i - $start), true);
                if (!is_string($decoded)) {
                    if (preg_match('/\\\\u[dD][89A-Fa-f0-9]{3}/', substr($s, $start, $i - $start))) {
                        throw new \InvalidArgumentException('jcs-invalid-surrogate');
                    }
                    throw new \InvalidArgumentException('jcs-invalid-json');
                }
                return $decoded;
            }
            if (ord($c) < 0x20) throw new \InvalidArgumentException('jcs-invalid-json');
        }
        throw new \InvalidArgumentException('jcs-invalid-json');
    }

    private static function scanJsonValue(string $s, int &$i, int $depth): void
    {
        self::skipJsonWhitespace($s, $i);
        if ($i >= strlen($s)) throw new \InvalidArgumentException('jcs-invalid-json');
        if ($s[$i] === '"') { self::scanJsonString($s, $i); return; }
        if ($s[$i] === '{') {
            if ($depth >= 256) throw new \InvalidArgumentException('resource-limit-exceeded');
            $i++; self::skipJsonWhitespace($s, $i); $seen = [];
            if ($i < strlen($s) && $s[$i] === '}') { $i++; return; }
            while (true) {
                self::skipJsonWhitespace($s, $i);
                if ($i >= strlen($s) || $s[$i] !== '"') throw new \InvalidArgumentException('jcs-invalid-json');
                $key = self::scanJsonString($s, $i);
                if (isset($seen[$key])) throw new \InvalidArgumentException('jcs-duplicate-key');
                $seen[$key] = true;
                self::skipJsonWhitespace($s, $i);
                if ($i >= strlen($s) || $s[$i++] !== ':') throw new \InvalidArgumentException('jcs-invalid-json');
                self::scanJsonValue($s, $i, $depth + 1); self::skipJsonWhitespace($s, $i);
                if ($i < strlen($s) && $s[$i] === '}') { $i++; return; }
                if ($i >= strlen($s) || $s[$i++] !== ',') throw new \InvalidArgumentException('jcs-invalid-json');
            }
        }
        if ($s[$i] === '[') {
            if ($depth >= 256) throw new \InvalidArgumentException('resource-limit-exceeded');
            $i++; self::skipJsonWhitespace($s, $i);
            if ($i < strlen($s) && $s[$i] === ']') { $i++; return; }
            while (true) {
                self::scanJsonValue($s, $i, $depth + 1); self::skipJsonWhitespace($s, $i);
                if ($i < strlen($s) && $s[$i] === ']') { $i++; return; }
                if ($i >= strlen($s) || $s[$i++] !== ',') throw new \InvalidArgumentException('jcs-invalid-json');
            }
        }
        $start = $i;
        while ($i < strlen($s) && strpos(" \t\r\n,]}", $s[$i]) === false) $i++;
        $token = substr($s, $start, $i - $start);
        if (!preg_match('/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)$/', $token)) {
            throw new \InvalidArgumentException('jcs-invalid-json');
        }
        // RFC 8785 delegates number semantics to IEEE-754 binary64. This
        // permits integers larger than 2^53 when they have a finite binary64
        // representation, and rounds them exactly as ECMAScript does.
        if (is_infinite((float) $token)) {
            throw new \InvalidArgumentException('jcs-number');
        }
    }

    /** @param mixed $value */
    private static function coerceJsonNumbersToFloat($value)
    {
        if (is_int($value)) {
            return (float) $value;
        }
        if (is_array($value)) {
            foreach ($value as $key => $item) {
                $value[$key] = self::coerceJsonNumbersToFloat($item);
            }
            return $value;
        }
        if (is_object($value)) {
            foreach (get_object_vars($value) as $key => $item) {
                $value->{$key} = self::coerceJsonNumbersToFloat($item);
            }
        }
        return $value;
    }
}
