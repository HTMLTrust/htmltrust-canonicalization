# HTMLTrust Canonicalization for JavaScript

This package implements `htmltrust-c14n-v1` for Node.js and browsers. The
repository also contains a synchronous adapter for the Rust WebAssembly core.

- Version: `0.3.0` release candidate
- Node.js: 22 or newer

## Install and test a checkout

Run npm from the repository root, which contains the published package
manifest and lock file:

```sh
npm ci
npm test
```

Run every protocol fixture with:

```sh
node conformance/runners/run-javascript.mjs
```

## Independent JavaScript API

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

The independent implementation remains available for compatibility testing.
For extraction, `baseUrl: null` and `baseUrl: ""` both mean that no base URL
was supplied. A nonempty base URL has a 1 MiB UTF-8 ceiling.

## Rust WebAssembly adapter

`@htmltrust/canonicalization/rust-wasm` accepts a generated `wasm-bindgen`
module. Build and validate the current Node.js artifact from the repository
root:

```sh
make test-shared-core
```

The command prints the artifact directory. Initialize the adapter once before
calling its synchronous methods:

```js
import { createRequire } from "node:module";
import {
  initializeRustWasm,
  normalizeText,
} from "@htmltrust/canonicalization/rust-wasm";

const generated = createRequire(import.meta.url)(
  "/path/to/wasm-node/htmltrust_canonicalization_ffi.js",
);
initializeRustWasm(generated);
console.log(normalizeText("A—B"));
```

The npm package currently contains the adapter and TypeScript declarations.
The generated Node.js module is a separate artifact. Browser-target packaging
remains release work.

See the [repository README](../README.md) for portable-authoring commands and
the [shared-core guide](../docs/RUST-SHARED-CORE.md) for the ABI decision.
