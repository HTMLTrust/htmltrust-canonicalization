package canonicalize

import (
	"testing"
)

func TestNormalize(t *testing.T) {
	tests := []struct {
		name     string
		inputA   string
		inputB   string
		wantSame bool
	}{
		{"Curly double quotes → straight", "\u201CHello\u201D", "\"Hello\"", true},
		{"Precomposed vs combining (NFKC)", "caf\u00E9", "cafe\u0301", true},
		{"fi ligature (NFKC)", "\uFB01nd", "find", true},
		{"Em dash → hyphen-minus", "word \u2014 word", "word - word", true},
		{"Guillemets → double quotes", "\u00ABBonjour\u00BB", "\"Bonjour\"", true},
		{"CJK corner brackets → double quotes", "\u300C\u6771\u4EAC\u300D", "\"\u6771\u4EAC\"", true},
		{"ZWNJ is semantic (Persian)", "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645", "\u0645\u06CC\u062E\u0648\u0627\u0647\u0645", false},
		{"Arabic tatweel stripped", "\u0643\u062A\u0640\u0640\u0640\u0627\u0628", "\u0643\u062A\u0627\u0628", true},
		{"Fullwidth ASCII (NFKC)", "\uFF21\uFF11", "A1", true},
		{"Circled digit (NFKC)", "\u2460", "1", true},
		{"ZWSP stripped", "word\u200Bword", "wordword", true},
		{"ZWNJ preserved (different)", "word\u200Cword", "wordword", false},
		{"Ellipsis → three dots", "Hello\u2026", "Hello...", true},
		{"Curly single quotes → straight", "\u2018Hello\u2019", "'Hello'", true},
		{"Low-9 quotes → straight", "\u201AGerman\u201C", "\"German\"", true},
		{"No-break space → space", "a\u00A0b", "a b", true},
		{"Ideographic space → space", "a\u3000b", "a b", true},
		{"Whitespace collapse", "a  \t  b", "a b", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			a := NormalizeText(tt.inputA)
			b := NormalizeText(tt.inputB)
			same := a == b
			if same != tt.wantSame {
				t.Errorf("NormalizeText(%q) = %q, NormalizeText(%q) = %q; same=%v, want same=%v",
					tt.inputA, a, tt.inputB, b, same, tt.wantSame)
			}
		})
	}
}
