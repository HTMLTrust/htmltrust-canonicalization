"""HTML -> canonical text extraction (HTMLTrust spec §2.1).

Direct semantic port of ``extractCanonicalText`` from the JavaScript
reference implementation. The Python binding uses BeautifulSoup
(html.parser backend, stdlib) for parsing because real HTML is messy
and a forgiving parser produces more reliable output than the JS
binding's regex pipeline. The text-output contract (which elements
contribute, where whitespace separators go) is identical.
"""

from __future__ import annotations

from bs4 import BeautifulSoup, NavigableString, Tag

from ._normalize import normalize_text

# Elements whose text content is NEVER part of the signed content.
# `<meta>` is excluded because, inside a signed-section, it carries
# claim metadata, not signed content (claims are hashed separately into
# the claims-hash field).
_EXCLUDED_TAGS = frozenset({
    "script", "style", "meta", "link", "head", "noscript",
})

# Block-level elements whose boundaries become whitespace separators.
# Inline elements (em, strong, a, span, etc.) do NOT introduce separators,
# so "<p>hello <em>world</em></p>" canonicalizes to "hello world".
_BLOCK_TAGS = frozenset({
    "address", "article", "aside", "blockquote", "canvas", "dd", "div",
    "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "header", "hr", "li", "main", "nav", "noscript", "ol", "output",
    "p", "pre", "section", "table", "tfoot", "thead",
    "tr", "td", "th", "ul", "video",
})


def extract_canonical_text(html: str, preserve_whitespace: bool = False) -> str:
    """Extract canonical text content from an HTML fragment.

    Given an HTML fragment (typically the inner contents of a
    ``<signed-section>`` element), this:

      1. Strips excluded elements (script, style, meta, link, head, noscript)
         and their contents.
      2. Walks the remaining tree in document order, inserting a single
         space at every block-element boundary so that ``<p>A</p><p>B</p>``
         extracts to ``"A B"`` and not ``"AB"``.
      3. Emits text nodes verbatim (entity-decoded by the parser).
      4. Applies the full text-normalization pipeline (``normalize_text``).

    Args:
        html: HTML fragment to canonicalize.
        preserve_whitespace: Passed through to ``normalize_text``.
            Defaults to ``False``.

    Returns:
        Canonical text, ready to be hashed. Trimmed of leading/trailing
        whitespace.
    """
    if not isinstance(html, str):
        raise TypeError("extract_canonical_text expects a str")

    soup = BeautifulSoup(html, "html.parser")

    # Remove excluded elements (and their text content) outright.
    for tag_name in _EXCLUDED_TAGS:
        for elem in soup.find_all(tag_name):
            elem.decompose()

    parts: list[str] = []
    _walk(soup, parts)

    text = "".join(parts)
    return normalize_text(text, preserve_whitespace).strip()


def _walk(node, out: list[str]) -> None:
    """Walk ``node`` in document order, appending text and block-boundary
    spaces to ``out`` in place.
    """
    for child in getattr(node, "children", ()):
        if isinstance(child, NavigableString):
            # bs4 navigable strings include comments / doctypes / cdata.
            # We only want plain text, not Comment / Doctype / CData.
            # Comment is a NavigableString subclass; check the type name.
            cls_name = type(child).__name__
            if cls_name in ("Comment", "Doctype", "CData", "ProcessingInstruction"):
                continue
            out.append(str(child))
        elif isinstance(child, Tag):
            name = child.name.lower() if child.name else ""
            is_block = name in _BLOCK_TAGS
            if is_block:
                out.append(" ")
            _walk(child, out)
            if is_block:
                out.append(" ")
            # Void elements (br, hr, img, etc.) within inline context: hr is
            # already in _BLOCK_TAGS; br is treated as inline (no separator),
            # matching the JS reference which strips br via ANY_TAG_RE.
