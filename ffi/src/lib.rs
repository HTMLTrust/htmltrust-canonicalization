//! FFI / WebAssembly bindings for the HTMLTrust canonicalization core.
//!
//! This crate makes the Rust implementation available to native and WebAssembly
//! consumers. The stable v1 boundary covers normalization, HTML extraction,
//! claims serialization, and strict JSON canonicalization.
//!
//! Native builds expose a C ABI for consumers such as Python `ctypes`, Go
//! `cgo`, and PHP FFI. `wasm32` builds expose `wasm-bindgen` functions for
//! JavaScript runtimes.

// ---------------------------------------------------------------------------
// Native C ABI
// ---------------------------------------------------------------------------
#[cfg(not(target_arch = "wasm32"))]
mod capi {
    use std::ffi::{CStr, CString};
    use std::os::raw::c_char;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    const CORE_INTERNAL_ERROR: &[u8] = b"core-internal-error";

    fn to_c(s: String) -> *mut c_char {
        // Canonical text never contains an interior NUL; fall back to empty on
        // the impossible case rather than panicking across the FFI boundary.
        CString::new(s)
            .unwrap_or_else(|_| CString::new("").unwrap())
            .into_raw()
    }

    unsafe fn initialize_byte_outputs(out: *mut *mut u8, out_len: *mut usize) -> bool {
        if !out.is_null() {
            *out = std::ptr::null_mut();
        }
        if !out_len.is_null() {
            *out_len = 0;
        }
        !out.is_null() && !out_len.is_null()
    }

    unsafe fn write_bytes(out: *mut *mut u8, out_len: *mut usize, bytes: Vec<u8>) -> i32 {
        let bytes = bytes.into_boxed_slice();
        *out_len = bytes.len();
        *out = Box::into_raw(bytes) as *mut u8;
        0
    }

    unsafe fn write_result(
        out: *mut *mut u8,
        out_len: *mut usize,
        result: Result<String, String>,
    ) -> i32 {
        match result {
            Ok(value) => write_bytes(out, out_len, value.into_bytes()),
            Err(error) => {
                let bytes = error.into_bytes().into_boxed_slice();
                *out_len = bytes.len();
                *out = Box::into_raw(bytes) as *mut u8;
                1
            }
        }
    }

    unsafe fn catch_result<F>(out: *mut *mut u8, out_len: *mut usize, operation: F) -> i32
    where
        F: FnOnce() -> Result<String, String>,
    {
        match catch_unwind(AssertUnwindSafe(operation)) {
            Ok(result) => write_result(out, out_len, result),
            Err(_) => {
                let _ = write_bytes(out, out_len, CORE_INTERNAL_ERROR.to_vec());
                1
            }
        }
    }

    /// ABI version for the versioned, length-based interface.
    #[no_mangle]
    pub extern "C" fn htmltrust_abi_version_v1() -> u32 {
        1
    }

    /// Extract canonical text from `html`, resolving relative signed-attribute
    /// URLs against `base_url` (may be NULL). On success returns 0 and sets
    /// `*out` to a newly-allocated UTF-8 C string (free with
    /// `htmltrust_string_free`). On canonicalization failure returns 1 and sets
    /// `*out` to the error code string. Returns 2 for an invalid argument,
    /// including a NULL `html`/`out` pointer or invalid UTF-8 in either input.
    /// If `out` is non-NULL, it is initialized to NULL before any input is
    /// decoded or any status is returned.
    ///
    /// # Safety
    /// `html`/`base_url` must be valid NUL-terminated UTF-8 (or NULL for
    /// `base_url`); `out` must be a valid pointer to write one `*mut c_char`.
    #[no_mangle]
    pub unsafe extern "C" fn htmltrust_extract_canonical_text(
        html: *const c_char,
        base_url: *const c_char,
        out: *mut *mut c_char,
    ) -> i32 {
        htmltrust_extract_canonical_text_with_options(html, base_url, false, out)
    }

