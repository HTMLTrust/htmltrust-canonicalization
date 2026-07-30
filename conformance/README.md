# Cross-language conformance suite

This directory is the **public contract** between every HTMLTrust
canonicalization binding (JavaScript, Go, PHP, Python, Rust). Every
implementation must produce **byte-identical** output for every fixture
under `fixtures/`. If two languages disagree on a fixture, that's a real
bug; the fixture itself defines the spec.

## Layout

```
conformance/
  README.md                  -- this file
  run-all.sh                 -- invokes every runner; non-zero on any divergence
  fixtures/
    normalize/               -- normalize_text input/expected pairs
    extract/                 -- extract_canonical_text input/expected pairs
    claims/                  -- canonicalize_claims input/expected pairs
  runners/
    run-javascript.mjs       -- Node 18+ ESM runner
    run-go.go                -- single-file `go run` runner
    run-php.php              -- PHP 7.2+ runner (requires ext-intl)
    run-python.py            -- Python 3.10+ runner
    run-rust/                -- tiny Cargo bin crate that vendors the in-tree binding
    go.mod                   -- tells `go run` to use the local `go/` binding
```

## Running

```sh
# Run everything (from repo root):
make conformance

# Run a single language:
make conformance-js
make conformance-go
make conformance-php
make conformance-python
make conformance-rust

# Or invoke a runner directly:
node    conformance/runners/run-javascript.mjs
cd conformance/runners && go run ./run-go.go
php     conformance/runners/run-php.php
python3 conformance/runners/run-python.py
cargo run --release --manifest-path conformance/runners/run-rust/Cargo.toml
```

Every runner prints one line per fixture:

```
PASS conformance/fixtures/normalize/basic-ascii.json
FAIL conformance/fixtures/normalize/curly-double-quotes.json
  expected: "\"Hello\""
  got:      "“Hello”"
SKIP conformance/fixtures/extract/simple-paragraph.json  (binding does not implement extract)
```

A runner exits 0 if every applicable fixture passes, 1 otherwise. The
`SKIP` status is **never** a failure -- it just means the binding hasn't
implemented that function yet (see [Binding coverage](#binding-coverage)
below).

`run-all.sh` exits 0 only when every available runner exits 0.
Missing toolchains (e.g. no `php` on a CI image) are reported but
don't fail the build by default -- set `REQUIRE_ALL_LANGUAGES=1` to
make them hard-fail.

## Fixture format

Every fixture is a self-contained JSON object:

```json
{
  "name": "curly-double-quotes",
  "description": "U+201C / U+201D collapse to ASCII double quote U+0022.",
  "input": "“Hello”",
  "expected": "\"Hello\""
}
```

- `input` is the raw value passed to the binding function:
  - `normalize/` -- a string
  - `extract/` -- an HTML fragment as a string
  - `claims/` -- a JSON object of `name -> value` pairs serialized as `name:content\n`
- `expected` is the byte-exact output the function must return.
- Both `input` and `expected` may contain literal non-ASCII characters
  (JSON allows it). Use Unicode escape sequences (`\uXXXX`) when the
  exact code point matters and the literal character would be
  ambiguous (combining marks, invisible characters, etc.).

## Authoring new fixtures

The recommended flow:

1. **Write the fixture with `input` only** and `"expected": ""`. The
   filename and the `name` field must match (e.g. `my-case.json` with
   `"name": "my-case"`).

2. **Populate `expected` from a known-good runner.** Python remains a
   convenient source of truth for parser-heavy `extract/` cases. The current
   JS, Go, PHP, Python, and Rust runners all cover the shared normalize,
   extract, and claims suites when their toolchains are installed:

   ```sh
   python3 conformance/runners/run-python.py --update
   ```

   Inspect the diff: the new fixture's `expected` is now populated.

3. **Verify every other runner agrees** without `--update`:

   ```sh
   make conformance
   ```

   If they all PASS, your fixture is consensus. Commit it.

4. **If a runner diverges**, you've either found a real bug in a
   binding or written a fixture that exposes a known-divergent area
   (see [Known divergences](#known-divergences) below). Discuss with
   the orchestrator before "fixing" anything -- silently editing the
   binding to match Python defeats the point of having a conformance
   suite.

## Binding coverage

The five bindings now implement the shared normalize/extract/claims surface.
The runners still report `SKIP` if a future fixture targets a function a
binding cannot run.

| Function                 | JS  | Go  | PHP | Python | Rust |
|--------------------------|:---:|:---:|:---:|:------:|:----:|
| `normalizeText`          | YES | YES | YES |  YES   | YES  |
| `extractCanonicalText`   | YES | YES | YES |  YES   | YES  |
| `canonicalizeClaims`     | YES | YES | YES |  YES   | YES  |

## Known divergences

None at the time of the current protocol cleanup. JS, Go, Python, and Rust
agree byte-for-byte on every fixture on the current development machine; PHP
was not installed locally for that run.

If divergences appear in the future, add them here with the fixture
name, the diverging language(s), and a one-line root-cause sketch.
**Do not** modify the fixture's `expected` to paper over a divergence
-- the whole point of the suite is that it catches drift.

## Fixture inventory

`normalize/` (22 cases): basic ASCII, empty, whitespace edge cases,
NFKC compatibility forms, curly/CJK/guillemet quotation marks,
dashes, ellipsis, ZWSP stripping, ZWNJ/ZWJ preservation, Arabic
tatweel, BOM, bidi controls.

`extract/` (14 cases): paragraphs, inline elements, block boundaries,
nested structure, lists, tables, excluded elements (script/style/meta),
entity decoding, inline anchors, mixed inline formatting,
post-extraction normalization, headings, `br`, signed semantic attributes.

`claims/` (7 cases): empty, single claim, multi-claim ordering, value
normalization, name normalization, NFKC inside values, internal newlines.

Total: 43 fixtures.
