import os
import sys

import pytest

from htmltrust_canonicalization import RustCore, RustCoreError


LIBRARY = os.environ.get("HTMLTRUST_RUST_CORE_LIB")
WRONG_ABI_LIBRARY = os.environ.get("HTMLTRUST_RUST_CORE_WRONG_ABI_LIB")
MISSING_OPERATION_LIBRARY = os.environ.get(
    "HTMLTRUST_RUST_CORE_MISSING_OPERATION_LIB"
)


def test_explicit_path_is_required():
    with pytest.raises(ValueError, match="library_path must be absolute"):
        RustCore("libhtmltrust_canonicalization_ffi.so")
    with pytest.raises((OSError, ValueError, RuntimeError)):
        RustCore("/definitely/missing/htmltrust-canonicalization-ffi.so")


@pytest.mark.skipif(
    sys.platform != "linux" or not WRONG_ABI_LIBRARY,
    reason="Linux shared-core fixture is not configured",
)
def test_constructor_rejects_wrong_abi_fixture():
    with pytest.raises(RuntimeError, match=r"unsupported htmltrust C ABI version 999"):
        RustCore(WRONG_ABI_LIBRARY)


@pytest.mark.skipif(
    sys.platform != "linux" or not MISSING_OPERATION_LIBRARY,
    reason="Linux shared-core fixture is not configured",
)
def test_constructor_rejects_missing_operation_fixture():
    with pytest.raises(
        RuntimeError,
        match="htmltrust C ABI symbol is missing: htmltrust_canonicalize_json_document_v1",
    ):
        RustCore(MISSING_OPERATION_LIBRARY)


@pytest.mark.skipif(not LIBRARY, reason="HTMLTRUST_RUST_CORE_LIB is not set")
def test_rust_core_all_operations_and_edge_inputs():
    core = RustCore(LIBRARY)
    assert core.normalize_text("A—B") == "A-B"
    assert core.normalize_text("a\x00b") == "a\x00b"
    assert core.normalize_text("") == ""
    assert core.extract_canonical_text("<p>A</p>", base_url="https://example.com/") == "A"
    assert core.extract_canonical_text("<p>A</p>", base_url="") == "A"
    assert core.canonicalize_claims({"z": "2", "a": "1"}) == "a:1\nz:2\n"
    assert core.canonicalize_claims({}) == ""
    assert core.canonicalize_json_document('{"z":0,"a":1}') == '{"a":1,"z":0}'
    with pytest.raises(RustCoreError, match="jcs-invalid-json") as invalid_json:
        core.canonicalize_json_document("{")
    assert invalid_json.value.code == "jcs-invalid-json"
    with pytest.raises(RustCoreError, match="jcs-invalid-surrogate"):
        core.canonicalize_json_document('"\ud800"')
