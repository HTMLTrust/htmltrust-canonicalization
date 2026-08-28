/**
 * HTMLTrust Canonical Text Normalization
 * Spec: https://github.com/HTMLTrust/htmltrust-canonicalization
 *
 * Uses parse5 for deterministic HTML parsing. Works in browsers and Node.js.
 */

import { NAMED_ENTITIES } from "./entities.js";
import * as parse5 from "parse5";

const MAX_RESOURCE_BYTES = 1024 * 1024;
const MAX_CLAIMS = 64;
const MAX_CLAIM_FIELD_BYTES = 4096;
const MAX_ELEMENT_DEPTH = 256;
const MAX_JCS_DEPTH = 256;
const MAX_REMOTE_KEY_BYTES = 64 * 1024;

function utf8Length(value) {
  return new TextEncoder().encode(value).byteLength;
}

function checkResourceBytes(value, what) {
  if (utf8Length(value) > MAX_RESOURCE_BYTES) {
    throw new Error("resource-limit-exceeded");
  }
  return value;
}

// Phase 6: Invisible/formatting characters to strip
const STRIP_RE = new RegExp(
  [
    "\\u00AD", // soft hyphen
    "\\u200B", // zero-width space
    "\\u200E", // LRM
    "\\u200F", // RLM
    "\\u2060", // word joiner
    "\\uFEFF", // BOM / ZWNBSP
    "\\u034F", // combining grapheme joiner
    "\\u061C", // arabic letter mark
    "\\u180E", // mongolian vowel separator
    "\\u0640", // arabic tatweel
    "[\\uFE00-\\uFE0F]", // variation selectors 1-16
    "[\\u202A-\\u202E]", // bidi embedding controls
    "[\\u2066-\\u2069]", // bidi isolate controls
    "[\\u2061-\\u2064]", // invisible math operators
    "[\\uFFF9-\\uFFFC]", // interlinear annotation + obj replacement
  ].join("|"),
  "gu",
);

