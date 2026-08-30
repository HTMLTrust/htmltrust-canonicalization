/** Functions exported by the generated wasm-bindgen Node or browser module. */
export interface RustWasmModule {
  abiVersion(): number;
  normalizeText(text: string): string;
  extractCanonicalText(html: string, base?: string | null): string;
  extractClaimsFromSignedSection(html: string): string;
  extractCanonicalTextWithOptions?(
    html: string,
    preserveWhitespace: boolean,
    base?: string | null,
  ): string;
  canonicalizeClaims(document: string): string;
  canonicalizeJsonDocument(document: string): string;
}

export interface ExtractCanonicalTextOptions {
  baseUrl?: string | null;
  preserveWhitespace?: boolean;
}

/** Install one generated Rust/WASM module before calling the adapter methods. */
export function initializeRustWasm(module: RustWasmModule): RustWasmModule;

/** Initialize the packaged Node.js WASM module. */
export function initializeNodeWasm(module?: unknown): Promise<RustWasmModule>;

/** Initialize the packaged browser WASM module. */
export function initializeBrowserWasm(
  module?: unknown,
  initializeInput?: unknown,
): Promise<RustWasmModule>;

/** Clear the installed module. Primarily useful for tests or reconfiguration. */
export function resetRustWasm(): void;

export interface NormalizeTextOptions {
  preserveWhitespace?: boolean;
}

export function normalizeText(
  text: string,
  options?: NormalizeTextOptions,
): string;

export function extractCanonicalText(
  html: string,
  options?: ExtractCanonicalTextOptions,
): string;

/** Canonicalize an object whose claim names and values are strings. */
export function canonicalizeClaims(claims: Record<string, string>): string;

/** Extract direct signed-section claims as a JavaScript object. */
export function extractClaimsFromSignedSection(html: string): Record<string, string>;

export function canonicalizeJsonDocument(document: string): string;
