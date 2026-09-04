#!/usr/bin/env bash
set -euo pipefail

# Build the Rust C ABI for the four Android ABIs supported by the Android NDK.
# The default API level is 21. Every ABI uses its own Cargo target directory.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

readonly NDK_VERSION="27.3.13750724"
readonly NDK_MAJOR="27"
readonly DEFAULT_API_LEVEL="21"
readonly LIBRARY_NAME="htmltrust_canonicalization_ffi"

die() {
  echo "build-android-artifacts: $*" >&2
  exit 2
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is missing: $1"
}

require_command cargo
require_command rustup
require_command sha256sum
require_command unzip
require_command zip

NDK="${ANDROID_NDK:-${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}}"
[[ -n "$NDK" && -d "$NDK" ]] || die "set ANDROID_NDK, ANDROID_NDK_HOME, or ANDROID_NDK_ROOT"
NDK="$(cd "$NDK" && pwd)"
[[ -f "$NDK/source.properties" ]] || die "NDK source.properties is missing: $NDK"
actual_ndk_version="$(sed -n 's/^Pkg.Revision[[:space:]]*=[[:space:]]*//p' "$NDK/source.properties")"
[[ "$actual_ndk_version" == "$NDK_VERSION" ]] || die "NDK $NDK_VERSION (r27d) is required, found ${actual_ndk_version:-unknown}"