// Supplementary plane stripping (variation selectors 17-256, tag characters)
const STRIP_SUPPLEMENTARY_RE = /[\u{E0001}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

// Phase 2: All Unicode whitespace → U+0020
const WHITESPACE_RE =
  /[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g;

// Phase 3: Quotation mark normalization
const SINGLE_QUOTE_RE = /[\u2018\u2019\u201A\u201B\u2039\u203A\u0060\u00B4\u2032]/g;
const DOUBLE_QUOTE_RE =
  /[\u201C\u201D\u201E\u201F\u00AB\u00BB\u2033\u301D\u301E\u301F]/g;
const CJK_QUOTE_RE = /[\u300C\u300D\u300E\u300F\uFE41-\uFE44]/g;

// Phase 4: Dashes → U+002D (includes minus sign from Phase 5)
const DASH_RE = /[\u2010-\u2015\u2212\uFE58\uFE63]/g;

// Phase 5: Ellipsis → three periods
const ELLIPSIS_RE = /\u2026/g;

/**
 * Normalize text content for canonical signing.
 * Apply AFTER extracting text from DOM, BEFORE hashing.
 *
 * Implements all 8 phases of the HTMLTrust canonicalization spec:
 *   1. NFKC normalization
 *   2. Whitespace normalization
 *   3. Quotation mark normalization
 *   4. Dash/hyphen normalization
 *   5. Other punctuation normalization
 *   6. Strip invisible/formatting characters
 *   7. Bidi control removal (handled by phase 6)
 *   8. Language-specific handling (NFKC + preserve ZWNJ/ZWJ)
 *
 * @param {string} text - Raw text content
 * @param {object} [options] - Options
 * @param {boolean} [options.preserveWhitespace=false] - Set true for <pre> content
 * @returns {string} Normalized text
 */
export function normalizeText(text, options = {}) {
  if (typeof text !== "string") throw new TypeError("normalizeText expects a string");
  checkResourceBytes(text, "source");
  const { preserveWhitespace = false } = options;

  // Phase 1: Unicode NFKC normalization
  // Handles ~80% of equivalences: ligatures, fullwidth/halfwidth,
  // presentation forms, superscripts, CJK compatibility, Jamo composition
  text = text.normalize("NFKC");

  // Phase 6 + 7: Strip invisible/formatting/bidi characters
  // (Done early so they don't interfere with other phases)
  // Preserves ZWNJ (U+200C) and ZWJ (U+200D) — semantic in Persian, Indic, emoji
  text = text.replace(STRIP_RE, "");
  text = text.replace(STRIP_SUPPLEMENTARY_RE, "");

  // Phase 2: Whitespace normalization
  if (!preserveWhitespace) {
    text = text.replace(WHITESPACE_RE, " ");
    text = text.replace(/ {2,}/g, " ");
  }

  // Phase 3: Quotation mark normalization
  text = text.replace(SINGLE_QUOTE_RE, "'");
  text = text.replace(DOUBLE_QUOTE_RE, '"');
  text = text.replace(CJK_QUOTE_RE, '"');

  // Phase 4: Dash and hyphen normalization
  text = text.replace(DASH_RE, "-");

  // Phase 5: Other punctuation
  text = text.replace(ELLIPSIS_RE, "...");

  checkResourceBytes(text, "output");

  return text;
}

// === HTML → canonical text extraction ===
//
// Elements whose text content is NEVER part of the signed content.
// These are either metadata (meta, link, script, style) or the signed-section
// wrapper's OWN metadata (meta tags inside a signed-section carry claims,
// not content). We strip them entirely before extracting text.
const EXCLUDED_ELEMENTS_RE =
  /<(script|style|meta|link|head|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>|<(meta|link|br|hr|img|input|source|track|wbr)\b[^>]*\/?>(?!\s*<\/\2>)/gi;

// Self-closing and void elements (no text content) to strip.
const VOID_ELEMENTS_RE = /<(meta|link|br|hr|img|input|source|track|wbr|area|base|col|embed|param)\b[^>]*\/?>/gi;

// Boundary-producing elements from the protocol draft. A boundary-producing
// element emits a line feed after its descendants have contributed text.
// Inline elements (em, strong, a, span, etc.) do NOT get separators, so
// "<p>hello <em>world</em></p>" canonicalizes to "hello world".
const BLOCK_ELEMENTS =
  "address|article|aside|blockquote|details|dialog|div|dl|fieldset|figcaption|figure|footer|form|h[1-6]|header|hgroup|hr|li|main|nav|ol|p|pre|section|table|td|th|tr|ul";

// Any remaining HTML tag (inline elements we strip without adding whitespace).
const ANY_TAG_RE = /<\/?[a-z][a-z0-9-]*\b[^>]*>/gi;
const HTML_TOKEN_RE = /<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z][^\t\n\f\r \/>]*(?:[\t\n\f\r ]+(?:[^>"']+|"[^"]*"|'[^']*')*)?\s*\/?>/gi;
const TAG_NAME_RE = /^<\/?\s*([a-z][^\t\n\f\r \/>]*)/i;
const SIGNED_ATTRS = ["href", "src", "alt", "aria-label"];
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const EXCLUDED_TAGS = new Set(["script", "style", "template", "noscript", "iframe", "head", "meta", "link"]);

// Full HTML5 named-entity table lives in ./entities.js (generated).
// Lookups are case-sensitive per the HTML Living Standard.

// windows-1252 mapping for numeric references in the C1 range (0x80-0x9F),
// per the HTML5 "numeric character reference end" state.
const C1_REPLACEMENTS = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};

function numericCharRef(n) {
  if (n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return "\uFFFD";
  if (Object.prototype.hasOwnProperty.call(C1_REPLACEMENTS, n)) {
    return String.fromCodePoint(C1_REPLACEMENTS[n]);
  }
  return String.fromCodePoint(n);
}

function decodeEntities(text) {
  // Named references (case-sensitive, semicolon-terminated).
  text = text.replace(/&[a-zA-Z][a-zA-Z0-9]*;/g, (match) =>
    Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, match)
      ? NAMED_ENTITIES[match]
      : match,
  );
  // Numeric decimal references.
  text = text.replace(/&#([0-9]+);/g, (_, code) => numericCharRef(parseInt(code, 10)));
  // Numeric hex references.
  text = text.replace(/&#[xX]([0-9a-fA-F]+);/g, (_, code) =>
    numericCharRef(parseInt(code, 16)),
  );
  return text;
}
function parseAttributes(tag) {
  const attrs = new Map();
  const body = tag.replace(/^<\/?\s*[a-z][^\t\n\f\r \/>]*/i, "").replace(/\/?\s*>$/, "");
  const attrRe = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = attrRe.exec(body))) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attrs.set(name, decodeEntities(value));
  }
  return attrs;
}

function appendPart(parts, value) {
  if (!value) return;
  parts.push(value);
}

function appendAttributeRecords(parts, elementName, attrs, baseUrl) {
  for (const attrName of SIGNED_ATTRS) {
    if (!attrs.has(attrName)) continue;
    let value = attrs.get(attrName);
    if (attrName === "href" || attrName === "src") {
      value = normalizeSafeURL(value, baseUrl, elementName, attrName);
    } else {
      value = normalizeText(value).trim();
    }
    value = value.replaceAll("@", "@@");
    if (value.includes("\n")) {
      throw new Error(`attribute-canonicalization-failed: ${elementName}.${attrName}`);
    }
    const prefix = parts.length && !/[\s\n]$/.test(parts[parts.length - 1]) ? "\n" : "";
    parts.push(`${prefix}@attr:${elementName}:${attrName}:${value}\n`);
  }
}

function normalizeSafeURL(value, baseUrl, elementName, attrName) {
  // Inspect the parser-decoded value before WHATWG URL preprocessing. URL()
  // otherwise silently strips tabs and line feeds.
  if (/[\u0000-\u001F\u007F]/u.test(value)) {
    throw new Error("url-policy-violation");
  }
  try {
    const url = new URL(value, baseUrl || undefined);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error("url-policy-violation");
    }
    return url.href;
  } catch (error) {
    if (error?.message === "url-policy-violation") throw error;
    throw new Error(`attribute-canonicalization-failed: ${elementName}.${attrName}`);
  }
}

function finalizeCanonicalParts(parts) {
  return parts
    .join("")
    .replace(/ {2,}/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * Extract canonical text from an HTML fragment for signing or verification.
 *
 * This is the HTML → canonical text extraction defined in the HTMLTrust
 * specification §2.1. Given an HTML fragment (typically the inner contents
 * of a `<signed-section>` element), it:
 *
 *   1. Strips excluded elements (script, style, meta, link, head, noscript)
 *      and their contents. `<meta>` is excluded because inside a signed-section
 *      it carries claim metadata, not signed content.
 *   2. Emits signed semantic attribute records for href, src, alt, and
 *      aria-label.
 *   3. Converts boundary-producing elements and br to line feeds so that
 *      `<p>A</p><p>B</p>` canonicalizes to `A\nB`, not `AB`.
 *   4. Strips remaining inline markup while preserving text content.
 *   5. Decodes HTML entities.
 *   6. Applies the full text normalization pipeline (`normalizeText`).
 *
 * The fragment is parsed with parse5, then walked as a DOM. A portable-profile
 * validation pass rejects parser recovery and unsupported input before the
 * parsed tree is traversed, so the same input produces the same result across
 * bindings.
 *
 * @param {string} html - HTML fragment to canonicalize
 * @param {object} [options] - Options passed through to normalizeText
 * @returns {string} Canonical text, ready to be hashed
 */
export function extractCanonicalText(html, options = {}) {
  if (typeof html !== "string") {
    throw new TypeError("extractCanonicalText expects a string");
  }
  checkResourceBytes(html, "source");
  const fragment = parseHTMLFragment(html);
  const baseUrl = validateBaseURL(options.baseUrl);
  const parts = [];
  walkParsedNode(fragment, parts, baseUrl, options);
  const result = finalizeCanonicalParts(parts);
  checkResourceBytes(result, "output");
  return result;
}

function parseHTMLFragment(html) {
  validatePortableSource(html);
  const errors = [];
  const fragment = parse5.parseFragment(html, {
    sourceCodeLocationInfo: true,
    onParseError(error) { errors.push(error); },
  });
  if (errors.length) throw new Error("parser-profile-unsupported");
  return fragment;
}

function validatePortableSource(source) {
  // parse5 recovers misnesting and foster parenting without emitting a parse
  // diagnostic, so these source-level checks complement its tokenizer.
  const stack = [];
  let index = 0;
  for (const match of source.matchAll(HTML_TOKEN_RE)) {
    const text = source.slice(index, match.index);
    // script, style, and iframe are raw-text/escapable-raw-text elements.
    // Their bodies are excluded from canonical content, so references there
    // must not affect the portable-profile validation of the surrounding
    // document.
    if (!isRawTextElement(stack.at(-1))) validatePortableReferences(text);
    if (stack.at(-1) === "table" && text.trim()) throw new Error("parser-profile-unsupported");
    index = match.index + match[0].length;
    const token = match[0];
    if (token.startsWith("<!--")) {
      // HTML comments cannot contain a double hyphen, including one hidden
      // in the comment body before the closing delimiter.
      const comment = token.slice(4, -3);
      if (!isRawTextElement(stack.at(-1)) && (comment.includes("--") || comment.endsWith("-"))) {
        throw new Error("parser-profile-unsupported");
      }
      continue;
    }
    const nameMatch = TAG_NAME_RE.exec(token);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase();
    if (isRawTextElement(stack.at(-1)) && !(token.startsWith("</") && name === stack.at(-1))) continue;
    validatePortableReferences(token);
    if (name === "svg" || name === "math" || name === "foreignobject") throw new Error("parser-profile-unsupported");
    if (/^<\//.test(token)) {
      if (stack.at(-1) !== name) throw new Error("parser-profile-unsupported");
      stack.pop();
      continue;
    }
    const attrs = parseAttributesWithDuplicateCheck(token);
    if (!VOID_TAGS.has(name) && !/\/\s*>$/.test(token)) {
      stack.push(name);
      if (stack.length > MAX_ELEMENT_DEPTH) throw new Error("resource-limit-exceeded");
    }
    void attrs;
  }
  const trailing = source.slice(index);
  if (!isRawTextElement(stack.at(-1))) validatePortableReferences(trailing);
  if (stack.at(-1) === "table" && trailing.trim()) throw new Error("parser-profile-unsupported");
  if (stack.length) throw new Error("parser-profile-unsupported");
}

function isRawTextElement(name) {
  return name === "script" || name === "style" || name === "iframe";
}

function validatePortableReferences(source) {
  for (const match of source.matchAll(/&[A-Za-z][A-Za-z0-9]*;/g)) {
    if (!Object.hasOwn(NAMED_ENTITIES, match[0])) throw new Error("parser-profile-unsupported");
  }
  if (/&[A-Za-z][A-Za-z0-9]*(?:$|[^A-Za-z0-9;])/u.test(source)) {
    throw new Error("parser-profile-unsupported");
  }
}

function parseAttributesWithDuplicateCheck(tag) {
  const attrs = new Set();
  const body = tag.replace(/^<\/?\s*[a-z][^\t\n\f\r \/>]*/i, "").replace(/\/?\s*>$/, "");
  const attrRe = /([^\s"'<>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
  for (const match of body.matchAll(attrRe)) {
    const name = match[1].toLowerCase();
    if (attrs.has(name)) throw new Error("parser-profile-unsupported");
    attrs.add(name);
  }
  return attrs;
}

function validateBaseURL(raw) {
  if (raw == null || raw === "") return undefined;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("attribute-canonicalization-failed");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("url-policy-violation");
  }
  return url.href;
}

function parsedAttributes(node) {
  const attrs = new Map();
  for (const attr of node.attrs || []) attrs.set(attr.name.toLowerCase(), attr.value);
  return attrs;
}

function walkParsedNode(node, parts, baseUrl, options) {
  for (const child of node.childNodes || []) {
    if (child.nodeName === "#text") {
      appendPart(parts, normalizeText(child.value, options).replaceAll("@", "@@"));
      continue;
    }
    if (child.nodeName === "#comment" || child.nodeName === "#documentType") continue;
    const name = String(child.tagName || child.nodeName || "").toLowerCase();
    if (!name || EXCLUDED_TAGS.has(name)) continue;
    appendAttributeRecords(parts, name, parsedAttributes(child), baseUrl);
    if (name === "br") {
      appendPart(parts, "\n");
    } else {
      walkParsedNode(child, parts, baseUrl, options);
      if (new RegExp(`^(${BLOCK_ELEMENTS}|signed-section)$`, "i").test(name)) appendPart(parts, "\n");
    }
  }
}

/**
 * Compute a canonical claims hash from a list of claim entries.
 *
 * Claims are serialized as a sorted list of "name:content" pairs, joined by
 * newlines, then hashed. Sorting ensures the order of <meta> elements in
 * the HTML source does not affect the hash. The caller is responsible for
 * computing the actual hash from the returned canonical string.
 *
 * @param {Record<string, string>} claims - claim name → value map
 * @returns {string} Canonical serialized string ready to be hashed
 */
// Compare two strings by Unicode code point, which is the same ordering as
// their UTF-8 byte sequences. JS string comparison uses UTF-16 code units,
// which mis-orders supplementary-plane characters relative to high-BMP ones.
function compareByCodePoint(a, b) {
  const ai = Array.from(a);
  const bi = Array.from(b);
  const n = Math.min(ai.length, bi.length);
  for (let i = 0; i < n; i++) {
    const ca = ai[i].codePointAt(0);
    const cb = bi[i].codePointAt(0);
    if (ca !== cb) return ca - cb;
  }
  return ai.length - bi.length;
}

export function canonicalizeClaims(claims) {
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) throw new TypeError("canonicalizeClaims expects an object");
  if (Object.keys(claims).length > MAX_CLAIMS) throw new Error("resource-limit-exceeded");
  const seen = new Set();
  const entries = Object.entries(claims)
    .map(([name, value]) => {
      if (typeof value !== "string") throw new Error("claim-malformed");
      return [normalizeText(name).trim(), normalizeText(value).trim()];
    })
    .map(([name, value]) => {
      if (!name) throw new Error("claim-malformed");
      if (seen.has(name)) throw new Error(`claim-duplicate: ${name}`);
      if (utf8Length(name) > MAX_CLAIM_FIELD_BYTES || utf8Length(value) > MAX_CLAIM_FIELD_BYTES) throw new Error("resource-limit-exceeded");
      seen.add(name);
      return [name, value];
    })
    // Sort by Unicode code point (== UTF-8 byte order), NOT by JS's default
    // UTF-16 code-unit comparison, so astral/high-BMP names order identically
    // to the other bindings (draft §4.6).
    .sort(([a], [b]) => compareByCodePoint(a, b));
  const escape = (value) => value.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("\n", "\\n");
  const result = entries.map(([name, value]) => `${escape(name)}:${escape(value)}\n`).join("");
  checkResourceBytes(result, "output");
  return result;
}

/**
 * Extract direct child `<meta name content>` claims from a signed-section.
 * If `html` contains a `<signed-section>`, the first such element is used;
 * otherwise `html` is treated as the signed-section's inner HTML fragment.
 *
 * Duplicate normalized names, missing name/content, and empty normalized names
 * throw spec-style claim failures.
 */
export function extractClaimsFromSignedSection(html) {
  if (typeof html !== "string") {
    throw new TypeError("extractClaimsFromSignedSection expects a string");
  }

  checkResourceBytes(html, "source");
  const fragment = parseHTMLFragment(html);
  let section = fragment;
  for (const node of fragment.childNodes || []) {
    if (node.tagName?.toLowerCase() === "signed-section") { section = node; break; }
  }
  const claims = {};
  const seen = new Set();
  for (const child of section.childNodes || []) {
    if (child.tagName?.toLowerCase() === "meta") {
      const attrs = parsedAttributes(child);
      if (!attrs.has("name") || !attrs.has("content")) throw new Error("claim-malformed");
      const claimName = normalizeText(attrs.get("name")).trim();
      const content = normalizeText(attrs.get("content")).trim();
      if (!claimName) throw new Error("claim-malformed");
      if (seen.has(claimName)) throw new Error(`claim-duplicate: ${claimName}`);
      if (seen.size >= MAX_CLAIMS || utf8Length(claimName) > MAX_CLAIM_FIELD_BYTES || utf8Length(content) > MAX_CLAIM_FIELD_BYTES) throw new Error("resource-limit-exceeded");
      seen.add(claimName);
      claims[claimName] = content;
    }
  }
  return claims;
}

// === Signature binding (spec §2.1) ===

/**
 * Build the legacy 0.2 signature binding string:
 *   {content-hash}:{claims-hash}:{domain}:{signed-at}
 *
 * The signer's identity is intentionally NOT included; it is implicit in
 * keyid resolution. Throws if any field is missing.
 *
 * @param {object} parts
 * @param {string} parts.contentHash - prefixed canonical content hash (e.g. "sha256:...")
 * @param {string} parts.claimsHash  - prefixed canonical claims hash
 * @param {string} parts.domain      - serialized publication origin (`scheme://host[:port]`)
 * @param {string} parts.signedAt    - ISO-8601 timestamp from <meta name="signed-at">
 * @returns {string}
 */
export function buildSignatureBinding({ contentHash, claimsHash, domain, signedAt }) {
  if (!contentHash || !claimsHash || !domain || !signedAt) {
    throw new Error(
      `buildSignatureBinding: missing field(s): contentHash=${contentHash}, claimsHash=${claimsHash}, domain=${domain}, signedAt=${signedAt}`,
    );
  }
  validateSerializedOrigin(domain);
  return `${contentHash}:${claimsHash}:${domain}:${signedAt}`;
}

export const SIGNING_PROFILE_V1 = Object.freeze({
  profile: "htmltrust-signature-v1",
  canonicalizationProfile: "htmltrust-c14n-v1",
  attributeProfile: "htmltrust-attrs-v1",
  urlProfile: "htmltrust-safe-url-v1",
  context: "https://htmltrust.org/protocol/signed-section",
});

export function deriveSigningLocationV1(documentURL, scope) {
  let url;
  try {
    url = new URL(documentURL);
  } catch {
    throw new Error("origin-not-supported");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("origin-not-supported");
  }
  if (scope === "origin") return url.origin;
  if (scope !== "url") throw new Error("scope-unsupported");
  url.hash = "";
  return url.href;
}

export function validateSignedAtV1(value) {
  if (typeof value !== "string" || !/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\dZ$/.test(value)) {
    throw new Error("timestamp-invalid");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().replace(".000Z", "Z") !== value) {
    throw new Error("timestamp-invalid");
  }
  return value;
}

/** Build the RFC 8785 signing payload fixed by htmltrust-signature-v1. */
export function buildSigningPayloadV1({
  contentHash,
  claimsHash,
  documentURL,
  scope,
  keyid,
  algorithm,
  signedAt,
}) {
  for (const [name, value] of Object.entries({ contentHash, claimsHash, documentURL, scope, keyid, algorithm, signedAt })) {
    if (typeof value !== "string" || value === "" || value.trim() !== value) {
      throw new Error(`signing-object-invalid: ${name}`);
    }
  }
  validateSignedAtV1(signedAt);
  return canonicalizeJson({
    algorithm,
    attributeProfile: SIGNING_PROFILE_V1.attributeProfile,
    canonicalizationProfile: SIGNING_PROFILE_V1.canonicalizationProfile,
    claimsHash,
    contentHash,
    context: SIGNING_PROFILE_V1.context,
    keyid,
    location: deriveSigningLocationV1(documentURL, scope),
    profile: SIGNING_PROFILE_V1.profile,
    scope,
    signedAt,
    urlProfile: SIGNING_PROFILE_V1.urlProfile,
  });
}

export function validateSerializedOrigin(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("domain must be a serialized Web origin");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("domain must be a serialized Web origin");
  }
  if (url.origin !== origin) {
    throw new Error(`domain must use canonical serialized origin form: ${url.origin}`);
  }
  return origin;
}

// === Crypto utilities (cross-environment) ===
//
// Runs in browsers (SubtleCrypto) and Node (node:crypto.webcrypto +
// node:crypto for PEM parsing). We prefer SubtleCrypto when available so
// the same code path runs in both environments.

let _nodeCrypto;
async function getNodeCrypto() {
  if (_nodeCrypto !== undefined) return _nodeCrypto;
  try {
    _nodeCrypto = await import("node:crypto");
  } catch {
    _nodeCrypto = null;
  }
  return _nodeCrypto;
}

function isNodeEnv() {
  return typeof process !== "undefined" && !!process.versions?.node;
}

export function encodeBase64Unpadded(bytes) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64").replace(/=+$/g, "");
  }
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/=+$/g, "");
}

