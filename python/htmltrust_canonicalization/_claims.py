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

_MAX_CLAIMS = 64
_MAX_CLAIM_BYTES = 4 * 1024


def _claim_field(value: str) -> str:
    try:
        value.encode("utf-8", "strict")
    except UnicodeEncodeError as exc:
        raise ValueError("claim-malformed") from exc
    value = normalize_text(value).strip()
    if len(value.encode("utf-8")) > _MAX_CLAIM_BYTES:
        raise ValueError("resource-limit-exceeded")
    return value


def _escape_claim(value: str) -> str:
    return value.replace("\\", "\\\\").replace(":", "\\:").replace("\n", "\\n")


def canonicalize_claims(claims: Mapping[str, str]) -> str:
    """Serialize ``claims`` to the canonical, sortable, hashable string form.

    Each claim name and value is run through ``normalize_text`` so that
    Unicode equivalents collapse to identical bytes. Entries are then
    sorted lexically by name and emitted as ``name:content\n`` records.

    Args:
        claims: Mapping of string claim names to string values.

    Returns:
        Canonical serialized string ready to be hashed.
    """
    if not isinstance(claims, Mapping):
        raise TypeError("canonicalize_claims expects a Mapping")

    entries = []
    seen = set()
    if len(claims) > _MAX_CLAIMS:
        raise ValueError("resource-limit-exceeded")
    for name, value in claims.items():
        if not isinstance(name, str) or not isinstance(value, str):
            raise ValueError("claim-malformed")
        normalized_name = _claim_field(name)
        normalized_value = _claim_field(value)
        if not normalized_name:
            raise ValueError("claim-malformed")
        if normalized_name in seen:
            raise ValueError(f"claim-duplicate: {normalized_name}")
        seen.add(normalized_name)
        entries.append((normalized_name, normalized_value))
    entries.sort(key=lambda nv: nv[0])
    return "".join(f"{_escape_claim(name)}:{_escape_claim(value)}\n" for name, value in entries)


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

    # Run the same source-profile checks as content extraction before using
    # the recovered HTML5 tree.
    from ._extract import _preflight_source
    _preflight_source(html)
    soup = BeautifulSoup(html, "html5lib")
    section = soup.find("signed-section")
    root = section if section is not None else soup
    claims: dict[str, str] = {}
    seen: set[str] = set()
    children = list(getattr(root, "children", ()))
    if section is None:
        # html5lib moves top-level metadata into <head>.  When callers pass
        # an inner signed-section fragment, those head/html wrappers are
        # parser scaffolding, so retain only metadata whose intervening
        # ancestors are html/head/body.
        children = [
            elem for elem in soup.find_all("meta")
            if all(
                ancestor.name in {"html", "head", "body", "[document]"}
                for ancestor in elem.parents
                if ancestor.name is not None
            )
        ]
    for child in children:
        if not isinstance(child, Tag) or child.name.lower() != "meta":
            continue
        if not child.has_attr("name") or not child.has_attr("content"):
            raise ValueError("claim-malformed")
        if len(claims) >= _MAX_CLAIMS:
            raise ValueError("resource-limit-exceeded")
        name = _claim_field(str(child["name"]))
        content = _claim_field(str(child["content"]))
        if not name:
            raise ValueError("claim-malformed")
        if name in seen:
            raise ValueError(f"claim-duplicate: {name}")
        seen.add(name)
        claims[name] = content
    return claims
