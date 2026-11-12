// Table detection from ruling lines ("lattice" method): thin rectangles and
// straight strokes are merged into horizontal/vertical rules, connected rules
// form a grid, and the grid atoms not separated by a rule are merged into
// cells (with row/column spans). Everything that is not part of a table is
// returned as plain lines, filled areas or generic vector shapes.

const SNAP = 1.2; // rule positions closer than this share one grid line (pt)
const JOIN = 1.6; // gaps along a rule smaller than this are bridged (pt)
const TOUCH = 2.2; // rules closer than this are considered connected (pt)

const isWhite = (c) => !c || /^#f[c-f]f[c-f]f[c-f]$/i.test(c);

function clampInterval(a, b, lo, hi) {
  return [Math.max(a, lo), Math.min(b, hi)];
}

// Splits a path into polylines; returns null when it contains curves.
function polylines(d) {
  const out = [];
  let cur = null;
  for (const c of d) {
    if (c[0] === 'M') {
      cur = { pts: [[c[1], c[2]]], closed: false };
      out.push(cur);
    } else if (c[0] === 'L') {
      if (!cur) return null;
      cur.pts.push([c[1], c[2]]);
    } else if (c[0] === 'Z') {
      if (cur) cur.closed = true;
    } else {
      return null;
    }
  }
  return out.filter((p) => p.pts.length >= 2);
}

function axisRect(poly) {
  // Returns [x0, y0, x1, y1] when the polyline is an axis-aligned rectangle.
  let pts = poly.pts;
  if (pts.length === 5 && Math.abs(pts[0][0] - pts[4][0]) < 0.01 && Math.abs(pts[0][1] - pts[4][1]) < 0.01) pts = pts.slice(0, 4);
  if (pts.length !== 4) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  // Tolerance for slightly skewed rectangles; always smaller than the sides.
  const eps = Math.max(0.004, Math.min(0.05 + Math.max(x1 - x0, y1 - y0) * 0.0005, Math.min(x1 - x0, y1 - y0) * 0.25));
  for (const p of pts) {
    if (Math.min(Math.abs(p[0] - x0), Math.abs(p[0] - x1)) > eps) return null;
    if (Math.min(Math.abs(p[1] - y0), Math.abs(p[1] - y1)) > eps) return null;
  }
  // Consecutive points must share exactly one coordinate.
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    const dx = Math.abs(a[0] - b[0]) > eps;
    const dy = Math.abs(a[1] - b[1]) > eps;
    if (dx === dy) return null;
  }
  return [x0, y0, x1, y1];
}

function isThin(w, h) {
  const mn = Math.min(w, h);
  const mx = Math.max(w, h);
  return mn <= 3.2 || (mn <= 8 && mx / mn >= 14);
}

/**
 * Classifies painted paths.
 * Returns { rules, fills, shapes }:
 *   rules:  [{ o: 'h'|'v', pos, a, b, t, color, dash, seq }]
 *   fills:  [{ x0, y0, x1, y1, color, seq }]           (filled rectangles)
 *   shapes: [path]                                        (everything else)
 */
