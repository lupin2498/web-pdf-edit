// Groups pdf.js text items into editable lines and paragraphs (Edit mode).
import { allTextRuns, allPaths } from '../../../core/interpreter.js';

const ORIENTATIONS = [0, 90, 180, 270];

function itemOrientation(it) {
  const [a, b] = it.transform;
  const deg = (Math.atan2(b, a) * 180) / Math.PI;
  const norm = ((deg % 360) + 360) % 360;
  for (const o of ORIENTATIONS) {
    const d = Math.abs(norm - o);
    if (d < 1.5 || d > 358.5) return o;
  }
  return null;
}

// Rotate a user-space point into the "text frame" of orientation o.
function toLocal(o, x, y) {
  switch (o) {
    case 90:
      return [y, -x];
    case 180:
      return [-x, -y];
    case 270:
      return [-y, x];
    default:
      return [x, y];
  }
}

function fromLocal(o, u, v) {
  switch (o) {
    case 90:
      return [-v, u];
    case 180:
      return [-u, -v];
    case 270:
      return [v, -u];
    default:
      return [u, v];
  }
}

function localRectToUser(o, r) {
  const pts = [fromLocal(o, r[0], r[1]), fromLocal(o, r[2], r[3])];
  return [Math.min(pts[0][0], pts[1][0]), Math.min(pts[0][1], pts[1][1]), Math.max(pts[0][0], pts[1][0]), Math.max(pts[0][1], pts[1][1])];
}

// Text running at orientation o (counterclockwise) reads upright when the
// page is viewed with a clockwise rotation of o, which is the object `rot`.
export function rotForOrientation(o) {
  return o % 360;
}

export function buildTextBlocks(textContent, { mode = 'paragraph', analysis = null } = {}) {
  const styles = textContent.styles || {};
  const items = [];
  for (const it of textContent.items || []) {
    if (typeof it.str !== 'string') continue;
    const o = itemOrientation(it);
    const [a, b, c, d, e, f] = it.transform;
    const size = Math.hypot(c, d) || Math.hypot(a, b) || it.height || 10;
    if (o === null) continue;
    if (!it.str.length && !it.width) continue;
    const st = styles[it.fontName] || {};
    const asc = typeof st.ascent === 'number' && st.ascent > 0 ? st.ascent : 0.8;
    const desc = typeof st.descent === 'number' && st.descent < 0 ? st.descent : -0.2;
    const [u, v] = toLocal(o, e, f);
    items.push({ str: it.str, o, size, u, v, w: it.width || 0, asc, desc, fontName: it.fontName, hasEOL: it.hasEOL, mirrored: a * d - b * c < 0 });
  }
  const blocks = [];
  const runs = analysis ? allTextRuns(analysis).map((r) => r.run) : null;
  const segments = analysis ? allPaths(analysis).flatMap((p) => p.pathItem.segments || []) : [];
  for (const o of ORIENTATIONS) {
    const group = items.filter((it) => it.o === o && !it.mirrored);
    if (!group.length) continue;
    const lines = buildLines(group, columnRules(segments, o));
    // Lines only join a paragraph when they share font and colour, so editing
    // a paragraph never restyles a differently styled line next to it.
    for (const l of lines) l.style = runs ? dominantStyle(runs, localRectToUser(o, l.rect))?.key : dominantFontName(l);
    const paragraphs = mode === 'line' ? lines.map((l) => [l]) : groupParagraphs(lines);
    for (const para of paragraphs) blocks.push(makeBlock(para, o));
  }
  // Attach style information from the content analysis.
  if (runs) attachStyles(blocks, runs);
  blocks.forEach((b, i) => (b.id = `blk${i}`));
  return blocks;
}

// Vertical rules (table cell borders) in the text frame of orientation o.
function columnRules(segments, o) {
  const rules = [];
  for (const [x0, y0, x1, y1] of segments) {
    const p = toLocal(o, x0, y0);
    const q = toLocal(o, x1, y1);
    if (Math.abs(p[0] - q[0]) > 1 || Math.abs(p[1] - q[1]) < 4) continue;
    rules.push({ u: (p[0] + q[0]) / 2, v0: Math.min(p[1], q[1]), v1: Math.max(p[1], q[1]) });
  }
  return rules;
}

