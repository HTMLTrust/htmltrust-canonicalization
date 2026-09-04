<?php
/**
 * HKDF + Ed25519 period-key derivation (draft §9.10, Appendix A) and the
 * document/negative caching behavior of DidWebResolver (spec §9.10 step 8).
 */

namespace HTMLTrust\Canonicalization\Tests\Keys;

use PHPUnit\Framework\TestCase;
use HTMLTrust\Canonicalization\Signature;
use HTMLTrust\Canonicalization\Keys\DidWebResolver;

class PeriodKeyDerivationTest extends TestCase
{
    private const KEYS_VECTOR_PATH = __DIR__ . '/../../../conformance/vectors/period-keys-v1.json';
    private const SIGNATURE_VECTOR_PATH = __DIR__ . '/../../../conformance/vectors/period-signature-v1.json';

    /**
     * Reference derivation for spec §9.10: HKDF-SHA-256 with salt
     * "htmltrust-period-key-v1" and info = "ed25519" || 0x00 || identity ||
     * 0x00 || uint32be(N), producing a 32-byte seed used directly as the
     * libsodium Ed25519 seed.
     *
     * @return array{0: string, 1: string} [rawSeed, rawSecretKeypair]
     */
    private static function derivePeriodKey(string $master, string $identity, int $period): array
    {
        $info = "ed25519\x00" . $identity . "\x00" . pack('N', $period);
        $seed = hash_hkdf('sha256', $master, 32, $info, 'htmltrust-period-key-v1');
        $keypair = sodium_crypto_sign_seed_keypair($seed);
        return [$seed, $keypair];
    }

    public function testDerivationReproducesVector(): void
    {
        $raw = file_get_contents(self::KEYS_VECTOR_PATH);
        $this->assertNotFalse($raw);
        $vector = json_decode($raw, true);
        $master = hex2bin($vector['masterHex']);
        $this->assertNotFalse($master);

        foreach ($vector['periods'] as $entry) {
            [$seed, $keypair] = self::derivePeriodKey($master, $vector['identity'], $entry['period']);
            $this->assertSame($entry['seedHex'], bin2hex($seed), 'period ' . $entry['period'] . ' seed');

            $publicKey = sodium_crypto_sign_publickey($keypair);
            $spkiPem = Signature::ed25519RawToPem($publicKey);
            $spkiDer = self::pemToDer($spkiPem);
            $this->assertSame(
                $entry['publicKeySpkiBase64'],
                self::base64Unpadded($spkiDer),
                'period ' . $entry['period'] . ' public key'
            );

            if (!empty($entry['signatureBase64'])) {
                $secretKey = sodium_crypto_sign_secretkey($keypair);
                $signature = sodium_crypto_sign_detached($entry['signatureTestMessage'], $secretKey);
                $this->assertSame(
                    $entry['signatureBase64'],
                    self::base64Unpadded($signature),
                    'period ' . $entry['period'] . ' signature'
                );
                $this->assertTrue(
                    Signature::verifySignature($entry['signatureTestMessage'], $entry['signatureBase64'], $entry['publicKeyPem'], 'ed25519'),
                    'period ' . $entry['period'] . ' signature must verify under the derived public key'
                );
            }
        }
    }

