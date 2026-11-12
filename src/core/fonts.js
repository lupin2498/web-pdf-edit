// Font registry: bundled fonts plus (on Windows) installed system fonts.
// Provides metrics for layout and embeds faces into pdf-lib documents.
import fontkit from '@cantoo/fontkit';
import { classifyFontName, stripSubsetPrefix } from './font-info.js';

export const BUNDLED_FAMILIES = [
  {
    family: 'Liberation Sans',
    category: 'sans',
    faces: {
      regular: 'LiberationSans-Regular.ttf',
      bold: 'LiberationSans-Bold.ttf',
      italic: 'LiberationSans-Italic.ttf',
      bolditalic: 'LiberationSans-BoldItalic.ttf',
    },
  },
  {
    family: 'Liberation Serif',
    category: 'serif',
    faces: {
      regular: 'LiberationSerif-Regular.ttf',
      bold: 'LiberationSerif-Bold.ttf',
      italic: 'LiberationSerif-Italic.ttf',
      bolditalic: 'LiberationSerif-BoldItalic.ttf',
    },
  },
  {
    family: 'Liberation Mono',
    category: 'mono',
    faces: {
      regular: 'LiberationMono-Regular.ttf',
      bold: 'LiberationMono-Bold.ttf',
      italic: 'LiberationMono-Italic.ttf',
      bolditalic: 'LiberationMono-BoldItalic.ttf',
    },
  },
];

export const DEFAULT_FAMILY = 'Liberation Sans';

const CATEGORY_DEFAULTS = {
  sans: ['Arial', 'Liberation Sans'],
  serif: ['Times New Roman', 'Liberation Serif'],
  mono: ['Courier New', 'Liberation Mono'],
};

const FAMILY_ALIASES = {
  helvetica: 'Arial',
  helveticaneue: 'Arial',
  arialmt: 'Arial',
  times: 'Times New Roman',
  timesroman: 'Times New Roman',
  timesnewromanps: 'Times New Roman',
  timesnewromanpsmt: 'Times New Roman',
  courier: 'Courier New',
  couriernewps: 'Courier New',
  couriernewpsmt: 'Courier New',
  arimo: 'Liberation Sans',
  tinos: 'Liberation Serif',
  cousine: 'Liberation Mono',
};

// Fallback families searched (in order) for characters missing from a face.
export const FALLBACK_FAMILIES = [
  'Liberation Sans',
  'Segoe UI',
  'Arial',
  'Segoe UI Symbol',
  'Microsoft YaHei',
  'SimSun',
  'Yu Gothic',
  'MS Gothic',
  'Malgun Gothic',
  'Nirmala UI',
  'Leelawadee UI',
  'Ebrima',
  'Segoe UI Historic',
  'Arial Unicode MS',
];

export function normalizeFamilyKey(name) {
  return (name || '').toLowerCase().replace(/[\s_-]+/g, '');
}

export function styleKey(bold, italic) {
  return bold && italic ? 'bolditalic' : bold ? 'bold' : italic ? 'italic' : 'regular';
}

// Extracts one font from a TrueType collection (.ttc) into a standalone sfnt.
export function extractFromCollection(bytes, index = 0) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (tag !== 'ttcf') return bytes;
  const numFonts = dv.getUint32(8);
  if (index >= numFonts) index = 0;
  const offset = dv.getUint32(12 + index * 4);
  const numTables = dv.getUint16(offset + 4);
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const rec = offset + 12 + i * 16;
    tables.push({
      tag: dv.getUint32(rec),
      checksum: dv.getUint32(rec + 4),
      offset: dv.getUint32(rec + 8),
      length: dv.getUint32(rec + 12),
    });
  }
  const headerSize = 12 + numTables * 16;
  let total = headerSize;
  for (const t of tables) total += (t.length + 3) & ~3;
  const out = new Uint8Array(total);
  const odv = new DataView(out.buffer);
  out.set(bytes.subarray(offset, offset + 12), 0);
  let pos = headerSize;
  tables.forEach((t, i) => {
    const rec = 12 + i * 16;
    odv.setUint32(rec, t.tag);
    odv.setUint32(rec + 4, t.checksum);
    odv.setUint32(rec + 8, pos);
    odv.setUint32(rec + 12, t.length);
    out.set(bytes.subarray(t.offset, t.offset + t.length), pos);
    pos += (t.length + 3) & ~3;
  });
  return out;
}

/**
 * Face descriptor: { id, family, style, source: 'bundled'|'system', file, index }
 * loader(descriptor) -> Promise<Uint8Array>
 */
