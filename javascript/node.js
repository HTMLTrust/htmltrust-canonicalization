/**
 * Node.js entry point with the packaged Rust/WASM core initialized.
 *
 * The operation methods remain synchronous after this one asynchronous
 * module-load step. Applications that need custom artifact pinning can use
 * the low-level `rust-wasm` entry point instead.
 */

import { createRequire } from "node:module";
import { initializeNodeWasm } from "./rust-wasm.js";

const externalModule = process.env.HTMLTRUST_WASM_PKG
  ? createRequire(import.meta.url)(process.env.HTMLTRUST_WASM_PKG)
  : undefined;
await initializeNodeWasm(externalModule);

export * from "./index.js";
export { initializeNodeWasm } from "./rust-wasm.js";
