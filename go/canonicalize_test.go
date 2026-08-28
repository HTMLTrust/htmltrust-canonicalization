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
	"crypto/sha512"
	"crypto/x509"
	"encoding/asn1"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestNormalize(t *testing.T) {
	tests := []struct {
		name     string
		inputA   string
		inputB   string
		wantSame bool
	}{
		{"Curly double quotes → straight", "“Hello”", "\"Hello\"", true},
		{"Precomposed vs combining (NFKC)", "café", "café", true},
		{"fi ligature (NFKC)", "ﬁnd", "find", true},
		{"Em dash → hyphen-minus", "word — word", "word - word", true},
		{"Guillemets → double quotes", "«Bonjour»", "\"Bonjour\"", true},
		{"CJK corner brackets → double quotes", "「東京」", "\"東京\"", true},
		{"ZWNJ is semantic (Persian)", "می‌خواهم", "میخواهم", false},
		{"Arabic tatweel stripped", "كتـــاب", "كتاب", true},
		{"Fullwidth ASCII (NFKC)", "Ａ１", "A1", true},
		{"Circled digit (NFKC)", "①", "1", true},
		{"ZWSP stripped", "word​word", "wordword", true},
		{"ZWNJ preserved (different)", "word‌word", "wordword", false},
		{"Ellipsis → three dots", "Hello…", "Hello...", true},
		{"Curly single quotes → straight", "‘Hello’", "'Hello'", true},
		{"Low-9 quotes → straight", "‚German“", "'German\"", true},
		{"No-break space → space", "a b", "a b", true},
		{"Ideographic space → space", "a　b", "a b", true},
		{"Whitespace collapse", "a  \t  b", "a b", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			a := NormalizeText(tt.inputA)
			b := NormalizeText(tt.inputB)
			same := a == b
			if same != tt.wantSame {
				t.Errorf("NormalizeText(%q) = %q, NormalizeText(%q) = %q; same=%v, want same=%v",
					tt.inputA, a, tt.inputB, b, same, tt.wantSame)
			}
		})
	}
}

func TestNormalizeCheckedEnforcesResourceLimits(t *testing.T) {
	if _, err := NormalizeTextChecked(strings.Repeat("x", maxResourceBytes+1)); err == nil || !strings.Contains(err.Error(), "resource-limit-exceeded") {
		t.Fatalf("expected checked normalization input limit, got %v", err)
	}
	if _, err := NormalizeChecked(strings.Repeat("x", maxResourceBytes+1)); err == nil || !strings.Contains(err.Error(), "resource-limit-exceeded") {
		t.Fatalf("expected checked trim normalization input limit, got %v", err)
	}
	// The legacy wrappers remain source-compatible and intentionally do not
	// return an error for oversized input.
	if got := NormalizeText(strings.Repeat("x", maxResourceBytes+1)); len(got) != maxResourceBytes+1 {
		t.Fatalf("legacy NormalizeText changed oversized-input behavior: got %d bytes", len(got))
	}
}

// ----- ExtractCanonicalText -----

