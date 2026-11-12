// Lexer, parser and serializer for PDF content streams.
//
// Parsed operations keep the byte range they came from so that untouched
// operations can be copied verbatim when a stream is rewritten.

const WHITESPACE = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WHITESPACE[c] = 1;
const DELIMITER = new Uint8Array(256);
for (const ch of '()<>[]{}/%') DELIMITER[ch.charCodeAt(0)] = 1;

export class PdfName {
  constructor(name) {
    this.name = name;
  }
  toString() {
    return '/' + this.name;
  }
}

export class PdfString {
  constructor(bytes, hex = false) {
    this.bytes = bytes;
    this.hex = hex;
  }
}

export class PdfDictValue {
  constructor(map = new Map()) {
    this.map = map;
  }
  get(key) {
    return this.map.get(key);
  }
}

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;

export function isName(v, name) {
  return v instanceof PdfName && (name === undefined || v.name === name);
}

class Lexer {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
    this.len = bytes.length;
  }

  skipWhitespaceAndComments() {
    const b = this.bytes;
    while (this.pos < this.len) {
      const c = b[this.pos];
      if (WHITESPACE[c]) {
        this.pos++;
      } else if (c === 0x25 /* % */) {
        while (this.pos < this.len && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
      } else {
        break;
      }
    }
  }

  // Returns {type, value, start, end} or null at EOF.
  next() {
    this.skipWhitespaceAndComments();
    if (this.pos >= this.len) return null;
    const b = this.bytes;
    const start = this.pos;
    const c = b[this.pos];
    switch (c) {
      case 0x28: // (
        return { type: 'value', value: this.readLiteralString(), start, end: this.pos };
      case 0x3c: // <
        if (b[this.pos + 1] === 0x3c) {
          this.pos += 2;
          return { type: 'dictStart', start, end: this.pos };
        }
        return { type: 'value', value: this.readHexString(), start, end: this.pos };
      case 0x3e: // >
        if (b[this.pos + 1] === 0x3e) {
          this.pos += 2;
          return { type: 'dictEnd', start, end: this.pos };
        }
        this.pos++;
        return { type: 'junk', start, end: this.pos };
      case 0x5b: // [
        this.pos++;
        return { type: 'arrayStart', start, end: this.pos };
      case 0x5d: // ]
        this.pos++;
        return { type: 'arrayEnd', start, end: this.pos };
      case 0x7b: // {
      case 0x7d: // }
      case 0x29: // )
        this.pos++;
        return { type: 'junk', start, end: this.pos };
      case 0x2f: // /
        return { type: 'value', value: this.readName(), start, end: this.pos };
      default: {
        let p = this.pos;
        while (p < this.len && !WHITESPACE[b[p]] && !DELIMITER[b[p]]) p++;
        let word = '';
        for (let i = this.pos; i < p; i++) word += String.fromCharCode(b[i]);
        this.pos = p;
        if (NUMBER_RE.test(word)) return { type: 'value', value: parseFloat(word), start, end: p };
        if (word === 'true') return { type: 'value', value: true, start, end: p };
        if (word === 'false') return { type: 'value', value: false, start, end: p };
        if (word === 'null') return { type: 'value', value: null, start, end: p };
        // Lenient number parsing for malformed values such as "--5" or "1.2.3".
        if (/^[+-]*[\d.]+$/.test(word)) {
          const n = parseFloat(word.replace(/^[+-]*(?=[+-])/, ''));
          if (!Number.isNaN(n)) return { type: 'value', value: n, start, end: p };
        }
        return { type: 'keyword', value: word, start, end: p };
      }
    }
  }

  readName() {
    const b = this.bytes;
    this.pos++; // skip '/'
    let name = '';
    while (this.pos < this.len && !WHITESPACE[b[this.pos]] && !DELIMITER[b[this.pos]]) {
      const c = b[this.pos];
      if (c === 0x23 /* # */ && this.pos + 2 < this.len) {
        const hex = String.fromCharCode(b[this.pos + 1], b[this.pos + 2]);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          name += String.fromCharCode(parseInt(hex, 16));
          this.pos += 3;
          continue;
        }
      }
      name += String.fromCharCode(c);
      this.pos++;
    }
    return new PdfName(name);
  }

  readLiteralString() {
    const b = this.bytes;
    this.pos++; // skip '('
    const out = [];
    let depth = 1;
    while (this.pos < this.len) {
      let c = b[this.pos++];
      if (c === 0x5c /* \ */) {
        if (this.pos >= this.len) break;
        c = b[this.pos++];
        switch (c) {
          case 0x6e: out.push(10); break; // n
          case 0x72: out.push(13); break; // r
          case 0x74: out.push(9); break; // t
          case 0x62: out.push(8); break; // b
          case 0x66: out.push(12); break; // f
          case 0x28: out.push(0x28); break;
          case 0x29: out.push(0x29); break;
          case 0x5c: out.push(0x5c); break;
          case 13: // line continuation
            if (b[this.pos] === 10) this.pos++;
            break;
          case 10:
            break;
          default:
            if (c >= 0x30 && c <= 0x37) {
              let v = c - 0x30;
              for (let k = 0; k < 2 && this.pos < this.len; k++) {
                const d = b[this.pos];
                if (d >= 0x30 && d <= 0x37) {
                  v = v * 8 + (d - 0x30);
                  this.pos++;
                } else break;
              }
              out.push(v & 0xff);
            } else {
              out.push(c);
            }
        }
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        depth--;
        if (depth === 0) break;
        out.push(c);
      } else if (c === 13) {
        // Unescaped end-of-line markers are read as a single LF.
        if (b[this.pos] === 10) this.pos++;
        out.push(10);
      } else {
        out.push(c);
      }
    }
    return new PdfString(Uint8Array.from(out), false);
  }

  readHexString() {
    const b = this.bytes;
    this.pos++; // skip '<'
    const out = [];
    let hi = -1;
    while (this.pos < this.len) {
      const c = b[this.pos++];
      if (c === 0x3e) break;
      let v;
      if (c >= 0x30 && c <= 0x39) v = c - 0x30;
      else if (c >= 0x41 && c <= 0x46) v = c - 0x37;
      else if (c >= 0x61 && c <= 0x66) v = c - 0x57;
      else continue;
      if (hi < 0) hi = v;
      else {
        out.push((hi << 4) | v);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi << 4);
    return new PdfString(Uint8Array.from(out), true);
  }
}

