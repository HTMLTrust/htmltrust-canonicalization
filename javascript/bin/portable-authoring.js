#!/usr/bin/env node

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { initializeNodeWasm } from "../rust-wasm.js";
import {
  preflightPortableDocument,
  wrapSignedSection,
} from "../portable-authoring.js";

const require = createRequire(import.meta.url);
const wasmModule = process.env.HTMLTRUST_WASM_PKG
  ? require(process.env.HTMLTRUST_WASM_PKG)
  : undefined;
await initializeNodeWasm(wasmModule);

function usage() {
  console.error("Usage: htmltrust-portable-preflight --url https://example.test/page.html [--wrap] [file|-]");
  console.error("       Reads UTF-8 HTML from file, or stdin when file is omitted or '-'.");
}

const args = process.argv.slice(2);
let documentURL = null;
let inputPath = "-";
let wrap = false;

for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--help" || arg === "-h") {
    usage();
    process.exit(0);
  }
  if (arg === "--wrap") {
    wrap = true;
    continue;
  }
  if (arg === "--url") {
    documentURL = args[++index];
    continue;
  }
  if (arg.startsWith("--")) {
    usage();
    process.exit(2);
  }
  if (inputPath !== "-") {
    usage();
    process.exit(2);
  }
  inputPath = arg;
}

if (!wrap && !documentURL) {
  usage();
  process.exit(2);
}

let html;
try {
  html = inputPath === "-" ? readFileSync(0, "utf8") : readFileSync(inputPath, "utf8");
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    diagnostics: [{
      code: "input-read-failed",
      severity: "error",
      message: String(error?.message || error),
      hint: "Check the input path and read permissions.",
      region: null,
      context: { inputPath },
    }],
  }));
  process.exit(1);
}

if (wrap) {
  try {
    console.log(JSON.stringify({ ok: true, html: wrapSignedSection(html) }));
    process.exit(0);
  } catch (error) {
    const code = error?.code || "conversion-ambiguous";
    console.log(JSON.stringify({
      ok: false,
      diagnostics: [{
        code,
        severity: "error",
        message: String(error?.message || code),
        hint: "Use an unambiguous, well-formed fragment and preserve its original source.",
        region: null,
        context: error?.context || {},
      }],
    }));
    process.exit(1);
  }
}

const result = preflightPortableDocument(html, { documentURL });
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