export class FontRegistry {
  constructor(loader) {
    this.loader = loader;
    this.families = new Map(); // key -> {family, category, faces: {style: descriptor}}
    this.bytesCache = new Map();
    this.fontkitCache = new Map();
    this.pending = new Map();
    for (const f of BUNDLED_FAMILIES) {
      const faces = {};
      for (const [style, file] of Object.entries(f.faces)) {
        faces[style] = { id: `bundled:${file}`, family: f.family, style, source: 'bundled', file, index: 0 };
      }
      this.families.set(normalizeFamilyKey(f.family), { family: f.family, category: f.category, faces, bundled: true });
    }
  }

  addSystemFonts(list) {
    // list: [{family, style, file, index}]
    for (const item of list || []) {
      if (!item || !item.family || !item.file) continue;
      const key = normalizeFamilyKey(item.family);
      let fam = this.families.get(key);
      if (!fam) {
        const cls = classifyFontName(item.family);
        fam = { family: item.family, category: cls.mono ? 'mono' : cls.serif ? 'serif' : 'sans', faces: {}, bundled: false };
        this.families.set(key, fam);
      }
      if (fam.bundled) continue;
      const style = item.style || 'regular';
      if (!fam.faces[style]) {
        fam.faces[style] = {
          id: `system:${item.file}#${item.index || 0}`,
          family: fam.family,
          style,
          source: 'system',
          file: item.file,
          index: item.index || 0,
        };
      }
    }
  }

  listFamilies() {
    return [...this.families.values()]
      .filter((f) => f.faces.regular || Object.keys(f.faces).length)
      .map((f) => ({ family: f.family, category: f.category, bundled: !!f.bundled, styles: Object.keys(f.faces) }))
      .sort((a, b) => a.family.localeCompare(b.family));
  }

  hasFamily(family) {
    return this.families.has(normalizeFamilyKey(family));
  }

  getFamily(family) {
    return this.families.get(normalizeFamilyKey(family)) || null;
  }

  // Returns {descriptor, synthBold, synthItalic}
  resolveFace(family, bold = false, italic = false) {
    let fam = this.getFamily(family) || this.getFamily(DEFAULT_FAMILY);
    if (!fam || !Object.keys(fam.faces).length) fam = this.getFamily(DEFAULT_FAMILY);
    const want = styleKey(bold, italic);
    if (fam.faces[want]) return { descriptor: fam.faces[want], synthBold: false, synthItalic: false };
    if (bold && italic && fam.faces.bold) return { descriptor: fam.faces.bold, synthBold: false, synthItalic: true };
    if (bold && italic && fam.faces.italic) return { descriptor: fam.faces.italic, synthBold: true, synthItalic: false };
    const base = fam.faces.regular || Object.values(fam.faces)[0];
    return { descriptor: base, synthBold: bold && base.style !== 'bold', synthItalic: italic && base.style !== 'italic' };
  }

  async getBytes(descriptor) {
    if (this.bytesCache.has(descriptor.id)) return this.bytesCache.get(descriptor.id);
    if (this.pending.has(descriptor.id)) return this.pending.get(descriptor.id);
    const p = (async () => {
      let bytes = await this.loader(descriptor);
      if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
      if (bytes[0] === 0x74 && bytes[1] === 0x74 && bytes[2] === 0x63 && bytes[3] === 0x66) {
        bytes = extractFromCollection(bytes, descriptor.index || 0);
      }
      this.bytesCache.set(descriptor.id, bytes);
      this.pending.delete(descriptor.id);
      return bytes;
    })();
    this.pending.set(descriptor.id, p);
    return p;
  }

  async getFontkit(descriptor) {
    if (this.fontkitCache.has(descriptor.id)) return this.fontkitCache.get(descriptor.id);
    const bytes = await this.getBytes(descriptor);
    const font = fontkit.create(bytes);
    const metrics = makeMetrics(font);
    this.fontkitCache.set(descriptor.id, metrics);
    return metrics;
  }

  getLoadedMetrics(descriptor) {
    return this.fontkitCache.get(descriptor.id) || null;
  }

