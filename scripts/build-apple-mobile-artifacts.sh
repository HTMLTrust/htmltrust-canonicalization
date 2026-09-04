#!/usr/bin/env bash
set -euo pipefail

# Build static Apple mobile artifacts for the Rust C ABI. Device and simulator
# archives stay separate. The two simulator archives are combined only after
# their individual link checks.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly LIBRARY_NAME="htmltrust_canonicalization_ffi"
# Rust supports iOS 10.0, while 12.0 gives current Xcode consumers a common
# baseline. Override this with IPHONEOS_DEPLOYMENT_TARGET when an app needs a
# newer deployment target.
readonly DEFAULT_DEPLOYMENT_TARGET="12.0"

die() { echo "build-apple-mobile-artifacts: $*" >&2; exit 2; }
require_command() { command -v "$1" >/dev/null 2>&1 || die "required command is missing: $1"; }

[[ "$(uname -s)" == "Darwin" ]] || die "Apple mobile artifacts require macOS"
for command_name in cargo rustup xcrun xcodebuild lipo zip shasum; do
  require_command "$command_name"
done

DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-$DEFAULT_DEPLOYMENT_TARGET}"
[[ "$DEPLOYMENT_TARGET" =~ ^[0-9]+\.[0-9]+([.][0-9]+)?$ ]] \
  || die "IPHONEOS_DEPLOYMENT_TARGET must be a version such as 12.0"
