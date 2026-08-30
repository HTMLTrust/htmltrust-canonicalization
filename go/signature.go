package canonicalize

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"encoding/asn1"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/url"
	"regexp"
	"strings"
	"time"

	whatwgurl "github.com/nlnwa/whatwg-url/url"
)

const (
	SigningProfileV1          = "htmltrust-signature-v1"
	CanonicalizationProfileV1 = "htmltrust-c14n-v1"
	AttributeProfileV1        = "htmltrust-attrs-v1"
	URLProfileV1              = "htmltrust-safe-url-v1"
	SigningContextV1          = "https://htmltrust.org/protocol/signed-section"
)

type SigningProfileV1Input struct {
	ContentHash string
	ClaimsHash  string
	DocumentURL string
	Scope       string
	KeyID       string
	Algorithm   string
	SignedAt    string
}

type signingObjectV1 struct {
	Algorithm               string `json:"algorithm"`
	AttributeProfile        string `json:"attributeProfile"`
	CanonicalizationProfile string `json:"canonicalizationProfile"`
	ClaimsHash              string `json:"claimsHash"`
	ContentHash             string `json:"contentHash"`
	Context                 string `json:"context"`
	KeyID                   string `json:"keyid"`
	Location                string `json:"location"`
	Profile                 string `json:"profile"`
	Scope                   string `json:"scope"`
	SignedAt                string `json:"signedAt"`
	URLProfile              string `json:"urlProfile"`
}

var signedAtV1Pattern = regexp.MustCompile(`^(?:[0-9]{4})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$`)

func ValidateSignedAtV1(value string) error {
	if !signedAtV1Pattern.MatchString(value) || strings.HasPrefix(value, "0000-") {
		return fmt.Errorf("timestamp-invalid")
	}
	parsed, err := time.Parse("2006-01-02T15:04:05Z", value)
	if err != nil || parsed.UTC().Format("2006-01-02T15:04:05Z") != value {
		return fmt.Errorf("timestamp-invalid")
	}
	return nil
}

func DeriveSigningLocationV1(documentURL, scope string) (string, error) {
	u, err := whatwgurl.Parse(documentURL)
	if err != nil || u.Scheme() != "https" || u.Hostname() == "" || u.Username() != "" || u.Password() != "" {
		return "", fmt.Errorf("origin-not-supported")
	}
	switch scope {
	case "url":
		return u.Href(true), nil
	case "origin":
		return u.Scheme() + "://" + u.Host(), nil
	default:
		return "", fmt.Errorf("scope-unsupported")
	}
}

// BuildSigningPayloadV1 returns the RFC 8785 bytes fixed by htmltrust-signature-v1.
func (r *RustCore) BuildSigningPayloadV1(input SigningProfileV1Input) (string, error) {
	fields := map[string]string{
		"contentHash": input.ContentHash, "claimsHash": input.ClaimsHash,
		"documentURL": input.DocumentURL, "scope": input.Scope, "keyid": input.KeyID,
		"algorithm": input.Algorithm, "signedAt": input.SignedAt,
	}
	for name, value := range fields {
		if value == "" || strings.TrimSpace(value) != value {
			return "", fmt.Errorf("signing-object-invalid: %s", name)
		}
	}
	if err := ValidateSignedAtV1(input.SignedAt); err != nil {
		return "", err
	}
	location, err := DeriveSigningLocationV1(input.DocumentURL, input.Scope)
	if err != nil {
		return "", err
	}
	document := signingObjectV1{
		Algorithm: input.Algorithm, AttributeProfile: AttributeProfileV1,
		CanonicalizationProfile: CanonicalizationProfileV1, ClaimsHash: input.ClaimsHash,
		ContentHash: input.ContentHash, Context: SigningContextV1, KeyID: input.KeyID,
		Location: location, Profile: SigningProfileV1, Scope: input.Scope,
		SignedAt: input.SignedAt, URLProfile: URLProfileV1,
	}
	raw, err := json.Marshal(document)
	if err != nil {
		return "", err
	}
	canonical, err := r.CanonicalizeJSONDocument(raw)
	if err != nil {
		return "", err
	}
	return string(canonical), nil
}

// BuildSignatureBinding returns the legacy 0.2 colon-joined payload.
// New integrations must use BuildSigningPayloadV1.
//
//	{contentHash}:{claimsHash}:{domain}:{signedAt}
//
// All four fields are required; an empty input yields an error.
func BuildSignatureBinding(contentHash, claimsHash, domain, signedAt string) (string, error) {
	if contentHash == "" {
		return "", errors.New("BuildSignatureBinding: contentHash is required")
	}
	if claimsHash == "" {
		return "", errors.New("BuildSignatureBinding: claimsHash is required")
	}
	if domain == "" {
		return "", errors.New("BuildSignatureBinding: domain is required")
	}
	if err := ValidateSerializedOrigin(domain); err != nil {
		return "", err
	}
	if signedAt == "" {
		return "", errors.New("BuildSignatureBinding: signedAt is required")
	}
	return contentHash + ":" + claimsHash + ":" + domain + ":" + signedAt, nil
}

// ValidateSerializedOrigin checks that the legacy-named "domain" field carries
// a canonical serialized Web origin: scheme://host[:port], with no path,
// query, fragment, or credentials.
func ValidateSerializedOrigin(origin string) error {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return errors.New("domain must be a serialized Web origin")
	}
	if u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("domain must be a serialized Web origin")
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return errors.New("domain must use the http or https scheme")
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return errors.New("domain must be a serialized Web origin")
	}
	serializedHost := host
	if strings.Contains(host, ":") {
		serializedHost = "[" + host + "]"
	}
	canonical := scheme + "://" + serializedHost
	if port := u.Port(); port != "" {
		if !((scheme == "http" && port == "80") || (scheme == "https" && port == "443")) {
			canonical = scheme + "://" + net.JoinHostPort(host, port)
		}
	}
	if canonical != origin {
		return fmt.Errorf("domain must use canonical serialized origin form: %s", canonical)
	}
	return nil
}

