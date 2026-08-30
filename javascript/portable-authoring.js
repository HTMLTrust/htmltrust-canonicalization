/**
 * Portable authoring helpers for complete HTML documents.
 *
 * The canonicalizer intentionally accepts an HTML fragment and requires its
 * caller to supply the resolved document base URL. This module is the small
 * source-snapshot layer that connects those two jobs for authors and tools.
 */

import * as parse5 from "parse5";
import {
  extractCanonicalText,
  extractClaimsFromSignedSection,
  canonicalizeClaims,
} from "./index.js";

const MAX_RESOURCE_BYTES = 1024 * 1024;
const SAFE_URL_PROTOCOL = "https:";

const DIAGNOSTIC_HINTS = Object.freeze({
  "document-url-invalid": "Pass the final HTTPS response URL, without credentials.",
  "base-invalid": "Fix the base href or remove it so the final response URL is used.",
  "signed-section-not-found": "Add a signed-section element to the document.",
  "signed-section-unclosed": "Close the signed-section element before signing.",
  "parser-profile-unsupported": "Use well-formed HTML in the HTMLTrust v1 portable profile.",
  "resource-limit-exceeded": "Reduce the document, region, or field size before signing.",
  "url-policy-violation": "Use an HTTPS URL without credentials in signed URL attributes.",
  "attribute-canonicalization-failed": "Fix the signed href or src attribute and its base URL.",
  "claim-malformed": "Give every direct claim meta element both name and content attributes.",
  "claim-duplicate": "Keep one direct claim meta element for each normalized claim name.",
  "conversion-ambiguous": "Wrap a fragment without document containers or an existing signed-section.",
  "conversion-lossy": "Keep the original source and resolve the canonicalization difference manually.",
  "document-parser-recovered": "Inspect document-level markup outside the signed regions before publishing.",
});

const KNOWN_CODES = Object.keys(DIAGNOSTIC_HINTS);

function utf8Length(value) {
  return new TextEncoder().encode(value).byteLength;
}

function fail(code, message, context = {}) {
  const error = new Error(message || code);
  error.code = code;
  error.context = context;
  return error;
}

function safeURL(raw, code) {
  if (typeof raw !== "string" || !raw) throw fail(code, "URL is required");
  if (/[\u0000-\u001F\u007F]/u.test(raw)) throw fail(code, "URL contains control characters");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw fail(code, "URL is malformed");
  }
  if (url.protocol !== SAFE_URL_PROTOCOL || url.username || url.password) {
    throw fail(code, "URL must be HTTPS and contain no credentials");
  }
  return url.href;
}

function attrsFor(node) {
  const attrs = new Map();
  for (const attr of node.attrs || []) attrs.set(attr.name.toLowerCase(), attr.value);
  return attrs;
}

function walk(node, callback) {
  for (const child of node.childNodes || []) {
    callback(child);
    walk(child, callback);
  }
}

function sourceLocation(node) {
  const location = node.sourceCodeLocation;
  if (!location?.startTag) return null;
  const endTag = location.endTag;
  return {
    startOffset: location.startTag.startOffset,
    endOffset: endTag?.endOffset ?? location.endOffset ?? null,
    startLine: location.startTag.startLine,
    startColumn: location.startTag.startCol,
    endLine: endTag?.endLine ?? location.endLine ?? null,
    endColumn: endTag?.endCol ?? location.endCol ?? null,
    innerStartOffset: location.startTag.endOffset,
    innerEndOffset: endTag?.startOffset ?? null,
    hasEndTag: Boolean(endTag),
  };
}