  // Picks the best family for text originally set in a PDF font.
  matchFamily(fontName, info = {}) {
    const name = stripSubsetPrefix(fontName || '');
    const familyPart = name.split(/[,-]/)[0].replace(/(PSMT|PS|MT)$/i, '');
    const candidates = [familyPart, name.replace(/[,-].*$/, ''), info.family || ''];
    for (const c of candidates) {
      if (!c) continue;
      const key = normalizeFamilyKey(c);
      const alias = FAMILY_ALIASES[key];
      if (alias && this.hasFamily(alias)) return this.getFamily(alias).family;
      if (this.hasFamily(c)) return this.getFamily(c).family;
      // Also try splitting CamelCase: "TimesNewRoman" -> "Times New Roman"
      const spaced = c.replace(/([a-z])([A-Z])/g, '$1 $2');
      if (this.hasFamily(spaced)) return this.getFamily(spaced).family;
    }
    const category = info.mono ? 'mono' : info.serif ? 'serif' : 'sans';
    for (const fam of CATEGORY_DEFAULTS[category]) if (this.hasFamily(fam)) return this.getFamily(fam).family;
    return DEFAULT_FAMILY;
  }

  /**
   * Prepares a shaper for `text` in the given face: loads fallback fonts for
   * characters the face cannot render. Returns {
   *   runs(str) -> [{text, metrics, descriptor}], measure(str) -> width at size 1,
   *   metrics (primary)
   * }
   */
  async getShaper(family, bold, italic, text = '') {
    const resolved = this.resolveFace(family, bold, italic);
    const primary = await this.getFontkit(resolved.descriptor);
    const fallbacks = [];
    const chars = new Set(Array.from((text || '').normalize('NFC')));
    const missing = [...chars].filter((ch) => ch.trim() && !primary.hasChar(ch));
    if (missing.length) {
      let remaining = missing;
      for (const famName of FALLBACK_FAMILIES) {
        if (!remaining.length) break;
        const fam = this.getFamily(famName);
        if (!fam) continue;
        const r = this.resolveFace(fam.family, bold, italic);
        let m;
        try {
          m = await this.getFontkit(r.descriptor);
        } catch {
          continue;
        }
        const covered = remaining.filter((ch) => m.hasChar(ch));
        if (covered.length) {
          fallbacks.push({ metrics: m, descriptor: r.descriptor, synthBold: r.synthBold, synthItalic: r.synthItalic });
          remaining = remaining.filter((ch) => !m.hasChar(ch));
        }
      }
    }
    const faces = [{ metrics: primary, descriptor: resolved.descriptor, synthBold: resolved.synthBold, synthItalic: resolved.synthItalic }, ...fallbacks];
    const pick = (ch) => {
      if (!ch.trim()) return faces[0];
      for (const f of faces) if (f.metrics.hasChar(ch)) return f;
      return faces[0];
    };
    const runs = (str) => {
      const out = [];
      for (const ch of Array.from(str)) {
        const f = pick(ch);
        const last = out[out.length - 1];
        if (last && last.face === f) last.text += ch;
        else out.push({ text: ch, face: f });
      }
      return out;
    };
    const measure = (str) => {
      if (faces.length === 1) return primary.measure(str);
      let w = 0;
      for (const r of runs(str)) w += r.face.metrics.measure(r.text);
      return w;
    };
    return { runs, measure, metrics: primary, faces, synthBold: resolved.synthBold, synthItalic: resolved.synthItalic, descriptor: resolved.descriptor };
  }
}

function makeMetrics(font) {
  const upm = font.unitsPerEm || 1000;
  const cache = new Map();
  const hasCache = new Map();
  return {
    font,
    upm,
    ascent: font.ascent / upm,
    descent: font.descent / upm,
    lineGap: (font.lineGap || 0) / upm,
    postscriptName: font.postscriptName,
    measure(str) {
      if (!str) return 0;
      let w = cache.get(str);
      if (w !== undefined) return w;
      const run = font.layout(str);
      w = 0;
      for (const g of run.glyphs) w += g.advanceWidth;
      w /= upm;
      if (cache.size > 5000) cache.clear();
      cache.set(str, w);
      return w;
    },
    hasChar(ch) {
      let v = hasCache.get(ch);
      if (v === undefined) {
        const cp = ch.codePointAt(0);
        try {
          v = font.hasGlyphForCodePoint(cp);
        } catch {
          v = false;
        }
        hasCache.set(ch, v);
      }
      return v;
    },
  };
}

// Embeds faces into a pdf-lib document, once per face.
export class DocFontEmbedder {
  constructor(doc, registry) {
    this.doc = doc;
    this.registry = registry;
    this.embedded = new Map();
    doc.registerFontkit(fontkit);
  }
  async embed(descriptor) {
    if (this.embedded.has(descriptor.id)) return this.embedded.get(descriptor.id);
    const p = (async () => {
      const bytes = await this.registry.getBytes(descriptor);
      return this.doc.embedFont(bytes, { subset: true });
    })();
    this.embedded.set(descriptor.id, p);
    return p;
  }
}
