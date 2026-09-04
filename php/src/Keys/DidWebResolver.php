<?php
/**
 * Resolves did:web:DOMAIN[#fragment] keyids by fetching the standard DID
 * document at https://DOMAIN/.well-known/did.json (or, with a path
 * component, https://DOMAIN/PATH/did.json) per the did:web specification,
 * then selecting a verificationMethod entry per spec §9.10's verifier
 * algorithm (steps 1-4).
 *
 * A non-empty fragment matching the period grammar (#p<N>) or naming any
 * other verification method selects that single entry by exact expanded
 * id, with no fallback. A bare keyid (no fragment) selects the first entry
 * whose fragment is not a period fragment (the anchor); assertionMethod is
 * never consulted. Revoked or expired entries are still returned, with
 * their lifecycle fields, so the caller can report "key-revoked" via
 * ResolvedKey::isRevoked(); resolve() never falls through to another
 * entry. The DID document and per-fragment "not found" outcomes are
 * cached per spec §9.10 step 8.
 *
 * @package HTMLTrust\Canonicalization\Keys
 */

namespace HTMLTrust\Canonicalization\Keys;

final class DidWebResolver implements KeyResolver
{
    private const PERIOD_FRAGMENT_PATTERN = '/^p([1-9][0-9]{0,9})$/';
    private const MAX_PERIOD = 2147483647;

    // Spec §12.9/§13.4 sets a floor/ceiling on document caching. The
    // injectable fetcher here returns only {body, contentType}, with no
    // response headers, so Cache-Control's max-age cannot be read; every
    // document is cached for the recommended ceiling (one hour).
    private const DOCUMENT_CACHE_TTL = 3600;
    private const DOCUMENT_CACHE_FLOOR = 60;
    private const NEGATIVE_CACHE_TTL = 60;

    /** @var callable(string): ?array{body: string, contentType: string} */
    private $fetcher;

    /** @var callable(): int */
    private $clock;

    /** @var array<string, array{doc: ?array, isText: bool, fetchedAt: int}> */
    private $docCache = [];

    /** @var array<string, int> negative-cache key => expiresAt (unix seconds) */
    private $negativeCache = [];

    /**
     * @param callable|null $fetcher Optional injected HTTP fetcher; defaults
     *                               to HttpFetcher::default().
     * @param callable|null $clock   Optional injected clock (): int returning
     *                               a unix timestamp; defaults to time().
     *                               Exists for deterministic cache tests.
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
        return strncmp($keyid, 'did:web:', 8) === 0;
    }

    public function resolve(string $keyid): ?ResolvedKey
    {
        if (!$this->supports($keyid)) {
            return null;
        }

        [$didPart, $fragment] = self::splitDidFragment($keyid);
        // Spec §9.10 step 1: a fragment containing '#', '/', or '?' fails.
        if (strpbrk($fragment, "#/?") !== false) {
            return null;
        }
        $period = self::parsePeriodFragment($fragment) ?? 0;

        $url = self::didWebToUrl($didPart);
        if ($url === null) {
            return null;
        }

        $entry = $this->loadDocument($url, false);
        if ($entry === null || $entry['isText'] || $entry['doc'] === null) {
            return null;
        }
        $doc = $entry['doc'];
        if (($doc['deactivated'] ?? false) === true) {
            return null;
        }
        $docId = $doc['id'] ?? null;
        if (!is_string($docId) || $docId === '' || $docId !== $didPart) {
            return null;
        }

        $selection = self::selectMethod($doc, $didPart, $fragment);
        if ($selection === null) {
            $negativeKey = $url . "\x00" . $fragment;
            $now = ($this->clock)();
            if (isset($this->negativeCache[$negativeKey]) && $this->negativeCache[$negativeKey] > $now) {
                return null;
            }
            // Spec §9.10 step 8: when the cached copy is older than 60
            // seconds, refetch once bypassing the cache before failing.
            if ($now - $entry['fetchedAt'] >= self::DOCUMENT_CACHE_FLOOR) {
                $freshEntry = $this->loadDocument($url, true);
                if ($freshEntry !== null && !$freshEntry['isText'] && $freshEntry['doc'] !== null) {
                    $freshDoc = $freshEntry['doc'];
                    if (($freshDoc['deactivated'] ?? false) === true) {
                        return null;
                    }
                    $freshDocId = $freshDoc['id'] ?? null;
                    if (!is_string($freshDocId) || $freshDocId === '' || $freshDocId !== $didPart) {
                        return null;
                    }
                    $doc = $freshDoc;
                    $selection = self::selectMethod($doc, $didPart, $fragment);
                }
            }
            if ($selection === null) {
                $this->negativeCache[$negativeKey] = $now + self::NEGATIVE_CACHE_TTL;
                return null;
            }
        }

        $method = $selection['method'];
        $pem = $method['publicKeyPem'] ?? null;
        // Spec §9.10 step 4: publicKeyPem MUST be present, else malformed.
        // There is no fall-through to another entry.
        if (!is_string($pem) || $pem === '') {
            throw new \InvalidArgumentException('malformed-key-document');
        }

        $algorithm = self::guessAlgorithm($method);
        $revoked = isset($method['revoked']) && is_bool($method['revoked'])
            ? $method['revoked']
            : false;
        $expires = isset($method['expires']) && is_string($method['expires']) && $method['expires'] !== ''
            ? $method['expires']
            : null;

        return new ResolvedKey($pem, $algorithm, $keyid, $revoked, $expires, $period, $didPart, $selection['methodId']);
    }

    /**
     * Split a did: keyid at the first '#' into the DID part and the
     * fragment (empty string when there is no '#').
     *
     * @return array{0: string, 1: string}
     */
    private static function splitDidFragment(string $keyid): array
    {
        $hash = strpos($keyid, '#');
        if ($hash === false) {
            return [$keyid, ''];
        }
        return [substr($keyid, 0, $hash), substr($keyid, $hash + 1)];
    }

