/**
 * HTMLTrust Canonical Text Normalization
 * Spec: https://github.com/HTMLTrust/htmltrust-canonicalization
 *
 * Zero dependencies. Works in browsers and Node.js.
 */

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
const SINGLE_QUOTE_RE = /[\u2018\u2019\u201B\u2039\u203A\u0060\u00B4\u2032]/g;
const DOUBLE_QUOTE_RE =
  /[\u201A\u201C\u201D\u201E\u201F\u00AB\u00BB\u2033\u301D\u301E\u301F]/g;
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

// Block-level elements whose boundaries should become whitespace separators.
// Inline elements (em, strong, a, span, etc.) do NOT get separators, so
// "<p>hello <em>world</em></p>" canonicalizes to "hello world" not "hello world ".
const BLOCK_ELEMENTS =
  "address|article|aside|blockquote|canvas|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|noscript|ol|output|p|pre|section|table|tfoot|thead|tr|td|th|ul|video";
const BLOCK_OPEN_RE = new RegExp(`<(${BLOCK_ELEMENTS})\\b[^>]*>`, "gi");
const BLOCK_CLOSE_RE = new RegExp(`</(${BLOCK_ELEMENTS})\\s*>`, "gi");

// Any remaining HTML tag (inline elements we strip without adding whitespace).
const ANY_TAG_RE = /<\/?[a-z][a-z0-9-]*\b[^>]*>/gi;

// HTML entity decoding table (common entities; numeric entities handled separately).
const NAMED_ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": "\u00A0",
  "&ndash;": "\u2013",
  "&mdash;": "\u2014",
  "&lsquo;": "\u2018",
  "&rsquo;": "\u2019",
  "&ldquo;": "\u201C",
  "&rdquo;": "\u201D",
  "&hellip;": "\u2026",
  "&copy;": "\u00A9",
  "&reg;": "\u00AE",
  "&trade;": "\u2122",
};

function decodeEntities(text) {
  // Named entities
  text = text.replace(/&[a-z]+;/gi, (match) => {
    const key = match.toLowerCase();
    return NAMED_ENTITIES[key] ?? match;
  });
  // Numeric decimal entities
  text = text.replace(/&#(\d+);/g, (_, code) =>
    String.fromCodePoint(parseInt(code, 10)),
  );
  // Numeric hex entities
  text = text.replace(/&#x([0-9a-f]+);/gi, (_, code) =>
    String.fromCodePoint(parseInt(code, 16)),
  );
  return text;
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
 *   2. Converts block-element boundaries to single spaces so that
 *      `<p>A</p><p>B</p>` canonicalizes to `A B`, not `AB`.
 *   3. Strips all remaining inline markup, preserving only text content.
 *   4. Decodes HTML entities.
 *   5. Applies the full text normalization pipeline (`normalizeText`).
 *
 * The output is a pure text string. Markup, attributes, link destinations,
 * and media sources are NOT covered by the hash. This is a deliberate
 * scoping choice (see spec §2.1 "Text-only scope" and the open design
 * question on attribute coverage).
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

  // Step 1: Strip excluded elements and their contents.
  let text = html.replace(EXCLUDED_ELEMENTS_RE, " ");
  text = text.replace(VOID_ELEMENTS_RE, " ");

  // Step 2: Convert block boundaries to whitespace.
  text = text.replace(BLOCK_OPEN_RE, " ");
  text = text.replace(BLOCK_CLOSE_RE, " ");

  // Step 3: Strip all remaining (inline) tags.
  text = text.replace(ANY_TAG_RE, "");

  // Step 4: Decode HTML entities.
  text = decodeEntities(text);

  // Step 5: Apply full canonicalization pipeline.
  return normalizeText(text, options).trim();
}

/**
 * Compute a canonical claims hash from a list of claim entries.
 *
 * Claims are serialized as a sorted list of "name=value" pairs, joined by
 * newlines, then hashed. Sorting ensures the order of <meta> elements in
 * the HTML source does not affect the hash. The caller is responsible for
 * computing the actual hash from the returned canonical string.
 *
 * @param {Record<string, string>} claims - claim name → value map
 * @returns {string} Canonical serialized string ready to be hashed
 */
export function canonicalizeClaims(claims) {
  const entries = Object.entries(claims)
    .map(([name, value]) => [normalizeText(name), normalizeText(String(value))])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([name, value]) => `${name}=${value}`).join("\n");
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
 * @param {string} parts.domain      - publication origin (hostname)
 * @param {string} parts.signedAt    - ISO-8601 timestamp from <meta name="signed-at">
 * @returns {string}
 */
