package canonicalize

import (
	"crypto/sha256"
	"encoding/json"
	"os"
	"testing"
)

// TestEndToEndVectors reproduces the shared end-to-end test vectors
// (conformance/vectors/*.json): canonical bytes -> content/claims hash ->
// §5 signing payload -> signature verification. This is the byte-level anchor
// that every signer and verifier must agree on.
func TestEndToEndVectors(t *testing.T) {
	type vector struct {
		Algorithm string `json:"algorithm"`
		Key       struct {
			PublicKeyPem string `json:"publicKeyPem"`
		} `json:"key"`
		Input struct {
			HTML     string `json:"html"`
			BaseURL  string `json:"baseURL"`
			Domain   string `json:"domain"`
			SignedAt string `json:"signedAt"`
		} `json:"input"`
		Claims           map[string]string `json:"claims"`
		CanonicalContent string            `json:"canonicalContent"`
		ContentHash      string            `json:"contentHash"`
		CanonicalClaims  string            `json:"canonicalClaims"`
		ClaimsHash       string            `json:"claimsHash"`
		SigningPayload   string            `json:"signingPayload"`
		Signature        string            `json:"signature"`
	}
	sha := func(s string) string {
		sum := sha256.Sum256([]byte(s))
		return "sha256:" + EncodeBase64Unpadded(sum[:])
	}
	for _, path := range []string{"../conformance/vectors/vector-01.json"} {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		var v vector
		if err := json.Unmarshal(raw, &v); err != nil {
			t.Fatalf("parse %s: %v", path, err)
		}
		content, err := ExtractCanonicalText(v.Input.HTML, Options{BaseURL: v.Input.BaseURL})
		if err != nil {
			t.Fatalf("%s: extract: %v", path, err)
		}
		if content != v.CanonicalContent {
			t.Errorf("%s: canonicalContent\n got %q\nwant %q", path, content, v.CanonicalContent)
		}
		if got := sha(content); got != v.ContentHash {
			t.Errorf("%s: contentHash got %s want %s", path, got, v.ContentHash)
		}
		claims, err := CanonicalizeClaimsStrict(v.Claims)
		if err != nil {
			t.Fatalf("%s: claims: %v", path, err)
		}
		if claims != v.CanonicalClaims {
			t.Errorf("%s: canonicalClaims\n got %q\nwant %q", path, claims, v.CanonicalClaims)
		}
		if got := sha(claims); got != v.ClaimsHash {
			t.Errorf("%s: claimsHash got %s want %s", path, got, v.ClaimsHash)
		}
		payload, err := BuildSignatureBinding(v.ContentHash, v.ClaimsHash, v.Input.Domain, v.Input.SignedAt)
		if err != nil {
			t.Fatalf("%s: binding: %v", path, err)
		}
		if payload != v.SigningPayload {
			t.Errorf("%s: signingPayload\n got %q\nwant %q", path, payload, v.SigningPayload)
		}
		ok, err := VerifySignature(payload, v.Signature, v.Key.PublicKeyPem, v.Algorithm)
		if err != nil || !ok {
			t.Errorf("%s: signature did not verify (ok=%v err=%v)", path, ok, err)
		}
	}
}
