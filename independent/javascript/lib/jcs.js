// RFC 8785 JSON Canonicalization Scheme (JCS), plus the resource limits and
// duplicate-key rejection the draft layers on top of it (section 5, and the
// `jcs` conformance suite).
//
// This is a hand-rolled recursive-descent JSON parser, not JSON.parse, for
// three reasons the conformance fixtures make unavoidable:
//
//   1. JSON.parse silently keeps the last of two duplicate object member
//      names. The draft requires rejecting the document instead, and the
//      dup check runs on the *decoded* name (`"a"` and `"a"` collide).
//   2. JSON.parse does not reject a lone UTF-16 surrogate inside a string,
//      because a JS string can hold one. I-JSON (RFC 8785's base) requires
//      rejecting it.
//   3. Nesting depth has to be enforced as containers are opened, both to
//      cap recursion and because "malformed-surrogate-json" and
//      "oversized-malformed-json" fixtures pin an exact precedence order
//      between resource limits and syntax errors that only a parser under
//      our control can guarantee.
//
// Object members are kept as an ordered list of [name, valueNode] pairs
// rather than a plain JS object, so nothing here is exposed to the engine's
// own key-ordering rules (which silently resort integer-looking keys) --
// member order is entirely this module's decision, applied at serialize
// time.

import { fail, utf8ByteLength } from './errors.js';

const MAX_SOURCE_BYTES = 1024 * 1024; // 1 MiB, resource-limits table.
const MAX_CONTAINER_DEPTH = 256;

// --- Parsing ---------------------------------------------------------------

class Parser {
  constructor(text) {
    this.s = text;
    this.i = 0;
    this.n = text.length;
  }

  syntaxError(msg) {
    fail('jcs-invalid-json', `JSON syntax error at offset ${this.i}: ${msg}`);
  }

  peek() {
    return this.i < this.n ? this.s[this.i] : '';
  }

  skipWs() {
    while (this.i < this.n) {
      const c = this.s[this.i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') this.i++;
      else break;
    }
  }

  parseDocument() {
    this.skipWs();
    const value = this.parseValue(0);
    this.skipWs();
    if (this.i !== this.n) this.syntaxError('trailing data after JSON value');
    return value;
  }

  parseValue(depth) {
    const c = this.peek();
    if (c === '{') return this.parseObject(depth);
    if (c === '[') return this.parseArray(depth);
    if (c === '"') return { type: 'string', value: this.parseStringLiteral() };
    if (c === '-' || (c >= '0' && c <= '9')) return this.parseNumber();
    if (this.s.startsWith('true', this.i)) {
      this.i += 4;
      return { type: 'bool', value: true };
    }
    if (this.s.startsWith('false', this.i)) {
      this.i += 5;
      return { type: 'bool', value: false };
    }
    if (this.s.startsWith('null', this.i)) {
      this.i += 4;
      return { type: 'null' };
    }
    this.syntaxError(c === '' ? 'unexpected end of input' : `unexpected character ${JSON.stringify(c)}`);
  }

  enterContainer(depth) {
    const next = depth + 1;
    if (next > MAX_CONTAINER_DEPTH) fail('resource-limit-exceeded', 'JSON nesting exceeds 256 containers');
    return next;
  }

  parseObject(depth) {
    const childDepth = this.enterContainer(depth);
    this.i++; // '{'
    const entries = [];
    const seen = new Set();
    this.skipWs();
    if (this.peek() === '}') {
      this.i++;
      return { type: 'object', entries };
    }
    for (;;) {
      this.skipWs();
      if (this.peek() !== '"') this.syntaxError('expected string member name');
      const name = this.parseStringLiteral();
      if (seen.has(name)) fail('jcs-duplicate-key', `duplicate object member name ${JSON.stringify(name)}`);
      seen.add(name);
      this.skipWs();
      if (this.peek() !== ':') this.syntaxError("expected ':' after member name");
      this.i++;
      this.skipWs();
      const value = this.parseValue(childDepth);
      entries.push([name, value]);
      this.skipWs();
      const c = this.peek();
      if (c === ',') {
        this.i++;
        continue;
      }
      if (c === '}') {
        this.i++;
        return { type: 'object', entries };
      }
      this.syntaxError("expected ',' or '}' in object");
    }
  }

  parseArray(depth) {
    const childDepth = this.enterContainer(depth);
    this.i++; // '['
    const items = [];
    this.skipWs();
    if (this.peek() === ']') {
      this.i++;
      return { type: 'array', items };
    }
    for (;;) {
      this.skipWs();
      items.push(this.parseValue(childDepth));
      this.skipWs();
      const c = this.peek();
      if (c === ',') {
        this.i++;
        continue;
      }
      if (c === ']') {
        this.i++;
        return { type: 'array', items };
      }
      this.syntaxError("expected ',' or ']' in array");
    }
  }

  parseStringLiteral() {
    // Assumes this.peek() === '"'.
    this.i++;
    let out = '';
    for (;;) {
      if (this.i >= this.n) this.syntaxError('unterminated string');
      const c = this.s[this.i];
      const cc = c.charCodeAt(0);
      if (c === '"') {
        this.i++;
        break;
      }
      if (cc < 0x20) this.syntaxError('unescaped control character in string');
      if (c === '\\') {
        this.i++;
        if (this.i >= this.n) this.syntaxError('unterminated escape sequence');
        const e = this.s[this.i];
        switch (e) {
          case '"': out += '"'; this.i++; break;
          case '\\': out += '\\'; this.i++; break;
          case '/': out += '/'; this.i++; break;
          case 'b': out += '\b'; this.i++; break;
          case 'f': out += '\f'; this.i++; break;
          case 'n': out += '\n'; this.i++; break;
          case 'r': out += '\r'; this.i++; break;
          case 't': out += '\t'; this.i++; break;
          case 'u': {
            this.i++;
            const hex = this.s.slice(this.i, this.i + 4);
            if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
              this.syntaxError('invalid \\u escape');
            }
            out += String.fromCharCode(parseInt(hex, 16));
            this.i += 4;
            break;
          }
          default:
            this.syntaxError(`invalid escape \\${e}`);
        }
        continue;
      }
      out += c;
      this.i++;
    }
    return out;
  }

