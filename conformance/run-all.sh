#!/usr/bin/env bash
#
# Run every per-language conformance runner against the shared fixtures.
#
# Exit codes:
#   0  -- every runnable language passed every fixture.
#   1  -- at least one runner reported a divergence.
#   2  -- a runner crashed (returned a non-1, non-0 exit code).
#
# A language whose toolchain is missing from $PATH is reported as
# "MISSING TOOLCHAIN" and does NOT cause a non-zero exit -- the suite
# still exits 0 if every available language passes. This means CI on a
# minimal image (e.g. Node + Python only) still produces a useful
# signal. To make a missing toolchain hard-fail, set
# REQUIRE_ALL_LANGUAGES=1 before invoking.
#
# Usage:
#   ./conformance/run-all.sh
#   REQUIRE_ALL_LANGUAGES=1 ./conformance/run-all.sh
#
# Re-run with --update to regenerate `expected` fields. Note: only the
# Python and Rust runners cover the extract/ and claims/ suites; the
# normalize suite reaches consensus across all five languages.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNNERS_DIR="$SCRIPT_DIR/runners"

EXTRA_ARGS=()
if [ "${1:-}" = "--update" ]; then
    EXTRA_ARGS=(--update)
fi

# Track results.
PASSED_LANGS=()
FAILED_LANGS=()
MISSING_LANGS=()
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

# Look up a binary; if missing, record as missing-toolchain.
require_bin() {
    local lang="$1" bin="$2"
    if command -v "$bin" >/dev/null 2>&1; then
        return 0
    fi
    MISSING_LANGS+=("${lang} (no ${bin} in PATH)")
    echo
    echo "=========================================="
    echo "  ${lang}: SKIPPED -- no '${bin}' in PATH"
    echo "=========================================="
    return 1
}

# ---- JavaScript -----------------------------------------------------------
if require_bin "JavaScript" node; then
    run_language "JavaScript" \
        node "$RUNNERS_DIR/run-javascript.mjs" "${EXTRA_ARGS[@]}"
fi

# ---- Go -------------------------------------------------------------------
if require_bin "Go" go; then
    # `go run` needs the runner's go.mod for its `replace` directive,
    # so cd into the runner's directory first.
    run_language "Go" \
        bash -c "cd '$RUNNERS_DIR' && go run ./run-go.go ${EXTRA_ARGS[*]}"
fi

# ---- PHP ------------------------------------------------------------------
if require_bin "PHP" php; then
    run_language "PHP" \
        php "$RUNNERS_DIR/run-php.php" "${EXTRA_ARGS[@]}"
fi

# ---- Python ---------------------------------------------------------------
if require_bin "Python" python3; then
    run_language "Python" \
        python3 "$RUNNERS_DIR/run-python.py" "${EXTRA_ARGS[@]}"
fi

# ---- Rust -----------------------------------------------------------------
if require_bin "Rust" cargo; then
    run_language "Rust" \
        cargo run --quiet --release \
            --manifest-path "$RUNNERS_DIR/run-rust/Cargo.toml" \
            -- "${EXTRA_ARGS[@]}"
fi

echo
echo "=========================================="
echo "  Summary"
echo "=========================================="
[ ${#PASSED_LANGS[@]}  -gt 0 ] && echo "  PASS:    ${PASSED_LANGS[*]}"
[ ${#FAILED_LANGS[@]}  -gt 0 ] && echo "  FAIL:    ${FAILED_LANGS[*]}"
[ ${#CRASHED_LANGS[@]} -gt 0 ] && echo "  CRASH:   ${CRASHED_LANGS[*]}"
[ ${#MISSING_LANGS[@]} -gt 0 ] && echo "  MISSING: ${MISSING_LANGS[*]}"

if [ ${#FAILED_LANGS[@]} -gt 0 ]; then
    exit 1
fi
if [ ${#CRASHED_LANGS[@]} -gt 0 ]; then
    exit 2
fi
if [ "${REQUIRE_ALL_LANGUAGES:-0}" = "1" ] && [ ${#MISSING_LANGS[@]} -gt 0 ]; then
    echo
    echo "REQUIRE_ALL_LANGUAGES=1: failing because some toolchains were missing."
    exit 2
fi
exit 0
