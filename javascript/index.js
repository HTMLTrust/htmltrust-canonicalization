/**
 * HTMLTrust canonicalization and signing helpers.
 *
 * Canonical bytes are produced by the Rust/WASM core. This module retains
 * JavaScript-native signing, cryptography, key resolution, and authoring APIs.
 */

import {
  canonicalizeClaims as rustCanonicalizeClaims,
  canonicalizeJsonDocument as rustCanonicalizeJsonDocument,
  extractCanonicalText as rustExtractCanonicalText,
  extractClaimsFromSignedSection as rustExtractClaimsFromSignedSection,
  normalizeText as rustNormalizeText,
} from "./rust-wasm.js";

export {
  initializeBrowserWasm,
  initializeNodeWasm,
} from "./rust-wasm.js";

const MAX_RESOURCE_BYTES = 1024 * 1024;
const MAX_REMOTE_KEY_BYTES = 64 * 1024;
const MAX_JCS_DEPTH = 256;

function utf8Length(value) {
  return new TextEncoder().encode(value).byteLength;
}

function checkResourceBytes(value) {
  if (utf8Length(value) > MAX_RESOURCE_BYTES) {
    throw new Error("resource-limit-exceeded");
  }
  return value;
}

function assertUnicodeScalarString(value, errorCode = "jcs-invalid-surrogate") {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) throw new Error(errorCode);
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error(errorCode);
    }
  }
}

function validateJsonValue(value, depth = 0, ancestors = new WeakSet()) {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    assertUnicodeScalarString(value);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite JSON number");
    if (Object.is(value, -0)) throw new Error("jcs-number");
    return;
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol" || value === undefined) {
    throw new Error(`unsupported JSON value: ${typeof value}`);
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_JCS_DEPTH) throw new Error("resource-limit-exceeded");
    if (ancestors.has(value)) throw new Error("unsupported JSON value: cyclic object");
    ancestors.add(value);
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) throw new Error("unsupported JSON value: sparse array");
      validateJsonValue(value[index], depth + 1, ancestors);
    }
    ancestors.delete(value);
    return;
  }
  if (typeof value === "object") {
    if (depth >= MAX_JCS_DEPTH) throw new Error("resource-limit-exceeded");
    if (ancestors.has(value)) throw new Error("unsupported JSON value: cyclic object");
    ancestors.add(value);
    for (const key of Object.keys(value)) {
      assertUnicodeScalarString(key);
      validateJsonValue(value[key], depth + 1, ancestors);
    }
    ancestors.delete(value);
    return;
  }
  throw new Error(`unsupported JSON value: ${typeof value}`);
}

function jcsInputBytes(value) {
  validateJsonValue(value);
  const raw = JSON.stringify(value);
  if (typeof raw !== "string") throw new Error("unsupported JSON value");
  checkResourceBytes(raw);
  return raw;
}

/** Normalize text through the mandatory Rust/WASM core. */
export function normalizeText(text, options = {}) {
  return rustNormalizeText(text, options);
}

/** Extract canonical HTML text through the mandatory Rust/WASM core. */
export function extractCanonicalText(html, options = {}) {
  return rustExtractCanonicalText(html, options);
}

/** Serialize claims through the mandatory Rust/WASM core. */
export function canonicalizeClaims(claims) {
  return rustCanonicalizeClaims(claims);
}

/** Extract signed-section claims through the mandatory Rust/WASM core. */
export function extractClaimsFromSignedSection(html) {
  return rustExtractClaimsFromSignedSection(html);
}

/** Canonicalize a JSON-compatible value through the mandatory Rust core. */
export function canonicalizeJson(value) {
  return canonicalizeJsonDocument(jcsInputBytes(value));
}

/** Canonicalize one raw JSON document through the mandatory Rust/WASM core. */
export function canonicalizeJsonDocument(document) {
  return rustCanonicalizeJsonDocument(document);
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
  // Enforce the input side of the resource profile before URL parsing or any
  // other derived-field work can shorten or otherwise transform the values.
  jcsInputBytes({ contentHash, claimsHash, documentURL, scope, keyid, algorithm, signedAt });
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
