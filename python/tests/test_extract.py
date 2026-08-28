"""Conformance tests for ``extract_canonical_text``.

These cases mirror the contract of the JavaScript reference
``extractCanonicalText`` and confirm that boundary-producing elements
emit line feeds, inline elements do not, excluded elements vanish
entirely, and HTML entities are decoded by the parser before
normalization.
"""

import pytest

from htmltrust_canonicalization import extract_canonical_text


def test_inline_no_separator():
    """Inline elements like <em> must NOT introduce extra whitespace."""
    assert (
        extract_canonical_text("<p>hello <em>world</em></p>")
        == "hello world"
    )


def test_block_boundary_inserts_linefeed():
    """<p>A</p><p>B</p> -> "A\nB" (not "AB")."""
    assert (
        extract_canonical_text("<p>A</p><p>B</p>") == "A\nB"
    )


def test_excluded_elements_removed():
    """script/style/meta content must vanish entirely."""
    html = (
        "<p>before</p>"
        "<script>alert(1)</script>"
        "<style>.x{color:red}</style>"
        "<meta name='claim:License' content='CC-BY-4.0'>"
        "<p>after</p>"
    )
    assert extract_canonical_text(html) == "before\nafter"


def test_excluded_rawtext_with_quoted_delimiters_is_removed():
    """Excluded content may contain tag-like text and quoted ``>`` chars."""
    html = (
        "<p>before</p>"
        "<script data=\">\"><iframe>ignored</iframe><p>ignored</p></script>"
        "<style title='>'>.x{content:'<p>ignored</p>'}</style>"
        "<iframe src='https://example.org/?q=>'><p>ignored</p></iframe>"
        "<p>after</p>"
    )
    assert extract_canonical_text(html) == "before\nafter"


def test_excluded_preflight_scanner_does_not_backtrack_on_unterminated_tag():
    """An unterminated unquoted attribute is rejected in bounded time."""
    source = "<script " + ("x" * 4096)
    with pytest.raises(ValueError, match="parser-profile-unsupported"):
        extract_canonical_text(source)


def test_source_depth_scanner_does_not_backtrack_on_unterminated_quote():
    """Repeated quoted attributes must not make malformed-tag recovery grow."""
    source = "<p>before</p><img " + ('data-x="x" ' * 8) + "style='x<p>after</p>"
    with pytest.raises(ValueError, match="parser-profile-unsupported"):
        extract_canonical_text(source)


def test_entity_decoding():
    """HTML entities must be decoded by the parser."""
    assert (
        extract_canonical_text("<p>A &amp; B &mdash; C</p>")
        == "A & B - C"
    )


def test_normalization_pipeline_applied():
    """The canonicalization pipeline must run on the extracted text."""
    # Curly quotes inside HTML get extracted then normalized to straight.
    assert (
        extract_canonical_text("<p>“Hello”</p>") == '"Hello"'
    )


def test_preserve_whitespace_finalization_strips_runs_around_newlines():
    html = "<pre>before \t \n \t after</pre>"
    assert extract_canonical_text(html, preserve_whitespace=True) == "before\nafter"


def test_nested_blocks():
    """Deeply nested block structure still collapses repeated line feeds."""
    html = (
        "<article>"
        "<header><h1>Title</h1></header>"
        "<section><p>Para one.</p><p>Para two.</p></section>"
        "</article>"
    )
    out = extract_canonical_text(html)
    assert out == "Title\nPara one.\nPara two."


def test_list_items_separated():
    assert (
        extract_canonical_text("<ul><li>a</li><li>b</li><li>c</li></ul>")
        == "a\nb\nc"
    )


def test_extract_rejects_non_string():
    with pytest.raises(TypeError):
        extract_canonical_text(123)  # type: ignore[arg-type]


def test_table_cells_separated():
    html = "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>"
    assert extract_canonical_text(html) == "a\nb\nc\nd"


@pytest.mark.parametrize(
    "html",
    [
        "<p>x",
        "<table><tr><td>x</td></tr>tail</table>",
    ],
)
def test_parser_preflight_rejects_unclosed_and_foster_parented_text(html):
    with pytest.raises(ValueError, match="parser-profile-unsupported"):
        extract_canonical_text(html)


def test_parser_preflight_rejects_invalid_utf8_surrogate():
    with pytest.raises(ValueError, match="parser-profile-unsupported"):
        extract_canonical_text("<p>bad\ud800</p>")


def test_colon_qualified_elements_count_toward_depth_limit():
    nested = "".join("<x:y>" for _ in range(257))
    closing = "".join("</x:y>" for _ in range(257))
    with pytest.raises(ValueError, match="resource-limit-exceeded"):
        extract_canonical_text(nested + "x" + closing)


def test_inline_link_no_separator():
    """Anchor tags are inline; they must NOT add separators. With a base URL
    the relative href resolves and emits a signed-attribute record."""
    assert (
        extract_canonical_text(
            '<p>see <a href="x">here</a> now</p>',
            base_url="https://example.org/",
        )
        == "see @attr:a:href:https://example.org/x\nhere now"
    )


def test_relative_url_no_base_fails():
    """A relative href with no base URL MUST fail (draft §4.3.2)."""
    with pytest.raises(ValueError, match="attribute-canonicalization-failed"):
        extract_canonical_text('<p><a href="x">here</a></p>')


def test_invalid_base_url_fails_without_url_attributes():
    with pytest.raises(ValueError, match="attribute-canonicalization-failed"):
        extract_canonical_text("<p>x</p>", base_url="not a URL")


def test_output_limit_applies_after_finalization():
    unit = '<p href="x" src="x" alt="x" aria-label="x"></p>'
    output = extract_canonical_text(
        unit * 10_000,
        base_url="https://example.com/",
    )
    assert len(output.encode("utf-8")) == 1_039_999


def test_signed_semantic_attributes_are_canonicalized():
    html = (
        '<p><a href="/story?a=1&amp;b=2" aria-label="Read “more”">link</a>'
        '<img src="img.png" alt="Hero — image"></p>'
    )
    assert extract_canonical_text(html, base_url="https://example.org/base/page.html") == (
        '@attr:a:href:https://example.org/story?a=1&b=2\n'
        '@attr:a:aria-label:Read "more"\n'
        'link\n'
        '@attr:img:src:https://example.org/base/img.png\n'
        '@attr:img:alt:Hero - image'
    )
