module htmltrust.conformance/run-go

go 1.25.0

require github.com/HTMLTrust/htmltrust-canonicalization/go v0.0.0

require (
	github.com/bits-and-blooms/bitset v1.20.0 // indirect
	github.com/nlnwa/whatwg-url v0.6.2 // indirect
)

replace github.com/HTMLTrust/htmltrust-canonicalization/go => ../../go
