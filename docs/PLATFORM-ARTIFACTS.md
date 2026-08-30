# Use the platform artifact lanes for Rust core builds

**Author:** HTMLTrust contributors

**Date:** 2026-08-30

**Version:** 0.1

**Status:** Developer reference, CI artifacts only

**Reading time:** 8 minutes

**Written for:** Binding maintainers, application integrators, and release maintainers

## Summary

Rust is the mandatory canonicalization core. Every native language adapter
loads its versioned C application binary interface (ABI). JavaScript loads the
Rust WebAssembly (WASM) build. The artifact lanes below build and check the
same Rust implementation for each platform.

The primary desktop runtime lanes are Linux, macOS, and Windows on x86_64 and
ARM64. Linux i686 and Windows i686 are C ABI compatibility lanes. Android and
iOS lanes produce linkable mobile packages and run C link checks. Mobile lanes
stop after those checks; device and simulator execution uses a later test lane.

Continuous integration (CI) artifacts are unsigned and unpublished. A CI upload records a build result.
Release distribution requires a separate trust and publication process.

## Choose a lane

| Lane | Targets or format | Checks and support level |
| --- | --- | --- |
| Desktop runtime | Linux x86_64 and ARM64, macOS x86_64 and ARM64, Windows x86_64 and ARM64 | Native dynamic and static C smoke tests run on matching jobs. The Go adapter also loads the built dynamic library and runs its tests. |
| C ABI compatibility | Linux i686, Windows i686 | Linux runs dynamic and static smoke executables with x86 multilib. Windows uses x86 MSVC tools and runs on an x64 host. This lane checks ABI compatibility. |
| Android package | Android application programming interface (API) 21, Native Development Kit (NDK) r27d, `arm64-v8a`, `armeabi-v7a`, `x86_64`, `x86` | Each ABI gets a shared library and C link check. The output includes raw `jniLibs` and an AAR with Prefab and conventional `jni/<abi>` entries. |
| iOS package | Deployment target 12, arm64 device, arm64 and x86_64 simulator | Each static slice gets a C link check. The output is a static XCFramework and archive. |
| JavaScript WASM | `wasm-node/` and `wasm-web/` | One Rust WASM build is wrapped for Node.js and browsers. Package tests initialize the packaged module. |

The desktop scripts use target triples and stage one target per archive. The
mobile scripts use fixed target and ABI maps so each ABI receives its mapped
library.

## Warning before you install

Signing, notarization, publication, download, and runtime library discovery
belong to later release work. Keep the archive, sidecar checksum, and manifest
together. Native Go, Python, and PHP applications configure an absolute library
path. The Android and iOS outputs still need application packaging and platform
review.

## Build desktop artifacts locally

Give each target a private Cargo target directory. Keep target directories
separate between targets, sessions, and toolchains.

### Unix targets

Use `scripts/build-native-unix.sh` on the matching Unix host. It accepts a
target triple, an absolute output directory, a package version, and an optional
ABI version:

```sh
export CARGO_TARGET_DIR="/mnt/bulk/cargo-targets/htmltrust-canonicalization/my-checkout/desktop-linux-x86_64"
mkdir -p "$HOME/tmp/htmltrust-artifacts/desktop-linux-x86_64"
bash scripts/build-native-unix.sh \
  x86_64-unknown-linux-gnu \
  "$HOME/tmp/htmltrust-artifacts/desktop-linux-x86_64" \
  0.3.0 1
```

Use another absolute, disk-backed path when `/mnt/bulk` is unavailable. Keep
the target directory private to this checkout, target, and toolchain.

Supported Unix triples are:

- `x86_64-unknown-linux-gnu`
- `aarch64-unknown-linux-gnu`
- `i686-unknown-linux-gnu`
- `x86_64-apple-darwin`
- `aarch64-apple-darwin`

The Rust target must be installed with `rustup`. Linux i686 requires x86
multilib on an x86_64 host. A cross build stages its files for a native matrix
job, where the smoke programs run on matching hardware.

The script builds `ffi` with `cargo build --locked --release`. It stages a
dynamic library, a static library, the public header, and `LICENSE`. On a
native job it compiles and runs both dynamic and static C header smoke
programs. The i686 Linux lane runs those programs with `-m32`.

### Windows targets

Use PowerShell and `scripts/build-native-windows.ps1` on a host with Microsoft
Visual C++ (MSVC) build tools installed. The script finds Visual Studio with
`vswhere` and initializes the required developer environment. The output and
Cargo target directories must be absolute paths:

```powershell
$env:CARGO_TARGET_DIR = 'C:\build\cargo\htmltrust-win-x64'
New-Item -ItemType Directory -Force C:\build\artifacts\htmltrust-win-x64
.\scripts\build-native-windows.ps1 `
  -Target x86_64-pc-windows-msvc `
  -OutputRoot C:\build\artifacts\htmltrust-win-x64 `
  -Version 0.3.0 `
  -AbiVersion 1
```

