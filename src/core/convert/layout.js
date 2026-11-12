// Page layout analysis for PDF-to-Word conversion.
//
// Turns a page model (glyphs, paths, images) into a description the DOCX
// writer can emit directly:
//   - blocks:  the vertical flow of the page (text lines and tables),
//   - floats:  everything positioned absolutely (images, lines, shapes and
//              text that cannot be part of the flow).
// Every text line keeps its exact position: one paragraph per line with an
// exact line height, an indent for the start position and explicit spacing
// between words, so the result does not depend on Word's own line breaking
// or justification.
import { classifyPaths, detectTables, applyCellFills } from './lattice.js';
import { buildWords, buildLines, splitByDirection, fitFonts } from './text-lines.js';

const r20 = (v) => Math.round(v * 20) / 20;

// Height of the line box Word needs for a font size so that the baseline
// ends up at 80% of the box in every layout engine (see docs in the writer).
export function naturalLineHeight(style) {
  const f = style.font || {};
  const a = f.ascent || 0.9;
  const d = f.descent || 0.22;
  const em = Math.min(1.32, Math.max(1.02, (a - d) / 0.6));
  return em * style.size;
}

// Character spacing below Word's useful resolution is noise.
const quant = (v) => {
  const q = r20(v);
  return Math.abs(q) < 0.075 ? 0 : q;
};

function weightedMedian(items) {
  const list = items.filter((e) => e.w > 0).sort((x, y) => x.v - y.v);
  if (!list.length) return 0;
  const half = list.reduce((acc, e) => acc + e.w, 0) / 2;
  let acc = 0;
  for (const e of list) {
    acc += e.w;
    if (acc >= half) return e.v;
  }
  return list[list.length - 1].v;
}

// Font size that decides the widths of a run in the Word document.
// PDF sizes such as 11.04 are 11 pt rounded to whole device pixels by the
// application that made the PDF (Word lays out on a 600 dpi grid, so its
// text really is that wide). Word will do the same again when it opens the
// document, other applications use the nominal size; the mean keeps both
// within about 0.2% of the original widths. Any other size is simply scaled
// to the half-point size Word uses.
function layoutSize(run) {
  const pdf = run.pdfSize || run.style.size;
  return Math.abs(pdf - run.style.size) <= 0.07 ? (pdf + run.style.size) / 2 : run.style.size;
}

function runWidth(run) {
  const pdf = run.pdfSize || run.style.size;
  let w = run.natural * (layoutSize(run) / pdf);
  // Word scales in whole percent.
  if (run.style.scale !== 100 && run.pdfScale > 0) w *= run.style.scale / 100 / run.pdfScale;
  return w;
}

// Largest position error (pt) that is left uncorrected. Lines set with one
// spacing value get more room: every correction splits their single run.
const tolerance = (size) => Math.max(0.25, 0.025 * size);
const uniformTolerance = (size) => Math.max(0.45, 0.04 * size);

/**
 * Tokens of one line: text runs, spaces with an exact width and tabs to
 * absolute positions.
 *
 * Word adds the character spacing of a run after every character of the run
 * (ECMA-376 17.3.2.35), so a line set with one spacing value - condensed or
 * expanded text - is reproduced by a single run. The spacing is estimated for
 * the whole line; words and spaces only get their own value when their
 * position would otherwise be off by more than the tolerance.
 *
 * `measure(text, style)` may return the natural width of text in the target
 * font (pt); by default the widths found in the PDF are used.
 */
