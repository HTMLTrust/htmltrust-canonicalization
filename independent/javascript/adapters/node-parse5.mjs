// Node adapter: parses HTML with parse5 and converts its tree into the
// generic node shape canonicalize.js's extract() walks.
//
// parse5 is this package's only dependency (see package.json), and its
// only job here is tree construction. By the time a document reaches this
// adapter, lib/portable-profile.js has already accepted it as conforming
// to the portable parser profile, so there is nothing left for parse5's
// own (silently repairing) error recovery to paper over -- see that
// module for why its diagnostics are not used as the profile's oracle.

import { parseFragment as p5ParseFragment } from 'parse5';

function convert(node) {
  if (node.nodeName === '#text') {
    return { type: 'text', data: node.value };
  }
  if (node.nodeName === '#comment' || node.nodeName === '#documentType') {
    return null; // section 4.2: comments and doctypes contribute nothing.
  }
  const attrs = {};
  for (const a of node.attrs || []) {
    attrs[a.name.toLowerCase()] = a.value;
  }
  const children = (node.childNodes || []).map(convert).filter((n) => n !== null);
  return { type: 'element', name: node.tagName.toLowerCase(), attrs, children };
}

/** parseFragment(html) -> generic top-level node array, for canonicalize.js's extract(). */
export function parseFragment(html) {
  const fragment = p5ParseFragment(html);
  return (fragment.childNodes || []).map(convert).filter((n) => n !== null);
}
