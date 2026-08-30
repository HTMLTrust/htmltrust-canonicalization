package canonicalize

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Endorsement is a third-party signed JSON attestation about a specific
// content hash, as defined in HTMLTrust spec §2.5.
type Endorsement struct {
	Endorser    string `json:"endorser"`
	Endorsement string `json:"endorsement"` // the targeted content-hash, e.g. "sha256:..."
	Signature   string `json:"signature"`
	Timestamp   string `json:"timestamp"`
	Algorithm   string `json:"algorithm"`
	Expires     string `json:"expires,omitempty"`
	Claim       string `json:"claim,omitempty"`
	RevokedBy   string `json:"revokedBy,omitempty"`
	// Extensions preserves implementation-defined members in the signed JCS payload.
	// Reserved document field names in this map are rejected.
	Extensions map[string]any `json:"-"`

	// present records optional fields that were explicitly present on the wire,
	// including an explicitly empty string. This keeps a decoded document's
	// signed member set intact.
	present map[string]bool
}

var endorsementFields = map[string]bool{
	"endorser": true, "endorsement": true, "signature": true,
	"timestamp": true, "algorithm": true, "expires": true,
	"claim": true, "revokedBy": true,
}

// UnmarshalJSON refuses the standard decoder because it has no RustCore
// receiver and therefore cannot perform the required duplicate-key/JCS
// validation. Use (*RustCore).DecodeEndorsement for raw signed input.
func (e *Endorsement) UnmarshalJSON(data []byte) error {
	if e == nil {
		return errors.New("cannot unmarshal endorsement into nil receiver")
	}
	return errors.New("endorsement decoding requires RustCore.DecodeEndorsement")
}

// DecodeEndorsement validates raw JSON with the Rust core before decoding it.
// Callers that process signed input should use this method so duplicate keys
// and other JCS-invalid values are rejected by the shared implementation.
func (r *RustCore) DecodeEndorsement(data []byte) (Endorsement, error) {
	if _, err := r.CanonicalizeJSONDocument(data); err != nil {
		return Endorsement{}, err
	}
	var endorsement Endorsement
	if err := decodeEndorsement(data, &endorsement); err != nil {
		return Endorsement{}, err
	}
	return endorsement, nil
}

func decodeEndorsement(data []byte, e *Endorsement) error {
	var members map[string]json.RawMessage
	if err := json.Unmarshal(data, &members); err != nil {
		return err
	}
	stringField := func(name string) (string, error) {
		raw, ok := members[name]
		if !ok {
			return "", nil
		}
		trimmed := bytes.TrimSpace(raw)
		if len(trimmed) == 0 || trimmed[0] != '"' {
			return "", fmt.Errorf("endorsement %s must be a string", name)
		}
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			return "", err
		}
		return value, nil
	}
	var err error
	fields := Endorsement{}
	if fields.Endorser, err = stringField("endorser"); err != nil {
		return err
	}
	if fields.Endorsement, err = stringField("endorsement"); err != nil {
		return err
	}
	if fields.Signature, err = stringField("signature"); err != nil {
		return err
	}
	if fields.Timestamp, err = stringField("timestamp"); err != nil {
		return err
	}
	if fields.Algorithm, err = stringField("algorithm"); err != nil {
		return err
	}
	if fields.Expires, err = stringField("expires"); err != nil {
		return err
	}
	if fields.Claim, err = stringField("claim"); err != nil {
		return err
	}
	if fields.RevokedBy, err = stringField("revokedBy"); err != nil {
		return err
	}
	decoded := Endorsement{
		Endorser: fields.Endorser, Endorsement: fields.Endorsement,
		Signature: fields.Signature, Timestamp: fields.Timestamp,
		Algorithm: fields.Algorithm, Expires: fields.Expires,
		Claim: fields.Claim, RevokedBy: fields.RevokedBy,
		Extensions: make(map[string]any),
		present:    make(map[string]bool),
	}
	for name, raw := range members {
		if endorsementFields[name] {
			decoded.present[name] = true
			continue
		}
		var value any
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		if err := decoder.Decode(&value); err != nil {
			return err
		}
		decoded.Extensions[name] = value
	}
	*e = decoded
	return nil
}

// MarshalJSON emits the complete endorsement document, including extensions.
// This makes a decode/marshal round trip retain the members that participate
// in the signature payload.
func (e Endorsement) MarshalJSON() ([]byte, error) {
	doc, err := e.signingDocument(true)
	if err != nil {
		return nil, err
	}
	return json.Marshal(doc)
}

