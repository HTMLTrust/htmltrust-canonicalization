//go:build cgo && (linux || darwin || freebsd || openbsd || netbsd)

package canonicalize

// #cgo linux LDFLAGS: -ldl
// #include <dlfcn.h>
// #include <stdint.h>
// #include <stdlib.h>
// #include <string.h>
// #include <stdbool.h>
//
// typedef uint32_t (*ht_version_fn)(void);
// typedef int32_t (*ht_normalize_fn)(const uint8_t *, size_t, bool, uint8_t **, size_t *);
// typedef int32_t (*ht_extract_fn)(const uint8_t *, size_t, const uint8_t *, size_t, bool, uint8_t **, size_t *);
// typedef int32_t (*ht_bytes_fn)(const uint8_t *, size_t, uint8_t **, size_t *);
// typedef void (*ht_free_fn)(uint8_t *, size_t);
// static uint8_t ht_empty_byte;
// static uint8_t *ht_empty(void) { return &ht_empty_byte; }
//
// static void *ht_open(const char *path) { return dlopen(path, RTLD_NOW | RTLD_LOCAL); }
// static void ht_close(void *handle) { if (handle) dlclose(handle); }
// static void *ht_symbol(void *handle, const char *name) {
//     (void)dlerror();
//     return dlsym(handle, name);
// }
// static const char *ht_error(void) { const char *e = dlerror(); return e ? e : "unable to load htmltrust library"; }
// static uint32_t ht_version(void *h) { return ((ht_version_fn)ht_symbol(h, "htmltrust_abi_version_v1"))(); }
// static int32_t ht_normalize(void *h, const uint8_t *in, size_t len, bool preserve, uint8_t **out, size_t *out_len) {
//     return ((ht_normalize_fn)ht_symbol(h, "htmltrust_normalize_text_v1"))(in, len, preserve, out, out_len);
// }
// static int32_t ht_extract(void *h, const uint8_t *html, size_t html_len, const uint8_t *base, size_t base_len, bool preserve, uint8_t **out, size_t *out_len) {
//     return ((ht_extract_fn)ht_symbol(h, "htmltrust_extract_canonical_text_options_v1"))(html, html_len, base, base_len, preserve, out, out_len);
// }
// static int32_t ht_claims(void *h, const uint8_t *in, size_t len, uint8_t **out, size_t *out_len) {
//     return ((ht_bytes_fn)ht_symbol(h, "htmltrust_canonicalize_claims_v1"))(in, len, out, out_len);
// }
// static int32_t ht_extract_claims(void *h, const uint8_t *in, size_t len, uint8_t **out, size_t *out_len) {
//     return ((ht_bytes_fn)ht_symbol(h, "htmltrust_extract_claims_from_signed_section_v1"))(in, len, out, out_len);
// }
// static int32_t ht_jcs(void *h, const uint8_t *in, size_t len, uint8_t **out, size_t *out_len) {
//     return ((ht_bytes_fn)ht_symbol(h, "htmltrust_canonicalize_json_document_v1"))(in, len, out, out_len);
// }
// static void ht_free(void *h, uint8_t *out, size_t len) {
//     ((ht_free_fn)ht_symbol(h, "htmltrust_bytes_free"))(out, len);
// }
import "C"

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"unicode/utf8"
	"unsafe"
)

const RustCoreABIVersion uint32 = 1
const rustCoreMaxOutputBytes = 1024 * 1024

// RustCoreError is an error returned by the Rust ABI. Status 1 contains a
// stable core error code; status 2 denotes an invalid ABI argument.
type RustCoreError struct {
	Code   string
	Status int32
}

func (e *RustCoreError) Error() string { return e.Code }

// RustCore is an explicit-path handle to the Rust canonicalization library.
// It never searches LD_LIBRARY_PATH, the executable directory, or the module
// cache on behalf of the caller.
type RustCore struct {
	mu     sync.Mutex
	handle unsafe.Pointer
	closed bool
}

// NewRustCore opens libraryPath and verifies the versioned ABI and all symbols
// required by canonicalization, claim extraction, and JSON operations.
func NewRustCore(libraryPath string) (*RustCore, error) {
	if libraryPath == "" {
		return nil, errors.New("htmltrust Rust core library path must not be empty")
	}
	if !filepath.IsAbs(libraryPath) {
		return nil, errors.New("htmltrust Rust core library path must be absolute")
	}
	cpath := C.CString(libraryPath)
	defer C.free(unsafe.Pointer(cpath))
	handle := C.ht_open(cpath)
	if handle == nil {
		return nil, fmt.Errorf("open htmltrust Rust core: %s", C.GoString(C.ht_error()))
	}
	core := &RustCore{handle: handle}
	for _, symbol := range []string{
		"htmltrust_abi_version_v1",
		"htmltrust_normalize_text_v1",
		"htmltrust_extract_canonical_text_options_v1",
		"htmltrust_canonicalize_claims_v1",
		"htmltrust_extract_claims_from_signed_section_v1",
		"htmltrust_canonicalize_json_document_v1",
		"htmltrust_bytes_free",
	} {
		csymbol := C.CString(symbol)
		missing := C.ht_symbol(handle, csymbol) == nil
		C.free(unsafe.Pointer(csymbol))
		if missing {
			core.Close()
			return nil, fmt.Errorf("htmltrust Rust core symbol is missing: %s", symbol)
		}
	}
	if version := uint32(C.ht_version(handle)); version != RustCoreABIVersion {
		core.Close()
		return nil, fmt.Errorf("unsupported htmltrust Rust core ABI version %d; expected %d", version, RustCoreABIVersion)
	}
	return core, nil
}

