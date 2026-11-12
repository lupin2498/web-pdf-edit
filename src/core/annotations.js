// Creation of PDF annotations (comments, markups, shapes, stamps, links,
// redaction marks) with appearance streams so every viewer renders them.
import { PDFHexString, PDFString, PDFName, PDFNumber, PDFArray, PDFDict } from '@cantoo/pdf-lib';
import {
  fmt,
  rgbOp,
  matrixStr,
  ResourceCollector,
  rectPathOps,
  ellipsePathOps,
  polylinePathOps,
  smoothPathOps,
  dashOps,
  arrowHeadPoints,
  textBlockOps,
  imageMatrix,
} from './graphics.js';
import { frameForRect, localToUser } from './text-layout.js';
import { N } from './pdf-objects.js';

export const ANNOTATION_SUBTYPES = {
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'StrikeOut',
  squiggly: 'Squiggly',
  note: 'Text',
  freetext: 'FreeText',
  rect: 'Square',
  ellipse: 'Circle',
  line: 'Line',
  arrow: 'Line',
  polyline: 'PolyLine',
  polygon: 'Polygon',
  ink: 'Ink',
  stamp: 'Stamp',
  signature: 'Stamp',
  link: 'Link',
  redact: 'Redact',
};

export function isAnnotationObject(obj) {
  return Object.prototype.hasOwnProperty.call(ANNOTATION_SUBTYPES, obj.type);
}

export function pdfDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  const tzh = pad(Math.floor(Math.abs(tz) / 60));
  const tzm = pad(Math.abs(tz) % 60);
  return `D:${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${sign}${tzh}'${tzm}'`;
}

export function pdfText(str) {
  const s = String(str ?? '');
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e\n\r\t]*$/.test(s)) return PDFString.of(s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/\r/g, '\\r').replace(/\n/g, '\\n'));
  return PDFHexString.fromText(s);
}

function expand(rect, d) {
  return [rect[0] - d, rect[1] - d, rect[2] + d, rect[3] + d];
}

function boundsOf(points) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

function quadPointsFor(rect, rot) {
  const f = frameForRect(rect, rot);
  const tl = localToUser(f, 0, 0);
  const tr = localToUser(f, f.width, 0);
  const bl = localToUser(f, 0, f.height);
  const br = localToUser(f, f.width, f.height);
  return [...tl, ...tr, ...bl, ...br];
}

function markupAppearance(obj, collector) {
  const color = obj.color || [1, 0.85, 0];
  const ops = ['q'];
  const rot = obj.rot || 0;
  if (obj.type === 'highlight') {
    const gs = collector.opacity(obj.opacity ?? 1, obj.opacity ?? 1, 'Multiply');
    if (gs) ops.push(`/${gs} gs`);
    ops.push(rgbOp(color));
    for (const r of obj.rects) {
      const f = frameForRect(r, rot);
      const pts = [localToUser(f, 0, 0), localToUser(f, f.width, 0), localToUser(f, f.width, f.height), localToUser(f, 0, f.height)];
      ops.push(polylinePathOps(pts, true), 'f');
    }
  } else {
    const gs = collector.opacity(obj.opacity ?? 1);
    if (gs) ops.push(`/${gs} gs`);
    ops.push(rgbOp(color, true), '0 J');
    for (const r of obj.rects) {
      const f = frameForRect(r, rot);
      const h = f.height;
      const lw = Math.max(0.6, h * 0.07);
      ops.push(`${fmt(lw)} w`);
      if (obj.type === 'underline' || obj.type === 'strikeout') {
        const v = obj.type === 'underline' ? h - h * 0.1 : h * 0.55;
        const a = localToUser(f, 0, v);
        const b = localToUser(f, f.width, v);
        ops.push(`${fmt(a[0])} ${fmt(a[1])} m ${fmt(b[0])} ${fmt(b[1])} l S`);
      } else {
        // Squiggly
        const amp = Math.max(1, h * 0.06);
        const step = Math.max(2, h * 0.12);
        const base = h - amp * 1.5;
        const pts = [];
        let up = false;
        for (let u = 0; u <= f.width + 0.01; u += step) {
          pts.push(localToUser(f, Math.min(u, f.width), base + (up ? -amp : amp)));
          up = !up;
        }
        ops.push(polylinePathOps(pts), 'S');
      }
    }
  }
  ops.push('Q');
  return ops.join('\n');
}

