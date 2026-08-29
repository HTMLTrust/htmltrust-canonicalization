// Synchronous JavaScript adapter for the Rust/WASM canonicalizer.
//
// Loading/initializing a generated wasm-bindgen module is intentionally an
// explicit operation.  Once initializeRustWasm() succeeds, calls retain the
// synchronous API shape used by the existing JavaScript binding.

let wasmExports = null;

function validateExports(value) {
  const required = [
    "abiVersion",
    "normalizeText",
    "extractCanonicalText",
    "canonicalizeClaims",
    "canonicalizeJsonDocument",
  ];
  if (!value || required.some((name) => typeof value[name] !== "function")) {
    throw new TypeError("rust-wasm-module-invalid");
  }
  if (value.abiVersion() !== 1) throw new Error("rust-wasm-abi-unsupported");
  return value;
}

/** Initialize the adapter with a generated wasm-bindgen Node module. */
export function initializeRustWasm(value) {
  wasmExports = validateExports(value);
  return wasmExports;
}

/** Clear initialization state. Intended for tests and process reconfiguration. */
export function resetRustWasm() {
  wasmExports = null;
}

function initialized() {
  if (wasmExports === null) throw new Error("rust-wasm-not-initialized");
  return wasmExports;
}

function assertUnicodeScalarString(value, errorCode) {
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

function textInput(value, operation, errorCode = "parser-profile-unsupported") {
  if (typeof value !== "string") throw new TypeError(`${operation} expects a string`);
  assertUnicodeScalarString(value, errorCode);
  return value;
}

/**
 * Extract canonical text synchronously after explicit initialization.
 * The options shape matches the JavaScript binding's baseUrl option.
 */
export function extractCanonicalText(html, options = {}) {
  const wasm = initialized();
  const requestedBase = options?.baseUrl ?? undefined;
  const base = requestedBase === "" ? undefined : requestedBase;
  textInput(html, "extractCanonicalText");
  if (base !== undefined) textInput(base, "baseUrl");
  if (options?.preserveWhitespace) {
    if (typeof wasm.extractCanonicalTextWithOptions !== "function") {
      throw new Error("rust-wasm-option-unsupported");
    }
    return wasm.extractCanonicalTextWithOptions(html, true, base);
  }
  return wasm.extractCanonicalText(html, base);
}

/** Normalize text using the v1 profile. Legacy whitespace preservation is not
 * part of the Rust/WASM v1 entry point. */
export function normalizeText(text, options = {}) {
  const wasm = initialized();
  if (options?.preserveWhitespace) throw new Error("rust-wasm-option-unsupported");
  return wasm.normalizeText(textInput(text, "normalizeText"));
}

/** Canonicalize a claims object using the Rust JSON claims entry point. */
export function canonicalizeClaims(claims) {
  const wasm = initialized();
  if (claims === null || typeof claims !== "object" || Array.isArray(claims)) {
    throw new TypeError("claim-malformed");
  }
  let document;
  try {
    const validated = Object.create(null);
    for (const [name, value] of Object.entries(claims)) {
      if (typeof value !== "string") throw new TypeError("claim-malformed");
      assertUnicodeScalarString(name, "claim-malformed");
      assertUnicodeScalarString(value, "claim-malformed");
      validated[name] = value;
    }
    document = JSON.stringify(validated);
    if (typeof document !== "string") throw new TypeError("claim-malformed");
  } catch {
    throw new TypeError("claim-malformed");
  }
  return wasm.canonicalizeClaims(document);
}

/** Canonicalize one raw JSON document according to the JCS profile. */
export function canonicalizeJsonDocument(document) {
  const wasm = initialized();
  textInput(document, "canonicalizeJsonDocument", "jcs-invalid-surrogate");
  return wasm.canonicalizeJsonDocument(document);
}
