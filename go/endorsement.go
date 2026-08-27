package canonicalize

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
)

// Endorsement is a third-party signed JSON attestation about a specific
// content hash, as defined in HTMLTrust spec §2.5.
type Endorsement struct {
	Endorser    string `json:"endorser"`
	Endorsement string `json:"endorsement"` // the targeted content-hash, e.g. "sha256:..."
	Signature   string `json:"signature"`
	Timestamp   string `json:"timestamp"`
	Algorithm   string `json:"algorithm"`
}

// BuildEndorsementBinding returns the deterministic JSON signing payload for
// an endorsement: the endorsement document serialized with signature omitted.
func BuildEndorsementBinding(endorsement Endorsement) (string, error) {
	if endorsement.Endorser == "" {
		return "", errors.New("BuildEndorsementBinding: endorser is required")
	}
	if endorsement.Endorsement == "" {
		return "", errors.New("BuildEndorsementBinding: endorsement is required")
	}
	if endorsement.Algorithm == "" {
		return "", errors.New("BuildEndorsementBinding: algorithm is required")
	}
	if endorsement.Timestamp == "" {
		return "", errors.New("BuildEndorsementBinding: timestamp is required")
	}
	doc := map[string]string{
		"algorithm":   endorsement.Algorithm,
		"endorsement": endorsement.Endorsement,
		"endorser":    endorsement.Endorser,
		"timestamp":   endorsement.Timestamp,
	}
	b, err := json.Marshal(doc)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// VerifyEndorsement resolves the endorser's keyid and verifies the
// endorsement's signature over the deterministic JSON document with the
// signature field omitted.
func VerifyEndorsement(ctx context.Context, endorsement Endorsement, resolvers []KeyResolver) (bool, error) {
	if endorsement.Endorser == "" {
		return false, errors.New("VerifyEndorsement: endorser is required")
	}
	if endorsement.Endorsement == "" {
		return false, errors.New("VerifyEndorsement: endorsement (target content hash) is required")
	}
	if endorsement.Signature == "" {
		return false, errors.New("VerifyEndorsement: signature is required")
	}
	if endorsement.Timestamp == "" {
		return false, errors.New("VerifyEndorsement: timestamp is required")
	}
	key, err := ResolveKey(ctx, endorsement.Endorser, resolvers)
	if err != nil {
		return false, err
	}
	if key.Algorithm != "" && !algorithmsCompatible(key.Algorithm, endorsement.Algorithm) {
		return false, errors.New("VerifyEndorsement: resolved key algorithm does not match endorsement")
	}
	message, err := BuildEndorsementBinding(endorsement)
	if err != nil {
		return false, err
	}
	return VerifySignature(message, endorsement.Signature, key.PublicKeyPEM, endorsement.Algorithm)
}

func algorithmFamily(algorithm string) string {
	algorithm = strings.ToLower(algorithm)
	if strings.HasPrefix(algorithm, "ecdsa") {
		return "ecdsa"
	}
	if strings.HasPrefix(algorithm, "rsa") {
		return "rsa"
	}
	return algorithm
}

func algorithmsCompatible(resolved, declared string) bool {
	resolved = strings.ToLower(resolved)
	declared = strings.ToLower(declared)
	if resolved == declared {
		return true
	}
	resolvedFamily := algorithmFamily(resolved)
	declaredFamily := algorithmFamily(declared)
	if resolvedFamily != declaredFamily {
		return false
	}
	if resolved == resolvedFamily || declared == declaredFamily {
		return true
	}
	return resolvedFamily == "rsa"
}
