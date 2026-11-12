// Helpers that produce PDF content operators for objects created in the
// editor (text boxes, images, shapes) and for annotation appearances.
import { formatNumber as fmt } from './content-stream.js';
import { layoutTextBox, frameForRect, localToUser } from './text-layout.js';
import { N, getDict, shallowCloneDict } from './pdf-objects.js';
import { PDFDict } from '@cantoo/pdf-lib';

export { fmt };

export function rgbOp(c, stroke = false) {
  const [r, g, b] = (c || [0, 0, 0]).map((v) => Math.min(1, Math.max(0, Number(v) || 0)));
  return `${fmt(r)} ${fmt(g)} ${fmt(b)} ${stroke ? 'RG' : 'rg'}`;
}

export function matrixStr(m) {
  return m.map((v) => fmt(Math.round(v * 10000) / 10000)).join(' ');
}

/**
 * Allocates resource names. When `target` (a PDFDict resources dictionary)
 * is given, names are added to it directly (it must be a private copy).
 */
export class ResourceCollector {
  constructor(context, target = null) {
    this.context = context;
    this.target = target;
    this.local = { Font: new Map(), XObject: new Map(), ExtGState: new Map() };
    this.byRef = new Map();
    this.counter = 0;
  }
  _sub(cat) {
    if (!this.target) return null;
    let d = getDict(this.context, this.target, cat);
    if (!d) {
      d = this.context.obj({});
      this.target.set(N(cat), d);
    }
    return d;
  }
  add(cat, prefix, value) {
    const cacheKey = `${cat}:${value && value.toString ? value.toString() : this.counter}`;
    if (value && value.objectNumber !== undefined && this.byRef.has(cacheKey)) return this.byRef.get(cacheKey);
    const sub = this._sub(cat);
    let key;
    do {
      key = `${prefix}${++this.counter}`;
    } while ((sub && sub.has(N(key))) || this.local[cat].has(key));
    this.local[cat].set(key, value);
    if (sub) sub.set(N(key), value);
    if (value && value.objectNumber !== undefined) this.byRef.set(cacheKey, key);
    return key;
  }
  font(ref) {
    return this.add('Font', 'PEF', ref);
  }
  xobject(ref) {
    return this.add('XObject', 'PEX', ref);
  }
  extGState(dict) {
    return this.add('ExtGState', 'PEG', dict);
  }
  opacity(fill = 1, stroke = fill, blend = null) {
    if (fill >= 0.999 && stroke >= 0.999 && !blend) return null;
    const d = { Type: 'ExtGState', ca: Math.max(0, Math.min(1, fill)), CA: Math.max(0, Math.min(1, stroke)) };
    if (blend) d.BM = blend;
    return this.extGState(this.context.obj(d));
  }
  toDict() {
    const res = {};
    for (const cat of Object.keys(this.local)) {
      if (!this.local[cat].size) continue;
      const d = this.context.obj({});
      for (const [k, v] of this.local[cat]) d.set(N(k), v);
      res[cat] = d;
    }
    const dict = this.context.obj({});
    for (const [k, v] of Object.entries(res)) dict.set(N(k), v);
    return dict;
  }
}

// Gives the page a private copy of its Resources (copy-on-write).
export function privatePageResources(context, page) {
  if (page.__pePrivateResources) return page.__pePrivateResources;
  const node = page.node;
  let res = node.Resources ? node.Resources() : undefined;
  if (!(res instanceof PDFDict)) res = getDict(context, node, 'Resources');
  const clone = res ? shallowCloneDict(context, res) : context.obj({});
  for (const cat of ['Font', 'XObject', 'ExtGState', 'ColorSpace', 'Pattern', 'Shading', 'Properties']) {
    const sub = getDict(context, clone, cat);
    if (sub) clone.set(N(cat), shallowCloneDict(context, sub));
  }
  node.set(N('Resources'), clone);
  page.__pePrivateResources = clone;
  return clone;
}

const KAPPA = 0.5522847498;

export function rectPathOps(x, y, w, h) {
  return `${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)} re`;
}

