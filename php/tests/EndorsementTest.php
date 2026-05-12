<?php
/**
 * End-to-end tests for verifyEndorsement: an in-memory resolver returns a
 * PEM key for the endorser, and the endorsement signature is verified over
 * `{endorsement}:{timestamp}`.
 */

namespace HTMLTrust\Canonicalization\Tests;

use PHPUnit\Framework\TestCase;
use HTMLTrust\Canonicalization\Signature;
use HTMLTrust\Canonicalization\Keys\KeyResolver;
use HTMLTrust\Canonicalization\Keys\ResolvedKey;

class EndorsementTest extends TestCase
{
    public function testVerifyEndorsementSucceeds(): void
    {
        $this->skipIfNoSodium();
        [$endorser, $pem, $secret] = $this->makeEndorser();

        $endorsement = [
            'endorser'    => $endorser,
            'endorsement' => 'sha256:CONTENT',
            'timestamp'   => '2025-05-01T00:00Z',
            'algorithm'   => 'ed25519',
        ];
        $message = $endorsement['endorsement'] . ':' . $endorsement['timestamp'];
        $endorsement['signature'] = base64_encode(sodium_crypto_sign_detached($message, $secret));

        $resolver = new InMemoryResolver([$endorser => new ResolvedKey($pem, 'ed25519', $endorser)]);
        $this->assertTrue(Signature::verifyEndorsement($endorsement, [$resolver]));
    }

    public function testVerifyEndorsementDefaultsToEd25519(): void
    {
        $this->skipIfNoSodium();
        [$endorser, $pem, $secret] = $this->makeEndorser();

        $endorsement = [
            'endorser'    => $endorser,
            'endorsement' => 'sha256:CONTENT',
            'timestamp'   => '2025-05-01T00:00Z',
            // no 'algorithm' key — default ed25519
        ];
        $message = $endorsement['endorsement'] . ':' . $endorsement['timestamp'];
        $endorsement['signature'] = base64_encode(sodium_crypto_sign_detached($message, $secret));

        $resolver = new InMemoryResolver([$endorser => new ResolvedKey($pem, 'ed25519', $endorser)]);
        $this->assertTrue(Signature::verifyEndorsement($endorsement, [$resolver]));
    }

    public function testVerifyEndorsementFailsForTamperedTimestamp(): void
    {
        $this->skipIfNoSodium();
        [$endorser, $pem, $secret] = $this->makeEndorser();

        $signedMessage = 'sha256:CONTENT:2025-05-01T00:00Z';
        $endorsement = [
            'endorser'    => $endorser,
            'endorsement' => 'sha256:CONTENT',
            'timestamp'   => '2025-05-02T00:00Z', // different from what was signed
            'signature'   => base64_encode(sodium_crypto_sign_detached($signedMessage, $secret)),
        ];

        $resolver = new InMemoryResolver([$endorser => new ResolvedKey($pem, 'ed25519', $endorser)]);
        $this->assertFalse(Signature::verifyEndorsement($endorsement, [$resolver]));
    }

    public function testVerifyEndorsementFailsForUnknownEndorser(): void
    {
        $this->skipIfNoSodium();
        [$endorser, , $secret] = $this->makeEndorser();
        $message = 'sha256:CONTENT:2025-05-01T00:00Z';

        $endorsement = [
            'endorser'    => $endorser,
            'endorsement' => 'sha256:CONTENT',
            'timestamp'   => '2025-05-01T00:00Z',
            'signature'   => base64_encode(sodium_crypto_sign_detached($message, $secret)),
        ];

        $resolver = new InMemoryResolver([]); // empty — won't resolve anything
        $this->assertFalse(Signature::verifyEndorsement($endorsement, [$resolver]));
    }

    public function testVerifyEndorsementFailsOnMissingFields(): void
    {
        $resolver = new InMemoryResolver([]);
        $this->assertFalse(Signature::verifyEndorsement([
            'endorser'    => 'did:web:example.com',
            'endorsement' => 'sha256:CONTENT',
            // missing signature and timestamp
        ], [$resolver]));
    }

    // ------------------------------------------------------------------

    private function skipIfNoSodium(): void
    {
        if (!function_exists('sodium_crypto_sign_keypair')) {
            $this->markTestSkipped('libsodium not available');
        }
    }

    /**
     * @return array{0: string, 1: string, 2: string} [endorser keyid, public PEM, secret raw]
     */
    private function makeEndorser(): array
    {
        $keypair = sodium_crypto_sign_keypair();
        $secret  = sodium_crypto_sign_secretkey($keypair);
        $public  = sodium_crypto_sign_publickey($keypair);
        $pem     = Signature::ed25519RawToPem($public);
        return ['did:web:endorser.example', $pem, $secret];
    }
}

/**
 * Test-only KeyResolver backed by a static map of keyid -> ResolvedKey.
 */
class InMemoryResolver implements KeyResolver
{
    /** @var array<string, ResolvedKey> */
    private $keys;

    /**
     * @param array<string, ResolvedKey> $keys
     */
    public function __construct(array $keys)
    {
        $this->keys = $keys;
    }

    public function supports(string $keyid): bool
    {
        return isset($this->keys[$keyid]);
    }

    public function resolve(string $keyid): ?ResolvedKey
    {
        return $this->keys[$keyid] ?? null;
    }
}