export function buildSignatureBinding({ contentHash, claimsHash, domain, signedAt }) {
  if (!contentHash || !claimsHash || !domain || !signedAt) {
    throw new Error(
      `buildSignatureBinding: missing field(s): contentHash=${contentHash}, claimsHash=${claimsHash}, domain=${domain}, signedAt=${signedAt}`,
    );
  }
  return `${contentHash}:${claimsHash}:${domain}:${signedAt}`;
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

function base64ToBytes(b64) {
  // Accept padded and unpadded base64; tolerate whitespace.
  const cleaned = String(b64).replace(/\s+/g, "");
  const padded = cleaned + "===".slice((cleaned.length + 3) % 4);
  if (typeof atob === "function") {
    const bin = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Node fallback
  return new Uint8Array(Buffer.from(padded, "base64"));
}

function utf8ToBytes(str) {
  return new TextEncoder().encode(str);
}

const ALGO_ALIASES = {
  ED25519: "ed25519",
  ECDSA: "ecdsa",
  RSA: "rsa",
  "RSA-SHA256": "rsa",
  ECDSAP256: "ecdsa",
};
function normalizeAlgo(algorithm) {
  const key = String(algorithm || "ed25519").toUpperCase();
  return ALGO_ALIASES[key] ?? key.toLowerCase();
}

/**
 * Verify a signature over `message` with `publicKeyPem` using `algorithm`.
 *
 * Algorithms supported: "ed25519", "ecdsa" (P-256 / secp256k1, SHA-256), "rsa" (RSA-SHA256).
 * Algorithm names are case-insensitive. Signature is base64-encoded (padded
 * or unpadded). Public key is a PEM-encoded SPKI document.
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
  const sigBytes = base64ToBytes(signatureB64);
  const msgBytes = utf8ToBytes(message);

  const node = isNodeEnv() ? await getNodeCrypto() : null;
  if (node) {
    try {
      const publicKey = node.createPublicKey(publicKeyPem);
      if (algo === "ed25519") {
        return node.verify(null, Buffer.from(msgBytes), publicKey, Buffer.from(sigBytes));
      }
      if (algo === "ecdsa") {
        return node.verify("sha256", Buffer.from(msgBytes), publicKey, Buffer.from(sigBytes));
      }
      if (algo === "rsa") {
        return node.verify("RSA-SHA256", Buffer.from(msgBytes), publicKey, Buffer.from(sigBytes));
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
    } else if (algo === "ecdsa") {
      key = await subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      params = { name: "ECDSA", hash: "SHA-256" };
    } else if (algo === "rsa") {
      key = await subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      params = { name: "RSASSA-PKCS1-v1_5" };
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
  return base64ToBytes(body);
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
 */

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
      const vm = (doc.verificationMethod || []).find((m) => m.publicKeyPem);
      if (!vm) return null;
      return {
        keyid,
        publicKeyPem: vm.publicKeyPem,
        algorithm: vm.algorithm || vmTypeToAlgo(vm.type) || "ed25519",
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
      const pem = data.publicKey || data.publicKeyPem || data.key;
      if (!pem) return null;
      return { keyid, publicKeyPem: pem, algorithm: data.algorithm || "ed25519" };
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
          const pem = data.publicKey || data.publicKeyPem || data.key;
          if (!pem) continue;
          return { keyid, publicKeyPem: pem, algorithm: data.algorithm || "ed25519" };
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
 * Build the canonical binding for an endorsement: `{content-hash}:{timestamp}`.
 * The endorser's keyid is implicit (resolution step), matching the content-
 * signature binding's design.
 *
 * @param {{ endorsement: string, timestamp: string }} e
 * @returns {string}
 */
export function buildEndorsementBinding(e) {
  if (!e?.endorsement || !e?.timestamp) {
    throw new Error("buildEndorsementBinding: missing endorsement or timestamp");
  }
  return `${e.endorsement}:${e.timestamp}`;
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
 *   algorithm?: string,
 * }} endorsement
 * @param {KeyResolver[]} resolvers
 * @returns {Promise<boolean>}
 */
export async function verifyEndorsement(endorsement, resolvers) {
  if (!endorsement) return false;
  const resolved = await resolveKey(endorsement.endorser, resolvers);
  if (!resolved) return false;
  const binding = buildEndorsementBinding(endorsement);
  // Resolver-declared algorithm is authoritative — the key knows what it is.
  // The endorsement.algorithm field is only consulted as a fallback when the
  // resolver doesn't carry one. Cross-platform parity: matches Go binding.
  return await verifySignature(
    binding,
    endorsement.signature,
    resolved.publicKeyPem,
    resolved.algorithm || endorsement.algorithm || "ed25519",
  );
}
