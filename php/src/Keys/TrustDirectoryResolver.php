<?php
/**
 * Resolves opaque keyids by querying a federated set of trust directories.
 * For each base URL `B`, this resolver tries `GET B/keys/{keyid}` and stops
 * at the first base URL that returns a usable JSON document.
 *
 * Expected JSON: { "publicKey": "<PEM>", "algorithm": "ed25519" }
 *   (also accepts "publicKeyPem" as a synonym, matching DID conventions)
 *
 * When a document carries a "period" member, "identity" and "kid" are
 * validated per spec §9.10 (PeriodKeyDocument::resolveFields); the
 * resulting InvalidArgumentException propagates immediately rather than
 * falling through to the next base URL, since a directory document that
 * fails validation is a real error, not an absent one. Documents are
 * cached (see the note on DOCUMENT_CACHE_TTL below).
 *
 * @package HTMLTrust\Canonicalization\Keys
 */

namespace HTMLTrust\Canonicalization\Keys;

final class TrustDirectoryResolver implements KeyResolver
{
    // Spec §12.9/§13.4 sets a floor/ceiling on document caching. The
    // injectable fetcher here returns only {body, contentType}, with no
    // response headers, so Cache-Control's max-age cannot be read; every
    // document is cached for the recommended ceiling (one hour).
    private const DOCUMENT_CACHE_TTL = 3600;

    /** @var array<int, string> */
    private $baseUrls;

    /** @var callable(string): ?array{body: string, contentType: string} */
    private $fetcher;

    /** @var callable(): int */
    private $clock;

    /** @var array<string, array{body: string, contentType: string, fetchedAt: int}> */
    private $docCache = [];

    /**
     * @param array<int, string> $baseUrls Ordered list of trust-directory
     *                                     base URLs; each is tried in turn.
     * @param callable|null $fetcher Optional injected HTTP fetcher; defaults
     *                               to HttpFetcher::default().
     * @param callable|null $clock   Optional injected clock (): int returning
     *                               a unix timestamp; defaults to time().
     */
    public function __construct(array $baseUrls, ?callable $fetcher = null, ?callable $clock = null)
    {
        $this->baseUrls = array_values(array_filter($baseUrls, 'is_string'));
        $this->fetcher  = $fetcher ?? HttpFetcher::default();
        $this->clock    = $clock ?? static function (): int {
            return time();
        };
    }

    public function supports(string $keyid): bool
    {
        // Trust directories accept anything that the other resolvers won't
        // claim. The chain in resolveKey() will naturally fall through to
        // this resolver after the more specific ones decline.
        if ($keyid === '') {
            return false;
        }
        if (strncmp($keyid, 'did:', 4) === 0) {
            return false;
        }
        if (strncmp($keyid, 'http://', 7) === 0 || strncmp($keyid, 'https://', 8) === 0) {
            return false;
        }
        return true;
    }

    public function resolve(string $keyid): ?ResolvedKey
    {
        if (!$this->supports($keyid)) {
            return null;
        }

        foreach ($this->baseUrls as $base) {
            $url = rtrim($base, '/') . '/keys/' . rawurlencode($keyid);
            $response = $this->loadDocument($url);
            if ($response === null) {
                continue;
            }
            $decoded = json_decode($response['body'], true);
            if (!is_array($decoded)) {
                continue;
            }
            $pem = $decoded['publicKey'] ?? $decoded['publicKeyPem'] ?? null;
            if (!is_string($pem) || $pem === '') {
                continue;
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

            // PeriodKeyDocument::resolveFields throws on a malformed period
            // key document; that MUST propagate, not fall through to the
            // next base URL, so it is intentionally not caught here.
            [$period, $identity] = PeriodKeyDocument::resolveFields($decoded, $keyid, false);

            return new ResolvedKey($pem, $algorithm, $keyid, $revoked, $expires, $period, $identity, $keyid);
        }

        return null;
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
