package canonicalize

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	jcs "github.com/gowebpki/jcs"
)

type jsonValue struct {
	kind byte
	str  string
	num  float64
	arr  []*jsonValue
	obj  []jsonMember
}
type jsonMember struct {
	name  string
	value *jsonValue
}
type strictJSONParser struct {
	data  []byte
	pos   int
	depth int
}

const maxJSONDepth = 256

func (p *strictJSONParser) fail() error { return fmt.Errorf("invalid JSON document") }
func (p *strictJSONParser) ws() {
	for p.pos < len(p.data) && strings.ContainsRune(" \t\r\n", rune(p.data[p.pos])) {
		p.pos++
	}
}
func (p *strictJSONParser) parse() (*jsonValue, error) {
	v, e := p.value()
	if e != nil {
		return nil, e
	}
	p.ws()
	if p.pos != len(p.data) {
		return nil, p.fail()
	}
	return v, nil
}
func (p *strictJSONParser) value() (*jsonValue, error) {
	p.ws()
	if p.pos >= len(p.data) {
		return nil, p.fail()
	}
	switch p.data[p.pos] {
	case '"':
		s, e := p.string()
		return &jsonValue{kind: 's', str: s}, e
	case '{':
		if p.depth >= maxJSONDepth {
			return nil, fmt.Errorf("resource-limit-exceeded")
		}
		p.depth++
		v, err := p.object()
		p.depth--
		return v, err
	case '[':
		if p.depth >= maxJSONDepth {
			return nil, fmt.Errorf("resource-limit-exceeded")
		}
		p.depth++
		v, err := p.array()
		p.depth--
		return v, err
	case 't':
		if p.literal("true") {
			return &jsonValue{kind: 'b', str: "true"}, nil
		}
	case 'f':
		if p.literal("false") {
			return &jsonValue{kind: 'b', str: "false"}, nil
		}
	case 'n':
		if p.literal("null") {
			return &jsonValue{kind: 'n'}, nil
		}
	}
	n, e := p.number()
	if e != nil {
		return nil, e
	}
	return &jsonValue{kind: 'd', num: n}, nil
}
func (p *strictJSONParser) literal(s string) bool {
	if strings.HasPrefix(string(p.data[p.pos:]), s) {
		p.pos += len(s)
		return true
	}
	return false
}
func hexValue(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}
func (p *strictJSONParser) string() (string, error) {
	if p.pos >= len(p.data) || p.data[p.pos] != '"' {
		return "", p.fail()
	}
	p.pos++
	var b strings.Builder
	for p.pos < len(p.data) {
		c := p.data[p.pos]
		p.pos++
		if c == '"' {
			s := b.String()
			if !utf8.ValidString(s) {
				return "", p.fail()
			}
			return s, nil
		}
		if c < 0x20 {
			return "", p.fail()
		}
		if c != '\\' {
			start := p.pos - 1
			for p.pos < len(p.data) && p.data[p.pos] != '"' && p.data[p.pos] != '\\' && p.data[p.pos] >= 0x20 {
				p.pos++
			}
			b.Write(p.data[start:p.pos])
			continue
		}
		if p.pos >= len(p.data) {
			return "", p.fail()
		}
		e := p.data[p.pos]
		p.pos++
		switch e {
		case '"', '\\', '/':
			b.WriteByte(e)
		case 'b':
			b.WriteByte('\b')
		case 'f':
			b.WriteByte('\f')
		case 'n':
			b.WriteByte('\n')
		case 'r':
			b.WriteByte('\r')
		case 't':
			b.WriteByte('\t')
		case 'u':
			if p.pos+4 > len(p.data) {
				return "", p.fail()
			}
			var u uint16
			for i := 0; i < 4; i++ {
				d, ok := hexValue(p.data[p.pos+i])
				if !ok {
					return "", p.fail()
				}
				u = u<<4 | uint16(d)
			}
			p.pos += 4
			if u >= 0xd800 && u <= 0xdbff {
				if p.pos+6 > len(p.data) || p.data[p.pos] != '\\' || p.data[p.pos+1] != 'u' {
					return "", fmt.Errorf("jcs-invalid-surrogate")
				}
				p.pos += 2
				var lo uint16
				for i := 0; i < 4; i++ {
					d, ok := hexValue(p.data[p.pos+i])
					if !ok {
						return "", p.fail()
					}
					lo = lo<<4 | uint16(d)
				}
				p.pos += 4
				if lo < 0xdc00 || lo > 0xdfff {
					return "", fmt.Errorf("jcs-invalid-surrogate")
				}
				b.WriteRune(utf16.DecodeRune(rune(u), rune(lo)))
			} else if u >= 0xdc00 && u <= 0xdfff {
				return "", fmt.Errorf("jcs-invalid-surrogate")
			} else {
				b.WriteRune(rune(u))
			}
		default:
			return "", p.fail()
		}
	}
	return "", p.fail()
}
func (p *strictJSONParser) number() (float64, error) {
	start := p.pos
	if p.pos < len(p.data) && p.data[p.pos] == '-' {
		p.pos++
	}
	if p.pos >= len(p.data) {
		return 0, p.fail()
	}
	if p.data[p.pos] == '0' {
		p.pos++
	} else if p.data[p.pos] >= '1' && p.data[p.pos] <= '9' {
		for p.pos < len(p.data) && p.data[p.pos] >= '0' && p.data[p.pos] <= '9' {
			p.pos++
		}
	} else {
		return 0, p.fail()
	}
	if p.pos < len(p.data) && p.data[p.pos] == '.' {
		p.pos++
		if p.pos >= len(p.data) || p.data[p.pos] < '0' || p.data[p.pos] > '9' {
			return 0, p.fail()
		}
		for p.pos < len(p.data) && p.data[p.pos] >= '0' && p.data[p.pos] <= '9' {
			p.pos++
		}
	}
	if p.pos < len(p.data) && (p.data[p.pos] == 'e' || p.data[p.pos] == 'E') {
		p.pos++
		if p.pos < len(p.data) && (p.data[p.pos] == '+' || p.data[p.pos] == '-') {
			p.pos++
		}
		if p.pos >= len(p.data) || p.data[p.pos] < '0' || p.data[p.pos] > '9' {
			return 0, p.fail()
		}
		for p.pos < len(p.data) && p.data[p.pos] >= '0' && p.data[p.pos] <= '9' {
			p.pos++
		}
	}
	n, e := strconv.ParseFloat(string(p.data[start:p.pos]), 64)
	if e != nil || n != n || n > 1.7976931348623157e308 || n < -1.7976931348623157e308 {
		return 0, fmt.Errorf("jcs-number")
	}
	return n, nil
}
func (p *strictJSONParser) array() (*jsonValue, error) {
	p.pos++
	v := &jsonValue{kind: 'a'}
	p.ws()
	if p.pos < len(p.data) && p.data[p.pos] == ']' {
		p.pos++
		return v, nil
	}
	for {
		e, err := p.value()
		if err != nil {
			return nil, err
		}
		v.arr = append(v.arr, e)
		p.ws()
		if p.pos < len(p.data) && p.data[p.pos] == ']' {
			p.pos++
			return v, nil
		}
		if p.pos >= len(p.data) || p.data[p.pos] != ',' {
			return nil, p.fail()
		}
		p.pos++
	}
}
func (p *strictJSONParser) object() (*jsonValue, error) {
	p.pos++
	v := &jsonValue{kind: 'o'}
	seen := map[string]bool{}
	p.ws()
	if p.pos < len(p.data) && p.data[p.pos] == '}' {
		p.pos++
		return v, nil
	}
	for {
		p.ws()
		if p.pos >= len(p.data) || p.data[p.pos] != '"' {
			return nil, p.fail()
		}
		name, err := p.string()
		if err != nil {
			return nil, err
		}
		if seen[name] {
			return nil, fmt.Errorf("jcs-duplicate-key")
		}
		seen[name] = true
		p.ws()
		if p.pos >= len(p.data) || p.data[p.pos] != ':' {
			return nil, p.fail()
		}
		p.pos++
		x, err := p.value()
		if err != nil {
			return nil, err
		}
		v.obj = append(v.obj, jsonMember{name, x})
		p.ws()
		if p.pos < len(p.data) && p.data[p.pos] == '}' {
			p.pos++
			return v, nil
		}
		if p.pos >= len(p.data) || p.data[p.pos] != ',' {
			return nil, p.fail()
		}
		p.pos++
	}
}
func escapeJSON(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				b.WriteString(fmt.Sprintf(`\u%04x`, r))
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}
func serializeJSON(v *jsonValue) (string, error) {
	switch v.kind {
	case 'n':
		return "null", nil
	case 'b':
		return v.str, nil
	case 's':
		return escapeJSON(v.str), nil
	case 'd':
		return jcs.NumberToJSON(v.num)
	case 'a':
		var b strings.Builder
		b.WriteByte('[')
		for i, x := range v.arr {
			s, e := serializeJSON(x)
			if e != nil {
				return "", e
			}
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteString(s)
		}
		b.WriteByte(']')
		return b.String(), nil
	case 'o':
		sort.Slice(v.obj, func(i, j int) bool {
			return compareUTF16(v.obj[i].name, v.obj[j].name) < 0
		})
		var b strings.Builder
		b.WriteByte('{')
		for i, m := range v.obj {
			s, e := serializeJSON(m.value)
			if e != nil {
				return "", e
			}
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteString(escapeJSON(m.name))
			b.WriteByte(':')
			b.WriteString(s)
		}
		b.WriteByte('}')
		return b.String(), nil
	}
	return "", fmt.Errorf("invalid JSON value")
}

