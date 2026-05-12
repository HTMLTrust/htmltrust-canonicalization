<?php
/**
 * Tests for TrustDirectoryResolver.
 */

namespace HTMLTrust\Canonicalization\Tests\Keys;

use PHPUnit\Framework\TestCase;
use HTMLTrust\Canonicalization\Keys\TrustDirectoryResolver;

class TrustDirectoryResolverTest extends TestCase
{
    public function testSupportsOpaqueKeyids(): void
    {
        $noop = static function (string $url): ?array {
            return null;
        };
        $resolver = new TrustDirectoryResolver([], $noop);
        $this->assertTrue($resolver->supports('abc123'));
        $this->assertFalse($resolver->supports('did:web:example.com'));
        $this->assertFalse($resolver->supports('https://example.com/key'));
        $this->assertFalse($resolver->supports(''));
    }

    public function testQueriesEachBaseInOrder(): void
    {
        $calls = [];
        $fetcher = static function (string $url) use (&$calls): ?array {
            $calls[] = $url;
            // First base 404s, second succeeds.
            if (strpos($url, 'second.example') !== false) {
                return [
                    'body'        => json_encode(['publicKey' => 'PEM', 'algorithm' => 'ed25519']),
                    'contentType' => 'application/json',
                ];
            }
            return null;
        };

        $resolver = new TrustDirectoryResolver(
            ['https://first.example/v1', 'https://second.example/v1/'],
            $fetcher
        );
        $resolved = $resolver->resolve('abc123');

        $this->assertNotNull($resolved);
        $this->assertSame('PEM', $resolved->publicKeyPem);
        $this->assertSame(2, count($calls));
        $this->assertSame('https://first.example/v1/keys/abc123', $calls[0]);
        // Trailing slash on the second base should be normalized.
        $this->assertSame('https://second.example/v1/keys/abc123', $calls[1]);
    }

    public function testReturnsNullWhenAllBasesFail(): void
    {
        $resolver = new TrustDirectoryResolver(
            ['https://a.example', 'https://b.example'],
            static function (string $url): ?array {
                return null;
            }
        );
        $this->assertNull($resolver->resolve('abc123'));
    }

    public function testUrlEncodesKeyid(): void
    {
        $captured = ['url' => null];
        $fetcher  = static function (string $url) use (&$captured): ?array {
            $captured['url'] = $url;
            return [
                'body'        => json_encode(['publicKey' => 'PEM']),
                'contentType' => 'application/json',
            ];
        };
        $resolver = new TrustDirectoryResolver(['https://dir.example/v1'], $fetcher);
        $resolver->resolve('id with spaces/and slashes');
        $this->assertSame(
            'https://dir.example/v1/keys/id%20with%20spaces%2Fand%20slashes',
            $captured['url']
        );
    }

    public function testStopsAtFirstSuccess(): void
    {
        $calls = [];
        $fetcher = static function (string $url) use (&$calls): ?array {
            $calls[] = $url;
            return [
                'body'        => json_encode(['publicKey' => 'PEM']),
                'contentType' => 'application/json',
            ];
        };
        $resolver = new TrustDirectoryResolver(
            ['https://first.example', 'https://second.example'],
            $fetcher
        );
        $resolved = $resolver->resolve('abc123');
        $this->assertNotNull($resolved);
        $this->assertSame(1, count($calls)); // second base never queried
    }

    public function testIgnoresInvalidJsonBaseAndContinues(): void
    {
        $fetcher = static function (string $url): ?array {
            if (strpos($url, 'first') !== false) {
                return ['body' => 'not json', 'contentType' => 'application/json'];
            }
            return [
                'body'        => json_encode(['publicKey' => 'PEM']),
                'contentType' => 'application/json',
            ];
        };
        $resolver = new TrustDirectoryResolver(
            ['https://first.example', 'https://second.example'],
            $fetcher
        );
        $resolved = $resolver->resolve('abc123');
        $this->assertNotNull($resolved);
        $this->assertSame('PEM', $resolved->publicKeyPem);
    }
}
