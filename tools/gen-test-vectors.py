#!/usr/bin/env python3
"""Generate HTMLTrust end-to-end test vectors: a fixed Ed25519 key and a
signed-section fixture carried through the full pipeline (canonical bytes ->
content/claims hash -> §5 signing payload -> Ed25519 signature). Every signer
and verifier MUST reproduce these bytes.

Run:  uv run --with cryptography python tools/gen-test-vectors.py
"""
import base64, hashlib, json, sys, pathlib
sys.path.insert(0, "python")
from htmltrust_canonicalization import extract_canonical_text, extract_claims_from_signed_section, canonicalize_claims
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

ROOT = pathlib.Path(".")

def b64(b): return base64.b64encode(b).decode().rstrip("=")
def sha256_hash(bs): return "sha256:" + b64(hashlib.sha256(bs).digest())

# Fixed, clearly-labelled test seed (32 bytes).
SEED = b"htmltrust-test-vector-ed25519-01"
assert len(SEED) == 32
sk = Ed25519PrivateKey.from_private_bytes(SEED)
pk = sk.public_key()
pub_raw = pk.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
pub_pem = pk.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()

DOMAIN = "https://example.com"                       # serialized Web origin
BASE_URL = "https://example.com/essays/engines"      # signed document URL
SIGNED_AT = "2026-01-15T12:00:00Z"

HTML = (
    "<signed-section>"
    '<meta name="author" content="Ada Lovelace">'
    f'<meta name="signed-at" content="{SIGNED_AT}">'
    '<meta name="license" content="CC-BY-4.0">'
    "<h1>On Analytical Engines</h1>"
    "<p>The engine weaves algebraic patterns &mdash; just as the loom weaves flowers.</p>"
    '<p>See <a href="/notes/engine">the notes</a> and '
    '<img src="/img/ada.png" alt="Portrait of Ada">.</p>'
    "</signed-section>"
)

content = extract_canonical_text(HTML, base_url=BASE_URL)
content_hash = sha256_hash(content.encode("utf-8"))
claims_map = extract_claims_from_signed_section(HTML)
claims_str = canonicalize_claims(claims_map)
claims_hash = sha256_hash(claims_str.encode("utf-8"))
payload = f"{content_hash}:{claims_hash}:{DOMAIN}:{SIGNED_AT}"
signature = b64(sk.sign(payload.encode("utf-8")))

vector = {
    "description": "HTMLTrust end-to-end test vector 01 (Ed25519). Every signer "
                   "and verifier MUST reproduce contentHash, claimsHash, "
                   "signingPayload and signature exactly.",
    "algorithm": "ed25519",
    "key": {
        "seedHex": SEED.hex(),
        "publicKeyRawHex": pub_raw.hex(),
        "publicKeyPem": pub_pem,
    },
    "input": {"html": HTML, "baseURL": BASE_URL, "domain": DOMAIN, "signedAt": SIGNED_AT},
    "canonicalContent": content,
    "contentHash": content_hash,
    "claims": claims_map,
    "canonicalClaims": claims_str,
    "claimsHash": claims_hash,
    "signingPayload": payload,
    "signature": signature,
}
out = ROOT / "conformance" / "vectors" / "vector-01.json"
out.write_text(json.dumps(vector, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("wrote", out)
print("  contentHash :", content_hash)
print("  claimsHash  :", claims_hash)
print("  payload     :", payload)
print("  signature   :", signature)
print("  canonicalContent:\n" + content)
