//! HTMLTrust canonicalization (Rust binding).
//!
//! Public API:
//!
//! - [`normalize_text`] -- the 8-phase HTMLTrust canonicalization pipeline.
//! - [`extract_canonical_text`] -- HTML -> canonical text extraction
//!   (spec §2.1), parses with `scraper` (html5ever) and walks the DOM.
//! - [`canonicalize_claims`] -- canonical serialization of claim metadata
//!   for the `claims-hash` field of the signature binding.
//!
//! All three functions produce byte-identical output to the JavaScript,
//! Go, PHP, and Python bindings. The 18 conformance cases in
//! `tests/conformance.rs` are a direct port of the shared test suite
//! (`htmltrust-canonicalization/javascript/test.js`).

use std::collections::BTreeMap;

use scraper::{node::Node, Html};
use ego_tree::NodeRef;
use unicode_normalization::UnicodeNormalization;

// ---------------------------------------------------------------------------
// Codepoint ranges, mirroring the JS reference regex character classes
// byte-for-byte. Inclusive ranges. Single codepoints expressed as
// (cp, cp).
// ---------------------------------------------------------------------------

/// Phase 6 + 7: invisible / formatting / bidi characters to strip.
/// ZWNJ (U+200C) and ZWJ (U+200D) are deliberately preserved -- they are
/// semantic in Persian, Indic, and emoji.
const STRIP_RANGES: &[(u32, u32)] = &[
    (0x00AD, 0x00AD), // soft hyphen
    (0x200B, 0x200B), // zero-width space
    (0x200E, 0x200E), // LRM
    (0x200F, 0x200F), // RLM
    (0x2060, 0x2060), // word joiner
    (0xFEFF, 0xFEFF), // BOM / ZWNBSP
    (0x034F, 0x034F), // combining grapheme joiner
    (0x061C, 0x061C), // arabic letter mark
    (0x180E, 0x180E), // mongolian vowel separator
    (0x0640, 0x0640), // arabic tatweel
    (0xFE00, 0xFE0F), // variation selectors 1-16
    (0x202A, 0x202E), // bidi embedding controls
    (0x2066, 0x2069), // bidi isolate controls
    (0x2061, 0x2064), // invisible math operators
    (0xFFF9, 0xFFFC), // interlinear annotation + obj replacement
    // Supplementary plane: variation selectors 17-256, tag characters.
    (0xE0001, 0xE007F),
    (0xE0100, 0xE01EF),
];

/// Phase 2: Unicode whitespace -> U+0020.
const WHITESPACE_RANGES: &[(u32, u32)] = &[
    (0x0009, 0x000D), // HT, LF, VT, FF, CR
    (0x0020, 0x0020), // SPACE
    (0x0085, 0x0085), // NEL
    (0x00A0, 0x00A0), // NBSP
    (0x1680, 0x1680), // ogham space mark
    (0x2000, 0x200A), // en quad .. hair space
    (0x2028, 0x2028), // line separator
    (0x2029, 0x2029), // paragraph separator
    (0x202F, 0x202F), // narrow no-break space
    (0x205F, 0x205F), // medium mathematical space
    (0x3000, 0x3000), // ideographic space
];

/// Phase 3: single quotes -> ASCII apostrophe.
const SINGLE_QUOTE_POINTS: &[u32] = &[
    0x2018, // left single quote
    0x2019, // right single quote
    0x201B, // single high-reversed-9
    0x2039, // single left guillemet
    0x203A, // single right guillemet
    0x0060, // grave accent
    0x00B4, // acute accent
    0x2032, // prime
];

/// Phase 3: double quotes -> ASCII double quote.
const DOUBLE_QUOTE_POINTS: &[u32] = &[
    0x201A, // single low-9 quote (intentionally mapped to double)
    0x201C, // left double quote
    0x201D, // right double quote
    0x201E, // low double quote
    0x201F, // double high-reversed-9
    0x00AB, // left guillemet
    0x00BB, // right guillemet
    0x2033, // double prime
    0x301D, // reversed double prime quotation mark
    0x301E, // double prime quotation mark
    0x301F, // low double prime quotation mark
];

/// Phase 3: CJK corner brackets -> ASCII double quote.
const CJK_QUOTE_RANGES: &[(u32, u32)] = &[
    (0x300C, 0x300F), // CJK corner brackets
    (0xFE41, 0xFE44), // presentation forms for vertical corner brackets
];

/// Phase 4: dashes -> ASCII hyphen-minus.
const DASH_POINTS: &[u32] = &[
    0x2212, // minus sign
    0xFE58, // small em dash
    0xFE63, // small hyphen-minus
];
const DASH_RANGES: &[(u32, u32)] = &[
    (0x2010, 0x2015), // hyphen .. horizontal bar
];

/// Phase 5: ellipsis -> three periods.
const ELLIPSIS: char = '\u{2026}';

// ---------------------------------------------------------------------------
// Range / point membership helpers (linear; the sets are tiny).
// ---------------------------------------------------------------------------

