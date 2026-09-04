//! HTMLTrust canonicalization core.
//!
//! Checked protocol operations:
//!
//! - [`normalize_text`] -- the four-phase normalize_text pipeline (draft
//!   section 4.4).
//! - [`extract_canonical_text`] -- HTML -> canonical text extraction
//!   (spec §2.1), parses with `scraper` (html5ever) and walks the DOM.
//! - [`extract_claims_from_signed_section`] -- direct claim metadata extraction.
//! - [`canonicalize_claims`] -- canonical serialization of claim metadata
//!   for the `claims-hash` field of the signature binding.
//! - [`canonicalize_json_document`] -- strict RFC 8785 JSON canonicalization.
//!
//! JavaScript, Go, Python, and PHP call this implementation through the FFI
//! crate's native or WebAssembly boundary.

use std::collections::BTreeMap;

use ego_tree::NodeRef;
use scraper::{node::Node, Html};
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::ser::{Serialize, Serializer};
use unicode_normalization::UnicodeNormalization;
use url::Url;

/// Maximum size of a source document and its canonical output.
pub const MAX_DOCUMENT_BYTES: usize = 1024 * 1024;
const MAX_ELEMENT_DEPTH: usize = 256;
const PARSER_UNSUPPORTED: &str = "parser-profile-unsupported";
const RESOURCE_LIMIT: &str = "resource-limit-exceeded";

// ---------------------------------------------------------------------------
// Codepoint ranges, mirroring the JS reference regex character classes
// byte-for-byte. Inclusive ranges. Single codepoints expressed as
// (cp, cp).
// ---------------------------------------------------------------------------

/// normalize_text phase 2 (draft section 4.4.2): invisible / formatting /
/// bidi characters to strip. ZWNJ (U+200C) and ZWJ (U+200D) are
/// deliberately preserved -- they are semantic in Persian, Indic, and
/// emoji.
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

/// normalize_text phase 3 (draft section 4.4.3): Unicode whitespace -> U+0020.
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

/// normalize_text phase 4 (draft section 4.4.4, punctuation): single
/// quotes -> ASCII apostrophe.
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

/// normalize_text phase 4 (draft section 4.4.4, punctuation): double
/// quotes -> ASCII double quote.
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

/// normalize_text phase 4 (draft section 4.4.4, punctuation): CJK corner
/// brackets -> ASCII double quote.
const CJK_QUOTE_RANGES: &[(u32, u32)] = &[
    (0x300C, 0x300F), // CJK corner brackets
    (0xFE41, 0xFE44), // presentation forms for vertical corner brackets
];

/// normalize_text phase 4 (draft section 4.4.4, punctuation): dashes ->
/// ASCII hyphen-minus.
const DASH_POINTS: &[u32] = &[
    0x2212, // minus sign
    0xFE58, // small em dash
    0xFE63, // small hyphen-minus
];
const DASH_RANGES: &[(u32, u32)] = &[
    (0x2010, 0x2015), // hyphen .. horizontal bar
];

/// normalize_text phase 4 (draft section 4.4.4, punctuation): ellipsis ->
/// three periods.
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