    /// Option-aware C-string extraction entry point. `preserve_whitespace`
    /// corresponds to the JavaScript `preserveWhitespace` option.
    #[no_mangle]
    pub unsafe extern "C" fn htmltrust_extract_canonical_text_with_options(
        html: *const c_char,
        base_url: *const c_char,
        preserve_whitespace: bool,
        out: *mut *mut c_char,
    ) -> i32 {
        if out.is_null() {
            return 2;
        }
        *out = std::ptr::null_mut();
        if html.is_null() {
            return 2;
        }
        let html = match CStr::from_ptr(html).to_str() {
            Ok(s) => s,
            Err(_) => return 2,
        };
        let base_owned;
        let base = if base_url.is_null() {
            None
        } else {
            match CStr::from_ptr(base_url).to_str() {
                Ok(s) => {
                    base_owned = s;
                    Some(base_owned)
                }
                Err(_) => return 2,
            }
        };
        match htmltrust_canonicalization::try_extract_canonical_text_with_options(
            html,
            htmltrust_canonicalization::ExtractOptions {
                preserve_whitespace,
                base_url: base,
            },
        ) {
            Ok(s) => {
                *out = to_c(s);
                0
            }
            Err(e) => {
                *out = to_c(e);
                1
            }
        }
    }

    /// Length-based v1 API. Both input buffers are UTF-8 byte strings and are
    /// allowed to contain NUL bytes. On success `*out`/`*out_len` contain a
    /// newly allocated UTF-8 buffer; on failure they contain the UTF-8 error
    /// code. Free either result with `htmltrust_bytes_free`.
    ///
    /// A zero-length base URL, with either a NULL or non-NULL pointer, means
    /// no base URL. Status 2 means
    /// an invalid pointer (`out`/`out_len` is NULL, or a non-zero length is
    /// paired with a NULL input pointer); such calls do not allocate a result.
    #[no_mangle]
    pub unsafe extern "C" fn htmltrust_extract_canonical_text_v1(
        html: *const u8,
        html_len: usize,
        base_url: *const u8,
        base_url_len: usize,
        out: *mut *mut u8,
        out_len: *mut usize,
    ) -> i32 {
        if !initialize_byte_outputs(out, out_len) {
            return 2;
        }
        if (html.is_null() && html_len != 0) || (base_url.is_null() && base_url_len != 0) {
            return 2;
        }
        htmltrust_extract_canonical_text_options_v1(
            html,
            html_len,
            base_url,
            base_url_len,
            false,
            out,
            out_len,
        )
    }

    /// Option-aware length-based extraction API. Status 0 indicates success;
    /// status 1 returns a UTF-8 canonicalization error code; status 2 means
    /// invalid arguments (NULL pointer with a non-zero length or a NULL output
    /// pointer). Invalid UTF-8 is a status-1 canonicalization error. For valid
    /// output pointers, `*out` and `*out_len` are initialized to NULL and zero
    /// before decoding input.
    #[no_mangle]
    pub unsafe extern "C" fn htmltrust_extract_canonical_text_options_v1(
        html: *const u8,
        html_len: usize,
        base_url: *const u8,
        base_url_len: usize,
        preserve_whitespace: bool,
        out: *mut *mut u8,
        out_len: *mut usize,
    ) -> i32 {
        if !initialize_byte_outputs(out, out_len) {
            return 2;
        }
        if (html.is_null() && html_len != 0) || (base_url.is_null() && base_url_len != 0) {
            return 2;
        }
        catch_result(out, out_len, || {
            let html = std::slice::from_raw_parts(
                if html.is_null() { b"".as_ptr() } else { html },
                html_len,
            );
            let base = if base_url.is_null() && base_url_len == 0 {
                None
            } else {
                Some(std::slice::from_raw_parts(base_url, base_url_len))
            };
            let html =
                std::str::from_utf8(html).map_err(|_| "parser-profile-unsupported".to_string())?;
            let base = match base {
                Some(bytes) => Some(
                    std::str::from_utf8(bytes)
                        .map_err(|_| "parser-profile-unsupported".to_string())?,
                ),
                None => None,
            };
            htmltrust_canonicalization::try_extract_canonical_text_with_options(
                html,
                htmltrust_canonicalization::ExtractOptions {
                    preserve_whitespace,
                    base_url: base,
                },
            )
        })
    }

