// Maps PDF font names to the font families Word knows, with the vertical
// metrics Word uses to lay out a line of text in that family.
import { stripSubsetPrefix, classifyFontName } from '../font-info.js';

const key = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Normalised PostScript-ish names -> Word family names.
const ALIASES = {
  timesnewroman: 'Times New Roman',
  timesnewromanps: 'Times New Roman',
  timesnewromanpsmt: 'Times New Roman',
  timesnewromanmt: 'Times New Roman',
  times: 'Times New Roman',
  timesroman: 'Times New Roman',
  timesltstd: 'Times New Roman',
  tinos: 'Times New Roman',
  liberationserif: 'Times New Roman',
  nimbusromno9l: 'Times New Roman',
  nimbusroman: 'Times New Roman',
  thorndale: 'Times New Roman',
  arial: 'Arial',
  arialmt: 'Arial',
  helvetica: 'Arial',
  helveticaneue: 'Arial',
  helveticaltstd: 'Arial',
  arimo: 'Arial',
  liberationsans: 'Arial',
  nimbussanl: 'Arial',
  nimbussans: 'Arial',
  albany: 'Arial',
  arialnarrow: 'Arial Narrow',
  liberationsansnarrow: 'Arial Narrow',
  arialblack: 'Arial Black',
  arialunicodems: 'Arial Unicode MS',
  couriernew: 'Courier New',
  couriernewps: 'Courier New',
  couriernewpsmt: 'Courier New',
  courier: 'Courier New',
  cousine: 'Courier New',
  liberationmono: 'Courier New',
  nimbusmonl: 'Courier New',
  nimbusmonops: 'Courier New',
  calibri: 'Calibri',
  carlito: 'Calibri',
  calibrilight: 'Calibri Light',
  cambria: 'Cambria',
  caladea: 'Cambria',
  cambriamath: 'Cambria Math',
  candara: 'Candara',
  consolas: 'Consolas',
  constantia: 'Constantia',
  corbel: 'Corbel',
  tahoma: 'Tahoma',
  verdana: 'Verdana',
  georgia: 'Georgia',
  garamond: 'Garamond',
  bookantiqua: 'Book Antiqua',
  palatino: 'Palatino Linotype',
  palatinolinotype: 'Palatino Linotype',
  bookmanoldstyle: 'Bookman Old Style',
  centuryschoolbook: 'Century Schoolbook',
  centurygothic: 'Century Gothic',
  century: 'Century',
  comicsansms: 'Comic Sans MS',
  trebuchetms: 'Trebuchet MS',
  lucidaconsole: 'Lucida Console',
  lucidasansunicode: 'Lucida Sans Unicode',
  microsoftsansserif: 'Microsoft Sans Serif',
  segoeui: 'Segoe UI',
  segoeuisymbol: 'Segoe UI Symbol',
  impact: 'Impact',
  symbol: 'Symbol',
  symbolmt: 'Symbol',
  // LibreOffice's symbol font mirrors the Symbol encoding.
  opensymbol: 'Symbol',
  starsymbol: 'Symbol',
  dejavusans: 'DejaVu Sans',
  dejavusanscondensed: 'DejaVu Sans Condensed',
  dejavuserif: 'DejaVu Serif',
  dejavusansmono: 'DejaVu Sans Mono',
  jetbrainsmono: 'JetBrains Mono',
  ptsans: 'PT Sans',
  ptserif: 'PT Serif',
  ibmplexsans: 'IBM Plex Sans',
  ibmplexserif: 'IBM Plex Serif',
  ibmplexmono: 'IBM Plex Mono',
  wingdings: 'Wingdings',
  wingdingsregular: 'Wingdings',
  wingdings2: 'Wingdings 2',
  wingdings3: 'Wingdings 3',
  webdings: 'Webdings',
  zapfdingbats: 'Segoe UI Symbol',
  itczapfdingbats: 'Segoe UI Symbol',
  msgothic: 'MS Gothic',
  msmincho: 'MS Mincho',
  mspgothic: 'MS PGothic',
  mspmincho: 'MS PMincho',
  meiryo: 'Meiryo',
  yugothic: 'Yu Gothic',
  yumincho: 'Yu Mincho',
  simsun: 'SimSun',
  nsimsun: 'NSimSun',
  simhei: 'SimHei',
  microsoftyahei: 'Microsoft YaHei',
  kaiti: 'KaiTi',
  fangsong: 'FangSong',
  mingliu: 'MingLiU',
  pmingliu: 'PMingLiU',
  malgungothic: 'Malgun Gothic',
  batang: 'Batang',
  gulim: 'Gulim',
  dotum: 'Dotum',
};

// Style words that do not belong to the family name.
const STYLE_WORDS = /^(regular|roman|normal|book|medium|bold|bd|italic|it|oblique|slanted|bolditalic|boldoblique|bi|boldit|bolditalicmt|boldmt|italicmt|mt|psmt|ps)$/i;
// Weight / width words that are separate families in Word ("Calibri Light").
const FAMILY_WORDS = /^(light|semilight|thin|extralight|ultralight|semibold|demibold|demi|black|heavy|extrabold|ultrabold|narrow|condensed|cond|compressed|extended|display|caption|subhead|text)$/i;