/// Apply the HTMLTrust four-phase normalize_text pipeline (draft section
/// 4.4) to `text`: NFKC, strip formatting characters, whitespace mapping
/// and collapse, punctuation normalization. Performs no trimming;
/// trimming (normalize_field, draft section 4.4) is caller-specific --
/// see `extract_canonical_text`'s `alt`/`aria-label` handling and
/// `canonicalize_claims`'s name/content handling for the two fields that
/// trim.
///
/// Order matches the JavaScript reference implementation precisely.
///
/// # Arguments
///
/// * `text` -- raw text content (typically the output of
///   [`extract_canonical_text`]).
/// * `preserve_whitespace` -- legacy 0.2 compatibility option. v1 callers
///   must pass `false`; v1 does not preserve `<pre>` whitespace verbatim.
///
/// # Returns
///
/// Normalized text, suitable for hashing.
pub fn normalize_text(text: &str, preserve_whitespace: bool) -> String {
    // Phase 1: NFKC.
    let nfkc: String = text.nfkc().collect();

    // Phase 2: strip invisible / formatting / bidi characters.
    let stripped: String = nfkc
        .chars()
        .filter(|&c| !in_ranges(c, STRIP_RANGES))
        .collect();

    // Phase 3: whitespace normalization.
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

    // Phase 4: punctuation normalization, in a single pass.
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

/// Fallible byte-oriented normalization entry point for profile-v1 callers.
///
/// The source and normalized UTF-8 output are each limited to
/// [`MAX_DOCUMENT_BYTES`]. The legacy [`normalize_text`] wrapper remains
/// available for callers that already enforce their own limits.
pub fn try_normalize_text(text: &str, preserve_whitespace: bool) -> Result<String, String> {
    if text.len() > MAX_DOCUMENT_BYTES {
        return Err(RESOURCE_LIMIT.to_string());
    }
    let result = normalize_text(text, preserve_whitespace);
    if result.len() > MAX_DOCUMENT_BYTES {
        return Err(RESOURCE_LIMIT.to_string());
    }
    Ok(result)
}

/// Fallible byte-oriented normalization entry point for profile-v1 callers.
pub fn try_normalize_text_v1(text: &[u8], preserve_whitespace: bool) -> Result<String, String> {
    if text.len() > MAX_DOCUMENT_BYTES {
        return Err(RESOURCE_LIMIT.to_string());
    }
    let text = std::str::from_utf8(text).map_err(|_| PARSER_UNSUPPORTED.to_string())?;
    try_normalize_text(text, preserve_whitespace)
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
/// * `options` -- extraction options, including the legacy
///   `preserve_whitespace` flag and an optional resolved HTTPS document base
///   URL for relative signed attributes.
///
/// # Returns
///
/// Canonical text, ready to be hashed. Trimmed of leading/trailing
/// whitespace.
pub fn extract_canonical_text(html: &str) -> String {
    extract_canonical_text_with_options(html, ExtractOptions::default())
}

/// Extract canonical text from an HTML fragment, resolving relative signed
/// semantic URL attributes against the resolved document `base_url` when
/// supplied. The caller's source-snapshot layer computes that URL, including
/// any HTML `<base>` element, before invoking this binding.
pub fn extract_canonical_text_with_base_url(html: &str, base_url: Option<&str>) -> String {
    extract_canonical_text_with_options(
        html,
        ExtractOptions {
            base_url,
            ..ExtractOptions::default()
        },
    )
}

/// Extraction options. `preserve_whitespace` is a legacy 0.2 compatibility
/// flag passed to text-node normalization; v1 callers must leave it false.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ExtractOptions<'a> {
    pub preserve_whitespace: bool,
    pub base_url: Option<&'a str>,
}

/// Extract canonical text with explicit options.
pub fn extract_canonical_text_with_options(html: &str, options: ExtractOptions<'_>) -> String {
    try_extract_canonical_text_with_options(html, options)
        .expect("attribute-canonicalization-failed")
}

/// Fallible extraction entry point with explicit options. Source HTML, base
/// URL, and canonical output are each limited to
/// [`MAX_DOCUMENT_BYTES`]. An empty base URL is treated as absent.
pub fn try_extract_canonical_text(html: &str) -> Result<String, String> {
    try_extract_canonical_text_with_options(html, ExtractOptions::default())
}

/// Fallible form of [`extract_canonical_text_with_base_url`].
pub fn try_extract_canonical_text_with_base_url(
    html: &str,
    base_url: Option<&str>,
) -> Result<String, String> {
    try_extract_canonical_text_with_options(
        html,
        ExtractOptions {
            base_url,
            ..ExtractOptions::default()
        },
    )
}

/// Fallible extraction entry point with explicit options.
pub fn try_extract_canonical_text_with_options(
    html: &str,
    options: ExtractOptions<'_>,
) -> Result<String, String> {
    if html.len() > MAX_DOCUMENT_BYTES {
        return Err(RESOURCE_LIMIT.to_string());
    }
    preflight_source(html)?;
    let document = Html::parse_fragment(html);
    // html5ever deliberately repairs malformed HTML. The portable profile
    // cannot sign a repaired tree, so every diagnostic is a hard failure.
    if !document.errors.is_empty() {
        return Err(PARSER_UNSUPPORTED.to_string());
    }
    let base = match options.base_url {
        Some("") | None => None,
        Some(raw) => {
            if raw.len() > MAX_DOCUMENT_BYTES {
                return Err(RESOURCE_LIMIT.to_string());
            }
            let parsed =
                Url::parse(raw).map_err(|_| "attribute-canonicalization-failed".to_string())?;
            if parsed.scheme() != "https"
                || !parsed.username().is_empty()
                || parsed.password().is_some()
            {
                return Err("url-policy-violation".to_string());
            }
            Some(parsed)
        }
    };

    let mut out = String::new();
    walk(
        document.tree.root(),
        &mut out,
        base.as_ref(),
        options.preserve_whitespace,
    )?;

    let result = finalize_parts(&out, options.preserve_whitespace);
    if result.len() > MAX_DOCUMENT_BYTES {
        return Err(RESOURCE_LIMIT.to_string());
    }
    Ok(result)
}

/// Fallible, profile-v1 entry point accepting raw UTF-8 bytes. No lossy
/// decoding is performed, which makes the API suitable for FFI callers.
pub fn try_extract_canonical_text_v1(
    html: &[u8],
    base_url: Option<&[u8]>,
) -> Result<String, String> {
    if html.len() > MAX_DOCUMENT_BYTES {
        return Err(RESOURCE_LIMIT.to_string());
    }
    if base_url.is_some_and(|base| base.len() > MAX_DOCUMENT_BYTES) {
        return Err(RESOURCE_LIMIT.to_string());
    }
    let html = std::str::from_utf8(html).map_err(|_| PARSER_UNSUPPORTED.to_string())?;
    let base = match base_url {
        Some(bytes) => {
            Some(std::str::from_utf8(bytes).map_err(|_| PARSER_UNSUPPORTED.to_string())?)
        }
        None => None,
    };
    try_extract_canonical_text_with_base_url(html, base)
}

/// Alias emphasizing that the input is a byte string.
pub fn try_extract_canonical_text_bytes(
    html: &[u8],
    base_url: Option<&[u8]>,
) -> Result<String, String> {
    try_extract_canonical_text_v1(html, base_url)
}

/// Extract claim metadata from direct child `meta` elements of the first
/// signed section. Without a wrapper, the fragment is treated as section
/// inner HTML and parser-created html/head/body nodes are ignored.
pub fn extract_claims_from_signed_section(html: &str) -> Result<BTreeMap<String, String>, String> {
    if html.len() > MAX_DOCUMENT_BYTES {
        return Err("resource-limit-exceeded".to_string());
    }
    preflight_source(html)?;
    let document = Html::parse_fragment(html);
    if !document.errors.is_empty() {
        return Err(PARSER_UNSUPPORTED.to_string());
    }
    let root = document.tree.root();
    let section = root.descendants().find(
        |node| matches!(node.value(), Node::Element(element) if element.name() == "signed-section"),
    );
    let candidates: Vec<_> = match section {
        Some(node) => node.children().collect(),
        None => root
            .descendants()
            .filter(|node| {
                if !matches!(node.value(), Node::Element(element) if element.name() == "meta") {
                    return false;
                }
                let mut parent = node.parent();
                while let Some(ancestor) = parent {
                    match ancestor.value() {
                        Node::Document | Node::Fragment => return true,
                        Node::Element(element)
                            if matches!(element.name(), "html" | "head" | "body") => {}
                        _ => return false,
                    }
                    parent = ancestor.parent();
                }
                true
            })
            .collect(),
    };
    let mut claims = BTreeMap::new();
    for node in candidates {
        let Node::Element(element) = node.value() else {
            continue;
        };
        if element.name() != "meta" {
            continue;
        }
        let raw_name = element
            .attr("name")
            .ok_or_else(|| "claim-malformed".to_string())?;
        let raw_content = element
            .attr("content")
            .ok_or_else(|| "claim-malformed".to_string())?;
        if claims.len() >= 64 {
            return Err("resource-limit-exceeded".to_string());
        }
        let name = normalize_text(raw_name, false).trim().to_string();
        let content = normalize_text(raw_content, false).trim().to_string();
        if name.is_empty() {
            return Err("claim-malformed".to_string());
        }
        if name.len() > 4096 || content.len() > 4096 {
            return Err("resource-limit-exceeded".to_string());
        }
        if claims.insert(name, content).is_some() {
            return Err("claim-duplicate".to_string());
        }
    }
    Ok(claims)
}

fn preflight_source(html: &str) -> Result<(), String> {
    if html.chars().any(|character| {
        matches!(
            character as u32,
            0x0000..=0x0008 | 0x000B | 0x000E..=0x001F | 0x007F..=0x009F
        )
    }) {
        return Err(PARSER_UNSUPPORTED.to_string());
    }
    let lower = html.to_ascii_lowercase();
    // A small source-level stack catches EOF-implied closes and lets us reject
    // malformed nesting before html5ever has a chance to repair it. It is
    // intentionally conservative: all non-void starts require an explicit
    // matching end tag in the signed profile.
    const VOID: &[&str] = &[
        "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param",
        "source", "track", "wbr",
    ];
    let bytes = html.as_bytes();
    let mut stack: Vec<String> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let raw_close = stack.last().and_then(|name| {
            matches!(
                name.as_str(),
                "script" | "style" | "iframe" | "xmp" | "noembed"
            )
            .then(|| format!("</{name}"))
        });
        if let Some(needle) = raw_close {
            if !lower[i..].starts_with(&needle) {
                let offset = lower[i..]
                    .find(&needle)
                    .ok_or_else(|| PARSER_UNSUPPORTED.to_string())?;
                i += offset;
            }
        }
        if bytes[i] != b'<' {
            if bytes[i] == b'&' {
                if let Some(end) = reference_end(bytes, i + 1) {
                    let candidate = &html[i..end];
                    if !candidate.ends_with(';') {
                        return Err(PARSER_UNSUPPORTED.to_string());
                    }
                    // html5ever accepts some ambiguous legacy references and
                    // partially consumes them. Verify that it recognizes the
                    // entire reference, rather than relying on that repair.
                    if !recognized_reference(candidate) {
                        return Err(PARSER_UNSUPPORTED.to_string());
                    }
                    i = end;
                    continue;
                }
            }
            i += 1;
            continue;
        }
        if bytes.get(i..i + 4) == Some(b"<!--") {
            let Some(end) = html[i + 4..].find("-->") else {
                return Err(PARSER_UNSUPPORTED.to_string());
            };
            let comment = &html[i + 4..i + 4 + end];
            if comment.contains("--") || comment.ends_with('-') {
                return Err(PARSER_UNSUPPORTED.to_string());
            }
            i += end + 7;
            continue;
        }
        let mut j = i + 1;
        if j >= bytes.len() {
            return Err(PARSER_UNSUPPORTED.to_string());
        }
        let closing = bytes[j] == b'/';
        if closing {
            j += 1;
        }
        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        let name_start = j;
        while j < bytes.len()
            && !bytes[j].is_ascii_whitespace()
            && bytes[j] != b'/'
            && bytes[j] != b'>'
        {
            j += 1;
        }
        if j == name_start {
            // declarations and processing instructions are left to html5ever;
            // malformed ones will produce a parser diagnostic.
            i += 1;
            continue;
        }
        let name = html[name_start..j].to_ascii_lowercase();
        if !closing && matches!(name.as_str(), "svg" | "math" | "foreignobject") {
            return Err(PARSER_UNSUPPORTED.to_string());
        }
        let mut quote = 0u8;
        let mut end = j;
        while end < bytes.len() {
            match (quote, bytes[end]) {
                (0, b'\'' | b'"') => quote = bytes[end],
                (q, c) if q == c => quote = 0,
                (0, b'>') => break,
                _ => {}
            }
            end += 1;
        }
        if end == bytes.len() {
            return Err(PARSER_UNSUPPORTED.to_string());
        }
        if closing {
            if stack.pop().as_deref() != Some(name.as_str()) {
                return Err(PARSER_UNSUPPORTED.to_string());
            }
        } else if !VOID.contains(&name.as_str()) && has_self_closing_suffix(&html[i..=end]) {
            return Err(PARSER_UNSUPPORTED.to_string());
        } else if !VOID.contains(&name.as_str()) {
            if stack.len() >= MAX_ELEMENT_DEPTH {
                return Err(RESOURCE_LIMIT.to_string());
            }
            stack.push(name);
        }
        i = end + 1;
    }
    if !stack.is_empty() {
        return Err(PARSER_UNSUPPORTED.to_string());
    }
    Ok(())
}

