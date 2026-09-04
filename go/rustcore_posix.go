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
// static int32_t ht_extract(void *h, const uint8_t *in, size_t len, const uint8_t *base, size_t base_len, bool preserve, uint8_t **out, size_t *out_len) {
//     return ((ht_extract_fn)ht_symbol(h, "htmltrust_extract_canonical_text_options_v1"))(in, len, base, base_len, preserve, out, out_len);
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
	"fmt"
	"unsafe"
)

type rustCorePOSIX struct {
	handle unsafe.Pointer
}

func newRustCoreBackend(libraryPath string) (rustCoreBackend, error) {
	cpath := C.CString(libraryPath)
	defer C.free(unsafe.Pointer(cpath))
	handle := C.ht_open(cpath)
	if handle == nil {
		return nil, fmt.Errorf("open htmltrust Rust core: %s", C.GoString(C.ht_error()))
	}
	backend := &rustCorePOSIX{handle: handle}
	for _, symbol := range rustCoreRequiredSymbols {
		csymbol := C.CString(symbol)
		missing := C.ht_symbol(handle, csymbol) == nil
		C.free(unsafe.Pointer(csymbol))
		if missing {
			backend.close()
			return nil, fmt.Errorf("htmltrust Rust core symbol is missing: %s", symbol)
		}
	}
	if version := uint32(C.ht_version(handle)); version != RustCoreABIVersion {
		backend.close()
		return nil, fmt.Errorf("unsupported htmltrust Rust core ABI version %d; expected %d", version, RustCoreABIVersion)
	}
	return backend, nil
}

func (r *rustCorePOSIX) close() {
	if r.handle != nil {
		C.ht_close(r.handle)
		r.handle = nil
	}
}

func (r *rustCorePOSIX) call(operation rustCoreOperation, input, base []byte, preserveWhitespace bool) ([]byte, error) {
	var out *C.uint8_t
	var outLen C.size_t
	var status C.int32_t
	switch operation {
	case rustCoreNormalize:
		status = C.ht_normalize(r.handle, posixBytesPointer(input), C.size_t(len(input)), C.bool(preserveWhitespace), &out, &outLen)
	case rustCoreExtract:
		status = C.ht_extract(r.handle, posixBytesPointer(input), C.size_t(len(input)), posixBytesPointer(base), C.size_t(len(base)), C.bool(preserveWhitespace), &out, &outLen)
	case rustCoreClaims:
		status = C.ht_claims(r.handle, posixBytesPointer(input), C.size_t(len(input)), &out, &outLen)
	case rustCoreExtractClaims:
		status = C.ht_extract_claims(r.handle, posixBytesPointer(input), C.size_t(len(input)), &out, &outLen)
	case rustCoreJCS:
		status = C.ht_jcs(r.handle, posixBytesPointer(input), C.size_t(len(input)), &out, &outLen)
	default:
		return nil, &RustCoreError{Code: "invalid-argument", Status: 2}
	}
	return r.finish(status, out, outLen)
}

func posixBytesPointer(value []byte) *C.uint8_t {
	if len(value) == 0 {
		return C.ht_empty()
	}
	return (*C.uint8_t)(unsafe.Pointer(&value[0]))
}

func (r *rustCorePOSIX) finish(status C.int32_t, out *C.uint8_t, outLen C.size_t) ([]byte, error) {
	defer func() {
		if out != nil {
			C.ht_free(r.handle, out, outLen)
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
