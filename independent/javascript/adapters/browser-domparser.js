// Browser adapter: parses HTML with the browser's own DOMParser and
// converts its tree into the generic node shape canonicalize.js's
// extract() walks. Loaded as a classic module directly by
// browser-runner.html; no bundler, no build step.
//
// DOMParser.parseFromString(html, 'text/html') parses a full document,
// not a fragment, so the fragment content this project's fixtures supply
// ends up as document.body's children -- exactly the node list extract()
// needs, in the order it was written. (An element the HTML parsing
// algorithm treats as document metadata content, such as a `<meta>`
// mid-fragment, is still inserted at the current point in the tree per
// the HTML Standard's "in body" handling for it; it is not physically
// relocated into <head>. Its content is excluded from canonical output
// by lib/extract.js regardless, per section 4.3.1.)
//
// As in the Node adapter, DOMParser's own error recovery never runs on
// input lib/portable-profile.js has not already accepted, since that
// module is what decides accept/reject here, not DOMParser (which the
// standard gives no API to ask for parse errors at all).

function convert(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return { type: 'text', data: node.data };
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null; // comments, processing instructions: contribute nothing.
  }
  const attrs = {};
  for (const attr of node.attributes) {
    attrs[attr.name.toLowerCase()] = attr.value;
  }
  const children = Array.from(node.childNodes).map(convert).filter((n) => n !== null);
  return { type: 'element', name: node.tagName.toLowerCase(), attrs, children };
}

/** parseFragment(html) -> generic top-level node array, for canonicalize.js's extract(). */
export function parseFragment(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return Array.from(doc.body.childNodes).map(convert).filter((n) => n !== null);
}
