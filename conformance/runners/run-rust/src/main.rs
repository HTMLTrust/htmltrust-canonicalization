//! Rust conformance runner for HTMLTrust canonicalization.
//!
//! Reads every fixture under conformance/fixtures/{normalize,extract,claims}/
//! and compares the binding output byte-for-byte against the `expected`
//! field. Exits non-zero on any divergence.
//!
//! Usage (from anywhere in the repo):
//!
//! ```sh
//! cargo run --manifest-path conformance/runners/run-rust/Cargo.toml
//! cargo run --manifest-path conformance/runners/run-rust/Cargo.toml -- --update
//! ```
//!
//! The Rust binding implements all three functions
//! (`normalize_text`, `extract_canonical_text`, `canonicalize_claims`),
//! so no SKIPs are emitted.

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use htmltrust_canonicalization::{
    canonicalize_claims, extract_canonical_text, normalize_text,
};
use serde_json::{Map, Value};

#[derive(Debug)]
enum SuiteError {
    BadInput(String),
}

impl std::fmt::Display for SuiteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SuiteError::BadInput(msg) => write!(f, "bad fixture input: {msg}"),
        }
    }
}

/// Run a single fixture through the appropriate binding function.
fn run_suite(suite: &str, input: &Value) -> Result<String, SuiteError> {
    match suite {
        "normalize" => {
            let s = input.as_str().ok_or_else(|| {
                SuiteError::BadInput("normalize input must be a string".into())
            })?;
            Ok(normalize_text(s, false))
        }
        "extract" => {
            let s = input.as_str().ok_or_else(|| {
                SuiteError::BadInput("extract input must be a string".into())
            })?;
            Ok(extract_canonical_text(s))
        }
        "claims" => {
            let obj = input.as_object().ok_or_else(|| {
                SuiteError::BadInput("claims input must be an object".into())
            })?;
            let mut map: BTreeMap<String, String> = BTreeMap::new();
            for (k, v) in obj {
                // Coerce non-string values to their JSON representation so
                // simple scalars (numbers, bools) work without losing data.
                let value = match v {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                map.insert(k.clone(), value);
            }
            Ok(canonicalize_claims(&map))
        }
        _ => unreachable!("unknown suite: {suite}"),
    }
}

fn list_fixtures(dir: &Path) -> Vec<PathBuf> {
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("read_dir {}: {e}", dir.display()))
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("json"))
        .collect();
    entries.sort();
    entries
}

/// Walk up looking for a `conformance/fixtures/` directory. Searches
/// first from `$CONFORMANCE_DIR` (if set), then from CWD, then from
/// the compile-time `CARGO_MANIFEST_DIR` (the runner's own crate). The
/// manifest-dir fallback makes `cargo run --manifest-path` work
/// regardless of where the user invokes it.
///
/// Returns `(confDir, repoRoot)`.
fn locate_conformance() -> (PathBuf, PathBuf) {
    if let Ok(explicit) = env::var("CONFORMANCE_DIR") {
        let p = PathBuf::from(explicit);
        if p.join("fixtures").is_dir() {
            let repo_root = p
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| p.clone());
            return (p, repo_root);
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = env::current_dir() {
        candidates.push(cwd);
    }
    // CARGO_MANIFEST_DIR points at the crate manifest dir at compile
    // time, so by walking up from there we always find the repo's
    // conformance/ directory.
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")));

    for start in candidates {
        let mut dir = start.clone();
        for _ in 0..8 {
            let candidate = dir.join("conformance").join("fixtures");
            if candidate.is_dir() {
                return (dir.join("conformance"), dir);
            }
            match dir.parent() {
                Some(p) => dir = p.to_path_buf(),
                None => break,
            }
        }
    }
    panic!(
        "no conformance/fixtures/ directory found above CWD or CARGO_MANIFEST_DIR; \
         pass CONFORMANCE_DIR=<path> to override",
    );
}

fn load_fixture(path: &Path) -> Map<String, Value> {
    let raw = fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let v: Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));
    match v {
        Value::Object(m) => m,
        _ => panic!("fixture {} is not a JSON object", path.display()),
    }
}

/// Write a fixture back to disk with our standard formatting:
/// pretty-printed, 2-space indent, trailing newline, key order
/// (name, description, input, expected) preserved.
fn save_fixture(path: &Path, fx: &Map<String, Value>) {
    let mut ordered = Map::new();
    for key in ["name", "description", "input", "expected"] {
        if let Some(v) = fx.get(key) {
            ordered.insert(key.to_string(), v.clone());
        }
    }
    for (k, v) in fx {
        if !ordered.contains_key(k) {
            ordered.insert(k.clone(), v.clone());
        }
    }
    let pretty = serde_json::to_string_pretty(&Value::Object(ordered))
        .expect("serialize");
    let mut out = pretty;
    out.push('\n');
    fs::write(path, out).unwrap_or_else(|e| panic!("write {}: {e}", path.display()));
}

fn show(v: &Value) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "<unrepresentable>".into())
}

fn main() -> ExitCode {
    let update = env::args().any(|a| a == "--update");
    let (conf_dir, repo_root) = locate_conformance();
    let fixtures_root = conf_dir.join("fixtures");

    let mut passed = 0usize;
    let mut failed = 0usize;
    let skipped = 0usize;
    let mut failures: Vec<String> = Vec::new();

    for suite in ["normalize", "extract", "claims"] {
        for path in list_fixtures(&fixtures_root.join(suite)) {
            let id = path
                .strip_prefix(&repo_root)
                .unwrap_or(path.as_path())
                .display()
                .to_string();
            let mut fixture = load_fixture(&path);
            let input = fixture
                .get("input")
                .cloned()
                .unwrap_or(Value::Null);
            let actual = match run_suite(suite, &input) {
                Ok(s) => s,
                Err(e) => {
                    failed += 1;
                    let msg = format!("FAIL {id}\n  threw: {e}");
                    println!("{msg}");
                    failures.push(msg);
                    continue;
                }
            };

            if update {
                fixture.insert("expected".to_string(), Value::String(actual));
                save_fixture(&path, &fixture);
                println!("UPDATED {id}");
                continue;
            }

            let expected = fixture
                .get("expected")
                .cloned()
                .unwrap_or(Value::Null);
            let expected_s = expected.as_str().unwrap_or("");
            if actual == expected_s {
                passed += 1;
                println!("PASS {id}");
            } else {
                failed += 1;
                let msg = format!(
                    "FAIL {id}\n  expected: {}\n  got:      {}",
                    show(&expected),
                    show(&Value::String(actual.clone())),
                );
                println!("{msg}");
                failures.push(msg);
            }
        }
    }

    if !update {
        println!("\n{passed} passed, {failed} failed, {skipped} skipped");
        if failed > 0 {
            println!("\n--- Failures ---");
            for msg in &failures {
                println!("{msg}");
            }
        }
    }

    if failed > 0 {
        ExitCode::from(1)
    } else {
        ExitCode::from(0)
    }
}
