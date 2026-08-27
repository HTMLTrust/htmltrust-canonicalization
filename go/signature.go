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
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/url"
	"strings"
)

// BuildSignatureBinding returns the canonical signing payload used to compute
// or verify a content signature, as defined in HTMLTrust spec §2.1:
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
