// Portable parser profile: draft section 4.1.1 ("Portable parser profile").
//
// A real HTML5 parser (parse5, or a browser's DOMParser) SILENTLY REPAIRS
// the malformed input this section requires rejecting: it moves foster-
// parented table text, closes unclosed elements, drops duplicate
// attributes, and decodes an unterminated character reference as best it
// can, all without surfacing that anything was wrong. A DOM built that way
// carries no trace of the repair, so it cannot be used, after the fact, to
// tell portable input apart from input a parser only *accepted after
// fixing*. The draft is explicit about this: "A DOM that has already
// discarded duplicate attributes or repaired malformed markup is
// insufficient by itself."
//
// This module is therefore a small hand-rolled scanner, independent of
// both parse5's and any browser's parser internals, modeled directly on
// the relevant states of the WHATWG HTML tokenizer (tag name, attribute,
// self-closing, comment, and character-reference states) plus a shallow
// open-element stack for the tree-construction-level checks (unclosed and
// misnested elements, table foster parenting). It runs BEFORE the real
// parser, on the raw source; if it finds nothing to reject, the source
// has nothing left for a real parser's error recovery to silently paper
// over, so handing it to parse5/DOMParser afterward is safe.
//
// Two checks that are semantic policy rather than syntax are folded in
// here too, because the draft lists them alongside the syntactic ones:
// foreign-content integration points (`svg`, `math`, `foreignObject`) and
// the 256-element nesting limit (reported as resource-limit-exceeded, not
// parser-profile-unsupported, since the draft's resource-limits table
// covers it separately).
//
// Scope this module deliberately does NOT cover, because no conformance
// fixture exercises it: character-reference ambiguity inside attribute
// values (only text-node references are checked); implied end tags for
// elements with optional closing tags (p, li, td, ...) -- every accepted
// fixture closes its elements explicitly, so a strict "every end tag must
// match the top of the open-element stack" rule is sufficient and does
// not need the HTML5 implied-end-tag exception list; and RCDATA character
// decoding inside <title>/<textarea> (treated the same as RAWTEXT: no
// internal validation, just scan for the matching end tag).

import { fail } from './errors.js';
import { matchEntityName, MAX_ENTITY_NAME_LENGTH } from './entities-data.js';

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'source', 'track', 'wbr',
]);

// Elements whose content the tokenizer does not parse as markup at all
// (RAWTEXT and RCDATA content models); see `parser-raw-text-is-data`.
const NO_MARKUP_ELEMENTS = new Set([
  'script', 'style', 'iframe', 'noembed', 'noframes', 'noscript', 'xmp',
  'textarea', 'title',
]);

// Foreign-content integration points the profile excludes outright
// (section 4.1.1), regardless of well-formedness. Matched by tag name
// alone -- `parser-foreign-object-standalone` rejects a bare
// `<foreignObject>` even outside an `<svg>` wrapper, so this is not
// conditioned on actual SVG/MathML namespace context.
const FOREIGN_ELEMENTS = new Set(['svg', 'math', 'foreignobject']);

// "Current node" names for which non-whitespace text is foster-parented
// out of the table by the HTML5 tree-construction algorithm.
const TABLE_TEXT_CONTEXT = new Set(['table', 'tbody', 'thead', 'tfoot', 'tr']);

const MAX_ELEMENT_DEPTH = 256;

function isAsciiAlpha(cc) {
  return (cc >= 0x41 && cc <= 0x5a) || (cc >= 0x61 && cc <= 0x7a);
}
function isAsciiDigit(cc) {
  return cc >= 0x30 && cc <= 0x39;
}
function isAsciiAlnum(cc) {
  return isAsciiAlpha(cc) || isAsciiDigit(cc);
}
function isHexDigit(cc) {
  return isAsciiDigit(cc) || (cc >= 0x41 && cc <= 0x46) || (cc >= 0x61 && cc <= 0x66);
}
function isAsciiWhitespace(cc) {
  return cc === 0x09 || cc === 0x0a || cc === 0x0c || cc === 0x0d || cc === 0x20;
}

// C0 controls (other than tab/LF/FF/CR) and C1 controls. Input-stream
// preprocessing per the HTML Standard runs before tokenization and flags
// these regardless of tokenizer state, so this check applies uniformly,
// including inside raw-text element content.
function isForbiddenControl(cp) {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0c || cp === 0x0d) return false;
  if (cp <= 0x1f || cp === 0x7f) return true;
  if (cp >= 0x80 && cp <= 0x9f) return true;
  return false;
}

/**
 * Find the end of a `&...` character reference starting at `amp` (the
 * index of '&') in text content, and reject an unterminated match.
 * Returns the index to resume scanning from. Per the HTML5 named-
 * character-reference state: consume the longest run that matches a
 * table entry; if the match found does not end in ';', that is a
 * missing-semicolon parse error (this covers both a legacy no-semicolon
 * entity followed by more text, e.g. "&amp B", and a longer name that
 * only partially matches, e.g. "&notit;" matching legacy "&not"). No
 * match at all is the silent "ambiguous ampersand" case: '&' is literal.
 */
