# HTMLTrust Canonicalization for JavaScript

This package provides HTMLTrust canonicalization for Node.js and browsers.
Rust is the sole canonicalization implementation, packaged as generated
WebAssembly for both runtimes. Signing, verification, key resolution, and
portable authoring helpers stay in the JavaScript package.

**Author:** HTMLTrust contributors

**Date:** 2026-08-29

**Version:** 0.3.0 release candidate

**Status:** Node and browser WASM package layouts

**Readers:** JavaScript developers and package integrators

**Reading time:** 3 minutes

## Prerequisites and shortest test

Install Node.js 22 or newer. From the repository root, build the artifacts and
point the source test at the generated Node loader:

```sh
make core-artifacts
npm ci
HTMLTRUST_WASM_PKG=/absolute/path/to/wasm-node/htmltrust_canonicalization_ffi.js \
  npm test
```

The complete Rust artifact and adapter check is:

```sh
make test-docker
```

The Docker pipeline builds the Rust core first, generates `wasm-node/` and
`wasm-web/`, then tests the package and its installed layout. The native
artifact lane used by the same pipeline is Linux amd64.

## Node.js API

The package entry point loads the packaged Node WebAssembly module while the
module is imported. Await the import before calling synchronous operations:

```js
import {
  canonicalizeClaims,
  canonicalizeJsonDocument,
  extractCanonicalText,
  normalizeText,
} from "@htmltrust/canonicalization";

const text = normalizeText("A—B");
const content = extractCanonicalText('<a href="/paper">Paper</a>', {
  baseUrl: "https://example.org/article",
});
const claims = canonicalizeClaims({ License: "CC-BY-4.0" });
const json = canonicalizeJsonDocument('{"z":0,"a":1}');
```

`extractClaimsFromSignedSection` returns the direct claims from the first
signed section. Relative links require a resolved `baseUrl`. A missing or
empty base URL means relative links cannot be resolved.

## Browser API

Browser loading is asynchronous. Initialize the packaged browser module once
before calling the synchronous operations:

```js
import {
  initializeBrowserWasm,
  normalizeText,
} from "@htmltrust/canonicalization/browser";

await initializeBrowserWasm();
const text = normalizeText("A—B");
```

The optional second argument accepts a WebAssembly URL, `Request`, or bytes
when an application hosts or embeds the `.wasm` file itself:

```js
await initializeBrowserWasm(undefined, wasmUrl);
```

The first argument is reserved for supplying a compatible generated loader.
Most applications should omit both arguments and use the packaged files.

The low-level `@htmltrust/canonicalization/rust-wasm` entry point exposes
`initializeNodeWasm()` and `initializeBrowserWasm()` for applications that
manage when the packaged module loads. Calls before initialization raise
`rust-wasm-not-initialized`. Initialization validates ABI version 1 and the
required Rust exports.

## Build and inspect artifacts

From the repository root:

```sh
make core-artifacts
```

Use the printed absolute directory. `wasm-node/` contains the Node.js
`wasm-bindgen` loader and WebAssembly file. `wasm-web/` contains the browser
loader and WebAssembly file. `MANIFEST.txt` records the target, tool versions,
ABI, and checksums. `npm-package/` is the complete staged package tree. Pack
that directory for release:

```sh
npm pack /absolute/path/to/npm-package
```

Packing the checkout directly fails when generated WASM files are absent.

## Portable authoring

Install dependencies with `npm ci`, then preflight a complete document:

```sh
npm run portable-preflight -- \
  --url https://example.org/articles/example.html article.html
```

When running the command from a checkout, set `HTMLTRUST_WASM_PKG` to the
generated Node loader. A packaged install loads its bundled module.

The command checks each signed section and reports canonical content, claims,
source locations, and stable diagnostic codes. It does not fetch the document.

See the [repository README](../README.md), [FFI README](../ffi/README.md), and
[shared-core guide](../docs/RUST-SHARED-CORE.md). Report failures with the
command, browser or Node version, artifact manifest, and complete output in a
GitHub issue. Retained protocol history is available with `git show v0.2.2`.
