package canonicalize

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const maxRemoteKeyBytes = 64 * 1024

var rfc3339UTC = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$`)

// ResolvedKey is the result of a successful keyid resolution.
type ResolvedKey struct {
	PublicKeyPEM string `json:"publicKeyPem"`
	Algorithm    string `json:"algorithm"`
	Keyid        string `json:"keyid"`
	// Revoked and Expires are optional lifecycle fields from the key document.
	// A revoked key or an expired key MUST NOT be used for verification.
	Revoked bool   `json:"revoked,omitempty"`
	Expires string `json:"expires,omitempty"`
}

// IsKeyRevoked reports whether a resolved key is revoked or expired. An
// unparseable non-empty expiry is treated as revoked so malformed lifecycle
// metadata cannot keep a key usable. The optional now argument is useful for
// deterministic tests.
func IsKeyRevoked(key *ResolvedKey, now ...time.Time) bool {
	if key == nil {
		return false
	}
	if key.Revoked {
		return true
	}
	if key.Expires == "" {
		return false
	}
	when := time.Now()
	if len(now) > 0 {
		when = now[0]
	}
	expires, valid := parseRFC3339UTC(key.Expires)
	return !valid || !expires.After(when)
}

// parseRFC3339UTC accepts the v1 lifecycle timestamp form: a valid RFC3339
// date-time in UTC, with optional fractional seconds. Go's general RFC3339
// parser also accepts numeric offsets, so the shape is checked first.
func parseRFC3339UTC(value string) (time.Time, bool) {
	if !rfc3339UTC.MatchString(value) {
		return time.Time{}, false
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, false
	}
	return parsed, true
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

// DidWebResolver resolves did:web:<domain>[:<path>...] keyids. A bare domain
// fetches https://<domain>/.well-known/did.json; a path DID fetches
// https://<domain>/<path>/did.json. It returns the first currently usable
// verificationMethod entry that contains a publicKeyPem field.
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
	Revoked      bool   `json:"revoked"`
	Expires      string `json:"expires"`
}

// Resolve implements KeyResolver.
func (r DidWebResolver) Resolve(ctx context.Context, keyid string) (*ResolvedKey, error) {
	if !strings.HasPrefix(keyid, "did:web:") {
		return nil, nil
	}
	rest := strings.TrimPrefix(keyid, "did:web:")
	// A DID URL fragment identifies a resource in the DID document. It is
	// never part of the URL used to retrieve that document.
	if suffix := strings.IndexAny(rest, "/?#"); suffix >= 0 {
		rest = rest[:suffix]
	}
	// did:web allows ":" as path separators after the domain. A bare host
	// uses the well-known location; a path DID document uses /<path>/did.json.
	parts := strings.Split(rest, ":")
	domain := parts[0]
	if domain == "" {
		return nil, fmt.Errorf("DidWebResolver: empty domain in keyid %q", keyid)
	}
	documentURL, err := didWebDocumentURL(domain, parts[1:])
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, documentURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := httpClient(r.HTTPClient).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("DidWebResolver: GET %s: status %d", documentURL, resp.StatusCode)
	}
	body, err := readRemoteKeyBody(resp.Body)
	if err != nil {
		return nil, err
	}
	if !utf8.Valid(body) {
		return nil, fmt.Errorf("DidWebResolver: invalid UTF-8 response")
	}
	var doc didDocument
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, fmt.Errorf("DidWebResolver: decode did.json: %w", err)
	}
	for _, vm := range doc.VerificationMethod {
		resolved := &ResolvedKey{
			PublicKeyPEM: vm.PublicKeyPem,
			Algorithm:    vm.Algorithm,
			Keyid:        keyid,
			Revoked:      vm.Revoked,
			Expires:      vm.Expires,
		}
		// DID resolution skips unusable verification methods. Preserve the
		// lifecycle values on usable methods so a later verification cannot
		// race an expiry without checking it again.
		if vm.PublicKeyPem != "" && !IsKeyRevoked(resolved) {
			alg := vm.Algorithm
			if alg == "" {
				alg = inferAlgorithmFromType(vm.Type)
			}
			resolved.Algorithm = alg
			return resolved, nil
		}
	}
	// A DID document with no currently usable verification method declines,
	// matching the JavaScript resolver and allowing a resolver chain to try
	// another source.
	return nil, nil
}

// readRemoteKeyBody reads at most one byte beyond the v1 key-document limit.
// The extra byte lets callers distinguish an exactly-at-limit response from
// an oversized response without ever allocating or buffering an unbounded
// response body.
func readRemoteKeyBody(body io.Reader) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(body, maxRemoteKeyBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxRemoteKeyBytes {
		return nil, fmt.Errorf("resource-limit-exceeded")
	}
	return data, nil
}

func didWebDocumentURL(domain string, pathParts []string) (string, error) {
	// Keep the authority separate from the path so key material cannot inject
	// a query, fragment, credentials, or an alternate host.
	// did:web encodes the authority port colon as %3A so it cannot be
	// confused with the colon-delimited path segments.
	authorityDomain := strings.NewReplacer("%3A", ":", "%3a", ":").Replace(domain)
	if strings.Contains(authorityDomain, "%") {
		return "", fmt.Errorf("DidWebResolver: invalid domain %q", domain)
	}
	authority, err := url.Parse("https://" + authorityDomain)
	if err != nil || authority.Host != authorityDomain || authority.User != nil || authority.Path != "" || authority.RawQuery != "" || authority.Fragment != "" {
		return "", fmt.Errorf("DidWebResolver: invalid domain %q", domain)
	}
	u := &url.URL{Scheme: "https", Host: authorityDomain}
	if len(pathParts) == 0 {
		u.Path = "/.well-known/did.json"
		return u.String(), nil
	}
	escaped := make([]string, len(pathParts))
	for i, part := range pathParts {
		var err error
		escaped[i], err = escapeDidWebPathPart(part)
		if err != nil {
			return "", err
		}
	}
	rawPath := "/" + strings.Join(escaped, "/") + "/did.json"
	path, err := url.PathUnescape(rawPath)
	if err != nil {
		return "", fmt.Errorf("DidWebResolver: invalid path in domain %q", domain)
	}
	u.Path = path
	u.RawPath = rawPath
	return u.String(), nil
}

func escapeDidWebPathPart(part string) (string, error) {
	if part == "" {
		return "", fmt.Errorf("DidWebResolver: invalid empty path segment")
	}
	var escaped strings.Builder
	for offset := 0; offset < len(part); {
		if part[offset] == '%' {
			if offset+2 >= len(part) || !isHexByte(part[offset+1]) || !isHexByte(part[offset+2]) {
				return "", fmt.Errorf("DidWebResolver: invalid path escape")
			}
			escaped.WriteString(part[offset : offset+3])
			offset += 3
			continue
		}
		next := strings.IndexByte(part[offset:], '%')
		if next < 0 {
			next = len(part) - offset
		}
		escaped.WriteString(url.PathEscape(part[offset : offset+next]))
		offset += next
	}
	return escaped.String(), nil
}

func isHexByte(value byte) bool {
	return value >= '0' && value <= '9' || value >= 'a' && value <= 'f' || value >= 'A' && value <= 'F'
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
	PublicKey    string  `json:"publicKey"`
	PublicKeyPEM string  `json:"publicKeyPem"`
	Key          string  `json:"key"`
	Algorithm    string  `json:"algorithm"`
	Revoked      *bool   `json:"revoked"`
	Expires      *string `json:"expires"`
}

func (r DirectURLResolver) Resolve(ctx context.Context, keyid string) (*ResolvedKey, error) {
	requestURL, err := url.Parse(keyid)
	if err != nil || requestURL.Host == "" || !(strings.EqualFold(requestURL.Scheme, "https") || strings.EqualFold(requestURL.Scheme, "http")) {
		return nil, nil
	}
	requestURL.Scheme = strings.ToLower(requestURL.Scheme)
	return fetchKey(ctx, httpClient(r.HTTPClient), requestURL.String(), keyid)
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
		requestURL, err := directoryKeyURL(base, keyid)
		if err != nil {
			lastErr = err
			continue
		}
		key, err := fetchKey(ctx, httpClient(r.HTTPClient), requestURL, keyid)
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

func directoryKeyURL(base, keyid string) (string, error) {
	u, err := url.Parse(base)
	if err != nil || u.Scheme == "" || u.Host == "" || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("TrustDirectoryResolver: invalid base URL %q", base)
	}
	basePath := strings.TrimRight(u.EscapedPath(), "/")
	rawPath := basePath + "/keys/" + url.PathEscape(keyid)
	path, err := url.PathUnescape(rawPath)
	if err != nil {
		return "", fmt.Errorf("TrustDirectoryResolver: invalid keyid")
	}
	u.Path = path
	u.RawPath = rawPath
	return u.String(), nil
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
	body, err := readRemoteKeyBody(resp.Body)
	if err != nil {
		return nil, err
	}
	if !utf8.Valid(body) {
		return nil, fmt.Errorf("fetchKey: invalid UTF-8 response")
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
	publicKey := doc.PublicKey
	if publicKey == "" {
		publicKey = doc.PublicKeyPEM
	}
	if publicKey == "" {
		publicKey = doc.Key
	}
	if publicKey == "" {
		return nil, fmt.Errorf("fetchKey: %s: missing publicKey field", url)
	}
	return &ResolvedKey{
		PublicKeyPEM: publicKey,
		Algorithm:    doc.Algorithm,
		Keyid:        keyid,
		Revoked:      doc.Revoked != nil && *doc.Revoked,
		Expires:      optionalString(doc.Expires),
	}, nil
}

func optionalString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
