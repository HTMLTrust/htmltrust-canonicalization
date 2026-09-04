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
        $did = 'did:web:example.com:user:alice';
        $fetcher  = static function (string $url) use (&$captured, $did): ?array {
            $captured['url'] = $url;
            return [
                'body'        => json_encode([
                    'id' => $did,
                    'verificationMethod' => [
                        ['id' => '#key-1', 'type' => 'Ed25519VerificationKey2020', 'publicKeyPem' => 'PEM'],
                    ],
                ]),
                'contentType' => 'application/json',
            ];
        };

        $resolver = new DidWebResolver($fetcher);
        $resolved = $resolver->resolve($did);

        $this->assertNotNull($resolved);
        $this->assertSame('https://example.com/user/alice/did.json', $captured['url']);
        $this->assertSame($did . '#key-1', $resolved->methodId);
        $this->assertSame(0, $resolved->period);
    }

    public function testPreservesPercentEncodedPathSegments(): void
    {
        $captured = ['url' => null];
        $did = 'did:web:example.com:foo%2Fbar';
        $resolver = new DidWebResolver(static function (string $url) use (&$captured, $did): ?array {
            $captured['url'] = $url;
            return [
                'body' => json_encode(['id' => $did, 'verificationMethod' => [['id' => '#key-1', 'publicKeyPem' => 'PEM']]]),
                'contentType' => 'application/did+json',
            ];
        });

        $this->assertNotNull($resolver->resolve($did));
        $this->assertSame('https://example.com/foo%2Fbar/did.json', $captured['url']);
    }

    public function testValidatesAndDecodesEncodedPortAuthority(): void
    {
        $captured = ['url' => null];
        $did = 'did:web:example.com%3A3000:user';
        $resolver = new DidWebResolver(static function (string $url) use (&$captured, $did): ?array {
            $captured['url'] = $url;
            return [
                'body' => json_encode(['id' => $did, 'verificationMethod' => [['id' => '#key-1', 'publicKeyPem' => 'PEM']]]),
                'contentType' => 'application/did+json',
            ];
        });

        $this->assertNotNull($resolver->resolve($did));
        $this->assertSame('https://example.com:3000/user/did.json', $captured['url']);
    }

    /** @dataProvider invalidAuthorityProvider */
    public function testRejectsInvalidAuthority(string $keyid): void
    {
        $called = false;
        $resolver = new DidWebResolver(static function (string $url) use (&$called): ?array {
            $called = true;
            return null;
        });

        $this->assertNull($resolver->resolve($keyid));
        $this->assertFalse($called);
    }

    public static function invalidAuthorityProvider(): array
    {
        return [
            'userinfo' => ['did:web:example.com@evil.com'],
            'nonnumeric port' => ['did:web:example.com%3Aabc'],
            'unexpected escape' => ['did:web:example%2Ecom'],
        ];
    }

    public function testIgnoresFragment(): void
    {
        $captured = ['url' => null];
        $fetcher  = static function (string $url) use (&$captured): ?array {
            $captured['url'] = $url;
            return [
                'body'        => json_encode([
                    'id' => 'did:web:example.com',
                    'verificationMethod' => [
                        ['id' => '#keys-1', 'type' => 'Ed25519VerificationKey2020', 'publicKeyPem' => 'PEM'],
                    ],
                ]),
                'contentType' => '',
            ];
        };

        $resolver = new DidWebResolver($fetcher);
        $resolved = $resolver->resolve('did:web:example.com#keys-1');
        $this->assertSame('https://example.com/.well-known/did.json', $captured['url']);
        // The fragment never reaches the document URL, but it still governs
        // exact-id selection (spec §9.10).
        $this->assertNotNull($resolved);
        $this->assertSame('did:web:example.com#keys-1', $resolved->methodId);
    }

    public function testReturnsNullOnFetchFailure(): void
    {
        $resolver = new DidWebResolver(static function (string $url): ?array {
            return null;
        });
        $this->assertNull($resolver->resolve('did:web:example.com'));
    }

    public function testRejectsOversizedInjectedResponse(): void
    {
        $resolver = new DidWebResolver(static function (string $url): ?array {
            return ['body' => str_repeat('x', 64 * 1024 + 1), 'contentType' => 'application/json'];
        });
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('resource-limit-exceeded');
        $resolver->resolve('did:web:example.com');
    }

    public function testReturnsNullOnInvalidJson(): void
    {
        $fetcher = static function (string $url): ?array {
            return ['body' => 'not json', 'contentType' => 'application/json'];
        };
        $resolver = new DidWebResolver($fetcher);
        $this->assertNull($resolver->resolve('did:web:example.com'));
    }

    public function testReturnsNullWhenNoNonPeriodMethodExists(): void
    {
        // A document holding only period methods has no anchor for a bare
        // keyid to resolve to (spec §9.10): key-resolution-failed, not a
        // fallback to a period entry.
        $fetcher = static function (string $url): ?array {
            return [
                'body'        => json_encode([
                    'id' => 'did:web:example.com',
                    'verificationMethod' => [
                        ['id' => '#p1', 'type' => 'X', 'publicKeyPem' => 'PEM'],
                    ],
                ]),
                'contentType' => 'application/json',
            ];
        };
        $resolver = new DidWebResolver($fetcher);
        $this->assertNull($resolver->resolve('did:web:example.com'));
    }

    public function testFirstNonPeriodEntryWinsRegardlessOfPosition(): void
    {
        // Array position 0 is a period method; bare selection MUST still
        // skip it (spec §9.10) and select the first non-period entry.
        $fetcher = static function (string $url): ?array {
            return [
                'body' => json_encode([
                    'id' => 'did:web:example.com',
                    'verificationMethod' => [
                        ['id' => '#p1', 'type' => 'Ed25519VerificationKey2020', 'publicKeyPem' => 'PERIOD-1'],
                        ['id' => '#a', 'type' => 'Ed25519VerificationKey2020', 'publicKeyPem' => 'A'],
                        ['id' => '#b', 'type' => 'Ed25519VerificationKey2020', 'publicKeyPem' => 'B'],
                    ],
                ]),
                'contentType' => 'application/json',
            ];
        };
        $resolver = new DidWebResolver($fetcher);
        $resolved = $resolver->resolve('did:web:example.com');
        $this->assertNotNull($resolved);
        $this->assertSame('A', $resolved->publicKeyPem);
        $this->assertSame('did:web:example.com#a', $resolved->methodId);
        $this->assertSame(0, $resolved->period);
    }

    public function testFirstNonPeriodEntryWithoutPemIsMalformed(): void
    {
        // Selection is by array order among non-period entries; there is no
        // fall-through to a later entry when the selected one lacks
        // publicKeyPem (spec §9.10 step 4).
        $fetcher = static function (string $url): ?array {
            return [
                'body' => json_encode([
                    'id' => 'did:web:example.com',
                    'verificationMethod' => [
                        ['id' => '#a', 'type' => 'X'], // selected, but has no publicKeyPem
                        ['id' => '#b', 'type' => 'Ed25519VerificationKey2020', 'publicKeyPem' => 'B'],
                    ],
                ]),
                'contentType' => 'application/json',
            ];
        };
        $resolver = new DidWebResolver($fetcher);
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('malformed-key-document');
        $resolver->resolve('did:web:example.com');
    }

    public function testDoesNotSkipRevokedOrExpiredMethods(): void
    {
        // Spec §9.10: revoked or expired entries are still returned, with
        // their lifecycle fields, so the caller can report "key-revoked".
        // The resolver itself never skips to another entry on this basis.
        $fetcher = static function (string $url): ?array {
            return [
                'body' => json_encode([
                    'id' => 'did:web:example.com',
                    'verificationMethod' => [
                        ['id' => '#a', 'type' => 'Ed25519VerificationKey2020', 'publicKeyPem' => 'REVOKED', 'revoked' => true],
                        ['id' => '#b', 'type' => 'Ed25519VerificationKey2020', 'publicKeyPem' => 'LIVE'],
                    ],
                ]),
                'contentType' => 'application/did+json',
            ];
        };

        $resolved = (new DidWebResolver($fetcher))->resolve('did:web:example.com');
        $this->assertNotNull($resolved);
        $this->assertSame('REVOKED', $resolved->publicKeyPem);
        $this->assertTrue($resolved->revoked);
        $this->assertTrue($resolved->isRevoked());
    }

    public function testDeactivatedDocumentDoesNotResolve(): void
    {
        $resolver = new DidWebResolver(static function (string $url): ?array {
            return [
                'body' => json_encode([
                    'deactivated' => true,
                    'verificationMethod' => [['publicKeyPem' => 'PEM']],
                ]),
                'contentType' => 'application/did+json',
            ];
        });
        $this->assertNull($resolver->resolve('did:web:example.com'));
    }

    public function testMalformedExpiryIsReturnedAsIsForCallerToReject(): void
    {
        // A malformed expires value on the selected entry is not this
        // resolver's decision: it is returned as-is, and ResolvedKey's own
        // lifecycle policy (isRevoked()) treats it as revoked.
        $resolver = new DidWebResolver(static function (string $url): ?array {
            return [
                'body' => json_encode([
                    'id' => 'did:web:example.com',
                    'verificationMethod' => [
                        ['id' => '#a', 'publicKeyPem' => 'BAD', 'expires' => '2026-01-01T00:00:00+00:00'],
                        ['id' => '#b', 'publicKeyPem' => 'GOOD', 'expires' => '2999-01-01T00:00:00Z'],
                    ],
                ]),
                'contentType' => 'application/did+json',
            ];
        });
        $resolved = $resolver->resolve('did:web:example.com');
        $this->assertNotNull($resolved);
        $this->assertSame('BAD', $resolved->publicKeyPem);
        $this->assertSame('2026-01-01T00:00:00+00:00', $resolved->expires);
        $this->assertTrue($resolved->isRevoked());
    }

    public function testInfersEcdsaFromMethodType(): void
    {
        $fetcher = static function (string $url): ?array {
            return [
                'body' => json_encode([
                    'id' => 'did:web:example.com',
                    'verificationMethod' => [
                        ['id' => '#key-1', 'type' => 'EcdsaSecp256r1VerificationKey2019', 'publicKeyPem' => 'PEM'],
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
            'id' => 'did:web:example.com',
            'verificationMethod' => [
                ['id' => '#key-1', 'type' => 'Ed25519VerificationKey2020', 'publicKeyPem' => 'FROM_FILE'],
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
