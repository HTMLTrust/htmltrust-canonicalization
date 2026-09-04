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
// misnested elements, table foster parenting, p-closing, nested headings,
// nested anchors). It runs BEFORE the real parser, on the raw source; if
// it finds nothing to reject, the source has nothing left for a real
// parser's error recovery to silently paper over, so handing it to
// parse5/DOMParser afterward is safe.
//
// Two checks that are semantic policy rather than syntax are folded in
// here too, because the draft lists them alongside the syntactic ones:
// foreign-content integration points (`svg`, `math`, `foreignObject`) and
// the 256-element nesting limit (reported as resource-limit-exceeded, not
// parser-profile-unsupported). That 256 figure has no source in the
// draft's own resource-limits table (it lists no nesting-depth row at
// all); it is pinned entirely by the conformance fixtures
// (extract/resource-element-depth-limit.json and its siblings, and
// jcs/resource-nesting-limit.json, all independently converging on 256).
//
// Scope this module deliberately does NOT cover: the HTML5 optional-
// end-tag list beyond the cases below (dt/dd, option, colgroup, and a
// few others still require an explicit end tag here even though the
// HTML Standard permits omitting it -- every accepted fixture closes its
// elements explicitly, so this is conservative rather than wrong); and
// the wider set of WHATWG tokenizer parse errors an adversarial review
// found this scanner does not model (an unquoted attribute value
// containing a stray quote, a DOCTYPE appearing mid-fragment, a bare `<`
// followed by whitespace, an end tag carrying attributes or a trailing
// solidus). Implementing the full parse-error set is a larger, separate
// piece of work; see README.md's ambiguity 2 for the reasoning and the
// cases this scanner is known to accept that a from-scratch WHATWG
// tokenizer would reject.

import { fail } from './errors.js';
import { matchEntityName, MAX_ENTITY_NAME_LENGTH } from './entities-data.js';

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'source', 'track', 'wbr',
]);

// RAWTEXT elements: the tokenizer does not parse their content as markup
// or decode character references in it at all; see `parser-raw-text-is-data`.
const RAWTEXT_ELEMENTS = new Set(['script', 'style', 'iframe', 'noembed', 'noframes', 'noscript', 'xmp']);

// RCDATA elements: content is not parsed as markup (a "<" is literal), but
// character references ARE decoded, exactly as in ordinary text. Treating
// these the same as RAWTEXT was a confirmed defect: a malformed reference
// inside <textarea>/<title> was silently accepted and its parser-repaired
// decoding emitted, when the same reference in a <p> was correctly
// rejected (review finding "Scope limit 2").
const RCDATA_ELEMENTS = new Set(['textarea', 'title']);

// Foreign-content integration points the profile excludes outright
// (section 4.1.1), regardless of well-formedness. Matched by tag name
// alone -- `parser-foreign-object-standalone` rejects a bare
// `<foreignObject>` even outside an `<svg>` wrapper, so this is not
// conditioned on actual SVG/MathML namespace context. `math` is included
// by analogy with `svg`: the draft names foreign content generally, and
// MathML is HTML's other foreign namespace, though no fixture forces it
// the way the svg and foreignObject cases do.
const FOREIGN_ELEMENTS = new Set(['svg', 'math', 'foreignobject']);

// "Current node" names for which content is foster-parented out of the
// table by the HTML5 tree-construction algorithm's "in table" insertion
// mode: a start tag or non-whitespace text that is not one of the names
// below (or style/script/template, handled separately) is moved to just
// before the table rather than inserted where it appears in the source.
const TABLE_TEXT_CONTEXT = new Set(['table', 'tbody', 'thead', 'tfoot', 'tr']);
const ALWAYS_ALLOWED_IN_TABLE_CONTEXT = new Set([
  'caption', 'col', 'colgroup', 'tbody', 'tfoot', 'thead', 'tr', 'td', 'th',
  'style', 'script', 'template',
]);

// Table-structure elements that HTML5's "in body" insertion mode ignores
// as a parse error when there is no enclosing <table> at all (a bare
// `<td>a</td>` with no table ancestor).
const TABLE_STRUCTURE_ONLY_TAGS = new Set(['caption', 'col', 'colgroup', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr']);

// HTML5's "in body" insertion mode implicitly closes an open <p> (in
// button scope) when a start tag with one of these names is seen. Under
// this profile's explicit-end-tag-only rule, an implicit close a source
// document then relies on (however invisibly, since the later `</p>`
// still appears) is a misnesting parse error: that `</p>` has nothing
// left to close once tree construction runs for real.
const P_CLOSING_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog',
  'dir', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main',
  'menu', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'ul',
]);

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

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
// these regardless of tokenizer state, so this check applies uniformly:
// in text content, inside raw-text/RCDATA element content, and inside
// attribute values.
function isForbiddenControl(cp) {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0c || cp === 0x0d) return false;
  if (cp <= 0x1f || cp === 0x7f) return true;
  if (cp >= 0x80 && cp <= 0x9f) return true;
  return false;
}

