package canonicalize

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodedEndorsementExtensionsAreSignedAndMutable(t *testing.T) {
	pem, _, private := newEd25519PEM(t)
	var endorsement Endorsement
	raw := `{"endorser":"static","endorsement":"sha256:content","algorithm":"ed25519","timestamp":"2026-08-27T12:00:00Z","extension":{"answer":42},"signature":"placeholder"}`
	if err := json.Unmarshal([]byte(raw), &endorsement); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}
	if _, ok := endorsement.Extensions["extension"]; !ok {
		t.Fatalf("decoded extension was dropped: %#v", endorsement.Extensions)
	}
	roundTrip, err := json.Marshal(endorsement)
	if err != nil || !strings.Contains(string(roundTrip), `"extension":{"answer":42}`) {
		t.Fatalf("decoded extension was not retained by marshal: json=%s err=%v", roundTrip, err)
	}
	first, err := BuildEndorsementBinding(endorsement)
	if err != nil {
		t.Fatalf("BuildEndorsementBinding: %v", err)
	}
	if !strings.Contains(first, `"extension":{"answer":42}`) {
		t.Fatalf("decoded extension missing from binding: %s", first)
	}
	endorsement.Signature = base64.RawStdEncoding.EncodeToString(ed25519.Sign(private, []byte(first)))
	if ok, err := VerifyEndorsement(context.Background(), endorsement, []KeyResolver{
		staticKeyResolver{key: &ResolvedKey{PublicKeyPEM: pem, Algorithm: "ed25519"}},
	}); err != nil || !ok {
		t.Fatalf("decoded extension endorsement did not verify: ok=%v err=%v", ok, err)
	}
	value := endorsement.Extensions["extension"].(map[string]any)
	value["answer"] = float64(43)
	second, err := BuildEndorsementBinding(endorsement)
	if err != nil {
		t.Fatalf("BuildEndorsementBinding after extension change: %v", err)
	}
	if first == second || !strings.Contains(second, `"extension":{"answer":43}`) {
		t.Fatalf("extension change did not change binding: before=%s after=%s", first, second)
	}
	if ok, err := VerifyEndorsement(context.Background(), endorsement, []KeyResolver{
		staticKeyResolver{key: &ResolvedKey{PublicKeyPEM: pem, Algorithm: "ed25519"}},
	}); err != nil || ok {
		t.Fatalf("changed decoded extension unexpectedly verified: ok=%v err=%v", ok, err)
	}
}

func TestEndorsementExpiryIsStrictAndFailClosed(t *testing.T) {
	for _, value := range []string{
		"2026-08-27T12:00:00+00:00", // offsets are not v1 UTC form
		"2026-02-29T12:00:00Z",      // invalid calendar date
		"not-a-timestamp",
	} {
		if _, ok := parseRFC3339UTC(value); ok {
			t.Errorf("parseRFC3339UTC(%q) accepted malformed value", value)
		}
		if !IsKeyRevoked(&ResolvedKey{Expires: value}) {
			t.Errorf("IsKeyRevoked accepted malformed expiry %q", value)
		}
	}
}

func TestEndorsementRejectsExplicitEmptyLifecycleFields(t *testing.T) {
	for _, field := range []string{"expires", "revokedBy"} {
		t.Run(field, func(t *testing.T) {
			var endorsement Endorsement
			raw := fmt.Sprintf(`{"endorser":"static","endorsement":"sha256:content","algorithm":"ed25519","timestamp":"2026-08-27T12:00:00Z",%q:"","signature":"placeholder"}`, field)
			if err := json.Unmarshal([]byte(raw), &endorsement); err != nil {
				t.Fatalf("json.Unmarshal: %v", err)
			}
			if ok, err := VerifyEndorsement(context.Background(), endorsement, nil); err != nil || ok {
				t.Fatalf("explicit empty %s unexpectedly verified: ok=%v err=%v", field, ok, err)
			}
		})
	}
}

func TestParserPreflightRejectsCommentsAndDeclarations(t *testing.T) {
	for _, input := range []string{
		"<!-- a -- b -->x",
		"<!-- unclosed x",
		"<!foo>x",
		"<!DOCTYPE html>x",
	} {
		if _, err := ExtractCanonicalText(input); err == nil || !strings.Contains(err.Error(), "parser-profile-unsupported") {
			t.Errorf("ExtractCanonicalText(%q) error = %v, want parser-profile-unsupported", input, err)
		}
	}
	got, err := ExtractCanonicalText("<!-- safe -->x")
	if err != nil || got != "x" {
		t.Fatalf("valid comment: got %q, err %v", got, err)
	}
}

func TestExtractionRejectsInvalidUTF8(t *testing.T) {
	if _, err := ExtractCanonicalText(string([]byte{'<', 'p', '>', 0xff, '<', '/', 'p', '>'})); err == nil || !strings.Contains(err.Error(), "parser-profile-unsupported") {
		t.Fatalf("invalid UTF-8 extraction error = %v, want parser-profile-unsupported", err)
	}
	if _, err := ExtractClaimsFromSignedSection(string([]byte{'<', 'm', 'e', 't', 'a', ' ', 0xff, '>'})); err == nil || !strings.Contains(err.Error(), "parser-profile-unsupported") {
		t.Fatalf("invalid UTF-8 claim extraction error = %v, want parser-profile-unsupported", err)
	}
}

