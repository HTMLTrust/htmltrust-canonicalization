package canonicalize

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"os"
	"strings"
	"testing"
)

func testRustCore(t *testing.T) *RustCore {
	t.Helper()
	path := os.Getenv("HTMLTRUST_RUST_CORE_LIB")
	if path == "" {
		t.Fatal("HTMLTRUST_RUST_CORE_LIB is required for Rust-backed Go tests")
	}
	core, err := NewRustCore(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = core.Close() })
	return core
}

func TestRustCoreClaimExtraction(t *testing.T) {
	core := testRustCore(t)
	claims, err := core.ExtractClaimsFromSignedSection(`<signed-section><meta name="author" content=" Alice "><meta name="signed-at" content="2026-08-27T12:00:00Z"><div><meta name="author" content="Nested"></div></signed-section>`)
	if err != nil {
		t.Fatal(err)
	}
	if claims["author"] != "Alice" || claims["signed-at"] != "2026-08-27T12:00:00Z" || len(claims) != 2 {
		t.Fatalf("unexpected claims: %#v", claims)
	}
}

func TestRustCoreSigningPayloadReceiver(t *testing.T) {
	core := testRustCore(t)
	payload, err := core.BuildSigningPayloadV1(SigningProfileV1Input{
		ContentHash: "sha256:content", ClaimsHash: "sha256:claims",
		DocumentURL: "https://example.test/article", Scope: "origin",
		KeyID: "did:web:example.test", Algorithm: "ed25519",
		SignedAt: "2026-08-27T12:00:00Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(payload, `"profile":"htmltrust-signature-v1"`) || !strings.Contains(payload, `"location":"https://example.test"`) {
		t.Fatalf("unexpected signing payload: %s", payload)
	}
}

func TestRustCoreEndorsementReceiver(t *testing.T) {
	core := testRustCore(t)
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	endorsement := Endorsement{
		Endorser: "static", Endorsement: "sha256:content", Algorithm: "ed25519",
		Timestamp: "2026-08-27T12:00:00Z", Signature: "placeholder",
		Extensions: map[string]any{"extension": map[string]any{"answer": 42}},
	}
	binding, err := core.BuildEndorsementBinding(endorsement)
	if err != nil || !strings.Contains(binding, `"extension":{"answer":42}`) {
		t.Fatalf("BuildEndorsementBinding: %s, %v", binding, err)
	}
	if _, err := core.CanonicalizeEndorsementDocument([]byte(`{"endorser":"a","endorser":"b","endorsement":"sha256:x","algorithm":"ed25519","timestamp":"2026-08-27T12:00:00Z"}`)); err == nil || !strings.Contains(err.Error(), "jcs-duplicate-key") {
		t.Fatalf("duplicate endorsement member error: %v", err)
	}
	endorsement.Signature = base64.RawStdEncoding.EncodeToString(ed25519.Sign(private, []byte(binding)))
	ok, err := core.VerifyEndorsement(context.Background(), endorsement, []KeyResolver{
		migrationKeyResolver{key: &ResolvedKey{PublicKeyPEM: encodePublicKeyPEM(t, public), Algorithm: "ed25519"}},
	})
	if err != nil || !ok {
		t.Fatalf("VerifyEndorsement: %v, %v", ok, err)
	}
}

func TestRustCoreDecodeEndorsementPreservesExtensions(t *testing.T) {
	core := testRustCore(t)
	var unsafe Endorsement
	if err := json.Unmarshal([]byte(`{"endorser":"a"}`), &unsafe); err == nil || !strings.Contains(err.Error(), "DecodeEndorsement") {
		t.Fatalf("standard endorsement decoding error = %v", err)
	}
	e, err := core.DecodeEndorsement([]byte(`{"endorser":"static","endorsement":"sha256:content","algorithm":"ed25519","timestamp":"2026-08-27T12:00:00Z","extension":{"answer":42},"signature":"placeholder"}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := e.Extensions["extension"]; !ok {
		t.Fatalf("extension dropped: %#v", e.Extensions)
	}
}

func TestRustCoreEndorsementLifecycleAndRequiredFields(t *testing.T) {
	core := testRustCore(t)
	base := Endorsement{
		Endorser: "static", Endorsement: "sha256:content", Signature: "AAAA",
		Timestamp: "2026-08-27T12:00:00Z", Algorithm: "ed25519",
	}
	for name, endorsement := range map[string]Endorsement{
		"revoked endorsement": func() Endorsement { e := base; e.RevokedBy = "authority"; return e }(),
		"expired endorsement": func() Endorsement { e := base; e.Expires = "2020-01-01T00:00:00Z"; return e }(),
	} {
		t.Run(name, func(t *testing.T) {
			ok, err := core.VerifyEndorsement(context.Background(), endorsement, nil)
			if err != nil || ok {
				t.Fatalf("VerifyEndorsement = %v, %v", ok, err)
			}
		})
	}
	for name, endorsement := range map[string]Endorsement{
		"missing endorser":    func() Endorsement { e := base; e.Endorser = ""; return e }(),
		"missing endorsement": func() Endorsement { e := base; e.Endorsement = ""; return e }(),
		"missing signature":   func() Endorsement { e := base; e.Signature = ""; return e }(),
		"missing timestamp":   func() Endorsement { e := base; e.Timestamp = ""; return e }(),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := core.VerifyEndorsement(context.Background(), endorsement, nil); err == nil {
				t.Fatal("missing required field was accepted")
			}
		})
	}
}

func TestNativeSignatureAndLifecycleRemainAvailable(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	message := "native signing remains in the Go binding"
	signature := base64.RawStdEncoding.EncodeToString(ed25519.Sign(private, []byte(message)))
	publicPEM := encodePublicKeyPEM(t, public)
	ok, err := VerifySignature(message, signature, publicPEM, "ed25519")
	if err != nil || !ok {
		t.Fatalf("VerifySignature: %v, %v", ok, err)
	}
	if err := ValidateSignedAtV1("2026-08-27T12:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if err := ValidateSignedAtV1("2026-02-29T12:00:00Z"); err == nil {
		t.Fatal("invalid timestamp accepted")
	}
}

func encodePublicKeyPEM(t *testing.T, public any) string {
	t.Helper()
	// VerifySignature accepts the standard PKIX PEM generated by the existing
	// test helpers. Keep this helper local to avoid coupling canonicalization
	// tests to the removed implementation files.
	der, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
}

type migrationKeyResolver struct{ key *ResolvedKey }

func (r migrationKeyResolver) Resolve(context.Context, string) (*ResolvedKey, error) {
	return r.key, nil
}
