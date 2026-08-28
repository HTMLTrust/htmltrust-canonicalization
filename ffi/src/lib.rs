//! FFI / WebAssembly bindings for the HTMLTrust canonicalization core.
//!
//! This crate makes the Rust implementation available to native and WebAssembly
//! consumers. The in-tree JavaScript, Go, PHP, and Python bindings remain
//! independent implementations and are checked against shared fixtures.
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
    /// A NULL base pointer with length zero means no base URL. Status 2 means
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
        let html =
            std::slice::from_raw_parts(if html.is_null() { b"".as_ptr() } else { html }, html_len);
        let base = if base_url.is_null() && base_url_len == 0 {
            None
        } else {
            Some(std::slice::from_raw_parts(base_url, base_url_len))
        };
        let result = match std::str::from_utf8(html) {
            Ok(html) => {
                let base = match base {
                    Some(bytes) => match std::str::from_utf8(bytes) {
                        Ok(base) => Some(base),
                        Err(_) => {
                            let bytes = b"parser-profile-unsupported".to_vec().into_boxed_slice();
                            *out_len = bytes.len();
                            *out = Box::into_raw(bytes) as *mut u8;
                            return 1;
                        }
                    },
                    None => None,
                };
                htmltrust_canonicalization::try_extract_canonical_text_with_options(
                    html,
                    htmltrust_canonicalization::ExtractOptions {
                        preserve_whitespace,
                        base_url: base,
                    },
                )
            }
            Err(_) => Err("parser-profile-unsupported".to_string()),
        };
        let (status, bytes) = match result {
            Ok(text) => (0, text.into_bytes()),
            Err(error) => (1, error.into_bytes()),
        };
        let bytes = bytes.into_boxed_slice();
        *out_len = bytes.len();
        *out = Box::into_raw(bytes) as *mut u8;
        status
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
        let text =
            std::slice::from_raw_parts(if text.is_null() { b"".as_ptr() } else { text }, text_len);
        let result = htmltrust_canonicalization::try_normalize_text_v1(text, preserve_whitespace);
        let (status, bytes) = match result {
            Ok(value) => (0, value.into_bytes()),
            Err(error) => (1, error.into_bytes()),
        };
        let bytes = bytes.into_boxed_slice();
        *out_len = bytes.len();
        *out = Box::into_raw(bytes) as *mut u8;
        status
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
        let json =
            std::slice::from_raw_parts(if json.is_null() { b"".as_ptr() } else { json }, json_len);
        let result = htmltrust_canonicalization::canonicalize_json_document(json);
        let (status, bytes) = match result {
            Ok(text) => (0, text.into_bytes()),
            Err(error) => (1, error.into_bytes()),
        };
        let bytes = bytes.into_boxed_slice();
        *out_len = bytes.len();
        *out = Box::into_raw(bytes) as *mut u8;
        status
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
            let mut out = 1_usize as *mut c_char;
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
            let mut out = 1_usize as *mut u8;
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

            let mut out = 1_usize as *mut u8;
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
    }
}

// ---------------------------------------------------------------------------
// WebAssembly binding (JavaScript / browser)
// ---------------------------------------------------------------------------
#[cfg(target_arch = "wasm32")]
mod wasm {
    use wasm_bindgen::prelude::*;

    /// Extract canonical text. `base` may be omitted (undefined/null). Throws a
    /// JS error carrying the canonicalization failure code on failure.
    #[wasm_bindgen(js_name = extractCanonicalText)]
    pub fn extract_canonical_text(html: &str, base: Option<String>) -> Result<String, JsError> {
        htmltrust_canonicalization::try_extract_canonical_text_with_base_url(html, base.as_deref())
            .map_err(|e| JsError::new(&e))
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
        .map_err(|e| JsError::new(&e))
    }
}
