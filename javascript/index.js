/**
 * HTMLTrust Canonical Text Normalization
 * Spec: https://github.com/HTMLTrust/htmltrust-canonicalization
 *
 * Zero dependencies. Works in browsers and Node.js.
 */

import { NAMED_ENTITIES } from "./entities.js";

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
const HTML_TOKEN_RE = /<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\s*\/?>/gi;
const TAG_NAME_RE = /^<\/?\s*([a-z][a-z0-9-]*)/i;
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
  const body = tag.replace(/^<\/?\s*[a-z][a-z0-9-]*/i, "").replace(/\/?\s*>$/, "");
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
      if (!baseUrl && !/^[a-z][a-z0-9+.-]*:/i.test(value)) {
        // Relative URL with no base cannot be resolved. The draft (§4.3.2)
        // requires a hard failure rather than a silent skip.
        throw new Error(
          `attribute-canonicalization-failed: ${elementName}.${attrName}`,
        );
      }
      try {
        // `null` base coerces to the invalid string "null"; pass undefined so
        // an absolute URL is accepted without a base.
        value = new URL(value, baseUrl || undefined).href;
      } catch (err) {
        throw new Error(`attribute-canonicalization-failed: ${elementName}.${attrName}`);
      }
    } else {
      value = normalizeText(value).trim();
    }
    if (value.includes("\n")) {
      throw new Error(`attribute-canonicalization-failed: ${elementName}.${attrName}`);
    }
    const prefix = parts.length && !/[\s\n]$/.test(parts[parts.length - 1]) ? "\n" : "";
    parts.push(`${prefix}@attr:${elementName}:${attrName}:${value}\n`);
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
 * This implementation is regex-based and is sufficient for signed content
 * as typically produced by CMS platforms (blog posts, articles, news
 * stories). For pathological or adversarial input, a real DOM parser
 * should be used instead; the library API is compatible.
 *
 * @param {string} html - HTML fragment to canonicalize
 * @param {object} [options] - Options passed through to normalizeText
 * @returns {string} Canonical text, ready to be hashed
 */
export function extractCanonicalText(html, options = {}) {
  if (typeof html !== "string") {
    throw new TypeError("extractCanonicalText expects a string");
  }

  const parts = [];
  const baseUrl = options.baseUrl;
  let index = 0;
  let excludedDepth = 0;
  let match;
  HTML_TOKEN_RE.lastIndex = 0;
  while ((match = HTML_TOKEN_RE.exec(html))) {
    if (match.index > index && excludedDepth === 0) {
      appendPart(parts, normalizeText(decodeEntities(html.slice(index, match.index)), options));
    }
    index = HTML_TOKEN_RE.lastIndex;

    const token = match[0];
    const nameMatch = TAG_NAME_RE.exec(token);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase();
    const closing = /^<\//.test(token);
    const selfClosing = /\/\s*>$/.test(token) || VOID_TAGS.has(name);
    const excluded = EXCLUDED_TAGS.has(name);

    if (closing) {
      if (excluded && excludedDepth > 0) {
        excludedDepth--;
        continue;
      }
      if (excludedDepth > 0) continue;
      if (new RegExp(`^(${BLOCK_ELEMENTS})$`, "i").test(name)) appendPart(parts, "\n");
      continue;
    }

    if (excluded) {
      if (!selfClosing) excludedDepth++;
      continue;
    }
    if (excludedDepth > 0) continue;

    appendAttributeRecords(parts, name, parseAttributes(token), baseUrl);
    if (name === "br") appendPart(parts, "\n");
    if (selfClosing && new RegExp(`^(${BLOCK_ELEMENTS})$`, "i").test(name)) appendPart(parts, "\n");
  }
  if (index < html.length && excludedDepth === 0) {
    appendPart(parts, normalizeText(decodeEntities(html.slice(index)), options));
  }
  return finalizeCanonicalParts(parts);
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
  const seen = new Set();
  const entries = Object.entries(claims)
    .map(([name, value]) => [normalizeText(name).trim(), normalizeText(String(value)).trim()])
    .map(([name, value]) => {
      if (!name) throw new Error("claim-malformed");
      if (seen.has(name)) throw new Error(`claim-duplicate: ${name}`);
      seen.add(name);
      return [name, value];
    })
    // Sort by Unicode code point (== UTF-8 byte order), NOT by JS's default
    // UTF-16 code-unit comparison, so astral/high-BMP names order identically
    // to the other bindings (draft §4.6).
    .sort(([a], [b]) => compareByCodePoint(a, b));
  return entries.map(([name, value]) => `${name}:${value}\n`).join("");
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

  let depth = 0;
  let inSignedSection = !/<signed-section\b/i.test(html);
  const claims = {};
  const seen = new Set();
  HTML_TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = HTML_TOKEN_RE.exec(html))) {
    const token = match[0];
    const nameMatch = TAG_NAME_RE.exec(token);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase();
    const closing = /^<\//.test(token);
    const selfClosing = /\/\s*>$/.test(token) || VOID_TAGS.has(name);

    if (!inSignedSection) {
      if (!closing && name === "signed-section") {
        inSignedSection = true;
        depth = 0;
      }
      continue;
    }

    if (closing) {
      if (name === "signed-section" && depth === 0) break;
      if (depth > 0) depth--;
      continue;
    }

    if (depth === 0 && name === "meta") {
      const attrs = parseAttributes(token);
      if (!attrs.has("name") || !attrs.has("content")) throw new Error("claim-malformed");
      const claimName = normalizeText(attrs.get("name")).trim();
      const content = normalizeText(attrs.get("content")).trim();
      if (!claimName) throw new Error("claim-malformed");
      if (seen.has(claimName)) throw new Error(`claim-duplicate: ${claimName}`);
      seen.add(claimName);
      claims[claimName] = content;
      continue;
    }

    if (!selfClosing) depth++;
  }
  return claims;
}

// === Signature binding (spec §2.1) ===

/**
 * Build the canonical signature binding string per spec §2.1:
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
  const expiresAt = Date.parse(String(key.expires));
  return Number.isNaN(expiresAt) || expiresAt <= now;
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
  const ct = res.headers.get?.("content-type") ?? "";
  if (ct.includes("application/json")) return await res.json();
  // Treat as raw PEM if content-type is text-ish
  return { _rawText: await res.text() };
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
      const rest = keyid.slice("did:web:".length);
      const [host, ...pathParts] = rest.split(":");
      const url = pathParts.length
        ? `https://${host}/${pathParts.join("/")}/did.json`
        : `https://${host}/.well-known/did.json`;
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
    if (!e?.[field]) throw new Error(`buildEndorsementBinding: missing ${field}`);
  }
  const { signature, ...unsigned } = e;
  return canonicalizeJson(unsigned);
}

export function canonicalizeJson(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalizeJson(value[k])}`)
      .join(",")}}`;
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite JSON number");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  throw new Error(`unsupported JSON value: ${typeof value}`);
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