function buildLines(items, rules = []) {
  // Whitespace-only items are skipped: pdf.js emits wide "fake space" items
  // for column gaps, which would glue table cells into one line. Word
  // spacing is restored from the gaps below.
  const sorted = items.filter((it) => it.str.trim()).sort((p, q) => q.v - p.v || p.u - q.u);
  const lines = [];
  for (const it of sorted) {
    let placed = false;
    for (let k = lines.length - 1; k >= 0 && k >= lines.length - 6; k--) {
      const line = lines[k];
      const tol = Math.max(line.size, it.size) * 0.35;
      if (Math.abs(line.v - it.v) > tol) continue;
      const gap = it.u - line.u1;
      const maxGap = Math.max(line.size, it.size) * 1.6;
      if (gap > maxGap || it.u + it.w < line.u0 - 0.5) continue;
      // A column rule between the line and the item separates table cells.
      const lo = it.v + it.desc * it.size;
      const hi = it.v + it.asc * it.size;
      if (gap > 0 && rules.some((r) => r.u > line.u1 - 0.5 && r.u < it.u + 0.5 && r.v0 < hi && r.v1 > lo)) continue;
      line.items.push(it);
      line.u1 = Math.max(line.u1, it.u + it.w);
      line.u0 = Math.min(line.u0, it.u);
      placed = true;
      break;
    }
    if (!placed) {
      lines.push({ items: [it], u0: it.u, u1: it.u + it.w, v: it.v, size: it.size, asc: it.asc, desc: it.desc });
    }
  }
  for (const line of lines) {
    line.items.sort((p, q) => p.u - q.u);
    let text = '';
    let lastEnd = null;
    for (const it of line.items) {
      if (lastEnd !== null) {
        const gap = it.u - lastEnd;
        if (gap > it.size * 0.12 && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' ';
      }
      text += it.str;
      lastEnd = it.u + it.w;
    }
    line.text = text.replace(/\s+$/, '');
    const sizes = line.items.filter((i) => i.str.trim()).map((i) => i.size);
    line.size = sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : line.size;
    line.asc = Math.max(...line.items.map((i) => i.asc));
    line.desc = Math.min(...line.items.map((i) => i.desc));
    line.rect = [line.u0, line.v + line.desc * line.size, line.u1, line.v + line.asc * line.size];
  }
  return lines.filter((l) => l.text.trim());
}

// Lines starting with a list marker ("1.", "a)", bullets) begin a paragraph.
const LIST_ITEM = /^\s*(?:\d{1,3}[.)]|[a-zA-Z][.)]|[•·▪◦‣●○■□–—*-])\s/;

function groupParagraphs(lines) {
  const sorted = lines.slice().sort((a, b) => b.v - a.v || a.u0 - b.u0);
  const paras = [];
  for (const line of sorted) {
    let target = null;
    if (LIST_ITEM.test(line.text)) {
      paras.push([line]);
      continue;
    }
    for (let k = paras.length - 1; k >= 0 && k >= paras.length - 8; k--) {
      const p = paras[k];
      const last = p[p.length - 1];
      const sizeRatio = Math.abs(last.size - line.size) / Math.max(last.size, line.size);
      if (sizeRatio > 0.2) continue;
      if (last.style !== line.style) continue;
      const dy = last.v - line.v;
      if (dy <= last.size * 0.5 || dy > Math.max(last.size, line.size) * 1.75) continue;
      const pu0 = Math.min(...p.map((l) => l.u0));
      const pu1 = Math.max(...p.map((l) => l.u1));
      const overlap = Math.min(pu1, line.u1) - Math.max(pu0, line.u0);
      if (overlap < Math.min(pu1 - pu0, line.u1 - line.u0) * 0.3) continue;
      if (Math.abs(line.u0 - pu0) > line.size * 4 && Math.abs(line.u1 - pu1) > line.size * 4) continue;
      target = p;
      break;
    }
    if (target) target.push(line);
    else paras.push([line]);
  }
  return paras;
}

