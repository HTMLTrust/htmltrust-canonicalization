module htmltrust.conformance/run-go

go 1.25.0

require github.com/HTMLTrust/htmltrust-canonicalization/go v0.0.0

require (
	golang.org/x/net v0.55.0 // indirect
	golang.org/x/text v0.39.0 // indirect
)

replace github.com/HTMLTrust/htmltrust-canonicalization/go => ../../go
