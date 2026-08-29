#!/usr/bin/env bash
set -euo pipefail

# This script runs in the pinned Rust builder service.  Source is mounted
# read-only; all Cargo output and generated bindings are written to the named
# /artifacts volume so a checkout never receives build products.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACTS="${HTMLTRUST_SHARED_CORE_ARTIFACTS:-/artifacts}"
NATIVE_TARGET="${HTMLTRUST_SHARED_CORE_NATIVE_TARGET:-${ARTIFACTS}/cargo-target-native}"
WASM_TARGET="${HTMLTRUST_SHARED_CORE_WASM_TARGET:-${ARTIFACTS}/cargo-target-wasm}"
WASM_OUT="${ARTIFACTS}/wasm-node"
TEST_FIXTURES="${ARTIFACTS}/test-fixtures"

mkdir -p "${ARTIFACTS}" "${NATIVE_TARGET}" "${WASM_TARGET}" "${WASM_OUT}" "${TEST_FIXTURES}"
# wasm-bindgen emits a fixed, small set of files. Remove only those exact
# paths, never an arbitrary artifact directory.
rm -f -- \
  "${WASM_OUT}/htmltrust_canonicalization_ffi.js" \
  "${WASM_OUT}/htmltrust_canonicalization_ffi_bg.js" \
  "${WASM_OUT}/htmltrust_canonicalization_ffi_bg.wasm" \
  "${WASM_OUT}/htmltrust_canonicalization_ffi.d.ts" \
  "${WASM_OUT}/htmltrust_canonicalization_ffi_bg.wasm.d.ts"

echo ">> Rust core and FFI tests"
CARGO_TARGET_DIR="${NATIVE_TARGET}" cargo test --locked --manifest-path "${ROOT}/rust/Cargo.toml"
(
  cd "${ROOT}/ffi"
  CARGO_TARGET_DIR="${NATIVE_TARGET}" cargo test --locked
)

echo ">> Native cdylib/staticlib"
(
  cd "${ROOT}/ffi"
  CARGO_TARGET_DIR="${NATIVE_TARGET}" cargo build --locked --release
)
cp "${NATIVE_TARGET}/release/libhtmltrust_canonicalization_ffi.so" "${ARTIFACTS}/"
cp "${NATIVE_TARGET}/release/libhtmltrust_canonicalization_ffi.a" "${ARTIFACTS}/"
cp "${ROOT}/ffi/include/htmltrust_canonicalization.h" "${ARTIFACTS}/"

if [[ "$(uname -s)" == "Linux" ]]; then
  echo ">> Linux shared-core constructor fixtures"
  cc -std=c11 -Wall -Wextra -Werror -fPIC -shared \
    "${ROOT}/ffi/tests/shared_core_wrong_abi.c" \
    -o "${TEST_FIXTURES}/libhtmltrust_shared_core_wrong_abi.so"
  cc -std=c11 -Wall -Wextra -Werror -fPIC -shared \
    "${ROOT}/ffi/tests/shared_core_missing_operation.c" \
    -o "${TEST_FIXTURES}/libhtmltrust_shared_core_missing_operation.so"
fi

echo ">> Public C header dynamic-link smoke test"
cc -std=c11 -Wall -Wextra -Werror \
  -I"${ROOT}/ffi/include" \
  "${ROOT}/ffi/tests/header_smoke.c" \
  -L"${NATIVE_TARGET}/release" \
  -Wl,-rpath,"${NATIVE_TARGET}/release" \
  -lhtmltrust_canonicalization_ffi \
  -o "${NATIVE_TARGET}/header-smoke"
"${NATIVE_TARGET}/header-smoke"

echo ">> Public C header static-link smoke test"
cc -std=c11 -Wall -Wextra -Werror \
  -I"${ROOT}/ffi/include" \
  "${ROOT}/ffi/tests/header_smoke.c" \
  "${NATIVE_TARGET}/release/libhtmltrust_canonicalization_ffi.a" \
  -ldl -lpthread -lm \
  -o "${NATIVE_TARGET}/header-smoke-static"
"${NATIVE_TARGET}/header-smoke-static"

echo ">> wasm32-unknown-unknown"
(
  cd "${ROOT}/ffi"
  CARGO_TARGET_DIR="${WASM_TARGET}" cargo build --locked --release \
    --target wasm32-unknown-unknown
)

WASM_INPUT="${WASM_TARGET}/wasm32-unknown-unknown/release/htmltrust_canonicalization_ffi.wasm"
wasm-bindgen --target nodejs --out-dir "${WASM_OUT}" "${WASM_INPUT}"

{
  echo "abi_version=1"
  echo "native_target=$(rustc -vV | sed -n 's/^host: //p')"
  echo "wasm_target=wasm32-unknown-unknown"
  rustc --version
  cargo --version
  wasm-bindgen --version
  (
    cd "${ARTIFACTS}"
    sha256sum \
      libhtmltrust_canonicalization_ffi.so \
      libhtmltrust_canonicalization_ffi.a \
      htmltrust_canonicalization.h \
      wasm-node/htmltrust_canonicalization_ffi.js \
      wasm-node/htmltrust_canonicalization_ffi.d.ts \
      wasm-node/htmltrust_canonicalization_ffi_bg.wasm \
      wasm-node/htmltrust_canonicalization_ffi_bg.wasm.d.ts
  )
} > "${ARTIFACTS}/MANIFEST.txt"

echo "Shared-core artifacts written to ${ARTIFACTS}"
