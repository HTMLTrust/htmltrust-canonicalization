//go:build (!cgo && !windows) || (windows && 386) || (!linux && !darwin && !freebsd && !openbsd && !netbsd && !windows)

package canonicalize

import "errors"

func newRustCoreBackend(string) (rustCoreBackend, error) {
	return nil, errors.New("htmltrust Rust core adapter is unavailable on this platform")
}
