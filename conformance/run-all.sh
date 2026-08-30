#!/usr/bin/env bash
#
# Run every per-language conformance runner against the shared fixtures.
#
# Exit codes:
#   0  -- every runnable language passed every fixture.
#   1  -- at least one runner reported a divergence.
#   2  -- a runner crashed (returned a non-1, non-0 exit code).
#
# Usage:
#   ./conformance/run-all.sh
#
# Re-run with --update to regenerate `expected` fields from the Rust runner;
# adapter runners then verify those values.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNERS_DIR="$SCRIPT_DIR/runners"
FIXTURES_ROOT="$SCRIPT_DIR/fixtures"

# Count the files that this checkout will exercise. Keeping this derived from
# disk prevents the summary and documentation from going stale when a fixture
# is added.
TOTAL_FIXTURES=$(find "$FIXTURES_ROOT" -mindepth 2 -maxdepth 2 -type f -name '*.json' -print | wc -l | tr -d ' ')

if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != "--update" ]; }; then
    echo "Usage: $0 [--update]" >&2
    exit 2
fi
UPDATE=0
if [ "${1:-}" = "--update" ]; then UPDATE=1; fi

# Track results.
PASSED_LANGS=()
FAILED_LANGS=()
CRASHED_LANGS=()

# run_language <name> <command...>
# Executes the command and records the outcome. Exit codes other than 0
# or 1 (e.g. a panic) are surfaced as CRASHED so they're noticed.
run_language() {
    local lang="$1"; shift
    echo
    echo "=========================================="
    echo "  ${lang}"
    echo "=========================================="
    "$@"
    local rc=$?
    if [ $rc -eq 0 ]; then
        PASSED_LANGS+=("$lang")
    elif [ $rc -eq 1 ]; then
        FAILED_LANGS+=("$lang")
    else
        CRASHED_LANGS+=("${lang} (exit ${rc})")
    fi
}

# Every adapter must run against a built Rust artifact. Missing toolchains or
# artifacts are failures rather than opportunities to fall back to old code.
require_bin() {
    local lang="$1" bin="$2"
    if command -v "$bin" >/dev/null 2>&1; then
        return 0
    fi
    echo
    echo "=========================================="
    echo "  ${lang}: ERROR -- no '${bin}' in PATH"
    echo "=========================================="
    CRASHED_LANGS+=("${lang} (no ${bin} in PATH)")
    return 1
}

if [ -z "${HTMLTRUST_RUST_CORE_LIB:-}" ] || [ ! -s "${HTMLTRUST_RUST_CORE_LIB}" ]; then
    echo "HTMLTRUST_RUST_CORE_LIB must point to the built Rust shared library." >&2
    exit 2
fi
if [ -z "${HTMLTRUST_WASM_PKG:-}" ] || [ ! -s "${HTMLTRUST_WASM_PKG}" ]; then
    echo "HTMLTRUST_WASM_PKG must point to the built Node WASM module." >&2
    exit 2
fi

# ---- Rust -----------------------------------------------------------------
if require_bin "Rust" cargo; then
    if [ "$UPDATE" -eq 1 ]; then
        run_language "Rust" cargo run --quiet --release --locked \
            --manifest-path "$RUNNERS_DIR/run-rust/Cargo.toml" -- --update
    else
        run_language "Rust" cargo run --quiet --release --locked \
            --manifest-path "$RUNNERS_DIR/run-rust/Cargo.toml"
    fi
fi

# ---- JavaScript -----------------------------------------------------------
if require_bin "JavaScript" node; then
    run_language "JavaScript" \
        node "$RUNNERS_DIR/run-javascript.mjs"
fi

# ---- Go -------------------------------------------------------------------
if require_bin "Go" go; then
    # `go run` needs the runner's go.mod for its `replace` directive,
    # so cd into the runner's directory first.
    run_language "Go" \
        bash -c "cd '$RUNNERS_DIR' && go run ./run-go.go"
fi

# ---- PHP ------------------------------------------------------------------
if require_bin "PHP" php; then
    run_language "PHP" \
        php "$RUNNERS_DIR/run-php.php"
fi

# ---- Python ---------------------------------------------------------------
if require_bin "Python" python3; then
    run_language "Python" \
        python3 "$RUNNERS_DIR/run-python.py"
fi

echo
echo "=========================================="
echo "  Summary"
echo "=========================================="
echo "  FIXTURES: ${TOTAL_FIXTURES}"
[ ${#PASSED_LANGS[@]}  -gt 0 ] && echo "  PASS:    ${PASSED_LANGS[*]}"
[ ${#FAILED_LANGS[@]}  -gt 0 ] && echo "  FAIL:    ${FAILED_LANGS[*]}"
[ ${#CRASHED_LANGS[@]} -gt 0 ] && echo "  CRASH:   ${CRASHED_LANGS[*]}"

if [ ${#FAILED_LANGS[@]} -gt 0 ]; then
    exit 1
fi
if [ ${#CRASHED_LANGS[@]} -gt 0 ]; then
    exit 2
fi
exit 0
