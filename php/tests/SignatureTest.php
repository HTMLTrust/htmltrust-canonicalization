<?php
/**
 * Tests for HTMLTrust signature binding and verification.
 */

namespace HTMLTrust\Canonicalization\Tests;

use PHPUnit\Framework\TestCase;
use HTMLTrust\Canonicalization\Signature;
use InvalidArgumentException;

class SignatureTest extends TestCase
{
    // ------------------------------------------------------------------
    // buildSignatureBinding
    // ------------------------------------------------------------------

    public function testBuildSignatureBindingFormatsCorrectly(): void
    {
        $this->assertSame(
            'sha256:ABC:sha256:DEF:example.com:2025-05-01T00:00Z',
            Signature::buildSignatureBinding('sha256:ABC', 'sha256:DEF', 'example.com', '2025-05-01T00:00Z')
        );
    }

    /**
     * @dataProvider emptyFieldProvider
     */
    public function testBuildSignatureBindingRejectsEmptyFields(string $contentHash, string $claimsHash, string $domain, string $signedAt): void
    {
        $this->expectException(InvalidArgumentException::class);
        Signature::buildSignatureBinding($contentHash, $claimsHash, $domain, $signedAt);
    }

    public function emptyFieldProvider(): array
    {
        return [
            'empty contentHash' => ['', 'b', 'c', 'd'],
            'empty claimsHash'  => ['a', '', 'c', 'd'],
            'empty domain'      => ['a', 'b', '', 'd'],
            'empty signedAt'    => ['a', 'b', 'c', ''],
        ];
    }

    // ------------------------------------------------------------------
    // buildEndorsementBinding
    // ------------------------------------------------------------------

    public function testBuildEndorsementBinding(): void
    {
        $this->assertSame(
            'sha256:XYZ:2025-05-01T00:00Z',
            Signature::buildEndorsementBinding('sha256:XYZ', '2025-05-01T00:00Z')
        );
    }

    public function testBuildEndorsementBindingRejectsEmpty(): void
    {
        $this->expectException(InvalidArgumentException::class);
        Signature::buildEndorsementBinding('', '2025-05-01');
    }

    // ------------------------------------------------------------------
    // verifySignature: ed25519 round trip via libsodium
    // ------------------------------------------------------------------

    public function testVerifyEd25519RoundTripPaddedSignature(): void
    {
        $this->skipIfNoSodium();

        [$pem, $secret] = $this->makeEd25519KeypairPem();
        $message   = 'sha256:ABC:sha256:DEF:example.com:2025-05-01T00:00Z';
        $signature = sodium_crypto_sign_detached($message, $secret);
        $b64       = base64_encode($signature); // padded

        $this->assertTrue(Signature::verifySignature($message, $b64, $pem, 'ed25519'));
    }

    public function testVerifyEd25519RoundTripUnpaddedSignature(): void
    {
        $this->skipIfNoSodium();

        [$pem, $secret] = $this->makeEd25519KeypairPem();
        $message   = 'hello';
        $signature = sodium_crypto_sign_detached($message, $secret);
        $unpadded  = rtrim(base64_encode($signature), '=');

        $this->assertTrue(Signature::verifySignature($message, $unpadded, $pem, 'ed25519'));
    }

    public function testVerifyEd25519IsCaseInsensitive(): void
    {
        $this->skipIfNoSodium();

        [$pem, $secret] = $this->makeEd25519KeypairPem();
        $message   = 'hello';
        $signature = base64_encode(sodium_crypto_sign_detached($message, $secret));

        $this->assertTrue(Signature::verifySignature($message, $signature, $pem, 'ED25519'));
        $this->assertTrue(Signature::verifySignature($message, $signature, $pem, 'Ed25519'));
    }

    public function testVerifyEd25519RejectsTamperedMessage(): void
    {
        $this->skipIfNoSodium();

        [$pem, $secret] = $this->makeEd25519KeypairPem();
        $signature = base64_encode(sodium_crypto_sign_detached('original', $secret));

        $this->assertFalse(Signature::verifySignature('tampered', $signature, $pem, 'ed25519'));
    }

    public function testVerifyEd25519RejectsBadKey(): void
    {
        $this->skipIfNoSodium();

        [$pemA, $secretA] = $this->makeEd25519KeypairPem();
        [$pemB,]          = $this->makeEd25519KeypairPem();

        $signature = base64_encode(sodium_crypto_sign_detached('hello', $secretA));

        $this->assertFalse(Signature::verifySignature('hello', $signature, $pemB, 'ed25519'));
    }

