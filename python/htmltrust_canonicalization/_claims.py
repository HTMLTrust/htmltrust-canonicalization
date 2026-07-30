"""Canonical claims serialization and extraction (HTMLTrust spec §4.6).

Direct port of ``canonicalizeClaims`` from the JavaScript reference
implementation. Claims are normalized through the same pipeline as
content text and emitted as a sorted list of ``name:content\n`` records.
The caller is responsible for hashing the result.
"""

from __future__ import annotations

from collections.abc import Mapping

from bs4 import BeautifulSoup, Tag

from ._normalize import normalize_text


def canonicalize_claims(claims: Mapping[str, object]) -> str:
    """Serialize ``claims`` to the canonical, sortable, hashable string form.

    Each claim name and value is run through ``normalize_text`` so that
    Unicode equivalents collapse to identical bytes. Entries are then
    sorted lexically by name and emitted as ``name:content\n`` records.

    Args:
        claims: Mapping of claim name to value. Values are coerced to
            ``str`` before normalization so callers may pass simple
            scalar types.

    Returns:
        Canonical serialized string ready to be hashed.
    """
    if not isinstance(claims, Mapping):
        raise TypeError("canonicalize_claims expects a Mapping")

    entries = []
    seen = set()
    for name, value in claims.items():
        normalized_name = normalize_text(name).strip()
        normalized_value = normalize_text(str(value)).strip()
        if not normalized_name:
            raise ValueError("claim-malformed")
        if normalized_name in seen:
            raise ValueError(f"claim-duplicate: {normalized_name}")
        seen.add(normalized_name)
        entries.append((normalized_name, normalized_value))
    entries.sort(key=lambda nv: nv[0])
    return "".join(f"{name}:{value}\n" for name, value in entries)


def extract_claims_from_signed_section(html: str) -> dict[str, str]:
    """Extract direct-child claim ``<meta name content>`` elements.

    If ``html`` contains a ``<signed-section>``, the first one is used.
    Otherwise ``html`` is treated as the inner HTML of a signed section.
    Nested ``<meta>`` elements are ignored. Missing ``name``/``content``,
    empty normalized names, or duplicate normalized names raise ``ValueError``
    with the spec-style failure reason.
    """
    if not isinstance(html, str):
        raise TypeError("extract_claims_from_signed_section expects a str")

    soup = BeautifulSoup(html, "html.parser")
    root = soup.find("signed-section") or soup
    claims: dict[str, str] = {}
    seen: set[str] = set()
    for child in getattr(root, "children", ()):
        if not isinstance(child, Tag) or child.name.lower() != "meta":
            continue
        if not child.has_attr("name") or not child.has_attr("content"):
            raise ValueError("claim-malformed")
        name = normalize_text(str(child["name"])).strip()
        content = normalize_text(str(child["content"])).strip()
        if not name:
            raise ValueError("claim-malformed")
        if name in seen:
            raise ValueError(f"claim-duplicate: {name}")
        seen.add(name)
        claims[name] = content
    return claims