func TestExtractCanonicalText(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "block boundaries become whitespace",
			in:   "<p>Hello</p><p>World</p>",
			want: "Hello\nWorld",
		},
		{
			name: "inline elements do not introduce spaces",
			in:   "<p>hello <em>world</em></p>",
			want: "hello world",
		},
		{
			name: "scripts and styles dropped with content",
			in:   "<p>before</p><script>alert('x')</script><style>p{}</style><p>after</p>",
			want: "before\nafter",
		},
		{
			name: "meta inside signed-section is metadata, not content",
			in:   `<signed-section><meta name="signed-at" content="2025-01-01"/>Body</signed-section>`,
			want: "Body",
		},
		{
			name: "named entities decoded",
			in:   "<p>fish &amp; chips</p>",
			want: "fish & chips",
		},
		{
			name: "numeric entities decoded",
			in:   "<p>caf&#233;</p>",
			want: "café",
		},
		{
			name: "hex entities decoded",
			in:   "<p>&#x2014;</p>",
			want: "-", // em dash → hyphen via Phase 4
		},
		{
			name: "br is a void element → whitespace",
			in:   "<p>line1<br/>line2</p>",
			want: "line1\nline2",
		},
		{
			name: "signed semantic attributes",
			in:   `<p><a href="https://example.org/story?a=1&amp;b=2" aria-label="Read “more”">link</a><img src="https://example.org/img.png" alt="Hero — image"></p>`,
			want: "@attr:a:href:https://example.org/story?a=1&b=2\n@attr:a:aria-label:Read \"more\"\nlink\n@attr:img:src:https://example.org/img.png\n@attr:img:alt:Hero - image",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ExtractCanonicalText(tt.in)
			if err != nil {
				t.Fatalf("ExtractCanonicalText(%q) returned error: %v", tt.in, err)
			}
			if got != tt.want {
				t.Errorf("ExtractCanonicalText(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestExtractCanonicalTextRejectsUnterminatedNumericReferences(t *testing.T) {
	for _, input := range []string{
		"<p>&#65</p>",
		"<p>&#x41</p>",
		`<a aria-label="&#65">link</a>`,
	} {
		if _, err := ExtractCanonicalText(input); err == nil || !strings.Contains(err.Error(), "parser-profile-unsupported") {
			t.Errorf("ExtractCanonicalText(%q) error = %v, want parser-profile-unsupported", input, err)
		}
	}
}

// ----- CanonicalizeClaims -----

func TestCanonicalizeClaims(t *testing.T) {
	got, err := CanonicalizeClaims(map[string]string{
		"signed-at": "2025-01-01T00:00:00Z",
		"author":    "alice",
		"domain":    "https://example.com",
	})
	if err != nil {
		t.Fatalf("CanonicalizeClaims: %v", err)
	}
	want := "author:alice\ndomain:https\\://example.com\nsigned-at:2025-01-01T00\\:00\\:00Z\n"
	if got != want {
		t.Errorf("CanonicalizeClaims = %q, want %q", got, want)
	}
}

func TestCanonicalizeClaimsNormalizesValues(t *testing.T) {
	got, err := CanonicalizeClaims(map[string]string{
		"title": "“Hello”",
	})
	if err != nil {
		t.Fatalf("CanonicalizeClaims: %v", err)
	}
	want := "title:\"Hello\"\n"
	if got != want {
		t.Errorf("CanonicalizeClaims = %q, want %q", got, want)
	}
}

func TestSigningProfileV1LocationAndTimestamp(t *testing.T) {
	location, err := DeriveSigningLocationV1("HTTPS://BÜCHER.EXAMPLE:443/a/../article?q=1#part", "url")
	if err != nil || location != "https://xn--bcher-kva.example/article?q=1" {
		t.Fatalf("URL location = %q, %v", location, err)
	}
	location, err = DeriveSigningLocationV1("https://example.org:8443/a?q=1#part", "origin")
	if err != nil || location != "https://example.org:8443" {
		t.Fatalf("origin location = %q, %v", location, err)
	}
	for _, value := range []string{"2023-02-29T23:59:59Z", "2026-01-15T12:00:00.000Z"} {
		if err := ValidateSignedAtV1(value); err == nil {
			t.Fatalf("expected timestamp %q to fail", value)
		}
	}
}

// ----- BuildSignatureBinding -----

func TestBuildSignatureBinding(t *testing.T) {
	got, err := BuildSignatureBinding("sha256:abc", "sha256:def", "https://example.com", "2025-01-01T00:00:00Z")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := "sha256:abc:sha256:def:https://example.com:2025-01-01T00:00:00Z"
	if got != want {
		t.Errorf("BuildSignatureBinding = %q, want %q", got, want)
	}
}

func TestBuildSignatureBindingErrors(t *testing.T) {
	cases := [][]string{
		{"", "b", "https://example.com", "d"},
		{"a", "", "https://example.com", "d"},
		{"a", "b", "", "d"},
		{"a", "b", "https://example.com", ""},
		{"a", "b", "example.com", "d"},
		{"a", "b", "ftp://example.com", "d"},
	}
	for _, c := range cases {
		if _, err := BuildSignatureBinding(c[0], c[1], c[2], c[3]); err == nil {
			t.Errorf("expected error for inputs %v", c)
		}
	}
}

func TestValidateSerializedOriginIPv6(t *testing.T) {
	if err := ValidateSerializedOrigin("https://[2001:db8::1]:8443"); err != nil {
		t.Fatalf("valid IPv6 origin rejected: %v", err)
	}
}

// ----- VerifySignature -----

func encodePKIX(t *testing.T, pub any) string {
	t.Helper()
	b, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatalf("MarshalPKIXPublicKey: %v", err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: b}))
}