export function classifyPaths(paths, page) {
  const rules = [];
  const fills = [];
  const shapes = [];
  const pageBox = [0, 0, page.width, page.height];
  const addRule = (o, pos, a, b, t, color, dash, seq, clip) => {
    const c = clip || pageBox;
    if (o === 'h') {
      if (pos < c[1] - t - 0.5 || pos > c[3] + t + 0.5) return;
      [a, b] = clampInterval(a, b, c[0], c[2]);
    } else {
      if (pos < c[0] - t - 0.5 || pos > c[2] + t + 0.5) return;
      [a, b] = clampInterval(a, b, c[1], c[3]);
    }
    if (b < a) return;
    rules.push({ o, pos, a, b, t, color, dash: dash || null, seq });
  };
  const addRectAsRuleOrFill = (r, color, seq, clip) => {
    const w = r[2] - r[0];
    const h = r[3] - r[1];
    if (isThin(w, h)) {
      if (w <= 3.2 && h <= 3.2) {
        // A dot (e.g. the corner squares Word draws where borders meet): it
        // may extend rules in both directions.
        addRule('h', (r[1] + r[3]) / 2, r[0], r[2], h, color, null, seq, clip);
        addRule('v', (r[0] + r[2]) / 2, r[1], r[3], w, color, null, seq, clip);
      } else if (w >= h) addRule('h', (r[1] + r[3]) / 2, r[0], r[2], h, color, null, seq, clip);
      else addRule('v', (r[0] + r[2]) / 2, r[1], r[3], w, color, null, seq, clip);
      return;
    }
    const c = clip || pageBox;
    const x0 = Math.max(r[0], c[0]);
    const y0 = Math.max(r[1], c[1]);
    const x1 = Math.min(r[2], c[2]);
    const y1 = Math.min(r[3], c[3]);
    if (x1 - x0 > 0.5 && y1 - y0 > 0.5) fills.push({ x0, y0, x1, y1, color, seq });
  };

  for (const p of paths) {
    // A gradient needs a shape.
    const polys = p.grad ? null : polylines(p.d);
    if (!polys || !polys.length) {
      shapes.push(p);
      continue;
    }
    const rects = polys.map((pl) => axisRect(pl));
    const allRects = rects.every(Boolean);
    let handled = false;
    if (p.fill && !p.stroke) {
      if (allRects) {
        for (const r of rects) {
          if (isWhite(p.fill)) {
            // White rectangles only matter as cell backgrounds.
            const w = r[2] - r[0];
            const h = r[3] - r[1];
            if (!isThin(w, h)) fills.push({ x0: r[0], y0: r[1], x1: r[2], y1: r[3], color: p.fill, seq: p.seq, white: true });
          } else addRectAsRuleOrFill(r, p.fill, p.seq, p.clip);
        }
        handled = true;
      }
    } else if (p.stroke) {
      // Straight strokes: every segment must be axis aligned.
      const segs = [];
      let ok = true;
      for (const pl of polys) {
        const n = pl.pts.length;
        const last = pl.closed ? n : n - 1;
        for (let i = 0; i < last; i++) {
          const a = pl.pts[i];
          const b = pl.pts[(i + 1) % n];
          const dx = Math.abs(a[0] - b[0]);
          const dy = Math.abs(a[1] - b[1]);
          if (dx < 0.01 && dy < 0.01) continue;
          if (dy <= 0.35 && dx > dy * 20) segs.push(['h', (a[1] + b[1]) / 2, Math.min(a[0], b[0]), Math.max(a[0], b[0])]);
          else if (dx <= 0.35 && dy > dx * 20) segs.push(['v', (a[0] + b[0]) / 2, Math.min(a[1], b[1]), Math.max(a[1], b[1])]);
          else {
            ok = false;
            break;
          }
        }
        if (!ok) break;
      }
      if (ok && segs.length && (!p.fill || allRects)) {
        if (p.fill && !isWhite(p.fill)) for (const r of rects) addRectAsRuleOrFill(r, p.fill, p.seq, p.clip);
        if (!isWhite(p.stroke)) {
          for (const [o, pos, a, b] of segs) addRule(o, pos, a, b, p.lw, p.stroke, p.dash, p.seq, p.clip);
        }
        handled = true;
      }
    }
    if (!handled) shapes.push(p);
  }
  return { rules, fills, shapes };
}

function clusterValues(values, tol) {
  const sorted = [...values].sort((a, b) => a.v - b.v);
  const clusters = [];
  for (const it of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && it.v - last.max <= tol && it.v - last.min <= tol * 2.5) {
      last.items.push(it);
      last.max = it.v;
    } else clusters.push({ items: [it], min: it.v, max: it.v });
  }
  for (const c of clusters) {
    let sw = 0;
    let sv = 0;
    for (const it of c.items) {
      const w = Math.max(0.5, it.w || 1);
      sw += w;
      sv += it.v * w;
    }
    c.center = sv / sw;
  }
  return clusters;
}

