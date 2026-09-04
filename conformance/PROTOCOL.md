# HTMLTrust conformance protocol v1

How an implementation in any language proves it canonicalizes correctly.

**Status:** Stable for the v0.3 fixture set
**Readers:** Anyone implementing HTMLTrust canonicalization
**Reading time:** 5 minutes

This protocol exists so that testing an implementation does not require adding
a runner to this repository. Implement one program that speaks JSON Lines on
stdin and stdout, and the driver here will exercise it against every fixture.

Passing this suite is also the single condition in the
[trademark policy](https://www.htmltrust.org/trademark/) for calling an
implementation HTMLTrust. The gate is public and the same for everyone,
including this project's own bindings.

## The contract

Your program reads one JSON object per line from stdin and writes one JSON
object per line to stdout. Requests may arrive faster than you answer them,
but responses must carry the `id` they answer, so order does not matter.

### Request

```json
{"id": "extract/basic-text", "suite": "extract", "input": "<p>hi</p>", "baseURL": "https://example.com/a", "repeat": 1}
```

| Field | Always present | Meaning |
|---|---|---|
| `id` | yes | Opaque. Echo it back. |
| `suite` | yes | One of `normalize`, `extract`, `claims`, `jcs`. |
| `input` | yes | The bytes to process, as a JSON string. |
| `baseURL` | no | Base for resolving relative URLs in `extract`. Absent means no base, and a relative URL must then fail with `attribute-canonicalization-failed`. |
| `repeat` | no | Repeat `input` this many times before processing. Used by resource-limit fixtures so the file does not have to carry megabytes. Default 1. |

### Response

Exactly one of `output` or `error`:

```json
{"id": "extract/basic-text", "output": "hi"}
{"id": "extract/bad-url", "error": "url-policy-violation"}
```

| Field | Meaning |
|---|---|
| `output` | The canonical result, as a JSON string. Compared byte for byte. |
| `error` | The rejection code. Compared exactly. |

Writing both, or neither, is a protocol violation and fails the fixture.

### What each suite means

| Suite | Input | Output |
|---|---|---|
| `normalize` | Text | The text after the eight normalization phases |
| `extract` | An HTML fragment | Canonical text extracted from it, including signed attribute records |
| `claims` | JSON claims | The canonical claims serialization |
| `jcs` | JSON | RFC 8785 canonical JSON |

### Rejection codes

An implementation must reject what the profile rejects, with the same code.
Accepting input the profile rejects is a conformance failure even if nothing
crashes, because a verifier that accepts more than the specification is a
verifier that will disagree with every other one.

The ten codes in the current fixture set:

```
attribute-canonicalization-failed   claim-duplicate
claim-malformed                     parser-profile-unsupported
resource-limit-exceeded             url-policy-violation
```

plus four more that appear in individual fixtures. Read them out of the
fixtures rather than hardcoding this list; the driver reports any code it sees
that you did not produce.

## Running the driver

```sh
# Your implementation, however it starts:
python3 conformance/run-external.py -- ./my-canonicalizer
python3 conformance/run-external.py -- node ./my-runner.mjs
python3 conformance/run-external.py -- cargo run --quiet --bin conformance
```

Useful flags:

```sh
--suite extract        # one suite only
--verify-fixtures      # check the fixtures have not been altered, then run
--json report.json     # machine-readable results
--timeout 30           # per-fixture seconds, default 30
```

Exit codes: `0` every fixture passed, `1` at least one diverged, `2` the
implementation crashed or violated the protocol.

## A minimal implementation, in full

```python
#!/usr/bin/env python3
import json, sys
for line in sys.stdin:
    req = json.loads(line)
    text = req["input"] * req.get("repeat", 1)
    try:
        out = canonicalize(req["suite"], text, req.get("baseURL"))
        print(json.dumps({"id": req["id"], "output": out}), flush=True)
    except HTMLTrustError as exc:
        print(json.dumps({"id": req["id"], "error": exc.code}), flush=True)
```

That is the whole integration surface. Everything else is your canonicalizer.

## Fixture integrity

`fixtures.sha256` records a hash for every fixture. `--verify-fixtures`
checks them before running.

This matters more than it looks. The internal runners support `--update`,
which rewrites `expected` from whatever the implementation just produced. That
is a reasonable tool for changing the core deliberately, and a trivial way to
make any implementation pass by redefining correct. **Never run `--update` to
make a failing implementation pass.** If your output disagrees with a fixture,
either your implementation is wrong or the specification is ambiguous, and the
second case is worth an issue rather than an edit.

## When a fixture looks wrong

Open an issue. Five independently written implementations were reconciled
against these fixtures before v0.3.0, and every disagreement found during that
work turned out to be an ambiguity in the specification text rather than a bug
in one implementation. A disagreement is evidence about the prose, which makes
it more valuable than a passing run.
