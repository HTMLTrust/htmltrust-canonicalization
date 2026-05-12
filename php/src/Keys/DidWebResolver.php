<?php
/**
 * Resolves did:web:DOMAIN keyids by fetching the standard DID document at
 * https://DOMAIN/.well-known/did.json (or, with a path component,
 * https://DOMAIN/PATH/did.json) per the did:web specification.
 *
 * Returns the first verificationMethod whose publicKeyPem is populated.
 *
 * @package HTMLTrust\Canonicalization\Keys
 */

namespace HTMLTrust\Canonicalization\Keys;

final class DidWebResolver implements KeyResolver
{
    /** @var callable(string): ?array{body: string, contentType: string} */
    private $fetcher;

    /**
     * @param callable|null $fetcher Optional injected HTTP fetcher; defaults
     *                               to HttpFetcher::default().
     */
    public function __construct(?callable $fetcher = null)
    {
        $this->fetcher = $fetcher ?? HttpFetcher::default();
    }

    public function supports(string $keyid): bool
    {
        return strncmp($keyid, 'did:web:', 8) === 0;
    }

    public function resolve(string $keyid): ?ResolvedKey
    {
        if (!$this->supports($keyid)) {
            return null;
        }

        $url = self::didWebToUrl($keyid);
        if ($url === null) {
            return null;
        }

        $response = ($this->fetcher)($url);
        if ($response === null) {
            return null;
        }

        $doc = json_decode($response['body'], true);
        if (!is_array($doc)) {
            return null;
        }

        $methods = $doc['verificationMethod'] ?? null;
        if (!is_array($methods)) {
            return null;
        }

        foreach ($methods as $method) {
            if (!is_array($method)) {
                continue;
            }
            $pem = $method['publicKeyPem'] ?? null;
            if (!is_string($pem) || $pem === '') {
                continue;
            }

            $algorithm = self::guessAlgorithm($method);
            return new ResolvedKey($pem, $algorithm, $keyid);
        }

        return null;
    }

    /**
     * Translate a did:web:DOMAIN[:PATH:SEGMENTS] keyid to the canonical
     * fetch URL. Per spec:
     *   - did:web:example.com         -> https://example.com/.well-known/did.json
     *   - did:web:example.com:user:1  -> https://example.com/user/1/did.json
     */
    private static function didWebToUrl(string $keyid): ?string
    {
        $rest = substr($keyid, 8);
        if ($rest === '' || $rest === false) {
            return null;
        }

        // Strip any fragment (e.g. did:web:example.com#keys-1) — the fragment
        // identifies a verificationMethod, but the document URL is the same.
        $hash = strpos($rest, '#');
        if ($hash !== false) {
            $rest = substr($rest, 0, $hash);
        }

        $parts = explode(':', $rest);
        $domain = array_shift($parts);
        if ($domain === null || $domain === '') {
            return null;
        }
        // did:web percent-encodes ports as %3A; decode for URL building.
        $domain = rawurldecode($domain);

        if (count($parts) === 0) {
            return 'https://' . $domain . '/.well-known/did.json';
        }
        $path = implode('/', array_map('rawurldecode', $parts));
        return 'https://' . $domain . '/' . $path . '/did.json';
    }

    /**
     * Best-effort algorithm hint from a verificationMethod entry.
     * The "type" field is conventional but inconsistent across DID
     * implementations; default to ed25519 since that's the spec default.
     */
    private static function guessAlgorithm(array $method): string
    {
        $type = isset($method['type']) && is_string($method['type']) ? strtolower($method['type']) : '';
        if (strpos($type, 'ed25519') !== false) {
            return 'ed25519';
        }
        if (strpos($type, 'ecdsa') !== false || strpos($type, 'secp') !== false) {
            return 'ecdsa';
        }
        if (strpos($type, 'rsa') !== false) {
            return 'rsa';
        }
        if (isset($method['algorithm']) && is_string($method['algorithm']) && $method['algorithm'] !== '') {
            return strtolower($method['algorithm']);
        }
        return 'ed25519';
    }
}
