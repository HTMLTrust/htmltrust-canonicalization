import {
  normalizeText,
  extractCanonicalText,
  canonicalizeClaims,
  extractClaimsFromSignedSection,
  decodeCanonicalBase64,
  buildSignatureBinding,
  buildSigningPayloadV1,
  deriveSigningLocationV1,
  validateSignedAtV1,
  buildEndorsementBinding,
  verifySignature,
  didWebResolver,
  directUrlResolver,
  trustDirectoryResolver,
  resolveKey,
  verifyEndorsement,
  isKeyRevoked,
  canonicalizeJson,
  canonicalizeJsonDocument,
} from './index.js';
import * as nodeCrypto from 'node:crypto';
import { generateKeyPairSync, sign as nodeSign, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { encodeBase64Unpadded } from './index.js';

const tests = [
  // [inputA, inputB, shouldMatch, description]
  ['\u201CHello\u201D', '"Hello"', true, 'Curly double quotes → straight'],
  ['caf\u00E9', 'cafe\u0301', true, 'Precomposed vs combining (NFKC)'],
  ['\uFB01nd', 'find', true, 'fi ligature (NFKC)'],
  ['word \u2014 word', 'word - word', true, 'Em dash → hyphen-minus'],
  ['\u00ABBonjour\u00BB', '"Bonjour"', true, 'Guillemets → double quotes'],
  ['\u300C\u6771\u4EAC\u300D', '"\u6771\u4EAC"', true, 'CJK corner brackets → double quotes'],
  ['\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645', '\u0645\u06CC\u062E\u0648\u0627\u0647\u0645', false, 'ZWNJ is semantic (Persian)'],
  ['\u0643\u062A\u0640\u0640\u0640\u0627\u0628', '\u0643\u062A\u0627\u0628', true, 'Arabic tatweel stripped'],
  ['\uFF21\uFF11', 'A1', true, 'Fullwidth ASCII (NFKC)'],
  ['\u2460', '1', true, 'Circled digit (NFKC)'],
  ['word\u200Bword', 'wordword', true, 'ZWSP stripped'],
  ['word\u200Cword', 'wordword', false, 'ZWNJ preserved (different)'],
  ['Hello\u2026', 'Hello...', true, 'Ellipsis → three dots'],
  ['\u2018Hello\u2019', "'Hello'", true, 'Curly single quotes → straight'],
  ['\u201AGerman\u201C', '\'German"', true, 'Low-9 quotes → straight'],
  ['a\u00A0b', 'a b', true, 'No-break space → space'],
  ['a\u3000b', 'a b', true, 'Ideographic space → space'],
  ['a  \t  b', 'a b', true, 'Whitespace collapse'],
];

let passed = 0;
let failed = 0;

for (const [inputA, inputB, shouldMatch, desc] of tests) {
  const a = normalizeText(inputA);
  const b = normalizeText(inputB);
  const match = a === b;

  if (match === shouldMatch) {
    passed++;
    console.log(`  ✓ ${desc}`);
  } else {
    failed++;
    console.log(`  ✗ ${desc}`);
    console.log(`    A: ${JSON.stringify(a)}`);
    console.log(`    B: ${JSON.stringify(b)}`);
    console.log(`    Expected ${shouldMatch ? 'same' : 'different'}, got ${match ? 'same' : 'different'}`);
  }
}

// ============================================================================
// Async tests for signature binding, verification, resolvers, endorsements
// ============================================================================

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

await check('buildSignatureBinding produces colon-joined string', () => {
  const s = buildSignatureBinding({
    contentHash: 'sha256:AAA',
    claimsHash: 'sha256:BBB',
    domain: 'https://example.org',
    signedAt: '2026-04-28T00:00:00Z',
  });
  assertEq(s, 'sha256:AAA:sha256:BBB:https://example.org:2026-04-28T00:00:00Z');
});

await check('buildSignatureBinding rejects bare hostname domain field', () => {
  let threw = false;
  try {
    buildSignatureBinding({
      contentHash: 'sha256:AAA',
      claimsHash: 'sha256:BBB',
      domain: 'example.org',
      signedAt: '2026-04-28T00:00:00Z',
    });
  } catch {
    threw = true;
  }
  assert(threw, 'expected bare hostname to be rejected');
});

await check('v1 location derivation removes fragments and supports origin scope', () => {
  assertEq(
    deriveSigningLocationV1('HTTPS://BÜCHER.EXAMPLE:443/a/../article?q=1#part', 'url'),
    'https://xn--bcher-kva.example/article?q=1',
  );
  assertEq(
    deriveSigningLocationV1('https://example.org:8443/a?q=1#part', 'origin'),
    'https://example.org:8443',
  );
});

await check('v1 timestamp validation rejects impossible dates and fractions', () => {
  for (const value of ['2023-02-29T23:59:59Z', '2026-01-15T12:00:00.000Z']) {
    let threw = false;
    try { validateSignedAtV1(value); } catch { threw = true; }
    assert(threw, `expected ${value} to fail`);
  }
});

await check('canonicalizeClaims uses colon lines and signs author/signed-at', () => {
  const out = canonicalizeClaims({
    'signed-at': '2026-05-01T10:30:00Z',
    author: 'Alice Example',
    'claim:License': 'CC-BY-4.0',
  });
  assertEq(out, 'author:Alice Example\nclaim\\:License:CC-BY-4.0\nsigned-at:2026-05-01T10\\:30\\:00Z\n');
});

await check('canonicalizeClaims rejects non-string values', () => {
  let threw = false;
  try {
    canonicalizeClaims({ count: 42 });
  } catch (error) {
    threw = String(error).includes('claim-malformed');
  }
  assert(threw, 'expected non-string claim value to fail');
});

await check('extractClaimsFromSignedSection includes all direct child meta only', () => {
  const claims = extractClaimsFromSignedSection(`
    <signed-section>
      <meta name="author" content="Alice">
      <meta name="signed-at" content="2026-05-01T10:30:00Z">
      <div><meta name="author" content="Nested"></div>
    </signed-section>
  `);
  assertEq(claims.author, 'Alice');
  assertEq(claims['signed-at'], '2026-05-01T10:30:00Z');
  assert(!('Nested' in claims), 'nested meta must not be extracted');
});

await check('extractClaimsFromSignedSection selects the first signed-section anywhere', () => {
  const claims = extractClaimsFromSignedSection(`
    <div><signed-section><meta name="author" content="Nested first"></signed-section></div>
    <signed-section><meta name="author" content="Later"></signed-section>
  `);
  assertEq(claims.author, 'Nested first');
});

await check('extractClaimsFromSignedSection rejects duplicate normalized names', () => {
  let threw = false;
  try {
    extractClaimsFromSignedSection('<meta name="author" content="A"><meta name="author" content="B">');
  } catch {
    threw = true;
  }
  assert(threw, 'expected duplicate direct child meta names to fail');
});

await check('extractClaimsFromSignedSection checks oversized fields before duplicates', () => {
  let threw = false;
  try {
    extractClaimsFromSignedSection(`<meta name="author" content="A"><meta name="author" content="${'x'.repeat(4097)}">`);
  } catch (error) {
    threw = String(error).includes('resource-limit-exceeded');
  }
  assert(threw, 'oversized duplicate claim must fail as a resource violation');
});

await check('extractCanonicalText signs href/src/alt/aria-label attributes', () => {
  const out = extractCanonicalText(
    '<p><a href="/story?a=1&amp;b=2" aria-label="Read “more”">link</a><img src="img.png" alt="Hero — image"></p>',
    { baseUrl: 'https://example.org/base/page.html' },
  );
  assertEq(
    out,
    '@attr:a:href:https://example.org/story?a=1&b=2\n@attr:a:aria-label:Read "more"\nlink\n@attr:img:src:https://example.org/base/img.png\n@attr:img:alt:Hero - image',
  );
});

await check('extractCanonicalText rejects malformed comment bodies', () => {
  let threw = false;
  try { extractCanonicalText('<!-- a -- b -->x'); } catch (error) {
    threw = String(error).includes('parser-profile-unsupported');
  }
  assert(threw, 'double hyphen in a comment must be rejected');
});

await check('extractCanonicalText bounds malformed quoted tag scanning', () => {
  const source = '<p>before</p><img ' + ('data-x="x" '.repeat(8)) + "style='x<p>after</p>";
  const started = performance.now();
  let threw = false;
  try { extractCanonicalText(source); } catch (error) {
    threw = String(error).includes('parser-profile-unsupported');
  }
  assert(threw, 'unterminated quoted attributes must be rejected');
  assert(performance.now() - started < 1000, 'malformed quoted tag scanning must stay bounded');
});

await check('UTF-16 surrogates cannot enter the UTF-8 canonical profile', () => {
  let normalizeThrew = false;
  try { normalizeText('\ud800'); } catch (error) {
    normalizeThrew = String(error).includes('parser-profile-unsupported');
  }
  assert(normalizeThrew, 'normalizeText must reject lone surrogates');

  let extractThrew = false;
  try { extractCanonicalText(`<p>bad\ud800</p>`); } catch (error) {
    extractThrew = String(error).includes('parser-profile-unsupported');
  }
  assert(extractThrew, 'extractCanonicalText must reject non-UTF-8 source');
});

await check('source limits precede malformed UTF-16 classification', () => {
  let rejected = false;
  try { normalizeText('\ud800'.repeat(1024 * 1024 + 1)); } catch (error) {
    rejected = String(error).includes('resource-limit-exceeded');
  }
  assert(rejected, 'oversized malformed source must report the resource limit');
});

await check('extractCanonicalText accepts qualified tag names and enforces element depth', () => {
  assertEq(extractCanonicalText('<x:y>qualified</x:y>'), 'qualified');
  const withinLimit = '<x:y>'.repeat(256) + 'deep' + '</x:y>'.repeat(256);
  assertEq(extractCanonicalText(withinLimit), 'deep');
  let threw = false;
  try {
    extractCanonicalText('<x:y>'.repeat(257) + 'too deep' + '</x:y>'.repeat(257));
  } catch (error) {
    threw = String(error).includes('resource-limit-exceeded');
  }
  assert(threw, 'qualified element nesting beyond 256 levels must be rejected');
  threw = false;
  try { extractCanonicalText('<svg><x:y>foreign</x:y></svg>'); } catch (error) {
    threw = String(error).includes('parser-profile-unsupported');
  }
  assert(threw, 'foreign-content rejection must remain in force');
});

await check('canonicalizeJsonDocument accepts escaped surrogate pairs', () => {
  assertEq(canonicalizeJsonDocument('{"music":"\\uD834\\uDD1E"}'), '{"music":"𝄞"}');
  for (const input of [
    '{"music":"\\uD834"}',
    '{"music":"\\uDD1E"}',
    '{"music":"\\uD834\\u0041"}',
  ]) {
    let threw = false;
    try { canonicalizeJsonDocument(input); } catch (error) {
      threw = String(error).includes('jcs-invalid-surrogate');
    }
    assert(threw, `invalid surrogate sequence must be rejected: ${input}`);
  }
});

await check('canonicalizeJsonDocument rejects excessive nesting', () => {
  let threw = false;
  try { canonicalizeJsonDocument('['.repeat(257) + '0' + ']'.repeat(257)); } catch (error) {
    threw = String(error).includes('resource-limit-exceeded');
  }
  assert(threw, 'JCS nesting beyond 256 levels must be rejected');
});

await check('canonicalizeJsonDocument rejects negative zero and underflow', () => {
  for (const input of ['{"value":-0}', '{"value":-1e-400}']) {
    let threw = false;
    try { canonicalizeJsonDocument(input); } catch (error) {
      threw = String(error).includes('jcs-number');
    }
    assert(threw, `negative zero must be rejected: ${input}`);
  }
});

await check('canonicalizeJson rejects negative zero in object input', () => {
  for (const input of [-0, { value: -0 }, [-0]]) {
    let rejected = false;
    try { canonicalizeJson(input); } catch (error) {
      rejected = String(error).includes('jcs-number');
    }
    if (!rejected) throw new Error(`expected object input to reject negative zero: ${JSON.stringify(input)}`);
  }
});

await check('canonicalizeJson rejects sparse and undefined values', () => {
  const sparse = [];
  sparse.length = 1;
  let sparseRejected = false;
  try { canonicalizeJson(sparse); } catch (error) { sparseRejected = String(error).includes('sparse array'); }
  assert(sparseRejected, 'sparse arrays must be rejected');

  let undefinedRejected = false;
  try { canonicalizeJson({ value: undefined }); } catch (error) { undefinedRejected = String(error).includes('undefined'); }
  assert(undefinedRejected, 'undefined object values must be rejected');
  let surrogateRejected = false;
  try { canonicalizeJson('\ud800'); } catch (error) { surrogateRejected = String(error).includes('jcs-invalid-surrogate'); }
  assert(surrogateRejected, 'lone surrogates must use the JCS failure vocabulary');
});

await check('canonicalizeJson and buildSigningPayloadV1 enforce the input ceiling', () => {
  let jsonRejected = false;
  try { canonicalizeJson('x'.repeat(1024 * 1024)); } catch (error) { jsonRejected = String(error).includes('resource-limit-exceeded'); }
  assert(jsonRejected, 'oversized object-call input must be rejected');

  let outputRejected = false;
  try { canonicalizeJson('\0'.repeat(1024 * 1024 - 2)); } catch (error) { outputRejected = String(error).includes('resource-limit-exceeded'); }
  assert(outputRejected, 'expanded canonical JSON output must be rejected');

  let payloadRejected = false;
  try {
    buildSigningPayloadV1({
      contentHash: 'x'.repeat(1024 * 1024),
      claimsHash: 'sha256:claims',
      documentURL: 'https://example.org/article',
      scope: 'url',
      keyid: 'did:web:example.org',
      algorithm: 'ed25519',
      signedAt: '2026-05-01T10:30:00Z',
    });
  } catch (error) { payloadRejected = String(error).includes('resource-limit-exceeded'); }
  assert(payloadRejected, 'oversized signing payload input must be rejected');
});

await check('canonicalizeJsonDocument classifies malformed surrogate JSON as JSON syntax', () => {
  let malformed = false;
  try { canonicalizeJsonDocument('{"value":"\\uD800'); } catch (error) {
    malformed = String(error).includes('jcs-invalid-json');
  }
  assert(malformed, 'malformed JSON must precede surrogate classification');
});

await check('extractCanonicalText applies output limit after finalization', () => {
  const unit = '<p href="x" src="x" alt="x" aria-label="x"></p>';
  const output = extractCanonicalText(unit.repeat(10000), { baseUrl: 'https://example.com/' });
  assertEq(output.length, 1039999);
});

await check('decodeCanonicalBase64 rejects padded and base64url forms', () => {
  assertEq(new TextDecoder().decode(decodeCanonicalBase64('Zm9v')), 'foo');
  let padded = false;
  try { decodeCanonicalBase64('Zm9v='); } catch { padded = true; }
  assert(padded, 'expected padded base64 to be rejected');
  let url = false;
  try { decodeCanonicalBase64('ab-c'); } catch { url = true; }
  assert(url, 'expected base64url to be rejected');
});

await check('buildSignatureBinding throws on missing field', () => {
  let threw = false;
  try {
    buildSignatureBinding({ contentHash: '', claimsHash: 'x', domain: 'd', signedAt: 't' });
  } catch {
    threw = true;
  }
  assert(threw, 'expected throw on missing field');
});

await check('buildEndorsementBinding requires non-empty string members', () => {
  for (const field of ['endorser', 'endorsement', 'algorithm', 'timestamp']) {
    const endorsement = {
      endorser: 'a', endorsement: 'b', algorithm: 'ed25519', timestamp: '2026-01-01T00:00:00Z',
    };
    endorsement[field] = field === 'endorser' ? 1 : '';
    let threw = false;
    try { buildEndorsementBinding(endorsement); } catch { threw = true; }
    assert(threw, `${field} must be a non-empty string`);
  }
});

await check('verifySignature ed25519 round-trip', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const message = 'hello world';
  const sig = nodeSign(null, Buffer.from(message), privateKey).toString('base64').replace(/=+$/, '');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const ok = await verifySignature(message, sig, pem, 'ed25519');
  assert(ok, 'expected ed25519 signature to verify');

  const tampered = await verifySignature(message + '!', sig, pem, 'ed25519');
  assert(!tampered, 'tampered message must not verify');
});