    /**
     * Parse a DID URL fragment as a period index (spec §9.10): "p" followed
     * by a decimal integer, no sign, no leading zero, value 1 through
     * 2147483647. Returns null for the empty string, a non-matching
     * fragment, or an out-of-range value.
     */
    private static function parsePeriodFragment(string $fragment): ?int
    {
        if (preg_match(self::PERIOD_FRAGMENT_PATTERN, $fragment, $matches) !== 1) {
            return null;
        }
        // PHP ints are 64-bit on every platform this package supports, so a
        // 10-digit decimal fragment cannot overflow before the range check.
        $value = (int) $matches[1];
        if ($value < 1 || $value > self::MAX_PERIOD) {
            return null;
        }
        return $value;
    }

    /**
     * Expand a relative "#fragment" verificationMethod id against the
     * document id. Returns null when $id is not a non-empty string.
     *
     * @param mixed $id
     */
    private static function expandMethodId($id, string $docId): ?string
    {
        if (!is_string($id) || $id === '') {
            return null;
        }
        return $id[0] === '#' ? $docId . $id : $id;
    }

    private static function methodFragmentOf(string $expandedId): string
    {
        $hash = strpos($expandedId, '#');
        return $hash === false ? '' : substr($expandedId, $hash + 1);
    }

    /**
     * Select the verificationMethod entry a keyid resolves to (spec §9.10
     * step 3), after validating that no two entries share an expanded id
     * (step 2's duplicate check, run unconditionally over the whole
     * document).
     *
     * @return array{method: array, methodId: string}|null
     * @throws \InvalidArgumentException "malformed-key-document" on a
     *         duplicate expanded id.
     */
    private static function selectMethod(array $doc, string $didPart, string $fragment): ?array
    {
        $docId = is_string($doc['id'] ?? null) ? $doc['id'] : '';
        $methods = isset($doc['verificationMethod']) && is_array($doc['verificationMethod'])
            ? $doc['verificationMethod']
            : [];

        $seen = [];
        foreach ($methods as $method) {
            if (!is_array($method)) {
                continue;
            }
            $id = self::expandMethodId($method['id'] ?? null, $docId);
            if ($id === null) {
                continue;
            }
            if (isset($seen[$id])) {
                throw new \InvalidArgumentException('malformed-key-document');
            }
            $seen[$id] = true;
        }

        if ($fragment !== '') {
            // Period or anchor kind: the single entry whose expanded id
            // equals the whole keyid. No fallback of any kind.
            $target = $didPart . '#' . $fragment;
            foreach ($methods as $method) {
                if (!is_array($method)) {
                    continue;
                }
                $id = self::expandMethodId($method['id'] ?? null, $docId);
                if ($id === $target) {
                    return ['method' => $method, 'methodId' => $target];
                }
            }
            return null;
        }

        // Bare kind: the first entry in array order whose fragment is not a
        // period fragment. A verifier MUST NOT consult assertionMethod.
        foreach ($methods as $method) {
            if (!is_array($method)) {
                continue;
            }
            $id = self::expandMethodId($method['id'] ?? null, $docId);
            if ($id === null) {
                continue;
            }
            if (self::parsePeriodFragment(self::methodFragmentOf($id)) === null) {
                return ['method' => $method, 'methodId' => $id];
            }
        }
        return null;
    }

