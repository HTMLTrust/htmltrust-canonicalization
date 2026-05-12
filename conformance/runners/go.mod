module htmltrust.conformance/run-go

go 1.21

require github.com/ArcadeLabsInc/htmltrust-canonicalization/go v0.0.0

require golang.org/x/text v0.21.0 // indirect

replace github.com/ArcadeLabsInc/htmltrust-canonicalization/go => ../../go
