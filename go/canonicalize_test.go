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
		{"Low-9 quotes → straight", "‚German“", "\"German\"", true},
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
			want: "Hello World",
		},
		{
			name: "inline elements do not introduce spaces",
			in:   "<p>hello <em>world</em></p>",
			want: "hello world",
		},
		{
			name: "scripts and styles dropped with content",
			in:   "<p>before</p><script>alert('x')</script><style>p{}</style><p>after</p>",
			want: "before after",
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
			want: "line1 line2",
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

// ----- CanonicalizeClaims -----

func TestCanonicalizeClaims(t *testing.T) {
	got := CanonicalizeClaims(map[string]string{
		"signed-at": "2025-01-01T00:00:00Z",
		"author":    "alice",
		"domain":    "example.com",
	})
	want := "author=alice\ndomain=example.com\nsigned-at=2025-01-01T00:00:00Z"
	if got != want {
		t.Errorf("CanonicalizeClaims = %q, want %q", got, want)
	}
}

func TestCanonicalizeClaimsNormalizesValues(t *testing.T) {
	got := CanonicalizeClaims(map[string]string{
		"title": "“Hello”",
	})
	want := `title="Hello"`
	if got != want {
		t.Errorf("CanonicalizeClaims = %q, want %q", got, want)
	}
}

// ----- BuildSignatureBinding -----

func TestBuildSignatureBinding(t *testing.T) {
	got, err := BuildSignatureBinding("sha256:abc", "sha256:def", "example.com", "2025-01-01T00:00:00Z")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := "sha256:abc:sha256:def:example.com:2025-01-01T00:00:00Z"
	if got != want {
		t.Errorf("BuildSignatureBinding = %q, want %q", got, want)
	}
}

func TestBuildSignatureBindingErrors(t *testing.T) {
	cases := [][]string{
		{"", "b", "c", "d"},
		{"a", "", "c", "d"},
		{"a", "b", "", "d"},
		{"a", "b", "c", ""},
	}
	for _, c := range cases {
		if _, err := BuildSignatureBinding(c[0], c[1], c[2], c[3]); err == nil {
			t.Errorf("expected error for inputs %v", c)
		}
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

	ok, err := VerifySignature(msg, base64.StdEncoding.EncodeToString(sig), pemStr, "ed25519")
	if err != nil {
		t.Fatalf("VerifySignature returned error: %v", err)
	}
	if !ok {
		t.Errorf("expected ed25519 signature to verify")
	}

	// Unpadded base64 should also work.
	ok, err = VerifySignature(msg, base64.RawStdEncoding.EncodeToString(sig), pemStr, "ED25519")
	if err != nil {
		t.Fatalf("VerifySignature(raw) returned error: %v", err)
	}
	if !ok {
		t.Errorf("expected ed25519 signature to verify with unpadded base64 + uppercase algo")
	}

	// Tampered message must fail.
	ok, _ = VerifySignature("tampered", base64.StdEncoding.EncodeToString(sig), pemStr, "ed25519")
	if ok {
		t.Errorf("expected tampered ed25519 signature to fail")
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
	ok, err := VerifySignature(msg, base64.StdEncoding.EncodeToString(sig), pemStr, "RSA")
	if err != nil {
		t.Fatalf("VerifySignature returned error: %v", err)
	}
	if !ok {
		t.Errorf("expected rsa signature to verify")
	}

	ok, _ = VerifySignature("tampered", base64.StdEncoding.EncodeToString(sig), pemStr, "rsa")
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
	ok, err := VerifySignature(msg, base64.StdEncoding.EncodeToString(sigBytes), pemStr, "ecdsa")
	if err != nil {
		t.Fatalf("VerifySignature returned error: %v", err)
	}
	if !ok {
		t.Errorf("expected ecdsa signature to verify")
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
		_ = json.NewEncoder(w).Encode(map[string]string{
			"publicKey": pemStr,
			"algorithm": "ed25519",
		})
	}))
	defer srv.Close()

	r := DirectURLResolver{HTTPClient: srv.Client()}
	got, err := r.Resolve(context.Background(), srv.URL+"/key.json")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got == nil || got.Algorithm != "ed25519" {
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

// ----- ResolveKey -----

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

	msg := endorsement.Endorsement + ":" + endorsement.Timestamp
	sig := ed25519.Sign(priv, []byte(msg))
	endorsement.Signature = base64.StdEncoding.EncodeToString(sig)

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

func TestVerifyEndorsementMissingFields(t *testing.T) {
	cases := []Endorsement{
		{Endorser: "", Endorsement: "x", Signature: "x", Timestamp: "x"},
		{Endorser: "x", Endorsement: "", Signature: "x", Timestamp: "x"},
		{Endorser: "x", Endorsement: "x", Signature: "", Timestamp: "x"},
		{Endorser: "x", Endorsement: "x", Signature: "x", Timestamp: ""},
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
	base   http.RoundTripper
	target string
}

func (t rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	// Build a new URL: target + original path + raw query.
	newURL := fmt.Sprintf("%s%s", strings.TrimRight(t.target, "/"), req.URL.Path)
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
