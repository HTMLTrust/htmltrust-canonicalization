<?php
/**
 * Resolves opaque keyids by querying a federated set of trust directories.
 * For each base URL `B`, this resolver tries `GET B/keys/{keyid}` and stops
 * at the first base URL that returns a usable JSON document.
 *
 * Expected JSON: { "publicKey": "<PEM>", "algorithm": "ed25519" }
 *   (also accepts "publicKeyPem" as a synonym, matching DID conventions)
 *
 * @package HTMLTrust\Canonicalization\Keys
 */

namespace HTMLTrust\Canonicalization\Keys;

final class TrustDirectoryResolver implements KeyResolver
{
    /** @var array<int, string> */
    private $baseUrls;

    /** @var callable(string): ?array{body: string, contentType: string} */
    private $fetcher;

    /**
     * @param array<int, string> $baseUrls Ordered list of trust-directory
     *                                     base URLs; each is tried in turn.
     */
    public function __construct(array $baseUrls, ?callable $fetcher = null)
    {
        $this->baseUrls = array_values(array_filter($baseUrls, 'is_string'));
        $this->fetcher  = $fetcher ?? HttpFetcher::default();
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
            $response = ($this->fetcher)($url);
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

            return new ResolvedKey($pem, $algorithm, $keyid);
        }

        return null;
    }
}
