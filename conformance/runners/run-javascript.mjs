#!/usr/bin/env node
/**
 * JavaScript conformance runner for HTMLTrust canonicalization.
 *
 * Reads every fixture under conformance/fixtures/{normalize,extract,claims}/,
 * runs the corresponding binding function, and compares byte-for-byte
 * against the `expected` field. Prints PASS / FAIL / SKIP per fixture and
 * exits non-zero on any divergence.
 *
 * Usage:
 *   node run-javascript.mjs           # verify all fixtures
 *   node run-javascript.mjs --update  # rewrite the `expected` field from
 *                                     # the current binding output
 *
 * The JS binding currently exports only `normalizeText`; extract and
 * claims fixtures are reported as SKIP (not failures) because the
 * runner has nothing to call.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

import * as binding from "../../javascript/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..", "..");
const FIXTURES_ROOT = join(__dirname, "..", "fixtures");

const args = new Set(process.argv.slice(2));
const UPDATE = args.has("--update");

// Map suite name -> function that runs the binding on the fixture input
// and returns the produced output string. Returns `null` if the binding
// has no implementation for that suite.
const RUNNERS = {
  normalize: (input) => binding.normalizeText(input),
  // The JS binding does not yet export extractCanonicalText or
  // canonicalizeClaims; the runner reports these suites as SKIP.
  extract: () => null,
  claims: () => null,
};

/** List fixture files in a suite directory, sorted lexically. */
function listFixtures(suite) {
  const dir = join(FIXTURES_ROOT, suite);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => join(dir, f));
}

function relPath(p) {
  return relative(REPO_ROOT, p);
}

function readFixture(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeFixture(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function showString(s) {
  return JSON.stringify(s);
}

let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];

for (const suite of ["normalize", "extract", "claims"]) {
  const runner = RUNNERS[suite];
  for (const path of listFixtures(suite)) {
    const fixture = readFixture(path);
    const id = relPath(path);

    let actual;
    try {
      actual = runner(fixture.input);
    } catch (err) {
      // A runner that throws unexpectedly counts as a fail.
      fail++;
      const msg = `FAIL ${id}\n  threw: ${err && err.message ? err.message : err}`;
      failures.push(msg);
      console.log(msg);
      continue;
    }

    if (actual === null) {
      skip++;
      console.log(`SKIP ${id}  (binding does not implement ${suite})`);
      continue;
    }

    if (UPDATE) {
      fixture.expected = actual;
      writeFixture(path, fixture);
      console.log(`UPDATED ${id}`);
      continue;
    }

    if (actual === fixture.expected) {
      pass++;
      console.log(`PASS ${id}`);
    } else {
      fail++;
      const msg =
        `FAIL ${id}\n` +
        `  expected: ${showString(fixture.expected)}\n` +
        `  got:      ${showString(actual)}`;
      failures.push(msg);
      console.log(msg);
    }
  }
}

if (!UPDATE) {
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
  if (fail > 0) {
    console.log("\n--- Failures ---");
    for (const msg of failures) console.log(msg);
  }
}

process.exit(fail > 0 ? 1 : 0);
