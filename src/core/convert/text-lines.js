// Groups the glyphs of a page model into words and lines.
//
// A word is a run of glyphs without a gap; it keeps the exact start and end
// position found in the PDF so the Word output can reproduce the spacing.
// A line is the set of words of one container (table cell, page, text box)
// that share a baseline.
import { mapFont, defaultSpaceWidth } from './font-map.js';

const cps = (s) => Array.from(s).length;

/** Resolves the Word font of every PDF font record (cached on the record). */
export function wordFont(rec, resolveFont) {
  if (!rec.word) {
    const mapped = mapFont(rec.name, rec);
    const custom = resolveFont ? resolveFont(mapped, rec) : null;
    rec.word = { ...mapped, ...(custom || {}) };
    if (custom && custom.space > 0) rec.word.spaceKnown = true;
    else {
      rec.word.spaceKnown = rec.spaceWidth > 0.05 && rec.spaceWidth < 1.2;
      rec.word.space = rec.word.spaceKnown ? rec.spaceWidth : defaultSpaceWidth(rec.word);
    }
  }
  return rec.word;
}

function styleOf(g, resolveFont) {
  const f = wordFont(g.font, resolveFont);
  // Sizes are compared at Word's half-point resolution.
  const size = Math.max(1, Math.round(g.size * 2) / 2);
  // Horizontal scale of the PDF text times the one that fits a replacement
  // font to the widths of the original (see fitFonts).
  const hs = g.hs * (f.fit || 1);
  const scale = Math.abs(hs - 1) > 0.04 ? Math.round(hs * 100) : 100;
  // Bold by a bold font, by stroking the glyphs or by painting them twice.
  const bold = !!(f.bold || g.faux || g.overprint);
  const outline = !!g.outline;
  const key = `${f.family}|${bold ? 1 : 0}${f.italic ? 1 : 0}${outline ? 1 : 0}|${size}|${g.color}|${scale}`;
  return { key, family: f.family, bold, italic: f.italic, outline, size, color: g.color, scale, font: f };
}

function finishWord(w) {
  const gl = w.glyphs;
  const first = gl[0];
  const last = gl[gl.length - 1];
  w.x0 = first.x;
  w.x1 = last.x + last.w;
  const ys = gl.map((g) => g.y).sort((a, b) => a - b);
  w.y = ys[ys.length >> 1];
  w.size = 0;
  w.seq = first.seq;
  w.runs = [];
  let run = null;
  for (const g of gl) {
    if (g.size > w.size) w.size = g.size;
    // (after all glyphs of the row are known: overprinting marks bold)
    g.style = styleOf(g, g.resolveFont);
    delete g.resolveFont;
    if (!run || run.style.key !== g.style.key) {
      run = { text: '', style: g.style, natural: 0, chars: 0, pdfSize: g.size, pdfScale: g.hs };
      w.runs.push(run);
    }
    run.text += g.s;
    run.natural += g.w;
    run.chars += cps(g.s);
  }
  for (const r of w.runs) r.text = r.text.normalize('NFC');
  w.text = w.runs.map((r) => r.text).join('');
  w.natural = w.runs.reduce((a, r) => a + r.natural, 0);
  w.chars = w.runs.reduce((a, r) => a + r.chars, 0);
  w.lineY = w.y;
  w.rise = 0;
  return w;
}

/**
 * A replacement font (one `measure` knows the widths of) that runs clearly
 * wider or narrower than the PDF font is scaled horizontally to the same
 * average width: the text then looks like normal words instead of being
 * letter-spaced into place. `fits` (font name -> factor) keeps the factor the
 * same on every page.
 */
export function fitFonts(glyphs, { resolveFont = null, measure = null, fits = null } = {}) {
  if (!measure) return;
  const sums = new Map();
  for (const g of glyphs) {
    if (g.space || !(g.size > 0) || !(g.hs > 0)) continue;
    const f = wordFont(g.font, resolveFont);
    if (f.fit !== undefined) continue;
    const known = fits && fits.get(g.font.name);
    if (known) {
      f.fit = known;
      continue;
    }
    const m = measure(g.s, { font: f, size: 1, scale: 100 });
    if (!(m > 0)) continue;
    const e = sums.get(g.font) || { pdf: 0, own: 0, n: 0 };
    e.pdf += g.w / (g.size * g.hs);
    e.own += m;
    e.n++;
    sums.set(g.font, e);
  }
  for (const [rec, e] of sums) {
    let fit = 1;
    if (e.n >= 4 && e.own > 0) {
      const ratio = e.pdf / e.own;
      if (Math.abs(ratio - 1) >= 0.04) fit = Math.min(2, Math.max(0.5, Math.round(ratio * 100) / 100));
    }
    rec.word.fit = fit;
    if (fits) fits.set(rec.name, fit);
  }
}

/**
 * Builds words from horizontal glyphs (baseline direction = +x).
 * Returns words: { text, runs, x0, x1, y, size, natural, chars, spacesBefore, lineY, rise }
 */