    /// Spelling-compatible alias for callers that put the version suffix
    /// before the option suffix.
    #[no_mangle]
    pub unsafe extern "C" fn htmltrust_extract_canonical_text_v1_with_options(
        html: *const u8,
        html_len: usize,
        base_url: *const u8,
        base_url_len: usize,
        preserve_whitespace: bool,
        out: *mut *mut u8,
        out_len: *mut usize,
    ) -> i32 {
        htmltrust_extract_canonical_text_options_v1(
            html,
            html_len,
            base_url,
            base_url_len,
            preserve_whitespace,
            out,
            out_len,
        )
    }

    /// Alias retained for callers that name the operation by its byte input.
    #[no_mangle]
    pub unsafe extern "C" fn htmltrust_extract_canonical_text_bytes(
        html: *const u8,
        html_len: usize,
        base_url: *const u8,
        base_url_len: usize,
        out: *mut *mut u8,
        out_len: *mut usize,
    ) -> i32 {
        htmltrust_extract_canonical_text_v1(html, html_len, base_url, base_url_len, out, out_len)
    }

    /// Alias for [`htmltrust_extract_canonical_text_options_v1`].
    #[no_mangle]
    pub unsafe extern "C" fn htmltrust_extract_canonical_text_bytes_with_options(
        html: *const u8,
        html_len: usize,
        base_url: *const u8,
        base_url_len: usize,
        preserve_whitespace: bool,
        out: *mut *mut u8,
        out_len: *mut usize,
    ) -> i32 {
        htmltrust_extract_canonical_text_options_v1(
            html,
            html_len,
            base_url,
            base_url_len,
            preserve_whitespace,
            out,
            out_len,
        )
    }

    /// Normalize a UTF-8 byte string with the profile-v1 size limits.
    /// Status 0 returns normalized text, status 1 returns
    /// `parser-profile-unsupported` or
    /// `resource-limit-exceeded`, and status 2 indicates invalid pointers.
    /// Valid output pointers are initialized before input decoding.
    #[no_mangle]
    pub unsafe extern "C" fn htmltrust_normalize_text_v1(
        text: *const u8,
        text_len: usize,
        preserve_whitespace: bool,
        out: *mut *mut u8,
        out_len: *mut usize,
    ) -> i32 {
        if !initialize_byte_outputs(out, out_len) {
            return 2;
        }
        if text.is_null() && text_len != 0 {
            return 2;
        }
        catch_result(out, out_len, || {
            let text = std::slice::from_raw_parts(
                if text.is_null() { b"".as_ptr() } else { text },
                text_len,
            );
            htmltrust_canonicalization::try_normalize_text_v1(text, preserve_whitespace)
        })
    }

    #[no_mangle]
    pub unsafe extern "C" fn htmltrust_normalize_text_bytes(
        text: *const u8,
        text_len: usize,
        preserve_whitespace: bool,
        out: *mut *mut u8,
        out_len: *mut usize,
    ) -> i32 {
        htmltrust_normalize_text_v1(text, text_len, preserve_whitespace, out, out_len)
    }

