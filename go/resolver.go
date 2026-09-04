package canonicalize

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
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
	// Period is the period index (spec §9.10); 0 when Keyid has no period
	// fragment, or the resolved key document has no "period" member.
	Period uint32 `json:"period"`
	// Identity is the DID with no fragment, the key document's "identity",
	// or Keyid itself for a non-period URL key (spec §9.10).
	Identity string `json:"identity"`
	// MethodID is the expanded id of the selected DID verification method,
	// or Keyid for a URL-form key (spec §9.10).
	MethodID string `json:"methodId"`
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

// ----- period-scoped key selection (spec §9.10) -----

// ErrMalformedKeyDocument is returned when a fetched key document violates
// its shape (spec §9.10): duplicate verificationMethod ids, a selected
// method missing publicKeyPem, or invalid period/identity/kid members on a
// URL-form key document. A verifier MUST NOT fall through to another entry
// or another resolver on this error; callers of TrustDirectoryResolver in
// particular MUST propagate it rather than try the next base URL.
var ErrMalformedKeyDocument = errors.New("malformed-key-document")

const maxPeriod = 2147483647

// Period fragment grammar (spec §9.10): "p" followed by a decimal integer,
// no sign, no leading zero, value 1 through 2147483647. Index 0 is reserved
// and never appears in a fragment.
var periodFragmentRe = regexp.MustCompile(`^p([1-9][0-9]{0,9})$`)

// parsePeriodFragment parses a DID URL fragment as a period index. The
// second return is false for the empty string, a non-matching fragment, or
// a value out of range.
func parsePeriodFragment(fragment string) (uint32, bool) {
	m := periodFragmentRe.FindStringSubmatch(fragment)
	if m == nil {
		return 0, false
	}
	value, err := strconv.ParseUint(m[1], 10, 64)
	if err != nil || value > maxPeriod {
		return 0, false
	}
	return uint32(value), true
}

func splitDidFragment(keyid string) (did, fragment string) {
	if idx := strings.IndexByte(keyid, '#'); idx >= 0 {
		return keyid[:idx], keyid[idx+1:]
	}
	return keyid, ""
}

// expandMethodID expands a relative "#fragment" verificationMethod id
// against the document id. The second return is false when id is empty.
func expandMethodID(id, docID string) (string, bool) {
	if id == "" {
		return "", false
	}
	if strings.HasPrefix(id, "#") {
		return docID + id, true
	}
	return id, true
}

func methodFragmentOf(expandedID string) string {
	if idx := strings.IndexByte(expandedID, '#'); idx >= 0 {
		return expandedID[idx+1:]
	}
	return ""
}

// Spec §12.9/§13.4: DID documents and key documents follow HTTP cache
// semantics with a floor of 60 seconds and a ceiling of 3600 seconds
// regardless of headers. Absent an explicit max-age, key documents are
// cached for the recommended ceiling (one hour).
const (
	documentCacheFloor   = 60 * time.Second
	documentCacheCeiling = 3600 * time.Second
	negativeCacheTTL     = 60 * time.Second
)

// cachedResponse is one document cache entry: the raw response body, so
// both JSON and raw-text responses can be re-parsed cheaply on a cache hit.
type cachedResponse struct {
	body      []byte
	isText    bool // true for a non-JSON (raw PEM/text) response
	fetchedAt time.Time
	ttl       time.Duration
}

// documentCache is a per-resolver cache of fetched documents with a
// floor/ceiling TTL (spec §12.9, §13.4). Safe for concurrent use.
type documentCache struct {
	mu   sync.Mutex
	now  func() time.Time
	docs map[string]cachedResponse
}

func newDocumentCache(now func() time.Time) *documentCache {
	if now == nil {
		now = time.Now
	}
	return &documentCache{now: now, docs: make(map[string]cachedResponse)}
}

// load serves a fresh fetch within TTL from cache; bypassCache forces a
// fetch regardless of freshness (used for the single refetch of spec §9.10
// step 8).
func (c *documentCache) load(ctx context.Context, client *http.Client, requestURL string, bypassCache bool) (cachedResponse, error) {
	now := c.now()
	if !bypassCache {
		c.mu.Lock()
		cached, ok := c.docs[requestURL]
		c.mu.Unlock()
		if ok && now.Sub(cached.fetchedAt) < cached.ttl {
			return cached, nil
		}
	}
	body, isText, ttl, err := fetchRemoteDocument(ctx, client, requestURL)
	if err != nil {
		return cachedResponse{}, err
	}
	entry := cachedResponse{body: body, isText: isText, fetchedAt: now, ttl: ttl}
	c.mu.Lock()
	c.docs[requestURL] = entry
	c.mu.Unlock()
	return entry, nil
}

