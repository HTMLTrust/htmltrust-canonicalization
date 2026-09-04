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


## Licensing your contribution

This project uses the [Developer Certificate of Origin](DCO), not a contributor
licence agreement. There is nothing to sign and nobody to email. You keep the
copyright in what you write.

Sign off each commit, which certifies you have the right to submit it under the
project's licence:

```sh
git commit -s -m "your message"
```

That adds a `Signed-off-by: Your Name <you@example.com>` trailer. Use a real
name and a real address. The full text of what you are certifying is in
[DCO](DCO); it is four short clauses and worth reading once.

Your contribution is licensed to the project on the same terms the project uses,
which is the Apache License 2.0 in `LICENSE`. That includes
the patent grant in section 3, which is what makes the code safe for others
to implement against. No additional rights are transferred, and there is no
copyright assignment.

One consequence worth stating plainly: because contributors keep their
copyright, changing the project's licence later would need the agreement of
everyone who has contributed. That is the deliberate trade for having no CLA to
sign, and it is why the licence was settled before inviting contributions.

## Verifying sign-off locally

```sh
git log --format='%h %s%n    %(trailers:key=Signed-off-by)' origin/main..HEAD
```

Every commit in the range should show a trailer. To add one to the last commit:

```sh
git commit --amend -s --no-edit
```