    /**
     * Fetch (or serve from cache) the DID document at $url.
     *
     * @return array{doc: ?array, isText: bool, fetchedAt: int}|null
     */
    private function loadDocument(string $url, bool $bypassCache): ?array
    {
        $now = ($this->clock)();
        if (!$bypassCache && isset($this->docCache[$url])) {
            $cached = $this->docCache[$url];
            if ($now - $cached['fetchedAt'] < self::DOCUMENT_CACHE_TTL) {
                return $cached;
            }
        }
        $response = HttpFetcher::validateResponse(($this->fetcher)($url));
        if ($response === null) {
            return null;
        }
        $decoded = json_decode($response['body'], true);
        $entry = [
            'doc' => is_array($decoded) ? $decoded : null,
            'isText' => !is_array($decoded),
            'fetchedAt' => $now,
        ];
        $this->docCache[$url] = $entry;
        return $entry;
    }

    /**
     * Translate a did:web:DOMAIN[:PATH:SEGMENTS] DID (with no fragment) to
     * the canonical fetch URL. Per spec:
     *   - did:web:example.com         -> https://example.com/.well-known/did.json
     *   - did:web:example.com:user:1  -> https://example.com/user/1/did.json
     */
    private static function didWebToUrl(string $did): ?string
    {
        $rest = substr($did, 8);
        if ($rest === '' || $rest === false) {
            return null;
        }

        $parts = explode(':', $rest);
        $domain = array_shift($parts);
        if ($domain === null || $domain === '') {
            return null;
        }
        // did:web percent-encodes only the authority's port colon.
        $domain = str_ireplace('%3A', ':', $domain);
        if (str_contains($domain, '%')) {
            return null;
        }
        try {
            $authorityUrl = \Uri\WhatWg\Url::parse('https://' . $domain);
        } catch (\Throwable $error) {
            return null;
        }
        if ($authorityUrl === null
            || strtolower($authorityUrl->getScheme()) !== 'https'
            || $authorityUrl->getAsciiHost() === null
            || $authorityUrl->getAsciiHost() === ''
            || $authorityUrl->getUsername() !== null
            || $authorityUrl->getPassword() !== null
            || $authorityUrl->getPath() !== '/'
            || $authorityUrl->getQuery() !== null
            || $authorityUrl->getFragment() !== null) {
            return null;
        }
        $domain = $authorityUrl->getAsciiHost();
        if ($authorityUrl->getPort() !== null) {
            $domain .= ':' . $authorityUrl->getPort();
        }

        if (count($parts) === 0) {
            return 'https://' . $domain . '/.well-known/did.json';
        }
        $encodedParts = [];
        foreach ($parts as $part) {
            $encoded = self::encodePathPart($part);
            if ($encoded === null) {
                return null;
            }
            $encodedParts[] = $encoded;
        }
        $path = implode('/', $encodedParts);
        return 'https://' . $domain . '/' . $path . '/did.json';
    }

    private static function encodePathPart(string $part): ?string
    {
        if ($part === '' || preg_match('/%(?![0-9A-Fa-f]{2})/', $part) === 1) {
            return null;
        }
        return preg_replace_callback(
            '/%25([0-9A-Fa-f]{2})/',
            static fn (array $match): string => '%' . $match[1],
            rawurlencode($part)
        );
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