/**
 * Find the end of a `&...` character reference starting at `amp` (the
 * index of '&'), and reject the parse-error shapes the HTML5 named- and
 * numeric-character-reference tokenizer states define. Returns the index
 * to resume scanning from.
 *
 * `inAttribute` selects the HTML Standard's one attribute-specific rule:
 * when a legacy (no-semicolon) named match is immediately followed by
 * `=` or an ASCII alphanumeric, the whole thing is treated as literal
 * text with no error (this is what lets `?a=1&copy=2` mean literal `&`,
 * not a truncated `&copy` reference). Outside an attribute value, that
 * exception does not apply.
 *
 * Four outcomes, matching the tokenizer's named-character-reference
 * state:
 *   - A full match ending in `;` (`&amp;`, `&notin;`): valid, consumed.
 *   - A match that does NOT end in `;` (`&amp B`, or `&notit;`'s longest
 *     match against legacy `&not`): missing-semicolon-after-character-
 *     reference. Rejected, unless the attribute exception above applies.
 *   - No match at all, but a `;` immediately follows the alphanumeric
 *     run (`&foo;`): unknown-named-character-reference. Rejected.
 *   - No match and no following `;` (`AT&T`, `a &b`): the silent
 *     "ambiguous ampersand" case. Not an error; '&' is literal text.
 * The numeric-reference state is analogous: `&#` or `&#x` with no digits
 * at all (absence-of-digits-in-numeric-character-reference) and a digit
 * run with no terminating `;` (missing-semicolon-after-character-
 * reference) are both rejected. So is a reference that IS digits-then-`;`
 * but whose decoded value is null-character-reference,
 * character-reference-outside-unicode-range, surrogate-character-
 * reference, noncharacter-character-reference, or control-character-
 * reference (a C0 or C1 control other than tab/LF/FF/CR): draft section
 * 4.1's prose describes decoding these forms (to U+FFFD, or through the
 * windows-1252 table), but the reference implementation rejects all of
 * them, and this profile follows that rather than the prose.
 */
function isNoncharacter(cp) {
  if (cp >= 0xfdd0 && cp <= 0xfdef) return true;
  return (cp & 0xfffe) === 0xfffe; // U+xFFFE / U+xFFFF in every plane.
}

function isRejectedNumericReferenceValue(cp) {
  if (cp === 0) return true;
  if (cp > 0x10ffff) return true;
  if (cp >= 0xd800 && cp <= 0xdfff) return true;
  if (isNoncharacter(cp)) return true;
  if (isForbiddenControl(cp)) return true;
  return false;
}

function scanCharacterReference(s, amp, inAttribute) {
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
    if (k === digitsStart) {
      fail('parser-profile-unsupported', 'numeric character reference has no digits');
    }
    if (s[k] !== ';') {
      fail('parser-profile-unsupported', 'numeric character reference missing terminating semicolon');
    }
    const value = parseInt(s.slice(digitsStart, k), hex ? 16 : 10);
    if (isRejectedNumericReferenceValue(value)) {
      fail('parser-profile-unsupported', `numeric character reference decodes to a rejected code point (U+${value.toString(16).toUpperCase()})`);
    }
    return k + 1;
  }

  if (!isAsciiAlpha(s.charCodeAt(j))) return amp + 1;

  let end = j;
  while (end < n && isAsciiAlnum(s.charCodeAt(end)) && end - j < MAX_ENTITY_NAME_LENGTH) end++;
  const hasTrailingSemicolon = end < n && s[end] === ';';
  const boundedEnd = hasTrailingSemicolon ? end + 1 : end;

  for (let k = boundedEnd; k > j; k--) {
    const candidate = s.slice(j, k);
    if (matchEntityName(candidate)) {
      if (candidate.endsWith(';')) return k;
      if (inAttribute) {
        const afterCc = s.charCodeAt(k); // NaN past EOF, which fails both checks below.
        if (s[k] === '=' || isAsciiAlnum(afterCc)) {
          return amp + 1; // Historical attribute-value exception: literal.
        }
      }
      fail('parser-profile-unsupported', `named character reference "&${candidate}" missing terminating semicolon`);
    }
  }
  if (hasTrailingSemicolon) {
    fail('parser-profile-unsupported', `unknown named character reference "&${s.slice(j, end)};"`);
  }
  return amp + 1; // No table entry matches and no semicolon follows: silent, '&' is literal text.
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

