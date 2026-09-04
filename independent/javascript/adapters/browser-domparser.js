// Browser adapter: parses HTML with the browser's own HTML parser and
// converts its tree into the generic node shape canonicalize.js's
// extract() walks. Loaded as a classic module directly by
// browser-runner.html; no bundler, no build step.
//
// This parses in FRAGMENT context, using a detached <template> element's
// innerHTML setter (a standard part of the HTML parsing algorithm: it
// parses its argument with the template element itself as context, into
// template.content, a DocumentFragment). That is deliberate, not
// incidental: `DOMParser.parseFromString(html, 'text/html')` parses a
// full DOCUMENT, so any leading document-metadata content (a `<title>`,
// a `<base>`) is inserted into a synthesized `<head>` rather than left in
// place, and extract() never sees it -- a confirmed divergence from both
// the Node adapter (parse5's default fragment context is also
// `<template>`) and the Rust core (fragment-parses in body context). Two
// engine defaults exist, template and body; this project follows parse5's,
// so both adapters agree with each other and with Rust on where a
// document-metadata element that is not a direct child of the signed
// section (see draft 4.3.1) ends up.
//
// As in the Node adapter, the browser's own error recovery never runs on
// input lib/portable-profile.js has not already accepted, since that
// module is what decides accept/reject here, not the HTML parser (which
// the standard gives no API to ask for parse errors at all, regardless of
// which entry point is used to reach it).

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
  const template = document.createElement('template');
  template.innerHTML = html;
  return Array.from(template.content.childNodes).map(convert).filter((n) => n !== null);
}