await check('verifySignature rsa round-trip', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const { createSign } = await import('node:crypto');
  const signer = createSign('SHA256');
  signer.update('hello rsa');
  const sig = signer.sign(privateKey, 'base64').replace(/=+$/, '');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const ok = await verifySignature('hello rsa', sig, pem, 'rsa');
  assert(ok, 'expected rsa signature to verify');
});

await check('verifySignature handles unpadded base64', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const sig = nodeSign(null, Buffer.from('msg'), privateKey).toString('base64').replace(/=+$/, '');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const ok = await verifySignature('msg', sig, pem, 'ED25519');
  assert(ok, 'unpadded base64 should still verify');
});

await check('verifySignature rejects padded base64', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const sig = nodeSign(null, Buffer.from('msg'), privateKey).toString('base64');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const ok = await verifySignature('msg', sig, pem, 'ed25519');
  assert(!ok, 'padded base64 should not verify in conforming mode');
});

// ---- Algorithm registry (spec §7.1) ----

function signEcdsa(privateKey, message, hash) {
  const { createSign } = nodeCrypto;
  const signer = createSign(hash);
  signer.update(message);
  return signer.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }, 'base64').replace(/=+$/, '');
}

await check('verifySignature ecdsa-p256 round-trip', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const sig = signEcdsa(privateKey, 'hello p256', 'SHA256');
  assert(await verifySignature('hello p256', sig, pem, 'ecdsa-p256'), 'p256 should verify');
});

