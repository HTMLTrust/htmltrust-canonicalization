package canonicalize

import (
	"context"
	"errors"
)

// Endorsement is a third-party signed JSON attestation about a specific
// content hash, as defined in HTMLTrust spec §2.5.
type Endorsement struct {
	Endorser    string `json:"endorser"`
	Endorsement string `json:"endorsement"` // the targeted content-hash, e.g. "sha256:..."
	Signature   string `json:"signature"`
	Timestamp   string `json:"timestamp"`
	Algorithm   string `json:"algorithm,omitempty"` // defaults to "ed25519"
}

// VerifyEndorsement resolves the endorser's keyid and verifies the
// endorsement's signature over the canonical binding "{endorsement}:{timestamp}".
// If the endorsement does not specify an algorithm, ed25519 is assumed. If the
// resolver chain returns a key with its own declared algorithm, that takes
// precedence over the endorsement's hint (the resolved key is the source of
// truth about what the signer actually uses).
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
	algorithm := key.Algorithm
	if algorithm == "" {
		algorithm = endorsement.Algorithm
	}
	if algorithm == "" {
		algorithm = "ed25519"
	}
	message := endorsement.Endorsement + ":" + endorsement.Timestamp
	return VerifySignature(message, endorsement.Signature, key.PublicKeyPEM, algorithm)
}