// ecdsaSig is the ASN.1 wire encoding for an ECDSA signature.
type ecdsaSig struct {
	R, S *big.Int
}

// EncodeBase64Unpadded emits canonical unpadded standard Base64.
func EncodeBase64Unpadded(b []byte) string {
	return base64.RawStdEncoding.EncodeToString(b)
}

// DecodeCanonicalBase64 decodes canonical unpadded standard Base64 and rejects
// padded, whitespace-containing, or base64url forms.
func DecodeCanonicalBase64(s string) ([]byte, error) {
	if s == "" {
		return []byte{}, nil
	}
	if strings.ContainsAny(s, "=\r\n\t -_") || len(s)%4 == 1 {
		return nil, errors.New("non-canonical base64")
	}
	b, err := base64.RawStdEncoding.DecodeString(s)
	if err != nil {
		return nil, err
	}
	if EncodeBase64Unpadded(b) != s {
		return nil, errors.New("non-canonical base64")
	}
	return b, nil
}

// parsePublicKey decodes a PEM-wrapped PKIX public key.
func parsePublicKey(pemStr string) (any, error) {
	block, _ := pem.Decode([]byte(pemStr))
	if block == nil {
		return nil, errors.New("VerifySignature: invalid PEM block")
	}
	return x509.ParsePKIXPublicKey(block.Bytes)
}

// VerifySignature verifies a base64-encoded signature over the given message
// using the supplied PEM-encoded public key. Algorithm matching is
// case-insensitive and supports the registry algorithms plus the legacy
// generic "ecdsa" and "rsa" spellings.
func VerifySignature(message string, signatureB64 string, publicKeyPEM string, algorithm string) (bool, error) {
	sig, err := DecodeCanonicalBase64(signatureB64)
	if err != nil {
		return false, fmt.Errorf("VerifySignature: decode signature: %w", err)
	}
	pub, err := parsePublicKey(publicKeyPEM)
	if err != nil {
		return false, fmt.Errorf("VerifySignature: parse public key: %w", err)
	}

	switch strings.ToLower(algorithm) {
	case "ed25519":
		key, ok := pub.(ed25519.PublicKey)
		if !ok {
			return false, errors.New("VerifySignature: public key is not ed25519")
		}
		return ed25519.Verify(key, []byte(message), sig), nil

	case "ecdsa":
		key, ok := pub.(*ecdsa.PublicKey)
		if !ok {
			return false, errors.New("VerifySignature: public key is not ecdsa")
		}
		digest := sha256.Sum256([]byte(message))
		var parsed ecdsaSig
		if _, err := asn1.Unmarshal(sig, &parsed); err != nil {
			return false, fmt.Errorf("VerifySignature: parse ecdsa signature: %w", err)
		}
		return ecdsa.Verify(key, digest[:], parsed.R, parsed.S), nil

	case "ecdsa-p256", "ecdsa-p384":
		key, ok := pub.(*ecdsa.PublicKey)
		if !ok {
			return false, errors.New("VerifySignature: public key is not ecdsa")
		}
		componentBytes := 32
		expectedCurve := "P-256"
		var digest []byte
		if strings.EqualFold(algorithm, "ecdsa-p384") {
			componentBytes = 48
			expectedCurve = "P-384"
			sum := sha512.Sum384([]byte(message))
			digest = sum[:]
		} else {
			sum := sha256.Sum256([]byte(message))
			digest = sum[:]
		}
		if key.Curve.Params().Name != expectedCurve || len(sig) != 2*componentBytes {
			return false, nil
		}
		r := new(big.Int).SetBytes(sig[:componentBytes])
		s := new(big.Int).SetBytes(sig[componentBytes:])
		return ecdsa.Verify(key, digest, r, s), nil

	case "rsa":
		fallthrough
	case "rsa-pkcs1-sha256":
		key, ok := pub.(*rsa.PublicKey)
		if !ok {
			return false, errors.New("VerifySignature: public key is not rsa")
		}
		digest := sha256.Sum256([]byte(message))
		if err := rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], sig); err != nil {
			return false, nil
		}
		return true, nil

	case "rsa-pss-sha256":
		key, ok := pub.(*rsa.PublicKey)
		if !ok {
			return false, errors.New("VerifySignature: public key is not rsa")
		}
		digest := sha256.Sum256([]byte(message))
		opts := &rsa.PSSOptions{SaltLength: rsa.PSSSaltLengthEqualsHash, Hash: crypto.SHA256}
		if err := rsa.VerifyPSS(key, crypto.SHA256, digest[:], sig, opts); err != nil {
			return false, nil
		}
		return true, nil

	default:
		return false, fmt.Errorf("VerifySignature: unsupported algorithm %q", algorithm)
	}
}

// VerifyResolvedSignature verifies a signature using a resolved key and
// rejects revoked or expired key material before doing any cryptographic work.
// VerifySignature is retained as the legacy PEM-only API; callers that obtain
// keys through a KeyResolver should use this checked form.
func VerifyResolvedSignature(message, signatureB64 string, key *ResolvedKey, algorithm string) (bool, error) {
	if key == nil {
		return false, errors.New("VerifyResolvedSignature: key is required")
	}
	if IsKeyRevoked(key) {
		return false, nil
	}
	return VerifySignature(message, signatureB64, key.PublicKeyPEM, algorithm)
}
