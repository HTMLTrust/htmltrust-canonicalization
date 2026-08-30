#!/usr/bin/env bash
set -euo pipefail

# Build one explicit Unix target. The caller supplies private output and Cargo
# target directories so parallel jobs never share a Cargo dependency tree.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:?usage: $0 <target> <output-root> <version> [abi-version]}"
OUTPUT_ROOT="${2:?usage: $0 <target> <output-root> <version> [abi-version]}"
VERSION="${3:?usage: $0 <target> <output-root> <version> [abi-version]}"
ABI_VERSION="${4:-1}"
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-}"

if [[ "$OUTPUT_ROOT" != /* || -z "$CARGO_TARGET_DIR" || "$CARGO_TARGET_DIR" != /* ]]; then
  echo "output-root and CARGO_TARGET_DIR must be absolute paths" >&2
  exit 2
fi

case "$TARGET" in
  x86_64-unknown-linux-gnu|aarch64-unknown-linux-gnu|i686-unknown-linux-gnu)
    DYNAMIC_NAME="libhtmltrust_canonicalization_ffi.so"
    STATIC_NAME="libhtmltrust_canonicalization_ffi.a"
    PLATFORM="linux"
    ;;
  x86_64-apple-darwin|aarch64-apple-darwin)
    DYNAMIC_NAME="libhtmltrust_canonicalization_ffi.dylib"
    STATIC_NAME="libhtmltrust_canonicalization_ffi.a"
    PLATFORM="darwin"
    ;;
  *)
    echo "unsupported Unix target: $TARGET" >&2
    exit 2
    ;;
esac

# Apple deployment variables influence Clang's platform selection. Resolve the
# desktop SDK explicitly in case the caller previously ran a mobile build.
MACOS_SDKROOT=""
if [[ "$PLATFORM" == "darwin" ]]; then
  unset IPHONEOS_DEPLOYMENT_TARGET
  command -v xcrun >/dev/null 2>&1 || {
    echo "macOS builds require xcrun" >&2
    exit 2
  }
  if ! MACOS_SDKROOT="$(SDKROOT='' xcrun --sdk macosx --show-sdk-path)"; then
    echo "unable to locate the macOS SDK" >&2
    exit 2
  fi
  [[ -d "$MACOS_SDKROOT" ]] || {
    echo "invalid macOS SDK path: $MACOS_SDKROOT" >&2
    exit 2
  }
  export SDKROOT="$MACOS_SDKROOT"
fi

mkdir -p "$OUTPUT_ROOT" "$CARGO_TARGET_DIR"
BUILD_DIR="$CARGO_TARGET_DIR/$TARGET/release"

echo ">> Building $TARGET"
(cd "$ROOT/ffi" && CARGO_TARGET_DIR="$CARGO_TARGET_DIR" cargo build --locked --release --target "$TARGET")

DYNAMIC="$BUILD_DIR/$DYNAMIC_NAME"
STATIC="$BUILD_DIR/$STATIC_NAME"
HEADER="$ROOT/ffi/include/htmltrust_canonicalization.h"
[[ -s "$DYNAMIC" ]] || { echo "missing dynamic library: $DYNAMIC" >&2; exit 1; }
[[ -s "$STATIC" ]] || { echo "missing static library: $STATIC" >&2; exit 1; }
[[ -s "$HEADER" ]] || { echo "missing C header: $HEADER" >&2; exit 1; }

HOST_TARGET="$(rustc -vV | sed -n 's/^host: //p')"
HOST_OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
RUN_NATIVE_SMOKE=false
if [[ "$TARGET" == "$HOST_TARGET" ]]; then
  RUN_NATIVE_SMOKE=true
elif [[ "$TARGET" == "i686-unknown-linux-gnu" &&
        "$HOST_TARGET" == "x86_64-unknown-linux-gnu" && "$HOST_OS" == "linux" ]]; then
  # An x86 Linux library and executable can run on an x86_64 host when the
  # compiler and linker have multilib support installed.
  RUN_NATIVE_SMOKE=true
fi
if [[ "$RUN_NATIVE_SMOKE" == true ]]; then
  command -v "${CC:-cc}" >/dev/null 2>&1 || {
    echo "native smoke tests require a C compiler (${CC:-cc})" >&2
    exit 2
  }
  SMOKE_ROOT="$(mktemp -d "$OUTPUT_ROOT/.smoke-${TARGET}.XXXXXX")"
  trap 'rm -rf -- "$SMOKE_ROOT"' EXIT
  CC_BIN="${CC:-cc}"
  CFLAGS=(-O2)
  if [[ "$TARGET" == "i686-unknown-linux-gnu" ]]; then
    CFLAGS+=(-m32)
  elif [[ "$PLATFORM" == "darwin" ]]; then
    CFLAGS+=(-isysroot "$MACOS_SDKROOT")
  fi
  echo ">> Dynamic C header smoke test ($TARGET)"
  if [[ "$PLATFORM" == "linux" ]]; then
    "$CC_BIN" "${CFLAGS[@]}" -std=c11 -Wall -Wextra -Werror \
      -I"$ROOT/ffi/include" "$ROOT/ffi/tests/header_smoke.c" \
      -L"$BUILD_DIR" -Wl,-rpath,"$BUILD_DIR" \
      -lhtmltrust_canonicalization_ffi -o "$SMOKE_ROOT/header-smoke"
    LD_LIBRARY_PATH="$BUILD_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
      "$SMOKE_ROOT/header-smoke"
  else
    "$CC_BIN" "${CFLAGS[@]}" -std=c11 -Wall -Wextra -Werror \
      -I"$ROOT/ffi/include" "$ROOT/ffi/tests/header_smoke.c" \
      -L"$BUILD_DIR" -Wl,-rpath,"$BUILD_DIR" \
      -lhtmltrust_canonicalization_ffi -o "$SMOKE_ROOT/header-smoke"
    DYLD_LIBRARY_PATH="$BUILD_DIR${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}" \
      "$SMOKE_ROOT/header-smoke"
  fi

  echo ">> Static C header smoke test ($TARGET)"
  STATIC_FLAGS=()
  if [[ "$PLATFORM" == "linux" ]]; then
    STATIC_FLAGS=(-ldl -lpthread -lm)
  else
    STATIC_FLAGS=(-framework Security)
  fi
  "$CC_BIN" "${CFLAGS[@]}" -std=c11 -Wall -Wextra -Werror \
    -I"$ROOT/ffi/include" "$ROOT/ffi/tests/header_smoke.c" \
    "$STATIC" "${STATIC_FLAGS[@]}" -o "$SMOKE_ROOT/header-smoke-static"
  "$SMOKE_ROOT/header-smoke-static"
fi

NAME="htmltrust-canonicalization-ffi-v${VERSION}-abi${ABI_VERSION}-${TARGET}"
python3 "$ROOT/scripts/artifact_bundle.py" \
  --root "$ROOT" \
  --output-root "$OUTPUT_ROOT" \
  --name "$NAME" \
  --version "$VERSION" \
  --abi-version "$ABI_VERSION" \
  --target "$TARGET" \
  --format tar.gz \
  --dynamic "$DYNAMIC" \
  --static "$STATIC" \
  --header "$HEADER"

echo "Wrote $OUTPUT_ROOT/$NAME.tar.gz"
