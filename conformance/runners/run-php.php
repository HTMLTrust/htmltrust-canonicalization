#!/usr/bin/env php
<?php
/**
 * PHP conformance runner for HTMLTrust canonicalization.
 *
 * Reads every fixture under conformance/fixtures/{normalize,extract,claims,jcs}/
 * and compares the binding output byte-for-byte against the `expected`
 * field. Exits non-zero on any divergence.
 *
 * Usage:
 *   php run-php.php            # verify all fixtures
 *   php run-php.php --update   # rewrite `expected` from the current
 *                              # binding output
 *
 * Set HTMLTRUST_RUST_CORE_LIB to use the Rust shared-core adapter. Without it,
 * this runner uses the independent PHP implementation.
 *
 * Requires PHP 8.5+ with DOM and intl extensions.
 */

declare(strict_types=1);

if (getenv('HTMLTRUST_PHP_PACKAGE_MODE') === 'installed') {
    $autoload = getenv('HTMLTRUST_PHP_PACKAGE_AUTOLOAD');
    if (!is_string($autoload) || !is_file($autoload)) {
        throw new RuntimeException('installed PHP package autoloader is required');
    }
    require_once $autoload;
} else {
    require_once __DIR__ . '/../../php/src/Canonicalize.php';
    require_once __DIR__ . '/../../php/src/RustCoreError.php';
    require_once __DIR__ . '/../../php/src/RustCore.php';
    $autoload = __DIR__ . '/../../php/vendor/autoload.php';
    if (is_file($autoload)) {
        require_once $autoload;
    }
}

use HTMLTrust\Canonicalization\Canonicalize;
use HTMLTrust\Canonicalization\RustCore;

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

$rustCore = null;
$rustCoreLibrary = getenv('HTMLTRUST_RUST_CORE_LIB');
if ($rustCoreLibrary !== false && $rustCoreLibrary !== '') {
    $rustCore = new RustCore($rustCoreLibrary);
    echo "MODE: RustCore ({$rustCoreLibrary})\n";
} else {
    echo "MODE: independent PHP binding\n";
}

/**
 * Per-suite runner. Returns [string|null $output, bool $implemented].
 * $output is null when the binding has no implementation; callers
 * report SKIP rather than FAIL in that case.
 */
$runners = [
    'normalize' => static function (array $fx) use ($rustCore) {
        if (!is_string($fx['input'])) {
            throw new RuntimeException('normalize fixture input must be a string');
        }
        $input = $fx['input'];
        if (isset($fx['repeat'])) {
            $input = str_repeat($input, (int) $fx['repeat']);
        }
        return [$rustCore === null ? Canonicalize::normalizeText($input) : $rustCore->normalizeText($input), true];
    },
    'extract' => static function (array $fx) use ($rustCore) {
        if (!is_string($fx['input'])) {
            throw new RuntimeException('extract fixture input must be a string');
        }
        $input = $fx['input'];
        if (isset($fx['repeat'])) {
            $input = str_repeat($input, (int) $fx['repeat']);
        }
        $baseUrl = array_key_exists('baseURL', $fx) ? $fx['baseURL'] : null;
        return [$rustCore === null
            ? Canonicalize::extractCanonicalText($input, false, $baseUrl)
            : $rustCore->extractCanonicalText($input, false, $baseUrl), true];
    },
    'claims' => static function (array $fx) use ($rustCore) {
        if (!is_array($fx['input'])) {
            throw new RuntimeException('claims fixture input must be an object');
        }
        $input = $fx['input'];
        if (isset($fx['repeat'])) {
            $repeat = (int) $fx['repeat'];
            foreach ($input as $name => $value) {
                if (is_string($value)) {
                    $input[$name] = str_repeat($value, $repeat);
                }
            }
        }
        return [$rustCore === null ? Canonicalize::canonicalizeClaims($input) : $rustCore->canonicalizeClaims($input), true];
    },
    'jcs' => static function (array $fx) use ($rustCore) {
        if (!is_string($fx['input'])) {
            throw new RuntimeException('jcs fixture input must be a raw JSON string');
        }
        $input = $fx['input'];
        if (isset($fx['repeat'])) {
            $input = str_repeat($input, (int) $fx['repeat']);
        }
        return [$rustCore === null ? Canonicalize::canonicalizeJsonDocument($input) : $rustCore->canonicalizeJsonDocument($input), true];
    },
];

$passed = 0;
$failed = 0;
$skipped = 0;
$failures = [];

foreach (['normalize', 'extract', 'claims', 'jcs'] as $suite) {
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
        $expectError = $fixture['error'] ?? null;

        try {
            [$actual, $implemented] = $runner($fixture);
        } catch (Throwable $e) {
            if ($expectError !== null) {
                if (strpos($e->getMessage(), $expectError) !== false) {
                    $passed++;
                    echo "PASS {$id}  (expected error {$expectError})\n";
                } else {
                    $failed++;
                    $msg = "FAIL {$id}\n  expected error: {$expectError}\n  got error:      " . $e->getMessage();
                    $failures[] = $msg;
                    echo $msg, "\n";
                }
                continue;
            }
            $failed++;
            $msg = "FAIL {$id}\n  threw: " . $e->getMessage();
            $failures[] = $msg;
            echo $msg, "\n";
            continue;
        }

        if ($expectError !== null) {
            $failed++;
            $msg = "FAIL {$id}\n  expected error: {$expectError}\n  got output:     " . json_encode($actual, JSON_UNESCAPED_UNICODE);
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
