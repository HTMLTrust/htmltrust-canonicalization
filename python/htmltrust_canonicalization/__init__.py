"""HTMLTrust canonicalization (Python binding).

Public API:
    - normalize_text(text, preserve_whitespace=False) -> str
    - extract_canonical_text(html, preserve_whitespace=False) -> str
    - canonicalize_claims(claims) -> str

This binding produces byte-identical output to the JavaScript, Go, PHP,
and Rust implementations of the HTMLTrust canonicalization library.
"""

from ._normalize import normalize_text
from ._extract import extract_canonical_text
from ._claims import canonicalize_claims

__all__ = [
    "normalize_text",
    "extract_canonical_text",
    "canonicalize_claims",
]

__version__ = "0.1.0"