function makeBlock(lines, o) {
  const u0 = Math.min(...lines.map((l) => l.rect[0]));
  const v0 = Math.min(...lines.map((l) => l.rect[1]));
  const u1 = Math.max(...lines.map((l) => l.rect[2]));
  const v1 = Math.max(...lines.map((l) => l.rect[3]));
  const size = lines.reduce((a, l) => a + l.size, 0) / lines.length;
  let lineHeight = 1.2;
  if (lines.length > 1) {
    let sum = 0;
    for (let i = 1; i < lines.length; i++) sum += lines[i - 1].v - lines[i].v;
    lineHeight = sum / (lines.length - 1) / size;
  }
  let align = 'left';
  if (lines.length > 1) {
    const lefts = lines.map((l) => l.u0);
    const rights = lines.map((l) => l.u1);
    const centers = lines.map((l) => (l.u0 + l.u1) / 2);
    const spread = (arr) => Math.max(...arr) - Math.min(...arr);
    const tol = size * 0.5;
    if (spread(lefts) > tol && spread(centers) <= tol) align = 'center';
    else if (spread(lefts) > tol && spread(rights) <= tol) align = 'right';
  }
  const rect = localRectToUser(o, [u0, v0, u1, v1]);
  const text = lines.map((l) => l.text).join(lines.length > 1 ? ' ' : '');
  const lineTexts = lines.map((l) => l.text);
  return {
    orientation: o,
    rot: rotForOrientation(o),
    rect,
    localRect: [u0, v0, u1, v1],
    lines: lines.map((l) => ({ text: l.text, rect: localRectToUser(o, l.rect) })),
    lineTexts,
    text,
    size,
    lineHeight: Math.max(0.9, Math.min(3, lineHeight)),
    align,
    firstBaselineOffset: v1 - lines[0].v,
    ascent: lines[0].asc,
    descent: lines[0].desc,
  };
}

// Dominant font and fill colour of the glyphs inside `rect` (user space).
function dominantStyle(runs, rect) {
  const counts = new Map();
  for (const run of runs) {
    if (!run.bbox) continue;
    if (run.bbox[2] < rect[0] || run.bbox[0] > rect[2] || run.bbox[3] < rect[1] || run.bbox[1] > rect[3]) continue;
    let n = 0;
    for (const g of run.glyphs) {
      if (g.cx >= rect[0] && g.cx <= rect[2] && g.cy >= rect[1] && g.cy <= rect[3]) n++;
    }
    if (!n) continue;
    const key = `${(run.font.name || '').replace(/^[A-Z]{6}\+/, '')}|${run.fillRgb.map((v) => v.toFixed(2)).join(',')}`;
    const cur = counts.get(key) || { n: 0, run, key };
    cur.n += n;
    counts.set(key, cur);
  }
  let best = null;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  return best;
}

function dominantFontName(line) {
  const counts = new Map();
  for (const it of line.items) counts.set(it.fontName, (counts.get(it.fontName) || 0) + it.str.length);
  let best = null;
  for (const [name, n] of counts) if (!best || n > best[1]) best = [name, n];
  return best ? best[0] : undefined;
}

function attachStyles(blocks, runs) {
  for (const b of blocks) {
    const best = dominantStyle(runs, b.rect);
    if (best) {
      const f = best.run.font;
      b.font = { name: f.name, bold: !!f.bold, italic: !!f.italic, serif: !!f.serif, mono: !!f.mono, family: f.family };
      b.color = best.run.fillRgb.map((v) => Math.round(v * 1000) / 1000);
      if (best.run.render === 3 || best.run.render === 7) b.invisible = true;
    } else {
      b.font = { name: '', bold: false, italic: false, serif: false, mono: false };
      b.color = [0, 0, 0];
    }
  }
}
