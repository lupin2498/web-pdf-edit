// Font metrics needed to position glyphs while interpreting content streams.
import { Font as StdFont, Encodings } from '@cantoo/pdf-lib/standard-fonts';
import { PDFStream, PDFArray, PDFName, PDFDict } from '@cantoo/pdf-lib';
import { N, get, getDict, getArray, getNumber, getName, resolve, numberOf, nameOf, streamContents } from './pdf-objects.js';

const STANDARD_ENCODING = (() => {
  const t = new Array(256).fill('');
  const ascii =
    'space exclam quotedbl numbersign dollar percent ampersand quoteright parenleft parenright asterisk plus comma hyphen period slash ' +
    'zero one two three four five six seven eight nine colon semicolon less equal greater question at ' +
    'A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore quoteleft ' +
    'a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde';
  ascii.split(' ').forEach((n, i) => (t[32 + i] = n));
  const high = {
    161: 'exclamdown', 162: 'cent', 163: 'sterling', 164: 'fraction', 165: 'yen', 166: 'florin', 167: 'section',
    168: 'currency', 169: 'quotesingle', 170: 'quotedblleft', 171: 'guillemotleft', 172: 'guilsinglleft',
    173: 'guilsinglright', 174: 'fi', 175: 'fl', 177: 'endash', 178: 'dagger', 179: 'daggerdbl', 180: 'periodcentered',
    182: 'paragraph', 183: 'bullet', 184: 'quotesinglbase', 185: 'quotedblbase', 186: 'quotedblright',
    187: 'guillemotright', 188: 'ellipsis', 189: 'perthousand', 191: 'questiondown', 193: 'grave', 194: 'acute',
    195: 'circumflex', 196: 'tilde', 197: 'macron', 198: 'breve', 199: 'dotaccent', 200: 'dieresis', 202: 'ring',
    203: 'cedilla', 205: 'hungarumlaut', 206: 'ogonek', 207: 'caron', 208: 'emdash', 225: 'AE', 227: 'ordfeminine',
    232: 'Lslash', 233: 'Oslash', 234: 'OE', 235: 'ordmasculine', 241: 'ae', 245: 'dotlessi', 248: 'lslash',
    249: 'oslash', 250: 'oe', 251: 'germandbls',
  };
  for (const [k, v] of Object.entries(high)) t[+k] = v;
  return t;
})();

function encodingTableFromPdfLib(enc) {
  const t = new Array(256).fill('');
  const mappings = enc.unicodeMappings || {};
  for (const key of Object.keys(mappings)) {
    const [code, name] = mappings[key];
    if (code >= 0 && code < 256 && !t[code]) t[code] = name;
  }
  return t;
}

let WIN_ANSI = null;
let SYMBOL_ENC = null;
let ZAPF_ENC = null;
function winAnsi() {
  if (!WIN_ANSI) WIN_ANSI = encodingTableFromPdfLib(Encodings.WinAnsi);
  return WIN_ANSI;
}

