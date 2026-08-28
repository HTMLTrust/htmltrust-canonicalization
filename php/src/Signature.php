<?php
/**
 * HTMLTrust signature binding, verification, and endorsement helpers.
 *
 * Mirrors the JS reference implementation for the frozen v1 signing payload,
 * key resolution, signature verification, and endorsement formats.
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
    public const SIGNING_PROFILE_V1 = 'htmltrust-signature-v1';
    public const CANONICALIZATION_PROFILE_V1 = 'htmltrust-c14n-v1';
    public const ATTRIBUTE_PROFILE_V1 = 'htmltrust-attrs-v1';
    public const URL_PROFILE_V1 = 'htmltrust-safe-url-v1';
    public const SIGNING_CONTEXT_V1 = 'https://htmltrust.org/protocol/signed-section';

    /**
     * Build the legacy 0.2 signing-binding string:
     *
     *     {content-hash}:{claims-hash}:{domain}:{signed-at}
     *
     * All four fields are required; an empty string for any of them
     * raises InvalidArgumentException to surface programmer errors early.
     *
     * @throws InvalidArgumentException
     * @deprecated New integrations must use buildSigningPayloadV1().
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
     * Derive the canonical location fixed by htmltrust-signature-v1.
     *
     * URL scope retains the path and query after WHATWG serialization and
     * removes the fragment. Origin scope returns scheme://host[:port].
     *
     * @throws InvalidArgumentException
     */
    public static function deriveSigningLocationV1(string $documentUrl, string $scope): string
    {
        $url = \Uri\WhatWg\Url::parse($documentUrl);
        if ($url === null
            || strtolower((string) $url->getScheme()) !== 'https'
            || $url->getAsciiHost() === null
            || $url->getAsciiHost() === ''
            || $url->getUsername() !== null
            || $url->getPassword() !== null) {
            throw new InvalidArgumentException('origin-not-supported');
        }

        // Fragments are outside the signed URL scope. All other URL components
        // use the WHATWG serializer, matching the JavaScript binding.
        $withoutFragment = $url->withFragment(null)->toAsciiString();
        if ($scope === 'url') {
            return $withoutFragment;
        }
        if ($scope !== 'origin') {
            throw new InvalidArgumentException('scope-unsupported');
        }

        $originUrl = $url->withPath('/')->withQuery(null)->withFragment(null);
        return rtrim($originUrl->toAsciiString(), '/');
    }

    /** Validate the exact UTC timestamp form fixed by v1. */
    public static function validateSignedAtV1(string $value): string
    {
        if (preg_match('/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\dZ$/D', $value) !== 1) {
            throw new InvalidArgumentException('timestamp-invalid');
        }
        $parsed = \DateTimeImmutable::createFromFormat(
            '!Y-m-d\\TH:i:s\\Z',
            $value,
            new \DateTimeZone('UTC')
        );
        if ($parsed === false || $parsed->format('Y-m-d\\TH:i:s\\Z') !== $value) {
            throw new InvalidArgumentException('timestamp-invalid');
        }
        return $value;
    }

    /**
     * Build the RFC 8785 signing payload fixed by htmltrust-signature-v1.
     *
     * @param array<string, string> $parts
     * @throws InvalidArgumentException
     */
    public static function buildSigningPayloadV1(array $parts): string
    {
        $required = [
            'contentHash',
            'claimsHash',
            'documentURL',
            'scope',
            'keyid',
            'algorithm',
            'signedAt',
        ];
        foreach ($required as $name) {
            if (!array_key_exists($name, $parts)
                || !is_string($parts[$name])
                || $parts[$name] === ''
                || trim($parts[$name]) !== $parts[$name]) {
                throw new InvalidArgumentException('signing-object-invalid: ' . $name);
            }
        }

        self::validateSignedAtV1($parts['signedAt']);
        $document = [
            'algorithm' => $parts['algorithm'],
            'attributeProfile' => self::ATTRIBUTE_PROFILE_V1,
            'canonicalizationProfile' => self::CANONICALIZATION_PROFILE_V1,
            'claimsHash' => $parts['claimsHash'],
            'contentHash' => $parts['contentHash'],
            'context' => self::SIGNING_CONTEXT_V1,
            'keyid' => $parts['keyid'],
            'location' => self::deriveSigningLocationV1($parts['documentURL'], $parts['scope']),
            'profile' => self::SIGNING_PROFILE_V1,
            'scope' => $parts['scope'],
            'signedAt' => $parts['signedAt'],
            'urlProfile' => self::URL_PROFILE_V1,
        ];
        try {
            $encoded = json_encode(
                $document,
                JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
            );
        } catch (\JsonException $e) {
            throw new InvalidArgumentException('signing-object-invalid', 0, $e);
        }
        return Canonicalize::canonicalizeJsonDocument($encoded);
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
        try {
            $document = json_encode([
                'endorsement' => $endorsement,
                'timestamp' => $timestamp,
            ], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        } catch (\JsonException $e) {
            throw new InvalidArgumentException('endorsement is not valid UTF-8', 0, $e);
        }
        return Canonicalize::canonicalizeJsonDocument($document);
    }

    /**
     * Canonicalize one endorsement object using strict RFC 8785 rules.
     *
     * The array form is retained for the original PHP API. Passing raw JSON
     * is also supported so duplicate object members can be rejected before
     * PHP materializes an object and silently overwrites one of them.
     * `signature` is excluded from the signed object, while every other
     * extension member remains part of the binding.
     *
     * @param array<string, mixed>|string $endorsement
     */
    public static function canonicalizeEndorsementDocument($endorsement): string
    {
        if (is_string($endorsement)) {
            // Validate the raw syntax, duplicate names, Unicode scalars, and
            // JCS number range before decoding into a PHP object.
            Canonicalize::canonicalizeJsonDocument($endorsement);
            try {
                $endorsement = json_decode($endorsement, false, 512, JSON_THROW_ON_ERROR);
            } catch (\JsonException $e) {
                throw new InvalidArgumentException('endorsement is not valid JSON', 0, $e);
            }
            if (!is_object($endorsement)) {
                throw new InvalidArgumentException('endorsement must be an object');
            }
            unset($endorsement->signature);
            $document = $endorsement;
        } elseif (is_array($endorsement)) {
            unset($endorsement['signature']);
            $document = $endorsement;
        } else {
            throw new InvalidArgumentException('endorsement must be an object');
        }

        foreach (['endorser', 'endorsement', 'algorithm', 'timestamp'] as $required) {
            $present = is_object($document) ? property_exists($document, $required) : array_key_exists($required, $document);
            $value = is_object($document) ? ($document->{$required} ?? null) : ($document[$required] ?? null);
            if (!$present || !is_string($value) || $value === '') {
                throw new InvalidArgumentException("endorsement {$required} must be non-empty");
            }
        }

        try {
            $encoded = json_encode(
                $document,
                JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
            );
        } catch (\JsonException $e) {
            throw new InvalidArgumentException('endorsement is not valid JSON', 0, $e);
        }
        return Canonicalize::canonicalizeJsonDocument($encoded);
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
     *   - "rsa-pss-sha256": RSA-PSS with SHA-256 and a 32-byte salt.
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

            case 'rsa-pss-sha256':
                return self::verifyRsaPssSha256($message, $signature, $publicKeyPem);

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
        if (!self::endorsementLifecycleIsValid($endorsement)) {
            return false;
        }

        $endorser   = $endorsement['endorser'];
        $signature  = $endorsement['signature'];
        $algoOnWire = $endorsement['algorithm'];

        $resolved = KeyResolution::resolveKey($endorser, $resolvers);
        if ($resolved === null) {
            return false;
        }

        if ($resolved->isRevoked()) {
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

    /** Optional endorsement lifecycle fields fail closed when malformed. */
    private static function endorsementLifecycleIsValid(array $endorsement): bool
    {
        if (array_key_exists('revokedBy', $endorsement)) return false;
        if (!array_key_exists('expires', $endorsement)) return true;
        if (!is_string($endorsement['expires']) || $endorsement['expires'] === '') return false;
        $expiry = self::parseStrictLifecycleExpiry($endorsement['expires']);
        if ($expiry === null) return false;
        return $expiry > new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
    }

    private static function parseStrictLifecycleExpiry(string $value): ?\DateTimeImmutable
    {
        if (preg_match(
            '/^((?!0000)\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(?:\.\d+)?Z$/D',
            $value,
            $parts
        ) !== 1) {
            return null;
        }
        try {
            $expiry = new \DateTimeImmutable($value, new \DateTimeZone('UTC'));
        } catch (\Exception $e) {
            return null;
        }
        if ($expiry->format('Y-m-d\TH:i:s') !== $parts[1]) {
            return null;
        }
        return $expiry;
    }

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

        // PEM path. Ed25519 SPKI has one exact DER shape: the 12-byte
        // SubjectPublicKeyInfo prefix followed by the 32-byte key. Requiring
        // the complete structure prevents an unrelated key or arbitrary
        // trailing DER bytes from being accepted as an Ed25519 key.
        if (preg_match(
            '/\A-----BEGIN PUBLIC KEY-----\s*(.*?)\s*-----END PUBLIC KEY-----\s*\z/s',
            $publicKey,
            $matches
        ) !== 1) {
            return null;
        }
        $body = preg_replace('/\s+/', '', $matches[1]);
        if (!is_string($body) || $body === '') {
            return null;
        }
        $der = base64_decode($body, true);
        $prefix = "\x30\x2a\x30\x05\x06\x03\x2b\x65\x70\x03\x21\x00";
        if ($der === false || strlen($der) !== strlen($prefix) + SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES
            || substr($der, 0, strlen($prefix)) !== $prefix) {
            return null;
        }
        return substr($der, strlen($prefix));

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

    /**
     * Verify RSA-PSS(SHA-256, saltLength=32), matching the JS and Go
     * implementations. PHP's openssl_verify() does not expose PSS padding
     * options, so recover the EMSA-PSS encoded message with the RSA public
     * operation and verify EMSA-PSS-VERIFY (RFC 8017 §9.1.2) directly.
     */
    private static function verifyRsaPssSha256(string $message, string $signature, string $publicKeyPem): bool
    {
        if (!function_exists('openssl_public_decrypt') || !function_exists('openssl_pkey_get_public')) {
            throw new RuntimeException('ext-openssl is required for rsa verification');
        }

        $key = openssl_pkey_get_public($publicKeyPem);
        if ($key === false) {
            return false;
        }
        $details = openssl_pkey_get_details($key);
        // OpenSSL 3 exposes RSA-PSS-restricted keys as type -1. Reject those
        // here because this implementation cannot inspect their PSS parameter
        // restrictions before applying the fixed SHA-256/MGF1/salt policy.
        if (!is_array($details) || ($details['type'] ?? null) !== OPENSSL_KEYTYPE_RSA) {
            return false;
        }
        $bits = (int) ($details['bits'] ?? 0);
        if ($bits < 512 || strlen($signature) !== (int) ceil($bits / 8)) {
            return false;
        }

        $encoded = '';
        // NO_PADDING asks OpenSSL for the raw RSA public-operation result.
        if (@openssl_public_decrypt($signature, $encoded, $key, OPENSSL_NO_PADDING) !== true) {
            return false;
        }

        $emBits = $bits - 1;
        $emLen = (int) ceil($emBits / 8);
        // RSA operations return k octets. For a modulus whose bit length is
        // not byte-aligned, EMSA-PSS uses k-1 octets and the leading zero is
        // omitted from the encoded message.
        if (strlen($encoded) === $emLen + 1 && $encoded[0] === "\0") {
            $encoded = substr($encoded, 1);
        }
        if (strlen($encoded) !== $emLen || $emLen < 32 + 32 + 2) {
            return false;
        }

        $hLen = 32;
        $saltLen = 32;
        if (substr($encoded, -1) !== "\xbc") {
            return false;
        }
        $maskedDbLen = $emLen - $hLen - 1;
        $maskedDb = substr($encoded, 0, $maskedDbLen);
        $hash = substr($encoded, $maskedDbLen, $hLen);
        $unusedBits = 8 * $emLen - $emBits;
        if ($unusedBits > 0 && (ord($maskedDb[0]) & (0xff << (8 - $unusedBits))) !== 0) {
            return false;
        }

        $dbMask = self::mgf1Sha256($hash, $maskedDbLen);
        $db = $maskedDb ^ $dbMask;
        if ($unusedBits > 0) {
            $db[0] = chr(ord($db[0]) & (0xff >> $unusedBits));
        }
        $paddingLength = $emLen - $hLen - $saltLen - 2;
        if (substr($db, 0, $paddingLength) !== str_repeat("\0", $paddingLength)
            || ($db[$paddingLength] ?? '') !== "\x01") {
            return false;
        }
        $salt = substr($db, -$saltLen);
        $messageHash = hash('sha256', $message, true);
        $expectedHash = hash('sha256', str_repeat("\0", 8) . $messageHash . $salt, true);
        return hash_equals($expectedHash, $hash);
    }

    private static function mgf1Sha256(string $seed, int $length): string
    {
        $mask = '';
        for ($counter = 0; strlen($mask) < $length; $counter++) {
            $mask .= hash('sha256', $seed . pack('N', $counter), true);
        }
        return substr($mask, 0, $length);
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
