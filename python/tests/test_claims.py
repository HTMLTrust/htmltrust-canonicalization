"""Conformance tests for ``canonicalize_claims``.

Mirrors the JavaScript reference ``canonicalizeClaims``. Output MUST be
byte-identical across language bindings: claim entries serialize as
``name=value`` lines, sorted lexically by name, joined by ``\\n``.
"""

import pytest

from htmltrust_canonicalization import canonicalize_claims


def test_empty_claims():
    assert canonicalize_claims({}) == ""


def test_single_claim():
    assert canonicalize_claims({"License": "CC-BY-4.0"}) == "License=CC-BY-4.0"


def test_sorted_by_name():
    """Order in -> sorted out, regardless of source ordering."""
    out = canonicalize_claims({
        "License": "CC-BY-4.0",
        "AIAssistance": "None",
        "ContentType": "Article",
    })
    assert out == (
        "AIAssistance=None\n"
        "ContentType=Article\n"
        "License=CC-BY-4.0"
    )


def test_normalizes_values():
    """Values run through normalize_text -- curly quotes collapse."""
    out = canonicalize_claims({"author": "“Alice”"})
    assert out == 'author="Alice"'


def test_normalizes_names():
    """Claim names also normalize -- ensures hash determinism."""
    # An ellipsis in a claim name is exotic but tests the contract.
    out = canonicalize_claims({"odd…name": "x"})
    assert out == "odd...name=x"


def test_coerces_value_to_string():
    out = canonicalize_claims({"count": 42, "enabled": True})
    # Booleans serialize as "True" / "False" via str(); that's fine for
    # this layer -- callers should pre-stringify if they need different
    # representations.
    assert "count=42" in out
    assert "enabled=True" in out


def test_rejects_non_mapping():
    with pytest.raises(TypeError):
        canonicalize_claims([("a", "b")])  # type: ignore[arg-type]