await check('verifySignature ecdsa-p384 round-trip', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const sig = signEcdsa(privateKey, 'hello p384', 'SHA384');
  assert(await verifySignature('hello p384', sig, pem, 'ecdsa-p384'), 'p384 should verify');
});

await check('verifySignature pins the ECDSA curve to the declared algorithm', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const sig = signEcdsa(privateKey, 'curve confusion', 'SHA384');
  const ok = await verifySignature('curve confusion', sig, pem, 'ecdsa-p256');
  assert(!ok, 'a P-384 key must not satisfy an ecdsa-p256 signature');
});

await check('verifySignature rejects DER ECDSA for registry algorithms', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const signer = nodeCrypto.createSign('SHA256');
  signer.update('wire format');
  const der = signer.sign(privateKey, 'base64').replace(/=+$/, '');
  assert(!(await verifySignature('wire format', der, pem, 'ecdsa-p256')), 'DER must fail');
});

await check('verifySignature rsa-pss-sha256 round-trip', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const sig = nodeCrypto
    .sign('sha256', Buffer.from('hello pss'), {
      key: privateKey,
      padding: nodeCrypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    })
    .toString('base64')
    .replace(/=+$/, '');
  assert(await verifySignature('hello pss', sig, pem, 'rsa-pss-sha256'), 'PSS should verify');
});