Supported Windows triples are `x86_64-pc-windows-msvc`,
`aarch64-pc-windows-msvc`, and `i686-pc-windows-msvc`. The script initializes
MSVC through `vswhere` and `VsDevCmd.bat`. The i686 lane selects x86 tools and
runs its smoke executable on an x64 host. Windows builds stage the dynamic-link
library (DLL), static `.lib`, import `.dll.lib`, header, and `LICENSE`.

## Build Android artifacts locally

Run `scripts/build-android-artifacts.sh` on Linux x86_64. Install the
four Rust Android targets before running it. The script requires an Android
Native Development Kit (NDK) directory containing `source.properties` and
checks for revision
`27.3.13750724`, the r27d release.

Set the NDK and output locations explicitly for a reviewable build:

```sh
export ANDROID_NDK=/opt/android-sdk/ndk/27.3.13750724
export ANDROID_API_LEVEL=21
export HTMLTRUST_CARGO_TARGET_ROOT="/mnt/bulk/cargo-targets/htmltrust-canonicalization/my-checkout/android-local"
export HTMLTRUST_ANDROID_ARTIFACTS="$HOME/tmp/htmltrust-artifacts/android"
export HTMLTRUST_TEST_SESSION_ID=android-local
bash scripts/build-android-artifacts.sh
```

`ANDROID_NDK_HOME` and `ANDROID_NDK_ROOT` are fallback names when
`ANDROID_NDK` is unset. `ANDROID_API_LEVEL` defaults to 21 and cannot be lower.
`HTMLTRUST_PACKAGE_VERSION` and `HTMLTRUST_ABI_VERSION` optionally override the
versions read from `ffi/Cargo.toml` and ABI version 1. Prefab receives the
numeric release portion of a prerelease package version because CMake requires
numeric Prefab version components.
The session ID permits letters, digits, `_`, `.`, and `-`. The script creates a
separate Cargo target directory for each ABI:

| ABI | Rust target |
| --- | --- |
| `arm64-v8a` | `aarch64-linux-android` |
| `armeabi-v7a` | `armv7-linux-androideabi` |
| `x86_64` | `x86_64-linux-android` |
| `x86` | `i686-linux-android` |

For every ABI, Cargo uses the NDK API-level Clang, the shared library is
checked with NDK `llvm-readelf`, and a C program links with `--no-undefined`.
The script writes raw libraries under `jniLibs/<abi>/` and creates
`htmltrust-canonicalization-android.aar`. The AAR contains Prefab metadata and
the conventional `jni/<abi>/` layout. Its manifest declares the selected API
level as `minSdkVersion`. The script checks every required AAR entry and
verifies its embedded checksums before returning.

This lane checks package contents and C linking. Android device and emulator
execution uses a later test lane.

## Build iOS artifacts locally

Run `scripts/build-apple-mobile-artifacts.sh` on macOS with Xcode command-line
tools and the three Rust Apple targets installed:

```sh
export IPHONEOS_DEPLOYMENT_TARGET=12.0
export HTMLTRUST_CARGO_TARGET_ROOT="$HOME/tmp/cargo-targets/htmltrust/ios"
export HTMLTRUST_IOS_ARTIFACTS="$HOME/tmp/htmltrust-artifacts/ios"
export HTMLTRUST_TEST_SESSION_ID=ios-local
bash scripts/build-apple-mobile-artifacts.sh
```

The checked lane uses deployment target 12.0. The script accepts
`IPHONEOS_DEPLOYMENT_TARGET` values from 10.0 upward. It also accepts optional
`HTMLTRUST_PACKAGE_VERSION` and `HTMLTRUST_ABI_VERSION` overrides. The script
builds arm64 for the device and arm64 plus x86_64 for the simulator. It checks
each archive with `lipo` and links the C header smoke program against each
static slice with the selected software development kit (SDK) and deployment
target.
It creates `HTMLTrustCanonicalization.xcframework` and
`HTMLTrustCanonicalization.xcframework.zip`.

The simulator output contains both simulator architectures in the
XCFramework. Device and simulator execution uses a later test lane. Swift
Package Manager publication remains future work.

## Output and verification

### Desktop archives

Unix output names follow:

```text
htmltrust-canonicalization-ffi-v<VERSION>-abi<ABI_VERSION>-<TARGET>.tar.gz
```

Windows output names use the same stem with `.zip`. Each archive contains the
target library files, `htmltrust_canonicalization.h`, `LICENSE`, and
`manifest.json`. The manifest records the package and ABI versions, target,
source revision and dirty state, source date, Rust and Cargo versions, host
platform, file sizes, and SHA-256 values. The script writes a sidecar
`<archive>.manifest.json` with archive size and hash, plus `<archive>.sha256`.

Review the sidecar and the manifest before giving an archive to an adapter.
Linux distribution compatibility depends on the glibc and toolchain used to
build the archive. Linux distribution compatibility follows that glibc and
toolchain; the archive has no manylinux baseline.

### Android files

The Android output root contains a Java Native Interface (JNI) library at
`jniLibs/<abi>/libhtmltrust_canonicalization_ffi.so`:

```text
jniLibs/<abi>/libhtmltrust_canonicalization_ffi.so
htmltrust-canonicalization-android.aar
htmltrust_canonicalization.h
LICENSE
MANIFEST.txt
SHA256SUMS
```

