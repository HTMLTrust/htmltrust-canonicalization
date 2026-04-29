<?php
/**
 * Resolves keyids that are themselves http(s):// URLs pointing at a public
 * key document. The document MAY be either:
 *   - JSON: { "publicKey": "<PEM>", "algorithm": "ed25519" }
 *   - raw PEM if the response Content-Type indicates a PEM file
 *     (application/x-pem-file or text/plain with a -----BEGIN PUBLIC KEY-----
 *     prelude).
 *
 * @package HTMLTrust\Canonicalization\Keys
 */

namespace HTMLTrust\Canonicalization\Keys;

final class DirectUrlResolver implements KeyResolver
{
    /** @var callable(string): ?array{body: string, contentType: string} */
    private $fetcher;

    public function __construct(?callable $fetcher = null)
    {
        $this->fetcher = $fetcher ?? HttpFetcher::default();
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

        $response = ($this->fetcher)($keyid);
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
            return new ResolvedKey($body, 'ed25519', $keyid);
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

        return new ResolvedKey($pem, $algorithm, $keyid);
    }
}