export function lineTokens(line, { measure = null } = {}) {
  const tokens = [];
  // Text measured in a replacement font: its letters have other widths than
  // the original's, so words only need to be about right - the line as a
  // whole keeps its place.
  let replaced = false;
  const words = line.words.map((word) => {
    const widths = word.runs.map((r) => {
      if (measure) {
        const m = measure(r.text, r.style);
        if (m > 0) {
          replaced = true;
          return m;
        }
      }
      return runWidth(r);
    });
    return { word, widths, natural: widths.reduce((a, b) => a + b, 0), width: word.x1 - word.x0, gaps: word.chars - 1, spacing: 0, sep: null };
  });

  // ---- what separates the words
  let hasTab = false;
  const seps = [];
  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1];
    const cur = words[i];
    // The space takes the font of the word before it, unless that font never
    // shows a space in the document (a symbol font, a bullet).
    let spaceRun = prev.word.runs[prev.word.runs.length - 1];
    const nextRun = cur.word.runs[0];
    if (!spaceRun.style.font.spaceKnown && nextRun.style.font.spaceKnown) spaceRun = nextRun;
    const style = spaceRun.style;
    const sw = style.font.space * layoutSize(spaceRun) * (style.scale / 100);
    const gap = cur.word.x0 - prev.word.x1;
    let n = cur.word.spacesBefore;
    // A wide gap is a tab; so is a gap without any space character in it that
    // is clearly wider than a space (a bullet and its text, columns).
    if (gap >= Math.max(1.5 * style.size, 5 * sw) || (n === 0 && gap >= Math.max(0.9 * style.size, 3.2 * sw))) {
      cur.sep = { t: 'tab' };
      hasTab = true;
    } else if (n === 0 && gap < 0.45 * sw) {
      // Adjacent (e.g. a superscript right after its word).
    } else {
      n = Math.max(1, Math.min(n, 4));
      cur.sep = { t: 'space', n, sw, style, gap, prev };
      seps.push(cur.sep);
    }
  }

  // ---- character spacing
  const wordTol = (w) => (replaced ? Math.max(1, 0.06 * w.width) : Math.max(0.3, 0.008 * w.width));
  const gapTol = (size) => (replaced ? Math.max(1.5, 0.12 * size) : tolerance(size));
  // Plain, condensed or expanded text that is not justified: letters and
  // spaces share one value (a space is followed by the spacing of the last
  // letter and by its own).
  let num = 0;
  let den = 0;
  for (const w of words) {
    num += w.width - w.natural;
    den += w.gaps;
  }
  for (const sp of seps) {
    num += sp.gap - sp.n * sp.sw;
    den += sp.n + 1;
  }
  let shared = den ? quant(num / den) : 0;
  let sharedSpace = shared;
  const uniform =
    words.every((w) => Math.abs(w.width - w.natural - shared * w.gaps) <= wordTol(w)) &&
    seps.every((sp) => Math.abs(sp.gap - sp.n * sp.sw - (sp.n + 1) * shared) <= gapTol(sp.style.size));
  if (uniform) {
    for (const w of words) w.spacing = shared;
  } else {
    // Letters first (the spaces may be stretched by justification): a robust
    // estimate, refined over the words that agree with it.
    const rough = weightedMedian(words.filter((w) => w.gaps > 0).map((w) => ({ v: (w.width - w.natural) / w.gaps, w: w.gaps })));
    num = 0;
    den = 0;
    for (const w of words) {
      if (w.gaps > 0 && Math.abs(w.width - w.natural - rough * w.gaps) <= wordTol(w)) {
        num += w.width - w.natural;
        den += w.gaps;
      }
    }
    shared = quant(den ? num / den : rough);
    for (const w of words) {
      const delta = w.width - w.natural;
      if (w.gaps < 1 || Math.abs(delta - shared * w.gaps) <= wordTol(w)) w.spacing = shared;
      else w.spacing = quant(delta / w.gaps);
    }
    // The spacing of the last letter comes before the space.
    sharedSpace = quant(weightedMedian(seps.map((sp) => ({ v: (sp.gap - sp.prev.spacing) / sp.n - sp.sw, w: sp.n }))));
    if (Math.abs(sharedSpace - shared) <= 0.075) sharedSpace = shared;
  }

  // ---- tokens; `pen` follows the position Word reaches
  let pen = line.x0;
  for (const w of words) {
    const sep = w.sep;
    if (sep && sep.t === 'tab') {
      tokens.push({ t: 'tab', pos: w.word.x0 });
      pen = w.word.x0;
    } else if (sep) {
      const { n, sw, style } = sep;
      let extra = (w.word.x0 - pen) / n - sw;
      if (Math.abs(extra - sharedSpace) * n <= (replaced ? gapTol : uniform ? uniformTolerance : tolerance)(style.size)) extra = sharedSpace;
      else extra = quant(extra);
      if (extra < -0.75 * sw) extra = r20(-0.75 * sw);
      tokens.push({ t: 'space', n, extra, style });
      pen += n * (sw + extra);
    }
    const rise = Math.abs(w.word.rise) >= 0.25 ? w.word.rise : 0;
    w.word.runs.forEach((r, i) => {
      tokens.push({ t: 'text', text: r.text, style: r.style, spacing: w.spacing, rise, underline: !!w.word.underline, strike: !!w.word.strike });
      pen += w.widths[i] + w.spacing * r.chars;
    });
  }
  // Underline the spaces between underlined words.
  for (let i = 1; i + 1 < tokens.length; i++) {
    const t = tokens[i];
    if (t.t === 'space' && tokens[i - 1].underline && tokens[i + 1].underline) t.underline = true;
  }
  return { tokens, hasTab, end: pen };
}

