//go:build !cgo || (!linux && !darwin && !freebsd && !openbsd && !netbsd)

package canonicalize

import "errors"

const RustCoreABIVersion uint32 = 1

type RustCoreError struct {
	Code   string
	Status int32
}

func (e *RustCoreError) Error() string { return e.Code }

type RustCore struct{}

func NewRustCore(string) (*RustCore, error) {
	return nil, errors.New("htmltrust Rust core adapter requires cgo on a dlopen platform")
}
func (*RustCore) Close() error { return nil }
func (*RustCore) NormalizeText(string, bool) (string, error) {
	return "", errors.New("htmltrust Rust core adapter unavailable")
}
func (*RustCore) ExtractCanonicalText(string, bool, *string) (string, error) {
	return "", errors.New("htmltrust Rust core adapter unavailable")
}
func (*RustCore) CanonicalizeClaims(map[string]string) (string, error) {
	return "", errors.New("htmltrust Rust core adapter unavailable")
}
func (*RustCore) ExtractClaimsFromSignedSection(string) (map[string]string, error) {
	return nil, errors.New("htmltrust Rust core adapter unavailable")
}
func (*RustCore) CanonicalizeJSONDocument([]byte) ([]byte, error) {
	return nil, errors.New("htmltrust Rust core adapter unavailable")
}