const STD_FONT_ALIASES = {
  arial: 'Helvetica',
  'arial-bold': 'Helvetica-Bold',
  'arial-italic': 'Helvetica-Oblique',
  'arial-bolditalic': 'Helvetica-BoldOblique',
  arialmt: 'Helvetica',
  'arial-boldmt': 'Helvetica-Bold',
  'arial-italicmt': 'Helvetica-Oblique',
  'arial-bolditalicmt': 'Helvetica-BoldOblique',
  helvetica: 'Helvetica',
  'helvetica-bold': 'Helvetica-Bold',
  'helvetica-oblique': 'Helvetica-Oblique',
  'helvetica-boldoblique': 'Helvetica-BoldOblique',
  'helvetica-italic': 'Helvetica-Oblique',
  'helvetica-bolditalic': 'Helvetica-BoldOblique',
  timesnewroman: 'Times-Roman',
  'timesnewroman-bold': 'Times-Bold',
  'timesnewroman-italic': 'Times-Italic',
  'timesnewroman-bolditalic': 'Times-BoldItalic',
  timesnewromanps: 'Times-Roman',
  timesnewromanpsmt: 'Times-Roman',
  'timesnewromanps-boldmt': 'Times-Bold',
  'timesnewromanps-italicmt': 'Times-Italic',
  'timesnewromanps-bolditalicmt': 'Times-BoldItalic',
  'times-roman': 'Times-Roman',
  'times-bold': 'Times-Bold',
  'times-italic': 'Times-Italic',
  'times-bolditalic': 'Times-BoldItalic',
  times: 'Times-Roman',
  courier: 'Courier',
  'courier-bold': 'Courier-Bold',
  'courier-oblique': 'Courier-Oblique',
  'courier-boldoblique': 'Courier-BoldOblique',
  couriernew: 'Courier',
  'couriernew-bold': 'Courier-Bold',
  'couriernew-italic': 'Courier-Oblique',
  'couriernew-bolditalic': 'Courier-BoldOblique',
  couriernewpsmt: 'Courier',
  symbol: 'Symbol',
  symbolmt: 'Symbol',
  zapfdingbats: 'ZapfDingbats',
};

export function stripSubsetPrefix(name) {
  return (name || '').replace(/^[A-Z]{6}\+/, '');
}

function standardFontName(baseFont) {
  const key = stripSubsetPrefix(baseFont).toLowerCase().replace(/,/g, '-').replace(/\s+/g, '');
  return STD_FONT_ALIASES[key];
}

const stdFontCache = new Map();
function loadStdFont(name) {
  if (!stdFontCache.has(name)) {
    try {
      stdFontCache.set(name, StdFont.load(name));
    } catch {
      stdFontCache.set(name, null);
    }
  }
  return stdFontCache.get(name);
}

function builtinEncodingFor(stdName) {
  if (stdName === 'Symbol') {
    if (!SYMBOL_ENC) SYMBOL_ENC = encodingTableFromPdfLib(Encodings.Symbol);
    return SYMBOL_ENC;
  }
  if (stdName === 'ZapfDingbats') {
    if (!ZAPF_ENC) ZAPF_ENC = encodingTableFromPdfLib(Encodings.ZapfDingbats);
    return ZAPF_ENC;
  }
  return STANDARD_ENCODING;
}

function baseEncodingTable(name, stdName) {
  if (name === 'WinAnsiEncoding' || name === 'MacRomanEncoding' || name === 'PDFDocEncoding') return winAnsi();
  if (name === 'StandardEncoding') return STANDARD_ENCODING;
  return stdName ? builtinEncodingFor(stdName) : STANDARD_ENCODING;
}

// --- CMap parsing (embedded CMaps for composite fonts) ----------------------

function hexToInt(hex) {
  return parseInt(hex, 16);
}

function parseEmbeddedCMap(text) {
  const codespaces = [];
  const cidRanges = [];
  const csRe = /begincodespacerange([\s\S]*?)endcodespacerange/g;
  let m;
  while ((m = csRe.exec(text))) {
    const pairRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let p;
    while ((p = pairRe.exec(m[1]))) {
      codespaces.push({ len: p[1].length / 2, low: hexToInt(p[1]), high: hexToInt(p[2]) });
    }
  }
  const rangeRe = /begincidrange([\s\S]*?)endcidrange/g;
  while ((m = rangeRe.exec(text))) {
    const r = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\d+)/g;
    let p;
    while ((p = r.exec(m[1]))) cidRanges.push([hexToInt(p[1]), hexToInt(p[2]), parseInt(p[3], 10)]);
  }
  const charRe = /begincidchar([\s\S]*?)endcidchar/g;
  while ((m = charRe.exec(text))) {
    const r = /<([0-9a-fA-F]+)>\s*(\d+)/g;
    let p;
    while ((p = r.exec(m[1]))) {
      const c = hexToInt(p[1]);
      cidRanges.push([c, c, parseInt(p[2], 10)]);
    }
  }
  const wmode = /\/WMode\s+1/.test(text) ? 1 : 0;
  return { codespaces, cidRanges, wmode };
}