function resolveBase(document, finalURL) {
  const candidates = [];
  walk(document, (node) => {
    if (node.tagName?.toLowerCase() !== "base") return;
    const attrs = attrsFor(node);
    if (!attrs.has("href")) return;
    const href = attrs.get("href");
    const location = sourceLocation(node);
    try {
      candidates.push({
        href,
        url: new URL(href, finalURL),
        location,
      });
    } catch {
      candidates.push({ href, location, error: "malformed" });
    }
  });

  const first = candidates[0];
  if (!first) return { baseURL: finalURL, diagnostics: [] };

  // The HTML Standard uses the first base element with an href in tree order.
  // Later base elements never repair an invalid first one. A base URL that
  // cannot be used falls back to the document URL.
  if (first.error || /[\u0000-\u001F\u007F]/u.test(first.href)) {
    return {
      baseURL: finalURL,
      diagnostics: [diagnostic("base-invalid", {
        message: "The first base href could not be resolved; the final response URL is used.",
        context: { href: first.href, location: first.location },
      })],
    };
  }
  if (
    first.url.protocol === "data:" ||
    first.url.protocol === "javascript:"
  ) {
    return {
      baseURL: finalURL,
      diagnostics: [diagnostic("base-invalid", {
        message: "The first base href cannot become a document base; the final response URL is used.",
        context: { href: first.href, location: first.location },
      })],
    };
  }
  const diagnostics = [];
  if (
    first.url.protocol !== SAFE_URL_PROTOCOL ||
    first.url.username ||
    first.url.password
  ) {
    diagnostics.push(diagnostic("base-invalid", {
      message: "The document base is outside the HTMLTrust HTTPS profile; relative signed URLs will fail preflight.",
      context: { href: first.href, location: first.location },
    }));
  }
  return { baseURL: first.url.href, diagnostics };
}

function diagnostic(code, { message, region = null, context = {} } = {}) {
  return {
    code,
    severity: "error",
    message: message || code,
    hint: DIAGNOSTIC_HINTS[code] || "Inspect the source at the reported location.",
    region,
    context,
  };
}

function warningDiagnostic(code, args) {
  return { ...diagnostic(code, args), severity: "warning" };
}

function errorCode(error) {
  if (error?.code && KNOWN_CODES.includes(error.code)) return error.code;
  const message = String(error?.message || error || "");
  return KNOWN_CODES.find((code) => message === code || message.startsWith(`${code}:`)) ||
    "parser-profile-unsupported";
}

function errorContext(error) {
  const message = String(error?.message || "");
  const context = {};
  if (message.startsWith("attribute-canonicalization-failed:")) {
    const [, attribute] = message.split(":", 2);
    context.attribute = attribute;
  }
  if (message.startsWith("claim-duplicate:")) context.claimName = message.slice("claim-duplicate:".length).trim();
  if (error?.context) Object.assign(context, error.context);
  return context;
}

function parseDocument(html) {
  const parseErrors = [];
  const document = parse5.parse(html, {
    sourceCodeLocationInfo: true,
    onParseError(error) { parseErrors.push(error); },
  });
  return { document, parseErrors };
}

function signedSections(document) {
  const sections = [];
  walk(document, (node) => {
    if (node.tagName?.toLowerCase() === "signed-section") sections.push(node);
  });
  return sections;
}

function regionResult(node, index, html, baseURL) {
  const location = sourceLocation(node);
  if (!location?.hasEndTag || location.innerEndOffset == null) {
    return {
      index,
      status: "fail",
      location,
      diagnostics: [diagnostic("signed-section-unclosed", {
        region: index,
        context: { location },
      })],
    };
  }
  const innerHTML = html.slice(location.innerStartOffset, location.innerEndOffset);
  const sectionHTML = html.slice(location.startOffset, location.endOffset);
  try {
    const canonicalText = extractCanonicalText(innerHTML, { baseUrl: baseURL });
    // The exact source snapshot makes this section the first signed-section
    // seen by the Rust core, while preserving direct-child claim semantics.
    const claims = extractClaimsFromSignedSection(sectionHTML);
    const canonicalClaims = canonicalizeClaims(claims);
    return {
      index,
      status: "pass",
      location,
      baseURL,
      canonicalText,
      claims,
      canonicalClaims,
      diagnostics: [],
    };
  } catch (error) {
    const code = errorCode(error);
    return {
      index,
      status: "fail",
      location,
      baseURL,
      diagnostics: [diagnostic(code, {
        region: index,
        message: String(error?.message || code),
        context: { ...errorContext(error), location },
      })],
    };
  }
}

/**
 * Discover and preflight every signed-section in a complete HTML document.
 *
 * `documentURL` is the final response URL. The first `<base href>` in tree
 * order is used. Opaque or malformed first bases fall back to the final URL;
 * later base elements are ignored. Unsafe HTTP/credential-bearing bases are
 * retained and cause relative signed URLs to fail the v1 URL policy.
 */
