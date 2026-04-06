# Canonical Character Equivalences Specification

## Design Principles

1. **NFKC first** — apply Unicode NFKC normalization before any custom mappings.
   This handles ~80% of compatibility equivalences (ligatures, fullwidth/halfwidth,
   presentation forms, superscripts, CJK compatibility ideographs, etc.)

2. **Then custom mappings** — for characters NFKC doesn't normalize but CMSes
   freely interchange.

3. **Preserve semantic content** — if a character changes meaning in any major
   language, keep it. When in doubt, keep it.

4. **Strip formatting-only characters** — characters whose sole purpose is
   rendering/layout hints, not content.

---

## Phase 1: NFKC

Apply `String.prototype.normalize('NFKC')` — no table needed, built into every
modern JS engine and specified by UAX #15.

---

## Phase 2: Whitespace Normalization

All Unicode whitespace collapses to U+0020 SPACE (except inside `<pre>`).

### Characters → U+0020 SPACE

| Code Point | Name | Notes |
|------------|------|-------|
| U+0009 | TAB | |
| U+000A | LINE FEED | |
| U+000B | VERTICAL TAB | |
| U+000C | FORM FEED | |
| U+000D | CARRIAGE RETURN | |
| U+0085 | NEXT LINE (NEL) | Latin-1 legacy |
| U+00A0 | NO-BREAK SPACE | CMSes interchange with space freely |
| U+1680 | OGHAM SPACE MARK | Rare but valid Unicode whitespace |
| U+2000 | EN QUAD | |
| U+2001 | EM QUAD | |
| U+2002 | EN SPACE | |
| U+2003 | EM SPACE | |
| U+2004 | THREE-PER-EM SPACE | |
| U+2005 | FOUR-PER-EM SPACE | |
| U+2006 | SIX-PER-EM SPACE | |
| U+2007 | FIGURE SPACE | Used in number formatting |
| U+2008 | PUNCTUATION SPACE | Used in French typography |
| U+2009 | THIN SPACE | Used in French typography |
| U+200A | HAIR SPACE | |
| U+2028 | LINE SEPARATOR | |
| U+2029 | PARAGRAPH SEPARATOR | |
| U+202F | NARROW NO-BREAK SPACE | French punct spacing, Mongolian |
| U+205F | MEDIUM MATHEMATICAL SPACE | |
| U+3000 | IDEOGRAPHIC SPACE | CJK fullwidth space — NFKC misses this |

Then collapse runs of spaces to single space, and trim per block element.

**Regex (JS):**
```javascript
const UNICODE_WHITESPACE = /[\u0009\u000A-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g;
// Replace all with U+0020, then collapse
text = text.replace(UNICODE_WHITESPACE, ' ').replace(/ {2,}/g, ' ');
```

---

## Phase 3: Quotation Mark Normalization

Quotation marks are the #1 source of CMS-induced hash breakage. WordPress, Medium,
Google Docs, and most rich text editors auto-convert straight quotes to
language-specific curly/angled quotes. We normalize all to ASCII.

### Single Quotes → U+0027 APOSTROPHE

| Code Point | Name | Used In |
|------------|------|---------|
| U+2018 | LEFT SINGLE QUOTATION MARK | English, many European |
| U+2019 | RIGHT SINGLE QUOTATION MARK | English (also apostrophe) |
| U+201A | SINGLE LOW-9 QUOTATION MARK | German, Polish, Czech |
| U+201B | SINGLE HIGH-REVERSED-9 MARK | Rare, some African languages |
| U+2039 | SINGLE LEFT-POINTING ANGLE QUOTE | French, sometimes |
| U+203A | SINGLE RIGHT-POINTING ANGLE QUOTE | French, sometimes |
| U+0060 | GRAVE ACCENT | Commonly misused as quote |
| U+00B4 | ACUTE ACCENT | Commonly misused as quote |
| U+2032 | PRIME | Minutes/feet, often confused |
| U+FF07 | FULLWIDTH APOSTROPHE | CJK contexts (NFKC may miss contextually) |