func TestVerifySignatureEd25519(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	msg := "the quick brown fox"
	sig := ed25519.Sign(priv, []byte(msg))

	pemStr := encodePKIX(t, pub)

	ok, err := VerifySignature(msg, base64.RawStdEncoding.EncodeToString(sig), pemStr, "ed25519")
	if err != nil {
		t.Fatalf("VerifySignature returned error: %v", err)
	}
	if !ok {
		t.Errorf("expected ed25519 signature to verify")
	}

	// Uppercase algorithm should also work.
	ok, err = VerifySignature(msg, base64.RawStdEncoding.EncodeToString(sig), pemStr, "ED25519")
	if err != nil {
		t.Fatalf("VerifySignature(raw) returned error: %v", err)
	}
	if !ok {
		t.Errorf("expected ed25519 signature to verify with unpadded base64 + uppercase algo")
	}

	// Tampered message must fail.
	ok, _ = VerifySignature("tampered", base64.RawStdEncoding.EncodeToString(sig), pemStr, "ed25519")
	if ok {
		t.Errorf("expected tampered ed25519 signature to fail")
	}

	if ok, _ = VerifySignature(msg, base64.StdEncoding.EncodeToString(sig), pemStr, "ed25519"); ok {
		t.Errorf("expected padded base64 signature to be rejected")
	}
}

func TestVerifySignatureRSA(t *testing.T) {
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("rsa.GenerateKey: %v", err)
	}
	msg := "rsa payload"
	digest := sha256.Sum256([]byte(msg))
	sig, err := rsa.SignPKCS1v15(rand.Reader, priv, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatalf("SignPKCS1v15: %v", err)
	}

	pemStr := encodePKIX(t, &priv.PublicKey)
	ok, err := VerifySignature(msg, base64.RawStdEncoding.EncodeToString(sig), pemStr, "RSA")
	if err != nil {
		t.Fatalf("VerifySignature returned error: %v", err)
	}
	if !ok {
		t.Errorf("expected rsa signature to verify")
	}

	ok, _ = VerifySignature("tampered", base64.RawStdEncoding.EncodeToString(sig), pemStr, "rsa")
	if ok {
		t.Errorf("expected tampered rsa signature to fail")
	}
}

func TestVerifySignatureECDSA(t *testing.T) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("ecdsa.GenerateKey: %v", err)
	}
	msg := "ecdsa payload"
	digest := sha256.Sum256([]byte(msg))
	r, s, err := ecdsa.Sign(rand.Reader, priv, digest[:])
	if err != nil {
		t.Fatalf("ecdsa.Sign: %v", err)
	}
	sigBytes, err := asn1.Marshal(struct{ R, S *big.Int }{r, s})
	if err != nil {
		t.Fatalf("asn1.Marshal: %v", err)
	}
	pemStr := encodePKIX(t, &priv.PublicKey)
	ok, err := VerifySignature(msg, base64.RawStdEncoding.EncodeToString(sigBytes), pemStr, "ecdsa")
	if err != nil {
		t.Fatalf("VerifySignature returned error: %v", err)
	}
	if !ok {
		t.Errorf("expected ecdsa signature to verify")
	}
}

