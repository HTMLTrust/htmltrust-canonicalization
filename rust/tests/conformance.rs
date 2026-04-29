//! Conformance tests for the HTMLTrust Rust binding.
//!
//! The 18 normalization cases below are a direct port of
//! `htmltrust-canonicalization/javascript/test.js` and MUST produce
//! byte-identical results across all language bindings.

use std::collections::BTreeMap;

use htmltrust_canonicalization::{
    canonicalize_claims, extract_canonical_text, normalize_text,
};

/// One conformance vector. `(input_a, input_b, should_match, description)`.
type Case = (&'static str, &'static str, bool, &'static str);

const NORMALIZATION_CASES: &[Case] = &[
    (
        "\u{201C}Hello\u{201D}",
        "\"Hello\"",
        true,
        "Curly double quotes -> straight",
    ),
    (
        "caf\u{00E9}",
        "cafe\u{0301}",
        true,
        "Precomposed vs combining (NFKC)",
    ),
    ("\u{FB01}nd", "find", true, "fi ligature (NFKC)"),
    (
        "word \u{2014} word",
        "word - word",
        true,
        "Em dash -> hyphen-minus",
    ),
    (
        "\u{00AB}Bonjour\u{00BB}",
        "\"Bonjour\"",
        true,
        "Guillemets -> double quotes",
    ),
    (
        "\u{300C}\u{6771}\u{4EAC}\u{300D}",
        "\"\u{6771}\u{4EAC}\"",
        true,
        "CJK corner brackets -> double quotes",
    ),
    (
        "\u{0645}\u{06CC}\u{200C}\u{062E}\u{0648}\u{0627}\u{0647}\u{0645}",
        "\u{0645}\u{06CC}\u{062E}\u{0648}\u{0627}\u{0647}\u{0645}",
        false,
        "ZWNJ is semantic (Persian)",
    ),
    (
        "\u{0643}\u{062A}\u{0640}\u{0640}\u{0640}\u{0627}\u{0628}",
        "\u{0643}\u{062A}\u{0627}\u{0628}",
        true,
        "Arabic tatweel stripped",
    ),
    ("\u{FF21}\u{FF11}", "A1", true, "Fullwidth ASCII (NFKC)"),
    ("\u{2460}", "1", true, "Circled digit (NFKC)"),
    ("word\u{200B}word", "wordword", true, "ZWSP stripped"),
    (
        "word\u{200C}word",
        "wordword",
        false,
        "ZWNJ preserved (different)",
    ),
    ("Hello\u{2026}", "Hello...", true, "Ellipsis -> three dots"),
    (
        "\u{2018}Hello\u{2019}",
        "'Hello'",
        true,
        "Curly single quotes -> straight",
    ),
    (
        "\u{201A}German\u{201C}",
        "\"German\"",
        true,
        "Low-9 quotes -> straight",
    ),
    ("a\u{00A0}b", "a b", true, "No-break space -> space"),
    ("a\u{3000}b", "a b", true, "Ideographic space -> space"),
    ("a  \t  b", "a b", true, "Whitespace collapse"),
];

#[test]
fn normalization_conformance() {
    let mut failures = Vec::<String>::new();
    for &(a, b, should_match, desc) in NORMALIZATION_CASES {
        let na = normalize_text(a, false);
        let nb = normalize_text(b, false);
        let matched = na == nb;
        if matched != should_match {
            failures.push(format!(
                "  {desc}: A={na:?} B={nb:?} expected match={should_match}, got match={matched}",
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} failure(s):\n{}",
        failures.len(),
        failures.join("\n"),
    );
}

#[test]
fn preserve_whitespace_skips_collapse() {
    let src = "line1\n    line2\t\tline3";
    assert_eq!(normalize_text(src, true), src);
}

#[test]
fn idempotent_for_typical_input() {
    let src = "\u{201C}Caf\u{00E9}\u{2014}test\u{2026}\u{201D}";
    let once = normalize_text(src, false);
    let twice = normalize_text(&once, false);
    assert_eq!(once, twice);
}

#[test]
fn extract_inline_no_separator() {
    assert_eq!(
        extract_canonical_text("<p>hello <em>world</em></p>"),
        "hello world",
    );
}

#[test]
fn extract_block_boundary_inserts_space() {
    assert_eq!(extract_canonical_text("<p>A</p><p>B</p>"), "A B");
}

#[test]
fn extract_excluded_elements_removed() {
    let html = "\
<p>before</p>\
<script>alert(1)</script>\
<style>.x{color:red}</style>\
<meta name=\"claim:License\" content=\"CC-BY-4.0\">\
<p>after</p>";
    assert_eq!(extract_canonical_text(html), "before after");
}

#[test]
fn extract_entity_decoding() {
    assert_eq!(
        extract_canonical_text("<p>A &amp; B &mdash; C</p>"),
        "A & B - C",
    );
}

#[test]
fn extract_normalization_pipeline_applied() {
    assert_eq!(
        extract_canonical_text("<p>\u{201C}Hello\u{201D}</p>"),
        "\"Hello\"",
    );
}

#[test]
fn extract_nested_blocks() {
    let html = "<article><header><h1>Title</h1></header>\
<section><p>Para one.</p><p>Para two.</p></section></article>";
    assert_eq!(extract_canonical_text(html), "Title Para one. Para two.");
}

#[test]
fn extract_list_items_separated() {
    assert_eq!(
        extract_canonical_text("<ul><li>a</li><li>b</li><li>c</li></ul>"),
        "a b c",
    );
}

#[test]
fn extract_inline_link_no_separator() {
    assert_eq!(
        extract_canonical_text("<p>see <a href=\"x\">here</a> now</p>"),
        "see here now",
    );
}

#[test]
fn claims_empty() {
    let claims: BTreeMap<String, String> = BTreeMap::new();
    assert_eq!(canonicalize_claims(&claims), "");
}

#[test]
fn claims_sorted_by_name() {
    let mut claims = BTreeMap::new();
    claims.insert("License".to_string(), "CC-BY-4.0".to_string());
    claims.insert("AIAssistance".to_string(), "None".to_string());
    claims.insert("ContentType".to_string(), "Article".to_string());
    assert_eq!(
        canonicalize_claims(&claims),
        "AIAssistance=None\nContentType=Article\nLicense=CC-BY-4.0",
    );
}

#[test]
fn claims_normalize_values() {
    let mut claims = BTreeMap::new();
    claims.insert("author".to_string(), "\u{201C}Alice\u{201D}".to_string());
    assert_eq!(canonicalize_claims(&claims), "author=\"Alice\"");
}