/**
 * Converts the lines of a container into paragraph specs with exact line
 * boxes. `top` is the top of the container, `center` its horizontal centre
 * (lines centred on it are emitted as centred paragraphs).
 */
export function placeLines(lines, { top = -Infinity, left, right, measure = null } = {}) {
  const n = lines.length;
  const heights = lines.map((l) => naturalLineHeight({ font: l.style.font, size: Math.max(l.style.size, Math.round(l.size * 2) / 2) }));
  for (let i = 0; i < n; i++) {
    if (i > 0) heights[i] = Math.min(heights[i], lines[i].y - lines[i - 1].y);
    if (i + 1 < n) heights[i] = Math.min(heights[i], lines[i + 1].y - lines[i].y);
    heights[i] = Math.max(heights[i], 1);
  }
  const paras = [];
  for (let i = 0; i < n; i++) {
    const l = lines[i];
    let h = heights[i];
    let t = l.y - 0.8 * h;
    if (t < top) {
      // The text starts above the container: use a smaller box.
      h = Math.max(1, Math.min(h, (l.y - top) / 0.8));
      t = Math.max(top, l.y - 0.8 * h);
    }
    const { tokens, hasTab } = lineTokens(l, { measure });
    const p = { top: t, height: h, x: l.x0, x1: l.x1, y: l.y, align: 'left', hasTab, tokens, style: l.style, size: l.size };
    if (left !== undefined && right !== undefined) p.align = alignmentOf(p, left, right);
    paras.push(p);
  }
  return paras;
}

/**
 * Alignment of a line inside the text area [left, right]: centred when its
 * middle is the middle of the area, right aligned when it ends at the right
 * edge - in both cases only if it starts well inside the area, so that full
 * (justified) lines stay left aligned.
 */
export function alignmentOf(p, left, right) {
  if (p.hasTab) return 'left';
  const width = right - left;
  if (!(width > 0) || p.x - left <= Math.max(2, width * 0.1)) return 'left';
  const tol = Math.max(0.75, width * 0.006);
  if (Math.abs((p.x + p.x1) / 2 - (left + right) / 2) <= tol) return 'center';
  if (Math.abs(right - p.x1) <= 0.75) return 'right';
  return 'left';
}

// Horizontal cell margins of a table: the distance most cells keep between
// the left rule and their text (Word measures cell margins from the middle
// of the border). Cells whose text comes closer get a smaller margin.
const MAX_CELL_MARGIN = 5.4;
function cellMargins(table) {
  const count = new Map();
  let smallest = Infinity;
  for (const c of table.cells) {
    c.gapL = Infinity;
    c.gapR = Infinity;
    for (const l of c.lines) {
      c.gapL = Math.min(c.gapL, l.x0 - c.x0);
      c.gapR = Math.min(c.gapR, c.x1 - l.x1);
    }
    if (!c.lines.length) continue;
    const g = Math.max(0, r20(c.gapL));
    smallest = Math.min(smallest, g);
    if (g <= MAX_CELL_MARGIN + 1.8) count.set(g, (count.get(g) || 0) + 1);
  }
  let margin = 0;
  let best = 0;
  for (const [g, n] of count) {
    if (n > best || (n === best && g < margin)) {
      best = n;
      margin = g;
    }
  }
  if (!best) margin = Number.isFinite(smallest) ? smallest : MAX_CELL_MARGIN;
  margin = Math.min(MAX_CELL_MARGIN, margin);
  table.marL = margin;
  table.marR = margin;
  for (const c of table.cells) {
    c.marL = r20(Math.max(0, Math.min(margin, c.gapL)));
    c.marR = r20(Math.max(0, Math.min(margin, c.gapR)));
  }
}