// Merges collinear rules of one orientation into maximal segments.
function mergeRules(rules) {
  const clusters = clusterValues(
    rules.map((r) => ({ v: r.pos, w: r.b - r.a, r })),
    SNAP,
  );
  const out = [];
  for (const c of clusters) {
    const items = c.items.map((it) => it.r).sort((p, q) => p.a - q.a);
    let cur = null;
    for (const r of items) {
      if (cur && r.a <= cur.b + JOIN) {
        if (r.b > cur.b) cur.b = r.b;
        if (r.b - r.a > cur.longest) {
          cur.longest = r.b - r.a;
          cur.color = r.color;
          cur.dash = r.dash;
          cur.t = r.t;
        }
        cur.seq = Math.max(cur.seq, r.seq);
        cur.parts.push(r);
      } else {
        cur = { o: r.o, pos: c.center, a: r.a, b: r.b, t: r.t, color: r.color, dash: r.dash, seq: r.seq, longest: r.b - r.a, parts: [r] };
        out.push(cur);
      }
    }
  }
  return out.filter((s) => s.b - s.a >= 3.5);
}

class UnionFind {
  constructor(n) {
    this.p = Array.from({ length: n }, (_, i) => i);
  }
  find(i) {
    while (this.p[i] !== i) {
      this.p[i] = this.p[this.p[i]];
      i = this.p[i];
    }
    return i;
  }
  union(a, b) {
    a = this.find(a);
    b = this.find(b);
    if (a !== b) this.p[b] = a;
  }
}

function uniqueSorted(values, tol) {
  return clusterValues(
    values.map((v) => ({ v, w: 1 })),
    tol,
  ).map((c) => c.center);
}

