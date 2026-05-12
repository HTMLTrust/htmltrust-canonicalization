package canonicalize

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/asn1"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
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
	if signedAt == "" {
		return "", errors.New("BuildSignatureBinding: signedAt is required")
	}
	return contentHash + ":" + claimsHash + ":" + domain + ":" + signedAt, nil
}

// ecdsaSig is the ASN.1 wire encoding for an ECDSA signature.
type ecdsaSig struct {
	R, S *big.Int
}

// decodeBase64 accepts both standard padded and unpadded base64.
func decodeBase64(s string) ([]byte, error) {
	if b, err := base64.StdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return base64.RawStdEncoding.DecodeString(s)
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
// case-insensitive and supports "ed25519", "ecdsa" (with SHA-256), and "rsa"
// (PKCS1v15 with SHA-256).
func VerifySignature(message string, signatureB64 string, publicKeyPEM string, algorithm string) (bool, error) {
	sig, err := decodeBase64(signatureB64)
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

	case "rsa":
		key, ok := pub.(*rsa.PublicKey)
		if !ok {
			return false, errors.New("VerifySignature: public key is not rsa")
		}
		digest := sha256.Sum256([]byte(message))
		if err := rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], sig); err != nil {
			return false, nil
		}
		return true, nil

	default:
		return false, fmt.Errorf("VerifySignature: unsupported algorithm %q", algorithm)
	}
}