fn has_self_closing_suffix(tag: &str) -> bool {
    let suffix = tag.trim_end();
    if !suffix.ends_with('>') {
        return false;
    }
    let before_gt = suffix[..suffix.len() - 1].trim_end();
    let Some(prefix) = before_gt.strip_suffix('/') else {
        return false;
    };
    if prefix.chars().last().is_some_and(char::is_whitespace) {
        return true;
    }
    let mut chars = prefix.chars();
    if chars.next() != Some('<') {
        return false;
    }
    while chars.next().is_some_and(|c| c.is_ascii_whitespace()) {}
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphabetic() {
        return false;
    }
    !chars.any(|c| c.is_ascii_whitespace() || matches!(c, '/' | '>'))
}

fn reference_end(bytes: &[u8], start: usize) -> Option<usize> {
    if start >= bytes.len() || !(bytes[start].is_ascii_alphanumeric() || bytes[start] == b'#') {
        return None;
    }
    let mut i = start;
    while i < bytes.len() && !matches!(bytes[i], b';' | b'<' | b'>' | b' ' | b'\t' | b'\r' | b'\n')
    {
        i += 1;
    }
    if bytes.get(i) == Some(&b';') {
        Some(i + 1)
    } else {
        Some(i)
    }
}

fn recognized_reference(reference: &str) -> bool {
    // Numeric references are unambiguous only with a semicolon, and the
    // parser is the authority for validity/range handling.
    if reference.starts_with("&#") {
        let doc = Html::parse_fragment(&format!("<span>{reference}</span>"));
        return doc.errors.is_empty();
    }
    // Compare the parser's result against the literal. Unknown names remain
    // unchanged; names that are only a prefix (for example `&notit;`) are
    // rejected because html5ever changes the source but does not consume the
    // complete named reference.
    let doc = Html::parse_fragment(&format!("<span>{reference}</span>"));
    if !doc.errors.is_empty() {
        return false;
    }
    let mut text = String::new();
    for node in doc.tree.root().descendants() {
        if let Node::Text(t) = node.value() {
            text.push_str(&t.text);
        }
    }
    text != reference
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
            | "signed-section"
            | "table"
            | "tr"
            | "td"
            | "th"
            | "ul"
    )
}

