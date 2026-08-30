#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const entryPath = process.env.HTMLTRUST_BROWSER_PACKAGE_ENTRY;
const wasmPath = process.env.HTMLTRUST_BROWSER_WASM;
if (!entryPath || !wasmPath) {
  throw new Error(
    "HTMLTRUST_BROWSER_PACKAGE_ENTRY and HTMLTRUST_BROWSER_WASM are required",
  );
}

const { initializeBrowserWasm, normalizeText, extractCanonicalText } =
  await import(pathToFileURL(entryPath).href);
await initializeBrowserWasm(undefined, readFileSync(wasmPath));

assert.equal(normalizeText("A—B"), "A-B");
assert.equal(extractCanonicalText("<p>Ready.</p>"), "Ready.");
console.log("Packaged browser WASM smoke test passed");
