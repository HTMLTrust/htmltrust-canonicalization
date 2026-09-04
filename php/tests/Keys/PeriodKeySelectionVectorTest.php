<?php
/**
 * Consumes conformance/vectors/did-selection-v1.json (draft §9.10 period-
 * scoped key selection) against the real resolvers, with a stubbed fetcher.
 * The same vector file drives the JavaScript and Go test suites, so a
 * disagreement here is a cross-language behavior bug, not a PHP-only one.
 */

namespace HTMLTrust\Canonicalization\Tests\Keys;

use PHPUnit\Framework\TestCase;
use HTMLTrust\Canonicalization\Keys\DidWebResolver;
use HTMLTrust\Canonicalization\Keys\DirectUrlResolver;
use HTMLTrust\Canonicalization\Keys\TrustDirectoryResolver;

class PeriodKeySelectionVectorTest extends TestCase
{
    private const VECTOR_PATH = __DIR__ . '/../../../conformance/vectors/did-selection-v1.json';

    /** @return array<int, array{0: string, 1: array}> */
    public static function caseProvider(): array
    {
        $raw = file_get_contents(self::VECTOR_PATH);
        if ($raw === false) {
            throw new \RuntimeException('could not read ' . self::VECTOR_PATH);
        }
        $vector = json_decode($raw, true);
        $cases = [];
        foreach ($vector['cases'] as $case) {
            $cases[$case['name']] = [$case, $vector['cases']];
        }
        return $cases;
    }

    private static function findDidDocument(array $case, array $allCases): array
    {
        if (isset($case['didDocument'])) {
            return $case['didDocument'];
        }
        foreach ($allCases as $ref) {
            if (($ref['name'] ?? null) === ($case['didDocumentRef'] ?? null)) {
                return $ref['didDocument'];
            }
        }
        throw new \RuntimeException('no such didDocumentRef: ' . ($case['didDocumentRef'] ?? '(none)'));
    }

    private static function jsonFetchStub(string $expectedUrl, array $body): callable
    {
        return static function (string $url) use ($expectedUrl, $body): ?array {
            if ($url !== $expectedUrl) {
                return null;
            }
            return ['body' => json_encode($body), 'contentType' => 'application/json'];
        };
    }

    /** @dataProvider caseProvider */
    public function testVector(array $case, array $allCases): void
    {
        $kind = $case['kind'] ?? 'did';
        $keyid = $case['keyid'];
        $resolved = null;
        $thrown = null;

        try {
            switch ($kind) {
                case 'did':
                    $doc = self::findDidDocument($case, $allCases);
                    $resolver = new DidWebResolver(self::jsonFetchStub('https://example.com/.well-known/did.json', $doc));
                    $resolved = $resolver->resolve($keyid);
                    break;
                case 'url':
                    $resolver = new DirectUrlResolver(self::jsonFetchStub($keyid, $case['keyDocument']));
                    $resolved = $resolver->resolve($keyid);
                    break;
                case 'directory':
                    $base = 'https://directory.example';
                    $url = $base . '/keys/' . rawurlencode($keyid);
                    $resolver = new TrustDirectoryResolver([$base], self::jsonFetchStub($url, $case['keyDocument']));
                    $resolved = $resolver->resolve($keyid);
                    break;
                default:
                    $this->fail('unknown vector case kind: ' . $kind);
            }
        } catch (\InvalidArgumentException $error) {
            $thrown = $error;
        }

        $expected = $case['expected'];
        switch ($expected['outcome']) {
            case 'resolved':
                $this->assertNull($thrown, 'expected resolution, got throw: ' . ($thrown !== null ? $thrown->getMessage() : ''));
                $this->assertNotNull($resolved, 'expected a resolution for ' . $case['name']);
                if (isset($expected['methodId'])) {
                    $this->assertSame($expected['methodId'], $resolved->methodId);
                }
                if (isset($expected['period'])) {
                    $this->assertSame($expected['period'], $resolved->period);
                }
                if (isset($expected['identity'])) {
                    $this->assertSame($expected['identity'], $resolved->identity);
                }
                if (isset($expected['publicKeyPem'])) {
                    $this->assertSame($expected['publicKeyPem'], $resolved->publicKeyPem);
                }
                if (isset($expected['revoked'])) {
                    $this->assertSame($expected['revoked'], $resolved->revoked);
                }
                break;
            case 'key-resolution-failed':
                $this->assertNull($thrown, 'expected a decline (null), got throw: ' . ($thrown !== null ? $thrown->getMessage() : ''));
                $this->assertNull($resolved, 'expected key-resolution-failed (null)');
                break;
            case 'malformed-key-document':
                $this->assertNotNull($thrown, 'expected malformed-key-document to throw');
                $this->assertSame('malformed-key-document', $thrown->getMessage());
                break;
            default:
                $this->fail('unknown expected outcome: ' . $expected['outcome']);
        }
    }
}
