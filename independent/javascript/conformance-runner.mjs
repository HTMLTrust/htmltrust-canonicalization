#!/usr/bin/env node
// Speaks the conformance/PROTOCOL.md JSON-Lines contract on stdin/stdout,
// backed by canonicalize.js (this package's independent implementation)
// and the parse5-based Node adapter.
//
// Run directly:
//   node conformance-runner.mjs
// Run against the fixture suite:
//   python3 ../../conformance/run-external.py --verify-fixtures -v -- \
//     node conformance-runner.mjs

import { createInterface } from 'node:readline';
import { extract, normalizeStandaloneChecked, canonicalizeClaims, canonicalizeJCS, HTMLTrustError } from './canonicalize.js';
import { parseFragment } from './adapters/node-parse5.mjs';

/**
 * PROTOCOL.md's `repeat` field repeats "input" before processing. For the
 * `claims` suite, input is a JSON object rather than text; the fixtures
 * that use repeat there (resource-repeat-limit) repeat each claim's
 * string value, per that fixture's own description ("repeat expansion
 * applies to claim values before the 4 KiB field limit").
 */
function applyRepeat(suite, input, repeat) {
  if (!repeat || repeat === 1) return input;
  if (suite === 'claims') {
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      out[k] = typeof v === 'string' ? v.repeat(repeat) : v;
    }
    return out;
  }
  return input.repeat(repeat);
}

function handle(req) {
  const input = applyRepeat(req.suite, req.input, req.repeat);
  switch (req.suite) {
    case 'normalize':
      return normalizeStandaloneChecked(input);
    case 'extract':
      return extract(input, { baseURL: req.baseURL, parseFragment });
    case 'claims':
      return canonicalizeClaims(input);
    case 'jcs':
      return canonicalizeJCS(input);
    default:
      throw new Error(`unknown suite ${JSON.stringify(req.suite)}`);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed === '') return;
  const req = JSON.parse(trimmed);
  let response;
  try {
    response = { id: req.id, output: handle(req) };
  } catch (err) {
    if (err instanceof HTMLTrustError) {
      response = { id: req.id, error: err.code };
    } else {
      // A bug, not a spec-defined rejection. Surface it loudly on stderr
      // and crash, rather than inventing an error code that would hide
      // the bug behind a plausible-looking conformance failure.
      process.stderr.write(`INTERNAL ERROR on ${req.id}: ${err.stack || err}\n`);
      process.exitCode = 2;
      process.exit(2);
    }
  }
  process.stdout.write(JSON.stringify(response) + '\n');
});