func TestNormalizeTextCheckedRejectsInvalidUTF8WithParserProfileError(t *testing.T) {
	if _, err := NormalizeTextChecked(string([]byte{0xff})); err == nil || !strings.Contains(err.Error(), "parser-profile-unsupported") {
		t.Fatalf("NormalizeTextChecked error = %v, want parser-profile-unsupported", err)
	}
}

func TestSourceLimitPrecedesInvalidUTF8Classification(t *testing.T) {
	if _, err := NormalizeTextChecked(strings.Repeat(string([]byte{0xff}), maxResourceBytes+1)); err == nil || !strings.Contains(err.Error(), "resource-limit-exceeded") {
		t.Fatalf("oversized invalid UTF-8 normalization error = %v, want resource-limit-exceeded", err)
	}
}

func TestExtractionPreflightRunsBeforeInvalidBaseURL(t *testing.T) {
	if _, err := ExtractCanonicalText("<p>unclosed", Options{BaseURL: "not a URL"}); err == nil || !strings.Contains(err.Error(), "parser-profile-unsupported") {
		t.Fatalf("ExtractCanonicalText error = %v, want parser-profile-unsupported before base URL handling", err)
	}
}

func TestRemoteKeyResolversBoundResponseBodies(t *testing.T) {
	body := strings.Repeat("x", maxRemoteKeyBytes+1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()
	if _, err := (DirectURLResolver{HTTPClient: srv.Client()}).Resolve(context.Background(), srv.URL); err == nil || !strings.Contains(err.Error(), "resource-limit-exceeded") {
		t.Fatalf("oversized direct key response error = %v, want resource-limit-exceeded", err)
	}

	client := srv.Client()
	client.Transport = rewriteTransport{base: srv.Client().Transport, target: srv.URL}
	if _, err := (DidWebResolver{HTTPClient: client}).Resolve(context.Background(), "did:web:example.test"); err == nil || !strings.Contains(err.Error(), "resource-limit-exceeded") {
		t.Fatalf("oversized DID key response error = %v, want resource-limit-exceeded", err)
	}
}

func TestDirectURLResolverAcceptsCaseInsensitiveSchemeAndRejectsInvalidUTF8(t *testing.T) {
	valid := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"publicKey":"PEM","algorithm":"ed25519"}`))
	}))
	defer valid.Close()
	upperScheme := strings.ToUpper(valid.URL[:4]) + valid.URL[4:]
	key, err := (DirectURLResolver{HTTPClient: valid.Client()}).Resolve(context.Background(), upperScheme)
	if err != nil || key == nil {
		t.Fatalf("case-insensitive scheme: key=%+v err=%v", key, err)
	}

	invalid := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte{'{', '"', 'x', '"', ':', '"', 0xff, '"', '}'})
	}))
	defer invalid.Close()
	if _, err := (DirectURLResolver{HTTPClient: invalid.Client()}).Resolve(context.Background(), invalid.URL); err == nil || !strings.Contains(err.Error(), "invalid UTF-8") {
		t.Fatalf("invalid UTF-8 response error = %v", err)
	}
}

func TestJCSRejectsNestingBeyondLimit(t *testing.T) {
	tooDeep := strings.Repeat("[", maxJSONDepth+1) + "0" + strings.Repeat("]", maxJSONDepth+1)
	if _, err := CanonicalizeJSONDocument([]byte(tooDeep)); err == nil || !strings.Contains(err.Error(), "resource-limit-exceeded") {
		t.Fatalf("too-deep JSON error = %v, want resource-limit-exceeded", err)
	}
	withinLimit := strings.Repeat("[", maxJSONDepth) + "0" + strings.Repeat("]", maxJSONDepth)
	if _, err := CanonicalizeJSONDocument([]byte(withinLimit)); err != nil {
		t.Fatalf("JSON at nesting limit rejected: %v", err)
	}
}

func TestJCSMalformedJSONPrecedesSurrogateClassification(t *testing.T) {
	if _, err := CanonicalizeJSONDocument([]byte(`{"value":"\uD800`)); err == nil || !strings.Contains(err.Error(), "jcs-invalid-json") {
		t.Fatalf("malformed surrogate JSON error = %v, want jcs-invalid-json", err)
	}
}

func TestExtractionAppliesOutputLimitAfterFinalization(t *testing.T) {
	unit := `<p href="x" src="x" alt="x" aria-label="x"></p>`
	source := strings.Repeat(unit, 10000)
	output, err := ExtractCanonicalText(source, Options{BaseURL: "https://example.com/"})
	if err != nil {
		t.Fatalf("finalized output should be within the limit: %v", err)
	}
	if len(output) != 1039999 {
		t.Fatalf("finalized output length = %d, want 1039999", len(output))
	}
}