fn walk<'a>(
    root: NodeRef<'a, Node>,
    out: &mut String,
    base_url: Option<&Url>,
    preserve_whitespace: bool,
) -> Result<(), String> {
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
                Node::Text(t) => out.push_str(&escape_at_signs(&normalize_text(
                    &t.text,
                    preserve_whitespace,
                ))),
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
            escape_at_signs(normalize_text(raw, false).trim())
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
    // URL parsers generally strip C0 controls as part of their recovery. The
    // signed profile must inspect the decoded HTML attribute first so that a
    // reference such as `&#10;` cannot silently change its meaning.
    if raw.chars().any(|c| c.is_control()) {
        return Err("url-policy-violation".to_string());
    }
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
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("url-policy-violation".to_string());
    }
    Ok(escape_at_signs(parsed.as_str()))
}

fn escape_at_signs(value: &str) -> String {
    value.replace('@', "@@")
}

fn finalize_parts(text: &str, _preserve_whitespace: bool) -> String {
    let mut text = text.to_string();
    while text.contains("  ") {
        text = text.replace("  ", " ");
    }
    while text.contains(" \n")
        || text.contains("\n ")
        || text.contains("\t\n")
        || text.contains("\n\t")
    {
        text = text.replace(" \n", "\n");
        text = text.replace("\n ", "\n");
        text = text.replace("\t\n", "\n");
        text = text.replace("\n\t", "\n");
    }
    while text.contains("\n\n") {
        text = text.replace("\n\n", "\n");
    }
    text.trim().to_string()
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
        .map(|(k, v)| {
            format!(
                "{}:{}\n",
                escape_claim_component(&k),
                escape_claim_component(&v)
            )
        })
        .collect::<String>()
}

