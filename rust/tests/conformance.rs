//! Conformance tests for the HTMLTrust Rust binding.
//!
//! The 18 normalization cases below are a direct port of
//! `htmltrust-canonicalization/javascript/test.js` and MUST produce
//! byte-identical results across all language bindings.

use std::collections::BTreeMap;

use htmltrust_canonicalization::{
    canonicalize_claims, canonicalize_json_document, extract_canonical_text,
    extract_canonical_text_with_options, extract_claims_from_signed_section, normalize_text,
    try_extract_canonical_text, try_normalize_text, ExtractOptions, MAX_DOCUMENT_BYTES,
};

#[test]
fn jcs_rejects_excessive_nesting() {
    let document = format!("{}0{}", "[".repeat(257), "]".repeat(257));
    assert_eq!(
        canonicalize_json_document(document.as_bytes()),
        Err("resource-limit-exceeded".to_string())
    );
}

#[test]
fn jcs_rejects_negative_zero_and_underflow() {
    for document in [&br#"{"value":-0}"#[..], &br#"{"value":-1e-400}"#[..]] {
        assert_eq!(
            canonicalize_json_document(document),
            Err("jcs-number".to_string())
        );
    }
}

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
        "'German\"",
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
fn extraction_options_use_shared_finalization() {
    let options = ExtractOptions {
        preserve_whitespace: true,
        base_url: None,
    };
    assert_eq!(
        extract_canonical_text_with_options("<pre>line1\n    line2\t\tline3</pre>", options),
        "line1\nline2\t\tline3",
    );
    assert_eq!(
        extract_canonical_text_with_options("<p>a   b</p>", ExtractOptions::default()),
        "a b",
    );
}

#[test]
fn fallible_text_apis_enforce_source_and_output_limits() {
    let source = "x".repeat(MAX_DOCUMENT_BYTES + 1);
    assert_eq!(
        try_normalize_text(&source, false),
        Err("resource-limit-exceeded".into())
    );
    assert_eq!(
        try_extract_canonical_text(&source),
        Err("resource-limit-exceeded".into())
    );

    // Ellipsis expansion makes a source below the limit produce an oversized
    // canonical output, which must also be rejected.
    let expanding = "…".repeat(MAX_DOCUMENT_BYTES / 2);
    assert_eq!(
        try_normalize_text(&expanding, false),
        Err("resource-limit-exceeded".into())
    );
}

#[test]
fn fallible_text_apis_reject_invalid_utf8() {
    assert_eq!(
        htmltrust_canonicalization::try_normalize_text_v1(b"\xff", false),
        Err("parser-profile-unsupported".into())
    );
    assert_eq!(
        htmltrust_canonicalization::try_extract_canonical_text_v1(b"\xff", None),
        Err("parser-profile-unsupported".into())
    );
    assert_eq!(
        htmltrust_canonicalization::try_normalize_text_v1(
            &vec![0xff; MAX_DOCUMENT_BYTES + 1],
            false,
        ),
        Err("resource-limit-exceeded".into())
    );
}

#[test]
fn checked_claim_map_enforces_normalized_field_limits() {
    let mut claims = BTreeMap::new();
    claims.insert("x".repeat(4097), "value".to_string());
    assert_eq!(
        htmltrust_canonicalization::canonicalize_claims_checked(&claims),
        Err("resource-limit-exceeded".into())
    );

    let mut claims = BTreeMap::new();
    claims.insert("name".to_string(), "x".repeat(4097));
    assert_eq!(
        htmltrust_canonicalization::canonicalize_claims_checked(&claims),
        Err("resource-limit-exceeded".into())
    );
}

#[test]
fn extraction_applies_output_limit_after_finalization() {
    let unit = r#"<p href="x" src="x" alt="x" aria-label="x"></p>"#;
    let source = unit.repeat(10_000);
    let output = htmltrust_canonicalization::try_extract_canonical_text_with_base_url(
        &source,
        Some("https://example.com/"),
    )
    .expect("finalized output is within the limit");
    assert_eq!(output.len(), 1_039_999);
}

#[test]
fn malformed_json_precedes_surrogate_classification() {
    let error = canonicalize_json_document(br#"{"value":"\uD800"#).unwrap_err();
    assert!(
        error.starts_with("jcs-invalid-json:"),
        "unexpected error: {error}"
    );
}

#[test]
fn valid_json_lone_surrogate_is_classified_after_parsing() {
    assert_eq!(
        canonicalize_json_document(br#""\uD800""#),
        Err("jcs-invalid-surrogate".into())
    );
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
    assert_eq!(extract_canonical_text("<p>A</p><p>B</p>"), "A\nB");
}

#[test]
fn extract_excluded_elements_removed() {
    let html = "\
<p>before</p>\
<script>alert(1)</script>\
<style>.x{color:red}</style>\
<meta name=\"claim:License\" content=\"CC-BY-4.0\">\
<p>after</p>";
    assert_eq!(extract_canonical_text(html), "before\nafter");
}

#[test]
fn extract_rejects_malformed_comments() {
    assert_eq!(
        try_extract_canonical_text("<!-- a -- b -->x"),
        Err("parser-profile-unsupported".to_string())
    );
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
    assert_eq!(extract_canonical_text(html), "Title\nPara one.\nPara two.");
}

#[test]
fn extract_list_items_separated() {
    assert_eq!(
        extract_canonical_text("<ul><li>a</li><li>b</li><li>c</li></ul>"),
        "a\nb\nc",
    );
}

#[test]
fn extract_inline_link_no_separator() {
    // Anchor tags are inline: no separator. With a base URL the relative href
    // resolves and emits a signed-attribute record (draft §4.3.2).
    assert_eq!(
        htmltrust_canonicalization::try_extract_canonical_text_with_base_url(
            "<p>see <a href=\"x\">here</a> now</p>",
            Some("https://example.org/"),
        )
        .unwrap(),
        "see @attr:a:href:https://example.org/x\nhere now",
    );
}

#[test]
fn extract_relative_url_no_base_fails() {
    // A relative href with no base URL MUST fail rather than silently skip.
    let err = htmltrust_canonicalization::try_extract_canonical_text_with_base_url(
        "<p>see <a href=\"x\">here</a> now</p>",
        None,
    )
    .unwrap_err();
    assert!(err.contains("attribute-canonicalization-failed"));
}

#[test]
fn extracts_direct_child_claims() {
    let claims = extract_claims_from_signed_section(
        r#"<signed-section><meta name="author" content=" Alice "><meta name="signed-at" content="2026-08-27T12:00:00Z"><div><meta name="author" content="Nested"></div></signed-section>"#,
    )
    .unwrap();
    assert_eq!(claims.len(), 2);
    assert_eq!(claims.get("author").map(String::as_str), Some("Alice"));
    assert_eq!(
        claims.get("signed-at").map(String::as_str),
        Some("2026-08-27T12:00:00Z")
    );
}

#[test]
fn rejects_duplicate_extracted_claim_names() {
    let error = extract_claims_from_signed_section(
        r#"<meta name="author" content="A"><meta name=" author " content="B">"#,
    )
    .unwrap_err();
    assert_eq!(error, "claim-duplicate");
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
        "AIAssistance:None\nContentType:Article\nLicense:CC-BY-4.0\n",
    );
}

#[test]
fn claims_normalize_values() {
    let mut claims = BTreeMap::new();
    claims.insert("author".to_string(), "\u{201C}Alice\u{201D}".to_string());
    assert_eq!(canonicalize_claims(&claims), "author:\"Alice\"\n");
}