function buildTable(hs, vs, page) {
  // Grid lines: rule positions plus dangling rule ends.
  const xsRaw = vs.map((v) => v.pos);
  const ysRaw = hs.map((h) => h.pos);
  const xs0 = uniqueSorted(xsRaw, SNAP);
  const ys0 = uniqueSorted(ysRaw, SNAP);
  const near = (arr, v, tol) => arr.some((x) => Math.abs(x - v) <= tol);
  const extraX = [];
  const extraY = [];
  for (const h of hs) {
    for (const e of [h.a, h.b]) if (!near(xs0, e, TOUCH) && !near(extraX, e, TOUCH)) extraX.push(e);
  }
  for (const v of vs) {
    for (const e of [v.a, v.b]) if (!near(ys0, e, TOUCH) && !near(extraY, e, TOUCH)) extraY.push(e);
  }
  const xs = uniqueSorted([...xs0, ...extraX], SNAP);
  const ys = uniqueSorted([...ys0, ...extraY], SNAP);
  const m = xs.length - 1;
  const n = ys.length - 1;
  if (m < 1 || n < 1 || m > 400 || n > 600) return null;

  // Rule coverage of every grid edge.
  const vEdge = Array.from({ length: m + 1 }, () => new Array(n).fill(null)); // vertical edge at xs[i] in row j
  const hEdge = Array.from({ length: n + 1 }, () => new Array(m).fill(null)); // horizontal edge at ys[j] in column i
  const cover = (segs, pos, lo, hi) => {
    let len = 0;
    let best = null;
    for (const s of segs) {
      if (Math.abs(s.pos - pos) > SNAP * 1.5) continue;
      const o = Math.min(s.b, hi) - Math.max(s.a, lo);
      if (o > 0) {
        len += o;
        if (!best || o > best.o) best = { o, s };
      }
    }
    return len >= (hi - lo) * 0.72 && best ? best.s : null;
  };
  for (let i = 0; i <= m; i++) for (let j = 0; j < n; j++) vEdge[i][j] = cover(vs, xs[i], ys[j], ys[j + 1]);
  for (let j = 0; j <= n; j++) for (let i = 0; i < m; i++) hEdge[j][i] = cover(hs, ys[j], xs[i], xs[i + 1]);

  // Merge atoms that are not separated by a rule.
  const id = (i, j) => j * m + i;
  const uf = new UnionFind(m * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < m; i++) {
      if (i + 1 < m && !vEdge[i + 1][j]) uf.union(id(i, j), id(i + 1, j));
      if (j + 1 < n && !hEdge[j + 1][i]) uf.union(id(i, j), id(i, j + 1));
    }
  }
  // Split every region into rectangles (row-major greedy).
  const owner = new Array(m * n).fill(-1);
  const cells = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < m; i++) {
      if (owner[id(i, j)] >= 0) continue;
      const region = uf.find(id(i, j));
      let c1 = i;
      while (c1 + 1 < m && owner[id(c1 + 1, j)] < 0 && uf.find(id(c1 + 1, j)) === region && !vEdge[c1 + 1][j]) c1++;
      let r1 = j;
      for (;;) {
        if (r1 + 1 >= n) break;
        let ok = true;
        for (let k = i; k <= c1 && ok; k++) {
          if (owner[id(k, r1 + 1)] >= 0 || uf.find(id(k, r1 + 1)) !== region || hEdge[r1 + 1][k]) ok = false;
        }
        // The rectangle must not be cut by a vertical rule inside the new row.
        for (let k = i + 1; k <= c1 && ok; k++) if (vEdge[k][r1 + 1]) ok = false;
        if (!ok) break;
        r1++;
      }
      const cell = { c0: i, c1, r0: j, r1, index: cells.length };
      for (let jj = j; jj <= r1; jj++) for (let ii = i; ii <= c1; ii++) owner[id(ii, jj)] = cell.index;
      cells.push(cell);
    }
  }
  // Borders: a side has a border when every grid edge along it is ruled.
  const claimedH = hEdge.map((row) => row.map(() => false));
  const claimedV = vEdge.map((col) => col.map(() => false));
  const sideBorder = (edges) => {
    let pick = null;
    for (const e of edges) {
      if (!e) return null;
      if (!pick || e.t > pick.t) pick = e;
    }
    return pick ? { t: pick.t, color: pick.color, dash: pick.dash, seq: pick.seq } : null;
  };
  let closed = 0;
  for (const c of cells) {
    const top = [];
    const bottom = [];
    const left = [];
    const right = [];
    for (let i = c.c0; i <= c.c1; i++) {
      top.push(hEdge[c.r0][i]);
      bottom.push(hEdge[c.r1 + 1][i]);
    }
    for (let j = c.r0; j <= c.r1; j++) {
      left.push(vEdge[c.c0][j]);
      right.push(vEdge[c.c1 + 1][j]);
    }
    c.borders = { top: sideBorder(top), bottom: sideBorder(bottom), left: sideBorder(left), right: sideBorder(right) };
    if (c.borders.top) for (let i = c.c0; i <= c.c1; i++) claimedH[c.r0][i] = true;
    if (c.borders.bottom) for (let i = c.c0; i <= c.c1; i++) claimedH[c.r1 + 1][i] = true;
    if (c.borders.left) for (let j = c.r0; j <= c.r1; j++) claimedV[c.c0][j] = true;
    if (c.borders.right) for (let j = c.r0; j <= c.r1; j++) claimedV[c.c1 + 1][j] = true;
    if (c.borders.top && c.borders.bottom && c.borders.left && c.borders.right) closed++;
    c.x0 = xs[c.c0];
    c.x1 = xs[c.c1 + 1];
    c.y0 = ys[c.r0];
    c.y1 = ys[c.r1 + 1];
    c.fill = null;
  }
  if (!closed) return null;
  // Rule pieces that no cell border represents are drawn as plain lines.
  const extraLines = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i < m; i++) {
      const e = hEdge[j][i];
      if (e && !claimedH[j][i]) extraLines.push({ o: 'h', pos: ys[j], a: xs[i], b: xs[i + 1], t: e.t, color: e.color, dash: e.dash, seq: e.seq });
    }
  }
  for (let i = 0; i <= m; i++) {
    for (let j = 0; j < n; j++) {
      const e = vEdge[i][j];
      if (e && !claimedV[i][j]) extraLines.push({ o: 'v', pos: xs[i], a: ys[j], b: ys[j + 1], t: e.t, color: e.color, dash: e.dash, seq: e.seq });
    }
  }
  // Parts of rules that only cover a fraction of a grid edge.
  for (const s of [...hs, ...vs]) {
    const grid = s.o === 'h' ? xs : ys;
    const lines = s.o === 'h' ? ys : xs;
    const li = lines.findIndex((v) => Math.abs(v - s.pos) <= SNAP * 1.5);
    for (let k = 0; k + 1 < grid.length; k++) {
      const lo = grid[k];
      const hi = grid[k + 1];
      const o = Math.min(s.b, hi) - Math.max(s.a, lo);
      if (o <= 1.5) continue;
      const edge = li < 0 ? null : s.o === 'h' ? hEdge[li][k] : vEdge[li][k];
      if (!edge) extraLines.push({ o: s.o, pos: s.pos, a: Math.max(s.a, lo), b: Math.min(s.b, hi), t: s.t, color: s.color, dash: s.dash, seq: s.seq });
    }
  }
  const thick = (arr) => {
    let t = 0;
    for (const s of arr) t = Math.max(t, s.t);
    return t;
  };
  // Thickness of the rule on each grid line (0 when the line is virtual).
  const hT = ys.map((y) => thick(hs.filter((s) => Math.abs(s.pos - y) <= SNAP * 1.5)));
  const vT = xs.map((x) => thick(vs.filter((s) => Math.abs(s.pos - x) <= SNAP * 1.5)));
  return { xs, ys, hT, vT, cells, owner, cols: m, rows: n, x0: xs[0], x1: xs[m], y0: ys[0], y1: ys[n], extraLines, page: page ? [page.width, page.height] : null };
}