function parseObject(lexer, tok) {
  if (tok.type === 'value') return tok.value;
  if (tok.type === 'arrayStart') {
    const arr = [];
    for (;;) {
      const t = lexer.next();
      if (!t || t.type === 'arrayEnd') break;
      if (t.type === 'keyword' || t.type === 'junk' || t.type === 'dictEnd') continue;
      arr.push(parseObject(lexer, t));
    }
    return arr;
  }
  if (tok.type === 'dictStart') {
    const map = new Map();
    for (;;) {
      const t = lexer.next();
      if (!t || t.type === 'dictEnd') break;
      if (t.type === 'value' && t.value instanceof PdfName) {
        const vt = lexer.next();
        if (!vt || vt.type === 'dictEnd') break;
        map.set(t.value.name, parseObject(lexer, vt));
      }
    }
    return new PdfDictValue(map);
  }
  return null;
}

const INLINE_IMAGE_ABBREVIATIONS = {
  BPC: 'BitsPerComponent',
  CS: 'ColorSpace',
  D: 'Decode',
  DP: 'DecodeParms',
  F: 'Filter',
  H: 'Height',
  IM: 'ImageMask',
  I: 'Interpolate',
  W: 'Width',
  L: 'Length',
};

function inlineImageExpectedLength(dict) {
  const get = (k) => {
    if (dict.has(k)) return dict.get(k);
    for (const [abbr, full] of Object.entries(INLINE_IMAGE_ABBREVIATIONS)) {
      if (full === k && dict.has(abbr)) return dict.get(abbr);
    }
    return undefined;
  };
  const length = get('Length');
  if (typeof length === 'number' && length > 0) return length;
  if (get('Filter') !== undefined) return -1;
  const w = get('Width');
  const h = get('Height');
  if (typeof w !== 'number' || typeof h !== 'number') return -1;
  const mask = get('ImageMask') === true;
  let bpc = mask ? 1 : get('BitsPerComponent');
  if (typeof bpc !== 'number') bpc = 8;
  let ncomp = 1;
  if (!mask) {
    const cs = get('ColorSpace');
    const csName = cs instanceof PdfName ? cs.name : Array.isArray(cs) && cs[0] instanceof PdfName ? cs[0].name : null;
    if (csName === 'G' || csName === 'DeviceGray' || csName === 'I' || csName === 'Indexed') ncomp = 1;
    else if (csName === 'RGB' || csName === 'DeviceRGB') ncomp = 3;
    else if (csName === 'CMYK' || csName === 'DeviceCMYK') ncomp = 4;
    else return -1;
  }
  return h * Math.ceil((w * bpc * ncomp) / 8);
}