// Close releases the explicitly opened library handle. It is safe to call
// more than once.
func (r *RustCore) Close() error {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.closed {
		C.ht_close(r.handle)
		r.handle = nil
		r.closed = true
	}
	return nil
}

func (r *RustCore) begin() (unsafe.Pointer, error) {
	if r == nil {
		return nil, errors.New("nil htmltrust Rust core")
	}
	if r.closed || r.handle == nil {
		return nil, errors.New("htmltrust Rust core is closed")
	}
	return r.handle, nil
}

func bytesPointer(value []byte, present bool) *C.uint8_t {
	if len(value) == 0 {
		if present {
			return C.ht_empty()
		}
		return nil
	}
	return (*C.uint8_t)(unsafe.Pointer(&value[0]))
}

func (r *RustCore) finish(handle unsafe.Pointer, status C.int32_t, out *C.uint8_t, outLen C.size_t) ([]byte, error) {
	defer func() {
		if out != nil {
			C.ht_free(handle, out, outLen)
		}
	}()
	if status != 0 && status != 1 {
		return nil, &RustCoreError{Code: "invalid-argument", Status: int32(status)}
	}
	if uint64(outLen) > rustCoreMaxOutputBytes {
		return nil, &RustCoreError{Code: "invalid-output", Status: int32(status)}
	}
	if outLen != 0 && out == nil {
		return nil, &RustCoreError{Code: "invalid-output", Status: int32(status)}
	}
	result := C.GoBytes(unsafe.Pointer(out), C.int(outLen))
	if status == 1 {
		return nil, &RustCoreError{Code: string(result), Status: int32(status)}
	}
	return result, nil
}

func (r *RustCore) NormalizeText(text string, preserveWhitespace bool) (string, error) {
	raw := []byte(text)
	r.mu.Lock()
	defer r.mu.Unlock()
	handle, err := r.begin()
	if err != nil {
		return "", err
	}
	var out *C.uint8_t
	var outLen C.size_t
	status := C.ht_normalize(handle, bytesPointer(raw, true), C.size_t(len(raw)), C.bool(preserveWhitespace), &out, &outLen)
	result, err := r.finish(handle, status, out, outLen)
	return string(result), err
}

func (r *RustCore) ExtractCanonicalText(html string, preserveWhitespace bool, baseURL *string) (string, error) {
	rawHTML := []byte(html)
	var rawBase []byte
	basePresent := baseURL != nil && *baseURL != ""
	if basePresent {
		rawBase = []byte(*baseURL)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	handle, err := r.begin()
	if err != nil {
		return "", err
	}
	var out *C.uint8_t
	var outLen C.size_t
	status := C.ht_extract(handle, bytesPointer(rawHTML, true), C.size_t(len(rawHTML)), bytesPointer(rawBase, basePresent), C.size_t(len(rawBase)), C.bool(preserveWhitespace), &out, &outLen)
	result, err := r.finish(handle, status, out, outLen)
	return string(result), err
}

func (r *RustCore) CanonicalizeClaims(claims map[string]string) (string, error) {
	if claims == nil {
		claims = map[string]string{}
	}
	validated := make(map[string]string, len(claims))
	for name, value := range claims {
		if !utf8.ValidString(name) || !utf8.ValidString(value) {
			return "", &RustCoreError{Code: "claim-malformed", Status: 1}
		}
		validated[name] = value
	}
	raw, err := json.Marshal(validated)
	if err != nil {
		return "", &RustCoreError{Code: "claim-malformed", Status: 1}
	}
	result, err := r.callBytes(raw, false)
	return string(result), err
}

// ExtractClaimsFromSignedSection delegates signed-section parsing and claim
// normalization to the Rust core. The ABI returns a JSON object whose values
// are strings, keeping HTML parsing out of this language binding.
func (r *RustCore) ExtractClaimsFromSignedSection(source string) (map[string]string, error) {
	raw, err := r.callExtractClaims([]byte(source))
	if err != nil {
		return nil, err
	}
	var claims map[string]string
	if err := json.Unmarshal(raw, &claims); err != nil {
		return nil, &RustCoreError{Code: "invalid-output", Status: 1}
	}
	if claims == nil {
		claims = map[string]string{}
	}
	return claims, nil
}

func (r *RustCore) CanonicalizeJSONDocument(document []byte) ([]byte, error) {
	return r.callBytes(document, true)
}

func (r *RustCore) callBytes(input []byte, jcs bool) ([]byte, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	handle, err := r.begin()
	if err != nil {
		return nil, err
	}
	var out *C.uint8_t
	var outLen C.size_t
	var status C.int32_t
	if jcs {
		status = C.ht_jcs(handle, bytesPointer(input, true), C.size_t(len(input)), &out, &outLen)
	} else {
		status = C.ht_claims(handle, bytesPointer(input, true), C.size_t(len(input)), &out, &outLen)
	}
	return r.finish(handle, status, out, outLen)
}

func (r *RustCore) callExtractClaims(input []byte) ([]byte, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	handle, err := r.begin()
	if err != nil {
		return nil, err
	}
	var out *C.uint8_t
	var outLen C.size_t
	status := C.ht_extract_claims(handle, bytesPointer(input, true), C.size_t(len(input)), &out, &outLen)
	return r.finish(handle, status, out, outLen)
}