    /// Free a byte buffer returned by a length-based API. Results are allocated
    /// as boxed slices, so the pointer and length fully describe their layout.
    #[no_mangle]
    pub unsafe extern "C" fn htmltrust_bytes_free(ptr: *mut u8, len: usize) {
        if !ptr.is_null() {
            drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)));
        }
    }

    /// Canonicalize a raw JSON document using the same length-based ownership
    /// contract as [`htmltrust_extract_canonical_text_v1`].
    /// Status 0 is success, status 1 returns a canonicalization error code,
    /// and status 2 means an invalid output/input pointer. Valid output
    /// pointers are cleared before the JSON bytes are decoded.
    #[no_mangle]
    pub unsafe extern "C" fn htmltrust_canonicalize_json_document_v1(
        json: *const u8,
        json_len: usize,
        out: *mut *mut u8,
        out_len: *mut usize,
    ) -> i32 {
        if !initialize_byte_outputs(out, out_len) {
            return 2;
        }
        if json.is_null() && json_len != 0 {
            return 2;
        }
        catch_result(out, out_len, || {
            let json = std::slice::from_raw_parts(
                if json.is_null() { b"".as_ptr() } else { json },
                json_len,
            );
            htmltrust_canonicalization::canonicalize_json_document(json)
        })
    }

    #[no_mangle]
    pub unsafe extern "C" fn htmltrust_canonicalize_json_document_bytes(
        json: *const u8,
        json_len: usize,
        out: *mut *mut u8,
        out_len: *mut usize,
    ) -> i32 {
        htmltrust_canonicalize_json_document_v1(json, json_len, out, out_len)
    }

    /// Canonicalize a UTF-8 JSON object whose values are claim strings. Status
    /// and output ownership match the other length-based v1 APIs. Duplicate
    /// members, non-string values, malformed JSON, and non-object roots return
    /// the allocated `claim-malformed` error code with status 1.
    #[no_mangle]
    pub unsafe extern "C" fn htmltrust_canonicalize_claims_v1(
        claims: *const u8,
        claims_len: usize,
        out: *mut *mut u8,
        out_len: *mut usize,
    ) -> i32 {
        if !initialize_byte_outputs(out, out_len) {
            return 2;
        }
        if claims.is_null() && claims_len != 0 {
            return 2;
        }
        catch_result(out, out_len, || {
            let claims = std::slice::from_raw_parts(
                if claims.is_null() {
                    b"".as_ptr()
                } else {
                    claims
                },
                claims_len,
            );
            htmltrust_canonicalization::canonicalize_claims_document(claims)
        })
    }

    /// Free a string previously returned via `htmltrust_extract_canonical_text`.
    ///
    /// # Safety
    /// `s` must be a pointer returned by this library, or NULL.
    #[no_mangle]
    pub unsafe extern "C" fn htmltrust_string_free(s: *mut c_char) {
        if !s.is_null() {
            drop(CString::from_raw(s));
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn invalid_utf8_c_string_clears_stale_output() {
            let input = [0xff_u8, 0];
            let mut out = std::ptr::NonNull::<c_char>::dangling().as_ptr();
            let status = unsafe {
                htmltrust_extract_canonical_text(
                    input.as_ptr() as *const c_char,
                    std::ptr::null(),
                    &mut out,
                )
            };
            assert_eq!(status, 2);
            assert!(out.is_null());
        }

        #[test]
        fn invalid_pointer_clears_length_api_outputs() {
            let mut out = std::ptr::NonNull::<u8>::dangling().as_ptr();
            let mut out_len = 77;
            let status = unsafe {
                htmltrust_extract_canonical_text_v1(
                    std::ptr::null(),
                    1,
                    std::ptr::null(),
                    0,
                    &mut out,
                    &mut out_len,
                )
            };
            assert_eq!(status, 2);
            assert!(out.is_null());
            assert_eq!(out_len, 0);

            let mut out = std::ptr::NonNull::<u8>::dangling().as_ptr();
            let status = unsafe {
                htmltrust_normalize_text_v1(b"x".as_ptr(), 1, false, &mut out, std::ptr::null_mut())
            };
            assert_eq!(status, 2);
            assert!(out.is_null());
        }

        #[test]
        fn option_and_normalize_apis_return_owned_buffers() {
            let html = b"<pre>a   b</pre>";
            let mut out = std::ptr::null_mut();
            let mut out_len = 0;
            let status = unsafe {
                htmltrust_extract_canonical_text_options_v1(
                    html.as_ptr(),
                    html.len(),
                    std::ptr::null(),
                    0,
                    true,
                    &mut out,
                    &mut out_len,
                )
            };
            assert_eq!(status, 0);
            let bytes = unsafe { std::slice::from_raw_parts(out, out_len) };
            assert_eq!(bytes, b"a b");
            unsafe { htmltrust_bytes_free(out, out_len) };

            let empty_base = [0_u8];
            out = std::ptr::null_mut();
            out_len = 0;
            let status = unsafe {
                htmltrust_extract_canonical_text_options_v1(
                    html.as_ptr(),
                    html.len(),
                    empty_base.as_ptr(),
                    0,
                    false,
                    &mut out,
                    &mut out_len,
                )
            };
            assert_eq!(status, 0);
            let bytes = unsafe { std::slice::from_raw_parts(out, out_len) };
            assert_eq!(bytes, b"a b");
            unsafe { htmltrust_bytes_free(out, out_len) };

            let input = b"a\t\tb";
            out = std::ptr::null_mut();
            out_len = 0;
            let status = unsafe {
                htmltrust_normalize_text_v1(
                    input.as_ptr(),
                    input.len(),
                    false,
                    &mut out,
                    &mut out_len,
                )
            };
            assert_eq!(status, 0);
            let bytes = unsafe { std::slice::from_raw_parts(out, out_len) };
            assert_eq!(bytes, b"a b");
            unsafe { htmltrust_bytes_free(out, out_len) };
        }

        #[test]
        fn versioned_api_reports_abi_and_claims_result() {
            assert_eq!(htmltrust_abi_version_v1(), 1);

            let input = "{\"b\":\"two\",\"a\":\"“one”\"}".as_bytes();
            let mut out = std::ptr::null_mut();
            let mut out_len = 0;
            let status = unsafe {
                htmltrust_canonicalize_claims_v1(
                    input.as_ptr(),
                    input.len(),
                    &mut out,
                    &mut out_len,
                )
            };
            assert_eq!(status, 0);
            let bytes = unsafe { std::slice::from_raw_parts(out, out_len) };
            assert_eq!(bytes, b"a:\"one\"\nb:two\n");
            unsafe { htmltrust_bytes_free(out, out_len) };
        }

        #[test]
        fn claims_and_json_apis_return_allocated_errors() {
            let mut out = std::ptr::NonNull::<u8>::dangling().as_ptr();
            let mut out_len = 77;
            let claims = br#"{"claim":42}"#;
            let status = unsafe {
                htmltrust_canonicalize_claims_v1(
                    claims.as_ptr(),
                    claims.len(),
                    &mut out,
                    &mut out_len,
                )
            };
            assert_eq!(status, 1);
            let bytes = unsafe { std::slice::from_raw_parts(out, out_len) };
            assert_eq!(bytes, b"claim-malformed");
            unsafe { htmltrust_bytes_free(out, out_len) };

            out = std::ptr::null_mut();
            out_len = 0;
            let json = br#"{"value":-0}"#;
            let status = unsafe {
                htmltrust_canonicalize_json_document_v1(
                    json.as_ptr(),
                    json.len(),
                    &mut out,
                    &mut out_len,
                )
            };
            assert_eq!(status, 1);
            let bytes = unsafe { std::slice::from_raw_parts(out, out_len) };
            assert_eq!(bytes, b"jcs-number");
            unsafe { htmltrust_bytes_free(out, out_len) };

            out = std::ptr::null_mut();
            out_len = 0;
            let json = b"{";
            let status = unsafe {
                htmltrust_canonicalize_json_document_v1(
                    json.as_ptr(),
                    json.len(),
                    &mut out,
                    &mut out_len,
                )
            };
            assert_eq!(status, 1);
            let bytes = unsafe { std::slice::from_raw_parts(out, out_len) };
            assert_eq!(bytes, b"jcs-invalid-json");
            unsafe { htmltrust_bytes_free(out, out_len) };
        }

        #[test]
        fn panic_in_versioned_operation_becomes_core_error() {
            let mut out = std::ptr::null_mut();
            let mut out_len = 0;
            let status = unsafe {
                catch_result(&mut out, &mut out_len, || -> Result<String, String> {
                    panic!("test panic")
                })
            };
            assert_eq!(status, 1);
            let bytes = unsafe { std::slice::from_raw_parts(out, out_len) };
            assert_eq!(bytes, CORE_INTERNAL_ERROR);
            unsafe { htmltrust_bytes_free(out, out_len) };
        }

        #[test]
        fn claims_api_clears_outputs_on_invalid_pointer() {
            let mut out = std::ptr::NonNull::<u8>::dangling().as_ptr();
            let mut out_len = 77;
            let status = unsafe {
                htmltrust_canonicalize_claims_v1(std::ptr::null(), 1, &mut out, &mut out_len)
            };
            assert_eq!(status, 2);
            assert!(out.is_null());
            assert_eq!(out_len, 0);
        }
    }
}

