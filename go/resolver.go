package canonicalize

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// ResolvedKey is the result of a successful keyid resolution.
type ResolvedKey struct {
	PublicKeyPEM string
	Algorithm    string
	Keyid        string
}

// KeyResolver resolves a keyid to a public key. A resolver that does not apply
// to a particular keyid (e.g. a DID resolver handed an https URL) MUST return
// (nil, nil) so the next resolver in the chain is tried.
type KeyResolver interface {
	Resolve(ctx context.Context, keyid string) (*ResolvedKey, error)
}

// ResolveKey walks the supplied resolver chain in order and returns the first
// non-nil ResolvedKey. If every resolver declines, an error is returned.
func ResolveKey(ctx context.Context, keyid string, resolvers []KeyResolver) (*ResolvedKey, error) {
	if keyid == "" {
		return nil, errors.New("ResolveKey: keyid is required")
	}
	for _, r := range resolvers {
		key, err := r.Resolve(ctx, keyid)
		if err != nil {
			return nil, err
		}
		if key != nil {
			return key, nil
		}
	}
	return nil, fmt.Errorf("ResolveKey: no resolver matched keyid %q", keyid)
}

func httpClient(c *http.Client) *http.Client {
	if c != nil {
		return c
	}
	return http.DefaultClient
}

// ----- did:web -----

// DidWebResolver resolves did:web:<domain>[:<path>...] keyids by fetching the
// DID document at https://<domain>/.well-known/did.json and returning the
// first verificationMethod entry that contains a publicKeyPem field.
type DidWebResolver struct {
	HTTPClient *http.Client
}

type didDocument struct {
	VerificationMethod []verificationMethod `json:"verificationMethod"`
}

type verificationMethod struct {
	ID           string `json:"id"`
	Type         string `json:"type"`
	PublicKeyPem string `json:"publicKeyPem"`
	Algorithm    string `json:"algorithm"`
}

// Resolve implements KeyResolver.
func (r DidWebResolver) Resolve(ctx context.Context, keyid string) (*ResolvedKey, error) {
	if !strings.HasPrefix(keyid, "did:web:") {
		return nil, nil
	}
	rest := strings.TrimPrefix(keyid, "did:web:")
	// did:web allows ":" as path separators after the domain.
	parts := strings.Split(rest, ":")
	domain := parts[0]
	if domain == "" {
		return nil, fmt.Errorf("DidWebResolver: empty domain in keyid %q", keyid)
	}
	url := "https://" + domain + "/.well-known/did.json"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := httpClient(r.HTTPClient).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("DidWebResolver: GET %s: status %d", url, resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var doc didDocument
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, fmt.Errorf("DidWebResolver: decode did.json: %w", err)
	}
	for _, vm := range doc.VerificationMethod {
		if vm.PublicKeyPem != "" {
			alg := vm.Algorithm
			if alg == "" {
				alg = inferAlgorithmFromType(vm.Type)
			}
			return &ResolvedKey{
				PublicKeyPEM: vm.PublicKeyPem,
				Algorithm:    alg,
				Keyid:        keyid,
			}, nil
		}
	}
	return nil, fmt.Errorf("DidWebResolver: no verificationMethod with publicKeyPem in %s", url)
}

func inferAlgorithmFromType(t string) string {
	low := strings.ToLower(t)
	switch {
	case strings.Contains(low, "ed25519"):
		return "ed25519"
	case strings.Contains(low, "ecdsa"), strings.Contains(low, "secp"), strings.Contains(low, "p256"):
		return "ecdsa"
	case strings.Contains(low, "rsa"):
		return "rsa"
	default:
		return ""
	}
}

// ----- direct URL -----

// DirectURLResolver fetches a public key from an https://... or http://...
// keyid. The endpoint MAY return JSON (`{"publicKey": "...", "algorithm":
// "..."}`) or a raw PEM document (Content-Type: text/plain or
// application/x-pem-file).
type DirectURLResolver struct {
	HTTPClient *http.Client
}

type directKeyDoc struct {
	PublicKey string `json:"publicKey"`
	Algorithm string `json:"algorithm"`
}

func (r DirectURLResolver) Resolve(ctx context.Context, keyid string) (*ResolvedKey, error) {
	if !(strings.HasPrefix(keyid, "https://") || strings.HasPrefix(keyid, "http://")) {
		return nil, nil
	}
	return fetchKey(ctx, httpClient(r.HTTPClient), keyid, keyid)
}

// ----- trust directory -----

// TrustDirectoryResolver tries each base URL in turn, fetching
// {base}/keys/{keyid}. The first base URL that returns a 200 response wins.
type TrustDirectoryResolver struct {
	BaseURLs   []string
	HTTPClient *http.Client
}

func (r TrustDirectoryResolver) Resolve(ctx context.Context, keyid string) (*ResolvedKey, error) {
	if len(r.BaseURLs) == 0 {
		return nil, nil
	}
	var lastErr error
	for _, base := range r.BaseURLs {
		url := strings.TrimRight(base, "/") + "/keys/" + keyid
		key, err := fetchKey(ctx, httpClient(r.HTTPClient), url, keyid)
		if err == nil && key != nil {
			return key, nil
		}
		lastErr = err
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, nil
}

// fetchKey GETs `url` and parses either JSON ({publicKey, algorithm}) or a raw
// PEM document into a ResolvedKey. The keyid is recorded on the result.
func fetchKey(ctx context.Context, client *http.Client, url, keyid string) (*ResolvedKey, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetchKey: GET %s: status %d", url, resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	if strings.Contains(ct, "text/plain") || strings.Contains(ct, "application/x-pem-file") {
		return &ResolvedKey{
			PublicKeyPEM: string(body),
			Algorithm:    "",
			Keyid:        keyid,
		}, nil
	}
	var doc directKeyDoc
	if err := json.Unmarshal(body, &doc); err != nil {
		// As a fallback, treat the body as a PEM document.
		if strings.Contains(string(body), "-----BEGIN") {
			return &ResolvedKey{
				PublicKeyPEM: string(body),
				Algorithm:    "",
				Keyid:        keyid,
			}, nil
		}
		return nil, fmt.Errorf("fetchKey: decode %s: %w", url, err)
	}
	if doc.PublicKey == "" {
		return nil, fmt.Errorf("fetchKey: %s: missing publicKey field", url)
	}
	return &ResolvedKey{
		PublicKeyPEM: doc.PublicKey,
		Algorithm:    doc.Algorithm,
		Keyid:        keyid,
	}, nil
}
