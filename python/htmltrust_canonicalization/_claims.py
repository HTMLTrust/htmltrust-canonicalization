"""Canonical claims serialization (HTMLTrust spec §2.1).

Direct port of ``canonicalizeClaims`` from the JavaScript reference
implementation. Claims are normalized through the same pipeline as
content text and emitted as a sorted list of ``name=value`` pairs joined
by newlines. The caller is responsible for hashing the result.
"""

from __future__ import annotations

from collections.abc import Mapping

from ._normalize import normalize_text


def canonicalize_claims(claims: Mapping[str, object]) -> str:
    """Serialize ``claims`` to the canonical, sortable, hashable string form.

    Each claim name and value is run through ``normalize_text`` so that
    Unicode equivalents collapse to identical bytes. Entries are then
    sorted lexically by name and joined with newlines as ``name=value``.

    Args:
        claims: Mapping of claim name to value. Values are coerced to
            ``str`` before normalization so callers may pass simple
            scalar types.

    Returns:
        Canonical serialized string ready to be hashed.
    """
    if not isinstance(claims, Mapping):
        raise TypeError("canonicalize_claims expects a Mapping")

    entries = [
        (normalize_text(name), normalize_text(str(value)))
        for name, value in claims.items()
    ]
    entries.sort(key=lambda nv: nv[0])
    return "\n".join(f"{name}={value}" for name, value in entries)