// usWinAscent / usWinDescent of common families (em units).
const METRICS = {
  'Times New Roman': [0.891, 0.216],
  Arial: [0.905, 0.212],
  'Arial Narrow': [0.936, 0.212],
  'Arial Black': [1.1, 0.31],
  'Courier New': [0.833, 0.3],
  Calibri: [0.952, 0.269],
  'Calibri Light': [0.952, 0.269],
  Cambria: [0.95, 0.222],
  'Cambria Math': [0.95, 0.222],
  Candara: [0.952, 0.269],
  Consolas: [0.953, 0.268],
  Constantia: [0.952, 0.269],
  Corbel: [0.952, 0.269],
  Tahoma: [1.0, 0.207],
  Verdana: [1.005, 0.21],
  Georgia: [0.917, 0.219],
  Garamond: [0.862, 0.263],
  'Book Antiqua': [0.923, 0.283],
  'Palatino Linotype': [1.05, 0.283],
  'Century Gothic': [1.006, 0.22],
  'Comic Sans MS': [1.102, 0.292],
  'Trebuchet MS': [0.939, 0.222],
  'Segoe UI': [1.079, 0.251],
  'Segoe UI Symbol': [1.079, 0.251],
  'Microsoft Sans Serif': [0.922, 0.21],
  Symbol: [1.005, 0.22],
  Wingdings: [0.899, 0.211],
};

// Families the alias table names correctly but that Windows does not ship.
const NOT_BUNDLED = /^(DejaVu|JetBrains|PT S|IBM Plex)/;

function deCamel(name) {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/\b(MS|UI|MT|PS)$/g, ' $1')
    .replace(/\s+/g, ' ')
    .trim();
}

function fallbackFamily(cls) {
  return cls.mono ? 'Courier New' : cls.serif ? 'Times New Roman' : 'Arial';
}

/**
 * Returns { family, bold, italic, ascent, descent, known } for a PDF font;
 * `known` tells that the family comes with Windows or Office.
 * `rec` carries the flags found by the page model (bold, italic, serif, mono).
 */
export function mapFont(pdfName, rec = {}) {
  const raw = stripSubsetPrefix(pdfName || '');
  const cls = classifyFontName(raw);
  const flags = { bold: !!(rec.bold || cls.bold), italic: !!(rec.italic || cls.italic), serif: !!(rec.serif || cls.serif), mono: !!(rec.mono || cls.mono) };
  let family = null;
  let known = false;
  const whole = key(raw);
  if (ALIASES[whole]) {
    family = ALIASES[whole];
    known = true;
  }
  if (!family && raw) {
    // "Times New Roman,Bold", "Arial-BoldMT", "Calibri-Light", "OpenSans-SemiboldItalic"
    const parts = raw.split(/[,-]/).map((s) => s.trim()).filter(Boolean);
    let base = parts[0] || '';
    const extra = [];
    for (const p of parts.slice(1)) {
      for (const w of deCamel(p).split(' ')) {
        if (STYLE_WORDS.test(w)) continue;
        if (FAMILY_WORDS.test(w)) extra.push(w[0].toUpperCase() + w.slice(1).toLowerCase());
      }
    }
    base = base.replace(/(PSMT|PS|MT)$/, '');
    const k = key(base);
    const withExtra = key(base + extra.join(''));
    if (ALIASES[withExtra]) {
      family = ALIASES[withExtra];
      known = true;
    } else if (ALIASES[k]) {
      family = ALIASES[k] + (extra.length ? ` ${extra.join(' ')}` : '');
      known = !extra.length;
    } else if (/^(cm|lm|ec|tc)(r|bx|ti|sl|ss|tt|mi|sy|ex|csc|b|u)\d*$/i.test(base) || /^(f|t|tt|c|cid|font|g|r)?[\d_]+$/i.test(base) || /^(cidfont|t3font|type3|unnamed|unknown|embedded)/i.test(base) || base.length < 3) {
      family = fallbackFamily({ mono: flags.mono || /^(cm|lm)tt/i.test(base), serif: flags.serif || /^(cm|lm|ec)(r|bx|ti|sl|csc|b)/i.test(base) });
    } else {
      // Drop style words glued to the family ("TimesNewRomanBold").
      let spaced = deCamel(base)
        .split(' ')
        .filter((w) => !STYLE_WORDS.test(w))
        .join(' ');
      if (!spaced) spaced = deCamel(base);
      const k2 = key(spaced);
      if (ALIASES[k2]) {
        family = ALIASES[k2];
        known = true;
      } else family = spaced + (extra.length ? ` ${extra.join(' ')}` : '');
    }
  }
  if (!family) family = fallbackFamily(flags);
  // "Black"/"Semibold" families carry their weight themselves.
  const m = METRICS[family];
  let ascent = m ? m[0] : null;
  let descent = m ? m[1] : null;
  if (!m) {
    const a = typeof rec.ascent === 'number' ? rec.ascent : 0.9;
    const d = typeof rec.descent === 'number' ? Math.abs(rec.descent) : 0.22;
    // Font descriptors are often sloppy; keep the result in a sane range.
    ascent = Math.min(1.1, Math.max(0.8, a));
    descent = Math.min(0.32, Math.max(0.18, d));
  }
  // `known`: a family that comes with Windows or Office.
  return { family, bold: flags.bold, italic: flags.italic, serif: flags.serif, mono: flags.mono, ascent, descent, known: (known || !!m) && !NOT_BUNDLED.test(family) };
}

// Default advance of a space (em) when the PDF never shows one in the font.
export function defaultSpaceWidth(font) {
  if (font.mono) return 0.6;
  if (/^(Arial|Verdana|Tahoma|Segoe UI|Microsoft Sans Serif)$/.test(font.family)) return 0.278;
  if (/^Calibri/.test(font.family)) return 0.226;
  return 0.25;
}
