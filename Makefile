# HTMLTrust canonicalization repo Makefile.
#
# The cross-language conformance suite is the public contract: every
# implementation must produce byte-identical output for every fixture
# under `conformance/fixtures/`. `make conformance` exercises every
# runnable language.

.PHONY: test-docker test-independent test-shared-core conformance conformance-update conformance-js conformance-go \
        conformance-php conformance-python conformance-rust help

help:
	@echo "Targets:"
	@echo "  test-docker         Test independent bindings and shared-core adapters."
	@echo "  test-independent    Test the five independent binding implementations."
	@echo "  test-shared-core    Build and validate Rust core adapters."
	@echo "  conformance         Run every per-language conformance runner."
	@echo "  conformance-update  Regenerate fixture 'expected' fields from"
	@echo "                      the current Python+Rust output."
	@echo "  conformance-<lang>  Run a single language's runner (js, go,"
	@echo "                      php, python, rust)."

conformance:
	./conformance/run-all.sh

test-docker:
	./scripts/test-in-docker.sh

test-independent:
	./scripts/test-in-docker.sh --independent-only

test-shared-core:
	./scripts/test-in-docker.sh --shared-core-only

# Regenerate fixture expected fields. Run each available language with
# --update; later runs overwrite earlier ones if they disagree, which
# is what you want -- the last language to run is the source of truth.
#
# Every binding implements all four suites. Rust runs last, so update mode uses
# the Rust output when implementations disagree.
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
	cargo run --quiet --release --locked \
	    --manifest-path conformance/runners/run-rust/Cargo.toml