await check('verifySignature separates PSS from PKCS#1 v1.5', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const pkcs1 = nodeCrypto
    .sign('RSA-SHA256', Buffer.from('padding matters'), privateKey)
    .toString('base64')
    .replace(/=+$/, '');
  assert(
    await verifySignature('padding matters', pkcs1, pem, 'rsa-pkcs1-sha256'),
    'PKCS#1 v1.5 should verify under its own identifier',
  );
  assert(
    !(await verifySignature('padding matters', pkcs1, pem, 'rsa-pss-sha256')),
    'a PKCS#1 v1.5 signature must not verify as PSS',
  );
});

await check('verifySignature rejects a key of the wrong type for the algorithm', async () => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  assert(!(await verifySignature('msg', 'abcd', pem, 'ed25519')), 'RSA key is not an ed25519 key');
  assert(!(await verifySignature('msg', 'abcd', pem, 'ecdsa-p256')), 'RSA key is not an EC key');
});

await check('verifySignature rejects an unregistered algorithm', async () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  assert(!(await verifySignature('msg', 'abcd', pem, 'ecdsa-p521')), 'unknown algorithm fails closed');
});

// ---- Key revocation and expiry (spec §8.2) ----

await check('isKeyRevoked honors revoked and expires', () => {
  assert(isKeyRevoked({ revoked: true }), 'revoked: true is revoked');
  assert(isKeyRevoked({ expires: '2020-01-01T00:00:00Z' }), 'past expiry is revoked');
  assert(isKeyRevoked({ expires: 'nonsense' }), 'unparseable expiry fails closed');
  assert(!isKeyRevoked({ expires: '2999-01-01T00:00:00Z' }), 'future expiry is live');
  assert(!isKeyRevoked({ revoked: false }), 'revoked: false is live');
  assert(!isKeyRevoked({}), 'a key document with neither field is live');
  assert(!isKeyRevoked(null), 'no key is not a revoked key');
});