func (endorsement Endorsement) signingDocument(includeSignature bool) (map[string]json.RawMessage, error) {
	doc := make(map[string]json.RawMessage, 8+len(endorsement.Extensions))
	put := func(name string, value any) error {
		raw, err := json.Marshal(value)
		if err != nil {
			return err
		}
		doc[name] = raw
		return nil
	}
	if err := put("algorithm", endorsement.Algorithm); err != nil {
		return nil, err
	}
	if err := put("endorsement", endorsement.Endorsement); err != nil {
		return nil, err
	}
	if err := put("endorser", endorsement.Endorser); err != nil {
		return nil, err
	}
	if err := put("timestamp", endorsement.Timestamp); err != nil {
		return nil, err
	}
	if includeSignature {
		if err := put("signature", endorsement.Signature); err != nil {
			return nil, err
		}
	}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"expires", endorsement.Expires}, {"claim", endorsement.Claim}, {"revokedBy", endorsement.RevokedBy},
	} {
		if field.value != "" || endorsement.present[field.name] {
			if err := put(field.name, field.value); err != nil {
				return nil, err
			}
		}
	}
	for name, value := range endorsement.Extensions {
		if endorsementFields[name] {
			return nil, fmt.Errorf("BuildEndorsementBinding: reserved extension field %q", name)
		}
		if err := put(name, value); err != nil {
			return nil, err
		}
	}
	return doc, nil
}

// BuildEndorsementBinding returns the deterministic JSON signing payload for
// an endorsement: the endorsement document serialized with signature omitted.
func (r *RustCore) BuildEndorsementBinding(endorsement Endorsement) (string, error) {
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
	doc, err := endorsement.signingDocument(false)
	if err != nil {
		return "", err
	}
	b, err := json.Marshal(doc)
	if err != nil {
		return "", err
	}
	canonical, err := r.CanonicalizeEndorsementDocument(b)
	if err != nil {
		return "", err
	}
	return string(canonical), nil
}

// CanonicalizeEndorsementDocument validates one raw endorsement object,
// removes its signature member, and returns RFC 8785 canonical bytes. Passing
// raw JSON lets callers reject duplicate members before object materialization.
func (r *RustCore) CanonicalizeEndorsementDocument(document []byte) ([]byte, error) {
	// The first Rust call validates the complete input, including duplicate
	// members, before Go materializes it into a map.
	if _, err := r.CanonicalizeJSONDocument(document); err != nil {
		return nil, err
	}
	var members map[string]json.RawMessage
	if err := json.Unmarshal(document, &members); err != nil {
		return nil, fmt.Errorf("jcs-invalid-json")
	}
	if members == nil {
		return nil, fmt.Errorf("endorsement document must be an object")
	}
	required := []string{"endorser", "endorsement", "algorithm", "timestamp"}
	for _, name := range required {
		raw, ok := members[name]
		if !ok {
			return nil, fmt.Errorf("endorsement %s must be non-empty", name)
		}
		var value string
		if err := json.Unmarshal(raw, &value); err != nil || value == "" {
			return nil, fmt.Errorf("endorsement %s must be non-empty", name)
		}
	}
	delete(members, "signature")
	unsigned, err := json.Marshal(members)
	if err != nil {
		return nil, err
	}
	canonical, err := r.CanonicalizeJSONDocument(unsigned)
	if err != nil {
		return nil, err
	}
	return canonical, nil
}

// VerifyEndorsement resolves the endorser's keyid and verifies the
// endorsement's signature over the deterministic JSON document with the
// signature field omitted.
func (r *RustCore) VerifyEndorsement(ctx context.Context, endorsement Endorsement, resolvers []KeyResolver) (bool, error) {
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
	// Endorsements carry their own lifecycle in addition to the endorser key.
	// A revoked/superseded endorsement and an expired or malformed expiry are
	// invalid for a current trust decision.
	if endorsement.RevokedBy != "" || endorsement.present["revokedBy"] {
		return false, nil
	}
	if endorsement.Expires != "" || endorsement.present["expires"] {
		expires, valid := parseRFC3339UTC(endorsement.Expires)
		if !valid || !expires.After(time.Now()) {
			return false, nil
		}
	}
	key, err := ResolveKey(ctx, endorsement.Endorser, resolvers)
	if err != nil {
		return false, err
	}
	if IsKeyRevoked(key) {
		return false, nil
	}
	if key.Algorithm != "" && !algorithmsCompatible(key.Algorithm, endorsement.Algorithm) {
		return false, errors.New("VerifyEndorsement: resolved key algorithm does not match endorsement")
	}
	message, err := r.BuildEndorsementBinding(endorsement)
	if err != nil {
		return false, err
	}
	return VerifyResolvedSignature(message, endorsement.Signature, key, endorsement.Algorithm)
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
