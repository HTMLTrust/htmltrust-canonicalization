// Canonical claims serialization: draft section 4.6 ("Canonical claims").
//
// The `claims` conformance suite hands us the claim map directly (as JSON),
// bypassing the HTML `<meta>` extraction step in section 4.6 items 1-2. What
// remains is: normalize every name and value with normalize_text, escape
// them, sort by the UTF-8 byte sequence of the normalized name, and join as
// `name:content\n` records.

import { fail, compareUtf8, utf8ByteLength } from './errors.js';
import { normalizeStandaloneText } from './text-normalize.js';

const MAX_CLAIMS = 64;
const MAX_FIELD_BYTES = 4096; // 4 KiB, resource-limits table.

/** Section 4.6 escaping, applied after normalization. */
function escapeClaimField(str) {
  let out = '';
  for (const ch of str) {
    if (ch === '\\') out += '\\\\';
    else if (ch === ':') out += '\\:';
    else if (ch === '\n') out += '\\n';
    else out += ch;
  }
  return out;
}

/**
 * Canonicalize a claims map (name -> value, both strings) per section 4.6.
 * Throws HTMLTrustError with codes claim-malformed, claim-duplicate, or
 * resource-limit-exceeded.
 */
export function canonicalizeClaims(claims) {
  if (claims === null || typeof claims !== 'object' || Array.isArray(claims)) {
    fail('claim-malformed', 'claims input must be a JSON object');
  }

  const rawNames = Object.keys(claims);
  if (rawNames.length > MAX_CLAIMS) {
    fail('resource-limit-exceeded', `more than ${MAX_CLAIMS} direct claims`);
  }

  const records = []; // { name, content } after normalization
  const seenNames = new Set();

  for (const rawName of rawNames) {
    const rawValue = claims[rawName];
    if (typeof rawValue !== 'string') {
      // The conformance suite's `claims` input models the (name, content)
      // pairs a real claim <meta> element supplies; both are always
      // strings on that source. A non-string value cannot have come from
      // an HTML attribute, so it is malformed input.
      fail('claim-malformed', `claim "${rawName}" has a non-string value`);
    }

    const name = normalizeStandaloneText(rawName);
    if (name === '') {
      fail('claim-malformed', 'a claim name normalizes to the empty string');
    }
    if (utf8ByteLength(name) > MAX_FIELD_BYTES) {
      fail('resource-limit-exceeded', 'normalized claim name exceeds 4 KiB');
    }

    const content = normalizeStandaloneText(rawValue);
    if (utf8ByteLength(content) > MAX_FIELD_BYTES) {
      fail('resource-limit-exceeded', 'normalized claim value exceeds 4 KiB');
    }

    if (seenNames.has(name)) {
      fail('claim-duplicate', `two claims normalize to the same name "${name}"`);
    }
    seenNames.add(name);

    records.push({ name, content });
  }

  records.sort((a, b) => compareUtf8(a.name, b.name));

  return records.map((r) => `${escapeClaimField(r.name)}:${escapeClaimField(r.content)}\n`).join('');
}