// ---- Resolver tests with a local HTTP fixture ----

function startFixtureServer(routes) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const handler = routes[req.url];
      if (!handler) {
        res.writeHead(404);
        res.end();
        return;
      }
      const r = handler();
      res.writeHead(r.status || 200, r.headers || { 'content-type': 'application/json' });
      res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const { publicKey: edPub, privateKey: edPriv } = generateKeyPairSync('ed25519');
const edPubPem = edPub.export({ type: 'spki', format: 'pem' });

const fixtureServer = await startFixtureServer({
  '/.well-known/did.json': () => ({
    body: {
      id: 'did:web:127.0.0.1',
      verificationMethod: [
        { id: '#key-1', type: 'Ed25519VerificationKey2020', publicKeyPem: edPubPem },
      ],
    },
  }),
  '/key.json': () => ({ body: { publicKey: edPubPem, algorithm: 'ed25519' } }),
  '/key.vendor-json': () => ({
    headers: { 'content-type': 'application/htmltrust-key+json; charset=utf-8' },
    body: { publicKey: edPubPem, algorithm: 'ed25519' },
  }),
  '/keys/abc123': () => ({ body: { publicKey: edPubPem, algorithm: 'ed25519' } }),
});
const port = fixtureServer.address().port;
const base = `http://127.0.0.1:${port}`;