// negativeCache remembers (document URL, fragment) pairs that resolved to no
// method, for spec §9.10 step 8, so a page carrying many unknown fragments
// cannot force repeated fetches.
type negativeCache struct {
	mu      sync.Mutex
	now     func() time.Time
	entries map[string]time.Time
}

func (c *negativeCache) hit(key string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	expiresAt, ok := c.entries[key]
	return ok && c.now().Before(expiresAt)
}

func (c *negativeCache) set(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = c.now().Add(negativeCacheTTL)
}

// fetchRemoteDocument fetches requestURL and returns its raw body, whether
// it looks like raw text/PEM rather than JSON, and the clamped cache TTL
// for the response. A non-2xx status or an oversized/malformed body is a
// hard error, matching this package's pre-existing fetch-failure
// convention (a resolver declines by returning nil, nil; it does not treat
// an HTTP error as a decline).
func fetchRemoteDocument(ctx context.Context, client *http.Client, requestURL string) (body []byte, isText bool, ttl time.Duration, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return nil, false, 0, err
	}
	resp, err := httpClient(client).Do(req)
	if err != nil {
		return nil, false, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, false, 0, fmt.Errorf("GET %s: status %d", requestURL, resp.StatusCode)
	}
	data, err := readRemoteKeyBody(resp.Body)
	if err != nil {
		return nil, false, 0, err
	}
	if !utf8.Valid(data) {
		return nil, false, 0, fmt.Errorf("GET %s: invalid UTF-8 response", requestURL)
	}
	seconds, present := parseMaxAgeSeconds(resp.Header.Get("Cache-Control"))
	ttl = clampDocumentTTL(seconds, present)
	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	isText = strings.Contains(ct, "text/plain") || strings.Contains(ct, "application/x-pem-file")
	return data, isText, ttl, nil
}

func parseMaxAgeSeconds(cacheControl string) (seconds int64, present bool) {
	for _, directive := range strings.Split(cacheControl, ",") {
		directive = strings.TrimSpace(directive)
		const prefix = "max-age="
		if len(directive) > len(prefix) && strings.EqualFold(directive[:len(prefix)], prefix) {
			value, err := strconv.ParseInt(directive[len(prefix):], 10, 64)
			if err == nil && value >= 0 {
				return value, true
			}
		}
	}
	return 0, false
}

func clampDocumentTTL(seconds int64, present bool) time.Duration {
	if !present {
		return documentCacheCeiling
	}
	ttl := time.Duration(seconds) * time.Second
	if ttl < documentCacheFloor {
		return documentCacheFloor
	}
	if ttl > documentCacheCeiling {
		return documentCacheCeiling
	}
	return ttl
}

// ----- did:web -----

// DidWebResolver resolves did:web:<domain>[:<path>...][#fragment] keyids
// per spec §9.10's verifier algorithm (steps 1-4). A bare domain fetches
// https://<domain>/.well-known/did.json; a path DID fetches
// https://<domain>/<path>/did.json.
//
// A non-empty fragment matching the period grammar (#p<N>) or naming any
// other verification method selects that single entry by exact expanded
// id, with no fallback. A bare keyid (no fragment) selects the first entry
// whose fragment is not a period fragment (the anchor); assertionMethod is
// never consulted. Revoked or expired entries are still returned, with
// their lifecycle fields, so the caller can report "key-revoked"; Resolve
// never falls through to another entry. The DID document and per-fragment
// "not found" outcomes are cached per spec §9.10 step 8.
//
// DidWebResolver holds cache state and MUST be used by pointer: a value
// DidWebResolver{} no longer satisfies KeyResolver, only &DidWebResolver{}
// does. The zero value (aside from that pointer requirement) is ready to
// use; cache state initializes lazily on first Resolve.
type DidWebResolver struct {
	HTTPClient *http.Client
	// Now overrides time.Now for the document/negative cache. Nil uses
	// time.Now; set only for deterministic tests.
	Now func() time.Time

	initOnce sync.Once
	docs     *documentCache
	neg      *negativeCache
}