export function buildWords(glyphs, { resolveFont = null } = {}) {
  const sorted = glyphs.slice().sort((a, b) => a.y - b.y || a.x - b.x || a.seq - b.seq);
  // Rows of glyphs sharing a baseline.
  const rows = [];
  let cur = null;
  for (const g of sorted) {
    if (cur && g.y - cur.y1 <= 0.45 && g.y - cur.y0 <= 1.2) {
      cur.items.push(g);
      cur.y1 = g.y;
    } else {
      cur = { items: [g], y0: g.y, y1: g.y };
      rows.push(cur);
    }
  }
  const words = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x || a.seq - b.seq);
    let word = null;
    let prev = null;
    let spaces = 0;
    for (const g of row.items) {
      if (g.space) {
        if (prev) spaces++;
        word = null;
        continue;
      }
      // The same character painted twice at (almost) the same place: fake
      // bold or a shadow. Keep one.
      if (prev && g.s === prev.s && Math.abs(g.x - prev.x) < 0.22 * g.size && Math.abs(g.size - prev.size) < 0.1) {
        if (Math.abs(g.x - prev.x) > 0.02 * g.size) prev.overprint = true;
        continue;
      }
      g.resolveFont = resolveFont;
      const gap = prev ? g.x - (prev.x + prev.w) : Infinity;
      const ref = Math.max(g.size, prev ? prev.size : 0);
      if (!word || spaces > 0 || gap > 0.27 * ref || gap < -0.7 * ref) {
        word = { glyphs: [], spacesBefore: prev && gap < 3 * ref + spaces * ref ? spaces : 0 };
        words.push(word);
      }
      word.glyphs.push(g);
      prev = g;
      spaces = 0;
    }
  }
  for (const w of words) finishWord(w);
  attachRaised(words);
  return words;
}

// Superscripts and subscripts: small words right next to a bigger word on a
// nearby baseline join that word's line, keeping their vertical offset.
function attachRaised(words) {
  const byX = words.slice().sort((a, b) => a.x0 - b.x0);
  for (const w of words) {
    let best = null;
    let bestDist = Infinity;
    for (const h of byX) {
      if (h === w || h.size < w.size * 1.18) continue;
      if (h.x0 > w.x1 + 0.45 * h.size) break;
      const dy = h.y - w.y;
      if (Math.abs(dy) < 0.5 || dy > 0.95 * h.size || dy < -0.45 * h.size) continue;
      const after = Math.abs(w.x0 - h.x1);
      const before = Math.abs(h.x0 - w.x1);
      const dist = Math.min(after, before);
      if (dist <= 0.45 * h.size && dist < bestDist) {
        best = h;
        bestDist = dist;
      }
    }
    if (best) w.host = best;
  }
  for (const w of words) {
    if (!w.host) continue;
    let h = w.host;
    for (let k = 0; k < 4 && h.host; k++) h = h.host;
    w.lineY = h.y;
    w.rise = h.y - w.y;
  }
}

/**
 * Groups the words of one container into lines (sorted top to bottom).
 * Line: { y, size, x0, x1, words, font }
 */
export function buildLines(words) {
  const sorted = words.slice().sort((a, b) => a.lineY - b.lineY || a.x0 - b.x0);
  const lines = [];
  for (const w of sorted) {
    let target = null;
    for (let k = lines.length - 1; k >= 0 && k >= lines.length - 4; k--) {
      const l = lines[k];
      const dy = w.lineY - l.y;
      if (dy <= 0.6) {
        target = l;
        break;
      }
      // Baselines that are too close for two separate lines of text share a
      // line when the words do not overlap horizontally.
      if (dy <= 0.5 * Math.min(w.size, l.size)) {
        const overlaps = l.words.some((o) => o.x0 < w.x1 - 0.5 && w.x0 < o.x1 - 0.5);
        if (!overlaps) {
          target = l;
          break;
        }
      }
    }
    if (target) {
      if (Math.abs(w.lineY - target.y) > 0.6) w.rise += target.y - w.lineY;
      target.words.push(w);
    } else lines.push({ y: w.lineY, words: [w] });
  }
  for (const l of lines) {
    l.words.sort((a, b) => a.x0 - b.x0 || a.seq - b.seq);
    l.x0 = Math.min(...l.words.map((w) => w.x0));
    l.x1 = Math.max(...l.words.map((w) => w.x1));
    // Dominant style by character count (ignoring raised text).
    const count = new Map();
    let size = 0;
    for (const w of l.words) {
      if (Math.abs(w.rise) < 0.5 && w.size > size) size = w.size;
      for (const r of w.runs) {
        const e = count.get(r.style.key) || { n: 0, style: r.style };
        e.n += r.chars;
        count.set(r.style.key, e);
      }
    }
    if (!size) size = Math.max(...l.words.map((w) => w.size));
    let dom = null;
    for (const e of count.values()) if (!dom || e.n > dom.n) dom = e;
    l.size = size;
    l.style = dom.style;
  }
  lines.sort((a, b) => a.y - b.y || a.x0 - b.x0);
  return lines;
}

/**
 * Splits glyphs by writing direction. Returns { horizontal, rotated } where
 * rotated is a list of { angle (deg, clockwise), glyphs (in a frame where the
 * text is horizontal), toPage(x, y) }.
 */
export function splitByDirection(glyphs) {
  const horizontal = [];
  const groups = new Map();
  for (const g of glyphs) {
    if (Math.abs(g.ay) < 0.02 && g.ax > 0) {
      horizontal.push(g);
      continue;
    }
    const angle = Math.round((Math.atan2(g.ay, g.ax) * 180) / Math.PI);
    if (!groups.has(angle)) groups.set(angle, []);
    groups.get(angle).push(g);
  }
  const rotated = [];
  for (const [angle, list] of groups) {
    const r = (angle * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    // Rotate by -angle so that the baseline runs along +x.
    const local = list.map((g) => ({ ...g, x: g.x * c + g.y * s, y: -g.x * s + g.y * c, ax: 1, ay: 0 }));
    rotated.push({ angle, glyphs: local, toPage: (x, y) => [x * c - y * s, x * s + y * c] });
  }
  return { horizontal, rotated };
}
