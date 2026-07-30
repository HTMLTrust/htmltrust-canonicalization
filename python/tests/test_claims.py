"""Conformance tests for ``canonicalize_claims``.

Mirrors the JavaScript reference ``canonicalizeClaims``. Output MUST be
byte-identical across language bindings: claim entries serialize as
``name:content\\n`` records, sorted lexically by name.
"""

import pytest

from htmltrust_canonicalization import canonicalize_claims, extract_claims_from_signed_section


def test_empty_claims():
    assert canonicalize_claims({}) == ""


def test_single_claim():
    assert canonicalize_claims({"License": "CC-BY-4.0"}) == "License:CC-BY-4.0\n"


def test_sorted_by_name():
    """Order in -> sorted out, regardless of source ordering."""
    out = canonicalize_claims({
        "License": "CC-BY-4.0",
        "AIAssistance": "None",
        "ContentType": "Article",
    })
    assert out == (
        "AIAssistance:None\n"
        "ContentType:Article\n"
        "License:CC-BY-4.0\n"
    )


def test_normalizes_values():
    """Values run through normalize_text -- curly quotes collapse."""
    out = canonicalize_claims({"author": "“Alice”"})
    assert out == 'author:"Alice"\n'


def test_normalizes_names():
    """Claim names also normalize -- ensures hash determinism."""
    # An ellipsis in a claim name is exotic but tests the contract.
    out = canonicalize_claims({"odd…name": "x"})
    assert out == "odd...name:x\n"


def test_coerces_value_to_string():
    out = canonicalize_claims({"count": 42, "enabled": True})
    # Booleans serialize as "True" / "False" via str(); that's fine for
    # this layer -- callers should pre-stringify if they need different
    # representations.
    assert "count:42" in out
    assert "enabled:True" in out


def test_rejects_non_mapping():
    with pytest.raises(TypeError):
        canonicalize_claims([("a", "b")])  # type: ignore[arg-type]


def test_extract_claims_includes_all_direct_child_meta():
    html = """
    <signed-section>
      <meta name="author" content="Alice Example">
      <meta name="signed-at" content="2026-05-01T10:30:00Z">
      <meta name="claim:License" content="CC-BY-4.0">
      <div><meta name="author" content="Nested"></div>
    </signed-section>
    """
    assert extract_claims_from_signed_section(html) == {
        "author": "Alice Example",
        "signed-at": "2026-05-01T10:30:00Z",
        "claim:License": "CC-BY-4.0",
    }


def test_extract_claims_rejects_duplicate_normalized_names():
    with pytest.raises(ValueError, match="claim-duplicate"):
        extract_claims_from_signed_section(
            '<meta name="author" content="A"><meta name="author" content="B">'
        )
