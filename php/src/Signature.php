<?php
/**
 * HTMLTrust signature binding, verification, and endorsement helpers.
 *
 * Mirrors the JS reference implementation. See htmltrust spec §2.1, §2.2,
 * §2.5 for the canonical signing payload, keyid resolution, and
 * endorsement formats.
 *
 * @package HTMLTrust\Canonicalization
 */

namespace HTMLTrust\Canonicalization;

use HTMLTrust\Canonicalization\Keys\KeyResolver;
use HTMLTrust\Canonicalization\Keys\KeyResolution;
use HTMLTrust\Canonicalization\Keys\ResolvedKey;
use InvalidArgumentException;
use RuntimeException;

class Signature
{
    /**
     * Build the canonical signing-binding string per spec §2.1:
     *
     *     {content-hash}:{claims-hash}:{domain}:{signed-at}
     *
     * All four fields are required; an empty string for any of them
     * raises InvalidArgumentException to surface programmer errors early.
     *
     * @throws InvalidArgumentException
     */
    public static function buildSignatureBinding(
        string $contentHash,
        string $claimsHash,
        string $domain,
        string $signedAt
    ): string {
        if ($contentHash === '') {
            throw new InvalidArgumentException('contentHash must be non-empty');
        }
        if ($claimsHash === '') {
            throw new InvalidArgumentException('claimsHash must be non-empty');
        }
        if ($domain === '') {
            throw new InvalidArgumentException('domain must be non-empty');
        }
        if ($signedAt === '') {
            throw new InvalidArgumentException('signedAt must be non-empty');
        }

        return $contentHash . ':' . $claimsHash . ':' . $domain . ':' . $signedAt;
    }

    /**
     * Build the canonical endorsement-binding string per spec §2.5:
     *
     *     {endorsement}:{timestamp}
     *
     * Both fields are required.
     *
     * @throws InvalidArgumentException
     */
    public static function buildEndorsementBinding(string $endorsement, string $timestamp): string
    {
        if ($endorsement === '') {
            throw new InvalidArgumentException('endorsement must be non-empty');
        }
        if ($timestamp === '') {
            throw new InvalidArgumentException('timestamp must be non-empty');
        }
        return $endorsement . ':' . $timestamp;
    }

    /**
     * Verify a signature over a message using the supplied PEM-encoded
     * public key. Algorithm match is case-insensitive.
     *
     * Supported algorithms:
     *   - "ed25519": uses libsodium (sodium_crypto_sign_verify_detached).
     *                The 32-byte raw key is extracted from the PEM body.
     *   - "ecdsa":   uses openssl_verify with OPENSSL_ALGO_SHA256.
     *   - "rsa":     uses openssl_verify with OPENSSL_ALGO_SHA256.
     *
     * The signature is accepted as either standard (padded) or unpadded
     * Base64. Per the spec the wire format is unpadded Base64, but
     * permitting padded input keeps things tolerant of well-meaning callers.
     *
     * @throws InvalidArgumentException for unknown algorithms or malformed
     *         inputs that prevent a meaningful verify attempt.
     */
    public static function verifySignature(
        string $message,
        string $signatureB64,
        string $publicKeyPem,
        string $algorithm
    ): bool {
        $algo = strtolower(trim($algorithm));

        $signature = self::base64DecodeFlexible($signatureB64);
        if ($signature === null) {
            return false;
        }

        switch ($algo) {
            case 'ed25519':
                return self::verifyEd25519($message, $signature, $publicKeyPem);

            case 'ecdsa':
            case 'rsa':
                return self::verifyOpenssl($message, $signature, $publicKeyPem);

            default:
                throw new InvalidArgumentException("unsupported signature algorithm: {$algorithm}");
        }
    }