API_LEVEL="${ANDROID_API_LEVEL:-$DEFAULT_API_LEVEL}"
[[ "$API_LEVEL" =~ ^[0-9]+$ ]] || die "ANDROID_API_LEVEL must be an integer"
(( API_LEVEL >= 21 )) || die "ANDROID_API_LEVEL must be at least 21 for this artifact lane"
PACKAGE_VERSION="${HTMLTRUST_PACKAGE_VERSION:-$(awk '
  $0 == "[package]" { package = 1; next }
  package && /^\[/ { exit }
  package && /^version = "/ { gsub(/^version = "|"$/, ""); print; exit }
' "$ROOT/ffi/Cargo.toml")}"
[[ "$PACKAGE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.-]+)?$ ]] \
  || die "HTMLTRUST_PACKAGE_VERSION is not a valid package version: $PACKAGE_VERSION"
PREFAB_VERSION="${PACKAGE_VERSION%%[-+]*}"
[[ "$PREFAB_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || die "the Prefab package version must have three numeric components"
ABI_VERSION="${HTMLTRUST_ABI_VERSION:-1}"
[[ "$ABI_VERSION" =~ ^[1-9][0-9]*$ ]] || die "HTMLTRUST_ABI_VERSION must be a positive integer"

case "$(uname -s):$(uname -m)" in
  Linux:x86_64) HOST_TAG="linux-x86_64" ;;
  *) die "the Android builder requires a Linux x86-64 host" ;;
esac

TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/$HOST_TAG/bin"
[[ -d "$TOOLCHAIN" ]] || die "NDK toolchain directory is missing: $TOOLCHAIN"
READELF="$TOOLCHAIN/llvm-readelf"
[[ -x "$READELF" ]] || die "NDK llvm-readelf is missing: $READELF"

CHECKOUT_ID="$(printf '%s' "$ROOT" | cksum | awk '{print $1}')"
DISK_TEMP_ROOT="${TMPDIR:-${HOME}/tmp}"
if [[ "$DISK_TEMP_ROOT" == "/tmp" || "$DISK_TEMP_ROOT" == /tmp/* ]]; then
  DISK_TEMP_ROOT="${HOME}/tmp"
fi
SESSION_ID="${HTMLTRUST_TEST_SESSION_ID:-default}"
[[ "$SESSION_ID" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || die "HTMLTRUST_TEST_SESSION_ID contains unsupported characters"

if [[ -d /mnt/bulk ]]; then
  DEFAULT_TARGET_ROOT="/mnt/bulk/cargo-targets/htmltrust-canonicalization/$(basename "$ROOT")-${CHECKOUT_ID}-${SESSION_ID}/android"
else
  DEFAULT_TARGET_ROOT="${DISK_TEMP_ROOT}/cargo-targets/htmltrust-mobile-android/${CHECKOUT_ID}-${SESSION_ID}"
fi
TARGET_ROOT="${HTMLTRUST_CARGO_TARGET_ROOT:-$DEFAULT_TARGET_ROOT}"
ARTIFACTS="${HTMLTRUST_ANDROID_ARTIFACTS:-${DISK_TEMP_ROOT}/htmltrust-mobile/android/${CHECKOUT_ID}-${SESSION_ID}}"
mkdir -p "$TARGET_ROOT" "$ARTIFACTS"

HEADER_SOURCE="$ROOT/ffi/include/htmltrust_canonicalization.h"
SMOKE_SOURCE="$ROOT/ffi/tests/header_smoke.c"
ANDROID_MANIFEST_TEMPLATE="$ROOT/mobile/android/AndroidManifest.xml.in"
[[ -f "$HEADER_SOURCE" ]] || die "public header is missing: $HEADER_SOURCE"
[[ -f "$SMOKE_SOURCE" ]] || die "header smoke source is missing: $SMOKE_SOURCE"
[[ -f "$ANDROID_MANIFEST_TEMPLATE" ]] || die "Android manifest template is missing: $ANDROID_MANIFEST_TEMPLATE"

declare -a TARGETS=(
  "aarch64-linux-android|arm64-v8a|aarch64-linux-android|AArch64"
  "armv7-linux-androideabi|armeabi-v7a|armv7a-linux-androideabi|ARM"
  "x86_64-linux-android|x86_64|x86_64-linux-android|Advanced Micro Devices X86-64"
  "i686-linux-android|x86|i686-linux-android|Intel 80386"
)

for entry in "${TARGETS[@]}"; do
  IFS='|' read -r target abi compiler_prefix machine <<< "$entry"
  rustup target list --installed | awk '{print $1}' | grep -Fx "$target" >/dev/null \
    || die "Rust target is not installed: $target"

  clang="$TOOLCHAIN/${compiler_prefix}${API_LEVEL}-clang"
  [[ -x "$clang" ]] || die "NDK clang is missing: $clang"

  target_dir="$TARGET_ROOT/$target"
  mkdir -p "$target_dir"
  target_key="$(printf '%s' "$target" | tr '[:lower:]-' '[:upper:]_')"
  linker_variable="CARGO_TARGET_${target_key}_LINKER"
  env "$linker_variable=$clang" \
    CARGO_TARGET_DIR="$target_dir" \
    cargo build --locked --release --manifest-path "$ROOT/ffi/Cargo.toml" --target "$target"

  release_dir="$target_dir/$target/release"
  shared_library="$release_dir/lib${LIBRARY_NAME}.so"
  static_library="$release_dir/lib${LIBRARY_NAME}.a"
  [[ -s "$shared_library" ]] || die "missing Android shared library: $shared_library"
  [[ -s "$static_library" ]] || die "missing Android static library: $static_library"

  "$READELF" -h "$shared_library" | grep -F "Machine:" | grep -F "$machine" >/dev/null \
    || die "unexpected ELF machine for $target"

  jni_dir="$ARTIFACTS/jniLibs/$abi"
  mkdir -p "$jni_dir"
  cp "$shared_library" "$jni_dir/lib${LIBRARY_NAME}.so"

  link_check="$target_dir/header-smoke"
  "$clang" -std=c11 -Wall -Wextra -Werror \
    -I"$ROOT/ffi/include" \
    "$SMOKE_SOURCE" "$shared_library" \
    -Wl,--no-undefined \
    -o "$link_check"
  [[ -s "$link_check" ]] || die "C header link check produced no executable for $target"
done

cp "$HEADER_SOURCE" "$ARTIFACTS/htmltrust_canonicalization.h"
cp "$ROOT/LICENSE" "$ARTIFACTS/LICENSE"

# Build the minimal Prefab package inside an AAR. The direct jniLibs tree above
# remains available for applications that load the shared object directly.
AAR_STAGE="$ARTIFACTS/.aar-stage"
rm -rf -- "$AAR_STAGE"
mkdir -p \
  "$AAR_STAGE/META-INF/htmltrust" \
  "$AAR_STAGE/prefab/modules/$LIBRARY_NAME/include"
cp "$HEADER_SOURCE" "$AAR_STAGE/prefab/modules/$LIBRARY_NAME/include/"
sed "s/@HTMLTRUST_API_LEVEL@/$API_LEVEL/g" \
  "$ANDROID_MANIFEST_TEMPLATE" > "$AAR_STAGE/AndroidManifest.xml"
cp "$ROOT/LICENSE" "$AAR_STAGE/META-INF/htmltrust/LICENSE"

cat > "$AAR_STAGE/prefab/prefab.json" <<EOF
{
  "schema_version": 2,
  "name": "htmltrust_canonicalization_ffi",
  "version": "$PREFAB_VERSION"
}
EOF
cat > "$AAR_STAGE/prefab/modules/$LIBRARY_NAME/module.json" <<EOF
{
  "library_name": "lib$LIBRARY_NAME"
}
EOF

for entry in "${TARGETS[@]}"; do
  IFS='|' read -r target abi compiler_prefix machine <<< "$entry"
  target_dir="$TARGET_ROOT/$target"
  shared_library="$target_dir/$target/release/lib${LIBRARY_NAME}.so"
  prefab_lib_dir="$AAR_STAGE/prefab/modules/$LIBRARY_NAME/libs/android.$abi"
  jni_lib_dir="$AAR_STAGE/jni/$abi"
  mkdir -p "$prefab_lib_dir" "$jni_lib_dir"
  cp "$shared_library" "$prefab_lib_dir/lib${LIBRARY_NAME}.so"
  cp "$shared_library" "$jni_lib_dir/lib${LIBRARY_NAME}.so"
  cat > "$prefab_lib_dir/abi.json" <<EOF
{
  "abi": "$abi",
  "api": $API_LEVEL,
  "ndk": $NDK_MAJOR,
  "stl": "none",
  "static": false
}
EOF
done

cat > "$AAR_STAGE/META-INF/htmltrust/MANIFEST.txt" <<EOF
artifact=htmltrust-canonicalization-android
version=$PACKAGE_VERSION
prefab_version=$PREFAB_VERSION
abi_version=$ABI_VERSION
ndk_revision=$actual_ndk_version
ndk_release=r27d
android_api_level=$API_LEVEL
host_tag=$HOST_TAG
rust_target_directories=private-per-ABI
abis=arm64-v8a,armeabi-v7a,x86_64,x86
EOF

(
  cd "$AAR_STAGE"
  find . -type f ! -path './META-INF/htmltrust/SHA256SUMS' -print0 \
    | sort -z \
    | xargs -0 sha256sum > META-INF/htmltrust/SHA256SUMS
  sha256sum --check META-INF/htmltrust/SHA256SUMS
)

AAR_PATH="$ARTIFACTS/htmltrust-canonicalization-android.aar"
rm -f -- "$AAR_PATH"
(
  cd "$AAR_STAGE"
  zip -q -r "$AAR_PATH" AndroidManifest.xml META-INF jni prefab
)

declare -a EXPECTED_AAR_ENTRIES=(
  "AndroidManifest.xml"
  "META-INF/htmltrust/LICENSE"
  "META-INF/htmltrust/MANIFEST.txt"
  "META-INF/htmltrust/SHA256SUMS"
  "prefab/prefab.json"
  "prefab/modules/$LIBRARY_NAME/module.json"
  "prefab/modules/$LIBRARY_NAME/include/htmltrust_canonicalization.h"
)
for entry in "${TARGETS[@]}"; do
  IFS='|' read -r target abi compiler_prefix machine <<< "$entry"
  EXPECTED_AAR_ENTRIES+=(
    "jni/$abi/lib${LIBRARY_NAME}.so"
    "prefab/modules/$LIBRARY_NAME/libs/android.$abi/abi.json"
    "prefab/modules/$LIBRARY_NAME/libs/android.$abi/lib${LIBRARY_NAME}.so"
  )
done
unzip -tq "$AAR_PATH" >/dev/null || die "the generated Android AAR is not a valid ZIP archive"
for expected in "${EXPECTED_AAR_ENTRIES[@]}"; do
  unzip -Z1 "$AAR_PATH" | grep -Fx "$expected" >/dev/null \
    || die "the generated Android AAR is missing: $expected"
done

cat > "$ARTIFACTS/MANIFEST.txt" <<EOF
artifact=htmltrust-canonicalization-android
version=$PACKAGE_VERSION
prefab_version=$PREFAB_VERSION
abi_version=$ABI_VERSION
ndk_revision=$actual_ndk_version
ndk_release=r27d
android_api_level=$API_LEVEL
host_tag=$HOST_TAG
library=lib${LIBRARY_NAME}.so
direct_library_root=jniLibs
prefab_aar=$(basename "$AAR_PATH")
EOF

(
  cd "$ARTIFACTS"
  sha256sum \
    LICENSE \
    htmltrust_canonicalization.h \
    htmltrust-canonicalization-android.aar \
    jniLibs/arm64-v8a/lib${LIBRARY_NAME}.so \
    jniLibs/armeabi-v7a/lib${LIBRARY_NAME}.so \
    jniLibs/x86_64/lib${LIBRARY_NAME}.so \
    jniLibs/x86/lib${LIBRARY_NAME}.so \
    > SHA256SUMS
  sha256sum --check SHA256SUMS
)

rm -rf -- "$AAR_STAGE"
echo "Android artifacts written to $ARTIFACTS"
