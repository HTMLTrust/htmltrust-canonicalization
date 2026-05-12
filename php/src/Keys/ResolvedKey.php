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

    public function __construct(string $publicKeyPem, string $algorithm, string $keyid)
    {
        $this->publicKeyPem = $publicKeyPem;
        $this->algorithm    = $algorithm;
        $this->keyid        = $keyid;
    }
}