func compareUTF16(a, b string) int {
	aa, bb := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(aa) && i < len(bb); i++ {
		if aa[i] < bb[i] {
			return -1
		}
		if aa[i] > bb[i] {
			return 1
		}
	}
	if len(aa) < len(bb) {
		return -1
	}
	if len(aa) > len(bb) {
		return 1
	}
	return 0
}

// CanonicalizeJSONDocument validates and canonicalizes one complete JSON document according to RFC 8785.
func CanonicalizeJSONDocument(document []byte) ([]byte, error) {
	if len(document) > maxResourceBytes {
		return nil, fmt.Errorf("resource-limit-exceeded")
	}
	if !utf8.Valid(document) {
		return nil, fmt.Errorf("jcs-invalid-json")
	}
	v, e := (&strictJSONParser{data: document}).parse()
	if e != nil {
		if strings.Contains(e.Error(), "jcs-") || strings.Contains(e.Error(), "resource-limit-exceeded") {
			return nil, e
		}
		return nil, fmt.Errorf("jcs-invalid-json")
	}
	s, e := serializeJSON(v)
	if e != nil {
		return nil, e
	}
	if len(s) > maxResourceBytes {
		return nil, fmt.Errorf("resource-limit-exceeded")
	}
	return []byte(s), nil
}