function bytesToLatin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

// --- Font flags ---------------------------------------------------------------

const FLAG_FIXED_PITCH = 1;
const FLAG_SERIF = 2;
const FLAG_ITALIC = 64;
const FLAG_FORCE_BOLD = 1 << 18;

export function classifyFontName(name) {
  const n = stripSubsetPrefix(name || '');
  const lower = n.toLowerCase();
  const bold = /bold|black|heavy|semibold|demibold|demi\b|extrabold|ultrabold|-bd\b|_bd\b|-w[6-9]\b|^cmbx/.test(lower);
  const italic =
    /italic|oblique|slanted|kursiv|[-,_](bold|semibold|light|medium|black|heavy|regular|book|demi)?it\b|[-,_]bi\b|^cmti|^cmmi|^cmsl/.test(
      lower,
    );
  const mono = /mono|courier|consolas|code|typewriter|fixed|menlo|inconsolata|cmtt|lucidaconsole/.test(lower);
  const serif =
    !mono &&
    /times|serif|roman|georgia|garamond|cambria|book|minion|palatino|caladea|baskerville|bodoni|century|cmr|cmbx|cmti|nimbusrom|libertine|didot|constantia|merriweather|tinos|batang|mincho|song|ming/.test(
      lower,
    ) &&
    !/sans/.test(lower);
  return { bold, italic, mono, serif };
}

/**
 * Builds a FontInfo object for a font dictionary.
 * FontInfo:
 *   type, baseFont, composite, vertical,
 *   readCode(bytes, pos) -> [code, length]
 *   width(code) -> advance in text space units (already divided by 1000 / scaled by FontMatrix)
 *   ascent, descent (text space units, relative to font size 1)
 *   bold, italic, serif, mono
 */