function cellOfPoint(table, x, y) {
  if (x < table.x0 || x > table.x1 || y < table.y0 || y > table.y1) return null;
  const { xs, ys } = table;
  let i = 0;
  while (i + 1 < xs.length - 1 && x >= xs[i + 1]) i++;
  let j = 0;
  while (j + 1 < ys.length - 1 && y >= ys[j + 1]) j++;
  return table.cells[table.owner[j * table.cols + i]];
}

// Marks words that sit on a thin horizontal rule as underlined / struck out.
function applyUnderlines(allLines, rules) {
  const rest = [];
  for (const r of rules) {
    let used = false;
    if (r.o === 'h' && !r.dash) {
      for (const l of allLines) {
        if (r.t > Math.max(1.2, l.size * 0.14)) continue;
        if (r.b < l.x0 - 1 || r.a > l.x1 + 1) continue;
        const dy = r.pos - l.y;
        const under = dy >= 0.02 * l.size && dy <= 0.3 * l.size;
        const strike = dy <= -0.18 * l.size && dy >= -0.45 * l.size;
        if (!under && !strike) continue;
        // The rule must not extend much beyond the text it decorates.
        if (r.a < l.x0 - 0.6 * l.size || r.b > l.x1 + 0.6 * l.size) continue;
        let hit = 0;
        for (const w of l.words) {
          const o = Math.min(r.b, w.x1) - Math.max(r.a, w.x0);
          if (o >= (w.x1 - w.x0) * 0.6) {
            if (under) w.underline = true;
            else w.strike = true;
            hit++;
          }
        }
        if (hit) {
          used = true;
          break;
        }
      }
    }
    if (!used) rest.push(r);
  }
  return rest;
}

function imageFloat(img) {
  const m = img.m;
  const ux = m[0];
  const uy = m[1];
  const vx = m[2];
  const vy = m[3];
  const w = Math.hypot(ux, uy);
  const h = Math.hypot(vx, vy);
  if (w < 0.5 || h < 0.5) return null;
  const cx = m[0] * 0.5 + m[2] * 0.5 + m[4];
  const cy = m[1] * 0.5 + m[3] * 0.5 + m[5];
  let angle = (Math.atan2(uy, ux) * 180) / Math.PI;
  // In view space (y down) an upright image has u = (w, 0) and v = (0, -h).
  const cross = ux * vy - uy * vx;
  let flipV = cross > 0;
  let flipH = false;
  if (Math.abs(Math.abs(angle) - 180) < 0.5) {
    // A half turn is the same as flipping both axes.
    angle = 0;
    flipH = true;
    flipV = !flipV;
  }
  const f = { type: 'image', x: cx - w / 2, y: cy - h / 2, w, h, rot: Math.abs(angle) < 0.05 ? 0 : angle, flipH, flipV, seq: img.seq, alpha: img.alpha, source: img, crop: null };
  // Cropping by the clip rectangle (upright images only).
  if (!f.rot && !flipH && !flipV && img.clip) {
    const c = img.clip;
    const l = Math.max(0, c[0] - f.x) / w;
    const t = Math.max(0, c[1] - f.y) / h;
    const r = Math.max(0, f.x + w - c[2]) / w;
    const b = Math.max(0, f.y + h - c[3]) / h;
    if (l + r < 0.98 && t + b < 0.98 && Math.max(l, t, r, b) > 0.004) {
      f.crop = { l, t, r, b };
      f.x += l * w;
      f.y += t * h;
      f.w = w * (1 - l - r);
      f.h = h * (1 - t - b);
    }
  }
  return f;
}

