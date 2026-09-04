// Text normalization: draft-grey-htmltrust-00 section 4.4 ("Text normalization").
//
// Four phases, applied in order to every Text node's data (and, per section
// 4.6, to claim names and claim values):
//
//   1. Unicode Normalization Form NFKC.
//   2. Strip a fixed list of formatting characters that carry no content
//      semantics (BOM, ZWSP, bidi marks, variation selectors, ...), while
//      preserving ZWNJ and ZWJ, which ARE semantic in Persian/Kurdish/Syriac
//      and Indic scripts and emoji sequences respectively.
//   3. Map a wide set of Unicode whitespace code points to U+0020 SPACE,
//      then collapse runs of two or more spaces to one.
//   4. Normalize curly quotes, guillemets, CJK corner brackets, dashes, and
//      ellipsis characters to their ASCII equivalents.
//
// This module does not do leading/trailing trimming or blank-line collapse:
// that is block-structure post-processing (section 4.5), applied once to
// the whole assembled canonical-content buffer during extraction, not to
// each text node in isolation. The `normalize` conformance suite exercises
// exactly the four phases below, with no block context.

// Phase 2: characters removed entirely. Ranges are listed as [start, end]
// (inclusive); a bare number is a single code point.
const STRIP_RANGES = [
  0x00ad, // SOFT HYPHEN
  0x200b, // ZERO WIDTH SPACE
  0x200e, // LEFT-TO-RIGHT MARK
  0x200f, // RIGHT-TO-LEFT MARK
  0x2060, // WORD JOINER
  0xfeff, // BYTE ORDER MARK / ZERO WIDTH NO-BREAK SPACE
  0x034f, // COMBINING GRAPHEME JOINER
  0x061c, // ARABIC LETTER MARK
  0x180e, // MONGOLIAN VOWEL SEPARATOR
  0x0640, // ARABIC TATWEEL
  [0xfe00, 0xfe0f], // VARIATION SELECTORS 1-16
  [0xe0100, 0xe01ef], // VARIATION SELECTORS 17-256
  [0xe0001, 0xe007f], // TAG CHARACTERS
  [0x202a, 0x202e], // BIDI EMBEDDING CONTROLS
  [0x2066, 0x2069], // BIDI ISOLATE CONTROLS
  [0x2061, 0x2064], // INVISIBLE MATH OPERATORS
  [0xfff9, 0xfffc], // INTERLINEAR ANNOTATION ANCHORS / OBJECT REPLACEMENT
];

// Phase 3: code points replaced with U+0020 SPACE outside <pre> (this
// revision gives <pre> no special treatment; see section 4.4.3).
const WHITESPACE_CODEPOINTS = new Set([
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0085, 0x00a0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

// Phase 4: punctuation normalization tables.
const SINGLE_QUOTES = new Set([
  0x2018, 0x2019, 0x201a, 0x201b, 0x2032, 0x2039, 0x203a, 0x0060, 0x00b4,
]);
const DOUBLE_QUOTES = new Set([
  0x201c, 0x201d, 0x201e, 0x201f, 0x2033, 0x00ab, 0x00bb, 0x300c, 0x300d,
  0x300e, 0x300f, 0x301d, 0x301e, 0x301f, 0xfe41, 0xfe42, 0xfe43, 0xfe44,
]);
const DASHES = new Set([
  0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0xfe58, 0xfe63,
]);
const ELLIPSES = new Set([0x2026, 0xfe19]);

function buildStripSet() {
  const set = new Set();
  for (const entry of STRIP_RANGES) {
    if (Array.isArray(entry)) {
      for (let cp = entry[0]; cp <= entry[1]; cp++) set.add(cp);
    } else {
      set.add(entry);
    }
  }
  return set;
}
const STRIP_SET = buildStripSet();

/**
 * Iterate the Unicode scalar values (code points) of a string, correctly
 * pairing UTF-16 surrogates. A lone surrogate (which cannot occur in
 * well-formed text extracted from a conformant HTML/DOM API, but could
 * appear in a raw JS string) is yielded as its own code point; U+FFFD is
 * not substituted here, since normalize_text does not define that.
 */
function* codePoints(str) {
  for (const ch of str) {
    yield ch.codePointAt(0);
  }
}

/**
 * Apply the four normalize_text phases (draft section 4.4) to a string.
 * Returns the normalized string. Does not trim or collapse blank lines;
 * that is a caller concern (see module comment above).
 */
export function normalizeText(input) {
  // Phase 1: NFKC. JavaScript's String.prototype.normalize implements the
  // Unicode Normalization Forms directly from the Unicode Character
  // Database; it is a language primitive, not something borrowed from any
  // HTMLTrust implementation.
  let s = input.normalize('NFKC');

  // Phase 2 + 3 + 4 in one pass over code points, building the output.
  let out = '';
  let lastWasSpace = false;
  for (const cp of codePoints(s)) {
    if (STRIP_SET.has(cp)) {
      continue; // Phase 2: drop entirely.
    }
    if (cp === 0x0020 || WHITESPACE_CODEPOINTS.has(cp)) {
      // Phase 3: map to space, collapse runs of 2+ (including runs made up
      // of already-ASCII spaces) to one.
      if (!lastWasSpace) {
        out += ' ';
        lastWasSpace = true;
      }
      continue;
    }
    lastWasSpace = false;
    if (SINGLE_QUOTES.has(cp)) {
      out += "'";
    } else if (DOUBLE_QUOTES.has(cp)) {
      out += '"';
    } else if (DASHES.has(cp)) {
      out += '-';
    } else if (ELLIPSES.has(cp)) {
      out += '...';
    } else {
      out += String.fromCodePoint(cp);
    }
  }
  return out;
}

/**
 * Escape U+0040 COMMERCIAL AT by doubling it. Applied to normalized text
 * node content and to normalized signed-attribute values immediately
 * before they are appended to canonical content (section 4.3.2), so a
 * literal "@attr:" in source text can never be confused with a real
 * attribute record.
 */
export function escapeAt(str) {
  return str.replace(/@/g, '@@');
}

/**
 * normalizeText, plus a leading/trailing trim of the single U+0020 spaces
 * phase 3 leaves behind. draft section 4.4 defines one normalize_text
 * procedure and reuses it, by reference, for several different fields
 * without saying which of them trim; this function is what this
 * implementation calls normalize_field in README.md's ambiguity 1, for
 * the two call sites confirmed (against the Rust core) to trim:
 *
 *   - section 4.6 claim name/value ("empty-name-fails": a claim name of
 *     a single space normalizes to the empty string).
 *   - section 4.3.2 the alt/aria-label signed attributes (an image
 *     `alt=" x "` produces the attribute record "...alt:x", not
 *     "...alt: x").
 *
 * It is deliberately NOT what extraction applies to each Text node's own
 * data, nor what the standalone `normalize` conformance suite calls: a
 * node holding "hello " immediately before an inline `<em>world</em>`
 * would lose the word-separating space if trimmed in isolation, and the
 * Rust core's `normalize` suite output for " a " is " a ", not "a".
 * Extraction instead assembles the whole buffer first and trims around
 * block boundaries afterward (see extract.js).
 */
export function normalizeStandaloneText(input) {
  return normalizeText(input).trim();
}
