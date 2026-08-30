# HTMLTrust canonicalization repo Makefile.
#
# The cross-language conformance suite is the public contract: every
# implementation must produce byte-identical output for every fixture
# under `conformance/fixtures/`. `make conformance` exercises every
# Rust-backed language adapter.

.PHONY: test-docker test-shared-core core-artifacts conformance conformance-update conformance-js conformance-go \
        conformance-php conformance-python conformance-rust help

help:
	@echo "Targets:"
	@echo "  test-docker         Build Rust core and test every adapter."
	@echo "  test-shared-core    Alias for test-docker."
	@echo "  core-artifacts      Build only the Rust native/WASM artifacts."
	@echo "  conformance         Run every per-language conformance runner."
	@echo "  conformance-update  Regenerate fixture 'expected' fields from Rust."
	@echo "  conformance-<lang>  Run a single language's runner (js, go,"
	@echo "                      php, python, rust)."

conformance:
	./conformance/run-all.sh

test-docker:
	./scripts/test-in-docker.sh

test-shared-core:
	./scripts/test-in-docker.sh

core-artifacts:
	./scripts/test-in-docker.sh --artifacts-only

# Regenerate fixture expected fields from Rust, then verify all adapters
# against those values.
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
