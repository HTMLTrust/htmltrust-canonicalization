"""Explicit-path adapter for the HTMLTrust Rust canonicalization core.

The adapter deliberately does not search the process, environment, or package
installation for a library.  Applications choose the exact native library
with :class:`RustCore`, which makes deployment and upgrades auditable.
"""

from __future__ import annotations

import ctypes
import json
import os
from collections.abc import Mapping
from typing import Final


ABI_VERSION: Final = 1
_MAX_DOCUMENT_BYTES: Final = 1024 * 1024


class RustCoreError(ValueError):
    """A canonicalization failure returned by the Rust ABI."""

    def __init__(self, code: str, status: int = 1) -> None:
        self.code = code
        self.status = status
        super().__init__(code)


class RustCore:
    """Call the versioned length-based Rust C ABI from Python.

    ``library_path`` is mandatory.  The constructor checks the ABI before the
    object is usable and validates every symbol needed by the five operations.
    """

    def __init__(self, library_path: str | os.PathLike[str]) -> None:
        if not isinstance(library_path, (str, os.PathLike)):
            raise TypeError("library_path must be a path")
        path = os.fspath(library_path)
        if not path:
            raise ValueError("library_path must not be empty")
        if not os.path.isabs(path):
            raise ValueError("library_path must be absolute")
        self._library = ctypes.CDLL(path)
        self._configure()
        version = int(self._abi_version())
        if version != ABI_VERSION:
            raise RuntimeError(
                f"unsupported htmltrust C ABI version {version}; expected {ABI_VERSION}"
            )

    def _configure(self) -> None:
        byte_ptr = ctypes.POINTER(ctypes.c_uint8)
        byte_ptr_ptr = ctypes.POINTER(byte_ptr)
        size_ptr = ctypes.POINTER(ctypes.c_size_t)

        self._abi_version = self._required("htmltrust_abi_version_v1")
        self._abi_version.argtypes = []
        self._abi_version.restype = ctypes.c_uint32

        self._normalize = self._required("htmltrust_normalize_text_v1")
        self._normalize.argtypes = [
            byte_ptr,
            ctypes.c_size_t,
            ctypes.c_bool,
            byte_ptr_ptr,
            size_ptr,
        ]
        self._normalize.restype = ctypes.c_int32

        self._extract = self._required("htmltrust_extract_canonical_text_options_v1")
        self._extract.argtypes = [
            byte_ptr,
            ctypes.c_size_t,
            byte_ptr,
            ctypes.c_size_t,
            ctypes.c_bool,
            byte_ptr_ptr,
            size_ptr,
        ]
        self._extract.restype = ctypes.c_int32

        self._claims = self._required("htmltrust_canonicalize_claims_v1")
        self._claims.argtypes = [byte_ptr, ctypes.c_size_t, byte_ptr_ptr, size_ptr]
        self._claims.restype = ctypes.c_int32

        self._extract_claims = self._required(
            "htmltrust_extract_claims_from_signed_section_v1"
        )
        self._extract_claims.argtypes = [
            byte_ptr,
            ctypes.c_size_t,
            byte_ptr_ptr,
            size_ptr,
        ]
        self._extract_claims.restype = ctypes.c_int32

        self._jcs = self._required("htmltrust_canonicalize_json_document_v1")
        self._jcs.argtypes = [byte_ptr, ctypes.c_size_t, byte_ptr_ptr, size_ptr]
        self._jcs.restype = ctypes.c_int32

        self._free = self._required("htmltrust_bytes_free")
        self._free.argtypes = [byte_ptr, ctypes.c_size_t]
        self._free.restype = None

    def _required(self, name: str):
        try:
            return getattr(self._library, name)
        except AttributeError as exc:
            raise RuntimeError(f"htmltrust C ABI symbol is missing: {name}") from exc

    @staticmethod
    def _input(value: bytes) -> tuple[object, int, object]:
        """Return a pointer, byte length, and owner for a byte buffer."""
        if not value:
            owner = (ctypes.c_uint8 * 1)()
            return ctypes.cast(owner, ctypes.POINTER(ctypes.c_uint8)), 0, owner
        owner = (ctypes.c_uint8 * len(value)).from_buffer_copy(value)
        return ctypes.cast(owner, ctypes.POINTER(ctypes.c_uint8)), len(value), owner

    def _call(self, function, *args) -> bytes:
        out = ctypes.POINTER(ctypes.c_uint8)()
        out_len = ctypes.c_size_t(0)
        status = int(function(*args, ctypes.byref(out), ctypes.byref(out_len)))
        try:
            if status not in (0, 1):
                raise RustCoreError("invalid-argument", status)
            if out_len.value > _MAX_DOCUMENT_BYTES:
                raise RustCoreError("invalid-output", status)
            if out_len.value and not bool(out):
                raise RustCoreError("invalid-output", status)
            data = b"" if not out_len.value else ctypes.string_at(out, out_len.value)
            if status == 1:
                try:
                    code = data.decode("utf-8")
                except UnicodeDecodeError as exc:
                    raise RustCoreError("invalid-utf8", status) from exc
                raise RustCoreError(code, status)
            return data
        finally:
            # The ABI permits a zero-length result to have a null pointer.
            # Calling the free function only for a real allocation avoids
            # relying on a particular allocator's null-pointer behavior.
            if bool(out):
                self._free(out, out_len.value)

    @staticmethod
    def _text(
        value: str,
        name: str,
        encoding_error_code: str = "parser-profile-unsupported",
    ) -> bytes:
        if not isinstance(value, str):
            raise TypeError(f"{name} expects a str")
        try:
            return value.encode("utf-8", "strict")
        except UnicodeEncodeError as exc:
            raise RustCoreError(encoding_error_code) from exc

    def normalize_text(self, text: str, preserve_whitespace: bool = False) -> str:
        raw = self._text(text, "normalize_text")
        ptr, length, _owner = self._input(raw)
        result = self._call(self._normalize, ptr, length, bool(preserve_whitespace))
        return result.decode("utf-8", "strict")

    def extract_canonical_text(
        self,
        html: str,
        preserve_whitespace: bool = False,
        base_url: str | None = None,
    ) -> str:
        raw_html = self._text(html, "extract_canonical_text")
        if base_url is not None and not isinstance(base_url, str):
            raise TypeError("base_url must be a str or None")
        raw_base = b"" if base_url in (None, "") else self._text(base_url, "base_url")
        html_ptr, html_len, _html_owner = self._input(raw_html)
        if base_url in (None, ""):
            base_ptr, base_len, _base_owner = None, 0, None
        else:
            base_ptr, base_len, _base_owner = self._input(raw_base)
        result = self._call(
            self._extract,
            html_ptr,
            html_len,
            base_ptr,
            base_len,
            bool(preserve_whitespace),
        )
        return result.decode("utf-8", "strict")

    def canonicalize_claims(self, claims: Mapping[str, str]) -> str:
        if not isinstance(claims, Mapping):
            raise TypeError("canonicalize_claims expects a Mapping")
        try:
            validated = dict(claims)
        except Exception as exc:
            raise RustCoreError("claim-malformed") from exc
        if any(
            not isinstance(name, str) or not isinstance(value, str)
            for name, value in validated.items()
        ):
            raise RustCoreError("claim-malformed")
        try:
            raw = json.dumps(
                validated, ensure_ascii=False, separators=(",", ":"), allow_nan=False
            ).encode("utf-8", "strict")
        except (TypeError, ValueError, UnicodeEncodeError) as exc:
            raise RustCoreError("claim-malformed") from exc
        ptr, length, _owner = self._input(raw)
        result = self._call(self._claims, ptr, length)
        return result.decode("utf-8", "strict")

    def extract_claims_from_signed_section(self, html: str) -> dict[str, str]:
        raw = self._text(html, "extract_claims_from_signed_section")
        ptr, length, _owner = self._input(raw)
        result = self._call(self._extract_claims, ptr, length)
        try:
            claims = json.loads(result.decode("utf-8", "strict"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RustCoreError("invalid-output", 0) from exc
        if not isinstance(claims, dict) or any(
            not isinstance(name, str) or not isinstance(value, str)
            for name, value in claims.items()
        ):
            raise RustCoreError("invalid-output", 0)
        return claims

    def canonicalize_json_document(self, document: str | bytes | bytearray) -> str:
        if isinstance(document, str):
            raw = self._text(
                document,
                "canonicalize_json_document",
                "jcs-invalid-surrogate",
            )
        elif isinstance(document, (bytes, bytearray)):
            raw = bytes(document)
        else:
            raise TypeError("canonicalize_json_document expects raw JSON text")
        ptr, length, _owner = self._input(raw)
        result = self._call(self._jcs, ptr, length)
        return result.decode("utf-8", "strict")


__all__ = ["ABI_VERSION", "RustCore", "RustCoreError"]
