#!/usr/bin/env node

import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const packageEntry = process.env.HTMLTRUST_NODE_PACKAGE_ENTRY;
const adapterLocation = packageEntry
  ? pathToFileURL(packageEntry).href
  : process.env.HTMLTRUST_NODE_ADAPTER_PATH
    ? pathToFileURL(process.env.HTMLTRUST_NODE_ADAPTER_PATH).href
    : new URL("../javascript/rust-wasm.js", import.meta.url).href;
const {
  canonicalizeClaims,
  canonicalizeJsonDocument,
  extractCanonicalText,
  initializeRustWasm,
  normalizeText,
} = await import(adapterLocation);

if (!packageEntry) {
  const wasmPath = process.env.HTMLTRUST_WASM_PKG;
  if (!wasmPath) throw new Error("HTMLTRUST_WASM_PKG is required");
  const require = createRequire(import.meta.url);
  initializeRustWasm(require(wasmPath));
}

const fixtureRoot = new URL("../conformance/fixtures/", import.meta.url);
const fixtureDir = decodeURIComponent(fixtureRoot.pathname);
const suites = {
  normalize: (fx) => normalizeText(expandInput(fx)),
  extract: (fx) => extractCanonicalText(expandInput(fx), { baseUrl: fx.baseURL ?? null }),
  claims: (fx) => canonicalizeClaims(expandInput(fx)),
  jcs: (fx) => canonicalizeJsonDocument(expandInput(fx)),
};

function expandInput(fixture) {
  if (!fixture.repeat) return fixture.input;
  if (typeof fixture.input === "string") return fixture.input.repeat(fixture.repeat);
  if (fixture.input && typeof fixture.input === "object") {
    const out = {};
    for (const [key, value] of Object.entries(fixture.input)) {
      out[key] = typeof value === "string" ? value.repeat(fixture.repeat) : value;
    }
    return out;
  }
  return fixture.input;
}

let passed = 0;
let failed = 0;
for (const [suite, run] of Object.entries(suites)) {
  const suiteDir = join(fixtureDir, suite);
  for (const name of readdirSync(suiteDir).filter((x) => x.endsWith(".json")).sort()) {
    const fixture = JSON.parse(readFileSync(join(suiteDir, name), "utf8"));
    const id = `conformance/fixtures/${suite}/${name}`;
    try {
      const actual = run(fixture);
      if (fixture.error) throw new Error(`expected error ${fixture.error}, got output`);
      assert.equal(actual, fixture.expected, id);
      passed++;
    } catch (error) {
      const message = error?.message ?? String(error);
      if (fixture.error && message.includes(fixture.error)) {
        passed++;
      } else {
        failed++;
        console.error(`FAIL ${id}: ${message}`);
      }
    }
  }
}
console.log(`Rust/WASM conformance: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