func TestVerifySignatureRegistryECDSA(t *testing.T) {
	tests := []struct {
		name      string
		curve     elliptic.Curve
		algorithm string
		width     int
		digest    func(string) []byte
	}{
		{"P-256", elliptic.P256(), "ecdsa-p256", 32, func(message string) []byte { sum := sha256.Sum256([]byte(message)); return sum[:] }},
		{"P-384", elliptic.P384(), "ecdsa-p384", 48, func(message string) []byte { sum := sha512.Sum384([]byte(message)); return sum[:] }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			priv, err := ecdsa.GenerateKey(tc.curve, rand.Reader)
			if err != nil {
				t.Fatalf("ecdsa.GenerateKey: %v", err)
			}
			message := "registry ecdsa"
			r, s, err := ecdsa.Sign(rand.Reader, priv, tc.digest(message))
			if err != nil {
				t.Fatalf("ecdsa.Sign: %v", err)
			}
			sig := make([]byte, tc.width*2)
			r.FillBytes(sig[:tc.width])
			s.FillBytes(sig[tc.width:])
			ok, err := VerifySignature(message, EncodeBase64Unpadded(sig), encodePKIX(t, &priv.PublicKey), tc.algorithm)
			if err != nil || !ok {
				t.Fatalf("registry signature did not verify: ok=%v err=%v", ok, err)
			}
		})
	}
}

func TestVerifySignatureRSAPSS(t *testing.T) {
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("rsa.GenerateKey: %v", err)
	}
	message := "rsa pss"
	digest := sha256.Sum256([]byte(message))
	sig, err := rsa.SignPSS(rand.Reader, priv, crypto.SHA256, digest[:], &rsa.PSSOptions{SaltLength: rsa.PSSSaltLengthEqualsHash})
	if err != nil {
		t.Fatalf("rsa.SignPSS: %v", err)
	}
	ok, err := VerifySignature(message, EncodeBase64Unpadded(sig), encodePKIX(t, &priv.PublicKey), "rsa-pss-sha256")
	if err != nil || !ok {
		t.Fatalf("PSS signature did not verify: ok=%v err=%v", ok, err)
	}
}

func TestVerifySignatureUnsupportedAlgorithm(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	pemStr := encodePKIX(t, pub)
	if _, err := VerifySignature("x", "AAAA", pemStr, "weird"); err == nil {
		t.Errorf("expected error for unsupported algorithm")
	}
}

// ----- Resolver tests -----

func newEd25519PEM(t *testing.T) (string, ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	return encodePKIX(t, pub), pub, priv
}

func TestDidWebResolver(t *testing.T) {
	pemStr, _, _ := newEd25519PEM(t)

	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/did.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"verificationMethod": []map[string]any{
				{
					"id":           "did:web:example#key1",
					"type":         "Ed25519VerificationKey2020",
					"publicKeyPem": pemStr,
				},
			},
		})
	})
	srv := httptest.NewTLSServer(mux)
	defer srv.Close()

	// Rewrite the request to point at our test server, regardless of host.
	client := srv.Client()
	client.Transport = rewriteTransport{base: srv.Client().Transport, target: srv.URL}

	r := DidWebResolver{HTTPClient: client}
	got, err := r.Resolve(context.Background(), "did:web:example.test")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got == nil {
		t.Fatal("expected ResolvedKey, got nil")
	}
	if !strings.Contains(got.PublicKeyPEM, "BEGIN PUBLIC KEY") {
		t.Errorf("expected PEM in PublicKeyPEM, got %q", got.PublicKeyPEM)
	}
	if got.Algorithm != "ed25519" {
		t.Errorf("expected algorithm ed25519, got %q", got.Algorithm)
	}
}