The AAR contains each library in its Prefab module and under `jni/<abi>/`. It
also includes its own license, manifest, and checksum file. The top-level
checksum covers `LICENSE`, the header, AAR, and four raw shared libraries.

### iOS files

The iOS output root contains:

```text
HTMLTrustCanonicalization.xcframework/
HTMLTrustCanonicalization.xcframework.zip
headers/htmltrust_canonicalization.h
headers/module.modulemap
slices/<slice>/libhtmltrust_canonicalization_ffi.a
libhtmltrust_canonicalization_ffi.a
LICENSE
MANIFEST.txt
SHA256SUMS
```

The checksum file covers the XCFramework archive, manifest, headers, and each
static slice. The text manifest records the deployment target, device slice,
simulator slices, required Security framework, and archive name.

### Static link dependencies

The static desktop archives need the same system libraries used by their C
smoke tests. Linux consumers pass `-ldl -lpthread -lm`. macOS consumers pass
`-framework Security`. Windows consumers link `bcrypt.lib`, `advapi32.lib`,
`userenv.lib`, `ws2_32.lib`, and `ntdll.lib`. An iOS application that links the
static XCFramework also links Apple's Security framework. The Android AAR uses
shared libraries and declares `stl: none` in each Prefab ABI record.

## Consume an artifact

Rust applications depend on the Rust crate directly. Go, Python, and PHP load
the native C ABI from a target-specific desktop archive and configure its
absolute library path. Their adapters validate ABI version 1 and required
symbols during startup. Go uses cgo on supported Unix systems and the native
Windows loader on Windows AMD64 and ARM64. Application configuration selects
the platform archive and controls its distribution.

JavaScript uses the npm package's packaged `wasm-node/` and `wasm-web/`
directories. Node imports the package entry point, which initializes its Node
module. Browser applications await `initializeBrowserWasm()` before calling
synchronous operations.

Android applications can consume `jniLibs` directly or use the Prefab AAR.
iOS applications can link the static XCFramework. Maven publication,
SwiftPM publication, and application-level packaging guidance remain future
work.

## Pull request (PR) and release workflow

The current PR checks run the Rust-first Docker validation and the platform
artifact matrix. The shared-core job uploads Linux amd64 files under
`rust-shared-core-linux-amd64`. The platform jobs upload target archives under
`htmltrust-linux-amd64`, `htmltrust-linux-arm64`, `htmltrust-linux-x86`,
`htmltrust-macos-amd64`, `htmltrust-macos-arm64`, `htmltrust-windows-amd64`,
`htmltrust-windows-arm64`, `htmltrust-windows-x86`, `htmltrust-android`, and
`htmltrust-apple-mobile`. Desktop outputs include the JSON source and toolchain
manifest. Mobile outputs include their text manifest and checksum files.

Release work starts from reviewed, target-specific build records. A future
release workflow can verify the sidecar checksums, apply signing or
notarization, and publish language or mobile packages. Those steps are outside
the current PR artifact contract.

## Rust boundary and support limits

Rust owns text normalization, HTML extraction, direct-claim extraction, claim
serialization, and strict JSON canonicalization. The C ABI and WebAssembly
exports call that implementation. Signing, verification, key resolution,
endorsement handling, and application policy remain in language adapters.

The current support contract has these limits:

- Desktop runtime support covers the six x86_64 and ARM64 targets in the
  primary matrix.
- Linux and Windows i686 provide C ABI compatibility checks.
- Windows support in these archives is MSVC-based. MinGW is outside this lane.
- Android uses API 21 and NDK r27d as the checked build inputs.
- iOS uses deployment target 12 and the listed static slices.
- CI artifacts are unsigned and unpublished.
- Mobile lanes stop after package and C link checks. Device and emulator
  execution belongs to future validation.

## Future release work

Signing and notarization, release policy, SwiftPM and Maven publication, and
mobile device or emulator runtime tests need separate release-matrix work. The
desktop scripts can produce target archives in this PR. Publication and trust
metadata belong to that later release workflow.

## Glossary

- **ABI:** The binary function contract between the adapter and Rust.
- **C ABI:** The versioned C function interface used by native language adapters.
- **JNI:** The native library layout used by Android applications.
- **Prefab:** Android metadata that lets Gradle expose native libraries to a consumer.
- **Target triple:** Rust's name for an operating system, architecture, and toolchain target.
- **XCFramework:** Apple's package for static or dynamic libraries across device and simulator slices.
- **WASM:** WebAssembly, the JavaScript runtime format in this project.

## Report a build problem

Open a GitHub issue or comment on the change under review. Include the exact
script command, target or ABI, operating system, tool versions, output
`MANIFEST.txt` or `manifest.json`, checksum file, and complete error output.
For a proposed support change, state whether it adds a runtime lane, a C ABI
compatibility lane, or a mobile link lane.

## Related documents

- [Rust shared core integration guide](RUST-SHARED-CORE.md)
- [FFI README](../ffi/README.md)
- [Go README](../go/README.md)
- [Repository README](../README.md)