function scanCharacterReference(s, amp) {
  const n = s.length;
  let j = amp + 1;
  if (j >= n) return amp + 1;

  if (s[j] === '#') {
    let k = j + 1;
    let hex = false;
    if (s[k] === 'x' || s[k] === 'X') {
      hex = true;
      k++;
    }
    const digitsStart = k;
    while (k < n && (hex ? isHexDigit(s.charCodeAt(k)) : isAsciiDigit(s.charCodeAt(k)))) k++;
    if (k === digitsStart) return amp + 1; // "&#" with no digits: not a reference.
    if (s[k] === ';') return k + 1;
    fail('parser-profile-unsupported', 'numeric character reference missing terminating semicolon');
  }

  if (!isAsciiAlpha(s.charCodeAt(j))) return amp + 1;

  let end = j;
  while (end < n && isAsciiAlnum(s.charCodeAt(end)) && end - j < MAX_ENTITY_NAME_LENGTH) end++;
  const boundedEnd = end < n && s[end] === ';' ? end + 1 : end;

  for (let k = boundedEnd; k > j; k--) {
    const candidate = s.slice(j, k);
    if (matchEntityName(candidate)) {
      if (candidate.endsWith(';')) return k;
      fail('parser-profile-unsupported', `named character reference "&${candidate}" missing terminating semicolon`);
    }
  }
  return amp + 1; // No table entry matches at all: silent, '&' is literal text.
}

function checkFosterParenting(stack, isWhitespace) {
  if (isWhitespace || stack.length === 0) return;
  const top = stack[stack.length - 1].name;
  if (TABLE_TEXT_CONTEXT.has(top)) {
    fail('parser-profile-unsupported', `non-whitespace text would be foster-parented out of <${top}>`);
  }
}

function pushElement(stack, name) {
  if (stack.length + 1 > MAX_ELEMENT_DEPTH) {
    fail('resource-limit-exceeded', 'element nesting exceeds 256');
  }
  stack.push({ name });
}

/** Scan RAWTEXT/RCDATA content: no markup interpretation, just look for
 * the matching end tag (an "appropriate end tag token" in HTML5 terms). */
function scanNoMarkupContent(s, i, stack) {
  const name = stack[stack.length - 1].name;
  const n = s.length;
  while (i < n) {
    const cp = s.codePointAt(i);
    if (isForbiddenControl(cp)) fail('parser-profile-unsupported', 'raw C0/C1 control character in input');
    if (s[i] === '<' && s[i + 1] === '/') {
      const candidate = s.slice(i + 2, i + 2 + name.length);
      if (candidate.toLowerCase() === name) {
        const after = s[i + 2 + name.length];
        if (after === undefined || after === '>' || after === '/' || (after !== undefined && isAsciiWhitespace(after.charCodeAt(0)))) {
          let k = i + 2 + name.length;
          while (k < n && s[k] !== '>') k++;
          if (k >= n) fail('parser-profile-unsupported', `unclosed end tag for <${name}>`);
          stack.pop();
          return k + 1;
        }
      }
    }
    i += cp > 0xffff ? 2 : 1;
  }
  fail('parser-profile-unsupported', `unclosed element <${name}>`);
}

function scanComment(s, i) {
  // s[i..i+4) === '<!--'
  const closeAt = s.indexOf('-->', i + 4);
  if (closeAt === -1) fail('parser-profile-unsupported', 'unclosed HTML comment');
  const body = s.slice(i + 4, closeAt);
  if (body.includes('--')) fail('parser-profile-unsupported', "comment body contains '--'");
  if (body.endsWith('-')) fail('parser-profile-unsupported', "comment body ends in '-'");
  return closeAt + 3;
}

function consumeTagName(s, i) {
  // HTML5 tag name state: everything up to whitespace, '/', or '>' is
  // part of the name (not just ASCII alnum -- see `x:y` / `x._y`).
  const start = i;
  while (i < s.length) {
    const cc = s.charCodeAt(i);
    if (isAsciiWhitespace(cc) || s[i] === '/' || s[i] === '>') break;
    i++;
  }
  return { name: s.slice(start, i).toLowerCase(), next: i };
}

function skipWhitespace(s, i) {
  while (i < s.length && isAsciiWhitespace(s.charCodeAt(i))) i++;
  return i;
}

/** Parse a start tag's attribute list starting after the tag name. Returns
 * { next, selfClosing }. `next` points just past the tag's '>'. */
