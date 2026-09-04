<?php
/**
 * Resolves keyids that are themselves http(s):// URLs pointing at a public
 * key document. The document MAY be either:
 *   - JSON: { "publicKey": "<PEM>", "algorithm": "ed25519" }
 *   - raw PEM if the response Content-Type indicates a PEM file
 *     (application/x-pem-file or text/plain with a -----BEGIN PUBLIC KEY-----
 *     prelude).
 *
 * When the document carries a "period" member, "identity" and "kid" are
 * validated per spec §9.10 (PeriodKeyDocument::resolveFields). Documents
 * are cached (see the note on DOCUMENT_CACHE_TTL below).
 *
 * @package HTMLTrust\Canonicalization\Keys
 */

namespace HTMLTrust\Canonicalization\Keys;

final class DirectUrlResolver implements KeyResolver
{
    // Spec §12.9/§13.4 sets a floor/ceiling on document caching. The
    // injectable fetcher here returns only {body, contentType}, with no
    // response headers, so Cache-Control's max-age cannot be read; every
    // document is cached for the recommended ceiling (one hour).
    private const DOCUMENT_CACHE_TTL = 3600;

    /** @var callable(string): ?array{body: string, contentType: string} */
    private $fetcher;

    /** @var callable(): int */
    private $clock;

    /** @var array<string, array{body: string, contentType: string, fetchedAt: int}> */
    private $docCache = [];

    /**
     * @param callable|null $fetcher Optional injected HTTP fetcher; defaults
     *                               to HttpFetcher::default().
     * @param callable|null $clock   Optional injected clock (): int returning
     *                               a unix timestamp; defaults to time().
     */
    public function __construct(?callable $fetcher = null, ?callable $clock = null)
    {
        $this->fetcher = $fetcher ?? HttpFetcher::default();
        $this->clock   = $clock ?? static function (): int {
            return time();
        };
    }

    public function supports(string $keyid): bool
    {
        return strncmp($keyid, 'http://', 7) === 0
            || strncmp($keyid, 'https://', 8) === 0;
    }

    public function resolve(string $keyid): ?ResolvedKey
    {
        if (!$this->supports($keyid)) {
            return null;
        }

        $response = $this->loadDocument($keyid);
        if ($response === null) {
            return null;
        }

        $body        = $response['body'];
        $contentType = strtolower($response['contentType'] ?? '');

        // Raw PEM path: either the Content-Type says so, or the body itself
        // begins with a PEM header (some static-file hosts mislabel them).
        $looksLikePem = strpos($contentType, 'pem') !== false
            || strpos($contentType, 'x-pem') !== false
            || strpos(ltrim($body), '-----BEGIN') === 0;

        if ($looksLikePem) {
            return new ResolvedKey($body, 'ed25519', $keyid, false, null, 0, $keyid, $keyid);
        }

        // JSON path.
        $decoded = json_decode($body, true);
        if (!is_array($decoded)) {
            return null;
        }
        $pem = $decoded['publicKey'] ?? $decoded['publicKeyPem'] ?? null;
        if (!is_string($pem) || $pem === '') {
            return null;
        }
        $algorithm = isset($decoded['algorithm']) && is_string($decoded['algorithm']) && $decoded['algorithm'] !== ''
            ? strtolower($decoded['algorithm'])
            : 'ed25519';
        $revoked = isset($decoded['revoked']) && is_bool($decoded['revoked'])
            ? $decoded['revoked']
            : false;
        $expires = isset($decoded['expires']) && is_string($decoded['expires']) && $decoded['expires'] !== ''
            ? $decoded['expires']
            : null;

        [$period, $identity] = PeriodKeyDocument::resolveFields($decoded, $keyid, true);

        return new ResolvedKey($pem, $algorithm, $keyid, $revoked, $expires, $period, $identity, $keyid);
    }

    /** @return array{body: string, contentType: string}|null */
    private function loadDocument(string $url): ?array
    {
        $now = ($this->clock)();
        if (isset($this->docCache[$url])) {
            $cached = $this->docCache[$url];
            if ($now - $cached['fetchedAt'] < self::DOCUMENT_CACHE_TTL) {
                return $cached;
            }
        }
        $response = HttpFetcher::validateResponse(($this->fetcher)($url));
        if ($response === null) {
            return null;
        }
        $entry = ['body' => $response['body'], 'contentType' => $response['contentType'] ?? '', 'fetchedAt' => $now];
        $this->docCache[$url] = $entry;
        return $entry;
    }
}
