"""Strict raw JSON Canonicalization Scheme (RFC 8785) entry point."""

from __future__ import annotations

import json
import math
from typing import Any

import rfc8785

_MAX_DOCUMENT_BYTES = 1024 * 1024
_MAX_NESTING_DEPTH = 256


def _enforce_nesting_limit(document: bytes) -> None:
    depth = 0
    in_string = False
    escaped = False
    for byte in document:
        if in_string:
            if escaped:
                escaped = False
            elif byte == 0x5C:
                escaped = True
            elif byte == 0x22:
                in_string = False
            continue
        if byte == 0x22:
            in_string = True
        elif byte in (0x5B, 0x7B):
            depth += 1
            if depth > _MAX_NESTING_DEPTH:
                raise ValueError("resource-limit-exceeded")
        elif byte in (0x5D, 0x7D):
            depth -= 1


def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("jcs-duplicate-key")
        result[key] = value
    return result


def _finite(value: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("jcs-number") from exc
    if not math.isfinite(number):
        raise ValueError("jcs-number")
    return number


def _reject_surrogates(value: Any) -> None:
    if isinstance(value, str):
        if any(0xD800 <= ord(ch) <= 0xDFFF for ch in value):
            raise ValueError("jcs-invalid-surrogate")
    elif isinstance(value, list):
        for item in value:
            _reject_surrogates(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            _reject_surrogates(key)
            _reject_surrogates(item)


def canonicalize_json_document(document: str | bytes) -> str:
    """Parse and canonicalize one raw JSON document using RFC 8785.

    Duplicate members, non-finite/overflowing numbers, invalid JSON, and
    lone UTF-16 surrogate code points are rejected before serialization.
    """
    if not isinstance(document, (str, bytes, bytearray)):
        raise TypeError("canonicalize_json_document expects raw JSON text")
    try:
        document_bytes = document.encode("utf-8", "strict") if isinstance(document, str) else bytes(document)
        document_bytes.decode("utf-8", "strict")
    except (UnicodeEncodeError, UnicodeDecodeError) as exc:
        raise ValueError("jcs-invalid-surrogate") from exc
    if len(document_bytes) > _MAX_DOCUMENT_BYTES:
        raise ValueError("resource-limit-exceeded")
    _enforce_nesting_limit(document_bytes)
    try:
        value = json.loads(
            document_bytes,
            object_pairs_hook=_pairs,
            parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("jcs-invalid-json")),
            parse_float=_finite,
            parse_int=_finite,
        )
    except ValueError as exc:
        if str(exc) in {"jcs-duplicate-key", "jcs-invalid-json", "jcs-number", "jcs-invalid-surrogate"}:
            raise
        raise ValueError("jcs-invalid-json") from exc
    _reject_surrogates(value)
    try:
        canonical = rfc8785.dumps(value)
    except (ValueError, TypeError, OverflowError) as exc:
        raise ValueError("jcs-number") from exc
    if len(canonical) > _MAX_DOCUMENT_BYTES:
        raise ValueError("resource-limit-exceeded")
    return canonical.decode("utf-8")
