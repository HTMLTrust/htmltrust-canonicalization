#include "htmltrust_canonicalization.h"

#include <string.h>

static int expect_bytes(
    int32_t status,
    uint8_t *output,
    size_t output_len,
    const char *expected) {
    size_t expected_len = strlen(expected);
    int failed = status != 0 || output_len != expected_len;
    if (!failed && expected_len != 0) {
        failed = output == NULL || memcmp(output, expected, expected_len) != 0;
    }
    htmltrust_bytes_free(output, output_len);
    return failed;
}

int main(void) {
    uint8_t *output = NULL;
    size_t output_len = 0;
    int32_t status;

    if (htmltrust_abi_version_v1() != 1) {
        return 1;
    }

    const uint8_t text[] = "A  B";
    status = htmltrust_normalize_text_v1(
        text, sizeof(text) - 1, false, &output, &output_len);
    if (expect_bytes(status, output, output_len, "A B")) {
        return 2;
    }

    const uint8_t html[] = "<p>Ready.</p>";
    status = htmltrust_extract_canonical_text_v1(
        html, sizeof(html) - 1, NULL, 0, &output, &output_len);
    if (expect_bytes(status, output, output_len, "Ready.")) {
        return 3;
    }

    const uint8_t claims[] = "{\"z\":\"2\",\"a\":\"1\"}";
    status = htmltrust_canonicalize_claims_v1(
        claims, sizeof(claims) - 1, &output, &output_len);
    if (expect_bytes(status, output, output_len, "a:1\nz:2\n")) {
        return 4;
    }

    const uint8_t section[] =
        "<signed-section><meta name=\"z\" content=\"2\">"
        "<meta name=\"a\" content=\"1\"></signed-section>";
    status = htmltrust_extract_claims_from_signed_section_v1(
        section, sizeof(section) - 1, &output, &output_len);
    if (expect_bytes(status, output, output_len, "{\"a\":\"1\",\"z\":\"2\"}")) {
        return 5;
    }

    const uint8_t json[] = "{\"z\":0,\"a\":1}";
    status = htmltrust_canonicalize_json_document_v1(
        json, sizeof(json) - 1, &output, &output_len);
    if (expect_bytes(status, output, output_len, "{\"a\":1,\"z\":0}")) {
        return 6;
    }

    return 0;
}
