<?php
/**
 * Tests for DidWebResolver. HTTP is stubbed via an injected fetcher.
 */

namespace HTMLTrust\Canonicalization\Tests\Keys;

use PHPUnit\Framework\TestCase;
use HTMLTrust\Canonicalization\Keys\DidWebResolver;

class DidWebResolverTest extends TestCase
{
    public function testSupportsDidWebPrefix(): void
    {
        $noop = static function (string $url): ?array {
            return null;
        };
        $resolver = new DidWebResolver($noop);
        $this->assertTrue($resolver->supports('did:web:example.com'));
        $this->assertFalse($resolver->supports('did:key:z123'));
        $this->assertFalse($resolver->supports('https://example.com/key'));
    }

    public function testResolvesBasicDomain(): void
    {
        $captured = ['url' => null];
        $fetcher  = static function (string $url) use (&$captured): ?array {
            $captured['url'] = $url;
            $body = json_encode([
                'id'                 => 'did:web:example.com',
                'verificationMethod' => [
                    [
                        'id'           => 'did:web:example.com#keys-1',
                        'type'         => 'Ed25519VerificationKey2020',
                        'publicKeyPem' => "-----BEGIN PUBLIC KEY-----\nFAKE\n-----END PUBLIC KEY-----\n",
                    ],
                ],
            ]);
            return ['body' => $body, 'contentType' => 'application/did+json'];
        };

        $resolver = new DidWebResolver($fetcher);
        $resolved = $resolver->resolve('did:web:example.com');

        $this->assertNotNull($resolved);
        $this->assertSame('https://example.com/.well-known/did.json', $captured['url']);
        $this->assertSame('ed25519', $resolved->algorithm);
        $this->assertSame('did:web:example.com', $resolved->keyid);
        $this->assertStringContainsString('FAKE', $resolved->publicKeyPem);
    }

    public function testResolvesWithPathSegments(): void
    {
        $captured = ['url' => null];
        $fetcher  = static function (string $url) use (&$captured): ?array {
            $captured['url'] = $url;
            return [
                'body'        => json_encode([
                    'verificationMethod' => [
                        ['type' => 'Ed25519VerificationKey2020', 'publicKeyPem' => 'PEM'],
                    ],
                ]),
                'contentType' => 'application/json',
            ];
        };

        $resolver = new DidWebResolver($fetcher);
        $resolved = $resolver->resolve('did:web:example.com:user:alice');

        $this->assertNotNull($resolved);
        $this->assertSame('https://example.com/user/alice/did.json', $captured['url']);
    }

    public function testIgnoresFragment(): void
    {
        $captured = ['url' => null];
        $fetcher  = static function (string $url) use (&$captured): ?array {
            $captured['url'] = $url;
            return [
                'body'        => json_encode([
                    'verificationMethod' => [
                        ['type' => 'Ed25519VerificationKey2020', 'publicKeyPem' => 'PEM'],
                    ],
                ]),
                'contentType' => '',
            ];
        };

        $resolver = new DidWebResolver($fetcher);
        $resolver->resolve('did:web:example.com#keys-1');
        $this->assertSame('https://example.com/.well-known/did.json', $captured['url']);
    }

    public function testReturnsNullOnFetchFailure(): void
    {
        $resolver = new DidWebResolver(static function (string $url): ?array {
            return null;
        });
        $this->assertNull($resolver->resolve('did:web:example.com'));
    }

    public function testReturnsNullOnInvalidJson(): void
    {
        $fetcher = static function (string $url): ?array {
            return ['body' => 'not json', 'contentType' => 'application/json'];
        };
        $resolver = new DidWebResolver($fetcher);
        $this->assertNull($resolver->resolve('did:web:example.com'));
    }

    public function testReturnsNullWhenNoVerificationMethodHasPem(): void
    {
        $fetcher = static function (string $url): ?array {
            return [
                'body'        => json_encode(['verificationMethod' => [['type' => 'X']]]),
                'contentType' => 'application/json',
            ];
        };
        $resolver = new DidWebResolver($fetcher);
        $this->assertNull($resolver->resolve('did:web:example.com'));
    }

    public function testPicksFirstVerificationMethodWithPem(): void
    {
        $fetcher = static function (string $url): ?array {
            return [
                'body' => json_encode([
                    'verificationMethod' => [
                        ['type' => 'X'],                                                  // skipped: no pem
                        ['type' => 'Ed25519VerificationKey2020', 'publicKeyPem' => 'A'],  // chosen
                        ['type' => 'Ed25519VerificationKey2020', 'publicKeyPem' => 'B'],
                    ],
                ]),
                'contentType' => 'application/json',
            ];
        };
        $resolver = new DidWebResolver($fetcher);
        $resolved = $resolver->resolve('did:web:example.com');
        $this->assertNotNull($resolved);
        $this->assertSame('A', $resolved->publicKeyPem);
    }

    public function testInfersEcdsaFromMethodType(): void
    {
        $fetcher = static function (string $url): ?array {
            return [
                'body' => json_encode([
                    'verificationMethod' => [
                        ['type' => 'EcdsaSecp256r1VerificationKey2019', 'publicKeyPem' => 'PEM'],
                    ],
                ]),
                'contentType' => 'application/json',
            ];
        };
        $resolver = new DidWebResolver($fetcher);
        $resolved = $resolver->resolve('did:web:example.com');
        $this->assertNotNull($resolved);
        $this->assertSame('ecdsa', $resolved->algorithm);
    }

    public function testReadsFromFileFixture(): void
    {
        // Exercise a fetcher that delegates to a real on-disk fixture.
        $fixtureDir = sys_get_temp_dir() . '/htmltrust-didweb-' . bin2hex(random_bytes(4));
        mkdir($fixtureDir . '/.well-known', 0700, true);
        $fixturePath = $fixtureDir . '/.well-known/did.json';
        file_put_contents($fixturePath, json_encode([
            'verificationMethod' => [
                ['type' => 'Ed25519VerificationKey2020', 'publicKeyPem' => 'FROM_FILE'],
            ],
        ]));

        $fetcher = static function (string $url) use ($fixturePath): ?array {
            if ($url === 'https://example.com/.well-known/did.json') {
                return ['body' => file_get_contents($fixturePath), 'contentType' => 'application/json'];
            }
            return null;
        };
        $resolver = new DidWebResolver($fetcher);
        $resolved = $resolver->resolve('did:web:example.com');
        $this->assertNotNull($resolved);
        $this->assertSame('FROM_FILE', $resolved->publicKeyPem);

        unlink($fixturePath);
        rmdir($fixtureDir . '/.well-known');
        rmdir($fixtureDir);
    }
}
