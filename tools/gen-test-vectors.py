#!/usr/bin/env python3
"""Generate HTMLTrust end-to-end test vectors: a fixed Ed25519 key and a
signed-section fixture carried through the full pipeline (canonical bytes ->
content/claims hash -> §5 signing payload -> Ed25519 signature). Every signer
and verifier MUST reproduce these bytes.

Run after installing ``python[dev]`` and building the Rust shared core:
    HTMLTRUST_RUST_CORE_LIB=/absolute/path/to/libhtmltrust_canonicalization_ffi.so \
      python tools/gen-test-vectors.py --check
"""
import argparse, base64, hashlib, json, os, pathlib
from htmltrust_canonicalization import RustCore
from pywhatwgurl import URL
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

ROOT = pathlib.Path(".")
ARGS = argparse.ArgumentParser(description=__doc__.splitlines()[0])
ARGS.add_argument("--check", action="store_true", help="fail if the checked-in vector is stale")
ARGS.add_argument(
    "--rust-core-library",
    default=os.environ.get("HTMLTRUST_RUST_CORE_LIB"),
    help="absolute path to the Rust shared library (defaults to HTMLTRUST_RUST_CORE_LIB)",
)
args = ARGS.parse_args()
if not args.rust_core_library:
    ARGS.error("--rust-core-library or HTMLTRUST_RUST_CORE_LIB is required")
core = RustCore(args.rust_core_library)

def b64(b): return base64.b64encode(b).decode().rstrip("=")
def sha256_hash(bs): return "sha256:" + b64(hashlib.sha256(bs).digest())

# Fixed, clearly-labelled test seed (32 bytes).
SEED = b"htmltrust-test-vector-ed25519-01"
assert len(SEED) == 32
sk = Ed25519PrivateKey.from_private_bytes(SEED)
pk = sk.public_key()
pub_raw = pk.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
pub_pem = pk.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()

BASE_URL = "https://example.com/essays/engines"      # signed document URL
DOCUMENT_URL = "HTTPS://EXAMPLE.COM:443/essays/engines#analysis"
SIGNED_AT = "2026-01-15T12:00:00Z"

HTML = (
    "<signed-section>"
    '<meta name="author" content="Ada Lovelace">'
    f'<meta name="signed-at" content="{SIGNED_AT}">'
    '<meta name="claim:License" content="CC-BY-4.0">'
    "<h1>On Analytical Engines</h1>"
    "<p>The engine weaves algebraic patterns &mdash; just as the loom weaves flowers.</p>"
    '<p>See <a href="/notes/engine">the notes</a> and '
    '<img src="/img/ada.png" alt="Portrait of Ada">.</p>'
    "</signed-section>"
)

content = core.extract_canonical_text(HTML, base_url=BASE_URL)
content_hash = sha256_hash(content.encode("utf-8"))
claims_map = dict(sorted(core.extract_claims_from_signed_section(HTML).items()))
claims_str = core.canonicalize_claims(claims_map)
claims_hash = sha256_hash(claims_str.encode("utf-8"))
location_url = URL(DOCUMENT_URL)
location_url.hash = ""
signing_object = {
    "algorithm": "ed25519",
    "attributeProfile": "htmltrust-attrs-v1",
    "canonicalizationProfile": "htmltrust-c14n-v1",
    "claimsHash": claims_hash,
    "contentHash": content_hash,
    "context": "https://htmltrust.org/protocol/signed-section",
    "keyid": "https://keys.example/alice-2026.json",
    "location": str(location_url),
    "profile": "htmltrust-signature-v1",
    "scope": "url",
    "signedAt": SIGNED_AT,
    "urlProfile": "htmltrust-safe-url-v1",
}
payload = core.canonicalize_json_document(json.dumps(signing_object, ensure_ascii=False))
signature = b64(sk.sign(payload.encode("utf-8")))

vector = {
    "description": "HTMLTrust htmltrust-signature-v1 end-to-end Ed25519 vector.",
    "algorithm": "ed25519",
    "key": {
        "seedHex": SEED.hex(),
        "publicKeyRawHex": pub_raw.hex(),
        "publicKeyPem": pub_pem,
    },
    "input": {
        "html": HTML,
        "baseURL": BASE_URL,
        "documentURL": DOCUMENT_URL,
        "scope": "url",
        "keyid": "https://keys.example/alice-2026.json",
        "signedAt": SIGNED_AT,
    },
    "canonicalContent": content,
    "contentHash": content_hash,
    "claims": claims_map,
    "canonicalClaims": claims_str,
    "claimsHash": claims_hash,
    "signingPayload": payload,
    "signature": signature,
}
out = ROOT / "conformance" / "vectors" / "vector-01.json"
rendered = json.dumps(vector, ensure_ascii=False, indent=2) + "\n"
if args.check:
    if out.read_text(encoding="utf-8") != rendered:
        raise SystemExit(f"stale vector: run {pathlib.Path(__file__).as_posix()}")
    print("vector is current:", out)
    raise SystemExit(0)
out.write_text(rendered, encoding="utf-8")
print("wrote", out)
print("  contentHash :", content_hash)
print("  claimsHash  :", claims_hash)
print("  payload     :", payload)
print("  signature   :", signature)
print("  canonicalContent:\n" + content)