function noteIconAppearance(obj) {
  const rect = obj.rect;
  const f = frameForRect(rect, obj.rot || 0);
  const w = f.width;
  const h = f.height;
  const c = obj.color || [1, 0.85, 0.2];
  const P = (u, v) => localToUser(f, u, v);
  const bubble = [P(1, 1), P(w - 1, 1), P(w - 1, h * 0.72), P(w * 0.45, h * 0.72), P(w * 0.25, h - 1), P(w * 0.28, h * 0.72), P(1, h * 0.72)];
  const ops = ['q', rgbOp(c), '0.25 0.25 0.25 RG 0.8 w 1 j', polylinePathOps(bubble, true), 'B', '0.25 0.25 0.25 RG 0.9 w'];
  for (const v of [0.22, 0.38, 0.54]) {
    const a = P(w * 0.18, h * v);
    const b = P(w * 0.82, h * v);
    ops.push(`${fmt(a[0])} ${fmt(a[1])} m ${fmt(b[0])} ${fmt(b[1])} l S`);
  }
  ops.push('Q');
  return ops.join('\n');
}

function shapeAppearance(obj, collector) {
  const width = obj.width ?? 2;
  const ops = ['q'];
  const gs = collector.opacity(obj.opacity ?? 1);
  if (gs) ops.push(`/${gs} gs`);
  ops.push(`${fmt(width)} w 1 j 1 J`, dashOps(obj.dash, width));
  if (obj.stroke) ops.push(rgbOp(obj.stroke, true));
  if (obj.fill) ops.push(rgbOp(obj.fill));
  const paint = obj.fill && obj.stroke ? 'B' : obj.fill ? 'f' : 'S';
  if (obj.type === 'rect') {
    const [x0, y0, x1, y1] = obj.rect;
    const i = width / 2;
    ops.push(rectPathOps(x0 + i, y0 + i, Math.max(0, x1 - x0 - width), Math.max(0, y1 - y0 - width)), paint);
  } else if (obj.type === 'ellipse') {
    const [x0, y0, x1, y1] = obj.rect;
    ops.push(ellipsePathOps((x0 + x1) / 2, (y0 + y1) / 2, Math.max(0.5, (x1 - x0 - width) / 2), Math.max(0.5, (y1 - y0 - width) / 2)), paint);
  } else if (obj.type === 'line' || obj.type === 'arrow') {
    const [p1, p2] = [obj.p1, obj.p2];
    ops.push(rgbOp(obj.stroke || [1, 0, 0], true));
    ops.push(`${fmt(p1[0])} ${fmt(p1[1])} m ${fmt(p2[0])} ${fmt(p2[1])} l S`, '[] 0 d');
    const heads = [
      [obj.startHead, p2, p1],
      [obj.endHead || (obj.type === 'arrow' ? 'OpenArrow' : 'None'), p1, p2],
    ];
    for (const [kind, from, tip] of heads) {
      if (!kind || kind === 'None') continue;
      const ah = arrowHeadPoints(from, tip, width, kind);
      if (ah.closed) ops.push(rgbOp(obj.stroke || [1, 0, 0]), polylinePathOps(ah.points, true), 'B');
      else ops.push(polylinePathOps(ah.points), 'S');
    }
  } else if (obj.type === 'polyline' || obj.type === 'polygon') {
    ops.push(polylinePathOps(obj.points, obj.type === 'polygon'), obj.type === 'polygon' ? paint : 'S');
  } else if (obj.type === 'ink') {
    ops.push(rgbOp(obj.stroke || [1, 0, 0], true), '[] 0 d');
    for (const path of obj.paths) ops.push(smoothPathOps(path), 'S');
  }
  ops.push('Q');
  return ops.join('\n');
}

// Label layout of a text stamp in its local frame (y down): a bold label,
// optionally followed by a smaller second line, centered in the box. Shared
// by the on-screen preview and the saved appearance stream.
export function stampLabelLayout(width, height, label, sub, measure) {
  const avail = width * 0.84;
  const mainSize = Math.max(4, Math.min(height * (sub ? 0.4 : 0.55), avail / Math.max(0.1, measure(label))));
  if (!sub) return [{ text: label, size: mainSize, top: (height - mainSize) / 2 }];
  const subSize = Math.max(3, Math.min(mainSize * 0.6, avail / Math.max(0.1, measure(sub))));
  const gap = mainSize * 0.1;
  const top = (height - (mainSize + gap + subSize)) / 2;
  return [
    { text: label, size: mainSize, top },
    { text: sub, size: subSize, top: top + mainSize + gap },
  ];
}

