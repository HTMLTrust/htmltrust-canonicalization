//! FFI / WebAssembly bindings for the HTMLTrust canonicalization core.
//!
//! The goal is one canonicalization implementation, many language bindings.
//! Rather than maintaining five hand-written ports that must converge on
//! byte-identical output (which Study 1 showed does not hold on real HTML),
//! each language calls this one Rust core — which uses `rust-url` (the Servo
//! WHATWG URL implementation) and `html5ever` (the Servo HTML5 parser) — so the
//! output is byte-identical by construction.
//!
//! Native builds expose a small C ABI (for Python `ctypes`, Go `cgo`, PHP
//! `FFI`); `wasm32` builds expose a `wasm-bindgen` function (for JavaScript in
//! Node and the browser).

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

    /// Extract canonical text from `html`, resolving relative signed-attribute
    /// URLs against `base_url` (may be NULL). On success returns 0 and sets
    /// `*out` to a newly-allocated UTF-8 C string (free with
    /// `htmltrust_string_free`). On canonicalization failure returns 1 and sets
    /// `*out` to the error code string. Returns 2 on a NULL argument.
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
        if html.is_null() || out.is_null() {
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
        match htmltrust_canonicalization::try_extract_canonical_text_with_base_url(html, base) {
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
}
