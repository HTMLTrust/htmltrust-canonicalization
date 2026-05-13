// Go conformance runner for HTMLTrust canonicalization.
//
// Reads every fixture under conformance/fixtures/{normalize,extract,claims}/
// and compares the binding output byte-for-byte against the `expected`
// field. Exits non-zero on any divergence.
//
// Usage:
//
//	go run conformance/runners/run-go.go           # verify
//	go run conformance/runners/run-go.go --update  # rewrite `expected`
//
// The Go binding currently exports only `NormalizeText`; extract and
// claims fixtures are reported as SKIP (not failures) because the
// runner has nothing to call.
//
// Build/run from the repo root, e.g.:
//
//	go run ./conformance/runners/run-go.go
//
// The `replace` directive in conformance/runners/go.mod points the
// import at the in-tree `go/` package so no network fetch is needed.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"

	canonicalize "github.com/HTMLTrust/htmltrust-canonicalization/go"
)

// fixture is the on-disk shape of every fixture JSON file. The `Input`
// is decoded as `json.RawMessage` so we can dispatch per-suite on the
// expected concrete shape: a string for normalize/extract, a map for
// claims.
type fixture struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Input       json.RawMessage `json:"input"`
	Expected    string          `json:"expected"`
}

type result struct {
	id      string
	status  string // PASS / FAIL / SKIP / UPDATED
	message string
}

// Per-suite runner: returns (output, implemented, error). `implemented`
// is false when the binding lacks the function -- the suite is then
// reported as SKIP.
type runner func(raw json.RawMessage) (string, bool, error)

func runNormalize(raw json.RawMessage) (string, bool, error) {
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", true, fmt.Errorf("input is not a string: %w", err)
	}
	return canonicalize.NormalizeText(s), true, nil
}

// The Go binding does not yet implement ExtractCanonicalText.
func runExtract(_ json.RawMessage) (string, bool, error) {
	return "", false, nil
}

// The Go binding does not yet implement CanonicalizeClaims.
func runClaims(_ json.RawMessage) (string, bool, error) {
	return "", false, nil
}

func main() {
	update := flag.Bool("update", false, "rewrite `expected` from the current binding output")
	flag.Parse()

	// Find the conformance directory relative to this source file.
	// `go run` invokes the binary from a temp dir, so resolve via
	// the caller's CWD: we look for `conformance/fixtures/` walking
	// up from CWD.
	confDir, repoRoot, err := locateConformance()
	if err != nil {
		fmt.Fprintln(os.Stderr, "could not locate conformance/ directory:", err)
		os.Exit(2)
	}
	fixturesRoot := filepath.Join(confDir, "fixtures")

	runners := map[string]runner{
		"normalize": runNormalize,
		"extract":   runExtract,
		"claims":    runClaims,
	}

	var (
		results []result
		passed  int
		failed  int
		skipped int
	)

	for _, suite := range []string{"normalize", "extract", "claims"} {
		paths, err := listFixtures(filepath.Join(fixturesRoot, suite))
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		r := runners[suite]
		for _, path := range paths {
			id, _ := filepath.Rel(repoRoot, path)
			fx, err := loadFixture(path)
			if err != nil {
				failed++
				msg := fmt.Sprintf("FAIL %s\n  load: %v", id, err)
				results = append(results, result{id, "FAIL", msg})
				fmt.Println(msg)
				continue
			}

			actual, implemented, err := r(fx.Input)
			if err != nil {
				failed++
				msg := fmt.Sprintf("FAIL %s\n  threw: %v", id, err)
				results = append(results, result{id, "FAIL", msg})
				fmt.Println(msg)
				continue
			}

			if !implemented {
				skipped++
				msg := fmt.Sprintf("SKIP %s  (binding does not implement %s)", id, suite)
				results = append(results, result{id, "SKIP", msg})
				fmt.Println(msg)
				continue
			}

			if *update {
				fx.Expected = actual
				if err := saveFixture(path, fx); err != nil {
					failed++
					msg := fmt.Sprintf("FAIL %s\n  write: %v", id, err)
					results = append(results, result{id, "FAIL", msg})
					fmt.Println(msg)
					continue
				}
				fmt.Printf("UPDATED %s\n", id)
				continue
			}

			if actual == fx.Expected {
				passed++
				fmt.Printf("PASS %s\n", id)
			} else {
				failed++
				eb, _ := json.Marshal(fx.Expected)
				ab, _ := json.Marshal(actual)
				msg := fmt.Sprintf("FAIL %s\n  expected: %s\n  got:      %s",
					id, string(eb), string(ab))
				results = append(results, result{id, "FAIL", msg})
				fmt.Println(msg)
			}
		}
	}

	if !*update {
		fmt.Printf("\n%d passed, %d failed, %d skipped\n", passed, failed, skipped)
		if failed > 0 {
			fmt.Println("\n--- Failures ---")
			for _, r := range results {
				if r.status == "FAIL" {
					fmt.Println(r.message)
				}
			}
		}
	}
	if failed > 0 {
		os.Exit(1)
	}
}