export function ellipsePathOps(cx, cy, rx, ry) {
  const ox = rx * KAPPA;
  const oy = ry * KAPPA;
  return [
    `${fmt(cx - rx)} ${fmt(cy)} m`,
    `${fmt(cx - rx)} ${fmt(cy + oy)} ${fmt(cx - ox)} ${fmt(cy + ry)} ${fmt(cx)} ${fmt(cy + ry)} c`,
    `${fmt(cx + ox)} ${fmt(cy + ry)} ${fmt(cx + rx)} ${fmt(cy + oy)} ${fmt(cx + rx)} ${fmt(cy)} c`,
    `${fmt(cx + rx)} ${fmt(cy - oy)} ${fmt(cx + ox)} ${fmt(cy - ry)} ${fmt(cx)} ${fmt(cy - ry)} c`,
    `${fmt(cx - ox)} ${fmt(cy - ry)} ${fmt(cx - rx)} ${fmt(cy - oy)} ${fmt(cx - rx)} ${fmt(cy)} c`,
    'h',
  ].join('\n');
}

export function polylinePathOps(points, close = false) {
  if (!points.length) return '';
  const parts = [`${fmt(points[0][0])} ${fmt(points[0][1])} m`];
  for (let i = 1; i < points.length; i++) parts.push(`${fmt(points[i][0])} ${fmt(points[i][1])} l`);
  if (close) parts.push('h');
  return parts.join('\n');
}

// Smooth freehand path through points using quadratic curves via midpoints.
export function smoothPathOps(points) {
  if (points.length < 3) {
    if (points.length === 1) {
      const [x, y] = points[0];
      return `${fmt(x)} ${fmt(y)} m ${fmt(x + 0.01)} ${fmt(y)} l`;
    }
    return polylinePathOps(points);
  }
  const parts = [`${fmt(points[0][0])} ${fmt(points[0][1])} m`];
  let prev = points[0];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const next = points[i + 1];
    const mid = [(p[0] + next[0]) / 2, (p[1] + next[1]) / 2];
    // Convert quadratic (prev->p->mid) to cubic.
    const c1 = [prev[0] + (2 / 3) * (p[0] - prev[0]), prev[1] + (2 / 3) * (p[1] - prev[1])];
    const c2 = [mid[0] + (2 / 3) * (p[0] - mid[0]), mid[1] + (2 / 3) * (p[1] - mid[1])];
    parts.push(`${fmt(c1[0])} ${fmt(c1[1])} ${fmt(c2[0])} ${fmt(c2[1])} ${fmt(mid[0])} ${fmt(mid[1])} c`);
    prev = mid;
  }
  const last = points[points.length - 1];
  parts.push(`${fmt(last[0])} ${fmt(last[1])} l`);
  return parts.join('\n');
}

export function dashOps(dash, width) {
  if (!dash) return '[] 0 d';
  const d = Math.max(2, width * 3);
  return `[${fmt(d)} ${fmt(d)}] 0 d`;
}

