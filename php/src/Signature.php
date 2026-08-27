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
        self::validateSerializedOrigin($domain);
        if ($signedAt === '') {
            throw new InvalidArgumentException('signedAt must be non-empty');
        }

        return $contentHash . ':' . $claimsHash . ':' . $domain . ':' . $signedAt;
    }

    /**
     * Validate the legacy-named domain field as a serialized Web origin.
     *
     * @throws InvalidArgumentException
     */
    public static function validateSerializedOrigin(string $origin): string
    {
        $parts = parse_url($origin);
        if (!is_array($parts) || empty($parts['scheme']) || empty($parts['host'])) {
            throw new InvalidArgumentException('domain must be a serialized Web origin');
        }
        foreach (['user', 'pass', 'path', 'query', 'fragment'] as $forbidden) {
            if (array_key_exists($forbidden, $parts)) {
                throw new InvalidArgumentException('domain must be a serialized Web origin');
            }
        }
        $scheme = strtolower((string) $parts['scheme']);
        if ($scheme !== 'http' && $scheme !== 'https') {
            throw new InvalidArgumentException('domain must use the http or https scheme');
        }
        $host = strtolower(trim((string) $parts['host'], '[]'));
        $serializedHost = strpos($host, ':') !== false ? '[' . $host . ']' : $host;
        $canonical = $scheme . '://' . $serializedHost;
        if (isset($parts['port'])) {
            $port = (int) $parts['port'];
            if (!(($scheme === 'http' && $port === 80) || ($scheme === 'https' && $port === 443))) {
                $canonical = $scheme . '://' . $serializedHost . ':' . $port;
            }
        }
        if ($canonical !== $origin) {
            throw new InvalidArgumentException('domain must use canonical serialized origin form: ' . $canonical);
        }
        return $origin;
    }

    /**
     * Build the canonical endorsement signing payload: deterministic JSON
     * with object keys sorted and the signature field omitted.
     *
     * @throws InvalidArgumentException
     */
    public static function buildEndorsementBinding($endorsement, ?string $timestamp = null): string
    {
        if (is_array($endorsement)) {
            return self::canonicalizeEndorsementDocument($endorsement);
        }
        if ($endorsement === '') {
            throw new InvalidArgumentException('endorsement must be non-empty');
        }
        if ($timestamp === null || $timestamp === '') {
            throw new InvalidArgumentException('timestamp must be non-empty');
        }
        return self::canonicalJson([
            'endorsement' => $endorsement,
            'timestamp' => $timestamp,
        ]);
    }

    /**
     * @param array<string, mixed> $endorsement
     */
    public static function canonicalizeEndorsementDocument(array $endorsement): string
    {
        unset($endorsement['signature']);
        foreach (['endorser', 'endorsement', 'algorithm', 'timestamp'] as $required) {
            if (!isset($endorsement[$required]) || !is_string($endorsement[$required]) || $endorsement[$required] === '') {
                throw new InvalidArgumentException("endorsement {$required} must be non-empty");
            }
        }
        return self::canonicalJson($endorsement);
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
     * The signature must be canonical unpadded standard Base64.
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

        $signature = self::base64DecodeCanonical($signatureB64);
        if ($signature === null) {
            return false;
        }

        switch ($algo) {
            case 'ed25519':
                return self::verifyEd25519($message, $signature, $publicKeyPem);

            case 'ecdsa':
                return self::verifyOpenssl($message, $signature, $publicKeyPem, OPENSSL_ALGO_SHA256, OPENSSL_KEYTYPE_EC);

            case 'rsa':
                return self::verifyOpenssl($message, $signature, $publicKeyPem, OPENSSL_ALGO_SHA256, OPENSSL_KEYTYPE_RSA);

            case 'ecdsa-p256':
                return self::verifyEcdsaP1363($message, $signature, $publicKeyPem, 'prime256v1', OPENSSL_ALGO_SHA256, 32);

            case 'ecdsa-p384':
                return self::verifyEcdsaP1363($message, $signature, $publicKeyPem, 'secp384r1', OPENSSL_ALGO_SHA384, 48);

            case 'rsa-pkcs1-sha256':
                return self::verifyOpenssl($message, $signature, $publicKeyPem, OPENSSL_ALGO_SHA256, OPENSSL_KEYTYPE_RSA);

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
     *   - "algorithm":    signature algorithm identifier
     *
     * Returns true iff the endorser's resolved key validates the signature
     * over the deterministic JSON document with `signature` omitted.
     *
     * @param array<string, mixed> $endorsement
     * @param array<int, KeyResolver> $resolvers
     */
    public static function verifyEndorsement(array $endorsement, array $resolvers): bool
    {
        foreach (['endorser', 'endorsement', 'signature', 'timestamp', 'algorithm'] as $required) {
            if (!isset($endorsement[$required]) || !is_string($endorsement[$required]) || $endorsement[$required] === '') {
                return false;
            }
        }

        $endorser   = $endorsement['endorser'];
        $signature  = $endorsement['signature'];
        $algoOnWire = $endorsement['algorithm'];

        $resolved = KeyResolution::resolveKey($endorser, $resolvers);
        if ($resolved === null) {
            return false;
        }

        if (!self::algorithmsCompatible($resolved->algorithm, $algoOnWire)) {
            return false;
        }

        try {
            $message = self::canonicalizeEndorsementDocument($endorsement);
            return self::verifySignature($message, $signature, $resolved->publicKeyPem, $algoOnWire);
        } catch (InvalidArgumentException $e) {
            return false;
        }
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    /**
     * Decode canonical unpadded standard Base64. Returns null on malformed or
     * non-canonical input.
     */
    private static function base64DecodeCanonical(string $input): ?string
    {
        if ($input === '') {
            return null;
        }
        if (preg_match('/[^A-Za-z0-9+\/]/', $input) === 1) {
            return null;
        }
        $remainder = strlen($input) % 4;
        if ($remainder === 1) {
            return null;
        }
        $padded = $input;
        if ($remainder !== 0) {
            $padded .= str_repeat('=', 4 - $remainder);
        }

        $decoded = base64_decode($padded, true);
        if ($decoded === false) {
            return null;
        }
        if (rtrim(base64_encode($decoded), '=') !== $input) {
            return null;
        }
        return $decoded;
    }

    /**
     * @param mixed $value
     */
    private static function canonicalJson($value): string
    {
        if (is_array($value)) {
            if ($value === [] || array_keys($value) === range(0, count($value) - 1)) {
                $items = array_map([self::class, 'canonicalJson'], $value);
                return '[' . implode(',', $items) . ']';
            }
            uksort($value, static function ($left, $right): int {
                return strcmp(
                    mb_convert_encoding((string) $left, 'UTF-16BE', 'UTF-8'),
                    mb_convert_encoding((string) $right, 'UTF-16BE', 'UTF-8')
                );
            });
            $items = [];
            foreach ($value as $key => $item) {
                if ($item === null) {
                    $items[] = json_encode((string) $key, JSON_UNESCAPED_SLASHES) . ':null';
                } else {
                    $items[] = json_encode((string) $key, JSON_UNESCAPED_SLASHES) . ':' . self::canonicalJson($item);
                }
            }
            return '{' . implode(',', $items) . '}';
        }
        if (is_string($value)) {
            return json_encode($value, JSON_UNESCAPED_SLASHES);
        }
        if (is_int($value) || is_float($value)) {
            return json_encode($value, JSON_UNESCAPED_SLASHES);
        }
        if (is_bool($value)) {
            return $value ? 'true' : 'false';
        }
        if ($value === null) {
            return 'null';
        }
        throw new InvalidArgumentException('unsupported JSON value');
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
    private static function verifyOpenssl(
        string $message,
        string $signature,
        string $publicKeyPem,
        int $digestAlgorithm,
        ?int $expectedKeyType = null
    ): bool
    {
        if (!function_exists('openssl_verify')) {
            throw new RuntimeException('ext-openssl is required for ecdsa/rsa verification');
        }

        $key = openssl_pkey_get_public($publicKeyPem);
        if ($key === false) {
            return false;
        }
        if ($expectedKeyType !== null) {
            $details = openssl_pkey_get_details($key);
            if (!is_array($details) || $details['type'] !== $expectedKeyType) {
                return false;
            }
        }
        $result = openssl_verify($message, $signature, $key, $digestAlgorithm);

        // PHP < 8.0 may return a resource that needs free; PHP >= 8.0
        // garbage-collects the OpenSSLAsymmetricKey automatically.
        if (PHP_VERSION_ID < 80000 && is_resource($key)) {
            // @phpstan-ignore-next-line — only present on PHP < 8.0
            openssl_free_key($key);
        }

        return $result === 1;
    }

    private static function verifyEcdsaP1363(
        string $message,
        string $signature,
        string $publicKeyPem,
        string $expectedCurve,
        int $digestAlgorithm,
        int $componentBytes
    ): bool {
        if (strlen($signature) !== $componentBytes * 2) {
            return false;
        }
        $key = openssl_pkey_get_public($publicKeyPem);
        if ($key === false) {
            return false;
        }
        $details = openssl_pkey_get_details($key);
        $curve = is_array($details) && isset($details['ec']['curve_name'])
            ? strtolower((string) $details['ec']['curve_name'])
            : '';
        $acceptedCurves = $expectedCurve === 'prime256v1'
            ? ['prime256v1', 'secp256r1']
            : ['secp384r1'];
        if (!in_array($curve, $acceptedCurves, true)) {
            return false;
        }
        $der = self::p1363ToDer($signature, $componentBytes);
        return openssl_verify($message, $der, $key, $digestAlgorithm) === 1;
    }

    private static function p1363ToDer(string $signature, int $componentBytes): string
    {
        $encodeInteger = static function (string $integer): string {
            $integer = ltrim($integer, "\x00");
            if ($integer === '') {
                $integer = "\x00";
            }
            if ((ord($integer[0]) & 0x80) !== 0) {
                $integer = "\x00" . $integer;
            }
            return "\x02" . chr(strlen($integer)) . $integer;
        };
        $r = $encodeInteger(substr($signature, 0, $componentBytes));
        $s = $encodeInteger(substr($signature, $componentBytes));
        return "\x30" . chr(strlen($r) + strlen($s)) . $r . $s;
    }

    private static function algorithmsCompatible(string $resolved, string $declared): bool
    {
        $resolved = strtolower($resolved);
        $declared = strtolower($declared);
        if ($resolved === $declared) {
            return true;
        }
        $family = static function (string $algorithm): string {
            if (strpos($algorithm, 'ecdsa') === 0) {
                return 'ecdsa';
            }
            if (strpos($algorithm, 'rsa') === 0) {
                return 'rsa';
            }
            return $algorithm;
        };
        $resolvedFamily = $family($resolved);
        $declaredFamily = $family($declared);
        if ($resolvedFamily !== $declaredFamily) {
            return false;
        }
        if ($resolved === $resolvedFamily || $declared === $declaredFamily) {
            return true;
        }
        return $resolvedFamily === 'rsa';
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
