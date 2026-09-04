#!/usr/bin/env python3
"""Run the HTMLTrust conformance fixtures against any external implementation.

The implementation speaks JSON Lines on stdin and stdout; see PROTOCOL.md.
Nothing here imports an HTMLTrust binding, so a passing run says the
implementation matches the fixtures, not that it matches this repository's
code.

Usage:
    python3 conformance/run-external.py -- <command> [args...]

Options:
    --suite NAME        run one of normalize, extract, claims, jcs
    --verify-fixtures   check fixtures against fixtures.sha256 first
    --json PATH         write a machine-readable report
    --timeout SECONDS   per-fixture limit, default 30
    -v                  print every fixture, not just failures

Exit codes:
    0  every fixture passed
    1  at least one fixture diverged
    2  the implementation crashed, timed out, or broke the protocol
"""

from __future__ import annotations

import argparse
import hashlib
import json
import queue
import subprocess
import sys
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"
HASHES = HERE / "fixtures.sha256"
SUITES = ("normalize", "extract", "claims", "jcs")


def load_fixtures(suite_filter: str | None) -> list[dict]:
    out = []
    for path in sorted(FIXTURES.rglob("*.json")):
        suite = path.parent.name
        if suite not in SUITES:
            continue
        if suite_filter and suite != suite_filter:
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        data["_suite"] = suite
        data["_id"] = f"{suite}/{path.stem}"
        data["_path"] = path
        out.append(data)
    return out


def verify_fixtures() -> bool:
    if not HASHES.is_file():
        print(f"no {HASHES.name}; run --write-hashes to create it", file=sys.stderr)
        return False
    expected = {}
    for line in HASHES.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        digest, rel = line.split(None, 1)
        expected[rel] = digest

    actual = {
        str(p.relative_to(HERE)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(FIXTURES.rglob("*.json"))
    }

    ok = True
    for rel, digest in sorted(expected.items()):
        if rel not in actual:
            print(f"fixture missing: {rel}", file=sys.stderr)
            ok = False
        elif actual[rel] != digest:
            print(f"fixture ALTERED: {rel}", file=sys.stderr)
            ok = False
    for rel in sorted(set(actual) - set(expected)):
        print(f"fixture not in manifest: {rel}", file=sys.stderr)
        ok = False
    if ok:
        print(f"fixture integrity OK ({len(expected)} files)")
    return ok


def write_hashes() -> int:
    lines = [
        "# sha256 of every conformance fixture. Regenerate only when changing a",
        "# fixture deliberately; see PROTOCOL.md.",
    ]
    for p in sorted(FIXTURES.rglob("*.json")):
        lines.append(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(HERE)}")
    HASHES.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {HASHES.name} ({len(lines) - 2} fixtures)")
    return 0


class Implementation:
    """The external process, with a reader thread so a hang cannot deadlock us."""

    def __init__(self, argv: list[str], timeout: float):
        self.timeout = timeout
        self.proc = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self.lines: queue.Queue[str | None] = queue.Queue()
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            self.lines.put(line)
        self.lines.put(None)

    def ask(self, request: dict) -> dict:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(request) + "\n")
        self.proc.stdin.flush()
        while True:
            try:
                line = self.lines.get(timeout=self.timeout)
            except queue.Empty:
                raise TimeoutError(f"no response within {self.timeout}s")
            if line is None:
                raise RuntimeError("implementation closed stdout")
            line = line.strip()
            if not line:
                continue
            return json.loads(line)

    def close(self) -> tuple[int | None, str]:
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()
        stderr = ""
        if self.proc.stderr:
            stderr = self.proc.stderr.read() or ""
        return self.proc.returncode, stderr


def show(value: str, limit: int = 160) -> str:
    text = repr(value)
    return text if len(text) <= limit else text[: limit - 3] + "..."


def main() -> int:
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--suite", choices=SUITES)
    ap.add_argument("--verify-fixtures", action="store_true")
    ap.add_argument("--write-hashes", action="store_true")
    ap.add_argument("--json", type=Path)
    ap.add_argument("--timeout", type=float, default=30.0)
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("command", nargs=argparse.REMAINDER)
    args = ap.parse_args()

    if args.write_hashes:
        return write_hashes()

    if args.verify_fixtures and not verify_fixtures():
        return 2

    argv = args.command[1:] if args.command and args.command[0] == "--" else args.command
    if not argv:
        ap.error("no implementation command given; use: run-external.py -- <command>")

    fixtures = load_fixtures(args.suite)
    if not fixtures:
        print("no fixtures matched", file=sys.stderr)
        return 2

    try:
        impl = Implementation(argv, args.timeout)
    except OSError as exc:
        print(f"could not start {argv[0]!r}: {exc}", file=sys.stderr)
        return 2

    passed, failed, results = 0, [], []
    crashed = False

    for fx in fixtures:
        request = {"id": fx["_id"], "suite": fx["_suite"], "input": fx["input"]}
        if "baseURL" in fx:
            request["baseURL"] = fx["baseURL"]
        if "repeat" in fx:
            request["repeat"] = fx["repeat"]

        try:
            reply = impl.ask(request)
        except Exception as exc:
            print(f"CRASH {fx['_id']}: {exc}", file=sys.stderr)
            crashed = True
            break

        if reply.get("id") != fx["_id"]:
            failed.append((fx["_id"], f"wrong id in reply: {reply.get('id')!r}"))
            continue

        has_out, has_err = "output" in reply, "error" in reply
        if has_out == has_err:
            failed.append((fx["_id"], "reply must carry exactly one of output/error"))
            continue

        if "error" in fx:
            if has_err and reply["error"] == fx["error"]:
                passed += 1
                verdict = "PASS"
            else:
                got = reply.get("error") if has_err else f"output {show(reply['output'])}"
                failed.append((fx["_id"], f"expected error {fx['error']!r}, got {got}"))
                verdict = "FAIL"
        else:
            if has_out and reply["output"] == fx["expected"]:
                passed += 1
                verdict = "PASS"
            else:
                got = show(reply["output"]) if has_out else f"error {reply.get('error')!r}"
                failed.append((fx["_id"], f"expected {show(fx['expected'])}, got {got}"))
                verdict = "FAIL"

        results.append({"id": fx["_id"], "suite": fx["_suite"], "verdict": verdict})
        if args.verbose:
            print(f"{verdict} {fx['_id']}")

    code, stderr = impl.close()

    print()
    print(f"passed {passed} of {len(fixtures)}")
    for fid, why in failed:
        print(f"FAIL {fid}\n     {why}")
    if stderr.strip():
        print("\nimplementation stderr:")
        for line in stderr.strip().splitlines()[:20]:
            print(f"  {line}")

    if args.json:
        args.json.write_text(
            json.dumps(
                {
                    "total": len(fixtures),
                    "passed": passed,
                    "failed": [{"id": f, "reason": w} for f, w in failed],
                    "results": results,
                    "implementation_exit": code,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        print(f"\nwrote {args.json}")

    if crashed:
        return 2
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
