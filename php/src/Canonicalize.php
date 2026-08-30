<?php

declare(strict_types=1);

namespace HTMLTrust\Canonicalization;

/**
 * Compatibility facade for the mandatory Rust canonicalization core.
 *
 * Applications configure one audited RustCore during process startup. Every
 * canonical byte returned by this class then comes from that instance.
 */
final class Canonicalize
{
    private static ?RustCore $core = null;

    public static function configureRustCore(RustCore $core): void
    {
        self::$core = $core;
    }

    /** Clear process configuration. Intended for isolated tests. */
    public static function resetRustCore(): void
    {
        self::$core = null;
    }

    public static function isRustCoreConfigured(): bool
    {
        return self::$core !== null;
    }

    private static function core(): RustCore
    {
        if (self::$core === null) {
            throw new \RuntimeException('htmltrust-rust-core-not-configured');
        }
        return self::$core;
    }

    public static function normalizeText(string $text, bool $preserveWhitespace = false): string
    {
        return self::core()->normalizeText($text, $preserveWhitespace);
    }

    public static function normalize(string $text): string
    {
        return trim(self::normalizeText($text));
    }

    public static function extractCanonicalText(
        string $html,
        bool $preserveWhitespace = false,
        ?string $baseUrl = null
    ): string {
        return self::core()->extractCanonicalText($html, $preserveWhitespace, $baseUrl);
    }

    /** @param array<string|int, string> $claims */
    public static function canonicalizeClaims(array $claims): string
    {
        return self::core()->canonicalizeClaims($claims);
    }

    /** @return array<string|int, string> */
    public static function extractClaimsFromSignedSection(string $html): array
    {
        return self::core()->extractClaimsFromSignedSection($html);
    }

    public static function canonicalizeJsonDocument(string $document): string
    {
        return self::core()->canonicalizeJsonDocument($document);
    }
}
