// Linux-only shared-core constructor fixture: ABI v1 with the JSON
// canonicalization operation deliberately absent. The other symbols are
// present so adapters must validate the complete required symbol set.
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

uint32_t htmltrust_abi_version_v1(void) { return 1; }

static int32_t invalid_argument(uint8_t **out, size_t *out_len) {
    if (out != NULL) {
        *out = NULL;
    }
    if (out_len != NULL) {
        *out_len = 0;
    }
    return 2;
}

int32_t htmltrust_normalize_text_v1(
    const uint8_t *text,
    size_t text_len,
    bool preserve_whitespace,
    uint8_t **out,
    size_t *out_len
) {
    (void) text;
    (void) text_len;
    (void) preserve_whitespace;
    return invalid_argument(out, out_len);
}

int32_t htmltrust_extract_canonical_text_options_v1(
    const uint8_t *html,
    size_t html_len,
    const uint8_t *base_url,
    size_t base_url_len,
    bool preserve_whitespace,
    uint8_t **out,
    size_t *out_len
) {
    (void) html;
    (void) html_len;
    (void) base_url;
    (void) base_url_len;
    (void) preserve_whitespace;
    return invalid_argument(out, out_len);
}

int32_t htmltrust_canonicalize_claims_v1(
    const uint8_t *claims,
    size_t claims_len,
    uint8_t **out,
    size_t *out_len
) {
    (void) claims;
    (void) claims_len;
    return invalid_argument(out, out_len);
}

// htmltrust_canonicalize_json_document_v1 is intentionally omitted.

void htmltrust_bytes_free(uint8_t *ptr, size_t len) {
    (void) ptr;
    (void) len;
}
