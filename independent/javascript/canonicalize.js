// HTMLTrust canonicalization: an independent implementation.
//
// This is a differential-testing oracle, not a production HTMLTrust
// binding. It is deliberately written from the specification text alone
// (draft-grey-htmltrust-00 sections 4-6), without reading or importing the
// project's Rust core (`rust/`) or its language bindings (`javascript/`,
// `ffi/`). Its entire value is in disagreeing with that core when either
// implementation has a bug the other doesn't share; see README.md.
//
// It is an ES module with no dependencies of its own. It never imports a
// specific HTML parser: extract() takes a `parseFragment` function as a
// parameter, supplied by an adapter (adapters/node-parse5.mjs, which wraps
// parse5, or adapters/browser-domparser.js, which wraps the browser's
// DOMParser). That keeps this file identical in Node and in a browser tab.
//
// Source layout:
//   lib/text-normalize.js   section 4.4, plain-text normalization
//   lib/portable-profile.js section 4.1.1, portable-parser-profile validation
//   lib/url-policy.js       section 5.2, htmltrust-safe-url-v1
//   lib/extract.js          sections 4.1-4.5, the walk and block structure
//   lib/claims.js           section 4.6, canonical claims
//   lib/jcs.js              RFC 8785, JSON Canonicalization Scheme
//   lib/entities-data.js    the HTML Standard's named-character-reference
//                           table (https://html.spec.whatwg.org/entities.json),
//                           used only to detect an unterminated match in the
//                           portable-profile checker; DOMParser and parse5
//                           already decode entities in ordinary text.
//   lib/errors.js           HTMLTrustError and small shared helpers

import { HTMLTrustError, fail, utf8ByteLength } from './lib/errors.js';
import { normalizeText, normalizeStandaloneText, escapeAt } from './lib/text-normalize.js';
import { canonicalizeClaims } from './lib/claims.js';
import { canonicalizeJCS } from './lib/jcs.js';
import { checkPortableProfile } from './lib/portable-profile.js';
import { extractContent } from './lib/extract.js';

const MAX_SOURCE_BYTES = 1024 * 1024; // 1 MiB, resource-limits table.

/**
 * Extract canonical content from an HTML fragment (draft sections 4.1-4.5).
 *
 * @param {string} html - the signed section's source octets, as text.
 * @param {object} opts
 * @param {string} [opts.baseURL] - document base URL for resolving href/src.
 * @param {(html: string) => Array} opts.parseFragment - adapter function
 *   that parses `html` in a fragment/body context and returns the
 *   top-level generic nodes ({type:'text',data} / {type:'element',name,
 *   attrs,children}).
 * @returns {string} canonical content.
 * @throws {HTMLTrustError}
 */
export function extract(html, { baseURL, parseFragment } = {}) {
  if (typeof parseFragment !== 'function') {
    throw new TypeError('extract() requires opts.parseFragment; see adapters/');
  }
  if (utf8ByteLength(html) > MAX_SOURCE_BYTES) {
    fail('resource-limit-exceeded', 'source input exceeds 1 MiB');
  }
  checkPortableProfile(html);
  const nodes = parseFragment(html);
  return extractContent(nodes, { baseURL });
}

/**
 * The `normalize` conformance suite's entry point: normalizeText (the
 * four normalize_text phases, section 4.4, with NO trimming) plus the
 * same 1 MiB source-input ceiling every other suite applies (see the
 * `resource-source-limit` fixture in each suite).
 *
 * This does not trim, even though the exported name this replaced
 * (normalizeStandaloneChecked, which called normalizeStandaloneText) did.
 * That was a confirmed divergence from the Rust core: normalize_text
 * itself never trims there either, and a leading/trailing space is
 * caller-specific (see normalizeStandaloneText's doc comment in
 * lib/text-normalize.js, and README.md's ambiguity 1).
 */
export function normalizeChecked(text) {
  if (utf8ByteLength(text) > MAX_SOURCE_BYTES) {
    fail('resource-limit-exceeded', 'normalize input exceeds 1 MiB');
  }
  return normalizeText(text);
}

export {
  HTMLTrustError,
  normalizeText,
  normalizeStandaloneText,
  escapeAt,
  canonicalizeClaims,
  canonicalizeJCS,
};