export function decodeCanonicalBase64(b64) {
  const input = String(b64);
  if (!/^[A-Za-z0-9+/]*$/.test(input) || input.length % 4 === 1) {
    throw new Error("non-canonical base64");
  }
  const bytes = base64ToBytesFlexible(input);
  if (encodeBase64Unpadded(bytes) !== input) {
    throw new Error("non-canonical base64");
  }
  return bytes;
}

function base64ToBytesFlexible(b64) {
  const cleaned = String(b64).replace(/\s+/g, "");
  const padded = cleaned + "===".slice((cleaned.length + 3) % 4);
  if (typeof atob === "function") {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Node fallback
  return new Uint8Array(Buffer.from(padded, "base64"));
}

function base64ToBytes(b64) {
  return decodeCanonicalBase64(b64);
}

function utf8ToBytes(str) {
  return new TextEncoder().encode(str);
}

// Registry identifiers from spec §7.1, plus the two legacy generic spellings
// ("ecdsa", "rsa") this library shipped with. The generic spellings name an
// algorithm family and leave the parameter set to the key; the registry
// identifiers pin curve and hash.
const ALGO_ALIASES = {
  ED25519: "ed25519",
  ECDSA: "ecdsa",
  ECDSAP256: "ecdsa-p256",
  "ECDSA-P256": "ecdsa-p256",
  "ECDSA-P384": "ecdsa-p384",
  RSA: "rsa",
  "RSA-SHA256": "rsa-pkcs1-sha256",
  "RSA-PKCS1-SHA256": "rsa-pkcs1-sha256",
  "RSA-PSS-SHA256": "rsa-pss-sha256",
};
function normalizeAlgo(algorithm) {
  const key = String(algorithm || "ed25519").toUpperCase();
  return ALGO_ALIASES[key] ?? key.toLowerCase();
}

// OpenSSL/Node curve spellings accepted for each pinned ECDSA identifier.
const EC_CURVES = {
  "ecdsa-p256": ["prime256v1", "secp256r1", "p-256"],
  "ecdsa-p384": ["secp384r1", "p-384"],
};
const EC_PARAMS = {
  "ecdsa-p256": { nodeHash: "sha256", curve: "P-256", hash: "SHA-256" },
  "ecdsa-p384": { nodeHash: "sha384", curve: "P-384", hash: "SHA-384" },
};

/**
 * Verify a signature over `message` with `publicKeyPem` using `algorithm`.
 *
 * Algorithms supported (spec §7.1): "ed25519", "ecdsa-p256", "ecdsa-p384",
 * "rsa-pss-sha256", "rsa-pkcs1-sha256". The legacy spellings "ecdsa" (SHA-256,
 * curve taken from the key, which is how the reference server's secp256k1 keys
 * verify) and "rsa" (= rsa-pkcs1-sha256) remain accepted. Anything else fails
 * closed. Algorithm names are case-insensitive. Signature is canonical
 * unpadded standard Base64. Public key is a PEM-encoded SPKI document.
 *
 * For the pinned ECDSA identifiers the key's curve MUST match the identifier;
 * a P-384 key does not verify an "ecdsa-p256" signature and vice versa.
 *
 * Uses Node's native crypto when running in Node (broadest algorithm
 * support, including the secp256k1 curve used by the reference server),
 * and falls back to SubtleCrypto in browsers.
 *
 * @param {string} message
 * @param {string} signatureB64
 * @param {string} publicKeyPem
 * @param {string} algorithm
 * @returns {Promise<boolean>}
 */
export async function verifySignature(message, signatureB64, publicKeyPem, algorithm = "ed25519") {
  const algo = normalizeAlgo(algorithm);
  let sigBytes;
  try {
    sigBytes = base64ToBytes(signatureB64);
  } catch {
    return false;
  }
  const msgBytes = utf8ToBytes(message);

  const node = isNodeEnv() ? await getNodeCrypto() : null;
  if (node) {
    try {
      const publicKey = node.createPublicKey(publicKeyPem);
      const keyType = publicKey.asymmetricKeyType;
      const msg = Buffer.from(msgBytes);
      const sig = Buffer.from(sigBytes);
      if (algo === "ed25519") {
        if (keyType !== "ed25519") return false;
        return node.verify(null, msg, publicKey, sig);
      }
      if (algo === "ecdsa") {
        // Legacy generic identifier: the curve comes from the key.
        if (keyType !== "ec") return false;
        return node.verify("sha256", msg, publicKey, sig);
      }
      if (algo === "ecdsa-p256" || algo === "ecdsa-p384") {
        if (keyType !== "ec") return false;
        const curve = String(publicKey.asymmetricKeyDetails?.namedCurve || "").toLowerCase();
        if (!EC_CURVES[algo].includes(curve)) return false;
        return node.verify(
          EC_PARAMS[algo].nodeHash,
          msg,
          { key: publicKey, dsaEncoding: "ieee-p1363" },
          sig,
        );
      }
      if (algo === "rsa" || algo === "rsa-pkcs1-sha256") {
        if (keyType !== "rsa") return false;
        return node.verify("RSA-SHA256", msg, publicKey, sig);
      }
      if (algo === "rsa-pss-sha256") {
        if (keyType !== "rsa" && keyType !== "rsa-pss") return false;
        return node.verify(
          "sha256",
          msg,
          {
            key: publicKey,
            padding: node.constants.RSA_PKCS1_PSS_PADDING,
            saltLength: 32,
          },
          sig,
        );
      }
      return false;
    } catch {
      return false;
    }
  }

  // Browser path: SubtleCrypto via JWK import. We use jose-style import
  // because SubtleCrypto cannot ingest PEM directly; we strip headers and
  // base64-decode the SPKI bytes.
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return false;
  try {
    const spki = pemToBytes(publicKeyPem);
    let key, params;
    if (algo === "ed25519") {
      key = await subtle.importKey("spki", spki, { name: "Ed25519" }, false, ["verify"]);
      params = { name: "Ed25519" };
    } else if (algo === "ecdsa" || algo === "ecdsa-p256" || algo === "ecdsa-p384") {
      // SubtleCrypto has no "curve from the key" mode, so the legacy generic
      // "ecdsa" identifier resolves to P-256 here. importKey rejects a key on
      // any other curve, so a mismatched key fails closed.
      const ec = EC_PARAMS[algo] ?? EC_PARAMS["ecdsa-p256"];
      key = await subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: ec.curve }, false, ["verify"]);
      params = { name: "ECDSA", hash: ec.hash };
    } else if (algo === "rsa" || algo === "rsa-pkcs1-sha256") {
      key = await subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      params = { name: "RSASSA-PKCS1-v1_5" };
    } else if (algo === "rsa-pss-sha256") {
      key = await subtle.importKey("spki", spki, { name: "RSA-PSS", hash: "SHA-256" }, false, ["verify"]);
      params = { name: "RSA-PSS", saltLength: 32 };
    } else {
      return false;
    }
    return await subtle.verify(params, key, sigBytes, msgBytes);
  } catch {
    return false;
  }
}

