package canonicalize

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Elements whose text content is NEVER part of the signed content. These are
// either metadata (meta, link, script, style) or the signed-section wrapper's
// own metadata (meta tags inside a signed-section carry claims, not content).
// They are stripped entirely (with their contents) before extracting text.
//
// Go's RE2 has no backreferences, so we compile one non-greedy regex per
// element name and apply them in sequence.
var excludedPairTagNames = []string{"script", "style", "meta", "link", "head", "noscript"}

var excludedPairREs = func() []*regexp.Regexp {
	out := make([]*regexp.Regexp, 0, len(excludedPairTagNames))
	for _, name := range excludedPairTagNames {
		out = append(out, regexp.MustCompile(`(?is)<`+name+`\b[^>]*>.*?</`+name+`\s*>`))
	}
	return out
}()

// Self-closing and void elements (no text content) to strip.
var voidElementsRE = regexp.MustCompile(
	`(?i)<(meta|link|br|hr|img|input|source|track|wbr|area|base|col|embed|param)\b[^>]*/?>`,
)

// Block-level elements whose boundaries should become whitespace separators.
const blockElements = `address|article|aside|blockquote|canvas|dd|div|dl|dt|` +
	`fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|` +
	`noscript|ol|output|p|pre|section|table|tfoot|thead|tr|td|th|ul|video`

var blockOpenRE = regexp.MustCompile(`(?i)<(` + blockElements + `)\b[^>]*>`)
var blockCloseRE = regexp.MustCompile(`(?i)</(` + blockElements + `)\s*>`)

// Any remaining HTML tag (inline elements stripped without adding whitespace).
var anyTagRE = regexp.MustCompile(`(?i)<\/?[a-z][a-z0-9-]*\b[^>]*>`)

// HTML named-entity table (common entities; numeric handled separately).
var namedEntities = map[string]string{
	"&amp;":    "&",
	"&lt;":     "<",
	"&gt;":     ">",
	"&quot;":   "\"",
	"&apos;":   "'",
	"&nbsp;":   " ",
	"&ndash;":  "–",
	"&mdash;":  "—",
	"&lsquo;":  "‘",
	"&rsquo;":  "’",
	"&ldquo;":  "“",
	"&rdquo;":  "”",
	"&hellip;": "…",
	"&copy;":   "©",
	"&reg;":    "®",
	"&trade;":  "™",
}

var (
	namedEntityRE   = regexp.MustCompile(`&[a-zA-Z]+;`)
	decimalEntityRE = regexp.MustCompile(`&#(\d+);`)
	hexEntityRE     = regexp.MustCompile(`&#x([0-9a-fA-F]+);`)
)

func decodeEntities(text string) string {
	text = namedEntityRE.ReplaceAllStringFunc(text, func(match string) string {
		key := strings.ToLower(match)
		if v, ok := namedEntities[key]; ok {
			return v
		}
		return match
	})
	text = decimalEntityRE.ReplaceAllStringFunc(text, func(match string) string {
		m := decimalEntityRE.FindStringSubmatch(match)
		if len(m) < 2 {
			return match
		}
		n, err := strconv.Atoi(m[1])
		if err != nil {
			return match
		}
		return string(rune(n))
	})
	text = hexEntityRE.ReplaceAllStringFunc(text, func(match string) string {
		m := hexEntityRE.FindStringSubmatch(match)
		if len(m) < 2 {
			return match
		}
		n, err := strconv.ParseInt(m[1], 16, 32)
		if err != nil {
			return match
		}
		return string(rune(n))
	})
	return text
}

// ExtractCanonicalText extracts canonical text from an HTML fragment for
// signing or verification. Mirrors the JS extractCanonicalText() reference
// implementation: strips excluded elements, converts block boundaries to
// whitespace, strips remaining inline markup, decodes entities, and runs the
// full text normalization pipeline. The returned string is trimmed.
//
// Per HTMLTrust spec §2.1 this produces a text-only hash input: markup and
// attributes of the signed content itself are not covered by the hash.
func ExtractCanonicalText(html string, opts ...Options) (string, error) {
	// Step 1: Strip excluded elements and their contents.
	text := html
	for _, re := range excludedPairREs {
		text = re.ReplaceAllString(text, " ")
	}
	text = voidElementsRE.ReplaceAllString(text, " ")

	// Step 2: Convert block boundaries to whitespace.
	text = blockOpenRE.ReplaceAllString(text, " ")
	text = blockCloseRE.ReplaceAllString(text, " ")

	// Step 3: Strip all remaining (inline) tags.
	text = anyTagRE.ReplaceAllString(text, "")

	// Step 4: Decode HTML entities.
	text = decodeEntities(text)

	// Step 5: Apply the full canonicalization pipeline.
	return strings.TrimSpace(NormalizeText(text, opts...)), nil
}

// CanonicalizeClaims serializes a claims map as a sorted list of "name=value"
// pairs joined by "\n". Both names and values are pushed through NormalizeText
// before serialization so the output is independent of trivial Unicode noise.
// Mirrors the JS canonicalizeClaims() reference implementation.
func CanonicalizeClaims(claims map[string]string) string {
	type entry struct{ name, value string }
	entries := make([]entry, 0, len(claims))
	for k, v := range claims {
		entries = append(entries, entry{NormalizeText(k), NormalizeText(v)})
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].name < entries[j].name
	})
	parts := make([]string, len(entries))
	for i, e := range entries {
		parts[i] = e.name + "=" + e.value
	}
	return strings.Join(parts, "\n")
}
