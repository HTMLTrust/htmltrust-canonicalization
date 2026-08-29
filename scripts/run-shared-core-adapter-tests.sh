#!/usr/bin/env bash
set -euo pipefail

language="${1:?language is required}"

missing() {
  echo "ERROR shared-core ${language}: maintained adapter test is missing" >&2
  exit 2
}

case "$language" in
  python)
    test -f python/tests/test_rust_core.py || missing
    cp python/tests/test_rust_core.py /cache/test_rust_core.py
    (cd /cache && python -m pytest -q -p no:cacheprovider test_rust_core.py)
    python conformance/runners/run-python.py
    ;;
  go)
    test -f go/rustcore_test.go || missing
    (cd go && go test -v -run '^TestRustCore|^TestNewRustCore')
    (cd conformance/runners && go run ./run-go.go)
    ;;
  php)
    test -f php/tests/RustCoreTest.php || missing
    php php/vendor/bin/phpunit --do-not-cache-result php/tests/RustCoreTest.php
    php_consumer=/cache/php-consumer
    mkdir -p "$php_consumer"
    if [[ ! -f "$php_consumer/composer.json" ]]; then
      (cd "$php_consumer" && composer init \
        --name=htmltrust/shared-core-consumer --no-interaction)
    fi
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