  parseNumber() {
    const start = this.i;
    if (this.peek() === '-') this.i++;
    if (this.peek() === '0') {
      this.i++;
    } else if (this.peek() >= '1' && this.peek() <= '9') {
      while (this.peek() >= '0' && this.peek() <= '9') this.i++;
    } else {
      this.syntaxError('invalid number');
    }
    if (this.peek() === '.') {
      this.i++;
      if (!(this.peek() >= '0' && this.peek() <= '9')) this.syntaxError('digit required after decimal point');
      while (this.peek() >= '0' && this.peek() <= '9') this.i++;
    }
    if (this.peek() === 'e' || this.peek() === 'E') {
      this.i++;
      if (this.peek() === '+' || this.peek() === '-') this.i++;
      if (!(this.peek() >= '0' && this.peek() <= '9')) this.syntaxError('digit required in exponent');
      while (this.peek() >= '0' && this.peek() <= '9') this.i++;
    }
    const token = this.s.slice(start, this.i);
    const negative = token.startsWith('-');
    const num = Number(token);
    if (!Number.isFinite(num)) {
      // RFC 8785 requires I-JSON numbers to be representable; a token that
      // overflows binary64 to +/-Infinity is out of range.
      fail('jcs-number', `number out of binary64 range: ${token}`);
    }
    if (negative && num === 0) {
      // RFC 8785 erratum 7920: a negative literal that is zero, or that
      // underflows to zero, is rejected rather than silently serialized as
      // indistinguishable positive zero.
      fail('jcs-number', `negative value underflows to zero: ${token}`);
    }
    return { type: 'number', value: num };
  }
}

/** Reject a string containing an unpaired UTF-16 surrogate (outside I-JSON). */
function checkNoLoneSurrogates(str) {
  for (let i = 0; i < str.length; i++) {
    const cc = str.charCodeAt(i);
    if (cc >= 0xd800 && cc <= 0xdbff) {
      // High surrogate: must be immediately followed by a low surrogate.
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++; // consumed as a pair
        continue;
      }
      fail('jcs-invalid-surrogate', 'unpaired UTF-16 high surrogate');
    }
    if (cc >= 0xdc00 && cc <= 0xdfff) {
      fail('jcs-invalid-surrogate', 'unpaired UTF-16 low surrogate');
    }
  }
}

function checkStringsForSurrogates(node) {
  switch (node.type) {
    case 'string':
      checkNoLoneSurrogates(node.value);
      return;
    case 'object':
      for (const [name, value] of node.entries) {
        checkNoLoneSurrogates(name);
        checkStringsForSurrogates(value);
      }
      return;
    case 'array':
      for (const item of node.items) checkStringsForSurrogates(item);
      return;
    default:
      return;
  }
}

// --- Serialization -----------------------------------------------------

const SHORT_ESCAPES = { 0x08: '\\b', 0x09: '\\t', 0x0a: '\\n', 0x0c: '\\f', 0x0d: '\\r' };

function serializeString(str) {
  let out = '"';
  for (let i = 0; i < str.length; i++) {
    const cc = str.charCodeAt(i);
    if (cc === 0x22) out += '\\"';
    else if (cc === 0x5c) out += '\\\\';
    else if (cc < 0x20) {
      out += SHORT_ESCAPES[cc] || '\\u' + cc.toString(16).padStart(4, '0');
    } else {
      out += str[i];
    }
  }
  return out + '"';
}

function serializeNumber(num) {
  // RFC 8785 section 3.2.2.3 mandates the ECMAScript Number::toString
  // representation. That is exactly what JS's own number-to-string
  // coercion produces (it is literally the algorithm the RFC names), so
  // this defers to the language rather than reimplementing shortest
  // round-trip float formatting by hand.
  if (Object.is(num, -0)) return '0'; // unreachable given the parser's own
  // negative-zero rejection, but kept defensive for values built outside
  // parseDocument (there are none today).
  return String(num);
}

function serializeValue(node) {
  switch (node.type) {
    case 'null':
      return 'null';
    case 'bool':
      return node.value ? 'true' : 'false';
    case 'number':
      return serializeNumber(node.value);
    case 'string':
      return serializeString(node.value);
    case 'array':
      return '[' + node.items.map(serializeValue).join(',') + ']';
    case 'object': {
      const sorted = node.entries.slice().sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return '{' + sorted.map(([name, value]) => serializeString(name) + ':' + serializeValue(value)).join(',') + '}';
    }
    default:
      throw new Error(`unreachable node type ${node.type}`);
  }
}

/**
 * Canonicalize a JSON text per RFC 8785, applying the draft's resource
 * limits and duplicate-key rejection. Throws HTMLTrustError with codes
 * jcs-invalid-json, jcs-duplicate-key, jcs-invalid-surrogate, jcs-number,
 * or resource-limit-exceeded.
 */
export function canonicalizeJCS(text) {
  if (utf8ByteLength(text) > MAX_SOURCE_BYTES) {
    fail('resource-limit-exceeded', 'JSON source exceeds 1 MiB');
  }
  const parser = new Parser(text);
  const root = parser.parseDocument();
  checkStringsForSurrogates(root);
  return serializeValue(root);
}
