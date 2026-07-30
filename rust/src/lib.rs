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
use url::Url;

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
    0x201A, // single low-9 quote (single-quote class per draft §4.4.4)
    0x201B, // single high-reversed-9
    0x2039, // single left guillemet
    0x203A, // single right guillemet
    0x0060, // grave accent
    0x00B4, // acute accent
    0x2032, // prime
];

/// Phase 3: double quotes -> ASCII double quote.
const DOUBLE_QUOTE_POINTS: &[u32] = &[
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
    extract_canonical_text_with_base_url(html, None)
}

/// Extract canonical text from an HTML fragment, resolving relative signed
/// semantic URL attributes against `base_url` when supplied.
pub fn extract_canonical_text_with_base_url(html: &str, base_url: Option<&str>) -> String {
    try_extract_canonical_text_with_base_url(html, base_url)
        .expect("attribute-canonicalization-failed")
}

/// Fallible form of [`extract_canonical_text_with_base_url`].
pub fn try_extract_canonical_text_with_base_url(
    html: &str,
    base_url: Option<&str>,
) -> Result<String, String> {
    let document = Html::parse_fragment(html);
    let base = match base_url {
        Some(raw) => Some(Url::parse(raw).map_err(|_| "attribute-canonicalization-failed".to_string())?),
        None => None,
    };

    let mut out = String::new();
    walk(document.tree.root(), &mut out, base.as_ref())?;

    Ok(finalize_parts(&out))
}

fn is_excluded_tag(name: &str) -> bool {
    matches!(
        name,
        "script" | "style" | "meta" | "link" | "head" | "noscript" | "template" | "iframe"
    )
}

fn is_block_tag(name: &str) -> bool {
    matches!(
        name,
        "address"
            | "article"
            | "aside"
            | "blockquote"
            | "details"
            | "dialog"
            | "div"
            | "dl"
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
            | "hgroup"
            | "hr"
            | "li"
            | "main"
            | "nav"
            | "ol"
            | "p"
            | "pre"
            | "section"
            | "table"
            | "tr"
            | "td"
            | "th"
            | "ul"
    )
}

fn walk<'a>(root: NodeRef<'a, Node>, out: &mut String, base_url: Option<&Url>) -> Result<(), String> {
    // Iterative depth-first walk with an explicit heap stack, equivalent to the
    // natural recursion but bounded by heap rather than the call stack. Real-world
    // DOMs can nest deeply enough to overflow a native thread stack (a latent
    // denial-of-service on the signer/verifier) and, more acutely, the small
    // WebAssembly stack; an explicit stack removes both failure modes while
    // producing byte-identical output.
    //
    // Per element the emission order is: attribute records, then the element's
    // children, then a block boundary. The `CloseBlock` marker defers the trailing
    // boundary until after the children have been processed (post-order).
    enum Work<'x> {
        Enter(NodeRef<'x, Node>),
        CloseBlock,
    }
    let mut stack: Vec<Work<'a>> = Vec::new();
    let kids: Vec<_> = root.children().collect();
    for child in kids.into_iter().rev() {
        stack.push(Work::Enter(child));
    }
    while let Some(item) = stack.pop() {
        match item {
            Work::CloseBlock => out.push('\n'),
            Work::Enter(node) => match node.value() {
                Node::Text(t) => out.push_str(&normalize_text(&t.text, false)),
                Node::Element(e) => {
                    let name = e.name();
                    if is_excluded_tag(name) {
                        continue;
                    }
                    let block = is_block_tag(name);
                    append_attribute_records(out, name, e, base_url)?;
                    if name == "br" {
                        out.push('\n');
                        if block {
                            out.push('\n');
                        }
                    } else {
                        if block {
                            stack.push(Work::CloseBlock);
                        }
                        let kids: Vec<_> = node.children().collect();
                        for child in kids.into_iter().rev() {
                            stack.push(Work::Enter(child));
                        }
                    }
                }
                // Comments, doctypes, processing instructions -- not signed.
                _ => {}
            },
        }
    }
    Ok(())
}

