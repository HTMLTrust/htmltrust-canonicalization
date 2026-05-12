/**
 * Options for normalizeText.
 */
export interface NormalizeOptions {
  /** Set true for content inside <pre> elements. Default: false. */
  preserveWhitespace?: boolean;
}

/**
 * Normalize text content for canonical signing.
 * Implements all 8 phases of the HTMLTrust canonicalization spec.
 *
 * @param text - Raw text content
 * @param options - Normalization options
 * @returns Normalized text
 */
export function normalizeText(text: string, options?: NormalizeOptions): string;

/**
 * Extract canonical text from an HTML fragment for signing or verification.
 *
 * Strips excluded elements (script, style, meta, link, head, noscript) and
 * their contents, converts block-element boundaries to whitespace separators,
 * strips all remaining inline markup, decodes HTML entities, and applies the
 * full text normalization pipeline.
 *
 * Per HTMLTrust spec §2.1, this produces a text-only hash input: markup and
 * attributes of the signed content are NOT covered by the hash.
 *
 * @param html - HTML fragment to canonicalize
 * @param options - Options passed through to normalizeText
 * @returns Canonical text, ready to be hashed
 */
export function extractCanonicalText(html: string, options?: NormalizeOptions): string;

/**
 * Compute a canonical claims string from a claims map.
 *
 * Claims are serialized as sorted "name=value" pairs joined by newlines.
 * The caller is responsible for hashing the returned string.
 *
 * @param claims - claim name → value map
 * @returns Canonical serialized string ready to be hashed
 */
export function canonicalizeClaims(claims: Record<string, string>): string;

/** Parts of the canonical signature binding (spec §2.1). */
export interface SignatureBindingParts {
  contentHash: string;
  claimsHash: string;
  domain: string;
  signedAt: string;
}

/**
 * Build the canonical signature binding `{content-hash}:{claims-hash}:{domain}:{signed-at}`.
 * Throws if any field is empty.
 */
export function buildSignatureBinding(parts: SignatureBindingParts): string;

/**
 * Verify a signature over `message` with a PEM-encoded public key.
 * Algorithm is one of "ed25519", "ecdsa", "rsa" (case-insensitive).
 * Signature is base64-encoded (padded or unpadded).
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
}

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
  algorithm?: string;
}

/** Build the canonical endorsement binding `{content-hash}:{timestamp}`. */
export function buildEndorsementBinding(e: Pick<Endorsement, "endorsement" | "timestamp">): string;

/** Verify a standalone signed endorsement (spec §2.5). */
export function verifyEndorsement(
  endorsement: Endorsement,
  resolvers: KeyResolver[],
): Promise<boolean>;