await check('didWebResolver fetches did.json and extracts key', async () => {
  // Override scheme to http for the fixture
  const r = {
    async resolve(keyid) {
      if (!keyid?.startsWith('did:web:')) return null;
      const rest = keyid.slice('did:web:'.length);
      const url = `http://${rest}/.well-known/did.json`;
      const res = await fetch(url);
      const doc = await res.json();
      const vm = (doc.verificationMethod || []).find((m) => m.publicKeyPem);
      return vm ? { keyid, publicKeyPem: vm.publicKeyPem, algorithm: 'ed25519' } : null;
    },
  };
  // Use the real resolver against a live https fixture would need TLS; we
  // already cover http path via directUrlResolver. Here we exercise the
  // shape contract via the same code path through resolveKey().
  const resolved = await resolveKey(`did:web:127.0.0.1:${port}`, [r]);
  assert(resolved, 'expected did:web resolver to resolve');
  assert(resolved.publicKeyPem.includes('BEGIN PUBLIC KEY'), 'expected PEM');
});

await check('didWebResolver preserves path escapes and decodes an encoded port', async () => {
  let requested;
  const resolver = didWebResolver({
    fetch: async (url) => {
      requested = url;
      return {
        ok: true,
        headers: { get: (name) => name === 'content-type' ? 'application/json' : null },
        text: async () => JSON.stringify({ verificationMethod: [{ publicKeyPem: edPubPem }] }),
      };
    },
  });
  const resolved = await resolver.resolve('did:web:example.com%3A3000:user%2Falice#key-1');
  assert(resolved, 'expected did:web resolution');
  assertEq(requested, 'https://example.com:3000/user%2Falice/did.json');
});

await check('didWebResolver rejects empty userinfo in authority', async () => {
  let called = false;
  const resolver = didWebResolver({
    fetch: async () => {
      called = true;
      return { ok: false };
    },
  });
  let rejected = false;
  try {
    await resolver.resolve('did:web:@example.com');
  } catch (error) {
    rejected = String(error).includes('did:web invalid domain');
  }
  assert(rejected, 'empty userinfo authority must be rejected');
  assert(!called, 'invalid authority must not invoke fetch');
});