export function buildFontInfo(context, fontDict) {
  if (!(fontDict instanceof PDFDict)) return defaultFontInfo();
  const subtype = getName(context, fontDict, 'Subtype') || 'Type1';
  const baseFont = getName(context, fontDict, 'BaseFont') || '';
  const info = {
    type: subtype,
    baseFont,
    name: stripSubsetPrefix(baseFont),
    composite: subtype === 'Type0',
    vertical: false,
    ascent: 0.8,
    descent: -0.2,
    bold: false,
    italic: false,
    serif: false,
    mono: false,
    readCode: null,
    width: null,
  };

  let descriptor;
  if (info.composite) {
    const descendants = getArray(context, fontDict, 'DescendantFonts');
    const cidFont = descendants ? resolve(context, descendants.get(0)) : undefined;
    const cidDict = cidFont instanceof PDFDict ? cidFont : undefined;
    descriptor = cidDict ? getDict(context, cidDict, 'FontDescriptor') : undefined;
    if (!info.name && cidDict) info.name = stripSubsetPrefix(getName(context, cidDict, 'BaseFont') || '');

    // Code length and CID mapping.
    const encoding = get(context, fontDict, 'Encoding');
    let codespaces = null;
    let cidRanges = null;
    let identity = false;
    let mixed = false;
    if (encoding instanceof PDFName) {
      const encName = nameOf(encoding);
      if (encName === 'Identity-H' || encName === 'Identity-V') identity = true;
      else if (/UCS2|UTF16/.test(encName)) identity = true;
      else mixed = true;
      if (/-V$/.test(encName)) info.vertical = true;
    } else if (encoding instanceof PDFStream) {
      try {
        const parsed = parseEmbeddedCMap(bytesToLatin1(streamContents(encoding)));
        codespaces = parsed.codespaces.length ? parsed.codespaces : null;
        cidRanges = parsed.cidRanges.length ? parsed.cidRanges : null;
        if (parsed.wmode === 1 || getNumber(context, encoding.dict, 'WMode', 0) === 1) info.vertical = true;
      } catch {
        identity = true;
      }
      if (!codespaces) identity = true;
    } else {
      identity = true;
    }

    if (codespaces) {
      const byLen = [...codespaces].sort((a, b) => a.len - b.len);
      info.readCode = (bytes, pos) => {
        let code = 0;
        for (let len = 1; len <= 4 && pos + len - 1 < bytes.length; len++) {
          code = (code << 8) | bytes[pos + len - 1];
          for (const cs of byLen) {
            if (cs.len === len && code >= cs.low && code <= cs.high) return [code, len];
          }
        }
        // Not in any codespace: consume the shortest defined length.
        const len = Math.min(byLen[0].len, bytes.length - pos);
        let c = 0;
        for (let i = 0; i < len; i++) c = (c << 8) | bytes[pos + i];
        return [c, Math.max(1, len)];
      };
    } else if (mixed) {
      info.readCode = (bytes, pos) => {
        const b = bytes[pos];
        if (b < 0x80 || pos + 1 >= bytes.length) return [b, 1];
        return [(b << 8) | bytes[pos + 1], 2];
      };
    } else {
      info.readCode = (bytes, pos) => {
        if (pos + 1 >= bytes.length) return [bytes[pos], 1];
        return [(bytes[pos] << 8) | bytes[pos + 1], 2];
      };
    }
    const toCid = (code) => {
      if (identity || !cidRanges) return code;
      for (const [lo, hi, start] of cidRanges) if (code >= lo && code <= hi) return start + (code - lo);
      return 0;
    };

    // Widths from /W and /DW.
    const dw = cidDict ? getNumber(context, cidDict, 'DW', 1000) : 1000;
    const widthMap = new Map();
    const W = cidDict ? getArray(context, cidDict, 'W') : undefined;
    const ranges = [];
    if (W) {
      let i = 0;
      const n = W.size();
      while (i < n) {
        const first = numberOf(context, W.get(i), 0);
        const second = resolve(context, W.get(i + 1));
        if (second instanceof PDFArray) {
          for (let k = 0; k < second.size(); k++) widthMap.set(first + k, numberOf(context, second.get(k), dw));
          i += 2;
        } else {
          const last = numberOf(context, second, first);
          const w = numberOf(context, W.get(i + 2), dw);
          if (last - first < 5000) {
            for (let c = first; c <= last; c++) widthMap.set(c, w);
          } else {
            ranges.push([first, last, w]);
          }
          i += 3;
        }
      }
    }
    info.width = (code) => {
      const cid = toCid(code);
      let w = widthMap.get(cid);
      if (w === undefined) {
        w = dw;
        for (const [lo, hi, rw] of ranges) if (cid >= lo && cid <= hi) w = rw;
      }
      return w / 1000;
    };
    info.isSpace = (code, len) => len === 1 && code === 32;
  } else {
    descriptor = getDict(context, fontDict, 'FontDescriptor');
    info.readCode = (bytes, pos) => [bytes[pos], 1];
    info.isSpace = (code) => code === 32;
    const firstChar = getNumber(context, fontDict, 'FirstChar', 0);
    const widthsArr = getArray(context, fontDict, 'Widths');
    const missing = descriptor ? getNumber(context, descriptor, 'MissingWidth', 0) : 0;
    let scaleFactor = 1 / 1000;
    if (subtype === 'Type3') {
      const fm = getArray(context, fontDict, 'FontMatrix');
      scaleFactor = fm ? numberOf(context, fm.get(0), 0.001) : 0.001;
    }
    if (widthsArr) {
      const widths = [];
      for (let i = 0; i < widthsArr.size(); i++) widths.push(numberOf(context, widthsArr.get(i), missing));
      info.width = (code) => {
        const idx = code - firstChar;
        const w = idx >= 0 && idx < widths.length ? widths[idx] : missing;
        return w * scaleFactor;
      };
    } else {
      // Standard 14 font (or alias) without widths: use AFM metrics.
      const stdName = standardFontName(baseFont) || 'Helvetica';
      const afm = loadStdFont(stdName);
      const encObj = get(context, fontDict, 'Encoding');
      let table;
      if (encObj instanceof PDFName) {
        table = baseEncodingTable(nameOf(encObj), stdName).slice();
      } else if (encObj instanceof PDFDict) {
        const baseName = getName(context, encObj, 'BaseEncoding');
        table = baseEncodingTable(baseName, stdName).slice();
        const diffs = getArray(context, encObj, 'Differences');
        if (diffs) {
          let code = 0;
          for (let i = 0; i < diffs.size(); i++) {
            const item = resolve(context, diffs.get(i));
            if (item instanceof PDFName) {
              if (code >= 0 && code < 256) table[code] = nameOf(item);
              code++;
            } else {
              code = numberOf(context, item, code);
            }
          }
        }
      } else {
        table = builtinEncodingFor(stdName).slice();
      }
      const fallback = stdName.startsWith('Courier') ? 600 : 500;
      info.width = (code) => {
        const glyph = table[code];
        let w;
        if (glyph && afm) {
          try {
            w = afm.getWidthOfGlyph(glyph);
          } catch {
            w = undefined;
          }
        }
        if (w === undefined || w === null || Number.isNaN(w)) w = code === 32 ? 250 : fallback;
        return w / 1000;
      };
      if (afm) {
        info.ascent = (afm.Ascender || 750) / 1000;
        info.descent = (afm.Descender || -250) / 1000;
      }
      info.stdName = stdName;
    }
  }

  // Style information.
  const byName = classifyFontName(info.name || baseFont);
  let flags = 0;
  if (descriptor) {
    flags = getNumber(context, descriptor, 'Flags', 0);
    const ascent = getNumber(context, descriptor, 'Ascent', undefined);
    const descent = getNumber(context, descriptor, 'Descent', undefined);
    if (ascent !== undefined && ascent > 0) info.ascent = ascent / 1000;
    if (descent !== undefined && descent < 0) info.descent = descent / 1000;
    const weight = getNumber(context, descriptor, 'FontWeight', 0);
    const italicAngle = getNumber(context, descriptor, 'ItalicAngle', 0);
    info.bold = byName.bold || weight >= 600 || !!(flags & FLAG_FORCE_BOLD);
    info.italic = byName.italic || italicAngle !== 0 || !!(flags & FLAG_ITALIC);
    info.mono = byName.mono || !!(flags & FLAG_FIXED_PITCH);
    info.serif = !info.mono && (byName.serif || (!!(flags & FLAG_SERIF) && !/sans/i.test(info.name)));
    const family = descriptor.get(N('FontFamily'));
    if (family && typeof family.decodeText === 'function') {
      try {
        info.family = family.decodeText();
      } catch {
        /* ignore */
      }
    }
  } else {
    info.bold = byName.bold;
    info.italic = byName.italic;
    info.mono = byName.mono;
    info.serif = byName.serif;
  }
  if (subtype === 'Type3') {
    info.ascent = 0.8;
    info.descent = -0.2;
  }
  if (info.ascent > 1.5) info.ascent = 0.9;
  if (info.descent < -1) info.descent = -0.25;
  return info;
}

export function defaultFontInfo() {
  return {
    type: 'Type1',
    baseFont: '',
    name: '',
    composite: false,
    vertical: false,
    ascent: 0.75,
    descent: -0.25,
    bold: false,
    italic: false,
    serif: false,
    mono: false,
    readCode: (bytes, pos) => [bytes[pos], 1],
    width: () => 0.5,
    isSpace: (code) => code === 32,
  };
}

export class FontInfoCache {
  constructor(context) {
    this.context = context;
    this.cache = new Map();
  }
  get(fontRefOrDict) {
    const key = fontRefOrDict;
    if (this.cache.has(key)) return this.cache.get(key);
    let info;
    try {
      info = buildFontInfo(this.context, resolve(this.context, fontRefOrDict));
    } catch {
      info = defaultFontInfo();
    }
    this.cache.set(key, info);
    return info;
  }
}