### Double Quotes → U+0022 QUOTATION MARK

| Code Point | Name | Used In |
|------------|------|---------|
| U+201C | LEFT DOUBLE QUOTATION MARK | English |
| U+201D | RIGHT DOUBLE QUOTATION MARK | English |
| U+201E | DOUBLE LOW-9 QUOTATION MARK | German „Anführungszeichen" |
| U+201F | DOUBLE HIGH-REVERSED-9 MARK | Rare |
| U+00AB | LEFT-POINTING DOUBLE ANGLE QUOTE | French «guillemets», Russian |
| U+00BB | RIGHT-POINTING DOUBLE ANGLE QUOTE | French, Russian, many European |
| U+2033 | DOUBLE PRIME | Seconds/inches, often confused |
| U+301D | REVERSED DOUBLE PRIME QUOTATION | CJK |
| U+301E | DOUBLE PRIME QUOTATION MARK | CJK |
| U+301F | LOW DOUBLE PRIME QUOTATION MARK | CJK |
| U+FF02 | FULLWIDTH QUOTATION MARK | CJK (NFKC may handle) |

**Important language note:** Guillemets (« ») are the standard quotation marks in
French, Russian, Arabic, and others. Normalizing them to `"` loses the "this is a
quote" visual in those languages, but the SEMANTIC content is identical — they're
quote delimiters. For a canonical form intended for signing, this is correct.

### CJK Quotation Marks → ASCII

| Code Point | Name | Maps To |
|------------|------|---------|
| U+300C | LEFT CORNER BRACKET「 | U+0022 " |
| U+300D | RIGHT CORNER BRACKET」 | U+0022 " |
| U+300E | LEFT WHITE CORNER BRACKET『 | U+0022 " |
| U+300F | RIGHT WHITE CORNER BRACKET』 | U+0022 " |
| U+FE41 | PRESENTATION FORM FOR VERTICAL LEFT CORNER BRACKET | U+0022 " |
| U+FE42 | PRESENTATION FORM FOR VERTICAL RIGHT CORNER BRACKET | U+0022 " |
| U+FE43 | PRESENTATION FORM FOR VERTICAL LEFT WHITE CORNER BRACKET | U+0022 " |
| U+FE44 | PRESENTATION FORM FOR VERTICAL RIGHT WHITE CORNER BRACKET | U+0022 " |

**⚠️  DESIGN DECISION:** CJK corner brackets are the standard quotation marks in
Japanese and traditional Chinese. Normalizing 「」to `""` is aggressive. An
alternative is to normalize 「」→「」 (keep as-is) and only normalize Western
variants. **Recommendation: normalize them.** The goal is hash stability across
CMS round-trips, and CMS editors in CJK locales will freely swap between these
and fullwidth quotes.

---

## Phase 4: Dash and Hyphen Normalization

### All Dashes → U+002D HYPHEN-MINUS

| Code Point | Name | Notes |
|------------|------|-------|
| U+2010 | HYPHEN | "Real" hyphen |
| U+2011 | NON-BREAKING HYPHEN | Rendering hint |
| U+2012 | FIGURE DASH | Used in phone numbers |
| U+2013 | EN DASH | Ranges, CMSes love inserting these |
| U+2014 | EM DASH | CMSes auto-convert -- to this |
| U+2015 | HORIZONTAL BAR | Dialogue in some languages |
| U+FE58 | SMALL EM DASH | CJK vertical form |
| U+FE63 | SMALL HYPHEN-MINUS | CJK small form |
| U+FF0D | FULLWIDTH HYPHEN-MINUS | CJK (NFKC should handle but verify) |

**⚠️  DESIGN DECISION:** This is the most aggressive normalization. En dash, em dash,
and hyphen ARE semantically different in professional typography. However:
- CMSes auto-convert `--` → `–` and `---` → `—` inconsistently
- Copy-paste from Word/Docs introduces these unpredictably
- For signing stability, collapsing is worth the tradeoff