/**
 * Finds tables in the classified rules.
 * Returns { tables, lines } where lines are the rules that belong to no table.
 */
export function detectTables(rules, page) {
  const hs = mergeRules(rules.filter((r) => r.o === 'h'));
  const vs = mergeRules(rules.filter((r) => r.o === 'v'));
  const all = [...hs, ...vs];
  const uf = new UnionFind(all.length);
  for (let i = 0; i < hs.length; i++) {
    const h = hs[i];
    for (let k = 0; k < vs.length; k++) {
      const v = vs[k];
      if (v.pos >= h.a - TOUCH && v.pos <= h.b + TOUCH && h.pos >= v.a - TOUCH && h.pos <= v.b + TOUCH) uf.union(i, hs.length + k);
    }
  }
  const groups = new Map();
  all.forEach((s, i) => {
    const g = uf.find(i);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  });
  const tables = [];
  const lines = [];
  for (const segs of groups.values()) {
    const gh = segs.filter((s) => s.o === 'h');
    const gv = segs.filter((s) => s.o === 'v');
    let table = null;
    if (gh.length >= 2 && gv.length >= 2) table = buildTable(gh, gv, page);
    if (table && table.cells.length === 1 && page) {
      // A single frame around most of the page is a page border, not a table.
      const area = (table.x1 - table.x0) * (table.y1 - table.y0);
      if (area > page.width * page.height * 0.45) table = null;
    }
    if (table) {
      tables.push(table);
      lines.push(...table.extraLines);
    } else lines.push(...segs.map((s) => ({ o: s.o, pos: s.pos, a: s.a, b: s.b, t: s.t, color: s.color, dash: s.dash, seq: s.seq })));
  }
  tables.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  return { tables, lines };
}

// Assigns filled rectangles to the table cells they shade. Returns the fills
// that do not shade a cell.
export function applyCellFills(tables, fills) {
  const rest = [];
  for (const f of fills) {
    let used = false;
    const fa = (f.x1 - f.x0) * (f.y1 - f.y0);
    for (const t of tables) {
      if (f.x1 < t.x0 - 1 || f.x0 > t.x1 + 1 || f.y1 < t.y0 - 1 || f.y0 > t.y1 + 1) continue;
      let covered = 0;
      const hit = [];
      for (const c of t.cells) {
        const w = Math.min(f.x1, c.x1) - Math.max(f.x0, c.x0);
        const h = Math.min(f.y1, c.y1) - Math.max(f.y0, c.y0);
        if (w <= 0 || h <= 0) continue;
        const ca = (c.x1 - c.x0) * (c.y1 - c.y0);
        if (w * h >= ca * 0.85) {
          hit.push(c);
          covered += w * h;
        }
      }
      if (hit.length && covered >= fa * 0.8) {
        for (const c of hit) c.fill = f.white ? null : f.color;
        used = true;
        break;
      }
    }
    if (!used && !f.white) rest.push(f);
  }
  return rest;
}