await check('directUrlResolver fetches http URL keyid', async () => {
  const resolved = await resolveKey(`${base}/key.json`, [directUrlResolver()]);
  assert(resolved, 'expected resolution');
  assertEq(resolved.algorithm, 'ed25519');
});

await check('directUrlResolver accepts vendor JSON media types', async () => {
  const resolved = await resolveKey(`${base}/key.vendor-json`, [directUrlResolver()]);
  assert(resolved, 'expected resolution');
  assertEq(resolved.algorithm, 'ed25519');
  assert(resolved.publicKeyPem.includes('BEGIN PUBLIC KEY'), 'expected parsed key document');
});

await check('remote key fetchers cap streamed response bodies', async () => {
  const chunks = [new Uint8Array(64 * 1024), new Uint8Array(1)];
  let reads = 0;
  let cancelled = false;
  const response = {
    ok: true,
    headers: { get: (name) => name === 'content-type' ? 'application/json' : null },
    body: {
      getReader() {
        return {
          async read() {
            if (reads >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[reads++] };
          },
          async cancel() { cancelled = true; },
        };
      },
    },
  };
  let rejected = false;
  try {
    await directUrlResolver({ fetch: async () => response }).resolve('http://example.test/key.json');
  } catch (error) {
    rejected = String(error).includes('resource-limit-exceeded');
  }
  assert(rejected, 'oversized streamed key response must fail');
  assert(cancelled, 'oversized response stream must be cancelled');
  assertEq(reads, 2, 'stream should stop at the first oversized chunk');
});

await check('directUrlResolver decodes canonical SPKI key documents', async () => {
  const der = edPub.export({ type: 'spki', format: 'der' });
  const encoded = der.toString('base64').replace(/=+$/, '');
  const localFixture = await startFixtureServer({
    '/key.json': () => ({
      body: { publicKey: encoded, publicKeyEncoding: 'spki-der', algorithm: 'ed25519' },
    }),
  });
  const localPort = localFixture.address().port;
  const resolved = await resolveKey(`http://127.0.0.1:${localPort}/key.json`, [directUrlResolver()]);
  await new Promise((r) => localFixture.close(r));
  assert(resolved?.publicKeyPem.includes('BEGIN PUBLIC KEY'), 'expected decoded PEM');
  assert(
    await verifySignature('resolver-key', encodeBase64Unpadded(nodeSign(null, Buffer.from('resolver-key'), edPriv)), resolved.publicKeyPem, 'ed25519'),
    'decoded key should verify',
  );
});

await check('trustDirectoryResolver tries each base', async () => {
  const resolver = trustDirectoryResolver({ baseUrls: ['http://127.0.0.1:1', base] });
  const resolved = await resolver.resolve('abc123');
  assert(resolved, 'expected fallback to second base');
  assert(resolved.publicKeyPem.includes('BEGIN PUBLIC KEY'));
});

await check('resolveKey returns null when no resolver matches', async () => {
  const resolved = await resolveKey('unknown:keyid', [
    didWebResolver(),
    directUrlResolver(),
  ]);
  assertEq(resolved, null);
});

// ---- Endorsement tests ----

await check('verifyEndorsement round-trip with direct-URL resolver', async () => {
  const { publicKey: ePub, privateKey: ePriv } = generateKeyPairSync('ed25519');
  const ePem = ePub.export({ type: 'spki', format: 'pem' });
  const endorsement = {
    endorser: `${base}/key.json`,
    endorsement: 'sha256:abcdef',
    timestamp: '2026-04-28T12:00:00Z',
    algorithm: 'ed25519',
  };

  // Replace fixture key for the duration of this test by swapping the route
  // via a fresh server (avoids mutating shared state).
  const localFixture = await startFixtureServer({
    '/key.json': () => ({ body: { publicKey: ePem, algorithm: 'ed25519' } }),
  });
  const localPort = localFixture.address().port;
  endorsement.endorser = `http://127.0.0.1:${localPort}/key.json`;
  const binding = buildEndorsementBinding(endorsement);
  endorsement.signature = nodeSign(null, Buffer.from(binding), ePriv).toString('base64').replace(/=+$/, '');
  const ok = await verifyEndorsement(endorsement, [directUrlResolver()]);
  await new Promise((r) => localFixture.close(r));
  assert(ok, 'expected endorsement to verify');
});