**Alternative:** Normalize only U+2011 (non-breaking) and U+2012 (figure) to
U+002D, but preserve U+2013/U+2014. This preserves more authorial intent but
increases hash fragility. Your call.

---

## Phase 5: Other Punctuation Normalization

### Ellipsis

| Code Point | Name | Maps To |
|------------|------|---------|
| U+2026 | HORIZONTAL ELLIPSIS … | `...` (three U+002E) |
| U+FE19 | PRESENTATION FORM FOR VERTICAL HORIZONTAL ELLIPSIS | `...` |

NFKC does NOT decompose ellipsis. CMSes freely interchange `...` and `…`.

### Minus Sign

| Code Point | Name | Maps To |
|------------|------|---------|
| U+2212 | MINUS SIGN | U+002D HYPHEN-MINUS |

### Bullets

| Code Point | Name | Maps To |
|------------|------|---------|
| U+2022 | BULLET • | Keep (semantic in lists) |
| U+2023 | TRIANGULAR BULLET | U+2022 |
| U+2043 | HYPHEN BULLET | U+2022 |
| U+25E6 | WHITE BULLET | U+2022 |

Actually — bullets within `<li>` elements are generated by CSS, not present in text.
If bullets appear in raw text nodes, they're authored content. **Keep all as-is.**
Remove this section from normalization.

### Spaces around punctuation — DO NOT NORMALIZE

French typography requires spaces before `:;!?`. Don't strip them — the whitespace
collapsing in Phase 2 is sufficient. The space will be preserved as a single space.

---

## Phase 6: Strip Invisible/Formatting Characters

These characters have NO content semantics. They are rendering hints, layout
controls, or exploitable for hash manipulation.

### Always Strip (Remove Entirely)

| Code Point(s) | Name | Rationale |
|----------------|------|-----------|
| U+00AD | SOFT HYPHEN | Line-break hint only |
| U+200B | ZERO WIDTH SPACE | Line-break hint only |
| U+2060 | WORD JOINER | Line-break prevention hint |
| U+FEFF | BOM / ZERO WIDTH NO-BREAK SPACE | Byte order mark, or legacy ZWNBSP |
| U+034F | COMBINING GRAPHEME JOINER | Rendering hint |
| U+061C | ARABIC LETTER MARK | Bidi hint |
| U+180E | MONGOLIAN VOWEL SEPARATOR | Legacy, reclassified as formatting |
| U+FE00–U+FE0F | VARIATION SELECTORS 1–16 | Glyph selection (emoji vs text) |
| U+E0100–U+E01EF | VARIATION SELECTORS 17–256 | CJK glyph variants |
| U+E0001–U+E007F | TAG CHARACTERS | Deprecated, used in flag emoji |
| U+FFF9–U+FFFB | INTERLINEAR ANNOTATION ANCHORS | |
| U+FFFC | OBJECT REPLACEMENT CHARACTER | |
| U+2061–U+2064 | INVISIBLE MATH OPERATORS | |
| U+2066–U+2069 | BIDI ISOLATE CONTROLS (LRI, RLI, FSI, PDI) | See bidi section |
| U+202A–U+202E | BIDI EMBEDDING CONTROLS (LRE, RLE, LRO, RLO, PDF) | See bidi section |
| U+200E | LEFT-TO-RIGHT MARK | See bidi section |
| U+200F | RIGHT-TO-LEFT MARK | See bidi section |

### Keep (Semantically Meaningful)

| Code Point | Name | Rationale |
|------------|------|-----------|
| U+200C | ZERO WIDTH NON-JOINER (ZWNJ) | **Semantic in Persian, Kurdish, Syriac** — changes word meaning |
| U+200D | ZERO WIDTH JOINER (ZWJ) | **Semantic in Indic scripts, emoji sequences** |

**ZWNJ Example (Persian):**
- می‌خواهم (mi-khāham, "I want") — ZWNJ separates the prefix
- میخواهم (mikhāham) — runs together, different visual parsing

**ZWJ Example (Devanagari):**
- क्‍ (ka + virama + ZWJ) — half form
- क् (ka + virama) — full conjunct