func TestDidWebResolverPathDocument(t *testing.T) {
	pemStr, _, _ := newEd25519PEM(t)
	var requestedPath string
	mux := http.NewServeMux()
	mux.HandleFunc("/user/1/did.json", func(w http.ResponseWriter, r *http.Request) {
		requestedPath = r.URL.EscapedPath()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"verificationMethod": []map[string]any{{"type": "Ed25519VerificationKey2020", "publicKeyPem": pemStr}},
		})
	})
	srv := httptest.NewTLSServer(mux)
	defer srv.Close()
	client := srv.Client()
	client.Transport = rewriteTransport{base: srv.Client().Transport, target: srv.URL}
	got, err := (DidWebResolver{HTTPClient: client}).Resolve(context.Background(), "did:web:example.test:user:1")
	if err != nil || got == nil {
		t.Fatalf("path DID resolution: key=%+v err=%v", got, err)
	}
	if requestedPath != "/user/1/did.json" {
		t.Fatalf("path DID requested %q, want /user/1/did.json", requestedPath)
	}
}

func TestDidWebResolverStripsFragmentAndDecodesPort(t *testing.T) {
	pemStr, _, _ := newEd25519PEM(t)
	var requestedPath string
	var requestedHost string
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/did.json", func(w http.ResponseWriter, r *http.Request) {
		requestedPath = r.URL.EscapedPath()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"verificationMethod": []map[string]any{{"type": "Ed25519VerificationKey2020", "publicKeyPem": pemStr}},
		})
	})
	srv := httptest.NewTLSServer(mux)
	defer srv.Close()
	client := srv.Client()
	client.Transport = rewriteTransport{base: srv.Client().Transport, target: srv.URL, seenHost: &requestedHost}
	got, err := (DidWebResolver{HTTPClient: client}).Resolve(context.Background(), "did:web:example.com%3A3000#key-1")
	if err != nil || got == nil {
		t.Fatalf("fragment/port DID resolution: key=%+v err=%v", got, err)
	}
	if requestedPath != "/.well-known/did.json" {
		t.Fatalf("DID requested path %q, want /.well-known/did.json", requestedPath)
	}
	if requestedHost != "example.com:3000" {
		t.Fatalf("DID requested host %q, want example.com:3000", requestedHost)
	}
}

func TestDidWebResolverRejectsInvalidUTF8Document(t *testing.T) {
	pemStr, _, _ := newEd25519PEM(t)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		body := []byte(`{"ignored":"`)
		body = append(body, 0xff)
		body = append(body, []byte(`","verificationMethod":[{"publicKeyPem":"`+pemStr+`"}]}`)...)
		_, _ = w.Write(body)
	}))
	defer srv.Close()
	client := srv.Client()
	client.Transport = rewriteTransport{base: srv.Client().Transport, target: srv.URL}
	if _, err := (DidWebResolver{HTTPClient: client}).Resolve(context.Background(), "did:web:example.test"); err == nil || !strings.Contains(err.Error(), "invalid UTF-8") {
		t.Fatalf("invalid UTF-8 DID document error = %v", err)
	}
}

func TestDidWebDocumentURLPreservesPathEscapes(t *testing.T) {
	got, err := didWebDocumentURL("example.com", []string{"foo%2Fbar"})
	if err != nil {
		t.Fatalf("didWebDocumentURL: %v", err)
	}
	if got != "https://example.com/foo%2Fbar/did.json" {
		t.Fatalf("didWebDocumentURL = %q", got)
	}
	if _, err := didWebDocumentURL("example.com", []string{"bad%escape"}); err == nil {
		t.Fatal("malformed percent escape was accepted")
	}
}

func TestDidWebResolverDeclinesNonDid(t *testing.T) {
	r := DidWebResolver{}
	got, err := r.Resolve(context.Background(), "https://example.com/key.json")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != nil {
		t.Errorf("expected nil for non-did keyid, got %+v", got)
	}
}