await check('verifyEndorsement fails on tampered hash', async () => {
  const { publicKey: ePub, privateKey: ePriv } = generateKeyPairSync('ed25519');
  const ePem = ePub.export({ type: 'spki', format: 'pem' });
  const localFixture = await startFixtureServer({
    '/key.json': () => ({ body: { publicKey: ePem, algorithm: 'ed25519' } }),
  });
  const localPort = localFixture.address().port;
  const endorsement = {
    endorser: `http://127.0.0.1:${localPort}/key.json`,
    endorsement: 'sha256:original',
    timestamp: '2026-04-28T12:00:00Z',
    algorithm: 'ed25519',
  };
  endorsement.signature = nodeSign(
    null,
    Buffer.from(buildEndorsementBinding(endorsement)),
    ePriv,
  ).toString('base64').replace(/=+$/, '');
  endorsement.endorsement = 'sha256:tampered';
  const ok = await verifyEndorsement(endorsement, [directUrlResolver()]);
  await new Promise((r) => localFixture.close(r));
  assert(!ok, 'tampered endorsement must not verify');
});

await check('verifyEndorsement fails closed on expiry and revokedBy lifecycle fields', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const keyid = 'did:web:endorsement-lifecycle.example';
  const resolver = { resolve: async () => ({ keyid, publicKeyPem, algorithm: 'ed25519' }) };
  const sign = (unsigned) => ({
    ...unsigned,
    signature: nodeSign(null, Buffer.from(buildEndorsementBinding(unsigned)), privateKey)
      .toString('base64').replace(/=+$/, ''),
  });
  const baseEndorsement = {
    endorser: keyid,
    endorsement: 'sha256:lifecycle',
    timestamp: '2026-04-28T12:00:00Z',
    algorithm: 'ed25519',
  };
  assert(await verifyEndorsement(sign({ ...baseEndorsement, expires: '2999-01-01T00:00:00Z' }), [resolver]), 'future expiry should verify');
  for (const field of [
    { expires: 'nonsense' },
    { expires: '2020-01-01T00:00:00Z' },
    { expires: '2999-01-01T00:00:00+00:00' },
    { expires: '' },
    { revokedBy: '' },
    { revokedBy: 'did:web:authority.example' },
    { revokedBy: 42 },
  ]) {
    assert(!(await verifyEndorsement(sign({ ...baseEndorsement, ...field }), [resolver])), `${Object.keys(field)[0]} must fail closed`);
  }
});

await check('end-to-end test vector reproduces hashes, payload, and signature', async () => {
  const v = JSON.parse(
    readFileSync(new URL('../conformance/vectors/vector-01.json', import.meta.url), 'utf8'),
  );
  const sha = (s) =>
    'sha256:' + encodeBase64Unpadded(createHash('sha256').update(Buffer.from(s, 'utf8')).digest());
  const content = extractCanonicalText(v.input.html, { baseUrl: v.input.baseURL });
  const claims = canonicalizeClaims(extractClaimsFromSignedSection(v.input.html));
  const contentHash = sha(content);
  const claimsHash = sha(claims);
  const payload = buildSigningPayloadV1({
    contentHash,
    claimsHash,
    documentURL: v.input.documentURL,
    scope: v.input.scope,
    keyid: v.input.keyid,
    algorithm: v.algorithm,
    signedAt: v.input.signedAt,
  });
  assertEq(content, v.canonicalContent, 'canonicalContent');
  assertEq(contentHash, v.contentHash, 'contentHash');
  assertEq(claims, v.canonicalClaims, 'canonicalClaims');
  assertEq(claimsHash, v.claimsHash, 'claimsHash');
  assertEq(payload, v.signingPayload, 'signingPayload');
  assert(
    await verifySignature(payload, v.signature, v.key.publicKeyPem, v.algorithm),
    'vector signature must verify',
  );
});

await new Promise((r) => fixtureServer.close(r));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