    public function testVerifyEd25519AcceptsRawKeyBytes(): void
    {
        $this->skipIfNoSodium();

        $keypair = sodium_crypto_sign_keypair();
        $secret  = sodium_crypto_sign_secretkey($keypair);
        $public  = sodium_crypto_sign_publickey($keypair);

        $message   = 'raw-key-test';
        $signature = base64_encode(sodium_crypto_sign_detached($message, $secret));

        // Pass the raw 32-byte key directly (no PEM wrapping).
        $this->assertTrue(Signature::verifySignature($message, $signature, $public, 'ed25519'));
    }

    public function testVerifyRejectsMalformedBase64(): void
    {
        $this->skipIfNoSodium();
        [$pem,] = $this->makeEd25519KeypairPem();
        // 1 mod 4 is never valid base64; flexible decoder rejects.
        $this->assertFalse(Signature::verifySignature('msg', 'A', $pem, 'ed25519'));
    }

    public function testVerifyUnknownAlgorithmThrows(): void
    {
        $this->expectException(InvalidArgumentException::class);
        Signature::verifySignature('msg', base64_encode('xx'), 'irrelevant', 'frobnicate');
    }

    // ------------------------------------------------------------------
    // verifySignature: ECDSA round trip via openssl
    // ------------------------------------------------------------------

    public function testVerifyEcdsaRoundTrip(): void
    {
        if (!function_exists('openssl_pkey_new')) {
            $this->markTestSkipped('openssl extension not available');
        }
        $key = openssl_pkey_new([
            'private_key_type' => OPENSSL_KEYTYPE_EC,
            'curve_name'       => 'prime256v1',
        ]);
        if ($key === false) {
            $this->markTestSkipped('this OpenSSL build cannot generate prime256v1 keypairs');
        }
        $details = openssl_pkey_get_details($key);
        $pem     = $details['key'];

        $message = 'ecdsa-test';
        $sig     = '';
        $this->assertTrue(openssl_sign($message, $sig, $key, OPENSSL_ALGO_SHA256));
        $b64 = base64_encode($sig);

        $this->assertTrue(Signature::verifySignature($message, $b64, $pem, 'ecdsa'));
        $this->assertFalse(Signature::verifySignature('tampered', $b64, $pem, 'ecdsa'));
    }

    // ------------------------------------------------------------------
    // verifySignature: RSA round trip via openssl
    // ------------------------------------------------------------------

    public function testVerifyRsaRoundTrip(): void
    {
        if (!function_exists('openssl_pkey_new')) {
            $this->markTestSkipped('openssl extension not available');
        }
        $key = openssl_pkey_new([
            'private_key_type' => OPENSSL_KEYTYPE_RSA,
            'private_key_bits' => 2048,
        ]);
        if ($key === false) {
            $this->markTestSkipped('OpenSSL keypair generation unavailable');
        }
        $details = openssl_pkey_get_details($key);
        $pem     = $details['key'];

        $message = 'rsa-test';
        $sig     = '';
        $this->assertTrue(openssl_sign($message, $sig, $key, OPENSSL_ALGO_SHA256));
        $b64 = base64_encode($sig);

        $this->assertTrue(Signature::verifySignature($message, $b64, $pem, 'rsa'));
        $this->assertFalse(Signature::verifySignature($message . 'x', $b64, $pem, 'rsa'));
    }

    // ------------------------------------------------------------------
    // ed25519RawToPem helper
    // ------------------------------------------------------------------

    public function testEd25519RawToPemStructure(): void
    {
        $this->skipIfNoSodium();
        $keypair = sodium_crypto_sign_keypair();
        $public  = sodium_crypto_sign_publickey($keypair);
        $pem     = Signature::ed25519RawToPem($public);

        $this->assertStringContainsString('-----BEGIN PUBLIC KEY-----', $pem);
        $this->assertStringContainsString('-----END PUBLIC KEY-----', $pem);

        // Round-trips via the verify path: signing with the secret and
        // verifying via the PEM should succeed.
        $secret    = sodium_crypto_sign_secretkey($keypair);
        $signature = base64_encode(sodium_crypto_sign_detached('roundtrip', $secret));
        $this->assertTrue(Signature::verifySignature('roundtrip', $signature, $pem, 'ed25519'));
    }

    public function testEd25519RawToPemRejectsWrongLength(): void
    {
        $this->expectException(InvalidArgumentException::class);
        Signature::ed25519RawToPem('short');
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    private function skipIfNoSodium(): void
    {
        if (!function_exists('sodium_crypto_sign_keypair')) {
            $this->markTestSkipped('libsodium not available');
        }
    }

    /**
     * Generate a fresh Ed25519 keypair and wrap the public key in a PEM SPKI.
     *
     * @return array{0: string, 1: string} [PEM publicKey, raw secretKey]
     */
    private function makeEd25519KeypairPem(): array
    {
        $keypair = sodium_crypto_sign_keypair();
        $secret  = sodium_crypto_sign_secretkey($keypair);
        $public  = sodium_crypto_sign_publickey($keypair);
        return [Signature::ed25519RawToPem($public), $secret];
    }
}
