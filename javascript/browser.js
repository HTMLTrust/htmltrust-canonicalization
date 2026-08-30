/**
 * Browser entry point for the Rust/WASM core.
 *
 * Browser WASM loading is asynchronous. Call initializeBrowserWasm() before
 * using any canonicalization or signing helper that consumes canonical bytes.
 */

export * from "./index.js";
export { initializeBrowserWasm } from "./rust-wasm.js";
