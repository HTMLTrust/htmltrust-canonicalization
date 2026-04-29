<?php
/**
 * Tests for KeyResolution::resolveKey() chain walker.
 */

namespace HTMLTrust\Canonicalization\Tests\Keys;

use PHPUnit\Framework\TestCase;
use HTMLTrust\Canonicalization\Keys\KeyResolution;
use HTMLTrust\Canonicalization\Keys\KeyResolver;
use HTMLTrust\Canonicalization\Keys\ResolvedKey;

class KeyResolutionTest extends TestCase
{
    public function testReturnsNullWhenNoResolverSupports(): void
    {
        $a = new RecordingResolver(['mine'], null);
        $b = new RecordingResolver(['yours'], null);
        $this->assertNull(KeyResolution::resolveKey('theirs', [$a, $b]));
        $this->assertSame(0, $a->resolveCalls);
        $this->assertSame(0, $b->resolveCalls);
    }

    public function testSkipsToNextResolverWhenFirstFails(): void
    {
        $a = new RecordingResolver(['x'], null);          // supports but resolve()=null
        $b = new RecordingResolver(['x'], 'PEM-FROM-B'); // supports + succeeds
        $resolved = KeyResolution::resolveKey('x', [$a, $b]);
        $this->assertNotNull($resolved);
        $this->assertSame('PEM-FROM-B', $resolved->publicKeyPem);
        $this->assertSame(1, $a->resolveCalls);
        $this->assertSame(1, $b->resolveCalls);
    }

    public function testFirstSupportingAndResolvingResolverWins(): void
    {
        $a = new RecordingResolver(['x'], 'A');
        $b = new RecordingResolver(['x'], 'B');
        $resolved = KeyResolution::resolveKey('x', [$a, $b]);
        $this->assertSame('A', $resolved->publicKeyPem);
        $this->assertSame(0, $b->resolveCalls); // short-circuit
    }

    public function testIgnoresNonResolvers(): void
    {
        $a = new RecordingResolver(['x'], 'A');
        // Non-KeyResolver entries are silently skipped.
        $resolved = KeyResolution::resolveKey('x', ['nonsense', 42, $a]);
        $this->assertNotNull($resolved);
        $this->assertSame('A', $resolved->publicKeyPem);
    }

    public function testEmptyKeyidReturnsNull(): void
    {
        $a = new RecordingResolver(['x'], 'A');
        $this->assertNull(KeyResolution::resolveKey('', [$a]));
    }
}

/**
 * Tiny test-only resolver: supports a fixed list of keyids; if it supports
 * the keyid, returns either the configured PEM or null.
 */
class RecordingResolver implements KeyResolver
{
    /** @var array<int, string> */
    private $supportedKeyids;
    /** @var ?string */
    private $pemOrNull;
    /** @var int */
    public $resolveCalls = 0;

    public function __construct(array $supportedKeyids, ?string $pemOrNull)
    {
        $this->supportedKeyids = $supportedKeyids;
        $this->pemOrNull       = $pemOrNull;
    }

    public function supports(string $keyid): bool
    {
        return in_array($keyid, $this->supportedKeyids, true);
    }

    public function resolve(string $keyid): ?ResolvedKey
    {
        $this->resolveCalls++;
        if ($this->pemOrNull === null) {
            return null;
        }
        return new ResolvedKey($this->pemOrNull, 'ed25519', $keyid);
    }
}
