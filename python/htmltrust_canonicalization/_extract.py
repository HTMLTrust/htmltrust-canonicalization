"""HTML -> canonical text extraction (HTMLTrust spec §2.1).

Direct semantic port of ``extractCanonicalText`` from the JavaScript
reference implementation. The Python binding uses BeautifulSoup
(html.parser backend, stdlib) for parsing because real HTML is messy
and a forgiving parser produces more reliable output than the JS
binding's regex pipeline. The text-output contract (which elements
contribute, where whitespace separators go) is identical.
"""

from __future__ import annotations

import re

from bs4 import BeautifulSoup, NavigableString, Tag
from html5lib.html5parser import HTMLParser
from pywhatwgurl import URL

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
    "tr", "td", "th", "ul", "signed-section",
})
_SIGNED_ATTRS = ("href", "src", "alt", "aria-label")
_MAX_SOURCE_BYTES = 1024 * 1024
_MAX_OUTPUT_BYTES = 1024 * 1024
_MAX_ELEMENT_DEPTH = 256
_VOID_TAGS = frozenset({
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
})


def _preflight_source(html: str) -> None:
    """Validate the portable-1 source profile before tree construction.

    html5lib exposes tokenizer/tree-builder diagnostics, which must be
    checked before BeautifulSoup receives the recovered tree.  A few HTML5
    repairs (notably table foster parenting and foreign content) are not
    reported as parse errors by html5lib, so those profile cases are checked
    against the source as well.
    """
    try:
        source_bytes = html.encode("utf-8", "strict")
    except UnicodeEncodeError as exc:
        raise ValueError("parser-profile-unsupported") from exc
    if len(source_bytes) > _MAX_SOURCE_BYTES:
        raise ValueError("resource-limit-exceeded")

    # Count source element nesting before handing the document to an HTML5
    # tree builder. This keeps the ceiling independent of BeautifulSoup's
    # synthetic html/head/body wrapper nodes and makes the limit effective
    # before traversal can recurse.
    profile_source = _strip_excluded_element_contents(html)
    _check_source_depth(profile_source)

    parser = HTMLParser(namespaceHTMLElements=False, strict=False)
    parser.parseFragment(html)
    if parser.errors:
        raise ValueError("parser-profile-unsupported")


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
        preserve_whitespace: Legacy 0.2 option passed through to
            ``normalize_text``. v1 callers must leave it ``False``.
        base_url: Resolved document base URL computed by the source-snapshot
            layer, including any HTML ``<base>`` element. This binding does
            not discover ``<base>`` elements.

    Returns:
        Canonical text, ready to be hashed. Trimmed of leading/trailing
        whitespace.
    """
    if not isinstance(html, str):
        raise TypeError("extract_canonical_text expects a str")

    _preflight_source(html)
    base_url = _validate_base_url(base_url)
    # BeautifulSoup's html5lib backend exposes the same HTML5 tree model as
    # the diagnostics pass above.  The source has already been accepted, so
    # no parser repair is silently used as verification input.
    soup = BeautifulSoup(html, "html5lib")

    # Remove excluded elements (and their text content) outright.
    for tag_name in _EXCLUDED_TAGS:
        for elem in soup.find_all(tag_name):
            elem.decompose()

    parts: list[str] = []
    _walk(soup, parts, base_url, preserve_whitespace)

    text = "".join(parts)
    return _finalize_parts(text)


def _check_source_depth(source: str) -> None:
    """Validate source nesting and reject parser repairs.

    HTML5 parsers implicitly close elements and foster-parent text around a
    table. Those repairs are outside the portable profile, so this small
    source stack requires explicit matching end tags and checks direct table
    text before tree construction.
    """
    stack: list[str] = []
    cursor = 0
    for token_start, token_end in _iter_profile_tokens(source):
        text = source[cursor:token_start]
        if stack and stack[-1] == "table" and text.strip():
            raise ValueError("parser-profile-unsupported")
        cursor = token_end

        name = _profile_tag_name(source, token_start)
        if name is None:
            continue
        if source[token_start + 1:token_start + 2] == "/":
            if not stack or stack[-1] != name:
                raise ValueError("parser-profile-unsupported")
            stack.pop()
            continue
        if name in {"svg", "math", "foreignobject"}:
            raise ValueError("parser-profile-unsupported")
        if name not in _VOID_TAGS and _is_self_closing(source, token_start, token_end):
            raise ValueError("parser-profile-unsupported")
        if name not in _VOID_TAGS:
            stack.append(name)
            if len(stack) > _MAX_ELEMENT_DEPTH:
                raise ValueError("resource-limit-exceeded")

    if stack and stack[-1] == "table" and source[cursor:].strip():
        raise ValueError("parser-profile-unsupported")
    if stack:
        raise ValueError("parser-profile-unsupported")


def _iter_profile_tokens(source: str):
    """Yield complete HTML profile tokens in one bounded forward scan.

    The old token regex nested a repeated alternation containing ``+`` and
    quoted ``*`` branches.  A malformed attribute could make it retry many
    partitions of the same source span. This scanner handles comments,
    declarations, and quoted tag attributes directly. If a candidate token
    is incomplete, iteration stops and the HTML5 diagnostics below report the
    malformed source.
    """
    cursor = 0
    source_length = len(source)
    while cursor < source_length:
        start = source.find("<", cursor)
        if start < 0:
            return

        if source.startswith("<!--", start):
            comment_end = source.find("-->", start + 4)
            if comment_end < 0:
                return
            token_end = comment_end + 3
            yield start, token_end
            cursor = token_end
            continue

        if source.startswith("<!", start):
            declaration_end = source.find(">", start + 2)
            if declaration_end < 0:
                return
            token_end = declaration_end + 1
            yield start, token_end
            cursor = token_end
            continue

        if not _looks_like_profile_tag(source, start):
            cursor = start + 1
            continue
        token_end = _scan_profile_tag_end(source, start)
        if token_end is None:
            return
        yield start, token_end
        cursor = token_end


def _looks_like_profile_tag(source: str, start: int) -> bool:
    r"""Match the initial ``</?\s*[a-z]`` token shape without a regex."""
    index = start + 1
    if index < len(source) and source[index] == "/":
        index += 1
    while index < len(source) and source[index].isspace():
        index += 1
    return index < len(source) and "a" <= source[index].lower() <= "z"


def _scan_profile_tag_end(source: str, start: int) -> int | None:
    """Return the first unquoted ``>`` in a profile tag."""
    quote: str | None = None
    index = start + 1
    while index < len(source):
        char = source[index]
        if quote is not None:
            if char == quote:
                quote = None
        elif char in "\"'":
            quote = char
        elif char == ">":
            return index + 1
        index += 1
    return None


def _profile_tag_name(source: str, start: int) -> str | None:
    """Extract a token name using the former tag-name character class."""
    index = start + 1
    if index < len(source) and source[index] == "/":
        index += 1
    while index < len(source) and source[index].isspace():
        index += 1
    if index >= len(source) or not ("a" <= source[index].lower() <= "z"):
        return None
    name_start = index
    index += 1
    while index < len(source) and source[index] not in "\t\n\f\r />":
        index += 1
    return source[name_start:index].lower()


def _is_self_closing(source: str, start: int, end: int) -> bool:
    r"""Check for a self-closing flag outside an unquoted attribute value."""
    index = end - 2
    while index >= start and source[index].isspace():
        index -= 1
    if index < start or source[index] != "/":
        return False
    prefix = source[start:index]
    if prefix and prefix[-1].isspace():
        return True
    return re.fullmatch(r"<\s*[a-z][^\t\n\f\r />]*", prefix, re.IGNORECASE) is not None


def _strip_excluded_element_contents(source: str) -> str:
    """Remove the contents of paired raw-text/profile-excluded elements.

    This pass exists only to keep script, style, and iframe contents from
    affecting the source-depth check.  The previous implementation used a
    nested regular expression for quoted attributes and arbitrary element
    contents.  A malformed opening tag could make that expression explore an
    exponential number of partitions.  The scanner below advances through
    each character at most a constant number of times and rejects incomplete
    excluded opening tags with the parser's profile error.
    """
    excluded = frozenset(("script", "style", "iframe"))
    output: list[str] = []
    cursor = 0
    source_length = len(source)

    while cursor < source_length:
        start = _find_excluded_start(source, cursor, excluded)
        if start is None:
            output.append(source[cursor:])
            break

        output.append(source[cursor:start])
        opening_end = _scan_tag_end(source, start)
        if opening_end is None:
            # The HTML5 diagnostics reject an incomplete excluded opening
            # tag. Reject it here before the source-depth tokenizer sees the
            # malformed token and can spend unbounded time recovering it.
            raise ValueError("parser-profile-unsupported")

        name = _start_tag_name(source, start)
        if name is None or name not in excluded:
            output.append(source[start:opening_end])
            cursor = opening_end
            continue

        closing = _find_matching_close(source, opening_end, name)
        if closing is None:
            # Keep a complete but unpaired element available to the parser
            # diagnostics. Its opening token is well-formed, so the bounded
            # source-depth scan can report the missing end tag.
            output.append(source[start:])
            break

        close_start, close_end = closing
        output.append(source[start:opening_end])
        output.append(source[close_start:close_end])
        cursor = close_end

    return "".join(output)


def _find_excluded_start(
    source: str,
    offset: int,
    excluded: frozenset[str],
) -> int | None:
    """Find the next source spelling of an excluded start tag."""
    index = offset
    while True:
        index = source.find("<", index)
        if index < 0:
            return None
        name = _start_tag_name(source, index)
        if name in excluded:
            return index
        index += 1


def _start_tag_name(source: str, start: int) -> str | None:
    """Return a candidate start-tag name using the profile regex grammar."""
    if start >= len(source) or source[start] != "<":
        return None
    index = start + 1
    while index < len(source) and source[index].isspace():
        index += 1
    if index >= len(source) or not ("a" <= source[index].lower() <= "z"):
        return None

    # The former expression captures the literal excluded name and applies a
    # regex word boundary.  Keep that spelling, including qualified names
    # such as ``<script:foo>``, rather than attempting to implement the full
    # HTML tag-name grammar here.
    for name in ("script", "style", "iframe"):
        end = index + len(name)
        if source[index:end].lower() != name:
            continue
        if end == len(source) or not (
            source[end].isalnum() or source[end] == "_"
        ):
            return name
    return None


def _scan_tag_end(source: str, start: int) -> int | None:
    """Return the first unquoted ``>`` after a candidate tag start."""
    quote: str | None = None
    index = start + 1
    while index < len(source):
        char = source[index]
        if quote is not None:
            if char == quote:
                quote = None
        elif char in "\"'":
            quote = char
        elif char == ">":
            return index + 1
        index += 1
    return None


def _find_matching_close(
    source: str,
    offset: int,
    name: str,
) -> tuple[int, int] | None:
    """Find ``</name>`` with the whitespace/case rules of the old regex."""
    index = offset
    name_length = len(name)
    source_length = len(source)
    while True:
        index = source.find("<", index)
        if index < 0:
            return None
        cursor = index + 1
        if cursor >= source_length or source[cursor] != "/":
            index += 1
            continue
        cursor += 1
        while cursor < source_length and source[cursor].isspace():
            cursor += 1
        if source[cursor:cursor + name_length].lower() != name:
            index += 1
            continue
        cursor += name_length
        while cursor < source_length and source[cursor].isspace():
            cursor += 1
        if cursor < source_length and source[cursor] == ">":
            return index, cursor + 1
        index += 1


def _validate_base_url(base_url: str | None) -> str | None:
    """Validate and serialize the optional document base URL up front."""
    if base_url is None or base_url == "":
        return None
    try:
        if len(base_url.encode("utf-8", "strict")) > _MAX_SOURCE_BYTES:
            raise ValueError("resource-limit-exceeded")
    except UnicodeEncodeError as exc:
        raise ValueError("attribute-canonicalization-failed") from exc
    try:
        base = URL(base_url)
    except Exception as exc:
        raise ValueError("attribute-canonicalization-failed") from exc
    if base.protocol != "https:" or not base.hostname or base.username or base.password:
        raise ValueError("url-policy-violation")
    return str(base)


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
            out.append(_escape_text(normalize_text(str(child), preserve_whitespace)))
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
            value = _canonicalize_url(value, base_url)
        else:
            value = normalize_text(value).strip()
        if "\n" in value:
            raise ValueError("attribute-canonicalization-failed")
        value = value.replace("@", "@@")
        if out and out[-1] and not out[-1][-1].isspace():
            out.append("\n")
        out.append(f"@attr:{element_name}:{attr_name}:{value}\n")


def _canonicalize_url(value: str, base_url: str | None) -> str:
    """Parse and serialize an href/src with the WHATWG URL algorithm."""
    # URL preprocessing must not erase controls before policy validation.
    if any(ord(ch) <= 0x1F or ord(ch) == 0x7F for ch in value):
        raise ValueError("url-policy-violation")
    try:
        base = URL(base_url) if base_url is not None else None
    except Exception as exc:
        raise ValueError("attribute-canonicalization-failed") from exc
    if base is not None:
        if base.protocol != "https:" or not base.hostname or base.username or base.password:
            raise ValueError("url-policy-violation")
    try:
        parsed = URL(value, str(base) if base is not None else None)
    except Exception as exc:
        raise ValueError("attribute-canonicalization-failed") from exc
    if parsed.protocol != "https:" or parsed.username or parsed.password:
        raise ValueError("url-policy-violation")
    if not parsed.hostname:
        raise ValueError("attribute-canonicalization-failed")
    return str(parsed)


def _escape_text(value: str) -> str:
    """Escape commercial-at signs in text-node records (htmltrust-c14n-v1)."""
    return value.replace("@", "@@")


def _finalize_parts(text: str) -> str:
    while "  " in text:
        text = text.replace("  ", " ")
    # Finalization is shared with the other bindings, including for
    # preserve_whitespace extraction. Spaces and tabs adjacent to a boundary
    # are formatting introduced by the DOM walk and must not remain around
    # the emitted line feed.
    text = re.sub(r"[ \t]*\n[ \t]*", "\n", text)
    while "\n\n" in text:
        text = text.replace("\n\n", "\n")
    text = text.strip()
    if len(text.encode("utf-8")) > _MAX_OUTPUT_BYTES:
        raise ValueError("resource-limit-exceeded")
    return text
