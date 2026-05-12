"""Conformance tests for ``extract_canonical_text``.

These cases mirror the contract of the JavaScript reference
``extractCanonicalText`` and confirm that block-element boundaries
become whitespace, inline elements do not, excluded elements vanish
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


def test_block_boundary_inserts_space():
    """<p>A</p><p>B</p> -> "A B" (not "AB")."""
    assert (
        extract_canonical_text("<p>A</p><p>B</p>") == "A B"
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
    assert extract_canonical_text(html) == "before after"


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


def test_nested_blocks():
    """Deeply nested block structure still produces single-space joins."""
    html = (
        "<article>"
        "<header><h1>Title</h1></header>"
        "<section><p>Para one.</p><p>Para two.</p></section>"
        "</article>"
    )
    out = extract_canonical_text(html)
    # We don't pin the exact spacing count beyond "single-space collapsed",
    # since multiple block-boundary spaces must collapse via phase 2.
    assert out == "Title Para one. Para two."


def test_list_items_separated():
    assert (
        extract_canonical_text("<ul><li>a</li><li>b</li><li>c</li></ul>")
        == "a b c"
    )


def test_extract_rejects_non_string():
    with pytest.raises(TypeError):
        extract_canonical_text(123)  # type: ignore[arg-type]


def test_table_cells_separated():
    html = "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>"
    assert extract_canonical_text(html) == "a b c d"


def test_inline_link_no_separator():
    """Anchor tags are inline; they must NOT add separators."""
    assert (
        extract_canonical_text('<p>see <a href="x">here</a> now</p>')
        == "see here now"
    )