function stampTextAppearance(obj, embedded, collector) {
  // Rounded border with centered label; `embedded` = { key, font, size, layoutWidth }
  const f = frameForRect(obj.rect, obj.rot || 0);
  const c = obj.color || [0.8, 0.1, 0.1];
  const w = f.width;
  const h = f.height;
  const bw = Math.max(1, Math.min(w, h) * 0.06);
  const r = Math.min(w, h) * 0.18;
  const P = (u, v) => localToUser(f, u, v);
  const ops = ['q'];
  const gs = collector.opacity(obj.opacity ?? 1);
  if (gs) ops.push(`/${gs} gs`);
  ops.push(rgbOp(c, true), rgbOp(c), `${fmt(bw)} w`);
  const i = bw / 2;
  // Rounded rectangle approximated with straight segments + curves.
  const pts = [
    [i + r, i],
    [w - i - r, i],
    [w - i, i + r],
    [w - i, h - i - r],
    [w - i - r, h - i],
    [i + r, h - i],
    [i, h - i - r],
    [i, i + r],
  ].map(([u, v]) => P(u, v));
  const corner = (a, ctrl, b) => `${fmt(ctrl[0])} ${fmt(ctrl[1])} ${fmt(ctrl[0])} ${fmt(ctrl[1])} ${fmt(b[0])} ${fmt(b[1])} c`;
  ops.push(`${fmt(pts[0][0])} ${fmt(pts[0][1])} m`);
  ops.push(`${fmt(pts[1][0])} ${fmt(pts[1][1])} l`);
  ops.push(corner(pts[1], P(w - i, i), pts[2]));
  ops.push(`${fmt(pts[3][0])} ${fmt(pts[3][1])} l`);
  ops.push(corner(pts[3], P(w - i, h - i), pts[4]));
  ops.push(`${fmt(pts[5][0])} ${fmt(pts[5][1])} l`);
  ops.push(corner(pts[5], P(i, h - i), pts[6]));
  ops.push(`${fmt(pts[7][0])} ${fmt(pts[7][1])} l`);
  ops.push(corner(pts[7], P(i, i), pts[0]));
  ops.push('h S');
  ops.push('Q');
  return ops.join('\n');
}

/**
 * Creates an annotation for `obj` on `page`.
 * ctx = { doc, registry, embedFace(descriptor), embedImage(assetId) -> PDFImage, author, pageRefFor(uid) }
 * Returns the annotation ref (or null when the object cannot be represented).
 */
