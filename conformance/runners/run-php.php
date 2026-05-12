#!/usr/bin/env php
<?php
/**
 * PHP conformance runner for HTMLTrust canonicalization.
 *
 * Reads every fixture under conformance/fixtures/{normalize,extract,claims}/
 * and compares the binding output byte-for-byte against the `expected`
 * field. Exits non-zero on any divergence.
 *
 * Usage:
 *   php run-php.php            # verify all fixtures
 *   php run-php.php --update   # rewrite `expected` from the current
 *                              # binding output
 *
 * The PHP binding currently exposes only `Canonicalize::normalizeText()`;
 * extract and claims fixtures are reported as SKIP (not failures).
 *
 * Requires PHP 7.2+ with the intl extension (for Normalizer::normalizeText).
 */

declare(strict_types=1);

require_once __DIR__ . '/../../php/src/Canonicalize.php';

use HTMLTrust\Canonicalization\Canonicalize;

$confDir     = realpath(__DIR__ . '/..');
$repoRoot    = realpath(__DIR__ . '/../..');
$fixturesDir = $confDir . '/fixtures';

$update = false;
foreach (array_slice($argv, 1) as $arg) {
    if ($arg === '--update') {
        $update = true;
    } else {
        fwrite(STDERR, "unknown argument: {$arg}\n");
        exit(2);
    }
}

/**
 * Per-suite runner. Returns [string|null $output, bool $implemented].
 * $output is null when the binding has no implementation; callers
 * report SKIP rather than FAIL in that case.
 */
$runners = [
    'normalize' => static function ($input) {
        if (!is_string($input)) {
            throw new RuntimeException('normalize fixture input must be a string');
        }
        return [Canonicalize::normalizeText($input), true];
    },
    // PHP binding does not yet implement extractCanonicalText.
    'extract' => static function ($input) {
        return [null, false];
    },
    // PHP binding does not yet implement canonicalizeClaims.
    'claims' => static function ($input) {
        return [null, false];
    },
];

$passed = 0;
$failed = 0;
$skipped = 0;
$failures = [];

foreach (['normalize', 'extract', 'claims'] as $suite) {
    $paths = list_fixtures($fixturesDir . '/' . $suite);
    $runner = $runners[$suite];
    foreach ($paths as $path) {
        $id = ltrim(str_replace($repoRoot, '', $path), '/');
        $raw = file_get_contents($path);
        if ($raw === false) {
            $failed++;
            $msg = "FAIL {$id}\n  read failed";
            $failures[] = $msg;
            echo $msg, "\n";
            continue;
        }
        $fixture = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);

        try {
            [$actual, $implemented] = $runner($fixture['input']);
        } catch (Throwable $e) {
            $failed++;
            $msg = "FAIL {$id}\n  threw: " . $e->getMessage();
            $failures[] = $msg;
            echo $msg, "\n";
            continue;
        }

        if (!$implemented) {
            $skipped++;
            echo "SKIP {$id}  (binding does not implement {$suite})\n";
            continue;
        }

        if ($update) {
            $fixture['expected'] = $actual;
            save_fixture($path, $fixture);
            echo "UPDATED {$id}\n";
            continue;
        }

        if ($actual === ($fixture['expected'] ?? null)) {
            $passed++;
            echo "PASS {$id}\n";
        } else {
            $failed++;
            $msg = "FAIL {$id}\n"
                . "  expected: " . json_encode($fixture['expected'] ?? null, JSON_UNESCAPED_UNICODE) . "\n"
                . "  got:      " . json_encode($actual, JSON_UNESCAPED_UNICODE);
            $failures[] = $msg;
            echo $msg, "\n";
        }
    }
}

if (!$update) {
    echo "\n{$passed} passed, {$failed} failed, {$skipped} skipped\n";
    if ($failed > 0) {
        echo "\n--- Failures ---\n";
        foreach ($failures as $msg) {
            echo $msg, "\n";
        }
    }
}

exit($failed > 0 ? 1 : 0);

/**
 * List *.json files in a directory, sorted lexically.
 *
 * @return string[]
 */
function list_fixtures(string $dir): array
{
    $out = [];
    foreach (scandir($dir) ?: [] as $name) {
        if (substr($name, -5) === '.json') {
            $out[] = $dir . '/' . $name;
        }
    }
    sort($out, SORT_STRING);
    return $out;
}

/**
 * Write a fixture back to disk with our standard formatting:
 * pretty-printed, 2-space indent, trailing newline, key order preserved
 * (name, description, input, expected).
 */
function save_fixture(string $path, array $fixture): void
{
    $ordered = [];
    foreach (['name', 'description', 'input', 'expected'] as $k) {
        if (array_key_exists($k, $fixture)) {
            $ordered[$k] = $fixture[$k];
        }
    }
    foreach ($fixture as $k => $v) {
        if (!array_key_exists($k, $ordered)) {
            $ordered[$k] = $v;
        }
    }
    $json = json_encode(
        $ordered,
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT
    );
    // PHP indents with 4 spaces by default; normalize to 2 spaces so
    // diffs against the Python-emitted format stay minimal.
    $json = preg_replace_callback(
        '/^( +)/m',
        static function ($m) {
            $indent = strlen($m[1]) / 4;
            return str_repeat('  ', (int)$indent);
        },
        $json
    );
    file_put_contents($path, $json . "\n");
}