function looksLikeOperatorsAfter(bytes, pos) {
  // After "EI" we expect whitespace followed by printable operators/operands.
  const end = Math.min(bytes.length, pos + 48);
  for (let i = pos; i < end; i++) {
    const c = bytes[i];
    if (c === 9 || c === 10 || c === 13 || c === 32) continue;
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

function findInlineImageEnd(bytes, dataStart, expectedLength) {
  const n = bytes.length;
  if (expectedLength >= 0) {
    let p = dataStart + expectedLength;
    // Skip whitespace and locate EI.
    let q = p;
    while (q < n && WHITESPACE[bytes[q]]) q++;
    if (bytes[q] === 0x45 && bytes[q + 1] === 0x49) {
      return { dataEnd: p, eiEnd: q + 2 };
    }
  }
  for (let i = dataStart; i < n - 1; i++) {
    if (
      bytes[i] === 0x45 &&
      bytes[i + 1] === 0x49 &&
      (i === dataStart || WHITESPACE[bytes[i - 1]]) &&
      (i + 2 >= n || WHITESPACE[bytes[i + 2]] || DELIMITER[bytes[i + 2]])
    ) {
      if (i + 2 >= n || looksLikeOperatorsAfter(bytes, i + 2)) {
        let dataEnd = i;
        if (dataEnd > dataStart && WHITESPACE[bytes[dataEnd - 1]]) dataEnd--;
        return { dataEnd, eiEnd: i + 2 };
      }
    }
  }
  return { dataEnd: n, eiEnd: n };
}

/**
 * Parses a content stream into an array of operations:
 *   { op: string, args: any[], start: number, end: number }
 * Inline images are returned as a single op 'BI' with args [dictMap, dataBytes].
 */
export function parseContentStream(bytes) {
  const lexer = new Lexer(bytes);
  const ops = [];
  let args = [];
  let argsStart = -1;
  for (;;) {
    const tok = lexer.next();
    if (!tok) break;
    if (tok.type === 'keyword') {
      const start = argsStart >= 0 ? argsStart : tok.start;
      if (tok.value === 'BI') {
        // Inline image: key/value pairs until ID.
        const dict = new Map();
        for (;;) {
          const t = lexer.next();
          if (!t) break;
          if (t.type === 'keyword' && t.value === 'ID') break;
          if (t.type === 'value' && t.value instanceof PdfName) {
            const vt = lexer.next();
            if (!vt) break;
            if (vt.type === 'keyword' && vt.value === 'ID') break;
            dict.set(t.value.name, parseObject(lexer, vt));
          }
        }
        let dataStart = lexer.pos;
        if (WHITESPACE[bytes[dataStart]]) {
          if (bytes[dataStart] === 13 && bytes[dataStart + 1] === 10) dataStart += 2;
          else dataStart += 1;
        }
        const expected = inlineImageExpectedLength(dict);
        const { dataEnd, eiEnd } = findInlineImageEnd(bytes, dataStart, expected);
        lexer.pos = eiEnd;
        ops.push({ op: 'BI', args: [dict, bytes.subarray(dataStart, dataEnd)], start, end: eiEnd });
      } else {
        ops.push({ op: tok.value, args, start, end: tok.end });
      }
      args = [];
      argsStart = -1;
    } else if (tok.type === 'junk' || tok.type === 'arrayEnd' || tok.type === 'dictEnd') {
      // Ignore stray delimiters.
    } else {
      if (argsStart < 0) argsStart = tok.start;
      args.push(parseObject(lexer, tok));
    }
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Serialization

export function formatNumber(n) {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  let s = n.toFixed(5);
  s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s;
}

function escapeName(name) {
  let out = '/';
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x21 || c > 0x7e || DELIMITER[c] || c === 0x23) {
      out += '#' + c.toString(16).padStart(2, '0');
    } else {
      out += name[i];
    }
  }
  return out;
}

function hexOf(bytes) {
  let s = '<';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s + '>';
}

export function serializeValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof PdfName) return escapeName(v.name);
  if (v instanceof PdfString) return hexOf(v.bytes);
  if (Array.isArray(v)) return '[' + v.map(serializeValue).join(' ') + ']';
  if (v instanceof PdfDictValue) {
    let s = '<<';
    for (const [k, val] of v.map) s += escapeName(k) + ' ' + serializeValue(val) + ' ';
    return s + '>>';
  }
  if (typeof v === 'string') return v; // pre-serialized token
  return 'null';
}

export function serializeOp(op) {
  if (op.op === 'BI') {
    throw new Error('Inline images must be copied from source bytes');
  }
  const parts = op.args.map(serializeValue);
  parts.push(op.op);
  return parts.join(' ');
}

const encoder = new TextEncoder();

export function latin1Bytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Assembles a content stream from a list of items. Each item is either
 *  - an op with `start`/`end` (copied verbatim from `source`) unless `dirty`
 *  - an op without byte range (serialized)
 *  - a string or Uint8Array (raw content inserted as-is)
 */
export function buildContentStream(items, source) {
  const chunks = [];
  let total = 0;
  const push = (u8) => {
    chunks.push(u8);
    total += u8.length;
  };
  const NL = encoder.encode('\n');
  for (const item of items) {
    if (item == null) continue;
    if (typeof item === 'string') {
      push(latin1Bytes(item));
    } else if (item instanceof Uint8Array) {
      push(item);
    } else if (!item.dirty && item.start !== undefined && source) {
      push(source.subarray(item.start, item.end));
    } else {
      push(latin1Bytes(serializeOp(item)));
    }
    push(NL);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
