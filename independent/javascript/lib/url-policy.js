// htmltrust-safe-url-v1: draft section 5.2 ("Signed-attribute and safe-URL
// profiles"), applied to `href` and `src` (section 4.3.2).
//
// This relies on the platform's URL class for parsing, resolution, and
// serialization. That class implements the WHATWG URL Standard, which is
// exactly what the draft cites for host case-folding, default-port
// omission, dot-segment resolution, IDNA/punycode, and percent-encoding of
// non-ASCII and reserved characters in path/query/fragment -- it is not a
// piece of HTMLTrust-specific behavior to reimplement, in the same way
// String.prototype.normalize('NFKC') is not.

import { fail } from './errors.js';

/** ASCII C0 controls and DEL. Checked on the raw, already-decoded value
 * before it ever reaches the URL parser, per section 5.2: "the verifier
 * MUST inspect every code point and reject an ASCII C0 control or U+007F.
 * This order prevents URL preprocessing from silently stripping a tab or
 * line feed." A character produced this way is a policy violation, not a
 * parse failure (see `url-control-rejected` fixture). */
function hasC0OrDelControl(str) {
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if ((cp <= 0x1f) || cp === 0x7f) return true;
  }
  return false;
}

/**
 * Validate a document base URL up front. The draft requires this to fail
 * even when no signed URL attribute in the content ends up needing it
 * (`url-invalid-unused-base-rejected`).
 */
export function checkBaseURL(baseURL) {
  if (baseURL === undefined || baseURL === null) return;
  try {
    // eslint-disable-next-line no-new
    new URL(baseURL);
  } catch {
    fail('attribute-canonicalization-failed', `base URL does not parse: ${JSON.stringify(baseURL)}`);
  }
}

/**
 * Apply htmltrust-safe-url-v1 to a decoded href/src attribute value and
 * return its canonical serialization. Throws HTMLTrustError with code
 * url-policy-violation or attribute-canonicalization-failed.
 */
export function canonicalizeSafeURL(rawValue, baseURL) {
  if (hasC0OrDelControl(rawValue)) {
    fail('url-policy-violation', 'URL value contains an ASCII C0 control or U+007F');
  }

  let url;
  try {
    url = baseURL === undefined || baseURL === null ? new URL(rawValue) : new URL(rawValue, baseURL);
  } catch {
    fail('attribute-canonicalization-failed', `URL does not parse: ${JSON.stringify(rawValue)}`);
  }

  if (url.protocol !== 'https:') {
    fail('url-policy-violation', `scheme ${url.protocol} is not https`);
  }
  if (url.username !== '' || url.password !== '') {
    fail('url-policy-violation', 'URL carries userinfo (username or password)');
  }

  const serialized = url.href;
  if (serialized.includes('\n')) {
    fail('attribute-canonicalization-failed', 'serialized URL contains a line feed');
  }
  return serialized;
}