/**
 * Lays out one page.
 * @returns { width, height, blocks, floats, lines (all text lines, for stats) }
 */
export function layoutPage(model, { resolveFont = null, measure = null, fits = null } = {}) {
  const { width, height } = model;
  fitFonts(model.glyphs, { resolveFont, measure, fits });
  const { rules, fills, shapes } = classifyPaths(model.paths, model);
  const detected = detectTables(rules, model);
  let tables = detected.tables;
  let looseRules = detected.lines;
  const looseFills = applyCellFills(tables, fills);

  const { horizontal, rotated } = splitByDirection(model.glyphs);

  // ---- distribute glyphs over table cells
  const free = [];
  for (const t of tables) for (const c of t.cells) c.glyphs = [];
  for (const g of horizontal) {
    const cx = g.x + g.w / 2;
    const cy = g.y - 0.3 * g.size;
    let cell = null;
    for (const t of tables) {
      cell = cellOfPoint(t, cx, cy);
      if (cell) break;
    }
    if (cell) cell.glyphs.push(g);
    else free.push(g);
  }
  const allLines = [];
  for (const t of tables) {
    for (const c of t.cells) {
      c.lines = c.glyphs.length ? buildLines(buildWords(c.glyphs, { resolveFont })) : [];
      allLines.push(...c.lines);
      delete c.glyphs;
    }
  }
  const freeLines = buildLines(buildWords(free, { resolveFont }));
  allLines.push(...freeLines);

  // A frame without text (around a picture, say) is a drawing, not a table.
  tables = tables.filter((t) => {
    const c = t.cells[0];
    if (t.cells.length !== 1 || c.lines.length) return true;
    const b = c.borders;
    const half = (e) => (e ? e.t / 2 : 0);
    if (c.fill) looseFills.push({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, color: c.fill, seq: -1 });
    for (const [o, pos, a, z, e] of [
      ['h', c.y0, c.x0 - half(b.left), c.x1 + half(b.right), b.top],
      ['h', c.y1, c.x0 - half(b.left), c.x1 + half(b.right), b.bottom],
      ['v', c.x0, c.y0 - half(b.top), c.y1 + half(b.bottom), b.left],
      ['v', c.x1, c.y0 - half(b.top), c.y1 + half(b.bottom), b.right],
    ]) {
      if (e) looseRules.push({ o, pos, a, b: z, t: e.t, color: e.color, dash: e.dash, seq: e.seq ?? 0 });
    }
    return false;
  });

  looseRules = applyUnderlines(allLines, looseRules);

  // ---- tables
  const tableBlocks = tables.map((t) => {
    cellMargins(t);
    for (const c of t.cells) {
      const topT = t.hT[c.r0] || 0;
      const interiorTop = c.y0 + topT / 2;
      const left = c.x0 + c.marL;
      const right = c.x1 - c.marR;
      c.paras = placeLines(c.lines, { top: interiorTop, left, right, measure });
    }
    const top = t.y0 - (t.hT[0] || 0) / 2;
    const bottom = t.y1 + (t.hT[t.rows] || 0) / 2;
    return { type: 'table', table: t, top, bottom, x0: t.x0, x1: t.x1 };
  });

  // ---- free text: flow when possible, otherwise text boxes
  const floats = [];
  const flowLines = [];
  const boxLines = [];
  for (const l of freeLines) {
    const hgt = naturalLineHeight({ font: l.style.font, size: l.style.size });
    const top = l.y - 0.8 * hgt;
    const bottom = l.y + 0.2 * hgt;
    const beside = tableBlocks.some((b) => top < b.bottom - 0.5 && bottom > b.top + 0.5);
    (beside ? boxLines : flowLines).push(l);
  }
  // Lines whose baselines are too close to stack - overprinted text, columns
  // whose lines do not share baselines - float: a line box much lower than
  // the text would cut the letters off.
  const stack = [];
  for (const l of flowLines) {
    const prev = stack[stack.length - 1];
    const need = 0.85 * Math.min(naturalLineHeight({ font: l.style.font, size: l.style.size }), naturalLineHeight({ font: prev ? prev.style.font : l.style.font, size: prev ? prev.style.size : l.style.size }));
    if (prev && l.y - prev.y < need) boxLines.push(l);
    else stack.push(l);
  }
  // Split the flow into segments between tables so that line boxes never
  // reach into a table.
  const blocks = [...tableBlocks];
  const sortedTables = tableBlocks.slice().sort((a, b) => a.top - b.top);
  let segment = [];
  let segTop = 0;
  const flushSegment = (limit) => {
    if (!segment.length) return;
    // The text area is only known once all pages are laid out: the writer
    // decides how these lines are aligned.
    const paras = placeLines(segment, { top: segTop, measure });
    for (const p of paras) {
      if (p.top + p.height > limit) p.height = Math.max(1, limit - p.top);
      blocks.push({ type: 'para', para: p, top: p.top, bottom: p.top + p.height, x0: p.x, x1: p.x1 });
    }
    segment = [];
  };
  let ti = 0;
  for (const l of stack) {
    while (ti < sortedTables.length && sortedTables[ti].top < l.y) {
      flushSegment(sortedTables[ti].top);
      segTop = Math.max(segTop, sortedTables[ti].bottom);
      ti++;
    }
    segment.push(l);
  }
  flushSegment(ti < sortedTables.length ? sortedTables[ti].top : height);
  blocks.sort((a, b) => a.top - b.top);
  // Overlapping tables (side by side) cannot both be in the flow.
  let cursor = -Infinity;
  for (const b of blocks) {
    if (b.type === 'table' && b.top < cursor - 0.5) b.overlaps = true;
    else cursor = Math.max(cursor, b.bottom);
  }

  for (const l of boxLines) {
    const [p] = placeLines([l], { measure });
    floats.push({ type: 'textbox', x: l.x0, y: p.top, w: l.x1 - l.x0, h: p.height, rot: 0, para: p, seq: l.words[0].seq });
  }

  // ---- rotated text: one rotated text box per line
  for (const group of rotated) {
    const lines = buildLines(buildWords(group.glyphs, { resolveFont }));
    for (const l of lines) {
      const [p] = placeLines([l], { measure });
      const w = l.x1 - l.x0;
      const [cx, cy] = group.toPage(l.x0 + w / 2, p.top + p.height / 2);
      floats.push({ type: 'textbox', x: cx - w / 2, y: cy - p.height / 2, w, h: p.height, cx, cy, rot: group.angle, para: { ...p, x: 0, top: 0, local: true, x0: l.x0 }, seq: l.words[0].seq });
      allLines.push(l);
    }
  }

  // ---- graphics
  for (const img of model.images) {
    const f = imageFloat(img);
    if (f) floats.push(f);
  }
  for (const r of looseRules) {
    if (r.b - r.a < 1.5) continue;
    floats.push({ type: 'line', o: r.o, pos: r.pos, a: r.a, b: r.b, t: r.t, color: r.color, dash: r.dash, seq: r.seq });
  }
  for (const f of looseFills) floats.push({ type: 'rect', x: f.x0, y: f.y0, w: f.x1 - f.x0, h: f.y1 - f.y0, fill: f.color, seq: f.seq });
  for (const s of shapes) {
    if (!s.bbox) continue;
    const bw = s.bbox[2] - s.bbox[0];
    const bh = s.bbox[3] - s.bbox[1];
    if (bw < 0.3 && bh < 0.3) continue;
    const white = (c) => !c || /^#f[c-f]f[c-f]f[c-f]$/i.test(c);
    // Large white shapes are page backgrounds.
    if (white(s.stroke) && white(s.fill)) continue;
    floats.push({ type: 'path', d: s.d, bbox: s.bbox, fill: s.fill, grad: s.grad || null, stroke: s.stroke, lw: s.lw, dash: s.dash, evenOdd: s.evenOdd, alpha: s.alpha, clip: s.clip, seq: s.seq });
  }
  floats.sort((a, b) => a.seq - b.seq);
  return { width, height, blocks, floats, lines: allLines, tables };
}
