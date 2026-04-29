<?php
/**
 * Tests for DirectUrlResolver.
 */

namespace HTMLTrust\Canonicalization\Tests\Keys;

use PHPUnit\Framework\TestCase;
use HTMLTrust\Canonicalization\Keys\DirectUrlResolver;

class DirectUrlResolverTest extends TestCase
{
    public function testSupportsHttpAndHttps(): void
    {
        $noop = static function (string $url): ?array {
            return null;
        };
        $resolver = new DirectUrlResolver($noop);
        $this->assertTrue($resolver->supports('https://example.com/key.json'));
        $this->assertTrue($resolver->supports('http://example.com/key.json'));
        $this->assertFalse($resolver->supports('did:web:example.com'));
        $this->assertFalse($resolver->supports('opaque-id'));
    }

    public function testResolvesJsonDocument(): void
    {
        $fetcher = static function (string $url): ?array {
            return [
                'body'        => json_encode(['publicKey' => 'PEM-BODY', 'algorithm' => 'rsa']),
                'contentType' => 'application/json',
            ];
        };
        $resolver = new DirectUrlResolver($fetcher);
        $resolved = $resolver->resolve('https://example.com/key.json');

        $this->assertNotNull($resolved);
        $this->assertSame('PEM-BODY', $resolved->publicKeyPem);
        $this->assertSame('rsa', $resolved->algorithm);
        $this->assertSame('https://example.com/key.json', $resolved->keyid);
    }

    public function testDefaultsAlgorithmToEd25519(): void
    {
        $fetcher = static function (string $url): ?array {
            return [
                'body'        => json_encode(['publicKey' => 'PEM']),
                'contentType' => 'application/json',
            ];
        };
        $resolver = new DirectUrlResolver($fetcher);
        $resolved = $resolver->resolve('https://example.com/key.json');
        $this->assertNotNull($resolved);
        $this->assertSame('ed25519', $resolved->algorithm);
    }

    public function testAcceptsPublicKeyPemSynonym(): void
    {
        $fetcher = static function (string $url): ?array {
            return [
                'body'        => json_encode(['publicKeyPem' => 'PEM-BODY']),
                'contentType' => 'application/json',
            ];
        };
        $resolver = new DirectUrlResolver($fetcher);
        $resolved = $resolver->resolve('https://example.com/key.json');
        $this->assertNotNull($resolved);
        $this->assertSame('PEM-BODY', $resolved->publicKeyPem);
    }

    public function testRecognizesRawPemByContentType(): void
    {
        $fetcher = static function (string $url): ?array {
            return [
                'body'        => "-----BEGIN PUBLIC KEY-----\nABC\n-----END PUBLIC KEY-----\n",
                'contentType' => 'application/x-pem-file',
            ];
        };
        $resolver = new DirectUrlResolver($fetcher);
        $resolved = $resolver->resolve('https://example.com/key.pem');
        $this->assertNotNull($resolved);
        $this->assertStringContainsString('BEGIN PUBLIC KEY', $resolved->publicKeyPem);
        $this->assertSame('ed25519', $resolved->algorithm);
    }

    public function testRecognizesRawPemByBodyPrelude(): void
    {
        $fetcher = static function (string $url): ?array {
            return [
                'body'        => "-----BEGIN PUBLIC KEY-----\nABC\n-----END PUBLIC KEY-----\n",
                'contentType' => 'text/plain', // mislabelled
            ];
        };
        $resolver = new DirectUrlResolver($fetcher);
        $resolved = $resolver->resolve('https://example.com/key.pem');
        $this->assertNotNull($resolved);
    }

    public function testReturnsNullOnFetchFailure(): void
    {
        $resolver = new DirectUrlResolver(static function (string $url): ?array {
            return null;
        });
        $this->assertNull($resolver->resolve('https://example.com/key.json'));
    }

    public function testReturnsNullForUnsupportedScheme(): void
    {
        $fetcher = static function (string $url): ?array {
            return ['body' => '{}', 'contentType' => 'application/json'];
        };
        $resolver = new DirectUrlResolver($fetcher);
        $this->assertNull($resolver->resolve('did:web:example.com'));
    }

    public function testReturnsNullOnMalformedJson(): void
    {
        $fetcher = static function (string $url): ?array {
            return ['body' => 'not json', 'contentType' => 'application/json'];
        };
        $resolver = new DirectUrlResolver($fetcher);
        $this->assertNull($resolver->resolve('https://example.com/key.json'));
    }

    public function testReturnsNullWhenJsonHasNoKey(): void
    {
        $fetcher = static function (string $url): ?array {
            return ['body' => '{"unrelated":1}', 'contentType' => 'application/json'];
        };
        $resolver = new DirectUrlResolver($fetcher);
        $this->assertNull($resolver->resolve('https://example.com/key.json'));
    }
}
