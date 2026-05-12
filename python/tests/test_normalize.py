"""Conformance tests for ``normalize_text``.

The 18 test cases below are a direct port of
``htmltrust-canonicalization/javascript/test.js`` and MUST produce
byte-identical results across all language bindings.
"""

import pytest

from htmltrust_canonicalization import normalize_text


# (input_a, input_b, should_match, description)
NORMALIZATION_CASES = [
    ("“Hello”", '"Hello"', True, "Curly double quotes -> straight"),
    ("café", "café", True, "Precomposed vs combining (NFKC)"),
    ("ﬁnd", "find", True, "fi ligature (NFKC)"),
    ("word — word", "word - word", True, "Em dash -> hyphen-minus"),
    ("«Bonjour»", '"Bonjour"', True, "Guillemets -> double quotes"),
    (
        "「東京」",
        '"東京"',
        True,
        "CJK corner brackets -> double quotes",
    ),
    (
        "می‌خواهم",
        "میخواهم",
        False,
        "ZWNJ is semantic (Persian)",
    ),
    (
        "كتـــاب",
        "كتاب",
        True,
        "Arabic tatweel stripped",
    ),
    ("Ａ１", "A1", True, "Fullwidth ASCII (NFKC)"),
    ("①", "1", True, "Circled digit (NFKC)"),
    ("word​word", "wordword", True, "ZWSP stripped"),
    ("word‌word", "wordword", False, "ZWNJ preserved (different)"),
    ("Hello…", "Hello...", True, "Ellipsis -> three dots"),
    ("‘Hello’", "'Hello'", True, "Curly single quotes -> straight"),
    ("‚German“", '"German"', True, "Low-9 quotes -> straight"),
    ("a b", "a b", True, "No-break space -> space"),
    ("a　b", "a b", True, "Ideographic space -> space"),
    ("a  \t  b", "a b", True, "Whitespace collapse"),
]


@pytest.mark.parametrize("a,b,should_match,desc", NORMALIZATION_CASES)
def test_normalize_match(a: str, b: str, should_match: bool, desc: str):
    norm_a = normalize_text(a)
    norm_b = normalize_text(b)
    if should_match:
        assert norm_a == norm_b, (
            f"{desc!r}: expected match but got\n"
            f"  A={norm_a!r}\n  B={norm_b!r}"
        )
    else:
        assert norm_a != norm_b, (
            f"{desc!r}: expected mismatch but both normalized to {norm_a!r}"
        )


def test_preserve_whitespace():
    """``preserve_whitespace=True`` must skip phase-2 collapsing."""
    src = "line1\n    line2\t\tline3"
    assert normalize_text(src, preserve_whitespace=True) == src


def test_normalize_text_rejects_non_string():
    with pytest.raises(TypeError):
        normalize_text(123)  # type: ignore[arg-type]


def test_zwj_preserved_emoji():
    """Family ZWJ sequence must survive normalization."""
    family = "\U0001F468‍\U0001F469‍\U0001F467"
    assert normalize_text(family) == family


def test_idempotent():
    """Normalization must be a fixed-point operation."""
    src = "“Café—test…”"
    once = normalize_text(src)
    twice = normalize_text(once)
    assert once == twice