func TestDirectURLResolverJSON(t *testing.T) {
	pemStr, _, _ := newEd25519PEM(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"publicKey": pemStr,
			"algorithm": "ed25519",
			"revoked":   false,
			"expires":   "2099-01-01T00:00:00Z",
		})
	}))
	defer srv.Close()

	r := DirectURLResolver{HTTPClient: srv.Client()}
	got, err := r.Resolve(context.Background(), srv.URL+"/key.json")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got == nil || got.Algorithm != "ed25519" || got.Revoked || got.Expires != "2099-01-01T00:00:00Z" {
		t.Fatalf("unexpected key: %+v", got)
	}
}

func TestDirectURLResolverPEM(t *testing.T) {
	pemStr, _, _ := newEd25519PEM(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/x-pem-file")
		_, _ = w.Write([]byte(pemStr))
	}))
	defer srv.Close()

	r := DirectURLResolver{HTTPClient: srv.Client()}
	got, err := r.Resolve(context.Background(), srv.URL+"/key.pem")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got == nil || !strings.Contains(got.PublicKeyPEM, "BEGIN PUBLIC KEY") {
		t.Fatalf("unexpected key: %+v", got)
	}
}

func TestDirectURLResolverDeclinesNonHTTP(t *testing.T) {
	r := DirectURLResolver{}
	got, err := r.Resolve(context.Background(), "did:web:example.test")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != nil {
		t.Errorf("expected nil, got %+v", got)
	}
}

func TestTrustDirectoryResolver(t *testing.T) {
	pemStr, _, _ := newEd25519PEM(t)

	// First base 404s, second base returns the key.
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer bad.Close()
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/keys/abc123" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"publicKey": pemStr,
			"algorithm": "ed25519",
		})
	}))
	defer good.Close()

	r := TrustDirectoryResolver{
		BaseURLs:   []string{bad.URL, good.URL},
		HTTPClient: good.Client(),
	}
	got, err := r.Resolve(context.Background(), "abc123")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got == nil {
		t.Fatal("expected key, got nil")
	}
	if got.Keyid != "abc123" {
		t.Errorf("expected Keyid=abc123, got %q", got.Keyid)
	}
}

func TestTrustDirectoryResolverEscapesKeyIDPath(t *testing.T) {
	pemStr, _, _ := newEd25519PEM(t)
	const keyid = "part/with?query#fragment"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.EscapedPath() != "/keys/part%2Fwith%3Fquery%23fragment" {
			t.Errorf("request path = %q, want escaped keyid path", r.URL.EscapedPath())
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"publicKey": pemStr, "algorithm": "ed25519"})
	}))
	defer srv.Close()
	got, err := (TrustDirectoryResolver{BaseURLs: []string{srv.URL}, HTTPClient: srv.Client()}).Resolve(context.Background(), keyid)
	if err != nil || got == nil {
		t.Fatalf("escaped keyid resolution: key=%+v err=%v", got, err)
	}
}

func TestResolvedKeyLifecycle(t *testing.T) {
	now := time.Date(2026, time.August, 27, 12, 0, 0, 0, time.UTC)
	if !IsKeyRevoked(&ResolvedKey{Revoked: true}, now) {
		t.Fatal("revoked key was accepted")
	}
	if !IsKeyRevoked(&ResolvedKey{Expires: "2026-08-27T11:59:59Z"}, now) {
		t.Fatal("expired key was accepted")
	}
	if !IsKeyRevoked(&ResolvedKey{Expires: "not-a-timestamp"}, now) {
		t.Fatal("invalid expiry was accepted")
	}
	if IsKeyRevoked(&ResolvedKey{Expires: "2026-08-27T12:00:01Z"}, now) {
		t.Fatal("future expiry was rejected")
	}
}

type staticKeyResolver struct{ key *ResolvedKey }

func (r staticKeyResolver) Resolve(context.Context, string) (*ResolvedKey, error) {
	return r.key, nil
}