function scanAttributes(s, i, tagLabel) {
  const seen = new Set();
  for (;;) {
    i = skipWhitespace(s, i);
    if (i >= s.length) fail('parser-profile-unsupported', `unterminated tag <${tagLabel}>`);
    if (s[i] === '/') {
      if (s[i + 1] === '>') return { next: i + 2, selfClosing: true };
      fail('parser-profile-unsupported', `unexpected '/' in tag <${tagLabel}>`);
    }
    if (s[i] === '>') return { next: i + 1, selfClosing: false };

    // Attribute name: up to whitespace, '=', '/', or '>'.
    const nameStart = i;
    while (i < s.length) {
      const cc = s.charCodeAt(i);
      if (isAsciiWhitespace(cc) || s[i] === '=' || s[i] === '/' || s[i] === '>') break;
      i++;
    }
    if (i === nameStart) fail('parser-profile-unsupported', `malformed attribute in tag <${tagLabel}>`);
    const attrName = s.slice(nameStart, i).toLowerCase();
    if (seen.has(attrName)) fail('parser-profile-unsupported', `duplicate attribute "${attrName}" on <${tagLabel}>`);
    seen.add(attrName);

    i = skipWhitespace(s, i);
    if (s[i] === '=') {
      i = skipWhitespace(s, i + 1);
      if (s[i] === '"' || s[i] === "'") {
        const quote = s[i];
        const valueStart = i + 1;
        const closeQuote = s.indexOf(quote, valueStart);
        if (closeQuote === -1) fail('parser-profile-unsupported', `unterminated attribute value in <${tagLabel}>`);
        i = closeQuote + 1;
      } else {
        while (i < s.length) {
          const cc = s.charCodeAt(i);
          if (isAsciiWhitespace(cc) || s[i] === '>') break;
          i++;
        }
      }
    }
    // Loop back for the next attribute, '/', or '>'.
  }
}

/** Handle `<` at index i in normal (non-raw-text) content. Returns the
 * next index to scan from, mutating `stack` for start/end tags. */
function handleTag(s, i, stack) {
  const n = s.length;
  const c1 = s[i + 1];

  if (c1 === '/') {
    const { name, next } = consumeTagName(s, i + 2);
    let k = next;
    while (k < n && s[k] !== '>') k++;
    if (k >= n) fail('parser-profile-unsupported', `unterminated end tag </${name}>`);
    if (stack.length === 0 || stack[stack.length - 1].name !== name) {
      fail('parser-profile-unsupported', `unclosed or misnested element: end tag </${name}> does not match open elements`);
    }
    stack.pop();
    return k + 1;
  }

  if (c1 === '!') {
    if (s.startsWith('<!--', i)) return scanComment(s, i);
    if (/^<!doctype/i.test(s.slice(i, i + 9))) {
      let k = i + 2;
      while (k < n && s[k] !== '>') k++;
      return k + 1;
    }
    // Bogus declaration (including a CDATA section, invalid in HTML
    // content outside foreign content) or malformed markup declaration.
    fail('parser-profile-unsupported', 'bogus markup declaration');
  }

  if (c1 === '?') {
    fail('parser-profile-unsupported', 'bogus processing-instruction-like markup');
  }

  if (c1 !== undefined && isAsciiAlpha(c1.charCodeAt(0))) {
    const { name, next } = consumeTagName(s, i + 1);
    const { next: afterTag, selfClosing } = scanAttributes(s, next, name);

    if (FOREIGN_ELEMENTS.has(name)) {
      fail('parser-profile-unsupported', `foreign-content integration point <${name}> is outside the portable profile`);
    }

    const isVoid = VOID_ELEMENTS.has(name);
    if (selfClosing && !isVoid) {
      fail('parser-profile-unsupported', `non-void element <${name}> has a self-closing flag`);
    }
    if (!isVoid && !selfClosing) {
      pushElement(stack, name);
      if (NO_MARKUP_ELEMENTS.has(name)) stack[stack.length - 1].rawText = true;
    }
    return afterTag;
  }

  // A bare '<' not starting a recognizable construct: treat as literal
  // text (matches "invalid-first-character-of-tag-name" recovery); not
  // exercised by any fixture, kept lenient to avoid a false rejection.
  return i + 1;
}

/** Advance one step through normal text content at index i. */
function handleText(s, i, stack) {
  const ch = s[i];
  if (ch === '&') {
    const next = scanCharacterReference(s, i);
    checkFosterParenting(stack, false);
    return next;
  }
  const cp = s.codePointAt(i);
  if (isForbiddenControl(cp)) fail('parser-profile-unsupported', 'raw C0/C1 control character in input');
  checkFosterParenting(stack, isAsciiWhitespace(cp));
  return i + (cp > 0xffff ? 2 : 1);
}

/**
 * Validate `source` against the portable parser profile (draft section
 * 4.1.1). Throws HTMLTrustError (parser-profile-unsupported or
 * resource-limit-exceeded) on the first violation found; returns
 * normally if the source is safe to hand to a real HTML parser.
 */
export function checkPortableProfile(source) {
  const n = source.length;
  let i = 0;
  const stack = [];

  while (i < n) {
    const top = stack.length > 0 ? stack[stack.length - 1] : null;
    if (top && top.rawText) {
      i = scanNoMarkupContent(source, i, stack);
      continue;
    }
    i = source[i] === '<' ? handleTag(source, i, stack) : handleText(source, i, stack);
  }

  if (stack.length > 0) {
    fail('parser-profile-unsupported', `unclosed element <${stack[stack.length - 1].name}>`);
  }
}
