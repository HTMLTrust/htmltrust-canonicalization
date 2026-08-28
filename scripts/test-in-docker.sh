#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

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

# Docker cannot create a nested volume target beneath the read-only checkout
# bind mount. Create empty host mountpoints for dependency volumes, then remove
# the empty directories after Compose unmounts them.
MOUNTPOINTS=("$REPO_ROOT/node_modules" "$REPO_ROOT/php/vendor")
CREATED_MOUNTPOINTS=()
for mountpoint in "${MOUNTPOINTS[@]}"; do
    if [[ ! -d "$mountpoint" ]]; then
        mkdir -p "$mountpoint"
        CREATED_MOUNTPOINTS+=("$mountpoint")
    fi
done

cleanup_mountpoints() {
    for mountpoint in "${CREATED_MOUNTPOINTS[@]}"; do
        rmdir "$mountpoint" 2>/dev/null || true
    done
}
trap cleanup_mountpoints EXIT

for service in javascript go php python rust; do
    echo
    echo "Running ${service} tests"
    docker compose --project-name "$COMPOSE_PROJECT" --file "$COMPOSE_FILE" run --rm "$service"
done

echo
echo "All five bindings passed their unit and conformance tests."