func TestVerifyEndorsementRejectsLifecycle(t *testing.T) {
	base := Endorsement{
		Endorser:    "did:web:example.test",
		Endorsement: "sha256:content",
		Signature:   "AAAA",
		Timestamp:   "2026-08-27T12:00:00Z",
		Algorithm:   "ed25519",
	}
	cases := []struct {
		name        string
		endorsement Endorsement
		key         *ResolvedKey
	}{
		{"revoked key", base, &ResolvedKey{Revoked: true}},
		{"expired key", base, &ResolvedKey{Expires: "2020-01-01T00:00:00Z"}},
		{"revoked endorsement", func() Endorsement { e := base; e.RevokedBy = "did:web:authority"; return e }(), &ResolvedKey{}},
		{"expired endorsement", func() Endorsement { e := base; e.Expires = "2020-01-01T00:00:00Z"; return e }(), &ResolvedKey{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ok, err := VerifyEndorsement(context.Background(), tc.endorsement, []KeyResolver{staticKeyResolver{key: tc.key}})
			if err != nil || ok {
				t.Fatalf("VerifyEndorsement = %v, %v; want false, nil", ok, err)
			}
		})
	}
}

// ----- ResolveKey -----

func TestExtractClaimsFromSignedSectionUsesDirectChildren(t *testing.T) {
	claims, err := ExtractClaimsFromSignedSection(`<signed-section><meta name="author" content=" Alice "><meta name="signed-at" content="2026-08-27T12:00:00Z"><div><meta name="author" content="Nested"></div></signed-section>`)
	if err != nil {
		t.Fatalf("ExtractClaimsFromSignedSection: %v", err)
	}
	if len(claims) != 2 || claims["author"] != "Alice" || claims["signed-at"] != "2026-08-27T12:00:00Z" {
		t.Fatalf("unexpected claims: %#v", claims)
	}
}

func TestExtractClaimsFromSignedSectionRejectsNormalizedDuplicate(t *testing.T) {
	_, err := ExtractClaimsFromSignedSection(`<meta name="author" content="A"><meta name=" author " content="B">`)
	if err == nil || !strings.Contains(err.Error(), "claim-duplicate") {
		t.Fatalf("expected claim-duplicate, got %v", err)
	}
}

func TestResolveKeyChain(t *testing.T) {
	pemStr, _, _ := newEd25519PEM(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"publicKey": pemStr,
			"algorithm": "ed25519",
		})
	}))
	defer srv.Close()

	resolvers := []KeyResolver{
		DidWebResolver{},
		DirectURLResolver{HTTPClient: srv.Client()},
	}
	got, err := ResolveKey(context.Background(), srv.URL+"/key.json", resolvers)
	if err != nil {
		t.Fatalf("ResolveKey: %v", err)
	}
	if got == nil || got.Algorithm != "ed25519" {
		t.Fatalf("unexpected key: %+v", got)
	}
}

func TestResolveKeyNoMatch(t *testing.T) {
	if _, err := ResolveKey(context.Background(), "did:fake:nope", []KeyResolver{DidWebResolver{}}); err == nil {
		t.Errorf("expected error when no resolver matches")
	}
}

// ----- VerifyEndorsement -----

func TestVerifyEndorsement(t *testing.T) {
	pemStr, _, priv := newEd25519PEM(t)

	endorsement := Endorsement{
		Endorser:    "", // filled in below once we know the URL
		Endorsement: "sha256:contenthash",
		Timestamp:   "2025-05-01T00:00:00Z",
		Algorithm:   "ed25519",
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"publicKey": pemStr,
			"algorithm": "ed25519",
		})
	}))
	defer srv.Close()
	endorsement.Endorser = srv.URL + "/key.json"

	msg, err := BuildEndorsementBinding(endorsement)
	if err != nil {
		t.Fatalf("BuildEndorsementBinding: %v", err)
	}
	sig := ed25519.Sign(priv, []byte(msg))
	endorsement.Signature = base64.RawStdEncoding.EncodeToString(sig)

	resolvers := []KeyResolver{DirectURLResolver{HTTPClient: srv.Client()}}
	ok, err := VerifyEndorsement(context.Background(), endorsement, resolvers)
	if err != nil {
		t.Fatalf("VerifyEndorsement: %v", err)
	}
	if !ok {
		t.Errorf("expected endorsement to verify")
	}

	// Tamper with the timestamp; should now fail.
	tampered := endorsement
	tampered.Timestamp = "2025-05-02T00:00:00Z"
	ok, _ = VerifyEndorsement(context.Background(), tampered, resolvers)
	if ok {
		t.Errorf("expected tampered endorsement to fail")
	}
}