// ---------------------------------------------------------------------------
// WebAssembly binding (JavaScript / browser)
// ---------------------------------------------------------------------------
#[cfg(target_arch = "wasm32")]
mod wasm {
    use wasm_bindgen::prelude::*;

    fn error(code: String) -> JsError {
        JsError::new(&code)
    }

    /// ABI version for the versioned WebAssembly interface.
    #[wasm_bindgen(js_name = abiVersion)]
    pub fn abi_version() -> u32 {
        1
    }

    /// Normalize text using the v1 profile. Legacy whitespace preservation is
    /// deliberately not exposed by this profile entry point.
    #[wasm_bindgen(js_name = normalizeText)]
    pub fn normalize_text(text: &str) -> Result<String, JsError> {
        htmltrust_canonicalization::try_normalize_text(text, false).map_err(error)
    }

    /// Canonicalize a JSON object containing string claim values.
    #[wasm_bindgen(js_name = canonicalizeClaims)]
    pub fn canonicalize_claims(document: &str) -> Result<String, JsError> {
        htmltrust_canonicalization::canonicalize_claims_document(document.as_bytes()).map_err(error)
    }

    /// Canonicalize one raw JSON document according to RFC 8785 (JCS).
    #[wasm_bindgen(js_name = canonicalizeJsonDocument)]
    pub fn canonicalize_json_document(document: &str) -> Result<String, JsError> {
        htmltrust_canonicalization::canonicalize_json_document(document.as_bytes()).map_err(error)
    }

    /// Extract canonical text. `base` may be omitted (undefined/null). Throws a
    /// JS error carrying the canonicalization failure code on failure.
    #[wasm_bindgen(js_name = extractCanonicalText)]
    pub fn extract_canonical_text(html: &str, base: Option<String>) -> Result<String, JsError> {
        htmltrust_canonicalization::try_extract_canonical_text_with_base_url(html, base.as_deref())
            .map_err(error)
    }

    /// Option-aware extraction. `base` may be omitted (undefined/null).
    #[wasm_bindgen(js_name = extractCanonicalTextWithOptions)]
    pub fn extract_canonical_text_with_options(
        html: &str,
        preserve_whitespace: bool,
        base: Option<String>,
    ) -> Result<String, JsError> {
        htmltrust_canonicalization::try_extract_canonical_text_with_options(
            html,
            htmltrust_canonicalization::ExtractOptions {
                preserve_whitespace,
                base_url: base.as_deref(),
            },
        )
        .map_err(error)
    }
}
