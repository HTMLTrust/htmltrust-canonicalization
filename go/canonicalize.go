// Package canonicalize implements the HTMLTrust canonical text normalization spec.
//
// It normalizes Unicode text through 8 phases to produce a stable canonical
// form suitable for content hashing and signing. Zero external dependencies
// beyond the Go standard library and golang.org/x/text for NFKC.
//
// Spec: https://github.com/HTMLTrust/htmltrust-canonicalization
package canonicalize

import (
	"regexp"
	"strings"

	"golang.org/x/text/unicode/norm"
)

// Phase 6+7: Invisible/formatting/bidi characters to strip.
// Preserves ZWNJ (U+200C) and ZWJ (U+200D) — semantic in Persian, Indic, emoji.
var stripRE = regexp.MustCompile("[\u00AD\u200B\u200E\u200F\u2060\uFEFF\u034F\u061C\u180E\u0640" +
	"\uFE00-\uFE0F" +
	"\u202A-\u202E" +
	"\u2066-\u2069" +
	"\u2061-\u2064" +
	"\uFFF9-\uFFFC]")

// Supplementary plane: variation selectors 17-256 (U+E0100-U+E01EF),
// tag characters (U+E0001-U+E007F).
var stripSupplementaryRE = regexp.MustCompile("[\U000E0001-\U000E007F\U000E0100-\U000E01EF]")

// Phase 2: All Unicode whitespace → U+0020.
var whitespaceRE = regexp.MustCompile("[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]")
var multiSpaceRE = regexp.MustCompile(" {2,}")

// Phase 3: Quotation marks.
var singleQuoteRE = regexp.MustCompile("[\u2018\u2019\u201B\u2039\u203A\u0060\u00B4\u2032]")
var doubleQuoteRE = regexp.MustCompile("[\u201A\u201C\u201D\u201E\u201F\u00AB\u00BB\u2033\u301D\u301E\u301F]")
var cjkQuoteRE = regexp.MustCompile("[\u300C\u300D\u300E\u300F\uFE41-\uFE44]")

// Phase 4: Dashes → U+002D (includes minus sign U+2212 from Phase 5).
var dashRE = regexp.MustCompile("[\u2010-\u2015\u2212\uFE58\uFE63]")

// Phase 5: Ellipsis → three periods.
var ellipsisRE = regexp.MustCompile("\u2026")

// Options controls normalization behavior.
type Options struct {
	// PreserveWhitespace skips whitespace collapsing (for <pre> content).
	PreserveWhitespace bool
}

// NormalizeText applies all 8 phases of the HTMLTrust canonicalization spec.
//
// Apply after extracting text from DOM, before hashing.
func NormalizeText(text string, opts ...Options) string {
	var o Options
	if len(opts) > 0 {
		o = opts[0]
	}

	// Phase 1: Unicode NFKC normalization.
	// Handles ligatures, fullwidth/halfwidth, presentation forms,
	// superscripts, CJK compatibility, Jamo composition, etc.
	text = norm.NFKC.String(text)

	// Phase 6+7: Strip invisible/formatting/bidi characters.
	text = stripRE.ReplaceAllString(text, "")
	text = stripSupplementaryRE.ReplaceAllString(text, "")

	// Phase 2: Whitespace normalization.
	if !o.PreserveWhitespace {
		text = whitespaceRE.ReplaceAllString(text, " ")
		text = multiSpaceRE.ReplaceAllString(text, " ")
	}

	// Phase 3: Quotation mark normalization.
	text = singleQuoteRE.ReplaceAllString(text, "'")
	text = doubleQuoteRE.ReplaceAllString(text, "\"")
	text = cjkQuoteRE.ReplaceAllString(text, "\"")

	// Phase 4: Dash and hyphen normalization.
	text = dashRE.ReplaceAllString(text, "-")

	// Phase 5: Other punctuation.
	text = ellipsisRE.ReplaceAllString(text, "...")

	return text
}

// Normalize is a convenience function that normalizes and trims the text.
func Normalize(text string) string {
	text = NormalizeText(text)
	return strings.TrimSpace(text)
}
