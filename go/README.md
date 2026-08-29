# HTMLTrust Canonicalization for Go

This module implements `htmltrust-c14n-v1` and includes an optional adapter for
the Rust shared core.

- Version: `0.3.0` release candidate
- Go: 1.25 or newer

## Install and test a checkout

```sh
cd go
go mod download
go test ./...
```

Use the module from another Go project after pinning a reviewed commit. A
subdirectory release tag will use the `go/v0.3.0` form when published:

```sh
go get github.com/HTMLTrust/htmltrust-canonicalization/go@REVIEWED_COMMIT
```

## Independent Go API

```go
text, err := canonicalize.NormalizeTextChecked("A—B")
content, err := canonicalize.ExtractCanonicalText(
    `<a href="/paper">Paper</a>`,
    canonicalize.Options{BaseURL: "https://example.org/article"},
)
claims, err := canonicalize.CanonicalizeClaims(map[string]string{
    "License": "CC-BY-4.0",
})
json, err := canonicalize.CanonicalizeJSONDocument([]byte(`{"z":0,"a":1}`))
```

Handle every returned error before hashing or signing the result.
An empty `Options.BaseURL` means that no base URL was supplied. A nonempty base
URL has a 1 MiB UTF-8 ceiling.

## Rust shared-core adapter

The maintained native lane uses Linux x86-64 and cgo. From the repository
root, build the native library and run all adapter fixtures:

```sh
make test-shared-core
```

The command prints the artifact directory. Open its absolute library path:

```go
core, err := canonicalize.NewRustCore(
    "/path/to/libhtmltrust_canonicalization_ffi.so",
)
if err != nil {
    return err
}
defer core.Close()

text, err := core.NormalizeText("A—B", false)
```

Construction checks ABI version 1 and every required symbol. The adapter does
not search the executable directory or system library paths.

See the [shared-core guide](../docs/RUST-SHARED-CORE.md) for artifact ownership
and the current platform matrix.