func (r *DidWebResolver) init() {
	r.initOnce.Do(func() {
		nowFn := r.Now
		if nowFn == nil {
			nowFn = time.Now
		}
		r.docs = newDocumentCache(nowFn)
		r.neg = &negativeCache{now: nowFn, entries: make(map[string]time.Time)}
	})
}

type didDocument struct {
	ID                 string               `json:"id"`
	Deactivated        bool                 `json:"deactivated"`
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

// selectedDidMethod pairs a chosen verificationMethod with its expanded id.
type selectedDidMethod struct {
	method   verificationMethod
	methodID string
}

// selectDidMethod implements spec §9.10 steps 2 (the document-wide
// duplicate-id check) and 3 (selection).
func selectDidMethod(doc *didDocument, didPart, fragment string) (*selectedDidMethod, error) {
	seen := make(map[string]struct{}, len(doc.VerificationMethod))
	for _, m := range doc.VerificationMethod {
		id, ok := expandMethodID(m.ID, doc.ID)
		if !ok {
			continue
		}
		if _, dup := seen[id]; dup {
			return nil, ErrMalformedKeyDocument
		}
		seen[id] = struct{}{}
	}
	if fragment != "" {
		// Period or anchor kind: the single entry whose expanded id equals
		// the whole keyid. No fallback of any kind.
		target := didPart + "#" + fragment
		for _, m := range doc.VerificationMethod {
			id, ok := expandMethodID(m.ID, doc.ID)
			if ok && id == target {
				return &selectedDidMethod{method: m, methodID: target}, nil
			}
		}
		return nil, nil
	}
	// Bare kind: the first entry in array order whose fragment is not a
	// period fragment. assertionMethod is never consulted.
	for _, m := range doc.VerificationMethod {
		id, ok := expandMethodID(m.ID, doc.ID)
		if !ok {
			continue
		}
		if _, isPeriod := parsePeriodFragment(methodFragmentOf(id)); !isPeriod {
			return &selectedDidMethod{method: m, methodID: id}, nil
		}
	}
	return nil, nil
}

// Resolve implements KeyResolver.
func (r *DidWebResolver) Resolve(ctx context.Context, keyid string) (*ResolvedKey, error) {
	if !strings.HasPrefix(keyid, "did:web:") {
		return nil, nil
	}
	r.init()

	didPart, fragment := splitDidFragment(keyid)
	// Spec §9.10 step 1: a fragment containing '#', '/', or '?' fails.
	if strings.ContainsAny(fragment, "#/?") {
		return nil, nil
	}
	period, _ := parsePeriodFragment(fragment)

	rest := strings.TrimPrefix(didPart, "did:web:")
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

	loadDoc := func(bypass bool) (*didDocument, cachedResponse, error) {
		entry, loadErr := r.docs.load(ctx, r.HTTPClient, documentURL, bypass)
		if loadErr != nil {
			return nil, cachedResponse{}, loadErr
		}
		if entry.isText {
			return nil, entry, nil
		}
		var doc didDocument
		if decodeErr := json.Unmarshal(entry.body, &doc); decodeErr != nil {
			return nil, entry, fmt.Errorf("DidWebResolver: decode did.json: %w", decodeErr)
		}
		return &doc, entry, nil
	}

	doc, entry, err := loadDoc(false)
	if err != nil {
		return nil, err
	}
	if doc == nil {
		// A non-JSON response is not a usable DID document.
		return nil, nil
	}
	if doc.Deactivated {
		return nil, nil
	}
	if doc.ID == "" || doc.ID != didPart {
		return nil, nil
	}

	selection, err := selectDidMethod(doc, didPart, fragment)
	if err != nil {
		return nil, err
	}
	if selection == nil {
		negKey := documentURL + "\x00" + fragment
		if r.neg.hit(negKey) {
			return nil, nil
		}
		// Spec §9.10 step 8: when the cached copy is older than 60 seconds,
		// refetch once bypassing the cache before failing.
		if r.docs.now().Sub(entry.fetchedAt) >= documentCacheFloor {
			freshDoc, freshEntry, fetchErr := loadDoc(true)
			if fetchErr != nil {
				return nil, fetchErr
			}
			if freshDoc != nil {
				if freshDoc.Deactivated {
					return nil, nil
				}
				if freshDoc.ID == "" || freshDoc.ID != didPart {
					return nil, nil
				}
				doc, entry = freshDoc, freshEntry
				selection, err = selectDidMethod(doc, didPart, fragment)
				if err != nil {
					return nil, err
				}
			}
		}
		if selection == nil {
			r.neg.set(negKey)
			return nil, nil
		}
	}

	method := selection.method
	// Spec §9.10 step 4: publicKeyPem MUST be present, else malformed.
	// There is no fall-through to another entry.
	if method.PublicKeyPem == "" {
		return nil, ErrMalformedKeyDocument
	}
	alg := method.Algorithm
	if alg == "" {
		alg = inferAlgorithmFromType(method.Type)
	}
	return &ResolvedKey{
		PublicKeyPEM: method.PublicKeyPem,
		Algorithm:    alg,
		Keyid:        keyid,
		Period:       period,
		Identity:     didPart,
		MethodID:     selection.methodID,
		Revoked:      method.Revoked,
		Expires:      method.Expires,
	}, nil
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

// isAbsoluteHTTPSURL reports whether value parses as an absolute https URL.
func isAbsoluteHTTPSURL(value string) bool {
	u, err := url.Parse(value)
	return err == nil && strings.EqualFold(u.Scheme, "https") && u.Host != ""
}

// directKeyDoc is the Section 8.2 key-document JSON shape, plus the period,
// identity, and kid members of a period key document (spec §9.10). Period
// is decoded via json.Number so a non-integer JSON number (e.g. 2.5) can be
// told apart from a valid integer without relying on the source's literal
// spelling.
type directKeyDoc struct {
	PublicKey    string       `json:"publicKey"`
	PublicKeyPEM string       `json:"publicKeyPem"`
	Key          string       `json:"key"`
	Algorithm    string       `json:"algorithm"`
	Revoked      *bool        `json:"revoked"`
	Expires      *string      `json:"expires"`
	Kid          *string      `json:"kid"`
	Period       *json.Number `json:"period"`
	Identity     *string      `json:"identity"`
}

// resolvePeriodKeyDocumentFields reads the optional period/identity members
// of a URL-form key document (spec §9.10 "Period key documents"). It
// returns (0, kid, nil) when period is absent. When requireSameOrigin is
// true (direct-URL resolution, where kid is itself the fetch URL), identity
// must share kid's origin; a trust-directory kid is opaque, so origin is
// not checked there (draft open issue: no identity-origin rule is yet
// defined for directory-hosted keys).
func resolvePeriodKeyDocumentFields(doc directKeyDoc, kid string, requireSameOrigin bool) (period uint32, identity string, err error) {
	if doc.Period == nil {
		return 0, kid, nil
	}
	value, numErr := doc.Period.Float64()
	if numErr != nil || value != math.Trunc(value) || value < 1 || value > maxPeriod {
		return 0, "", ErrMalformedKeyDocument
	}
	if doc.Identity == nil || !isAbsoluteHTTPSURL(*doc.Identity) {
		return 0, "", ErrMalformedKeyDocument
	}
	if doc.Kid == nil || *doc.Kid != kid {
		return 0, "", ErrMalformedKeyDocument
	}
	if doc.Expires != nil && *doc.Expires != "" {
		return 0, "", ErrMalformedKeyDocument
	}
	if requireSameOrigin {
		identityURL, errI := url.Parse(*doc.Identity)
		kidURL, errK := url.Parse(kid)
		if errI != nil || errK != nil || !strings.EqualFold(identityURL.Scheme, kidURL.Scheme) || !strings.EqualFold(identityURL.Host, kidURL.Host) {
			return 0, "", ErrMalformedKeyDocument
		}
	}
	return uint32(value), *doc.Identity, nil
}

// DirectURLResolver fetches a public key from an https://... or http://...
// keyid. The endpoint MAY return JSON (`{"publicKey": "...", "algorithm":
// "..."}`) or a raw PEM document (Content-Type: text/plain or
// application/x-pem-file). When the document carries a "period" member,
// "identity" and "kid" are validated per spec §9.10. Documents are cached
// per spec §12.9/§13.4.
//
// DirectURLResolver holds cache state and MUST be used by pointer: a value
// DirectURLResolver{} no longer satisfies KeyResolver, only
// &DirectURLResolver{} does.
type DirectURLResolver struct {
	HTTPClient *http.Client
	Now        func() time.Time

	initOnce sync.Once
	docs     *documentCache
}

func (r *DirectURLResolver) init() {
	r.initOnce.Do(func() {
		nowFn := r.Now
		if nowFn == nil {
			nowFn = time.Now
		}
		r.docs = newDocumentCache(nowFn)
	})
}

func (r *DirectURLResolver) Resolve(ctx context.Context, keyid string) (*ResolvedKey, error) {
	requestURL, err := url.Parse(keyid)
	if err != nil || requestURL.Host == "" || !(strings.EqualFold(requestURL.Scheme, "https") || strings.EqualFold(requestURL.Scheme, "http")) {
		return nil, nil
	}
	requestURL.Scheme = strings.ToLower(requestURL.Scheme)
	r.init()
	return fetchAndResolveKey(ctx, r.HTTPClient, r.docs, requestURL.String(), keyid, true)
}

// ----- trust directory -----

// TrustDirectoryResolver tries each base URL in turn, fetching
// {base}/keys/{keyid}. The first base URL that returns a 200 response wins.
// When a document carries a "period" member, "identity" and "kid" are
// validated per spec §9.10; a resulting ErrMalformedKeyDocument propagates
// immediately rather than falling through to the next base URL, since a
// directory document that fails validation is a real error, not an absent
// one. Documents are cached per spec §12.9/§13.4.
//
// TrustDirectoryResolver holds cache state and MUST be used by pointer: a
// value TrustDirectoryResolver{} no longer satisfies KeyResolver, only
// &TrustDirectoryResolver{} does.
type TrustDirectoryResolver struct {
	BaseURLs   []string
	HTTPClient *http.Client
	Now        func() time.Time

	initOnce sync.Once
	docs     *documentCache
}

func (r *TrustDirectoryResolver) init() {
	r.initOnce.Do(func() {
		nowFn := r.Now
		if nowFn == nil {
			nowFn = time.Now
		}
		r.docs = newDocumentCache(nowFn)
	})
}

func (r *TrustDirectoryResolver) Resolve(ctx context.Context, keyid string) (*ResolvedKey, error) {
	if len(r.BaseURLs) == 0 {
		return nil, nil
	}
	r.init()
	var lastErr error
	for _, base := range r.BaseURLs {
		requestURL, err := directoryKeyURL(base, keyid)
		if err != nil {
			lastErr = err
			continue
		}
		key, err := fetchAndResolveKey(ctx, r.HTTPClient, r.docs, requestURL, keyid, false)
		if err != nil {
			if errors.Is(err, ErrMalformedKeyDocument) {
				return nil, err
			}
			lastErr = err
			continue
		}
		if key != nil {
			return key, nil
		}
		lastErr = nil
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

// fetchAndResolveKey loads requestURL through the document cache and parses
// either JSON ({publicKey, algorithm, ...}) or a raw PEM document into a
// ResolvedKey. keyid is recorded on the result and, when the document
// carries a "period" member, validated as its "kid" (spec §9.10).
func fetchAndResolveKey(ctx context.Context, client *http.Client, cache *documentCache, requestURL, keyid string, requireSameOrigin bool) (*ResolvedKey, error) {
	entry, err := cache.load(ctx, client, requestURL, false)
	if err != nil {
		return nil, err
	}
	if entry.isText {
		return &ResolvedKey{
			PublicKeyPEM: string(entry.body),
			Keyid:        keyid,
			Identity:     keyid,
			MethodID:     keyid,
		}, nil
	}
	var doc directKeyDoc
	decoder := json.NewDecoder(bytes.NewReader(entry.body))
	decoder.UseNumber()
	if err := decoder.Decode(&doc); err != nil {
		// As a fallback, treat the body as a PEM document.
		if strings.Contains(string(entry.body), "-----BEGIN") {
			return &ResolvedKey{
				PublicKeyPEM: string(entry.body),
				Keyid:        keyid,
				Identity:     keyid,
				MethodID:     keyid,
			}, nil
		}
		return nil, fmt.Errorf("fetchKey: decode %s: %w", requestURL, err)
	}
	publicKey := doc.PublicKey
	if publicKey == "" {
		publicKey = doc.PublicKeyPEM
	}
	if publicKey == "" {
		publicKey = doc.Key
	}
	if publicKey == "" {
		return nil, fmt.Errorf("fetchKey: %s: missing publicKey field", requestURL)
	}
	period, identity, err := resolvePeriodKeyDocumentFields(doc, keyid, requireSameOrigin)
	if err != nil {
		return nil, err
	}
	return &ResolvedKey{
		PublicKeyPEM: publicKey,
		Algorithm:    doc.Algorithm,
		Keyid:        keyid,
		Period:       period,
		Identity:     identity,
		MethodID:     keyid,
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
