"""Text normalization (the 8-phase HTMLTrust canonicalization pipeline).

Direct port of the JavaScript reference implementation
(htmltrust-canonicalization/javascript/index.js, function ``normalizeText``).

The character classes below are byte-for-byte the same Unicode
codepoint sets used by the JavaScript and Go bindings; output MUST be
byte-identical across language implementations.

To keep this source file pure-ASCII and immune to editor mangling, the
character sets are built programmatically from explicit codepoint
ranges via ``chr()``. Each list entry is an ``(int, int)`` pair giving
an inclusive range, OR a single ``int`` for a single codepoint.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Iterable, Union

_RangeOrPoint = Union[int, tuple[int, int]]


def _build_class(items: Iterable[_RangeOrPoint]) -> str:
    """Build a regex character class string from ``items``.

    Each item is either a single codepoint (``int``) or an inclusive
    ``(start, end)`` range. Returns ``"[<chars>]"`` ready for ``re.compile``.
    """
    parts: list[str] = []
    for item in items:
        if isinstance(item, int):
            parts.append(re.escape(chr(item)))
        else:
            start, end = item
            # No re.escape on the dash separator; we want the literal '-'.
            parts.append(f"{re.escape(chr(start))}-{re.escape(chr(end))}")
    return "[" + "".join(parts) + "]"


# ---------------------------------------------------------------------------
# Phase 6 + 7: Invisible / formatting / bidi characters to strip.
#
# Mirrors JS reference STRIP_RE byte-for-byte. ZWNJ (U+200C) and ZWJ
# (U+200D) are deliberately preserved -- they are semantic in Persian,
# Indic, and emoji.
# ---------------------------------------------------------------------------
_STRIP_CODEPOINTS: list[_RangeOrPoint] = [
    0x00AD,                 # soft hyphen
    0x200B,                 # zero-width space
    0x200E,                 # LRM
    0x200F,                 # RLM
    0x2060,                 # word joiner
    0xFEFF,                 # BOM / ZWNBSP
    0x034F,                 # combining grapheme joiner
    0x061C,                 # arabic letter mark
    0x180E,                 # mongolian vowel separator
    0x0640,                 # arabic tatweel
    (0xFE00, 0xFE0F),       # variation selectors 1-16
    (0x202A, 0x202E),       # bidi embedding controls
    (0x2066, 0x2069),       # bidi isolate controls
    (0x2061, 0x2064),       # invisible math operators
    (0xFFF9, 0xFFFC),       # interlinear annotation + obj replacement
]
_STRIP_RE = re.compile(_build_class(_STRIP_CODEPOINTS))

# Supplementary plane: variation selectors 17-256, tag characters.
_STRIP_SUPPLEMENTARY_RE = re.compile(
    _build_class([(0xE0001, 0xE007F), (0xE0100, 0xE01EF)])
)

# ---------------------------------------------------------------------------
# Phase 2: Unicode whitespace -> U+0020.
#
# Mirrors JS reference WHITESPACE_RE byte-for-byte.
# ---------------------------------------------------------------------------
_WHITESPACE_CODEPOINTS: list[_RangeOrPoint] = [
    (0x0009, 0x000D),       # HT, LF, VT, FF, CR
    0x0020,                 # SPACE
    0x0085,                 # NEL
    0x00A0,                 # NBSP
    0x1680,                 # ogham space mark
    (0x2000, 0x200A),       # en quad .. hair space
    0x2028,                 # line separator
    0x2029,                 # paragraph separator
    0x202F,                 # narrow no-break space
    0x205F,                 # medium mathematical space
    0x3000,                 # ideographic space
]
_WHITESPACE_RE = re.compile(_build_class(_WHITESPACE_CODEPOINTS))
_RUN_OF_SPACES_RE = re.compile(r" {2,}")

# ---------------------------------------------------------------------------
# Phase 3: Quotation marks.
# Mirrors JS SINGLE_QUOTE_RE / DOUBLE_QUOTE_RE / CJK_QUOTE_RE byte-for-byte.
# ---------------------------------------------------------------------------
_SINGLE_QUOTE_CODEPOINTS: list[_RangeOrPoint] = [
    0x2018,  # left single quote
    0x2019,  # right single quote
    0x201B,  # single high-reversed-9
    0x2039,  # single left guillemet
    0x203A,  # single right guillemet
    0x0060,  # grave accent
    0x00B4,  # acute accent
    0x2032,  # prime
]
_SINGLE_QUOTE_RE = re.compile(_build_class(_SINGLE_QUOTE_CODEPOINTS))

_DOUBLE_QUOTE_CODEPOINTS: list[_RangeOrPoint] = [
    0x201A,  # single low-9 quote (intentionally mapped to double)
    0x201C,  # left double quote
    0x201D,  # right double quote
    0x201E,  # low double quote
    0x201F,  # double high-reversed-9
    0x00AB,  # left guillemet
    0x00BB,  # right guillemet
    0x2033,  # double prime
    0x301D,  # reversed double prime quotation mark
    0x301E,  # double prime quotation mark
    0x301F,  # low double prime quotation mark
]
_DOUBLE_QUOTE_RE = re.compile(_build_class(_DOUBLE_QUOTE_CODEPOINTS))

_CJK_QUOTE_CODEPOINTS: list[_RangeOrPoint] = [
    0x300C,                 # left corner bracket
    0x300D,                 # right corner bracket
    0x300E,                 # left white corner bracket
    0x300F,                 # right white corner bracket
    (0xFE41, 0xFE44),       # presentation forms for vertical corner brackets
]
_CJK_QUOTE_RE = re.compile(_build_class(_CJK_QUOTE_CODEPOINTS))

# ---------------------------------------------------------------------------
# Phase 4: Dashes -> U+002D (includes minus sign from Phase 5).
# Mirrors JS DASH_RE byte-for-byte.
# ---------------------------------------------------------------------------
_DASH_CODEPOINTS: list[_RangeOrPoint] = [
    (0x2010, 0x2015),       # hyphen .. horizontal bar
    0x2212,                 # minus sign
    0xFE58,                 # small em dash
    0xFE63,                 # small hyphen-minus
]
_DASH_RE = re.compile(_build_class(_DASH_CODEPOINTS))

# Phase 5: Ellipsis -> three periods.
_ELLIPSIS_RE = re.compile(re.escape(chr(0x2026)))


def normalize_text(text: str, preserve_whitespace: bool = False) -> str:
    """Apply the HTMLTrust 8-phase canonicalization pipeline to ``text``.

    Order matches the JavaScript reference implementation precisely.

    Args:
        text: Raw text content (typically the output of
            ``extract_canonical_text``).
        preserve_whitespace: Set ``True`` for ``<pre>`` content where
            whitespace is significant. Defaults to ``False``.

    Returns:
        Normalized text, suitable for hashing.
    """
    if not isinstance(text, str):
        raise TypeError("normalize_text expects a str")

    # Phase 1: NFKC -- ligatures, fullwidth/halfwidth, presentation forms,
    # superscripts, CJK compatibility, Jamo composition.
    text = unicodedata.normalize("NFKC", text)

    # Phases 6 + 7: strip invisible / formatting / bidi characters.
    # Done early so they don't interfere with later phases.
    text = _STRIP_RE.sub("", text)
    text = _STRIP_SUPPLEMENTARY_RE.sub("", text)

    # Phase 2: whitespace normalization.
    if not preserve_whitespace:
        text = _WHITESPACE_RE.sub(" ", text)
        text = _RUN_OF_SPACES_RE.sub(" ", text)

    # Phase 3: quotation marks.
    text = _SINGLE_QUOTE_RE.sub("'", text)
    text = _DOUBLE_QUOTE_RE.sub('"', text)
    text = _CJK_QUOTE_RE.sub('"', text)

    # Phase 4: dashes / hyphens / minus.
    text = _DASH_RE.sub("-", text)

    # Phase 5: ellipsis.
    text = _ELLIPSIS_RE.sub("...", text)

    return text