fn append_attribute_records(
    out: &mut String,
    element_name: &str,
    element: &scraper::node::Element,
    base_url: Option<&Url>,
) -> Result<(), String> {
    for attr in ["href", "src", "alt", "aria-label"] {
        let Some(raw) = element.attr(attr) else {
            continue;
        };
        let value = if attr == "href" || attr == "src" {
            canonicalize_url(raw, base_url)?
        } else {
            normalize_text(raw, false).trim().to_string()
        };
        if value.contains('\n') {
            return Err("attribute-canonicalization-failed".to_string());
        }
        if !out.is_empty() && !out.chars().last().is_some_and(|c| c.is_whitespace()) {
            out.push('\n');
        }
        out.push_str("@attr:");
        out.push_str(element_name);
        out.push(':');
        out.push_str(attr);
        out.push(':');
        out.push_str(&value);
        out.push('\n');
    }
    Ok(())
}

fn canonicalize_url(raw: &str, base_url: Option<&Url>) -> Result<String, String> {
    // The `url` crate is a WHATWG URL implementation: parsing already
    // lowercases scheme + host, punycodes IDN hosts, resolves dot-segments,
    // strips default ports, and preserves query + fragment.
    let parsed = match Url::parse(raw) {
        Ok(url) => url,
        Err(_) => {
            // Relative reference: it can only be resolved against a base. The
            // draft (§4.3.2) requires a hard failure when no base is available,
            // not a silent skip.
            let Some(base) = base_url else {
                return Err("attribute-canonicalization-failed".to_string());
            };
            base.join(raw)
                .map_err(|_| "attribute-canonicalization-failed".to_string())?
        }
    };
    Ok(parsed.to_string())
}

fn finalize_parts(text: &str) -> String {
    let mut text = text.to_string();
    while text.contains("  ") {
        text = text.replace("  ", " ");
    }
    while text.contains(" \n") || text.contains("\n ") || text.contains("\t\n") || text.contains("\n\t") {
        text = text.replace(" \n", "\n");
        text = text.replace("\n ", "\n");
        text = text.replace("\t\n", "\n");
        text = text.replace("\n\t", "\n");
    }
    while text.contains("\n\n") {
        text = text.replace("\n\n", "\n");
    }
    text.trim_matches(&[' ', '\n'][..]).to_string()
}

/// Compute the canonical serialization of a claim map.
///
/// Each name and value is run through [`normalize_text`] and entries are
/// sorted lexically by name, then joined by `\n` as `name:value` pairs.
/// The caller is responsible for hashing the result.
///
/// `BTreeMap` is used as the input type because its iteration order is
/// already lexicographic, which makes the determinism property obvious
/// at the type level. Callers with other map types can pass via
/// `BTreeMap::from_iter(...)`.
pub fn canonicalize_claims(claims: &BTreeMap<String, String>) -> String {
    let mut entries: Vec<(String, String)> = claims
        .iter()
        .map(|(k, v)| {
            (
                normalize_text(k, false).trim().to_string(),
                normalize_text(v, false).trim().to_string(),
            )
        })
        .collect();
    // Re-sort after normalization in case normalization changes name order.
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    entries
        .into_iter()
        .map(|(k, v)| format!("{}:{}\n", k, v))
        .collect::<String>()
}

/// Like [`canonicalize_claims`] but enforces the draft's MUST-fail rules:
/// an empty normalized name is `claim-malformed`, and two names that
/// normalize to the same value are `claim-duplicate`. Names are compared and
/// sorted by their UTF-8 byte sequence (`String` ordering).
pub fn canonicalize_claims_checked(
    claims: &BTreeMap<String, String>,
) -> Result<String, String> {
    let mut entries: Vec<(String, String)> = Vec::with_capacity(claims.len());
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for (k, v) in claims {
        let name = normalize_text(k, false).trim().to_string();
        let value = normalize_text(v, false).trim().to_string();
        if name.is_empty() {
            return Err("claim-malformed".to_string());
        }
        if !seen.insert(name.clone()) {
            return Err("claim-duplicate".to_string());
        }
        entries.push((name, value));
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(entries
        .into_iter()
        .map(|(k, v)| format!("{}:{}\n", k, v))
        .collect::<String>())
}
