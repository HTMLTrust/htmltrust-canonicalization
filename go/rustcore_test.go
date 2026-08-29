package canonicalize

import (
	"os"
	"runtime"
	"strings"
	"testing"
)

func TestNewRustCoreRequiresExplicitPath(t *testing.T) {
	if _, err := NewRustCore("libhtmltrust_canonicalization_ffi.so"); err == nil || !strings.Contains(err.Error(), "must be absolute") {
		t.Fatalf("relative path error: %v", err)
	}
	if _, err := NewRustCore("/definitely/missing/htmltrust-canonicalization-ffi.so"); err == nil {
		t.Fatal("NewRustCore unexpectedly succeeded")
	}
}

func TestNewRustCoreRejectsWrongABIFixture(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux shared-core fixture is not supported")
	}
	path := os.Getenv("HTMLTRUST_RUST_CORE_WRONG_ABI_LIB")
	if path == "" {
		t.Skip("HTMLTRUST_RUST_CORE_WRONG_ABI_LIB is not set")
	}
	if _, err := NewRustCore(path); err == nil || !strings.Contains(err.Error(), "unsupported htmltrust Rust core ABI version 999") {
		t.Fatalf("wrong ABI fixture error: %v", err)
	}
}

func TestNewRustCoreRejectsMissingOperationFixture(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux shared-core fixture is not supported")
	}
	path := os.Getenv("HTMLTRUST_RUST_CORE_MISSING_OPERATION_LIB")
	if path == "" {
		t.Skip("HTMLTRUST_RUST_CORE_MISSING_OPERATION_LIB is not set")
	}
	if _, err := NewRustCore(path); err == nil || !strings.Contains(err.Error(), "htmltrust Rust core symbol is missing: htmltrust_canonicalize_json_document_v1") {
		t.Fatalf("missing operation fixture error: %v", err)
	}
}

func TestRustCoreAllOperationsAndEdgeInputs(t *testing.T) {
	path := os.Getenv("HTMLTRUST_RUST_CORE_LIB")
	if path == "" {
		t.Skip("HTMLTRUST_RUST_CORE_LIB is not set")
	}
	core, err := NewRustCore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer core.Close()
	if got, err := core.NormalizeText("A—B", false); err != nil || got != "A-B" {
		t.Fatalf("normalize: %q, %v", got, err)
	}
	if got, err := core.NormalizeText("a\x00b", false); err != nil || got != "a\x00b" {
		t.Fatalf("normalize embedded NUL: %q, %v", got, err)
	}
	if got, err := core.NormalizeText("", false); err != nil || got != "" {
		t.Fatalf("normalize empty: %q, %v", got, err)
	}
	base := "https://example.com/"
	if got, err := core.ExtractCanonicalText("<p>A</p>", false, &base); err != nil || got != "A" {
		t.Fatalf("extract: %q, %v", got, err)
	}
	emptyBase := ""
	if got, err := core.ExtractCanonicalText("<p>A</p>", false, &emptyBase); err != nil || got != "A" {
		t.Fatalf("extract with empty base: %q, %v", got, err)
	}
	if got, err := core.CanonicalizeClaims(map[string]string{"z": "2", "a": "1"}); err != nil || got != "a:1\nz:2\n" {
		t.Fatalf("claims: %q, %v", got, err)
	}
	if got, err := core.CanonicalizeClaims(nil); err != nil || got != "" {
		t.Fatalf("empty claims: %q, %v", got, err)
	}
	if _, err := core.CanonicalizeClaims(map[string]string{"bad": string([]byte{0xff})}); err == nil || !strings.Contains(err.Error(), "claim-malformed") {
		t.Fatalf("invalid UTF-8 claims error: %v", err)
	}
	if got, err := core.CanonicalizeJSONDocument([]byte(`{"z":0,"a":1}`)); err != nil || string(got) != `{"a":1,"z":0}` {
		t.Fatalf("jcs: %q, %v", got, err)
	}
	if _, err := core.CanonicalizeJSONDocument([]byte("{")); err == nil || err.Error() != "jcs-invalid-json" {
		t.Fatalf("invalid jcs error: %v", err)
	}
	if _, err := core.CanonicalizeJSONDocument([]byte(`"\uD800"`)); err == nil || !strings.Contains(err.Error(), "jcs-invalid-surrogate") {
		t.Fatalf("lone surrogate jcs error: %v", err)
	}
}