    public function testPeriod3SignatureVerifiesOnlyUnderPeriod3Key(): void
    {
        $keys = json_decode(file_get_contents(self::KEYS_VECTOR_PATH), true);
        $sig = json_decode(file_get_contents(self::SIGNATURE_VECTOR_PATH), true);

        $period2Pem = null;
        $period3Pem = null;
        foreach ($keys['periods'] as $entry) {
            if ($entry['period'] === 2) {
                $period2Pem = $entry['publicKeyPem'];
            }
            if ($entry['period'] === 3) {
                $period3Pem = $entry['publicKeyPem'];
            }
        }
        $this->assertNotNull($period2Pem);
        $this->assertNotNull($period3Pem);

        $this->assertTrue(
            Signature::verifySignature($sig['jcsPayload'], $sig['signature'], $period3Pem, 'ed25519'),
            'the honest period-3 signature must verify under pk_3'
        );
        $this->assertFalse(
            Signature::verifySignature($sig['jcsPayload'], $sig['signatureFromPeriod2Mislabelled'], $period3Pem, 'ed25519'),
            'a period-2 signature relabelled as period-3 must not verify under pk_3'
        );
        $this->assertTrue(
            Signature::verifySignature($sig['jcsPayload'], $sig['signatureFromPeriod2Mislabelled'], $period2Pem, 'ed25519'),
            'the same bytes must verify under the period-2 key that actually made them'
        );
    }

    public function testNegativeCachesUnresolvedFragmentFor60Seconds(): void
    {
        $doc = [
            'id' => 'did:web:example.com',
            'verificationMethod' => [
                ['id' => '#p1', 'publicKeyPem' => 'P1'],
            ],
        ];
        $fetches = 0;
        $clock = 1_700_000_000;
        $fetcher = static function (string $url) use (&$fetches, $doc): ?array {
            $fetches++;
            if ($url !== 'https://example.com/.well-known/did.json') {
                return null;
            }
            return ['body' => json_encode($doc), 'contentType' => 'application/json'];
        };
        $resolver = new DidWebResolver($fetcher, static function () use (&$clock): int {
            return $clock;
        });

        $first = $resolver->resolve('did:web:example.com#p4');
        $this->assertNull($first, 'p4 is unpublished');
        $this->assertSame(1, $fetches);

        $clock += 30; // still within the 60s negative-cache window
        $second = $resolver->resolve('did:web:example.com#p4');
        $this->assertNull($second);
        $this->assertSame(1, $fetches, 'a negative-cached fragment must not trigger a refetch within 60s');
    }

    public function testRefetchesOnceBypassingCacheWhenStale(): void
    {
        $staleDoc = [
            'id' => 'did:web:example.com',
            'verificationMethod' => [
                ['id' => '#p1', 'publicKeyPem' => 'P1'],
                ['id' => '#p3', 'publicKeyPem' => 'P3'],
            ],
        ];
        $rolledDoc = $staleDoc;
        $rolledDoc['verificationMethod'][] = ['id' => '#p4', 'publicKeyPem' => 'ROLLED-P4-PEM'];

        $fetches = 0;
        $clock = 1_700_000_000;
        $fetcher = static function (string $url) use (&$fetches, $staleDoc, $rolledDoc): ?array {
            $fetches++;
            if ($url !== 'https://example.com/.well-known/did.json') {
                return null;
            }
            $doc = $fetches === 1 ? $staleDoc : $rolledDoc;
            return ['body' => json_encode($doc), 'contentType' => 'application/json'];
        };
        $resolver = new DidWebResolver($fetcher, static function () use (&$clock): int {
            return $clock;
        });

        $missing = $resolver->resolve('did:web:example.com#p3');
        $this->assertNotNull($missing, 'p3 should resolve from the first fetch');
        $this->assertSame(1, $fetches);

        $clock += 61; // past the 60s floor
        $rolled = $resolver->resolve('did:web:example.com#p4');
        $this->assertNotNull($rolled, 'a single bypass refetch should see the newly published #p4');
        $this->assertSame('ROLLED-P4-PEM', $rolled->publicKeyPem);
        $this->assertSame(2, $fetches, 'exactly one bypass refetch, not a refetch per call');
    }

    private static function pemToDer(string $pem): string
    {
        $body = preg_replace('/-----[^-]+-----|\s+/', '', $pem);
        $decoded = base64_decode($body, true);
        if ($decoded === false) {
            throw new \RuntimeException('invalid PEM body');
        }
        return $decoded;
    }

    private static function base64Unpadded(string $bytes): string
    {
        return rtrim(base64_encode($bytes), '=');
    }
}
