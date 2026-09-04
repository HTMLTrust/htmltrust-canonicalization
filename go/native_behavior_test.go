package canonicalize

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/asn1"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

func TestBuildSignatureBindingKeepsNativeLegacyPath(t *testing.T) {
	got, err := BuildSignatureBinding("sha256:abc", "sha256:def", "https://example.com", "2025-01-01T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	want := "sha256:abc:sha256:def:https://example.com:2025-01-01T00:00:00Z"
	if got != want {
		t.Fatalf("binding = %q, want %q", got, want)
	}
	for _, input := range [][4]string{
		{"", "b", "https://example.com", "d"},
		{"a", "", "https://example.com", "d"},
		{"a", "b", "", "d"},
		{"a", "b", "https://example.com", ""},
		{"a", "b", "example.com", "d"},
		{"a", "b", "ftp://example.com", "d"},
	} {
		if _, err := BuildSignatureBinding(input[0], input[1], input[2], input[3]); err == nil {
			t.Errorf("accepted invalid binding input %#v", input)
		}
	}
}

func TestNativeSignatureAlgorithmsAndBase64(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	message := "native signature payload"
	signature := base64.RawStdEncoding.EncodeToString(ed25519.Sign(private, []byte(message)))
	ok, err := VerifySignature(message, signature, encodePublicKeyPEM(t, public), "ED25519")
	if err != nil || !ok {
		t.Fatalf("VerifySignature = %v, %v", ok, err)
	}
	if _, err := DecodeCanonicalBase64(signature + "="); err == nil {
		t.Fatal("padded signature was accepted")
	}
	if _, err := DecodeCanonicalBase64("not base64"); err == nil {
		t.Fatal("invalid base64 was accepted")
	}
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(message))
	pkcs1, err := rsa.SignPKCS1v15(rand.Reader, rsaKey, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := VerifySignature(message, base64.RawStdEncoding.EncodeToString(pkcs1), encodePublicKeyPEM(t, &rsaKey.PublicKey), "rsa-pkcs1-sha256"); err != nil || !ok {
		t.Fatalf("RSA PKCS#1 verification = %v, %v", ok, err)
	}
	pss, err := rsa.SignPSS(rand.Reader, rsaKey, crypto.SHA256, digest[:], &rsa.PSSOptions{SaltLength: rsa.PSSSaltLengthEqualsHash, Hash: crypto.SHA256})
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := VerifySignature(message, base64.RawStdEncoding.EncodeToString(pss), encodePublicKeyPEM(t, &rsaKey.PublicKey), "rsa-pss-sha256"); err != nil || !ok {
		t.Fatalf("RSA-PSS verification = %v, %v", ok, err)
	}
	ecdsaKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	r, s, err := ecdsa.Sign(rand.Reader, ecdsaKey, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	ecdsaSignature, err := asn1.Marshal(ecdsaSig{R: r, S: s})
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := VerifySignature(message, base64.RawStdEncoding.EncodeToString(ecdsaSignature), encodePublicKeyPEM(t, &ecdsaKey.PublicKey), "ecdsa"); err != nil || !ok {
		t.Fatalf("ECDSA verification = %v, %v", ok, err)
	}
}

func TestNativeURLLocationAndLifecyclePolicy(t *testing.T) {
	location, err := DeriveSigningLocationV1("HTTPS://BÜCHER.EXAMPLE:443/a/../article?q=1#part", "url")
	if err != nil || location != "https://xn--bcher-kva.example/article?q=1" {
		t.Fatalf("URL location = %q, %v", location, err)
	}
	if _, err := DeriveSigningLocationV1("https://example.test/", "invalid"); err == nil {
		t.Fatal("unsupported scope was accepted")
	}
	now := time.Date(2026, time.August, 27, 12, 0, 0, 0, time.UTC)
	if !IsKeyRevoked(&ResolvedKey{Revoked: true}, now) || !IsKeyRevoked(&ResolvedKey{Expires: "2026-08-27T11:59:59Z"}, now) {
		t.Fatal("revoked or expired key was accepted")
	}
	if IsKeyRevoked(&ResolvedKey{Expires: "2026-08-27T12:00:01Z"}, now) {
		t.Fatal("future-expiry key was rejected")
	}
}

func TestDirectResolverAndResolverChain(t *testing.T) {
	public, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pemKey := encodePublicKeyPEM(t, public)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/key" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"publicKey": pemKey, "algorithm": "ed25519"})
	}))
	defer server.Close()
	key, err := (&DirectURLResolver{HTTPClient: server.Client()}).Resolve(context.Background(), server.URL+"/key")
	if err != nil || key == nil || key.Algorithm != "ed25519" {
		t.Fatalf("direct resolver = %#v, %v", key, err)
	}
	if _, err := ResolveKey(context.Background(), "did:fake:nope", []KeyResolver{&DidWebResolver{}}); err == nil {
		t.Fatal("unmatched resolver chain did not fail")
	}
}

func TestTrustDirectoryResolverEscapesKeyID(t *testing.T) {
	public, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.EscapedPath() != "/keys/part%2Fwith%3Fquery%23fragment" {
			t.Fatalf("escaped key path = %q", r.URL.EscapedPath())
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"publicKey": encodePublicKeyPEM(t, public), "algorithm": "ed25519"})
	}))
	defer server.Close()
	key, err := (&TrustDirectoryResolver{BaseURLs: []string{server.URL}, HTTPClient: server.Client()}).Resolve(context.Background(), "part/with?query#fragment")
	if err != nil || key == nil || key.Algorithm != "ed25519" {
		t.Fatalf("trust directory resolver = %#v, %v", key, err)
	}
}

func TestDidWebResolverUsesWellKnownDocument(t *testing.T) {
	public, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/did.json" {
			t.Fatalf("did document path = %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "did:web:example.test",
			"verificationMethod": []map[string]string{{
				"id": "#key-1", "type": "Ed25519VerificationKey", "publicKeyPem": encodePublicKeyPEM(t, public),
			}},
		})
	}))
	defer server.Close()
	client := server.Client()
	target, _ := url.Parse(server.URL)
	client.Transport = rewriteNativeTransport{base: client.Transport, target: target}
	key, err := (&DidWebResolver{HTTPClient: client}).Resolve(context.Background(), "did:web:example.test")
	if err != nil || key == nil || key.Algorithm != "ed25519" {
		t.Fatalf("did:web resolver = %#v, %v", key, err)
	}
	if key.Period != 0 || key.Identity != "did:web:example.test" || key.MethodID != "did:web:example.test#key-1" {
		t.Fatalf("did:web resolver period fields = %#v", key)
	}
}

func TestRemoteResolverRejectsOversizedBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(make([]byte, maxRemoteKeyBytes+1))
	}))
	defer server.Close()
	if _, err := (&DirectURLResolver{HTTPClient: server.Client()}).Resolve(context.Background(), server.URL); err == nil {
		t.Fatal("oversized resolver response was accepted")
	}
}

type rewriteNativeTransport struct {
	base   http.RoundTripper
	target *url.URL
}

func (t rewriteNativeTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	clone.URL.Scheme = t.target.Scheme
	clone.URL.Host = t.target.Host
	return t.base.RoundTrip(clone)
}
