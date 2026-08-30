package canonicalize

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"sync"
	"unicode/utf8"
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

type rustCoreOperation uint8

const (
	rustCoreNormalize rustCoreOperation = iota
	rustCoreExtract
	rustCoreClaims
	rustCoreExtractClaims
	rustCoreJCS
)

// rustCoreBackend owns the platform-specific dynamic-library handle. Keeping
// the operation semantics here means the POSIX and Windows loaders share the
// exact same Go API and input validation.
type rustCoreBackend interface {
	close()
	call(rustCoreOperation, []byte, []byte, bool) ([]byte, error)
}

var rustCoreRequiredSymbols = [...]string{
	"htmltrust_abi_version_v1",
	"htmltrust_normalize_text_v1",
	"htmltrust_extract_canonical_text_options_v1",
	"htmltrust_canonicalize_claims_v1",
	"htmltrust_extract_claims_from_signed_section_v1",
	"htmltrust_canonicalize_json_document_v1",
	"htmltrust_bytes_free",
}

// RustCore is an explicit-path handle to the Rust canonicalization library.
// It never searches process or system library paths on behalf of the caller.
type RustCore struct {
	mu      sync.Mutex
	backend rustCoreBackend
	closed  bool
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
	backend, err := newRustCoreBackend(libraryPath)
	if err != nil {
		return nil, err
	}
	return &RustCore{backend: backend}, nil
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
		if r.backend != nil {
			r.backend.close()
		}
		r.backend = nil
		r.closed = true
	}
	return nil
}

func (r *RustCore) begin() (rustCoreBackend, error) {
	if r == nil {
		return nil, errors.New("nil htmltrust Rust core")
	}
	if r.closed || r.backend == nil {
		return nil, errors.New("htmltrust Rust core is closed")
	}
	return r.backend, nil
}

func (r *RustCore) call(operation rustCoreOperation, input, base []byte, preserveWhitespace bool) ([]byte, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	backend, err := r.begin()
	if err != nil {
		return nil, err
	}
	result, err := backend.call(operation, input, base, preserveWhitespace)
	if err != nil {
		return nil, err
	}
	if uint64(len(result)) > rustCoreMaxOutputBytes {
		return nil, &RustCoreError{Code: "invalid-output", Status: 0}
	}
	return result, nil
}

func (r *RustCore) NormalizeText(text string, preserveWhitespace bool) (string, error) {
	result, err := r.call(rustCoreNormalize, []byte(text), nil, preserveWhitespace)
	return string(result), err
}

func (r *RustCore) ExtractCanonicalText(html string, preserveWhitespace bool, baseURL *string) (string, error) {
	var base []byte
	if baseURL != nil && *baseURL != "" {
		base = []byte(*baseURL)
	}
	result, err := r.call(rustCoreExtract, []byte(html), base, preserveWhitespace)
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
	result, err := r.call(rustCoreClaims, raw, nil, false)
	return string(result), err
}

// ExtractClaimsFromSignedSection delegates signed-section parsing and claim
// normalization to the Rust core. The ABI returns a JSON object whose values
// are strings, keeping HTML parsing out of this language binding.
func (r *RustCore) ExtractClaimsFromSignedSection(source string) (map[string]string, error) {
	raw, err := r.call(rustCoreExtractClaims, []byte(source), nil, false)
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
	return r.call(rustCoreJCS, document, nil, false)
}
