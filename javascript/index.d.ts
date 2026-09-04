/**
 * Options for normalizeText.
 */
export interface NormalizeOptions {
  /** Set true for content inside <pre> elements. Default: false. */
  preserveWhitespace?: boolean;
  /** Signed document base URL, used to canonicalize relative href/src attributes. */
  baseUrl?: string;
}

/**
 * Normalize text content for canonical signing.
 * Implements all 8 phases of the HTMLTrust canonicalization spec.
 *
 * @param text - Raw text content
 * @param options - Normalization options
 * @returns Normalized text from the initialized Rust/WASM core
 */
export function normalizeText(text: string, options?: NormalizeOptions): string;

/**
 * Extract canonical text from an HTML fragment for signing or verification.
 *
 * Strips excluded elements (script, style, meta, link, head, noscript) and
 * their contents, converts block-element boundaries to whitespace separators,
 * emits signed semantic attribute records for href, src, alt, and aria-label,
 * strips remaining inline markup, decodes HTML entities, and applies the full
 * text normalization pipeline.
 *
 * @param html - HTML fragment to canonicalize
 * @param options - Options passed through to normalizeText
 * @returns Canonical text from the initialized Rust/WASM core
 */
export function extractCanonicalText(html: string, options?: NormalizeOptions): string;

/**
 * Compute a canonical claims string from a claims map.
 *
 * Claims are serialized as sorted "name:content\n" records.
 * The caller is responsible for hashing the returned string.
 *
 * @param claims - claim name → value map
 * @returns Canonical serialized string from the initialized Rust/WASM core
 */
export function canonicalizeClaims(claims: Record<string, string>): string;
export const SIGNING_PROFILE_V1: Readonly<{
  profile: "htmltrust-signature-v1";
  canonicalizationProfile: "htmltrust-c14n-v1";
  attributeProfile: "htmltrust-attrs-v1";
  urlProfile: "htmltrust-safe-url-v1";
  context: "https://htmltrust.org/protocol/signed-section";
}>;
export function deriveSigningLocationV1(documentURL: string, scope: "url" | "origin"): string;
export function validateSignedAtV1(value: string): string;
export function buildSigningPayloadV1(parts: {
  contentHash: string;
  claimsHash: string;
  documentURL: string;
  scope: "url" | "origin";
  keyid: string;
  algorithm: string;
  signedAt: string;
}): string;

/** Extract direct child `<meta name content>` claims from a signed-section. */
export function extractClaimsFromSignedSection(html: string): Record<string, string>;

/** Initialize the packaged Node.js WASM module before calling canonical APIs. */
export function initializeNodeWasm(module?: unknown): Promise<unknown>;

/** Initialize the packaged browser WASM module before calling canonical APIs. */
export function initializeBrowserWasm(
  module?: unknown,
  initializeInput?: unknown,
): Promise<unknown>;

/** Parts of the canonical signature binding (spec §2.1). */
export interface SignatureBindingParts {
  contentHash: string;
  claimsHash: string;
  /** Legacy field name; value must be a serialized Web origin, not a bare hostname. */
  domain: string;
  signedAt: string;
}

/**
 * Build the canonical signature binding `{content-hash}:{claims-hash}:{domain}:{signed-at}`.
 * Throws if any field is empty.
 */
export function buildSignatureBinding(parts: SignatureBindingParts): string;

/** Validate a canonical serialized Web origin (`scheme://host[:port]`). */
export function validateSerializedOrigin(origin: string): string;

/** Encode bytes as canonical unpadded standard Base64. */
export function encodeBase64Unpadded(bytes: Uint8Array | ArrayBuffer | number[]): string;

/** Decode canonical unpadded standard Base64, rejecting padded/base64url forms. */
export function decodeCanonicalBase64(b64: string): Uint8Array;

/**
 * Verify a signature over `message` with a PEM-encoded public key.
 * Algorithm is one of the spec §7.1 identifiers "ed25519", "ecdsa-p256",
 * "ecdsa-p384", "rsa-pss-sha256", "rsa-pkcs1-sha256", or the legacy generic
 * spellings "ecdsa" / "rsa" (case-insensitive). Any other value returns false.
 * Signature is canonical unpadded standard Base64.
 */
export function verifySignature(
  message: string,
  signatureB64: string,
  publicKeyPem: string,
  algorithm?: string,
): Promise<boolean>;

export interface ResolvedKey {
  keyid: string;
  publicKeyPem: string;
  algorithm: string;
  /** `revoked: true` in the key document (spec §8.2). */
  revoked?: boolean;
  /** RFC3339 expiry from the key document (spec §8.2). */
  expires?: string;
}

/**
 * True when a resolved key is revoked or expired (spec §8.2). Verifiers MUST
 * treat this as a "key-revoked" failure and MUST NOT proceed to signature
 * verification. An unparseable `expires` counts as revoked.
 */
export function isKeyRevoked(
  key: { revoked?: boolean; expires?: string } | null | undefined,
  now?: number,
): boolean;

export interface KeyResolver {
  resolve(keyid: string): Promise<ResolvedKey | null>;
}

/** Resolves `did:web:<host>[:<path>]` by fetching the corresponding DID doc. */
export function didWebResolver(opts?: { fetch?: typeof fetch }): KeyResolver;
/** Resolves keyids that are themselves http(s) URLs by fetching them. */
export function directUrlResolver(opts?: { fetch?: typeof fetch }): KeyResolver;
/** Resolves keyids via one or more configured trust directories (`<base>/keys/<keyid>`). */
export function trustDirectoryResolver(opts: {
  baseUrls: string[];
  fetch?: typeof fetch;
}): KeyResolver;

/** Walk a resolver chain and return the first successful resolution. */
export function resolveKey(
  keyid: string,
  resolvers: KeyResolver[],
): Promise<ResolvedKey | null>;

export interface Endorsement {
  endorser: string;
  endorsement: string;
  signature: string;
  timestamp: string;
  algorithm: string;
}

/** Build deterministic canonical JSON for an endorsement with `signature` omitted. */
export function buildEndorsementBinding(e: Omit<Endorsement, "signature"> & { signature?: string }): string;

/** Deterministically serialize a JSON value with object keys sorted. */
export function canonicalizeJson(value: unknown): string;

/** Parse and RFC 8785-canonicalize a complete JSON document strictly. */
export function canonicalizeJsonDocument(document: string): string;

/** Verify a standalone signed endorsement (spec §2.5). */
export function verifyEndorsement(
  endorsement: Endorsement,
  resolvers: KeyResolver[],
): Promise<boolean>;
