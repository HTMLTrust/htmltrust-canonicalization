#!/usr/bin/env python3
"""Python conformance runner for HTMLTrust canonicalization.

Reads every fixture under conformance/fixtures/{normalize,extract,claims}/
and compares the binding output byte-for-byte against the ``expected``
field. Exits non-zero on any divergence.

Usage:
    python3 run-python.py           # verify all fixtures
    python3 run-python.py --update  # rewrite ``expected`` from the
                                    # current binding output

Python is the source of truth for the ``extract`` and ``claims``
fixtures' ``expected`` values: those suites are not (yet) implemented
by JavaScript, Go, or PHP, but Rust must match Python.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from pathlib import Path

CONF_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = CONF_DIR.parent
FIXTURES_ROOT = CONF_DIR / "fixtures"

# Make the in-tree Python binding importable without installing it.
sys.path.insert(0, str(REPO_ROOT / "python"))

from htmltrust_canonicalization import (  # noqa: E402
    canonicalize_claims,
    extract_canonical_text,
    normalize_text,
)


def run_normalize(fixture: dict) -> str:
    return normalize_text(fixture["input"])


def run_extract(fixture: dict) -> str:
    return extract_canonical_text(fixture["input"])


def run_claims(fixture: dict) -> str:
    return canonicalize_claims(fixture["input"])


RUNNERS = {
    "normalize": run_normalize,
    "extract": run_extract,
    "claims": run_claims,
}


def list_fixtures(suite: str) -> list[Path]:
    return sorted((FIXTURES_ROOT / suite).glob("*.json"))


def rel(p: Path) -> str:
    return str(p.relative_to(REPO_ROOT))


def load(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save(path: Path, data: dict) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument(
        "--update",
        action="store_true",
        help="rewrite the `expected` field of every fixture from the current "
        "binding output instead of comparing.",
    )
    args = parser.parse_args()

    passed = 0
    failed = 0
    skipped = 0
    failures: list[str] = []

    for suite in ("normalize", "extract", "claims"):
        runner = RUNNERS[suite]
        for path in list_fixtures(suite):
            fixture = load(path)
            ident = rel(path)
            try:
                actual = runner(fixture)
            except Exception as exc:
                failed += 1
                tb = "".join(traceback.format_exception_only(type(exc), exc)).strip()
                msg = f"FAIL {ident}\n  threw: {tb}"
                failures.append(msg)
                print(msg)
                continue

            if args.update:
                fixture["expected"] = actual
                save(path, fixture)
                print(f"UPDATED {ident}")
                continue

            if actual == fixture.get("expected"):
                passed += 1
                print(f"PASS {ident}")
            else:
                failed += 1
                msg = (
                    f"FAIL {ident}\n"
                    f"  expected: {json.dumps(fixture.get('expected'), ensure_ascii=False)}\n"
                    f"  got:      {json.dumps(actual, ensure_ascii=False)}"
                )
                failures.append(msg)
                print(msg)

    if not args.update:
        print(f"\n{passed} passed, {failed} failed, {skipped} skipped")
        if failures:
            print("\n--- Failures ---")
            for msg in failures:
                print(msg)
    return 1 if failed > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
