import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canonicalizeClaims,
  canonicalizeJsonDocument,
  extractCanonicalText,
  initializeRustWasm,
  normalizeText,
  resetRustWasm,
} from "./rust-wasm.js";

test.beforeEach(() => resetRustWasm());
test.after(() => resetRustWasm());

test("calls fail until the WASM module is explicitly initialized", () => {
  assert.throws(
    () => extractCanonicalText("<p>hello</p>"),
    (error) => error instanceof Error && error.message === "rust-wasm-not-initialized",
  );
});

test("calls remain synchronous after initialization", () => {
  let calls = 0;
  initializeRustWasm({
    abiVersion: () => 1,
    normalizeText: () => "normalized",
    extractCanonicalText(html, base) {
      calls++;
      assert.equal(html, "<p>hello</p>");
      assert.equal(base, calls === 1 ? "https://example.test/page" : undefined);
      return "hello";
    },
    canonicalizeClaims: (document) => `claims:${document}`,
    canonicalizeJsonDocument: (document) => `jcs:${document}`,
  });
  const result = extractCanonicalText("<p>hello</p>", {
    baseUrl: "https://example.test/page",
  });
  assert.equal(result, "hello");
  assert.equal(extractCanonicalText("<p>hello</p>", { baseUrl: "" }), "hello");
  assert.equal(typeof result.then, "undefined");
  assert.equal(calls, 2);
});

test("rejects a module without the required export", () => {
  assert.throws(() => initializeRustWasm({ abiVersion: () => 1 }), /rust-wasm-module-invalid/);
});

test("validates the ABI version", () => {
  const module = {
    abiVersion: () => 2,
    normalizeText: () => "",
    extractCanonicalText: () => "",
    canonicalizeClaims: () => "",
    canonicalizeJsonDocument: () => "",
  };
  assert.throws(() => initializeRustWasm(module), /rust-wasm-abi-unsupported/);
});

test("exposes all four operations and v1 whitespace behavior", () => {
  initializeRustWasm({
    abiVersion: () => 1,
    normalizeText: (value) => `norm:${value}`,
    extractCanonicalText: () => "extract",
    extractCanonicalTextWithOptions: (html, preserve, base) => `${html}:${preserve}:${base}`,
    canonicalizeClaims: (value) => `claims:${value}`,
    canonicalizeJsonDocument: (value) => `jcs:${value}`,
  });
  assert.equal(normalizeText("A—B", {}), "norm:A—B");
  assert.equal(canonicalizeClaims({ z: "1" }), 'claims:{"z":"1"}');
  assert.equal(canonicalizeJsonDocument('{"z":1}'), 'jcs:{"z":1}');
  assert.equal(extractCanonicalText("x", { preserveWhitespace: true }), "x:true:undefined");
  assert.throws(() => normalizeText("x", { preserveWhitespace: true }), /rust-wasm-option-unsupported/);
  assert.throws(() => canonicalizeClaims(null), /claim-malformed/);
  assert.throws(() => canonicalizeClaims({ count: 1 }), /claim-malformed/);
});

test("rejects non-string and lone-surrogate inputs before WASM encoding", () => {
  let calls = 0;
  initializeRustWasm({
    abiVersion: () => 1,
    normalizeText: () => { calls++; return ""; },
    extractCanonicalText: () => { calls++; return ""; },
    canonicalizeClaims: () => { calls++; return ""; },
    canonicalizeJsonDocument: () => { calls++; return ""; },
  });

  assert.throws(() => normalizeText(42), /normalizeText expects a string/);
  assert.throws(() => normalizeText("\ud800"), /parser-profile-unsupported/);
  assert.throws(() => extractCanonicalText("<p>x</p>", { baseUrl: "\udc00" }), /parser-profile-unsupported/);
  assert.throws(() => canonicalizeClaims({ value: "\ud800" }), /claim-malformed/);
  assert.throws(() => canonicalizeJsonDocument('"\ud800"'), /jcs-invalid-surrogate/);
  assert.equal(calls, 0);
});

test("canonicalizeClaims serializes the validated snapshot", () => {
  let document;
  const claims = Object.create({
    toJSON() {
      return { replaced: "value" };
    },
  });
  claims.License = "CC-BY-4.0";
  initializeRustWasm({
    abiVersion: () => 1,
    normalizeText: () => "",
    extractCanonicalText: () => "",
    canonicalizeClaims(value) {
      document = value;
      return "License:CC-BY-4.0\n";
    },
    canonicalizeJsonDocument: () => "",
  });

  assert.equal(canonicalizeClaims(claims), "License:CC-BY-4.0\n");
  assert.equal(document, '{"License":"CC-BY-4.0"}');
});

test("generated Node WASM module passes a real extraction smoke test", { skip: !process.env.HTMLTRUST_WASM_PKG }, () => {
  const require = createRequire(import.meta.url);
  const generated = require(process.env.HTMLTRUST_WASM_PKG);
  initializeRustWasm(generated);
  assert.equal(normalizeText("A—B", {}), "A-B");
  assert.equal(canonicalizeClaims({ License: "CC-BY-4.0" }), "License:CC-BY-4.0\n");
  assert.equal(canonicalizeJsonDocument('{"z":0,"a":1}'), '{"a":1,"z":0}');
  assert.throws(
    () => canonicalizeJsonDocument("{"),
    (error) => error instanceof Error && error.message === "jcs-invalid-json",
  );
  assert.equal(
    extractCanonicalText('<p>He said, “Hello…”</p>'),
    'He said, "Hello..."',
  );
});
