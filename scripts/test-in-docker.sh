#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

MODE="all"
case "${1:-}" in
    "") ;;
    --independent-only) MODE="independent" ;;
    --shared-core-only) MODE="shared-core" ;;
    *)
        echo "Usage: $0 [--independent-only|--shared-core-only]" >&2
        exit 2
        ;;
esac
if [[ $# -gt 1 ]]; then
    echo "Usage: $0 [--independent-only|--shared-core-only]" >&2
    exit 2
fi

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    echo "Docker with the Compose plugin is required." >&2
    exit 2
fi

CHECKOUT_ID="$(printf '%s' "$REPO_ROOT" | cksum | awk '{print $1}')"
COMPOSE_PROJECT="htmltrust-c14n-${CHECKOUT_ID}"
if [[ -n "${HTMLTRUST_TEST_SESSION_ID:-}" ]]; then
    if [[ ! "$HTMLTRUST_TEST_SESSION_ID" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
        echo "HTMLTRUST_TEST_SESSION_ID must use lowercase letters, digits, underscores, or hyphens." >&2
        exit 2
    fi
    COMPOSE_PROJECT="${COMPOSE_PROJECT}-${HTMLTRUST_TEST_SESSION_ID}"
fi
COMPOSE_FILE="$REPO_ROOT/compose.test.yml"

DISK_TEMP_ROOT="${TMPDIR:-${HOME}/tmp}"
if [[ "$DISK_TEMP_ROOT" == "/tmp" || "$DISK_TEMP_ROOT" == /tmp/* ]]; then
    DISK_TEMP_ROOT="${HOME}/tmp"
fi

# Each checkout/session gets a private Cargo directory so concurrent toolchains
# never share a target tree. Prefer the host's bulk mount when it exists; other
# machines use their configured disk-backed temporary directory.
if [[ -n "${HTMLTRUST_CARGO_TARGET_ROOT:-}" ]]; then
    CARGO_TARGET_ROOT="$HTMLTRUST_CARGO_TARGET_ROOT"
elif [[ -d /mnt/bulk && -w /mnt/bulk ]]; then
    CARGO_TARGET_ROOT="/mnt/bulk/cargo-targets/htmltrust-canonicalization/${CHECKOUT_ID}"
else
    CARGO_TARGET_ROOT="${DISK_TEMP_ROOT}/cargo-targets/htmltrust-canonicalization/${CHECKOUT_ID}"
fi
if [[ -n "${HTMLTRUST_TEST_SESSION_ID:-}" ]]; then
    CARGO_TARGET_ROOT="${CARGO_TARGET_ROOT}-${HTMLTRUST_TEST_SESSION_ID}"
fi
mkdir -p "$CARGO_TARGET_ROOT/ordinary" "$CARGO_TARGET_ROOT/shared-native" "$CARGO_TARGET_ROOT/shared-wasm"
export HTMLTRUST_CARGO_TARGET_MOUNT="$CARGO_TARGET_ROOT/ordinary"
export HTMLTRUST_SHARED_CORE_NATIVE_TARGET_MOUNT="$CARGO_TARGET_ROOT/shared-native"
export HTMLTRUST_SHARED_CORE_WASM_TARGET_MOUNT="$CARGO_TARGET_ROOT/shared-wasm"

if [[ -z "${HTMLTRUST_SHARED_CORE_ARTIFACTS_MOUNT:-}" ]]; then
    ARTIFACT_CACHE_BASE="$DISK_TEMP_ROOT"
    HTMLTRUST_SHARED_CORE_ARTIFACTS_MOUNT="${ARTIFACT_CACHE_BASE}/htmltrust-canonicalization/${CHECKOUT_ID}"
    if [[ -n "${HTMLTRUST_TEST_SESSION_ID:-}" ]]; then
        HTMLTRUST_SHARED_CORE_ARTIFACTS_MOUNT="${HTMLTRUST_SHARED_CORE_ARTIFACTS_MOUNT}-${HTMLTRUST_TEST_SESSION_ID}"
    fi
    HTMLTRUST_SHARED_CORE_ARTIFACTS_MOUNT="${HTMLTRUST_SHARED_CORE_ARTIFACTS_MOUNT}/artifacts"
fi
mkdir -p "$HTMLTRUST_SHARED_CORE_ARTIFACTS_MOUNT"
export HTMLTRUST_SHARED_CORE_ARTIFACTS_MOUNT

# Docker cannot create a nested volume target beneath the read-only checkout
# bind mount. Keep these ignored directories as stable mountpoints. Removing
# them at process exit creates a race when two test sessions share a checkout.
MOUNTPOINTS=("$REPO_ROOT/node_modules" "$REPO_ROOT/php/vendor")
for mountpoint in "${MOUNTPOINTS[@]}"; do
    if [[ ! -d "$mountpoint" ]]; then
        mkdir -p "$mountpoint"
    fi
done

if [[ "$MODE" != "shared-core" ]]; then
    for service in javascript go php python rust; do
        echo
        echo "Running ${service} tests"
        docker compose --project-name "$COMPOSE_PROJECT" --file "$COMPOSE_FILE" run --build --rm "$service"
    done
fi

if [[ "$MODE" != "independent" ]]; then
    for service in shared-core-build shared-core-node shared-core-python shared-core-go shared-core-php; do
        echo
        echo "Running ${service} validation"
        docker compose --project-name "$COMPOSE_PROJECT" --file "$COMPOSE_FILE" run --build --rm "$service"
    done
    echo
    echo "Shared-core artifacts: $HTMLTRUST_SHARED_CORE_ARTIFACTS_MOUNT"
fi

echo
case "$MODE" in
    all) echo "All independent binding and shared-core validation tests passed." ;;
    independent) echo "All independent binding tests passed." ;;
    shared-core) echo "All shared-core validation tests passed." ;;
esac
