// A rejection carries a machine-readable code from PROTOCOL.md / the draft.
// Every module in this implementation throws HTMLTrustError rather than a
// bare Error, so conformance-runner.mjs and browser-runner.html can turn a
// caught error directly into {"error": exc.code} without guessing.
export class HTMLTrustError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'HTMLTrustError';
    this.code = code;
  }
}

export function fail(code, message) {
  throw new HTMLTrustError(code, message);
}

const encoder = new TextEncoder();

export function utf8ByteLength(str) {
  return encoder.encode(str).length;
}

export function utf8Bytes(str) {
  return encoder.encode(str);
}

/** Lexicographic comparison of two strings by their UTF-8 byte sequence. */
export function compareUtf8(a, b) {
  const ba = utf8Bytes(a);
  const bb = utf8Bytes(b);
  const len = Math.min(ba.length, bb.length);
  for (let i = 0; i < len; i++) {
    if (ba[i] !== bb[i]) return ba[i] - bb[i];
  }
  return ba.length - bb.length;
}