/// Like [`canonicalize_claims`] but enforces the draft's MUST-fail rules:
/// an empty normalized name is `claim-malformed`, and two names that
/// normalize to the same value are `claim-duplicate`. Names are compared and
/// sorted by their UTF-8 byte sequence (`String` ordering).
pub fn canonicalize_claims_checked(claims: &BTreeMap<String, String>) -> Result<String, String> {
    if claims.len() > 64 {
        return Err("resource-limit-exceeded".to_string());
    }
    let mut entries: Vec<(String, String)> = Vec::with_capacity(claims.len());
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for (k, v) in claims {
        let name = normalize_text(k, false).trim().to_string();
        let value = normalize_text(v, false).trim().to_string();
        if name.is_empty() {
            return Err("claim-malformed".to_string());
        }
        if name.len() > 4096 || value.len() > 4096 {
            return Err("resource-limit-exceeded".to_string());
        }
        if !seen.insert(name.clone()) {
            return Err("claim-duplicate".to_string());
        }
        entries.push((name, value));
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let result: String = entries
        .into_iter()
        .map(|(k, v)| {
            format!(
                "{}:{}\n",
                escape_claim_component(&k),
                escape_claim_component(&v)
            )
        })
        .collect();
    if result.len() > MAX_DOCUMENT_BYTES {
        return Err("resource-limit-exceeded".to_string());
    }
    Ok(result)
}

/// Parse a UTF-8 JSON object of string claim values and serialize it using the
/// checked v1 claims contract.
///
/// This byte-oriented entry point is intended for FFI callers. It accepts the
/// same JSON object shape used by the conformance fixtures, rejects malformed
/// JSON, duplicate object members, non-object roots, and non-string values as
/// `claim-malformed`, and preserves the resource limits enforced by
/// [`canonicalize_claims_checked`].
pub fn canonicalize_claims_document(raw: &[u8]) -> Result<String, String> {
    if raw.len() > MAX_DOCUMENT_BYTES {
        return Err(RESOURCE_LIMIT.to_string());
    }
    enforce_json_nesting_limit(raw)?;
    let value = parse_strict_json(raw).map_err(|_| "claim-malformed".to_string())?;
    let StrictJson::Object(object) = value else {
        return Err("claim-malformed".to_string());
    };
    let claims = object
        .into_iter()
        .map(|(name, value)| match value {
            StrictJson::String(value) => Ok((name, value)),
            _ => Err("claim-malformed".to_string()),
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    canonicalize_claims_checked(&claims)
}

fn escape_claim_component(value: &str) -> String {
    // Ordering matters: escape the escape character before introducing any
    // escapes for the other delimiters.
    value
        .replace('\\', "\\\\")
        .replace(':', "\\:")
        .replace('\n', "\\n")
}

/// Canonicalize one raw JSON document according to RFC 8785 (JCS).
///
/// Parsing is done with a duplicate-preserving serde visitor before values are
/// handed to `serde_json_canonicalizer`; serde_json::Value would silently keep
/// only the last duplicate object member. JSON strings are not normalized.
pub fn canonicalize_json_document(raw: &[u8]) -> Result<String, String> {
    if raw.len() > MAX_DOCUMENT_BYTES {
        return Err("resource-limit-exceeded".to_string());
    }
    enforce_json_nesting_limit(raw)?;
    let value = match parse_strict_json(raw) {
        Ok(value) => value,
        Err(_error) if has_lone_surrogate_escape(raw) => {
            // serde_json rejects lone UTF-16 surrogate escapes while parsing,
            // so validate the same bytes with surrogate escapes replaced by a
            // scalar placeholder. This second parse only distinguishes a
            // syntactically valid lone-surrogate document from malformed JSON;
            // it never supplies the value used for canonicalization.
            let sanitized = replace_surrogate_escapes(raw);
            match parse_strict_json(&sanitized) {
                Ok(_) => return Err("jcs-invalid-surrogate".to_string()),
                Err(sanitized_error) => return Err(map_json_error(sanitized_error)),
            }
        }
        Err(error) => return Err(map_json_error(error)),
    };
    // Only classify surrogate escapes after the JSON parser has accepted the
    // complete document. A malformed document such as an unterminated string
    // containing `\uD800` is jcs-invalid-json, not jcs-invalid-surrogate.
    if has_lone_surrogate_escape(raw) {
        return Err("jcs-invalid-surrogate".to_string());
    }
    // RFC 8785 erratum 7920: reject negative zero, including negative values
    // whose magnitude underflows to zero during binary64 parsing.
    if has_negative_zero_number(raw) {
        return Err("jcs-number".to_string());
    }
    let output =
        serde_json_canonicalizer::to_string(&value).map_err(|_| "jcs-invalid-json".to_string())?;
    if output.len() > MAX_DOCUMENT_BYTES {
        return Err("resource-limit-exceeded".to_string());
    }
    Ok(output)
}

/// Detect negative JSON number tokens that parse as IEEE-754 negative zero.
/// This lexical pass is needed because serde_json presents an integer token
/// such as `-0` to the visitor as the signed integer zero, losing its sign.
fn has_negative_zero_number(raw: &[u8]) -> bool {
    let mut in_string = false;
    let mut escaped = false;
    let mut index = 0;
    while index < raw.len() {
        let byte = raw[index];
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if byte == b'"' {
            in_string = true;
            index += 1;
            continue;
        }
        if byte == b'-' {
            let start = index;
            index += 1;
            while index < raw.len()
                && !matches!(
                    raw[index],
                    b' ' | b'\t' | b'\r' | b'\n' | b',' | b']' | b'}'
                )
            {
                index += 1;
            }
            if let Ok(token) = std::str::from_utf8(&raw[start..index]) {
                if let Ok(number) = token.parse::<f64>() {
                    if number == 0.0 && number.is_sign_negative() {
                        return true;
                    }
                }
            }
            continue;
        }
        index += 1;
    }
    false
}

fn parse_strict_json(raw: &[u8]) -> Result<StrictJson, serde_json::Error> {
    let mut de = serde_json::Deserializer::from_slice(raw);
    let value = StrictJson::deserialize(&mut de)?;
    de.end()?;
    Ok(value)
}

fn enforce_json_nesting_limit(raw: &[u8]) -> Result<(), String> {
    const MAX_NESTING_DEPTH: usize = 256;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for byte in raw {
        if in_string {
            if escaped {
                escaped = false;
            } else if *byte == b'\\' {
                escaped = true;
            } else if *byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match *byte {
            b'"' => in_string = true,
            b'[' | b'{' => {
                depth += 1;
                if depth > MAX_NESTING_DEPTH {
                    return Err("resource-limit-exceeded".to_string());
                }
            }
            b']' | b'}' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    Ok(())
}

fn map_json_error(error: serde_json::Error) -> String {
    let msg = error.to_string();
    if msg.contains("number out of range") || msg.contains("invalid number") {
        "jcs-number".to_string()
    } else if msg.contains("duplicate object key") {
        "jcs-duplicate-key".to_string()
    } else {
        "jcs-invalid-json".to_string()
    }
}

fn replace_surrogate_escapes(raw: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        let slash_run = if raw[i] == b'\\' {
            let mut count = 0;
            let mut p = i;
            while p > 0 && raw[p - 1] == b'\\' {
                count += 1;
                p -= 1;
            }
            count
        } else {
            0
        };
        if raw[i] == b'\\'
            && slash_run % 2 == 0
            && i + 5 < raw.len()
            && raw[i + 1] == b'u'
            && hex4(&raw[i + 2..i + 6]).is_some_and(|v| (0xD800..=0xDFFF).contains(&v))
        {
            output.extend_from_slice(br"\uFFFD");
            i += 6;
        } else {
            output.push(raw[i]);
            i += 1;
        }
    }
    output
}

fn hex4(bytes: &[u8]) -> Option<u16> {
    if bytes.len() < 4 {
        return None;
    }
    let mut value = 0u16;
    for &c in &bytes[..4] {
        value = value.checked_mul(16)?.checked_add(match c {
            b'0'..=b'9' => (c - b'0') as u16,
            b'a'..=b'f' => (c - b'a' + 10) as u16,
            b'A'..=b'F' => (c - b'A' + 10) as u16,
            _ => return None,
        })?;
    }
    Some(value)
}

fn has_lone_surrogate_escape(raw: &[u8]) -> bool {
    let mut i = 0;
    while i + 5 < raw.len() {
        // A slash preceded by another slash is the escaped literal `\\`, not
        // the start of a Unicode escape. Count the run to distinguish the two
        // cases without pulling in a second JSON parser.
        let mut slash_run = 0;
        let mut p = i;
        while p > 0 && raw[p - 1] == b'\\' {
            slash_run += 1;
            p -= 1;
        }
        if raw[i] == b'\\' && raw[i + 1] == b'u' && slash_run % 2 == 0 {
            if let Some(value) = hex4(&raw[i + 2..i + 6]) {
                if (0xD800..=0xDBFF).contains(&value) {
                    let paired = i + 11 < raw.len()
                        && raw[i + 6] == b'\\'
                        && raw[i + 7] == b'u'
                        && hex4(&raw[i + 8..i + 12])
                            .is_some_and(|v| (0xDC00..=0xDFFF).contains(&v));
                    if !paired {
                        return true;
                    }
                    i += 12;
                    continue;
                }
                if (0xDC00..=0xDFFF).contains(&value) {
                    return true;
                }
            }
        }
        i += 1;
    }
    false
}

#[derive(Debug)]
enum StrictJson {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<StrictJson>),
    Object(BTreeMap<String, StrictJson>),
}

impl Serialize for StrictJson {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Null => serializer.serialize_none(),
            Self::Bool(v) => serializer.serialize_bool(*v),
            Self::Number(v) => serializer.serialize_f64(*v),
            Self::String(v) => serializer.serialize_str(v),
            Self::Array(v) => v.serialize(serializer),
            Self::Object(v) => v.serialize(serializer),
        }
    }
}

struct StrictVisitor;

impl<'de> Visitor<'de> for StrictVisitor {
    type Value = StrictJson;

    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("a JSON value")
    }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(StrictJson::Null)
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Self::Value, E> {
        Ok(StrictJson::Bool(v))
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
        Ok(StrictJson::String(v.to_owned()))
    }
    fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> {
        Ok(StrictJson::String(v))
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
        number(v as f64, self)
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
        number(v as f64, self)
    }
    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
        number(v, self)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        let mut values = Vec::new();
        while let Some(v) = seq.next_element_seed(StrictSeed)? {
            values.push(v);
        }
        Ok(StrictJson::Array(values))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut values = BTreeMap::new();
        while let Some(key) = map.next_key::<String>()? {
            if values.contains_key(&key) {
                return Err(de::Error::custom("duplicate object key"));
            }
            values.insert(key, map.next_value_seed(StrictSeed)?);
        }
        Ok(StrictJson::Object(values))
    }
}

fn number<E: de::Error>(v: f64, _visitor: StrictVisitor) -> Result<StrictJson, E> {
    if v.is_finite() {
        Ok(StrictJson::Number(v))
    } else {
        Err(E::custom("number out of range"))
    }
}

struct StrictSeed;
impl<'de> de::DeserializeSeed<'de> for StrictSeed {
    type Value = StrictJson;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
        d.deserialize_any(StrictVisitor)
    }
}
impl<'de> Deserialize<'de> for StrictJson {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<StrictJson, D::Error> {
        d.deserialize_any(StrictVisitor)
    }
}
