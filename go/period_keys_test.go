package canonicalize

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"testing"
	"time"
)

// ---- did-selection-v1.json: period-scoped did:web method selection ----

type didSelectionVector struct {
	Cases []didSelectionCase `json:"cases"`
}

type didSelectionCase struct {
	Name           string          `json:"name"`
	Kind           string          `json:"kind"`
	Keyid          string          `json:"keyid"`
	DidDocument    json.RawMessage `json:"didDocument"`
	DidDocumentRef string          `json:"didDocumentRef"`
	KeyDocument    json.RawMessage `json:"keyDocument"`
	Expected       struct {
		Outcome      string `json:"outcome"`
		MethodID     string `json:"methodId"`
		Period       *int   `json:"period"`
		Identity     string `json:"identity"`
		PublicKeyPem string `json:"publicKeyPem"`
		Revoked      *bool  `json:"revoked"`
	} `json:"expected"`
}

func loadDidSelectionVector(t *testing.T) didSelectionVector {
	t.Helper()
	raw, err := os.ReadFile("../conformance/vectors/did-selection-v1.json")
	if err != nil {
		t.Fatalf("read did-selection-v1.json: %v", err)
	}
	var v didSelectionVector
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parse did-selection-v1.json: %v", err)
	}
	return v
}

func findDidDocument(t *testing.T, v didSelectionVector, c didSelectionCase) json.RawMessage {
	t.Helper()
	if len(c.DidDocument) > 0 {
		return c.DidDocument
	}
	for _, ref := range v.Cases {
		if ref.Name == c.DidDocumentRef {
			return ref.DidDocument
		}
	}
	t.Fatalf("no such didDocumentRef: %s", c.DidDocumentRef)
	return nil
}

// jsonStubClient returns an *http.Client whose single expected URL responds
// with body.
func jsonStubClient(expectedURL string, body []byte) *http.Client {
	return &http.Client{Transport: bodyTransport{url: expectedURL, body: body}}
}

// bodyTransport routes exactly one URL to a canned JSON body; any other URL
// 404s.
type bodyTransport struct {
	url  string
	body []byte
}

func (b bodyTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.String() != b.url {
		return &http.Response{StatusCode: http.StatusNotFound, Body: http.NoBody, Header: make(http.Header), Request: req}, nil
	}
	header := make(http.Header)
	header.Set("Content-Type", "application/json")
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(bytes.NewReader(b.body)),
		Header:     header,
		Request:    req,
	}, nil
}

func TestDidSelectionVectors(t *testing.T) {
	v := loadDidSelectionVector(t)
	for _, c := range v.Cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			var resolved *ResolvedKey
			var err error
			switch c.Kind {
			case "", "did":
				doc := findDidDocument(t, v, c)
				resolver := &DidWebResolver{HTTPClient: jsonStubClient("https://example.com/.well-known/did.json", doc)}
				resolved, err = resolver.Resolve(context.Background(), c.Keyid)
			case "url":
				resolver := &DirectURLResolver{HTTPClient: jsonStubClient(c.Keyid, c.KeyDocument)}
				resolved, err = resolver.Resolve(context.Background(), c.Keyid)
			case "directory":
				base := "https://directory.example"
				requestURL := base + "/keys/" + url.PathEscape(c.Keyid)
				resolver := &TrustDirectoryResolver{BaseURLs: []string{base}, HTTPClient: jsonStubClient(requestURL, c.KeyDocument)}
				resolved, err = resolver.Resolve(context.Background(), c.Keyid)
			default:
				t.Fatalf("unknown vector case kind: %s", c.Kind)
			}

			switch c.Expected.Outcome {
			case "resolved":
				if err != nil {
					t.Fatalf("expected resolution, got error: %v", err)
				}
				if resolved == nil {
					t.Fatalf("expected a resolution for %s", c.Name)
				}
				if c.Expected.MethodID != "" && resolved.MethodID != c.Expected.MethodID {
					t.Errorf("methodId = %q, want %q", resolved.MethodID, c.Expected.MethodID)
				}
				if c.Expected.Period != nil && int(resolved.Period) != *c.Expected.Period {
					t.Errorf("period = %d, want %d", resolved.Period, *c.Expected.Period)
				}
				if c.Expected.Identity != "" && resolved.Identity != c.Expected.Identity {
					t.Errorf("identity = %q, want %q", resolved.Identity, c.Expected.Identity)
				}
				if c.Expected.PublicKeyPem != "" && resolved.PublicKeyPEM != c.Expected.PublicKeyPem {
					t.Errorf("publicKeyPem = %q, want %q", resolved.PublicKeyPEM, c.Expected.PublicKeyPem)
				}
				if c.Expected.Revoked != nil && resolved.Revoked != *c.Expected.Revoked {
					t.Errorf("revoked = %v, want %v", resolved.Revoked, *c.Expected.Revoked)
				}
			case "key-resolution-failed":
				if err != nil {
					t.Fatalf("expected a decline (nil, nil), got error: %v", err)
				}
				if resolved != nil {
					t.Fatalf("expected key-resolution-failed (nil), got %#v", resolved)
				}
			case "malformed-key-document":
				if !errors.Is(err, ErrMalformedKeyDocument) {
					t.Fatalf("expected ErrMalformedKeyDocument, got %v (resolved=%#v)", err, resolved)
				}
			default:
				t.Fatalf("unknown expected outcome: %s", c.Expected.Outcome)
			}
		})
	}
}

