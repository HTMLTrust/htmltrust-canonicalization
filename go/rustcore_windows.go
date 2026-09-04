//go:build windows && (amd64 || arm64)

package canonicalize

import (
	"fmt"
	"runtime"
	"syscall"
	"unsafe"
)

// rustCoreWindows calls the Rust C ABI directly through the native Windows
// loader. Windows AMD64 and ARM64 each have one system calling convention, so
// these calls do not require cgo or a separate C compiler.
type rustCoreWindows struct {
	handle        syscall.Handle
	normalize     uintptr
	extract       uintptr
	claims        uintptr
	extractClaims uintptr
	jcs           uintptr
	free          uintptr
}

func newRustCoreBackend(libraryPath string) (rustCoreBackend, error) {
	handle, err := syscall.LoadLibrary(libraryPath)
	if err != nil {
		return nil, fmt.Errorf("open htmltrust Rust core: %w", err)
	}
	backend := &rustCoreWindows{handle: handle}
	symbols := make(map[string]uintptr, len(rustCoreRequiredSymbols))
	for _, name := range rustCoreRequiredSymbols {
		address, err := syscall.GetProcAddress(handle, name)
		if err != nil {
			backend.close()
			return nil, fmt.Errorf("htmltrust Rust core symbol is missing: %s", name)
		}
		symbols[name] = address
	}

	version, _, _ := syscall.SyscallN(symbols["htmltrust_abi_version_v1"])
	if uint32(version) != RustCoreABIVersion {
		backend.close()
		return nil, fmt.Errorf("unsupported htmltrust Rust core ABI version %d; expected %d", uint32(version), RustCoreABIVersion)
	}

	backend.normalize = symbols["htmltrust_normalize_text_v1"]
	backend.extract = symbols["htmltrust_extract_canonical_text_options_v1"]
	backend.claims = symbols["htmltrust_canonicalize_claims_v1"]
	backend.extractClaims = symbols["htmltrust_extract_claims_from_signed_section_v1"]
	backend.jcs = symbols["htmltrust_canonicalize_json_document_v1"]
	backend.free = symbols["htmltrust_bytes_free"]
	runtime.KeepAlive(backend)
	return backend, nil
}

func (r *rustCoreWindows) close() {
	if r.handle != 0 {
		_ = syscall.FreeLibrary(r.handle)
		r.handle = 0
	}
}

func (r *rustCoreWindows) call(operation rustCoreOperation, input, base []byte, preserveWhitespace bool) ([]byte, error) {
	var out unsafe.Pointer
	var outLen uintptr
	var status uintptr
	preserve := uintptr(0)
	if preserveWhitespace {
		preserve = 1
	}

	switch operation {
	case rustCoreNormalize:
		status, _, _ = syscall.SyscallN(
			r.normalize,
			windowsBytesPointer(input), uintptr(len(input)), preserve,
			uintptr(unsafe.Pointer(&out)), uintptr(unsafe.Pointer(&outLen)),
		)
	case rustCoreExtract:
		status, _, _ = syscall.SyscallN(
			r.extract,
			windowsBytesPointer(input), uintptr(len(input)),
			windowsBytesPointer(base), uintptr(len(base)), preserve,
			uintptr(unsafe.Pointer(&out)), uintptr(unsafe.Pointer(&outLen)),
		)
	case rustCoreClaims:
		status, _, _ = syscall.SyscallN(
			r.claims,
			windowsBytesPointer(input), uintptr(len(input)),
			uintptr(unsafe.Pointer(&out)), uintptr(unsafe.Pointer(&outLen)),
		)
	case rustCoreExtractClaims:
		status, _, _ = syscall.SyscallN(
			r.extractClaims,
			windowsBytesPointer(input), uintptr(len(input)),
			uintptr(unsafe.Pointer(&out)), uintptr(unsafe.Pointer(&outLen)),
		)
	case rustCoreJCS:
		status, _, _ = syscall.SyscallN(
			r.jcs,
			windowsBytesPointer(input), uintptr(len(input)),
			uintptr(unsafe.Pointer(&out)), uintptr(unsafe.Pointer(&outLen)),
		)
	default:
		return nil, &RustCoreError{Code: "invalid-argument", Status: 2}
	}

	runtime.KeepAlive(input)
	runtime.KeepAlive(base)
	runtime.KeepAlive(r)
	return r.finish(int32(status), out, outLen)
}

func windowsBytesPointer(value []byte) uintptr {
	if len(value) == 0 {
		return 0
	}
	return uintptr(unsafe.Pointer(&value[0]))
}

func (r *rustCoreWindows) finish(status int32, out unsafe.Pointer, outLen uintptr) ([]byte, error) {
	defer func() {
		if out != nil {
			syscall.SyscallN(r.free, uintptr(out), outLen)
		}
		runtime.KeepAlive(r)
	}()
	if status != 0 && status != 1 {
		return nil, &RustCoreError{Code: "invalid-argument", Status: status}
	}
	if outLen > rustCoreMaxOutputBytes {
		return nil, &RustCoreError{Code: "invalid-output", Status: status}
	}
	if outLen != 0 && out == nil {
		return nil, &RustCoreError{Code: "invalid-output", Status: status}
	}

	result := make([]byte, int(outLen))
	if outLen != 0 {
		copy(result, unsafe.Slice((*byte)(out), int(outLen)))
	}
	if status == 1 {
		return nil, &RustCoreError{Code: string(result), Status: status}
	}
	return result, nil
}
