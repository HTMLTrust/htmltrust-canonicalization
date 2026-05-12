# HTMLTrust canonicalization repo Makefile.
#
# The cross-language conformance suite is the public contract: every
# implementation must produce byte-identical output for every fixture
# under `conformance/fixtures/`. `make conformance` exercises every
# runnable language.

.PHONY: conformance conformance-update conformance-js conformance-go \
        conformance-php conformance-python conformance-rust help

help:
	@echo "Targets:"
	@echo "  conformance         Run every per-language conformance runner."
	@echo "  conformance-update  Regenerate fixture 'expected' fields from"
	@echo "                      the current Python+Rust output."
	@echo "  conformance-<lang>  Run a single language's runner (js, go,"
	@echo "                      php, python, rust)."

conformance:
	./conformance/run-all.sh

# Regenerate fixture expected fields. Run each available language with
# --update; later runs overwrite earlier ones if they disagree, which
# is what you want -- the last language to run is the source of truth.
#
# We run Rust last because it's the only non-Python language that
# implements extract/ and claims/; if you want Python to win, swap the
# order in run-all.sh's language list.
conformance-update:
	./conformance/run-all.sh --update

conformance-js:
	node conformance/runners/run-javascript.mjs

conformance-go:
	cd conformance/runners && go run ./run-go.go

conformance-php:
	php conformance/runners/run-php.php

conformance-python:
	python3 conformance/runners/run-python.py

conformance-rust:
	cargo run --quiet --release \
	    --manifest-path conformance/runners/run-rust/Cargo.toml
