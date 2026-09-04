import { accessSync, constants } from "node:fs";

const required = [
  new URL("./wasm-node/htmltrust_canonicalization_ffi.js", import.meta.url),
  new URL("./wasm-node/htmltrust_canonicalization_ffi_bg.wasm", import.meta.url),
  new URL("./wasm-web/htmltrust_canonicalization_ffi.js", import.meta.url),
  new URL("./wasm-web/htmltrust_canonicalization_ffi_bg.wasm", import.meta.url),
];

try {
  for (const artifact of required) accessSync(artifact, constants.R_OK);
} catch {
  throw new Error(
    "WASM package artifacts are missing; pack the staged npm-package directory produced by make core-artifacts",
  );
}