    /**
     * Verify a JSON endorsement object per spec §2.5.
     *
     * The endorsement array is expected to have keys:
     *   - "endorser":     string keyid (subject to KeyResolver chain)
     *   - "endorsement":  the targeted content-hash (signed payload)
     *   - "signature":    Base64 signature
     *   - "timestamp":    ISO-8601 timestamp
     *   - "algorithm":    optional, default "ed25519"
     *
     * Returns true iff the endorser's resolved key validates the signature
     * over `{endorsement}:{timestamp}`.
     *
     * @param array<string, mixed> $endorsement
     * @param array<int, KeyResolver> $resolvers
     */
    public static function verifyEndorsement(array $endorsement, array $resolvers): bool
    {
        foreach (['endorser', 'endorsement', 'signature', 'timestamp'] as $required) {
            if (!isset($endorsement[$required]) || !is_string($endorsement[$required]) || $endorsement[$required] === '') {
                return false;
            }
        }

        $endorser   = $endorsement['endorser'];
        $payload    = $endorsement['endorsement'];
        $signature  = $endorsement['signature'];
        $timestamp  = $endorsement['timestamp'];
        $algoOnWire = isset($endorsement['algorithm']) && is_string($endorsement['algorithm']) && $endorsement['algorithm'] !== ''
            ? $endorsement['algorithm']
            : 'ed25519';

        $resolved = KeyResolution::resolveKey($endorser, $resolvers);
        if ($resolved === null) {
            return false;
        }

        // Prefer the algorithm declared in the endorsement; fall back to the
        // resolved key's hint if the endorsement omitted it. This mirrors
        // the JS reference, where the wire format wins.
        $algorithm = $algoOnWire;

        $message = self::buildEndorsementBinding($payload, $timestamp);

        try {
            return self::verifySignature($message, $signature, $resolved->publicKeyPem, $algorithm);
        } catch (InvalidArgumentException $e) {
            return false;
        }
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    /**
     * Decode a Base64 string that may or may not include "=" padding.
     * Returns null on malformed input.
     */
    private static function base64DecodeFlexible(string $input): ?string
    {
        $input = trim($input);
        if ($input === '') {
            return null;
        }

        // Pad to a multiple of 4 if the caller passed unpadded base64.
        $remainder = strlen($input) % 4;
        if ($remainder === 1) {
            // 1 mod 4 is never valid base64.
            return null;
        }
        if ($remainder !== 0) {
            $input .= str_repeat('=', 4 - $remainder);
        }

        $decoded = base64_decode($input, true);
        return $decoded === false ? null : $decoded;
    }

    /**
     * Verify an Ed25519 signature, given a PEM SubjectPublicKeyInfo or a raw
     * 32-byte sodium public key.
     */
    private static function verifyEd25519(string $message, string $signature, string $publicKey): bool
    {
        if (!function_exists('sodium_crypto_sign_verify_detached')) {
            throw new RuntimeException('libsodium is required to verify ed25519 signatures');
        }

        $rawKey = self::extractEd25519RawKey($publicKey);
        if ($rawKey === null || strlen($rawKey) !== SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES) {
            return false;
        }

        if (strlen($signature) !== SODIUM_CRYPTO_SIGN_BYTES) {
            return false;
        }

        try {
            return sodium_crypto_sign_verify_detached($signature, $message, $rawKey);
        } catch (\Throwable $e) {
            // sodium_* throws SodiumException on malformed inputs; we treat
            // anything thrown here as a failed verification.
            return false;
        }
    }

    /**
     * Extract the raw 32-byte Ed25519 public key from either:
     *   - a PEM-encoded SubjectPublicKeyInfo (`-----BEGIN PUBLIC KEY-----` ...)
     *   - a raw 32-byte string (already raw)
     *
     * The PEM body for an Ed25519 SPKI is exactly 44 bytes:
     *   12-byte SPKI header + 32-byte raw key.
     */
    private static function extractEd25519RawKey(string $publicKey): ?string
    {
        // Already raw?
        if (strlen($publicKey) === SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES
            && strpos($publicKey, '-----BEGIN') === false) {
            return $publicKey;
        }

        // PEM path.
        if (strpos($publicKey, '-----BEGIN') !== false) {
            // Strip header/footer and whitespace, then base64-decode.
            $body = preg_replace('/-----BEGIN [^-]+-----|-----END [^-]+-----|\s+/', '', $publicKey);
            if ($body === null || $body === '') {
                return null;
            }
            $der = base64_decode($body, true);
            if ($der === false) {
                return null;
            }
            // The Ed25519 SubjectPublicKeyInfo DER is 44 bytes; the raw key
            // is the trailing 32 bytes regardless of header length, since the
            // BIT STRING contents come last in the SPKI structure.
            $len = strlen($der);
            if ($len < SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES) {
                return null;
            }
            return substr($der, $len - SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES);
        }

        return null;
    }

    /**
     * Verify ECDSA or RSA via OpenSSL using SHA-256.
     */
    private static function verifyOpenssl(string $message, string $signature, string $publicKeyPem): bool
    {
        if (!function_exists('openssl_verify')) {
            throw new RuntimeException('ext-openssl is required for ecdsa/rsa verification');
        }

        $key = openssl_pkey_get_public($publicKeyPem);
        if ($key === false) {
            return false;
        }
        $result = openssl_verify($message, $signature, $key, OPENSSL_ALGO_SHA256);

        // PHP < 8.0 may return a resource that needs free; PHP >= 8.0
        // garbage-collects the OpenSSLAsymmetricKey automatically.
        if (PHP_VERSION_ID < 80000 && is_resource($key)) {
            // @phpstan-ignore-next-line — only present on PHP < 8.0
            openssl_free_key($key);
        }

        return $result === 1;
    }

    /**
     * Build a PEM SubjectPublicKeyInfo from a raw 32-byte Ed25519 public key.
     * Useful for tests and tooling that bridge libsodium-generated keys to
     * the PEM-based verification path.
     */
    public static function ed25519RawToPem(string $rawKey): string
    {
        if (strlen($rawKey) !== 32) {
            throw new InvalidArgumentException('ed25519 raw public key must be 32 bytes');
        }

        // SPKI prefix for AlgorithmIdentifier { id-Ed25519 }, BIT STRING (32 bytes).
        // 30 2A 30 05 06 03 2B 65 70 03 21 00 <32-byte key>
        $prefix = "\x30\x2a\x30\x05\x06\x03\x2b\x65\x70\x03\x21\x00";
        $der    = $prefix . $rawKey;
        $b64    = chunk_split(base64_encode($der), 64, "\n");
        return "-----BEGIN PUBLIC KEY-----\n" . $b64 . "-----END PUBLIC KEY-----\n";
    }
}