// ---- caching behavior (spec §9.10 step 8, §12.9/§13.4) ----

func TestDidWebResolverNegativeCachesUnresolvedFragment(t *testing.T) {
	v := loadDidSelectionVector(t)
	var docCase didSelectionCase
	for _, c := range v.Cases {
		if c.Name == "exact-fragment-p1" {
			docCase = c
		}
	}
	doc := findDidDocument(t, v, docCase)

	fetches := 0
	clock := time.Unix(1_700_000_000, 0)
	client := &http.Client{Transport: countingTransport{
		url:   "https://example.com/.well-known/did.json",
		body:  doc,
		count: &fetches,
	}}
	resolver := &DidWebResolver{HTTPClient: client, Now: func() time.Time { return clock }}

	first, err := resolver.Resolve(context.Background(), "did:web:example.com#p4")
	if err != nil || first != nil {
		t.Fatalf("expected p4 to be unpublished, got %#v, %v", first, err)
	}
	if fetches != 1 {
		t.Fatalf("expected exactly one fetch, got %d", fetches)
	}
	clock = clock.Add(30 * time.Second) // still within the 60s negative-cache window
	second, err := resolver.Resolve(context.Background(), "did:web:example.com#p4")
	if err != nil || second != nil {
		t.Fatalf("expected p4 to remain unpublished, got %#v, %v", second, err)
	}
	if fetches != 1 {
		t.Fatalf("a negative-cached fragment must not trigger a refetch within 60s, got %d fetches", fetches)
	}
}

func TestDidWebResolverRefetchesOnceWhenStale(t *testing.T) {
	v := loadDidSelectionVector(t)
	var docCase didSelectionCase
	for _, c := range v.Cases {
		if c.Name == "exact-fragment-p1" {
			docCase = c
		}
	}
	staleDoc := findDidDocument(t, v, docCase)
	var staleParsed map[string]any
	if err := json.Unmarshal(staleDoc, &staleParsed); err != nil {
		t.Fatal(err)
	}
	methods := staleParsed["verificationMethod"].([]any)
	rolledMethods := append(append([]any{}, methods...), map[string]any{
		"id": "#p4", "type": "Ed25519VerificationKey2020", "controller": "did:web:example.com",
		"publicKeyPem": "ROLLED-P4-PEM",
	})
	rolledParsed := map[string]any{"id": staleParsed["id"], "verificationMethod": rolledMethods}
	rolledDoc, err := json.Marshal(rolledParsed)
	if err != nil {
		t.Fatal(err)
	}

	fetches := 0
	clock := time.Unix(1_700_000_000, 0)
	client := &http.Client{Transport: sequenceTransport{
		url:    "https://example.com/.well-known/did.json",
		bodies: [][]byte{staleDoc, rolledDoc},
		count:  &fetches,
	}}
	resolver := &DidWebResolver{HTTPClient: client, Now: func() time.Time { return clock }}

	missing, err := resolver.Resolve(context.Background(), "did:web:example.com#p3")
	if err != nil || missing == nil {
		t.Fatalf("p3 should resolve from the first fetch: %#v, %v", missing, err)
	}
	if fetches != 1 {
		t.Fatalf("expected 1 fetch, got %d", fetches)
	}

	clock = clock.Add(61 * time.Second) // past the 60s floor
	rolled, err := resolver.Resolve(context.Background(), "did:web:example.com#p4")
	if err != nil || rolled == nil {
		t.Fatalf("a single bypass refetch should see the newly published #p4: %#v, %v", rolled, err)
	}
	if rolled.PublicKeyPEM != "ROLLED-P4-PEM" {
		t.Fatalf("publicKeyPem = %q, want ROLLED-P4-PEM", rolled.PublicKeyPEM)
	}
	if fetches != 2 {
		t.Fatalf("expected exactly one bypass refetch (2 total), got %d", fetches)
	}
}

type countingTransport struct {
	url   string
	body  []byte
	count *int
}

func (c countingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	*c.count++
	return bodyTransport{url: c.url, body: c.body}.RoundTrip(req)
}

type sequenceTransport struct {
	url    string
	bodies [][]byte
	count  *int
}

func (s sequenceTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	idx := *s.count
	if idx >= len(s.bodies) {
		idx = len(s.bodies) - 1
	}
	*s.count++
	return bodyTransport{url: s.url, body: s.bodies[idx]}.RoundTrip(req)
}

// ---- HKDF + Ed25519 period-key derivation (draft §9.10, Appendix A) ----

type periodKeysVector struct {
	MasterHex string `json:"masterHex"`
	Identity  string `json:"identity"`
	Salt      string `json:"salt"`
	Periods   []struct {
		Period               int    `json:"period"`
		SeedHex              string `json:"seedHex"`
		PublicKeySpkiB64     string `json:"publicKeySpkiBase64"`
		PublicKeyPem         string `json:"publicKeyPem"`
		SignatureTestMessage string `json:"signatureTestMessage"`
		SignatureB64         string `json:"signatureBase64"`
	} `json:"periods"`
}