export function preflightPortableDocument(html, { documentURL } = {}) {
  if (typeof html !== "string") throw new TypeError("preflightPortableDocument expects a string");
  if (utf8Length(html) > MAX_RESOURCE_BYTES) {
    return {
      profile: "htmltrust-portable-authoring-v1",
      ok: false,
      documentURL: documentURL ?? null,
      baseURL: null,
      diagnostics: [diagnostic("resource-limit-exceeded")],
      regions: [],
    };
  }

  let finalURL;
  try {
    finalURL = safeURL(documentURL, "document-url-invalid");
  } catch (error) {
    return {
      profile: "htmltrust-portable-authoring-v1",
      ok: false,
      documentURL: documentURL ?? null,
      baseURL: null,
      diagnostics: [diagnostic(errorCode(error), { context: errorContext(error) })],
      regions: [],
    };
  }

  const { document, parseErrors } = parseDocument(html);
  const base = resolveBase(document, finalURL);
  const sections = signedSections(document);
  const regions = sections.map((node, index) => regionResult(node, index, html, base.baseURL));
  const diagnostics = base.diagnostics.map((entry) => ({ ...entry, severity: "warning" }));
  if (!regions.length) diagnostics.push(diagnostic("signed-section-not-found"));
  // Full-document parser errors outside a region do not change the fragment
  // bytes being signed. Keep them observable without making valid regions
  // fail because of unrelated page chrome.
  if (parseErrors.length) {
    diagnostics.push(warningDiagnostic("document-parser-recovered", {
      message: "The HTML parser recovered from one or more document-level issues outside signed regions.",
      context: { count: parseErrors.length },
    }));
  }
  return {
    profile: "htmltrust-portable-authoring-v1",
    ok: regions.length > 0 && regions.every((region) => region.status === "pass"),
    documentURL: finalURL,
    baseURL: base.baseURL,
    diagnostics,
    regions,
  };
}

function containsElement(fragment, names) {
  let found = false;
  walk(fragment, (node) => {
    if (names.has(node.tagName?.toLowerCase())) found = true;
  });
  return found;
}

function hasExplicitDocumentContainer(source) {
  // Text inside comments and excluded raw-text elements is data, not a
  // document container. Remove those bodies before checking source that
  // parseFragment intentionally treats as fragment content.
  const markup = source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(?:script|style|iframe)\b[\s\S]*?<\/(?:script|style|iframe)\s*>/gi, "");
  return /<!doctype\b|<\s*(?:html|head|body|signed-section)\b/i.test(markup);
}

/**
 * Wrap a well-formed HTML fragment in a signed-section without changing its
 * canonical content or claims. Ambiguous document inputs and any canonical
 * difference are rejected with a stable error code.
 */
export function wrapSignedSection(html, options = {}) {
  if (typeof html !== "string") throw new TypeError("wrapSignedSection expects a string");
  if (utf8Length(html) > MAX_RESOURCE_BYTES) throw fail("resource-limit-exceeded", "source exceeds the v1 limit");
  const parseErrors = [];
  const fragment = parse5.parseFragment(html, {
    sourceCodeLocationInfo: true,
    onParseError(error) { parseErrors.push(error); },
  });
  if (
    parseErrors.length ||
    hasExplicitDocumentContainer(html) ||
    containsElement(fragment, new Set(["html", "head", "body", "signed-section"]))
  ) {
    throw fail("conversion-ambiguous", "fragment contains a document container or signed-section");
  }
  let beforeText;
  let beforeClaims;
  try {
    beforeText = extractCanonicalText(html, { baseUrl: options.baseUrl });
    beforeClaims = extractClaimsFromSignedSection(html);
  } catch (error) {
    const code = errorCode(error);
    throw fail(code, String(error?.message || code), errorContext(error));
  }
  const wrapped = `<signed-section>${html}</signed-section>`;
  try {
    const afterText = extractCanonicalText(wrapped, { baseUrl: options.baseUrl });
    const afterClaims = extractClaimsFromSignedSection(wrapped);
    if (afterText !== beforeText || JSON.stringify(afterClaims) !== JSON.stringify(beforeClaims)) {
      throw fail("conversion-lossy", "wrapping changed canonical content or claims");
    }
  } catch (error) {
    if (error.code === "conversion-lossy") throw error;
    const code = errorCode(error);
    throw fail(code, String(error?.message || code), errorContext(error));
  }
  return wrapped;
}