fn in_ranges(c: char, ranges: &[(u32, u32)]) -> bool {
    let cp = c as u32;
    ranges.iter().any(|&(start, end)| cp >= start && cp <= end)
}

fn in_points(c: char, points: &[u32]) -> bool {
    points.contains(&(c as u32))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Apply the HTMLTrust 8-phase canonicalization pipeline to `text`.
///
/// Order matches the JavaScript reference implementation precisely.
///
/// # Arguments
///
/// * `text` -- raw text content (typically the output of
///   [`extract_canonical_text`]).
/// * `preserve_whitespace` -- `true` for `<pre>` content where whitespace
///   is significant; otherwise `false`.
///
/// # Returns
///
/// Normalized text, suitable for hashing.
pub fn normalize_text(text: &str, preserve_whitespace: bool) -> String {
    // Phase 1: NFKC.
    let nfkc: String = text.nfkc().collect();

    // Phases 6 + 7: strip invisible / formatting / bidi characters.
    let stripped: String = nfkc.chars().filter(|&c| !in_ranges(c, STRIP_RANGES)).collect();

    // Phase 2: whitespace normalization.
    let ws: String = if preserve_whitespace {
        stripped
    } else {
        let mut buf = String::with_capacity(stripped.len());
        let mut prev_space = false;
        for c in stripped.chars() {
            if in_ranges(c, WHITESPACE_RANGES) {
                if !prev_space {
                    buf.push(' ');
                    prev_space = true;
                }
            } else {
                buf.push(c);
                prev_space = false;
            }
        }
        buf
    };

    // Phases 3, 4, 5 in a single pass.
    let mut out = String::with_capacity(ws.len());
    for c in ws.chars() {
        if in_points(c, SINGLE_QUOTE_POINTS) {
            out.push('\'');
        } else if in_points(c, DOUBLE_QUOTE_POINTS) || in_ranges(c, CJK_QUOTE_RANGES) {
            out.push('"');
        } else if in_points(c, DASH_POINTS) || in_ranges(c, DASH_RANGES) {
            out.push('-');
        } else if c == ELLIPSIS {
            out.push_str("...");
        } else {
            out.push(c);
        }
    }
    out
}

/// Extract canonical text from an HTML fragment.
///
/// Implements the HTML -> canonical text extraction defined in spec §2.1
/// and ports the contract of the JavaScript `extractCanonicalText`. Uses
/// `scraper` (html5ever under the hood) for parsing.
///
/// # Arguments
///
/// * `html` -- HTML fragment to canonicalize.
///
/// # Returns
///
/// Canonical text, ready to be hashed. Trimmed of leading/trailing
/// whitespace.
pub fn extract_canonical_text(html: &str) -> String {
    let document = Html::parse_fragment(html);

    let mut out = String::new();
    walk(document.tree.root(), &mut out);

    normalize_text(&out, false).trim().to_string()
}

fn is_excluded_tag(name: &str) -> bool {
    matches!(
        name,
        "script" | "style" | "meta" | "link" | "head" | "noscript"
    )
}

fn is_block_tag(name: &str) -> bool {
    matches!(
        name,
        "address"
            | "article"
            | "aside"
            | "blockquote"
            | "canvas"
            | "dd"
            | "div"
            | "dl"
            | "dt"
            | "fieldset"
            | "figcaption"
            | "figure"
            | "footer"
            | "form"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "header"
            | "hr"
            | "li"
            | "main"
            | "nav"
            | "noscript"
            | "ol"
            | "output"
            | "p"
            | "pre"
            | "section"
            | "table"
            | "tfoot"
            | "thead"
            | "tr"
            | "td"
            | "th"
            | "ul"
            | "video"
    )
}

fn walk<'a>(node: NodeRef<'a, Node>, out: &mut String) {
    for child in node.children() {
        match child.value() {
            Node::Text(t) => {
                out.push_str(&t.text);
            }
            Node::Element(e) => {
                let name = e.name();
                if is_excluded_tag(name) {
                    continue;
                }
                let block = is_block_tag(name);
                if block {
                    out.push(' ');
                }
                walk(child, out);
                if block {
                    out.push(' ');
                }
            }
            _ => {
                // Comments, doctypes, processing instructions -- not signed.
            }
        }
    }
}

/// Compute the canonical serialization of a claim map.
///
/// Each name and value is run through [`normalize_text`] and entries are
/// sorted lexically by name, then joined by `\n` as `name=value` pairs.
/// The caller is responsible for hashing the result.
///
/// `BTreeMap` is used as the input type because its iteration order is
/// already lexicographic, which makes the determinism property obvious
/// at the type level. Callers with other map types can pass via
/// `BTreeMap::from_iter(...)`.
pub fn canonicalize_claims(claims: &BTreeMap<String, String>) -> String {
    let mut entries: Vec<(String, String)> = claims
        .iter()
        .map(|(k, v)| (normalize_text(k, false), normalize_text(v, false)))
        .collect();
    // Re-sort after normalization in case normalization changes name order.
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    entries
        .into_iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join("\n")
}