deployment_major="${DEPLOYMENT_TARGET%%.*}"
(( deployment_major >= 10 )) || die "IPHONEOS_DEPLOYMENT_TARGET must be at least 10.0"
PACKAGE_VERSION="${HTMLTRUST_PACKAGE_VERSION:-$(awk '
  $0 == "[package]" { package = 1; next }
  package && /^\[/ { exit }
  package && /^version = "/ { gsub(/^version = "|"$/, ""); print; exit }
' "$ROOT/ffi/Cargo.toml")}"
[[ "$PACKAGE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.-]+)?$ ]] \
  || die "HTMLTRUST_PACKAGE_VERSION is not a valid package version: $PACKAGE_VERSION"
ABI_VERSION="${HTMLTRUST_ABI_VERSION:-1}"
[[ "$ABI_VERSION" =~ ^[1-9][0-9]*$ ]] || die "HTMLTRUST_ABI_VERSION must be a positive integer"

CHECKOUT_ID="$(printf '%s' "$ROOT" | cksum | awk '{print $1}')"
DISK_TEMP_ROOT="${TMPDIR:-${HOME}/tmp}"
if [[ "$DISK_TEMP_ROOT" == "/tmp" || "$DISK_TEMP_ROOT" == /tmp/* ]]; then DISK_TEMP_ROOT="${HOME}/tmp"; fi
SESSION_ID="${HTMLTRUST_TEST_SESSION_ID:-default}"
[[ "$SESSION_ID" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || die "invalid HTMLTRUST_TEST_SESSION_ID"
if [[ -d /mnt/bulk ]]; then
  DEFAULT_TARGET_ROOT="/mnt/bulk/cargo-targets/htmltrust-canonicalization/$(basename "$ROOT")-${CHECKOUT_ID}-${SESSION_ID}/ios"
else
  DEFAULT_TARGET_ROOT="${DISK_TEMP_ROOT}/cargo-targets/htmltrust-mobile-ios/${CHECKOUT_ID}-${SESSION_ID}"
fi
TARGET_ROOT="${HTMLTRUST_CARGO_TARGET_ROOT:-$DEFAULT_TARGET_ROOT}"
ARTIFACTS="${HTMLTRUST_IOS_ARTIFACTS:-${DISK_TEMP_ROOT}/htmltrust-mobile/ios/${CHECKOUT_ID}-${SESSION_ID}}"
mkdir -p "$TARGET_ROOT" "$ARTIFACTS"

HEADER_SOURCE="$ROOT/ffi/include/htmltrust_canonicalization.h"
SMOKE_SOURCE="$ROOT/ffi/tests/header_smoke.c"
MODULE_MAP_SOURCE="$ROOT/mobile/ios/module.modulemap"
[[ -f "$HEADER_SOURCE" && -f "$SMOKE_SOURCE" && -f "$MODULE_MAP_SOURCE" ]] || die "mobile input asset is missing"

declare -a TARGETS=(
  "aarch64-apple-ios|iphoneos|arm64|device"
  "aarch64-apple-ios-sim|iphonesimulator|arm64|simulator-arm64"
  "x86_64-apple-ios|iphonesimulator|x86_64|simulator-x86_64"
)
for entry in "${TARGETS[@]}"; do
  IFS='|' read -r target sdk arch slice_name <<< "$entry"
  rustup target list --installed | awk '{print $1}' | grep -Fx "$target" >/dev/null \
    || die "Rust target is not installed: $target"
  sdk_path="$(xcrun --sdk "$sdk" --show-sdk-path)"
  clang="$(xcrun --sdk "$sdk" --find clang)"
  [[ -x "$clang" ]] || die "Apple clang is missing for SDK $sdk"
  target_dir="$TARGET_ROOT/$target"
  mkdir -p "$target_dir"
  env IPHONEOS_DEPLOYMENT_TARGET="$DEPLOYMENT_TARGET" SDKROOT="$sdk_path" \
    CARGO_TARGET_DIR="$target_dir" cargo build --locked --release \
    --manifest-path "$ROOT/ffi/Cargo.toml" --target "$target"
  static_library="$target_dir/$target/release/lib${LIBRARY_NAME}.a"
  [[ -s "$static_library" ]] || die "missing Apple static library: $static_library"

  if [[ "$sdk" == "iphoneos" ]]; then minimum_flag="-miphoneos-version-min=$DEPLOYMENT_TARGET"; else minimum_flag="-mios-simulator-version-min=$DEPLOYMENT_TARGET"; fi
  link_check="$target_dir/header-smoke"
  "$clang" -arch "$arch" -isysroot "$sdk_path" "$minimum_flag" \
    -std=c11 -Wall -Wextra -Werror -I"$ROOT/ffi/include" \
    "$SMOKE_SOURCE" "$static_library" -framework Security -Wl,-undefined,error -o "$link_check"
  [[ -s "$link_check" ]] || die "C header link check failed for $target"
  lipo -info "$static_library" | grep -F "$arch" >/dev/null || die "architecture check failed for $target"
  slice_path="$ARTIFACTS/slices/$slice_name"
  mkdir -p "$slice_path"
  cp "$static_library" "$slice_path/lib${LIBRARY_NAME}.a"
  case "$slice_name" in
    device) DEVICE_LIBRARY="$slice_path/lib${LIBRARY_NAME}.a" ;;
    simulator-arm64) SIMULATOR_ARM64_LIBRARY="$slice_path/lib${LIBRARY_NAME}.a" ;;
    simulator-x86_64) SIMULATOR_X86_64_LIBRARY="$slice_path/lib${LIBRARY_NAME}.a" ;;
  esac
done

SIMULATOR_LIBRARY="$ARTIFACTS/lib${LIBRARY_NAME}.a"
rm -f -- "$SIMULATOR_LIBRARY"
lipo -create "$SIMULATOR_ARM64_LIBRARY" "$SIMULATOR_X86_64_LIBRARY" -output "$SIMULATOR_LIBRARY"
lipo -info "$SIMULATOR_LIBRARY" | grep -F arm64 >/dev/null || die "simulator archive lacks arm64"
lipo -info "$SIMULATOR_LIBRARY" | grep -F x86_64 >/dev/null || die "simulator archive lacks x86_64"

HEADERS="$ARTIFACTS/headers"
rm -rf -- "$HEADERS"
mkdir -p "$HEADERS"
cp "$HEADER_SOURCE" "$HEADERS/htmltrust_canonicalization.h"
cp "$MODULE_MAP_SOURCE" "$HEADERS/module.modulemap"
cp "$ROOT/LICENSE" "$ARTIFACTS/LICENSE"
XCFRAMEWORK="$ARTIFACTS/HTMLTrustCanonicalization.xcframework"
rm -rf -- "$XCFRAMEWORK"
xcodebuild -create-xcframework \
  -library "$DEVICE_LIBRARY" -headers "$HEADERS" \
  -library "$SIMULATOR_LIBRARY" -headers "$HEADERS" -output "$XCFRAMEWORK"

ZIP_PATH="$ARTIFACTS/HTMLTrustCanonicalization.xcframework.zip"
rm -f -- "$ZIP_PATH"
( cd "$ARTIFACTS" && zip -q -r "$ZIP_PATH" "$(basename "$XCFRAMEWORK")" )
printf '%s\n' \
  'artifact=htmltrust-canonicalization-apple-mobile' \
  "version=$PACKAGE_VERSION" \
  "abi_version=$ABI_VERSION" \
  "ios_deployment_target=$DEPLOYMENT_TARGET" \
  'required_link_frameworks=Security' \
  'device_target=aarch64-apple-ios' \
  'simulator_targets=aarch64-apple-ios-sim,x86_64-apple-ios' \
  'xcframework=HTMLTrustCanonicalization.xcframework' \
  'archive=HTMLTrustCanonicalization.xcframework.zip' > "$ARTIFACTS/MANIFEST.txt"
( cd "$ARTIFACTS" && shasum -a 256 LICENSE HTMLTrustCanonicalization.xcframework.zip \
  slices/device/lib${LIBRARY_NAME}.a slices/simulator-arm64/lib${LIBRARY_NAME}.a \
  slices/simulator-x86_64/lib${LIBRARY_NAME}.a lib${LIBRARY_NAME}.a \
  headers/htmltrust_canonicalization.h headers/module.modulemap MANIFEST.txt > SHA256SUMS )
echo "Apple mobile artifacts written to $ARTIFACTS"
