#!/usr/bin/env bash
set -euo pipefail

language="${1:?language is required}"

missing() {
  echo "ERROR shared-core ${language}: maintained adapter test is missing" >&2
  exit 2
}

require_native_artifact() {
  if [[ -z "${HTMLTRUST_RUST_CORE_LIB:-}" || ! -s "${HTMLTRUST_RUST_CORE_LIB}" ]]; then
    echo "ERROR shared-core ${language}: HTMLTRUST_RUST_CORE_LIB is missing" >&2
    exit 2
  fi
}

case "$language" in
  python)
    require_native_artifact
    test -f python/tests/test_rust_core.py || missing
    cp python/tests/test_rust_core.py /cache/test_rust_core.py
    (cd /cache && python -m pytest -q -p no:cacheprovider test_rust_core.py)
    python conformance/runners/run-python.py
    ;;
  go)
    require_native_artifact
    test -f go/rustcore_test.go || missing
    (cd go && go test -v ./...)
    (cd go && CGO_ENABLED=0 go test -v -run '^(TestNative|TestBuildSignatureBinding)' ./...)
    (cd conformance/runners && go run ./run-go.go)
    ;;
  php)
    require_native_artifact
    test -f php/tests/RustCoreTest.php || missing
    composer test --working-dir=php
    php_consumer=/cache/php-consumer
    rm -rf -- "$php_consumer"
    mkdir -p "$php_consumer"
    (cd "$php_consumer" && composer init \
      --name=htmltrust/shared-core-consumer --no-interaction)
    (
      cd "$php_consumer"
      composer config --json repositories.htmltrust \
        '{"type":"path","url":"/workspace/php","options":{"symlink":false,"versions":{"htmltrust/canonicalization":"0.3.0"}}}'
      composer require 'htmltrust/canonicalization:0.3.0' \
        --no-interaction --prefer-dist --no-progress
    )
    test ! -L "$php_consumer/vendor/htmltrust/canonicalization"
    HTMLTRUST_PHP_PACKAGE_MODE=installed \
      HTMLTRUST_PHP_PACKAGE_AUTOLOAD="$php_consumer/vendor/autoload.php" \
      php conformance/runners/run-php.php
    ;;
  *)
    echo "unknown shared-core adapter language: $language" >&2
    exit 2
    ;;
esac
