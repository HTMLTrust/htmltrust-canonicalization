"""Python adapter for the mandatory HTMLTrust Rust canonicalization core.

Construct :class:`RustCore` with the absolute path to a release artifact, then
call its five canonicalization methods. The package contains no independent
canonicalization implementation.
"""

from .rust_core import RustCore, RustCoreError

__all__ = [
    "RustCore",
    "RustCoreError",
]

__version__ = "0.3.0"
