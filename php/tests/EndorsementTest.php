<?php
/**
 * End-to-end tests for verifyEndorsement: an in-memory resolver returns a
 * PEM key for the endorser, and the endorsement signature is verified over
 * deterministic JSON with `signature` omitted.
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
        $message = Signature::canonicalizeEndorsementDocument($endorsement);
        $endorsement['signature'] = rtrim(base64_encode(sodium_crypto_sign_detached($message, $secret)), '=');

        $resolver = new InMemoryResolver([$endorser => new ResolvedKey($pem, 'ed25519', $endorser)]);
        $this->assertTrue(Signature::verifyEndorsement($endorsement, [$resolver]));
    }

    public function testVerifyEndorsementRequiresAlgorithm(): void
    {
        $this->skipIfNoSodium();
        [$endorser, $pem, $secret] = $this->makeEndorser();

        $endorsement = [
            'endorser'    => $endorser,
            'endorsement' => 'sha256:CONTENT',
            'timestamp'   => '2025-05-01T00:00Z',
            // no 'algorithm' key — default ed25519
        ];
        $message = '{"endorsement":"sha256:CONTENT","timestamp":"2025-05-01T00:00Z"}';
        $endorsement['signature'] = rtrim(base64_encode(sodium_crypto_sign_detached($message, $secret)), '=');

        $resolver = new InMemoryResolver([$endorser => new ResolvedKey($pem, 'ed25519', $endorser)]);
        $this->assertFalse(Signature::verifyEndorsement($endorsement, [$resolver]));
    }

    public function testVerifyEndorsementFailsForTamperedTimestamp(): void
    {
        $this->skipIfNoSodium();
        [$endorser, $pem, $secret] = $this->makeEndorser();

        $signed = [
            'endorser'    => $endorser,
            'endorsement' => 'sha256:CONTENT',
            'timestamp'   => '2025-05-01T00:00Z',
            'algorithm'   => 'ed25519',
        ];
        $signedMessage = Signature::canonicalizeEndorsementDocument($signed);
        $endorsement = [
            'endorser'    => $endorser,
            'endorsement' => 'sha256:CONTENT',
            'timestamp'   => '2025-05-02T00:00Z', // different from what was signed
            'algorithm'   => 'ed25519',
            'signature'   => rtrim(base64_encode(sodium_crypto_sign_detached($signedMessage, $secret)), '='),
        ];

        $resolver = new InMemoryResolver([$endorser => new ResolvedKey($pem, 'ed25519', $endorser)]);
        $this->assertFalse(Signature::verifyEndorsement($endorsement, [$resolver]));
    }

    public function testVerifyEndorsementFailsForUnknownEndorser(): void
    {
        $this->skipIfNoSodium();
        [$endorser, , $secret] = $this->makeEndorser();
        $endorsement = [
            'endorser'    => $endorser,
            'endorsement' => 'sha256:CONTENT',
            'timestamp'   => '2025-05-01T00:00Z',
            'algorithm'   => 'ed25519',
        ];
        $message = Signature::canonicalizeEndorsementDocument($endorsement);
        $endorsement['signature'] = rtrim(base64_encode(sodium_crypto_sign_detached($message, $secret)), '=');

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

    public function testEndorsementBindingPreservesUnicodeExtensions(): void
    {
        $binding = Signature::canonicalizeEndorsementDocument([
            'endorser' => 'did:web:例.example',
            'endorsement' => 'sha256:内容😀',
            'timestamp' => '2025-05-01T00:00Z',
            'algorithm' => 'ed25519',
            'extension😀' => ['説明' => 'café', 'value' => "\u{1F469}\u{200D}\u{1F4BB}"],
            'signature' => 'omitted',
        ]);

        $this->assertStringContainsString('例.example', $binding);
        $this->assertStringContainsString('内容😀', $binding);
        $this->assertStringContainsString('extension😀', $binding);
        $this->assertStringContainsString('説明', $binding);
        $this->assertStringNotContainsString('omitted', $binding);
    }

    public function testRawEndorsementBindingRejectsDuplicateMembers(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('jcs-duplicate-key');
        Signature::canonicalizeEndorsementDocument(
            '{"endorser":"alice","endorsement":"sha256:X","algorithm":"ed25519",'
            . '"timestamp":"2025-05-01T00:00Z","endorsement":"sha256:Y"}'
        );
    }

    public function testVerifyEndorsementRejectsRevokedResolvedKey(): void
    {
        $this->skipIfNoSodium();
        [$endorser, $pem, $secret] = $this->makeEndorser();
        $unsigned = [
            'endorser' => $endorser,
            'endorsement' => 'sha256:CONTENT',
            'timestamp' => '2025-05-01T00:00Z',
            'algorithm' => 'ed25519',
        ];
        $unsigned['signature'] = rtrim(base64_encode(
            sodium_crypto_sign_detached(Signature::canonicalizeEndorsementDocument($unsigned), $secret)
        ), '=');

        $resolver = new InMemoryResolver([
            $endorser => new ResolvedKey($pem, 'ed25519', $endorser, true),
        ]);
        $this->assertFalse(Signature::verifyEndorsement($unsigned, [$resolver]));
    }

    public function testVerifyEndorsementFailsClosedOnExpiryAndRevokedBy(): void
    {
        $this->skipIfNoSodium();
        [$endorser, $pem, $secret] = $this->makeEndorser();
        $resolver = new InMemoryResolver([$endorser => new ResolvedKey($pem, 'ed25519', $endorser)]);
        $sign = static function (array $unsigned) use ($secret): array {
            $unsigned['signature'] = rtrim(base64_encode(
                sodium_crypto_sign_detached(Signature::canonicalizeEndorsementDocument($unsigned), $secret)
            ), '=');
            return $unsigned;
        };
        $base = [
            'endorser' => $endorser,
            'endorsement' => 'sha256:LIFECYCLE',
            'timestamp' => '2025-05-01T00:00:00Z',
            'algorithm' => 'ed25519',
        ];

        $this->assertTrue(Signature::verifyEndorsement(
            $sign($base + ['expires' => '2999-01-01T00:00:00Z']), [$resolver]
        ));
        foreach ([
            ['expires' => 'nonsense'],
            ['expires' => '2000-01-01T00:00:00Z'],
            ['expires' => '2999-01-01T00:00:00+00:00'],
            ['expires' => ''],
            ['revokedBy' => ''],
            ['revokedBy' => 'did:web:authority.example'],
            ['revokedBy' => 42],
        ] as $lifecycle) {
            $this->assertFalse(
                Signature::verifyEndorsement($sign($base + $lifecycle), [$resolver]),
                'malformed or revoked lifecycle field must fail closed'
            );
        }
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