/** Scan RAWTEXT/RCDATA content: no tag/comment interpretation, just look
 * for the matching end tag (an "appropriate end tag token" in HTML5
 * terms). RCDATA additionally decodes `&` the same way ordinary text
 * does, since the HTML Standard's RCDATA tokenizer states do. */
function scanNoMarkupContent(s, i, stack) {
  const top = stack[stack.length - 1];
  const name = top.name;
  const rcdata = top.rcdata === true;
  const n = s.length;
  while (i < n) {
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
    if (rcdata && s[i] === '&') {
      i = scanCharacterReference(s, i, false);
      continue;
    }
    const cp = s.codePointAt(i);
    if (isForbiddenControl(cp)) fail('parser-profile-unsupported', 'raw C0/C1 control character in input');
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

/** Scan a quoted or unquoted attribute value, validating control
 * characters and character references exactly as text content does (with
 * the attribute-value historical exception; see scanCharacterReference).
 * Returns the index just past the value (past the closing quote, for a
 * quoted value). */
function scanAttributeValue(s, i, tagLabel) {
  if (s[i] === '"' || s[i] === "'") {
    const quote = s[i];
    i++;
    while (i < s.length && s[i] !== quote) {
      if (s[i] === '&') {
        i = scanCharacterReference(s, i, true);
        continue;
      }
      const cp = s.codePointAt(i);
      if (isForbiddenControl(cp)) fail('parser-profile-unsupported', 'raw C0/C1 control character in input');
      i += cp > 0xffff ? 2 : 1;
    }
    if (i >= s.length) fail('parser-profile-unsupported', `unterminated attribute value in <${tagLabel}>`);
    return i + 1; // past the closing quote
  }
  // Unquoted value: up to whitespace or '>'.
  while (i < s.length) {
    const cc = s.charCodeAt(i);
    if (isAsciiWhitespace(cc) || s[i] === '>') break;
    if (s[i] === '&') {
      i = scanCharacterReference(s, i, true);
      continue;
    }
    const cp = s.codePointAt(i);
    if (isForbiddenControl(cp)) fail('parser-profile-unsupported', 'raw C0/C1 control character in input');
    i += cp > 0xffff ? 2 : 1;
  }
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
      i = scanAttributeValue(s, i, tagLabel);
    }
    // Loop back for the next attribute, '/', or '>'.
  }
}

function stackHas(stack, name) {
  for (let k = 0; k < stack.length; k++) {
    if (stack[k].name === name) return true;
  }
  return false;
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

    // Misnesting the tree builder would repair implicitly, which this
    // profile's explicit-end-tag-only rule cannot allow: the repair
    // would leave a later explicit end tag in the source with nothing
    // left to close.
    if (P_CLOSING_TAGS.has(name) && stackHas(stack, 'p')) {
      fail('parser-profile-unsupported', `<${name}> while a <p> element is open implicitly closes it (misnesting)`);
    }
    if (name === 'a' && stackHas(stack, 'a')) {
      fail('parser-profile-unsupported', 'nested <a> is a misnesting parse error (adoption agency)');
    }
    if (HEADINGS.has(name) && stack.length > 0 && HEADINGS.has(stack[stack.length - 1].name)) {
      fail('parser-profile-unsupported', 'a heading element open when another heading starts is a misnesting parse error');
    }
    if (TABLE_STRUCTURE_ONLY_TAGS.has(name) && !stackHas(stack, 'table')) {
      fail('parser-profile-unsupported', `<${name}> outside a <table> is a parse error (ignored by tree construction)`);
    }
    if (stack.length > 0 && TABLE_TEXT_CONTEXT.has(stack[stack.length - 1].name) && !ALWAYS_ALLOWED_IN_TABLE_CONTEXT.has(name)) {
      fail('parser-profile-unsupported', `<${name}> would be foster-parented out of <${stack[stack.length - 1].name}>`);
    }

    const isVoid = VOID_ELEMENTS.has(name);
    if (selfClosing && !isVoid) {
      fail('parser-profile-unsupported', `non-void element <${name}> has a self-closing flag`);
    }
    if (!isVoid && !selfClosing) {
      pushElement(stack, name);
      if (RAWTEXT_ELEMENTS.has(name)) {
        stack[stack.length - 1].rawText = true;
      } else if (RCDATA_ELEMENTS.has(name)) {
        stack[stack.length - 1].rawText = true;
        stack[stack.length - 1].rcdata = true;
      }
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
    const next = scanCharacterReference(s, i, false);
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
