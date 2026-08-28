#!/usr/bin/env bash
set -euo pipefail

# Install every dependency needed by the checked-in tests. Keep this script
# safe to rerun when a container is rebuilt or a dependency changes.
npm ci --ignore-scripts --no-audit --no-fund
python3 -m pip install --disable-pip-version-check -e 'python[dev]'
(cd php && composer install --no-interaction --prefer-dist)
(cd go && go mod download)
cargo fetch --locked --manifest-path rust/Cargo.toml
cargo fetch --locked --manifest-path ffi/Cargo.toml
cargo fetch --locked --manifest-path conformance/runners/run-rust/Cargo.toml