export async function createAnnotation(ctx, page, obj) {
  const { doc } = ctx;
  const context = doc.context;
  const subtype = ANNOTATION_SUBTYPES[obj.type];
  if (!subtype) return null;
  const now = pdfDate(obj.modified ? new Date(obj.modified) : new Date());
  const dict = {
    Type: 'Annot',
    Subtype: subtype,
    F: obj.type === 'link' ? 0 : 4,
    NM: pdfText(obj.id || `pe-${Date.now()}`),
    M: PDFString.of(now),
  };
  if (obj.type !== 'link') {
    dict.T = pdfText(obj.author || ctx.author || '');
    dict.CreationDate = PDFString.of(obj.created ? pdfDate(new Date(obj.created)) : now);
  }
  if (obj.contents) dict.Contents = pdfText(obj.contents);
  if (obj.subject) dict.Subj = pdfText(obj.subject);
  if (page.ref) dict.P = page.ref;

  const collector = new ResourceCollector(context);
  let rect;
  let apOps = '';
  const color = obj.color || obj.stroke || null;

  switch (obj.type) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
    case 'squiggly': {
      if (!obj.rects || !obj.rects.length) return null;
      rect = obj.rects.reduce((acc, r) => [Math.min(acc[0], r[0]), Math.min(acc[1], r[1]), Math.max(acc[2], r[2]), Math.max(acc[3], r[3])], [Infinity, Infinity, -Infinity, -Infinity]);
      rect = expand(rect, 1);
      dict.QuadPoints = obj.rects.flatMap((r) => quadPointsFor(r, obj.rot || 0));
      dict.C = (obj.color || [1, 0.85, 0]).slice(0, 3);
      dict.CA = obj.opacity ?? 1;
      apOps = markupAppearance(obj, collector);
      break;
    }
    case 'note': {
      rect = obj.rect;
      dict.C = (obj.color || [1, 0.85, 0.2]).slice(0, 3);
      dict.Name = obj.icon || 'Comment';
      dict.Open = false;
      apOps = noteIconAppearance(obj);
      break;
    }
    case 'freetext': {
      rect = obj.rect;
      const size = obj.size || 12;
      const textColor = obj.color || [0, 0, 0];
      dict.DA = PDFString.of(`/Helv ${fmt(size)} Tf ${textColor.map(fmt).join(' ')} rg`);
      dict.Contents = pdfText(obj.text || '');
      if (obj.border) dict.C = obj.border.slice(0, 3);
      if (obj.fill) dict.IC = obj.fill.slice(0, 3);
      dict.BS = context.obj({ W: obj.border ? obj.borderWidth ?? 1 : 0 });
      if (obj.rot) dict.Rotate = obj.rot;
      const shaper = await ctx.registry.getShaper(obj.font?.family, obj.font?.bold, obj.font?.italic, obj.text || '');
      const parts = ['q'];
      const gs = collector.opacity(obj.opacity ?? 1);
      if (gs) parts.push(`/${gs} gs`);
      if (obj.fill || obj.border) {
        const bw = obj.border ? obj.borderWidth ?? 1 : 0;
        const [x0, y0, x1, y1] = rect;
        if (obj.fill) parts.push(rgbOp(obj.fill));
        if (obj.border) parts.push(rgbOp(obj.border, true), `${fmt(bw)} w`);
        parts.push(rectPathOps(x0 + bw / 2, y0 + bw / 2, x1 - x0 - bw, y1 - y0 - bw), obj.fill && obj.border ? 'B' : obj.fill ? 'f' : 'S');
      }
      const inner = await textBlockOps({ ...obj, opacity: 1, color: textColor }, shaper, ctx.embedFace, collector, { padding: obj.padding ?? 4 });
      parts.push(inner.ops, 'Q');
      apOps = parts.join('\n');
      break;
    }
    case 'rect':
    case 'ellipse': {
      rect = obj.rect;
      dict.C = (obj.stroke || [1, 0, 0]).slice(0, 3);
      if (!obj.stroke) dict.C = [];
      if (obj.fill) dict.IC = obj.fill.slice(0, 3);
      dict.BS = context.obj({ W: obj.width ?? 2, S: obj.dash ? 'D' : 'S', ...(obj.dash ? { D: [3, 3] } : {}) });
      dict.CA = obj.opacity ?? 1;
      apOps = shapeAppearance(obj, collector);
      break;
    }
    case 'line':
    case 'arrow': {
      const w = obj.width ?? 2;
      rect = expand(boundsOf([obj.p1, obj.p2]), Math.max(w, 6) * 1.5);
      dict.L = [...obj.p1, ...obj.p2];
      dict.LE = [obj.startHead || 'None', obj.endHead || (obj.type === 'arrow' ? 'OpenArrow' : 'None')];
      dict.C = (obj.stroke || [1, 0, 0]).slice(0, 3);
      dict.BS = context.obj({ W: w, S: obj.dash ? 'D' : 'S' });
      dict.CA = obj.opacity ?? 1;
      apOps = shapeAppearance(obj, collector);
      break;
    }
    case 'polyline':
    case 'polygon': {
      if (!obj.points || obj.points.length < 2) return null;
      const w = obj.width ?? 2;
      rect = expand(boundsOf(obj.points), w * 2);
      dict.Vertices = obj.points.flat();
      dict.C = (obj.stroke || [1, 0, 0]).slice(0, 3);
      if (obj.fill && obj.type === 'polygon') dict.IC = obj.fill.slice(0, 3);
      dict.BS = context.obj({ W: w, S: obj.dash ? 'D' : 'S' });
      dict.CA = obj.opacity ?? 1;
      apOps = shapeAppearance(obj, collector);
      break;
    }
    case 'ink': {
      const pts = obj.paths.flat();
      if (!pts.length) return null;
      const w = obj.width ?? 2;
      rect = expand(boundsOf(pts), w * 2);
      dict.InkList = obj.paths.map((p) => p.flat());
      dict.C = (obj.stroke || [1, 0, 0]).slice(0, 3);
      dict.BS = context.obj({ W: w, S: 'S' });
      dict.CA = obj.opacity ?? 1;
      apOps = shapeAppearance(obj, collector);
      break;
    }
    case 'stamp':
    case 'signature': {
      rect = obj.rect;
      dict.Name = obj.type === 'signature' ? 'Signature' : obj.stampName || 'Draft';
      if (obj.asset) {
        const image = await ctx.embedImage(obj.asset);
        const key = collector.xobject(image.ref);
        const gs = collector.opacity(obj.opacity ?? 1);
        apOps = ['q', gs ? `/${gs} gs` : '', `${matrixStr(imageMatrix(rect, obj.rot || 0))} cm`, `/${key} Do`, 'Q'].filter(Boolean).join('\n');
      } else {
        const label = obj.label || 'APPROVED';
        const sub = obj.subLabel || '';
        const shaper = await ctx.registry.getShaper(obj.font?.family || 'Liberation Sans', true, false, label + sub);
        const f = frameForRect(rect, obj.rot || 0);
        const parts = [stampTextAppearance(obj, null, collector)];
        for (const line of stampLabelLayout(f.width, f.height, label, sub, shaper.measure)) {
          const textObj = { rect, rot: obj.rot || 0, text: line.text, size: line.size, color: obj.color || [0.8, 0.1, 0.1], align: 'center', lineHeight: 1, opacity: obj.opacity ?? 1, wrap: true };
          const frame = { ...f, origin: localToUser(f, 0, line.top), height: line.size };
          parts.push((await textBlockOps(textObj, shaper, ctx.embedFace, collector, { frame })).ops);
        }
        apOps = parts.join('\n');
      }
      break;
    }
    case 'link': {
      rect = obj.rect;
      dict.Border = [0, 0, 0];
      if (obj.action?.type === 'url' && obj.action.url) {
        dict.A = context.obj({ Type: 'Action', S: 'URI', URI: PDFString.of(obj.action.url) });
      } else if (obj.action?.type === 'page' && ctx.pageRefFor) {
        const target = ctx.pageRefFor(obj.action.pageUid);
        if (!target) return null;
        dict.Dest = [target, 'Fit'];
      } else {
        return null;
      }
      apOps = '';
      break;
    }
    case 'redact': {
      rect = obj.rect;
      dict.QuadPoints = quadPointsFor(rect, 0);
      dict.IC = (obj.fill || [0, 0, 0]).slice(0, 3);
      dict.C = [1, 0, 0];
      if (obj.overlayText) dict.OverlayText = pdfText(obj.overlayText);
      apOps = ['q', '1 0 0 RG 1 w', rectPathOps(rect[0] + 0.5, rect[1] + 0.5, rect[2] - rect[0] - 1, rect[3] - rect[1] - 1), 'S', 'Q'].join('\n');
      break;
    }
    default:
      return null;
  }

  rect = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
  dict.Rect = rect;
  if (color && !dict.C && obj.type !== 'link') dict.C = color.slice(0, 3);
  const annot = context.obj(dict);
  if (apOps) {
    const ap = context.flateStream(apOps, {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: rect,
      Resources: collector.toDict(),
    });
    const apRef = context.register(ap);
    annot.set(N('AP'), context.obj({ N: apRef }));
  }
  if (obj.type !== 'link' && obj.type !== 'stamp' && obj.type !== 'signature') {
    try {
      const data = { ...obj };
      delete data.asset;
      annot.set(N('PDFEditData'), PDFHexString.fromText(JSON.stringify(data)));
    } catch {
      /* ignore */
    }
  }
  const ref = context.register(annot);
  return ref;
}

export function addAnnotationToPage(doc, page, ref) {
  const context = doc.context;
  const node = page.node;
  let annots = node.get(N('Annots'));
  let arr = annots ? context.lookup(annots) : null;
  if (!(arr instanceof PDFArray)) {
    arr = context.obj([]);
    node.set(N('Annots'), arr);
  } else if (!page.__pePrivateAnnots) {
    // Copy the array so it is not shared with other pages.
    const copy = context.obj([]);
    for (let i = 0; i < arr.size(); i++) copy.push(arr.get(i));
    node.set(N('Annots'), copy);
    arr = copy;
  }
  page.__pePrivateAnnots = true;
  arr.push(ref);
}

export { PDFName, PDFNumber, PDFDict };
