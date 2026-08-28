# Cross-language conformance suite

This directory defines the byte-level contract for the HTMLTrust
Canonicalization bindings. A fixture contains one input and the output that
every binding must produce. A changed canonical output is a protocol change.

Status: required for binding changes
Readers: binding contributors and release reviewers

## Run the suite

Run every unit suite and this conformance suite in containers from a clean
checkout:

```sh
./scripts/test-in-docker.sh
```

From the repository root, install the dependencies for the bindings you want
to run, then run:

```sh
make conformance
```

The command runs JavaScript, Go, PHP, Python, and Rust in that order. A
missing executable is reported as `MISSING` and does not fail a local run.
Require every toolchain in CI or before a release:

```sh
REQUIRE_ALL_LANGUAGES=1 make conformance
```

Run one binding while developing:

```sh
make conformance-js
make conformance-go
make conformance-php
make conformance-python
make conformance-rust
```

The runners also work directly:

```sh
node conformance/runners/run-javascript.mjs
(cd conformance/runners && go run ./run-go.go)
php conformance/runners/run-php.php
python3 conformance/runners/run-python.py
cargo run --locked --release --manifest-path conformance/runners/run-rust/Cargo.toml
```

Each runner prints one line per fixture:

```text
PASS conformance/fixtures/normalize/basic-ascii.json
FAIL conformance/fixtures/normalize/curly-double-quotes.json
  expected: "\"Hello\""
  got:      "“Hello”"
PASS conformance/fixtures/extract/url-http-rejected.json  (expected error url-policy-violation)
```

Exit status `0` means every applicable fixture passed. Exit status `1` means
an output or expected error differed. A missing toolchain becomes exit status
`2` when `REQUIRE_ALL_LANGUAGES=1`.

## Fixture suites

The directory contains four suites:

| Directory | Binding function | Input |
|---|---|---|
| `normalize/` | `normalizeText` | A text string |
| `extract/` | `extractCanonicalText` | An HTML fragment, with optional `baseURL` |
| `claims/` | `canonicalizeClaims` | A JSON object whose values are strings |
| `jcs/` | `canonicalizeJsonDocument` | A raw JSON document string |

Every fixture is a JSON object with a matching filename and `name` field:

```json
{
  "name": "curly-double-quotes",
  "description": "Curly quotes become ASCII quotation marks.",
  "input": "“Hello”",
  "expected": "\"Hello\""
}
```

`expected` is compared as a string. The runners encode and compare the UTF-8
bytes returned by each binding. A fixture may include:

- `baseURL` for resolving relative `href` and `src` values.
- `repeat` for testing resource limits without storing a large input file.
  String inputs are repeated directly. For a claims object, every string value
  is repeated while claim names remain unchanged.
- `error` when the binding must reject the input. The value is a stable error
  code such as `resource-limit-exceeded` or `url-policy-violation`.

Use `\uXXXX` escapes for invisible or combining characters when the exact code
point matters. Keep the description specific about the rule under test.

## Add or change a fixture

1. Add a JSON file to the suite directory. The filename and `name` must match.
2. Set `expected` to an empty string while writing the case.
3. Generate the expected value from the current Python binding:

   ```sh
   python3 conformance/runners/run-python.py --update
   ```

4. Inspect the diff. Run every available binding:

   ```sh
   REQUIRE_ALL_LANGUAGES=1 make conformance
   ```

5. If a binding disagrees, fix the binding or document the known divergence.
   Do not change `expected` to hide a disagreement.

The update command rewrites all fixture `expected` fields. Review every
changed file before committing.

## Fixture count

The runner counts JSON files from disk and prints the count in its summary.
The same command shows the current total without running a binding:

```sh
find conformance/fixtures -mindepth 2 -maxdepth 2 -type f -name '*.json' | wc -l
```

This count includes all four suites, including expected-error cases.

## Binding coverage

The five in-tree bindings currently implement every suite:

| Function | JavaScript | Go | PHP | Python | Rust |
|---|:---:|:---:|:---:|:---:|:---:|
| `normalizeText` | yes | yes | yes | yes | yes |
| `extractCanonicalText` | yes | yes | yes | yes | yes |
| `canonicalizeClaims` | yes | yes | yes | yes | yes |
| `canonicalizeJsonDocument` | yes | yes | yes | yes | yes |

A future runner may print `SKIP` for a suite that its binding does not
implement. `SKIP` is informational; an implemented fixture that differs is a
failure.

## Files in this directory

```text
conformance/
  README.md
  run-all.sh
  fixtures/{normalize,extract,claims,jcs}/
  runners/
    run-javascript.mjs
    run-go.go
    run-php.php
    run-python.py
    run-rust/
```

The runner modules use the local bindings. They do not download a published
version of this repository, so a conformance run always tests the checkout
under review.