Stripping these would corrupt content in multiple major languages.

---

## Phase 7: Bidi Handling

**Strategy:** Strip ALL bidi control characters. Rely on `dir` attribute on HTML
elements (preserved in our attribute allowlist) for directionality.

This works because:
1. The `dir` attribute is the W3C-recommended way to specify direction in HTML
2. Bidi control characters in HTML are often inserted by editors inconsistently
3. The HTML bidi algorithm (UAX #9) operates on the DOM, not raw text
4. `dir="rtl"` / `dir="ltr"` / `dir="auto"` on elements is deterministic

**Characters stripped:** LRM, RLM, LRE, RLE, LRO, RLO, PDF, LRI, RLI, FSI, PDI
(all listed in Phase 6)

**What about mixed-direction content?** Example: Arabic text with an English
product name embedded. The HTML should use:
```html
<p dir="rtl">هذا المنتج <span dir="ltr">iPhone 15</span> ممتاز</p>
```
The `dir` attributes survive canonicalization. The bidi controls don't, and
shouldn't — they're the fragile alternative to proper markup.

---

## Phase 8: Language-Specific Considerations

### Arabic
- **Tatweel/Kashida (U+0640):** STRIP. It's a justification character (stretches
  words visually). Not semantic. `كتـــــاب` = `كتاب` (kitāb, "book").
- **Presentation forms (U+FB50–U+FDFF, U+FE70–U+FEFF):** NFKC handles these →
  base Arabic characters. No extra work.
- **Diacritics (tashkīl: fatḥa, kasra, ḍamma, etc.):** KEEP. They change
  pronunciation and sometimes meaning. `عِلم` (ʿilm, knowledge) vs `عَلَم` (ʿalam, flag).

### Hebrew
- **Presentation forms (U+FB1D–U+FB4F):** NFKC handles these.
- **Cantillation marks:** KEEP. Semantic in religious texts.
- **Nikud (vowel points):** KEEP. Same rationale as Arabic diacritics.

### CJK (Chinese, Japanese, Korean)
- **CJK compatibility ideographs:** NFKC handles.
- **Fullwidth ASCII:** NFKC handles (Ａ→A, ０→0).
- **Halfwidth Katakana:** NFKC handles (ｱ→ア).
- **Ideographic space (U+3000):** Phase 2 handles → regular space.
- **CJK punctuation (。、「」etc.):** See quote section above. Other CJK
  punctuation (。period, 、comma) is **preserved** — it's the correct punctuation
  for those languages, not a variant of ASCII punctuation.
- **Kangxi radicals (U+2F00–U+2FDF):** NFKC maps to unified ideographs. Good.

### Thai / Lao / Khmer
- No word spaces — nothing to normalize.
- Mai han akat and other above-vowels: KEEP (semantic).
- These scripts work fine with NFKC alone.

### Indic Scripts (Devanagari, Bengali, Tamil, etc.)
- **ZWJ/ZWNJ:** Preserved (Phase 6). Critical for correct conjunct formation.
- **Nukta (U+093C etc.):** NFKC handles canonical ordering of combining marks.
- **Vedic extensions:** KEEP.

### Korean
- **Jamo vs. precomposed Hangul:** NFKC composes Jamo into syllable blocks
  (ᄒ+ᅡ+ᆫ → 한). This is correct.

### Latin / Cyrillic / Greek
- **Precomposed vs. combining:** NFKC handles (é = é after NFC/NFKC).
- **Cyrillic confusables (а vs a):** NOT normalized. These are different scripts
  and different Unicode code points. Normalizing them would corrupt legitimate
  Cyrillic text. If you need homoglyph detection, that's a separate layer
  (and shouldn't be in canonicalization — it's a trust/security concern).

---

## Complete JS Implementation

