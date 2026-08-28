import pytest

from htmltrust_canonicalization import canonicalize_json_document


def test_jcs_sorts_utf16_keys_and_numbers():
    assert canonicalize_json_document(
        '{"a":1e30,"b":4.50,"😀":2,"":1}'
    ) == '{"a":1e+30,"b":4.5,"😀":2,"":1}'


def test_jcs_uses_binary64_for_large_integer_tokens():
    assert canonicalize_json_document(
        '[9007199254740992,295147905179352830000,1424953923781206.25]'
    ) == '[9007199254740992,295147905179352830000,1424953923781206.2]'


@pytest.mark.parametrize(
    ("document", "reason"),
    [
        ('{"a":1,"a":2}', "jcs-duplicate-key"),
        ('"\\uD800"', "jcs-invalid-surrogate"),
        ('{"n":1e400}', "jcs-number"),
        ('{"n":-0}', "jcs-number"),
        ('{"n":-1e-400}', "jcs-number"),
    ],
)
def test_jcs_rejects_unsafe_raw_json(document, reason):
    with pytest.raises(ValueError, match=reason):
        canonicalize_json_document(document)


def test_jcs_rejects_excessive_nesting():
    document = "[" * 257 + "0" + "]" * 257
    with pytest.raises(ValueError, match="resource-limit-exceeded"):
        canonicalize_json_document(document)


def test_jcs_malformed_json_precedes_surrogate_classification():
    with pytest.raises(ValueError, match="jcs-invalid-json"):
        canonicalize_json_document('{"value":"\\uD800')


def test_jcs_source_limit_precedes_malformed_json():
    with pytest.raises(ValueError, match="resource-limit-exceeded"):
        canonicalize_json_document("{" * (1024 * 1024 + 1))


def test_jcs_bytes_reject_invalid_utf8_as_malformed_json():
    with pytest.raises(ValueError, match="jcs-invalid-json"):
        canonicalize_json_document(b'{"value":"\xff"}')