// deriveEd25519PeriodKey implements spec §9.10's derivation: HKDF-SHA-256
// with salt "htmltrust-period-key-v1" and
// info = "ed25519" || 0x00 || identity || 0x00 || uint32be(N), producing a
// 32-byte seed used directly as the RFC 8032 Ed25519 private key seed.
func deriveEd25519PeriodKey(master []byte, identity string, period uint32) (ed25519.PrivateKey, error) {
	// Built as a raw byte slice, not fmt.Sprintf("%c", ...): a %c verb
	// UTF-8-encodes its argument, which corrupts any byte >= 0x80.
	info := make([]byte, 0, len("ed25519")+1+len(identity)+1+4)
	info = append(info, "ed25519"...)
	info = append(info, 0)
	info = append(info, identity...)
	info = append(info, 0)
	info = append(info, byte(period>>24), byte(period>>16), byte(period>>8), byte(period))
	seed, err := hkdf.Key(sha256.New, master, []byte("htmltrust-period-key-v1"), string(info), ed25519.SeedSize)
	if err != nil {
		return nil, err
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

func TestPeriodKeyDerivationReproducesVector(t *testing.T) {
	raw, err := os.ReadFile("../conformance/vectors/period-keys-v1.json")
	if err != nil {
		t.Fatalf("read period-keys-v1.json: %v", err)
	}
	var v periodKeysVector
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parse period-keys-v1.json: %v", err)
	}
	master, err := hex.DecodeString(v.MasterHex)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range v.Periods {
		sk, err := deriveEd25519PeriodKey(master, v.Identity, uint32(entry.Period))
		if err != nil {
			t.Fatalf("period %d: derive: %v", entry.Period, err)
		}
		seed := sk.Seed()
		if hex.EncodeToString(seed) != entry.SeedHex {
			t.Errorf("period %d: seed = %s, want %s", entry.Period, hex.EncodeToString(seed), entry.SeedHex)
		}
		pub := sk.Public().(ed25519.PublicKey)
		spkiDER, err := x509.MarshalPKIXPublicKey(pub)
		if err != nil {
			t.Fatalf("period %d: marshal SPKI: %v", entry.Period, err)
		}
		if got := EncodeBase64Unpadded(spkiDER); got != entry.PublicKeySpkiB64 {
			t.Errorf("period %d: public key = %s, want %s", entry.Period, got, entry.PublicKeySpkiB64)
		}
		if entry.SignatureB64 != "" {
			signature := ed25519.Sign(sk, []byte(entry.SignatureTestMessage))
			if got := EncodeBase64Unpadded(signature); got != entry.SignatureB64 {
				t.Errorf("period %d: signature = %s, want %s", entry.Period, got, entry.SignatureB64)
			}
			ok, err := VerifySignature(entry.SignatureTestMessage, entry.SignatureB64, entry.PublicKeyPem, "ed25519")
			if err != nil || !ok {
				t.Errorf("period %d: signature must verify under the derived public key (ok=%v err=%v)", entry.Period, ok, err)
			}
		}
	}
}

type periodSignatureVector struct {
	JcsPayload                      string `json:"jcsPayload"`
	Signature                       string `json:"signature"`
	SignatureFromPeriod2Mislabelled string `json:"signatureFromPeriod2Mislabelled"`
}

func TestPeriod3SignatureVerifiesOnlyUnderPeriod3Key(t *testing.T) {
	rawKeys, err := os.ReadFile("../conformance/vectors/period-keys-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var keys periodKeysVector
	if err := json.Unmarshal(rawKeys, &keys); err != nil {
		t.Fatal(err)
	}
	rawSig, err := os.ReadFile("../conformance/vectors/period-signature-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var sig periodSignatureVector
	if err := json.Unmarshal(rawSig, &sig); err != nil {
		t.Fatal(err)
	}
	var period2Pem, period3Pem string
	for _, entry := range keys.Periods {
		switch entry.Period {
		case 2:
			period2Pem = entry.PublicKeyPem
		case 3:
			period3Pem = entry.PublicKeyPem
		}
	}

	ok, err := VerifySignature(sig.JcsPayload, sig.Signature, period3Pem, "ed25519")
	if err != nil || !ok {
		t.Fatalf("the honest period-3 signature must verify under pk_3 (ok=%v err=%v)", ok, err)
	}
	ok, err = VerifySignature(sig.JcsPayload, sig.SignatureFromPeriod2Mislabelled, period3Pem, "ed25519")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("a period-2 signature relabelled as period-3 must not verify under pk_3")
	}
	ok, err = VerifySignature(sig.JcsPayload, sig.SignatureFromPeriod2Mislabelled, period2Pem, "ed25519")
	if err != nil || !ok {
		t.Fatalf("the same bytes must verify under the period-2 key that actually made them (ok=%v err=%v)", ok, err)
	}
}
