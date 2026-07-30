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
from urllib.parse import urljoin, urlsplit, urlunsplit

from ._normalize import normalize_text

# Elements whose text content is NEVER part of the signed content.
# `<meta>` is excluded because, inside a signed-section, it carries
# claim metadata, not signed content (claims are hashed separately into
# the claims-hash field).
_EXCLUDED_TAGS = frozenset({
    "script", "style", "meta", "link", "head", "noscript",
    "template", "iframe",
})

# Boundary-producing elements from the protocol draft. A boundary-producing
# element emits a line feed after its descendants have contributed text.
# Inline elements (em, strong, a, span, etc.) do NOT introduce separators,
# so "<p>hello <em>world</em></p>" canonicalizes to "hello world".
_BLOCK_TAGS = frozenset({
    "address", "article", "aside", "blockquote", "details", "dialog", "div",
    "dl", "fieldset", "figcaption", "figure", "footer", "form",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "header", "hgroup", "hr", "li", "main", "nav", "ol",
    "p", "pre", "section", "table",
    "tr", "td", "th", "ul",
})
_SIGNED_ATTRS = ("href", "src", "alt", "aria-label")


def extract_canonical_text(
    html: str,
    preserve_whitespace: bool = False,
    base_url: str | None = None,
) -> str:
    """Extract canonical text content from an HTML fragment.

    Given an HTML fragment (typically the inner contents of a
    ``<signed-section>`` element), this:

      1. Strips excluded elements (script, style, meta, link, head, noscript)
         and their contents.
      2. Walks the remaining tree in document order, inserting a line feed
         after every boundary-producing element so that ``<p>A</p><p>B</p>``
         extracts to ``"A\nB"`` and not ``"AB"``.
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
    _walk(soup, parts, base_url, preserve_whitespace)

    text = "".join(parts)
    return _finalize_parts(text)


def _walk(
    node,
    out: list[str],
    base_url: str | None,
    preserve_whitespace: bool,
) -> None:
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
            out.append(normalize_text(str(child), preserve_whitespace))
        elif isinstance(child, Tag):
            name = child.name.lower() if child.name else ""
            is_block = name in _BLOCK_TAGS
            _append_attribute_records(out, name, child, base_url)
            if name == "br":
                out.append("\n")
            else:
                _walk(child, out, base_url, preserve_whitespace)
            if is_block:
                out.append("\n")


def _append_attribute_records(
    out: list[str],
    element_name: str,
    tag: Tag,
    base_url: str | None,
) -> None:
    for attr_name in _SIGNED_ATTRS:
        if not tag.has_attr(attr_name):
            continue
        raw_value = tag.get(attr_name)
        if isinstance(raw_value, list):
            raw_value = " ".join(str(v) for v in raw_value)
        value = str(raw_value)
        if attr_name in ("href", "src"):
            if base_url is None and not urlsplit(value).scheme:
                # Relative URL with no base cannot be resolved. The draft
                # (§4.3.2) requires a hard failure rather than a silent skip.
                raise ValueError("attribute-canonicalization-failed")
            value = _canonicalize_url(value, base_url)
        else:
            value = normalize_text(value).strip()
        if "\n" in value:
            raise ValueError("attribute-canonicalization-failed")
        if out and out[-1] and not out[-1][-1].isspace():
            out.append("\n")
        out.append(f"@attr:{element_name}:{attr_name}:{value}\n")


def _remove_dot_segments(path: str) -> str:
    """RFC 3986 §5.2.4 remove_dot_segments, matching the WHATWG URL path
    normalization the reference JS/Rust bindings perform via ``new URL``."""
    out = ""
    inp = path
    while inp:
        if inp.startswith("../"):
            inp = inp[3:]
        elif inp.startswith("./"):
            inp = inp[2:]
        elif inp.startswith("/./"):
            inp = "/" + inp[3:]
        elif inp == "/.":
            inp = "/"
        elif inp.startswith("/../"):
            inp = "/" + inp[4:]
            out = out[: out.rfind("/")] if "/" in out else ""
        elif inp == "/..":
            inp = "/"
            out = out[: out.rfind("/")] if "/" in out else ""
        elif inp in (".", ".."):
            inp = ""
        else:
            j = inp.find("/", 1) if inp.startswith("/") else inp.find("/")
            if j == -1:
                out += inp
                inp = ""
            else:
                out += inp[:j]
                inp = inp[j:]
    return out


def _canonicalize_url(value: str, base_url: str | None) -> str:
    """Canonicalize an href/src value using the Web (WHATWG) URL serializer
    semantics: lowercase scheme + host, IDNA/punycode host, strip default
    ports, resolve dot-segments, preserve query and fragment. Produces the
    same bytes as ``new URL(value, base).href`` for the cases the conformance
    vectors exercise (draft §4.3.2)."""
    try:
        absolute = urljoin(base_url or "", value)
        parts = urlsplit(absolute)
    except Exception as exc:  # pragma: no cover - defensive URL parser guard
        raise ValueError("attribute-canonicalization-failed") from exc
    if not parts.scheme:
        raise ValueError("attribute-canonicalization-failed")
    if not parts.netloc:
        # Opaque URL with no authority (mailto:, tel:, javascript:, data:,
        # about:, sms:, geo:, ...). The WHATWG URL parser accepts these; the
        # part after "scheme:" is an opaque path that is serialized verbatim
        # (scheme lowercased), matching new URL().href. No host/port/dot-segment
        # normalization applies.
        return urlunsplit((parts.scheme.lower(), "", parts.path, parts.query, parts.fragment))
    if parts.username or parts.password:
        raise ValueError("attribute-canonicalization-failed")
    hostname = (parts.hostname or "").lower()
    if not hostname:
        raise ValueError("attribute-canonicalization-failed")
    if hostname.isascii():
        netloc = hostname
    else:
        try:
            netloc = hostname.encode("idna").decode("ascii")
        except Exception as exc:
            raise ValueError("attribute-canonicalization-failed") from exc
    if parts.port is not None:
        default = (parts.scheme == "http" and parts.port == 80) or (
            parts.scheme == "https" and parts.port == 443
        )
        if not default:
            netloc = f"{netloc}:{parts.port}"
    path = _remove_dot_segments(parts.path or "/") or "/"
    if not path.startswith("/"):
        path = "/" + path
    return urlunsplit((parts.scheme.lower(), netloc, path, parts.query, parts.fragment))


def _finalize_parts(text: str) -> str:
    while "  " in text:
        text = text.replace("  ", " ")
    text = text.replace(" \n", "\n").replace("\n ", "\n")
    while "\n\n" in text:
        text = text.replace("\n\n", "\n")
    return text.strip()
