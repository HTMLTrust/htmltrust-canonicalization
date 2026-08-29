"""HTMLTrust canonicalization (Python binding).

Public API:
    - normalize_text(text, preserve_whitespace=False) -> str
    - extract_canonical_text(html, preserve_whitespace=False) -> str
    - canonicalize_claims(claims) -> str
    - extract_claims_from_signed_section(html) -> dict[str, str]
    - canonicalize_json_document(document) -> str

This binding produces byte-identical output to the JavaScript, Go, PHP,
and Rust implementations of the HTMLTrust canonicalization library.
"""

from ._normalize import normalize_text
from ._extract import extract_canonical_text
from ._claims import canonicalize_claims, extract_claims_from_signed_section
from ._jcs import canonicalize_json_document
from .rust_core import RustCore, RustCoreError

__all__ = [
    "normalize_text",
    "extract_canonical_text",
    "canonicalize_claims",
    "extract_claims_from_signed_section",
    "canonicalize_json_document",
    "RustCore",
    "RustCoreError",
]

__version__ = "0.3.0"
