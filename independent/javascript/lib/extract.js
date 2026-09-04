// Canonical content extraction: draft sections 4.1-4.5 (walk and text
// extraction, element categories, text normalization, block structure).
//
// This module is parser-agnostic: it walks a small generic tree shape --
// { type: 'text', data } and { type: 'element', name, attrs, children } --
// that an adapter (adapters/node-parse5.mjs or adapters/browser-domparser.js)
// builds from a real HTML parser's output. It never touches parse5 or
// DOMParser directly, and it never runs on input that
// lib/portable-profile.js has not already accepted; see that module for
// why a real parser's own (silently repairing) error handling cannot be
// used as this profile's oracle.

import { fail, utf8ByteLength } from './errors.js';
import { normalizeText, escapeAt } from './text-normalize.js';
import { canonicalizeSafeURL, checkBaseURL } from './url-policy.js';

const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB, resource-limits table.

// Section 4.3.1: excluded elements. Their entire subtree contributes no
// bytes, including any signed semantic attributes they carry.
const EXCLUDED = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'head', 'link', 'meta']);

// Section 4.3.3: boundary-producing elements (exact list).
const BOUNDARY = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div', 'dl',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'header', 'hgroup', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'signed-section', 'table', 'td', 'th', 'tr', 'ul',
]);

// Section 4.3.2: signed semantic attributes, in the fixed emission order.
const SIGNED_ATTRS = ['href', 'src', 'alt', 'aria-label'];

function lastChar(parts) {
  for (let k = parts.length - 1; k >= 0; k--) {
    if (parts[k].length > 0) return parts[k][parts[k].length - 1];
  }
  return '';
}

/** Section 4.3.2: the separator rule before an attribute record. */
function ensureAttrSeparator(parts) {
  const lc = lastChar(parts);
  if (lc !== '' && lc !== ' ' && lc !== '\n') parts.push('\n');
}

function emitAttributeRecords(parts, node, baseURL) {
  for (const attrName of SIGNED_ATTRS) {
    if (!Object.prototype.hasOwnProperty.call(node.attrs, attrName)) continue;
    const rawValue = node.attrs[attrName];

    let normalizedValue;
    if (attrName === 'href' || attrName === 'src') {
      normalizedValue = canonicalizeSafeURL(rawValue, baseURL);
    } else {
      // alt, aria-label: plain-text normalization (section 4.4). Phase 3
      // maps every source whitespace code point, U+000A included, to a
      // single space, so a normalized text value can never itself
      // contain a line feed; the draft's "MUST NOT contain U+000A" clause
      // is automatically satisfied here and needs no separate check.
      normalizedValue = normalizeText(rawValue);
    }

    ensureAttrSeparator(parts);
    parts.push(`@attr:${node.name}:${attrName}:${escapeAt(normalizedValue)}\n`);
  }
}

function walk(nodes, parts, baseURL) {
  for (const node of nodes) {
    if (node.type === 'text') {
      const escaped = escapeAt(normalizeText(node.data));
      if (escaped !== '') parts.push(escaped);
      continue;
    }
    // node.type === 'element'
    const name = node.name;
    if (name === 'br') {
      parts.push('\n'); // section 4.5: br emits a soft line break.
      continue;
    }
    if (EXCLUDED.has(name)) continue; // no bytes, no attribute records, no descent.

    emitAttributeRecords(parts, node, baseURL);
    walk(node.children, parts, baseURL);
    if (BOUNDARY.has(name)) parts.push('\n');
  }
}

/**
 * Extract canonical content from a parsed HTML fragment's top-level node
 * list. `parseFragment` (from an adapter) has already built `nodes` from
 * source that lib/portable-profile.js accepted.
 */
export function extractContent(nodes, { baseURL } = {}) {
  checkBaseURL(baseURL);

  const parts = [];
  walk(nodes, parts, baseURL);
  let buffer = parts.join('');

  // Section 4.4.3 (space collapse) applied once more across node
  // boundaries, section 4.4.3 (leading/trailing whitespace "within each
  // block" -- a block being delimited by the \n boundaries just emitted)
  // and section 4.5's final paragraph (trim, then collapse blank lines).
  buffer = buffer.replace(/ {2,}/g, ' ');
  buffer = buffer.replace(/ +\n/g, '\n').replace(/\n +/g, '\n');
  buffer = buffer.replace(/\n{2,}/g, '\n');
  buffer = buffer.replace(/^[\n ]+/, '').replace(/[\n ]+$/, '');

  if (utf8ByteLength(buffer) > MAX_OUTPUT_BYTES) {
    fail('resource-limit-exceeded', 'canonical content exceeds 1 MiB');
  }
  return buffer;
}