function pemToBytes(pem) {
  const body = String(pem)
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  return base64ToBytesFlexible(body);
}

function spkiBase64ToPem(value) {
  const bytes = decodeCanonicalBase64(value);
  const encoded = encodeBase64Unpadded(bytes);
  const padded = encoded + "===".slice((encoded.length + 3) % 4);
  const lines = padded.match(/.{1,64}/g) || [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
}

function pemFromKeyDocument(document) {
  if (!document || typeof document !== "object") return null;
  if (typeof document.publicKeyPem === "string" && document.publicKeyPem.includes("BEGIN PUBLIC KEY")) {
    return document.publicKeyPem;
  }
  if (typeof document.publicKey === "string") {
    if (document.publicKey.includes("BEGIN PUBLIC KEY")) return document.publicKey;
    if (document.publicKeyEncoding === "spki-der") return spkiBase64ToPem(document.publicKey);
  }
  if (typeof document.key === "string" && document.key.includes("BEGIN PUBLIC KEY")) {
    return document.key;
  }
  return null;
}

// === Keyid resolution (spec §2.2) ===
//
// Three pluggable resolvers. None is privileged; callers compose them in
// whatever order their implementation prefers. resolveKey() walks the chain
// and returns the first match.

/**
 * @typedef {Object} ResolvedKey
 * @property {string} keyid
 * @property {string} publicKeyPem
 * @property {string} algorithm
 * @property {boolean} [revoked] `revoked: true` from the key document (spec §8.2).
 * @property {string} [expires] RFC3339 expiry from the key document (spec §8.2).
 */

/**
 * Spec §8.2: a `revoked` value of true, or an `expires` value in the past, MUST
 * be treated as a "key-revoked" verification failure, and the verifier MUST NOT
 * proceed to signature verification. Unparseable `expires` values are treated as
 * revoked so a malformed directory response cannot buy a key extra life.
 *
 * @param {{ revoked?: boolean, expires?: string } | null | undefined} key
 * @param {number} [now]
 * @returns {boolean}
 */
export function isKeyRevoked(key, now = Date.now()) {
  if (!key) return false;
  if (key.revoked === true) return true;
  if (key.expires === undefined || key.expires === null || key.expires === "") return false;
  if (typeof key.expires !== "string") return true;
  const expiresAt = parseStrictLifecycleExpiry(key.expires);
  return expiresAt === null || expiresAt <= now;
}

function parseStrictLifecycleExpiry(value) {
  const match = /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z$/u.exec(value);
  if (!match) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19)) {
    return null;
  }
  return parsed.getTime();
}

