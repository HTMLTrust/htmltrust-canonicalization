# Contributing

Changes to HTMLTrust Canonicalization are welcome. Rust owns every canonical
byte. JavaScript, Go, Python, and PHP provide adapters plus their native
signing, resolver, and authoring APIs.

## Before you start

Install Git and Docker Engine with the Compose plugin. Open an issue before a
protocol change, a new normalization rule, or a public API break. State the
input and expected bytes or error code. Describe the compatibility effect.

## Make a change

1. Fork the repository and create a focused branch.
2. Change canonicalization behavior in `rust/`.
3. Add a fixture under `conformance/fixtures/` for each protocol behavior.
4. Update an adapter only when its boundary or native API changes.
5. Run the complete check from the repository root:

```sh
make test-docker
```

The command builds one native and WebAssembly artifact set and exercises each
source and installed package. Every language runs all 130 fixtures. Include
the command and result in the pull request.

## Pull requests

Describe the observable behavior and any public API changes. Include the
stable error code when failure behavior changes. Keep generated build output
out of Git; the Docker pipeline writes it to a disk-backed artifact directory.

Bug fixes, security work, performance changes, documentation, and new language
adapters belong in this repository. A new adapter must call the Rust core and
pass the conformance suite.

Decisions about acceptable signers or content belong to applications and trust
directory operators. Issues about political, religious, or philosophical
trust policies are outside this repository's scope.

## Legal and attribution

Contributions use the repository license. Keep existing copyright, license,
and notice text intact. Briefly disclose substantial AI assistance in the pull
request description.

Technical disagreements should include a reproducible input and observed
output. Cite the relevant protocol text.