```javascript
// Canonical Character Normalization for <signed-section>
// Spec-complete, zero dependencies, browser-native

const STRIP_RE = new RegExp([
  '\\u00AD',          // soft hyphen
  '\\u200B',          // zero-width space
  '\\u200E',          // LRM
  '\\u200F',          // RLM
  '\\u2060',          // word joiner
  '\\uFEFF',          // BOM/ZWNBSP
  '\\u034F',          // combining grapheme joiner
  '\\u061C',          // arabic letter mark
  '\\u180E',          // mongolian vowel separator
  '\\u0640',          // arabic tatweel
  '[\\uFE00-\\uFE0F]',  // variation selectors
  '[\\u202A-\\u202E]',  // bidi embedding controls
  '[\\u2066-\\u2069]',  // bidi isolate controls
  '[\\u2061-\\u2064]',  // invisible math operators
  '[\\uFFF9-\\uFFFC]',  // interlinear annotation + obj replacement
  // Supplementary plane (need surrogate pairs or unicode flag)
].join('|'), 'gu');

// Also strip supplementary plane characters (requires /u flag works in target)
const STRIP_SUPPLEMENTARY_RE = /[\u{E0001}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

const WHITESPACE_RE = /[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g;

const SINGLE_QUOTE_RE = /[\u2018\u2019\u201A\u201B\u2039\u203A\u0060\u00B4\u2032]/g;

const DOUBLE_QUOTE_RE = /[\u201C\u201D\u201E\u201F\u00AB\u00BB\u2033\u301D\u301E\u301F]/g;

const CJK_QUOTE_RE = /[\u300C\u300D\u300E\u300F\uFE41-\uFE44]/g;

const DASH_RE = /[\u2010-\u2015\u2212\uFE58\uFE63]/g;

const ELLIPSIS_RE = /\u2026/g;

/**
 * Normalize text content for canonical signing.
 * Apply AFTER extracting text from DOM, BEFORE hashing.
 *
 * @param {string} text - raw text content
 * @param {boolean} preserveWhitespace - true inside <pre> elements
 * @returns {string} normalized text
 */
function normalizeText(text, preserveWhitespace = false) {
  // Phase 1: Unicode NFKC
  text = text.normalize('NFKC');

  // Phase 6: Strip invisible/formatting characters
  text = text.replace(STRIP_RE, '');
  text = text.replace(STRIP_SUPPLEMENTARY_RE, '');

  // Phase 2: Whitespace normalization
  if (!preserveWhitespace) {
    text = text.replace(WHITESPACE_RE, ' ');
    text = text.replace(/ {2,}/g, ' ');
  }

  // Phase 3: Quotation marks
  text = text.replace(SINGLE_QUOTE_RE, "'");
  text = text.replace(DOUBLE_QUOTE_RE, '"');
  text = text.replace(CJK_QUOTE_RE, '"');

  // Phase 4: Dashes
  text = text.replace(DASH_RE, '-');

  // Phase 5: Other punctuation
  text = text.replace(ELLIPSIS_RE, '...');

  return text;
}

export { normalizeText };
```

---

## Verification Checklist

A conformant implementation MUST produce identical output for these test pairs:

| Input A | Input B | Expected: Same? |
|---------|---------|-----------------|
| `"Hello"` (curly) | `"Hello"` (straight) | ✅ Same |
| `café` (precomposed) | `café` (combining) | ✅ Same (NFKC) |
| `ﬁnd` (ligature) | `find` | ✅ Same (NFKC) |
| `word — word` (em dash) | `word - word` | ✅ Same |
| `«Bonjour»` | `"Bonjour"` | ✅ Same |
| `「東京」` | `"東京"` | ✅ Same |
| `می‌خواهم` (ZWNJ) | `میخواهم` (no ZWNJ) | ❌ Different (ZWNJ is semantic) |
| `كتـــاب` (tatweel) | `كتاب` | ✅ Same |
| `Ａ１` (fullwidth) | `A1` | ✅ Same (NFKC) |
| `한` (syllable) | `한` (jamo) | ✅ Same (NFKC) |
| `①` | `1` | ✅ Same (NFKC) |
| `word\u200Bword` (ZWSP) | `wordword` | ✅ Same |
| `word\u200Cword` (ZWNJ) | `wordword` | ❌ Different |