func listFixtures(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", dir, err)
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		out = append(out, filepath.Join(dir, e.Name()))
	}
	sort.Strings(out)
	return out, nil
}

func loadFixture(path string) (*fixture, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var fx fixture
	if err := json.Unmarshal(b, &fx); err != nil {
		return nil, err
	}
	return &fx, nil
}

func saveFixture(path string, fx *fixture) error {
	// Round-trip the original file so we keep any extra keys the
	// runner doesn't know about. The disk format is:
	//   { name, description, input, expected }
	// pretty-printed with 2-space indent and a trailing newline.
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return err
	}
	enc, err := json.Marshal(fx.Expected)
	if err != nil {
		return err
	}
	m["expected"] = enc

	// Re-encode using the conventional key order so the file diff
	// stays readable.
	ordered := []string{"name", "description", "input", "expected"}
	seen := map[string]bool{}
	var buf []byte
	buf = append(buf, '{', '\n')
	first := true
	emit := func(k string, v json.RawMessage) {
		if !first {
			buf = append(buf, ',', '\n')
		}
		first = false
		buf = append(buf, "  "...)
		kb, _ := json.Marshal(k)
		buf = append(buf, kb...)
		buf = append(buf, ':', ' ')
		// Indent any multi-line value (e.g. an object input) with 2 spaces.
		pretty, err := prettyIndent(v, "  ")
		if err != nil {
			buf = append(buf, v...)
		} else {
			buf = append(buf, pretty...)
		}
	}
	for _, k := range ordered {
		if v, ok := m[k]; ok {
			emit(k, v)
			seen[k] = true
		}
	}
	// Emit any other unexpected keys at the end (preserving them).
	var extras []string
	for k := range m {
		if !seen[k] {
			extras = append(extras, k)
		}
	}
	sort.Strings(extras)
	for _, k := range extras {
		emit(k, m[k])
	}
	buf = append(buf, '\n', '}', '\n')
	return os.WriteFile(path, buf, 0o644)
}

// prettyIndent re-indents a json.RawMessage so multi-line values
// (objects/arrays) sit at the right depth in the output. The leading
// line stays flush; continuation lines get `prefix` prepended.
func prettyIndent(v json.RawMessage, prefix string) ([]byte, error) {
	var any interface{}
	if err := json.Unmarshal(v, &any); err != nil {
		return nil, err
	}
	pretty, err := json.MarshalIndent(any, prefix, "  ")
	if err != nil {
		return nil, err
	}
	return pretty, nil
}

// locateConformance walks up looking for `conformance/fixtures/`.
// Searches first $CONFORMANCE_DIR (if set), then CWD, then the
// directory containing this source file (when discoverable via the
// Go runtime). Returns (confDir, repoRoot).
func locateConformance() (string, string, error) {
	if explicit := os.Getenv("CONFORMANCE_DIR"); explicit != "" {
		if st, err := os.Stat(filepath.Join(explicit, "fixtures")); err == nil && st.IsDir() {
			parent := filepath.Dir(explicit)
			return explicit, parent, nil
		}
	}

	var starts []string
	if cwd, err := os.Getwd(); err == nil {
		starts = append(starts, cwd)
	}
	// runtime.Caller gives the source-file path of THIS function at
	// compile time -- a stable fallback for `go run` invocations from
	// unusual working directories.
	if _, srcFile, _, ok := runtime.Caller(0); ok {
		starts = append(starts, filepath.Dir(srcFile))
	}

	for _, start := range starts {
		dir := start
		for i := 0; i < 8; i++ {
			c := filepath.Join(dir, "conformance")
			if st, err := os.Stat(filepath.Join(c, "fixtures")); err == nil && st.IsDir() {
				return c, dir, nil
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return "", "", fmt.Errorf("no conformance/fixtures/ found from CWD or source file; set CONFORMANCE_DIR")
}
