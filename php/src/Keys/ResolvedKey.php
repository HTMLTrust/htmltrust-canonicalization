<?php
/**
 * Value object: a successfully-resolved public key, ready for verification.
 *
 * @package HTMLTrust\Canonicalization\Keys
 */

namespace HTMLTrust\Canonicalization\Keys;

final class ResolvedKey
{
    /** @var string PEM-encoded public key (or raw key for ed25519 if the resolver chose to). */
    public $publicKeyPem;

    /** @var string Signature algorithm: "ed25519", "ecdsa", or "rsa". */
    public $algorithm;

    /** @var string The keyid this resolution corresponds to. */
    public $keyid;

    /** @var bool Whether the key document explicitly revoked this key. */
    public $revoked;

    /** @var ?string RFC3339 expiry supplied by the key document. */
    public $expires;

    public function __construct(
        string $publicKeyPem,
        string $algorithm,
        string $keyid,
        bool $revoked = false,
        ?string $expires = null
    )
    {
        $this->publicKeyPem = $publicKeyPem;
        $this->algorithm    = $algorithm;
        $this->keyid        = $keyid;
        $this->revoked      = $revoked;
        $this->expires      = $expires;
    }

    /**
     * Match the JS lifecycle policy. An explicit boolean revocation always
     * wins; an absent expiry is live, while malformed or past expiries are
     * treated as revoked so bad directory data cannot extend key lifetime.
     */
    public function isRevoked(?\DateTimeImmutable $now = null): bool
    {
        if ($this->revoked === true) {
            return true;
        }
        if ($this->expires === null || $this->expires === '') {
            return false;
        }
        // Lifecycle timestamps are deliberately narrower than PHP's general
        // date parser. Accept only RFC3339's UTC form, including its optional
        // fractional seconds, and fail closed on offsets, dates, or parser
        // extensions.
        if (preg_match('/^((?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?Z$/D', $this->expires, $parts) !== 1) {
            return true;
        }
        try {
            $expiry = new \DateTimeImmutable($this->expires);
        } catch (\Exception $e) {
            return true;
        }
        if ($expiry->format('Y-m-d\\TH:i:s') !== $parts[1]) {
            return true;
        }
        $now = $now ?? new \DateTimeImmutable('now');
        return $expiry <= $now;
    }
}