/** Read the optional `revoked`/`expires` fields of a key document (spec §8.2). */
function keyLifecycleFields(doc) {
  const out = {};
  if (typeof doc?.revoked === "boolean") out.revoked = doc.revoked;
  if (typeof doc?.expires === "string" && doc.expires !== "") out.expires = doc.expires;
  return out;
}

/**
 * @typedef {Object} KeyResolver
 * @property {(keyid: string) => Promise<ResolvedKey | null>} resolve
 *   Returns null if this resolver doesn't apply to the given keyid.
 */

async function fetchJson(url, fetchImpl) {
  const f = fetchImpl ?? globalThis.fetch;
  if (!f) throw new Error("no fetch implementation available");
  const res = await f(url);
  if (!res.ok) return null;
  const contentLength = Number.parseInt(res.headers.get?.("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_REMOTE_KEY_BYTES) {
    throw new Error("resource-limit-exceeded");
  }
  const ct = res.headers.get?.("content-type") ?? "";
  const mediaType = ct.split(";", 1)[0].trim().toLowerCase();
  const body = await readResponseBodyLimited(res);
  if (mediaType === "application/json" || mediaType.endsWith("+json")) {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  // Treat as raw PEM if content-type is text-ish.
  return { _rawText: body };
}

async function readResponseBodyLimited(response) {
  const reader = response.body?.getReader?.();
  if (reader) {
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw new Error("invalid response body");
        total += value.byteLength;
        if (total > MAX_REMOTE_KEY_BYTES) {
          await reader.cancel();
          throw new Error("resource-limit-exceeded");
        }
        chunks.push(value);
      }
    } catch (error) {
      try { await reader.cancel(); } catch { /* already closed */ }
      throw error;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("invalid response body");
    }
  }

  // A few fetch-compatible shims omit ReadableStream. Keep a length guard for
  // those shims, while real fetch responses use the bounded streaming path.
  if (typeof response.arrayBuffer === "function") {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_REMOTE_KEY_BYTES) throw new Error("resource-limit-exceeded");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  if (typeof response.text === "function") {
    const text = await response.text();
    if (utf8Length(text) > MAX_REMOTE_KEY_BYTES) throw new Error("resource-limit-exceeded");
    return text;
  }
  throw new Error("invalid response body");
}