func TestBuildEndorsementBindingIncludesOptionalAndExtensionFields(t *testing.T) {
	got, err := BuildEndorsementBinding(Endorsement{
		Endorser:    "https://example.org/keys/alice",
		Endorsement: "sha256:contenthash",
		Timestamp:   "2026-08-27T12:00:00Z",
		Algorithm:   "ed25519",
		Claim:       "reviewed",
		Expires:     "2027-08-27T12:00:00Z",
		Extensions: map[string]any{
			"z": map[string]any{"b": 2, "a": 1},
		},
	})
	if err != nil {
		t.Fatalf("BuildEndorsementBinding: %v", err)
	}
	want := `{"algorithm":"ed25519","claim":"reviewed","endorsement":"sha256:contenthash","endorser":"https://example.org/keys/alice","expires":"2027-08-27T12:00:00Z","timestamp":"2026-08-27T12:00:00Z","z":{"a":1,"b":2}}`
	if got != want {
		t.Fatalf("binding mismatch\nwant: %s\n got: %s", want, got)
	}
}

func TestCanonicalizeEndorsementDocumentRejectsDuplicateMembers(t *testing.T) {
	document := []byte(`{"endorser":"a","endorser":"b","endorsement":"sha256:x","algorithm":"ed25519","timestamp":"2026-08-27T12:00:00Z","signature":"x"}`)
	if _, err := CanonicalizeEndorsementDocument(document); err == nil || !strings.Contains(err.Error(), "jcs-duplicate-key") {
		t.Fatalf("expected jcs-duplicate-key, got %v", err)
	}
}

func TestVerifyEndorsementMissingFields(t *testing.T) {
	cases := []Endorsement{
		{Endorser: "", Endorsement: "x", Signature: "x", Timestamp: "x"},
		{Endorser: "x", Endorsement: "", Signature: "x", Timestamp: "x"},
		{Endorser: "x", Endorsement: "x", Signature: "", Timestamp: "x"},
		{Endorser: "x", Endorsement: "x", Signature: "x", Timestamp: ""},
		{Endorser: "x", Endorsement: "x", Signature: "x", Timestamp: "x", Algorithm: ""},
	}
	for i, c := range cases {
		if _, err := VerifyEndorsement(context.Background(), c, nil); err == nil {
			t.Errorf("case %d: expected error", i)
		}
	}
}

// ----- helpers -----

// rewriteTransport is a minimal RoundTripper that rewrites all incoming
// requests to point at `target` (host + scheme), preserving path and query.
// Used so DidWebResolver can be exercised without DNS gymnastics.
type rewriteTransport struct {
	base     http.RoundTripper
	target   string
	seenHost *string
}

func (t rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if t.seenHost != nil {
		*t.seenHost = req.URL.Host
	}
	// Build a new URL: target + original path + raw query.
	newURL := fmt.Sprintf("%s%s", strings.TrimRight(t.target, "/"), req.URL.EscapedPath())
	if req.URL.RawQuery != "" {
		newURL += "?" + req.URL.RawQuery
	}
	r2, err := http.NewRequestWithContext(req.Context(), req.Method, newURL, req.Body)
	if err != nil {
		return nil, err
	}
	r2.Header = req.Header.Clone()
	base := t.base
	if base == nil {
		base = http.DefaultTransport
	}
	return base.RoundTrip(r2)
}
