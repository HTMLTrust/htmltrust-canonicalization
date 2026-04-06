/**
 * HTMLTrust Canonical Text Normalization
 * Spec: https://github.com/ArcadeLabsInc/htmltrust-canonicalization
 *
 * Zero dependencies. Works in browsers and Node.js.
 */

// Phase 6: Invisible/formatting characters to strip
const STRIP_RE = new RegExp(
  [
    "\\u00AD", // soft hyphen
    "\\u200B", // zero-width space
    "\\u200E", // LRM
    "\\u200F", // RLM
    "\\u2060", // word joiner
    "\\uFEFF", // BOM / ZWNBSP
    "\\u034F", // combining grapheme joiner
    "\\u061C", // arabic letter mark
    "\\u180E", // mongolian vowel separator
    "\\u0640", // arabic tatweel
    "[\\uFE00-\\uFE0F]", // variation selectors 1-16
    "[\\u202A-\\u202E]", // bidi embedding controls
    "[\\u2066-\\u2069]", // bidi isolate controls
    "[\\u2061-\\u2064]", // invisible math operators
    "[\\uFFF9-\\uFFFC]", // interlinear annotation + obj replacement
  ].join("|"),
  "gu",
);

// Supplementary plane stripping (variation selectors 17-256, tag characters)
const STRIP_SUPPLEMENTARY_RE = /[\u{E0001}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

// Phase 2: All Unicode whitespace → U+0020
const WHITESPACE_RE =
  /[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g;

// Phase 3: Quotation mark normalization
const SINGLE_QUOTE_RE = /[\u2018\u2019\u201B\u2039\u203A\u0060\u00B4\u2032]/g;
const DOUBLE_QUOTE_RE =
  /[\u201A\u201C\u201D\u201E\u201F\u00AB\u00BB\u2033\u301D\u301E\u301F]/g;
const CJK_QUOTE_RE = /[\u300C\u300D\u300E\u300F\uFE41-\uFE44]/g;

// Phase 4: Dashes → U+002D (includes minus sign from Phase 5)
const DASH_RE = /[\u2010-\u2015\u2212\uFE58\uFE63]/g;

// Phase 5: Ellipsis → three periods
const ELLIPSIS_RE = /\u2026/g;

/**
 * Normalize text content for canonical signing.
 * Apply AFTER extracting text from DOM, BEFORE hashing.
 *
 * Implements all 8 phases of the HTMLTrust canonicalization spec:
 *   1. NFKC normalization
 *   2. Whitespace normalization
 *   3. Quotation mark normalization
 *   4. Dash/hyphen normalization
 *   5. Other punctuation normalization
 *   6. Strip invisible/formatting characters
 *   7. Bidi control removal (handled by phase 6)
 *   8. Language-specific handling (NFKC + preserve ZWNJ/ZWJ)
 *
 * @param {string} text - Raw text content
 * @param {object} [options] - Options
 * @param {boolean} [options.preserveWhitespace=false] - Set true for <pre> content
 * @returns {string} Normalized text
 */
export function normalizeText(text, options = {}) {
  const { preserveWhitespace = false } = options;

  // Phase 1: Unicode NFKC normalization
  // Handles ~80% of equivalences: ligatures, fullwidth/halfwidth,
  // presentation forms, superscripts, CJK compatibility, Jamo composition
  text = text.normalize("NFKC");

  // Phase 6 + 7: Strip invisible/formatting/bidi characters
  // (Done early so they don't interfere with other phases)
  // Preserves ZWNJ (U+200C) and ZWJ (U+200D) — semantic in Persian, Indic, emoji
  text = text.replace(STRIP_RE, "");
  text = text.replace(STRIP_SUPPLEMENTARY_RE, "");

  // Phase 2: Whitespace normalization
  if (!preserveWhitespace) {
    text = text.replace(WHITESPACE_RE, " ");
    text = text.replace(/ {2,}/g, " ");
  }

  // Phase 3: Quotation mark normalization
  text = text.replace(SINGLE_QUOTE_RE, "'");
  text = text.replace(DOUBLE_QUOTE_RE, '"');
  text = text.replace(CJK_QUOTE_RE, '"');

  // Phase 4: Dash and hyphen normalization
  text = text.replace(DASH_RE, "-");

  // Phase 5: Other punctuation
  text = text.replace(ELLIPSIS_RE, "...");

  return text;
}