/**
 * Build a did:web resolver. Resolves keyids of the form `did:web:<host>[:<path>]`
 * by fetching `https://<host>/.well-known/did.json` and extracting the
 * first verificationMethod with a publicKeyPem field.
 *
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetch]
 * @returns {KeyResolver}
 */
export function didWebResolver(opts = {}) {
  return {
    async resolve(keyid) {
      if (!keyid?.startsWith("did:web:")) return null;
      // A DID URL fragment identifies a resource in the DID document. It is
      // never part of the URL used to retrieve that document.
      const rest = keyid.slice("did:web:".length).split(/[/?#]/u, 1)[0];
      const [host, ...pathParts] = rest.split(":");
      const url = didWebDocumentURL(host, pathParts);
      const doc = await fetchJson(url, opts.fetch);
      if (!doc || doc._rawText) return null;
      if (doc.deactivated === true) return null;
      // Spec §8.1: an expired or revoked verification method is a DID
      // resolution failure, so skip it rather than hand it back to the caller.
      const vm = (doc.verificationMethod || []).find(
        (m) => m.publicKeyPem && !isKeyRevoked(m),
      );
      if (!vm) return null;
      return {
        keyid,
        publicKeyPem: vm.publicKeyPem,
        algorithm: vm.algorithm || vmTypeToAlgo(vm.type) || "ed25519",
        ...keyLifecycleFields(vm),
      };
    },
  };
}

function didWebDocumentURL(host, pathParts) {
  // did:web encodes the authority port colon as %3A so it cannot be
  // confused with the colon-delimited path segments.
  const authorityHost = host.replace(/%3a/gi, ":");
  if (authorityHost.includes("%")) throw new Error("did:web invalid domain");
  let authority;
  try {
    authority = new URL(`https://${authorityHost}`);
  } catch {
    throw new Error("did:web invalid domain");
  }
  if (authorityHost.includes("@") || authority.username || authority.password || authority.pathname !== "/" || authority.search || authority.hash) {
    throw new Error("did:web invalid domain");
  }
  if (!pathParts.length) return `https://${authority.host}/.well-known/did.json`;
  const path = pathParts.map(encodeDidWebPathPart).join("/");
  return `https://${authority.host}/${path}/did.json`;
}

function encodeDidWebPathPart(part) {
  if (!part || /%(?![0-9a-f]{2})/iu.test(part)) throw new Error("did:web invalid path");
  return encodeURIComponent(part).replace(/%25([0-9a-f]{2})/giu, "%$1");
}

function vmTypeToAlgo(type) {
  if (!type) return null;
  const t = type.toLowerCase();
  if (t.includes("ed25519")) return "ed25519";
  if (t.includes("ecdsa") || t.includes("secp256")) return "ecdsa";
  if (t.includes("rsa")) return "rsa";
  return null;
}

/**
 * Build a direct-URL resolver. Resolves any keyid that is itself an http(s) URL
 * by fetching it and parsing as JSON `{ publicKey | publicKeyPem, algorithm }`
 * or as raw PEM if the response is plain text.
 *
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetch]
 * @returns {KeyResolver}
 */
export function directUrlResolver(opts = {}) {
  return {
    async resolve(keyid) {
      if (!/^https?:\/\//i.test(keyid)) return null;
      const data = await fetchJson(keyid, opts.fetch);
      if (!data) return null;
      if (data._rawText) {
        return { keyid, publicKeyPem: data._rawText.trim(), algorithm: "ed25519" };
      }
      const pem = pemFromKeyDocument(data);
      if (!pem) return null;
      return {
        keyid,
        publicKeyPem: pem,
        algorithm: data.algorithm || "ed25519",
        ...keyLifecycleFields(data),
      };
    },
  };
}

/**
 * Build a trust-directory resolver. Tries each base URL in order; for each,
 * fetches `<base>/keys/<encoded-keyid>` and expects the same JSON shape as
 * directUrlResolver. Falls back across base URLs if any one fails.
 *
 * @param {object} opts
 * @param {string[]} opts.baseUrls
 * @param {typeof fetch} [opts.fetch]
 * @returns {KeyResolver}
 */
export function trustDirectoryResolver(opts) {
  const baseUrls = opts?.baseUrls ?? [];
  return {
    async resolve(keyid) {
      if (!keyid) return null;
      for (const base of baseUrls) {
        const url = `${base.replace(/\/$/, "")}/keys/${encodeURIComponent(keyid)}`;
        try {
          const data = await fetchJson(url, opts.fetch);
          if (!data) continue;
          if (data._rawText) {
            return { keyid, publicKeyPem: data._rawText.trim(), algorithm: "ed25519" };
          }
          const pem = pemFromKeyDocument(data);
          if (!pem) continue;
          return {
            keyid,
            publicKeyPem: pem,
            algorithm: data.algorithm || "ed25519",
            ...keyLifecycleFields(data),
          };
        } catch {
          // try next base
        }
      }
      return null;
    },
  };
}

/**
 * Walk a resolver chain and return the first successful resolution.
 *
 * @param {string} keyid
 * @param {KeyResolver[]} resolvers
 * @returns {Promise<ResolvedKey | null>}
 */
export async function resolveKey(keyid, resolvers) {
  for (const r of resolvers || []) {
    const result = await r.resolve(keyid);
    if (result) return result;
  }
  return null;
}

// === Endorsements (spec §2.5) ===

/**
 * Build the canonical JSON signing payload for an endorsement. The payload is
 * deterministic JSON with object keys sorted lexically and `signature` omitted.
 *
 * @param {{ endorsement: string, timestamp: string }} e
 * @returns {string}
 */
export function buildEndorsementBinding(e) {
  for (const field of ["endorser", "endorsement", "algorithm", "timestamp"]) {
    if (typeof e?.[field] !== "string" || e[field].length === 0) {
      throw new Error(`buildEndorsementBinding: missing ${field}`);
    }
  }
  const { signature, ...unsigned } = e;
  return canonicalizeJson(unsigned);
}

function assertUnicodeScalarString(value) {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(i + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) throw new Error("jcs-invalid-surrogate");
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error("jcs-invalid-surrogate");
    }
  }
}

function serializeJcs(value, depth = 0) {
  if (value === null) return "null";
  if (typeof value === "string") {
    assertUnicodeScalarString(value);
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_JCS_DEPTH) throw new Error("resource-limit-exceeded");
    return `[${value.map((item) => serializeJcs(item, depth + 1)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    if (depth >= MAX_JCS_DEPTH) throw new Error("resource-limit-exceeded");
    const keys = Object.keys(value).sort(); // RFC 8785 uses UTF-16 code units.
    return `{${keys.map((key) => {
      assertUnicodeScalarString(key);
      if (value[key] === undefined) throw new Error("unsupported JSON value: undefined");
      return `${JSON.stringify(key)}:${serializeJcs(value[key], depth + 1)}`;
    }).join(",")}}`;
  }
  throw new Error(`unsupported JSON value: ${typeof value}`);
}

export function canonicalizeJson(value) {
  return serializeJcs(value);
}

// A small strict JSON parser is used for raw documents. JSON.parse is unable
// to report duplicate member names and accepts lone surrogate escapes, both
// of which are forbidden by RFC 8785/I-JSON.
class StrictJsonParser {
  constructor(source) { this.source = source; this.index = 0; }
  fail() { throw new Error("invalid JSON document"); }
  ws() { while (this.index < this.source.length && " \t\r\n".includes(this.source[this.index])) this.index++; }
  value(depth = 0) {
    this.ws();
    const c = this.source[this.index];
    if (c === '"') return this.string();
    if (c === "{") return this.object(depth);
    if (c === "[") return this.array(depth);
    if (this.source.startsWith("true", this.index)) { this.index += 4; return true; }
    if (this.source.startsWith("false", this.index)) { this.index += 5; return false; }
    if (this.source.startsWith("null", this.index)) { this.index += 4; return null; }
    const match = this.source.slice(this.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) this.fail();
    const raw = match[0];
    const number = Number(raw);
    if (!Number.isFinite(number)) throw new Error("jcs-number");
    this.index += raw.length;
    return number;
  }
  string() {
    if (this.source[this.index++] !== '"') this.fail();
    let out = "";
    while (this.index < this.source.length) {
      const c = this.source[this.index++];
      if (c === '"') { assertUnicodeScalarString(out); return out; }
      if (c === "\\") {
        if (this.index >= this.source.length) this.fail();
        const e = this.source[this.index++];
        const escapes = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (Object.hasOwn(escapes, e)) { out += escapes[e]; continue; }
        if (e !== "u" || this.index + 4 > this.source.length) this.fail();
        const hex = this.source.slice(this.index, this.index + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail();
        const unit = parseInt(hex, 16); this.index += 4;
        if (unit >= 0xd800 && unit <= 0xdbff) {
          if (this.source.slice(this.index, this.index + 2) !== "\\u" || !/^[0-9a-fA-F]{4}$/.test(this.source.slice(this.index + 2, this.index + 6))) throw new Error("jcs-invalid-surrogate");
          const low = parseInt(this.source.slice(this.index + 2, this.index + 6), 16);
          if (low < 0xdc00 || low > 0xdfff) throw new Error("jcs-invalid-surrogate");
          out += String.fromCodePoint(0x10000 + ((unit - 0xd800) << 10) + low - 0xdc00); this.index += 6;
        } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error("jcs-invalid-surrogate");
        else out += String.fromCharCode(unit);
        continue;
      }
      if (c.charCodeAt(0) < 0x20) this.fail();
      out += c;
    }
    this.fail();
  }
  array(depth) {
    if (depth >= MAX_JCS_DEPTH) throw new Error("resource-limit-exceeded");
    this.index++; const out = []; this.ws();
    if (this.source[this.index] === "]") { this.index++; return out; }
    while (true) {
      out.push(this.value(depth + 1)); this.ws();
      if (this.source[this.index] === "]") { this.index++; return out; }
      if (this.source[this.index++] !== ",") this.fail();
    }
  }
  object(depth) {
    if (depth >= MAX_JCS_DEPTH) throw new Error("resource-limit-exceeded");
    this.index++; const out = Object.create(null); const seen = new Set(); this.ws();
    if (this.source[this.index] === "}") { this.index++; return out; }
    while (true) {
      this.ws(); if (this.source[this.index] !== '"') this.fail();
      const key = this.string(); if (seen.has(key)) throw new Error("jcs-duplicate-key"); seen.add(key);
      this.ws(); if (this.source[this.index++] !== ":") this.fail();
      out[key] = this.value(depth + 1); this.ws();
      if (this.source[this.index] === "}") { this.index++; return out; }
      if (this.source[this.index++] !== ",") this.fail();
    }
  }
  parse() { const result = this.value(); this.ws(); if (this.index !== this.source.length) this.fail(); return result; }
}

export function canonicalizeJsonDocument(document) {
  if (typeof document !== "string") throw new TypeError("canonicalizeJsonDocument expects a string");
  checkResourceBytes(document, "source");
  let result;
  try {
    assertUnicodeScalarString(document);
    result = serializeJcs(new StrictJsonParser(document).parse());
  } catch (error) {
    if (error?.message === "resource-limit-exceeded" || error?.message === "jcs-invalid-surrogate" || error?.message === "jcs-duplicate-key" || error?.message === "jcs-number") throw error;
    throw new Error("jcs-invalid-json");
  }
  checkResourceBytes(result, "output");
  return result;
}

/**
 * Verify a content endorsement (spec §2.5). The endorsement is a standalone
 * signed JSON blob attesting that `endorser` endorses the content identified
 * by `endorsement` (a content-hash) at `timestamp`. Returns true only if the
 * endorser's key resolves AND the signature verifies.
 *
 * @param {{
 *   endorser: string,
 *   endorsement: string,
 *   signature: string,
 *   timestamp: string,
 *   algorithm: string,
 * }} endorsement
 * @param {KeyResolver[]} resolvers
 * @returns {Promise<boolean>}
 */
export async function verifyEndorsement(endorsement, resolvers) {
  if (!endorsement) return false;
  if (!endorsementLifecycleIsValid(endorsement)) return false;
  const resolved = await resolveKey(endorsement.endorser, resolvers);
  if (!resolved) return false;
  if (isKeyRevoked(resolved)) return false;
  if (!endorsement.signature) return false;
  let binding;
  try {
    binding = buildEndorsementBinding(endorsement);
  } catch {
    return false;
  }
  return await verifySignature(
    binding,
    endorsement.signature,
    resolved.publicKeyPem,
    endorsement.algorithm,
  );
}

/** Endorsement lifecycle fields are optional, but malformed values fail closed. */
function endorsementLifecycleIsValid(endorsement, now = Date.now()) {
  if (Object.hasOwn(endorsement, "revokedBy")) return false;
  if (!Object.hasOwn(endorsement, "expires")) return true;
  if (typeof endorsement.expires !== "string" || endorsement.expires === "") return false;
  const expiresAt = parseStrictLifecycleExpiry(endorsement.expires);
  return expiresAt !== null && expiresAt > now;
}
