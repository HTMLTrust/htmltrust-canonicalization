<?php
/**
 * Shared period/identity/kid validation for URL-form key documents
 * (spec §9.10 "Period key documents"), used by DirectUrlResolver and
 * TrustDirectoryResolver.
 *
 * @package HTMLTrust\Canonicalization\Keys
 */

namespace HTMLTrust\Canonicalization\Keys;

final class PeriodKeyDocument
{
    private const MAX_PERIOD = 2147483647;

    /**
     * Read the optional period/identity members of a decoded URL-form key
     * document. Returns [0, $kid] when "period" is absent. When
     * $requireSameOrigin is true (direct-URL resolution, where $kid is
     * itself the fetch URL), identity must share $kid's origin; a
     * trust-directory $kid is opaque, so origin is not checked there (draft
     * open issue: no identity-origin rule is yet defined for
     * directory-hosted keys).
     *
     * @param array<string, mixed> $decoded
     * @return array{0: int, 1: string} [period, identity]
     * @throws \InvalidArgumentException "malformed-key-document" on any
     *         violation.
     */
    public static function resolveFields(array $decoded, string $kid, bool $requireSameOrigin): array
    {
        if (!array_key_exists('period', $decoded) || $decoded['period'] === null) {
            return [0, $kid];
        }
        $period = $decoded['period'];
        // JSON has no integer/float distinction; accept either PHP type but
        // require the value itself to be a whole number in range, matching
        // the other two language bindings' value-based check.
        if (!is_int($period) && !is_float($period)) {
            throw new \InvalidArgumentException('malformed-key-document');
        }
        $value = (float) $period;
        if ($value !== floor($value) || $value < 1 || $value > self::MAX_PERIOD) {
            throw new \InvalidArgumentException('malformed-key-document');
        }

        $identity = $decoded['identity'] ?? null;
        if (!is_string($identity) || !self::isAbsoluteHttpsUrl($identity)) {
            throw new \InvalidArgumentException('malformed-key-document');
        }

        $kidField = $decoded['kid'] ?? null;
        if (!is_string($kidField) || $kidField !== $kid) {
            throw new \InvalidArgumentException('malformed-key-document');
        }

        if (isset($decoded['expires']) && is_string($decoded['expires']) && $decoded['expires'] !== '') {
            throw new \InvalidArgumentException('malformed-key-document');
        }

        if ($requireSameOrigin && !self::sameOrigin($identity, $kid)) {
            throw new \InvalidArgumentException('malformed-key-document');
        }

        return [(int) $value, $identity];
    }

    private static function isAbsoluteHttpsUrl(string $value): bool
    {
        try {
            $url = \Uri\WhatWg\Url::parse($value);
        } catch (\Throwable $error) {
            return false;
        }
        return $url !== null
            && strtolower($url->getScheme()) === 'https'
            && $url->getAsciiHost() !== null
            && $url->getAsciiHost() !== '';
    }

    private static function sameOrigin(string $a, string $b): bool
    {
        try {
            $ua = \Uri\WhatWg\Url::parse($a);
            $ub = \Uri\WhatWg\Url::parse($b);
        } catch (\Throwable $error) {
            return false;
        }
        if ($ua === null || $ub === null) {
            return false;
        }
        return strtolower($ua->getScheme()) === strtolower($ub->getScheme())
            && strtolower((string) $ua->getAsciiHost()) === strtolower((string) $ub->getAsciiHost())
            && $ua->getPort() === $ub->getPort();
    }
}
