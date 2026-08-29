#ifndef HTMLTRUST_CANONICALIZATION_H
#define HTMLTRUST_CANONICALIZATION_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Version of this stable, length-based ABI contract. */
uint32_t htmltrust_abi_version_v1(void);

/*
 * Versioned operations return:
 *   0: success, output contains canonical UTF-8 bytes;
 *   1: canonicalization failed, output contains a UTF-8 error code;
 *   2: invalid pointer arguments, output is cleared and not allocated.
 *
 * On status 0 or 1, release the output with htmltrust_bytes_free(). A NULL
 * input pointer is valid only when its length is zero. Output pointers are
 * cleared before input decoding. A zero-length base URL means no base URL,
 * regardless of whether its pointer is NULL.
 */

int32_t htmltrust_extract_canonical_text_v1(
    const uint8_t *html,
    size_t html_len,
    const uint8_t *base_url,
    size_t base_url_len,
    uint8_t **out,
    size_t *out_len);

int32_t htmltrust_extract_canonical_text_options_v1(
    const uint8_t *html,
    size_t html_len,
    const uint8_t *base_url,
    size_t base_url_len,
    bool preserve_whitespace,
    uint8_t **out,
    size_t *out_len);

int32_t htmltrust_normalize_text_v1(
    const uint8_t *text,
    size_t text_len,
    bool preserve_whitespace,
    uint8_t **out,
    size_t *out_len);

int32_t htmltrust_canonicalize_claims_v1(
    const uint8_t *claims,
    size_t claims_len,
    uint8_t **out,
    size_t *out_len);

int32_t htmltrust_canonicalize_json_document_v1(
    const uint8_t *json,
    size_t json_len,
    uint8_t **out,
    size_t *out_len);

void htmltrust_bytes_free(uint8_t *ptr, size_t len);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* HTMLTRUST_CANONICALIZATION_H */