// Arrow head polygon for a line ending at `tip` coming from `from`.
export function arrowHeadPoints(from, tip, width, kind = 'OpenArrow') {
  const dx = tip[0] - from[0];
  const dy = tip[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const size = Math.max(6, width * 4.5);
  const back = [tip[0] - ux * size, tip[1] - uy * size];
  const half = size * 0.5;
  const p1 = [back[0] - uy * half, back[1] + ux * half];
  const p2 = [back[0] + uy * half, back[1] - ux * half];
  return { points: [p1, tip, p2], closed: kind === 'ClosedArrow' };
}

/**
 * Produces operators drawing a text box.
 * obj: { rect, rot, text, size, color, align, lineHeight, wrap, underline, strike, opacity }
 * shaper: from FontRegistry.getShaper
 * embedFace(descriptor) -> Promise<PDFFont>
 */
export async function textBlockOps(obj, shaper, embedFace, collector, { frame = null, padding = 0 } = {}) {
  const f = frame || frameForRect(obj.rect, obj.rot || 0);
  const size = Math.max(1, Number(obj.size) || 12);
  const layout = layoutTextBox({
    text: obj.text || '',
    measure: shaper.measure,
    size,
    boxWidth: f.width,
    wrap: obj.wrap !== false,
    align: obj.align || 'left',
    lineHeight: obj.lineHeight || 1.2,
    ascent: shaper.metrics.ascent,
    descent: shaper.metrics.descent,
    padding,
  });
  const ops = ['q'];
  const gs = collector.opacity(obj.opacity ?? 1);
  if (gs) ops.push(`/${gs} gs`);
  const color = obj.color || [0, 0, 0];
  ops.push(rgbOp(color), rgbOp(color, true));
  ops.push('BT');
  const decorations = [];
  for (const line of layout.lines) {
    if (!line.text) continue;
    let x = line.x;
    for (const run of shaper.runs(line.text)) {
      const pdfFont = await embedFace(run.face.descriptor);
      const key = collector.font(pdfFont.ref);
      const synthBold = run.face.synthBold || shaper.synthBold;
      const synthItalic = run.face.synthItalic || shaper.synthItalic;
      const skew = synthItalic ? 0.21 : 0;
      const p = localToUser(f, x, line.baseline);
      const r = f.right;
      const up = [-f.down[0], -f.down[1]];
      const tm = [r[0], r[1], up[0] + skew * r[0], up[1] + skew * r[1], p[0], p[1]];
      ops.push(`/${key} ${fmt(size)} Tf`);
      if (synthBold) ops.push(`2 Tr ${fmt(size * 0.035)} w`);
      else ops.push('0 Tr');
      ops.push(`${matrixStr(tm)} Tm`);
      ops.push(`${pdfFont.encodeText(run.text).toString()} Tj`);
      x += run.face.metrics.measure(run.text) * size;
    }
    if (obj.underline) decorations.push({ line, offset: -0.12 * size });
    if (obj.strike) decorations.push({ line, offset: 0.28 * size });
  }
  ops.push('ET');
  if (decorations.length) {
    ops.push(`${fmt(Math.max(0.5, size * 0.06))} w 0 J`);
    for (const d of decorations) {
      const a = localToUser(f, d.line.x, d.line.baseline - d.offset);
      const b = localToUser(f, d.line.x + d.line.width, d.line.baseline - d.offset);
      ops.push(`${fmt(a[0])} ${fmt(a[1])} m ${fmt(b[0])} ${fmt(b[1])} l S`);
    }
  }
  ops.push('Q');
  return { ops: ops.join('\n'), layout, frame: f };
}

// Matrix placing an image (unit square) into a rotated box.
export function imageMatrix(rect, rot = 0) {
  const f = frameForRect(rect, rot);
  const w = f.width;
  const h = f.height;
  return [w * f.right[0], w * f.right[1], -h * f.down[0], -h * f.down[1], f.origin[0] + h * f.down[0], f.origin[1] + h * f.down[1]];
}

export function imageOps(imageRef, rect, rot, collector, opacity = 1) {
  const key = collector.xobject(imageRef);
  const gs = collector.opacity(opacity);
  return ['q', gs ? `/${gs} gs` : '', `${matrixStr(imageMatrix(rect, rot))} cm`, `/${key} Do`, 'Q'].filter(Boolean).join('\n');
}

export function boxOps(rect, { fill = null, stroke = null, width = 1, opacity = 1, dash = false } = {}, collector) {
  const [x0, y0, x1, y1] = rect;
  const ops = ['q'];
  const gs = collector ? collector.opacity(opacity) : null;
  if (gs) ops.push(`/${gs} gs`);
  if (fill) ops.push(rgbOp(fill));
  if (stroke) ops.push(rgbOp(stroke, true), `${fmt(width)} w`, dashOps(dash, width));
  const inset = stroke ? width / 2 : 0;
  ops.push(rectPathOps(x0 + inset, y0 + inset, Math.max(0, x1 - x0 - 2 * inset), Math.max(0, y1 - y0 - 2 * inset)));
  ops.push(fill && stroke ? 'B' : fill ? 'f' : stroke ? 'S' : 'n');
  ops.push('Q');
  return ops.join('\n');
}
