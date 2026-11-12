// Content stream interpreter: tracks graphics/text state and reports the
// placement of text glyphs, images, form XObjects and vector paths in user
// space. The result is used for text editing, redaction and image editing.
import { parseContentStream, PdfName, PdfString, PdfDictValue } from './content-stream.js';
import { multiply, applyPoint, IDENTITY, boundsOfPoints } from './matrix.js';
import { FontInfoCache, defaultFontInfo } from './font-info.js';
import { N, get, getDict, getArray, resolve, streamContents, nameOf, numberOf, refOf } from './pdf-objects.js';
import { PDFStream, PDFArray, PDFDict, PDFName as PDFLibName, PDFRef } from '@cantoo/pdf-lib';

const MAX_FORM_DEPTH = 12;

function cloneState(s) {
  return {
    ctm: s.ctm,
    fillSpace: s.fillSpace,
    fill: s.fill,
    strokeSpace: s.strokeSpace,
    stroke: s.stroke,
    fontRef: s.fontRef,
    fontName: s.fontName,
    fontInfo: s.fontInfo,
    fontSize: s.fontSize,
    tc: s.tc,
    tw: s.tw,
    th: s.th,
    tl: s.tl,
    rise: s.rise,
    render: s.render,
    fillAlpha: s.fillAlpha,
  };
}

function colorSpaceComponents(context, resources, name) {
  if (name === 'DeviceGray' || name === 'CalGray' || name === 'G') return { space: 'gray', n: 1 };
  if (name === 'DeviceRGB' || name === 'CalRGB' || name === 'RGB') return { space: 'rgb', n: 3 };
  if (name === 'DeviceCMYK' || name === 'CMYK') return { space: 'cmyk', n: 4 };
  if (name === 'Pattern') return { space: 'pattern', n: 0 };
  const csDict = resources ? getDict(context, resources, 'ColorSpace') : undefined;
  const cs = csDict ? get(context, csDict, name) : undefined;
  if (cs instanceof PDFArray) {
    const kind = nameOf(resolve(context, cs.get(0)));
    if (kind === 'ICCBased') {
      const s = resolve(context, cs.get(1));
      const n = s instanceof PDFStream ? numberOf(context, s.dict.get(N('N')), 3) : 3;
      return { space: n === 1 ? 'gray' : n === 4 ? 'cmyk' : 'rgb', n };
    }
    if (kind === 'CalRGB' || kind === 'Lab') return { space: 'rgb', n: 3 };
    if (kind === 'CalGray') return { space: 'gray', n: 1 };
    if (kind === 'Indexed') return { space: 'indexed', n: 1 };
    if (kind === 'Separation') return { space: 'separation', n: 1 };
    if (kind === 'DeviceN') return { space: 'devicen', n: 1 };
  } else if (cs instanceof PDFLibName) {
    return colorSpaceComponents(context, null, nameOf(cs));
  }
  return { space: 'other', n: 1 };
}

export function colorToRgb(space, comps) {
  const c = comps || [];
  switch (space) {
    case 'gray':
      return [c[0] ?? 0, c[0] ?? 0, c[0] ?? 0];
    case 'rgb':
      return [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0];
    case 'cmyk': {
      const k = c[3] ?? 1;
      return [(1 - (c[0] ?? 0)) * (1 - k), (1 - (c[1] ?? 0)) * (1 - k), (1 - (c[2] ?? 0)) * (1 - k)];
    }
    case 'separation':
      // Tint 1 = full ink; approximate as dark.
      return [1 - (c[0] ?? 1), 1 - (c[0] ?? 1), 1 - (c[0] ?? 1)];
    default:
      return [0, 0, 0];
  }
}

/**
 * Interprets a content stream.
 * @returns ContentModel {
 *   bytes, ops, resources,
 *   textRuns: [{opIndex, op, elements, glyphs, font, ...}],
 *   images: [{opIndex, name, ref, inline, ctm, quad, bbox}],
 *   forms: [{opIndex, name, ref, matrix, ctm, model}],
 *   paths: [{startOp, endOp, bbox, segments}],  segments: straight [x0, y0, x1, y1]
 * }
 */
export function interpretContent(opts) {
  const {
    context,
    bytes,
    resources,
    fontCache = new FontInfoCache(context),
    baseCtm = IDENTITY,
    initialState = null,
    depth = 0,
    formStack = [],
    collectPaths = true,
  } = opts;

  const ops = parseContentStream(bytes);
  const model = { bytes, ops, resources, textRuns: [], images: [], forms: [], paths: [], marked: [] };

  let gs = initialState
    ? { ...cloneState(initialState), ctm: baseCtm }
    : {
        ctm: baseCtm,
        fillSpace: 'gray',
        fill: [0],
        strokeSpace: 'gray',
        stroke: [0],
        fontRef: null,
        fontName: null,
        fontInfo: null,
        fontSize: 0,
        tc: 0,
        tw: 0,
        th: 1,
        tl: 0,
        rise: 0,
        render: 0,
        fillAlpha: 1,
      };
  const stack = [];
  let tm = IDENTITY;
  let tlm = IDENTITY;
  const mcStack = [];
  let pathPoints = [];
  let pathStartOp = -1;
  // Straight segments of the current path (user space), e.g. table rules.
  let pathSegments = [];
  let lastPoint = null;
  let subpathStart = null;

  const fontDict = resources ? getDict(context, resources, 'Font') : undefined;
  const xobjDict = resources ? getDict(context, resources, 'XObject') : undefined;
  const extGStateDict = resources ? getDict(context, resources, 'ExtGState') : undefined;

  const setFont = (name, size) => {
    gs.fontName = name;
    gs.fontSize = size;
    const ref = fontDict ? fontDict.get(N(name)) : undefined;
    gs.fontRef = ref || null;
    gs.fontInfo = ref ? fontCache.get(ref) : defaultFontInfo();
  };

  const currentMc = () => (mcStack.length ? mcStack.map((m) => m) : null);

  const showText = (elements, opIndex, opName) => {
    const fi = gs.fontInfo || defaultFontInfo();
    const fs = gs.fontSize;
    const th = gs.th;
    const glyphs = [];
    const run = {
      opIndex,
      op: opName,
      elements,
      glyphs,
      font: fi,
      fontName: gs.fontName,
      fontRef: gs.fontRef,
      fontSize: fs,
      tc: gs.tc,
      tw: gs.tw,
      th,
      rise: gs.rise,
      render: gs.render,
      fillSpace: gs.fillSpace,
      fill: gs.fill,
      fillRgb: colorToRgb(gs.fillSpace, gs.fill),
      strokeRgb: colorToRgb(gs.strokeSpace, gs.stroke),
      fillAlpha: gs.fillAlpha,
      ctm: gs.ctm,
      tmStart: tm,
      mc: currentMc(),
      vertical: !!fi.vertical,
    };
    const asc = fi.ascent;
    const desc = fi.descent;
    for (let ei = 0; ei < elements.length; ei++) {
      const el = elements[ei];
      if (typeof el === 'number') {
        if (fi.vertical) tm = multiply([1, 0, 0, 1, 0, -(el / 1000) * fs], tm);
        else tm = multiply([1, 0, 0, 1, -(el / 1000) * fs * th, 0], tm);
        continue;
      }
      if (!(el instanceof PdfString)) continue;
      const b = el.bytes;
      let pos = 0;
      while (pos < b.length) {
        const [code, len] = fi.readCode(b, pos);
        const w0 = fi.width(code);
        const isSpace = fi.isSpace(code, len);
        const trm = multiply(multiply([fs * th, 0, 0, fs, 0, gs.rise], tm), gs.ctm);
        let corners;
        let adv;
        if (fi.vertical) {
          corners = [
            applyPoint(trm, -w0 / 2, -1),
            applyPoint(trm, w0 / 2, -1),
            applyPoint(trm, w0 / 2, 0),
            applyPoint(trm, -w0 / 2, 0),
          ];
          adv = -fs + gs.tc + (isSpace ? gs.tw : 0);
        } else {
          corners = [
            applyPoint(trm, 0, desc),
            applyPoint(trm, w0, desc),
            applyPoint(trm, w0, asc),
            applyPoint(trm, 0, asc),
          ];
          adv = (w0 * fs + gs.tc + (isSpace ? gs.tw : 0)) * th;
        }
        const center = fi.vertical ? applyPoint(trm, 0, -0.5) : applyPoint(trm, w0 / 2, (asc + desc) / 2);
        glyphs.push({
          ei,
          pos,
          len,
          code,
          w0,
          adv,
          isSpace,
          cx: center[0],
          cy: center[1],
          bbox: boundsOfPoints(corners),
          corners,
        });
        if (fi.vertical) tm = multiply([1, 0, 0, 1, 0, adv], tm);
        else tm = multiply([1, 0, 0, 1, adv, 0], tm);
        pos += len;
      }
    }
    if (glyphs.length) {
      let bb = null;
      for (const g of glyphs) {
        bb = bb
          ? [Math.min(bb[0], g.bbox[0]), Math.min(bb[1], g.bbox[1]), Math.max(bb[2], g.bbox[2]), Math.max(bb[3], g.bbox[3])]
          : g.bbox.slice();
      }
      run.bbox = bb;
    } else {
      run.bbox = null;
    }
    run.tmEnd = tm;
    model.textRuns.push(run);
  };

  const recordPath = (opIndex, kind) => {
    if (collectPaths && pathPoints.length) {
      model.paths.push({
        startOp: pathStartOp,
        endOp: opIndex,
        bbox: boundsOfPoints(pathPoints),
        segments: pathSegments,
        kind,
        ctm: gs.ctm,
        mc: currentMc(),
      });
    }
    pathPoints = [];
    pathStartOp = -1;
    pathSegments = [];
    lastPoint = null;
    subpathStart = null;
  };

  const addPathPoint = (opIndex, x, y) => {
    if (pathStartOp < 0) pathStartOp = opIndex;
    const p = applyPoint(gs.ctm, x, y);
    pathPoints.push(p);
    return p;
  };
  const addSegment = (a, b) => {
    if (collectPaths && a && b && pathSegments.length < 2000) pathSegments.push([a[0], a[1], b[0], b[1]]);
  };

  for (let i = 0; i < ops.length; i++) {
    const { op, args } = ops[i];
    const num = (k, d = 0) => (typeof args[k] === 'number' ? args[k] : d);
    switch (op) {
      case 'q':
        stack.push(cloneState(gs));
        break;
      case 'Q':
        if (stack.length) gs = stack.pop();
        break;
      case 'cm':
        if (args.length >= 6) gs.ctm = multiply([num(0), num(1), num(2), num(3), num(4), num(5)], gs.ctm);
        break;
      case 'gs': {
        const n = args[0] instanceof PdfName ? args[0].name : null;
        const egs = n && extGStateDict ? getDict(context, extGStateDict, n) : undefined;
        if (egs) {
          const fontArr = get(context, egs, 'Font');
          if (fontArr instanceof PDFArray && fontArr.size() >= 2) {
            const ref = fontArr.get(0);
            gs.fontRef = ref;
            gs.fontName = null;
            gs.fontInfo = fontCache.get(ref);
            gs.fontSize = numberOf(context, fontArr.get(1), gs.fontSize);
          }
          const ca = get(context, egs, 'ca');
          if (ca && typeof ca.asNumber === 'function') gs.fillAlpha = ca.asNumber();
        }
        break;
      }
      case 'g':
        gs.fillSpace = 'gray';
        gs.fill = [num(0)];
        break;
      case 'G':
        gs.strokeSpace = 'gray';
        gs.stroke = [num(0)];
        break;
      case 'rg':
        gs.fillSpace = 'rgb';
        gs.fill = [num(0), num(1), num(2)];
        break;
      case 'RG':
        gs.strokeSpace = 'rgb';
        gs.stroke = [num(0), num(1), num(2)];
        break;
      case 'k':
        gs.fillSpace = 'cmyk';
        gs.fill = [num(0), num(1), num(2), num(3)];
        break;
      case 'K':
        gs.strokeSpace = 'cmyk';
        gs.stroke = [num(0), num(1), num(2), num(3)];
        break;
      case 'cs':
      case 'CS': {
        const n = args[0] instanceof PdfName ? args[0].name : 'DeviceGray';
        const info = colorSpaceComponents(context, resources, n);
        const init = info.space === 'cmyk' ? [0, 0, 0, 1] : info.space === 'rgb' ? [0, 0, 0] : [info.space === 'separation' ? 1 : 0];
        if (op === 'cs') {
          gs.fillSpace = info.space;
          gs.fill = init;
        } else {
          gs.strokeSpace = info.space;
          gs.stroke = init;
        }
        break;
      }
      case 'sc':
      case 'scn':
      case 'SC':
      case 'SCN': {
        const comps = args.filter((a) => typeof a === 'number');
        if (op === 'sc' || op === 'scn') {
          if (comps.length) {
            gs.fill = comps;
            if (gs.fillSpace === 'other' || gs.fillSpace === 'pattern') {
              gs.fillSpace = comps.length === 4 ? 'cmyk' : comps.length === 3 ? 'rgb' : 'gray';
            }
          }
        } else if (comps.length) {
          gs.stroke = comps;
        }
        break;
      }
      case 'BT':
        tm = IDENTITY;
        tlm = IDENTITY;
        break;
      case 'ET':
        break;
      case 'Tf':
        setFont(args[0] instanceof PdfName ? args[0].name : '', num(1, 0));
        break;
      case 'Tc':
        gs.tc = num(0);
        break;
      case 'Tw':
        gs.tw = num(0);
        break;
      case 'Tz':
        gs.th = num(0, 100) / 100;
        break;
      case 'TL':
        gs.tl = num(0);
        break;
      case 'Ts':
        gs.rise = num(0);
        break;
      case 'Tr':
        gs.render = num(0);
        break;
      case 'Td':
        tlm = multiply([1, 0, 0, 1, num(0), num(1)], tlm);
        tm = tlm;
        break;
      case 'TD':
        gs.tl = -num(1);
        tlm = multiply([1, 0, 0, 1, num(0), num(1)], tlm);
        tm = tlm;
        break;
      case 'Tm':
        tlm = [num(0, 1), num(1), num(2), num(3, 1), num(4), num(5)];
        tm = tlm;
        break;
      case 'T*':
        tlm = multiply([1, 0, 0, 1, 0, -gs.tl], tlm);
        tm = tlm;
        break;
      case 'Tj':
        showText(args[0] instanceof PdfString ? [args[0]] : [], i, op);
        break;
      case 'TJ':
        showText(Array.isArray(args[0]) ? args[0] : [], i, op);
        break;
      case "'":
        tlm = multiply([1, 0, 0, 1, 0, -gs.tl], tlm);
        tm = tlm;
        showText(args[0] instanceof PdfString ? [args[0]] : [], i, op);
        break;
      case '"':
        gs.tw = num(0);
        gs.tc = num(1);
        tlm = multiply([1, 0, 0, 1, 0, -gs.tl], tlm);
        tm = tlm;
        showText(args[2] instanceof PdfString ? [args[2]] : [], i, op);
        break;
      case 'BMC':
        mcStack.push({ tag: args[0] instanceof PdfName ? args[0].name : '', props: null, start: i });
        break;
      case 'BDC': {
        const tag = args[0] instanceof PdfName ? args[0].name : '';
        let props = null;
        if (args[1] instanceof PdfDictValue) {
          props = {};
          for (const [k, v] of args[1].map) props[k] = v instanceof PdfName ? v.name : v;
        } else if (args[1] instanceof PdfName) {
          props = { ref: args[1].name };
        }
        mcStack.push({ tag, props, start: i });
        break;
      }
      case 'EMC': {
        const mc = mcStack.pop();
        if (mc) model.marked.push({ startOp: mc.start, endOp: i, tag: mc.tag, props: mc.props });
        break;
      }
      case 'm':
        lastPoint = subpathStart = addPathPoint(i, num(0), num(1));
        break;
      case 'l': {
        const p = addPathPoint(i, num(0), num(1));
        addSegment(lastPoint, p);
        lastPoint = p;
        break;
      }
      case 'h':
        addSegment(lastPoint, subpathStart);
        lastPoint = subpathStart;
        break;
      case 'c':
        addPathPoint(i, num(0), num(1));
        addPathPoint(i, num(2), num(3));
        lastPoint = addPathPoint(i, num(4), num(5));
        break;
      case 'v':
      case 'y':
        addPathPoint(i, num(0), num(1));
        lastPoint = addPathPoint(i, num(2), num(3));
        break;
      case 're': {
        const x = num(0);
        const y = num(1);
        const w = num(2);
        const h = num(3);
        const a = addPathPoint(i, x, y);
        const c = addPathPoint(i, x + w, y + h);
        const b = addPathPoint(i, x + w, y);
        const d = addPathPoint(i, x, y + h);
        addSegment(a, b);
        addSegment(b, c);
        addSegment(c, d);
        addSegment(d, a);
        lastPoint = subpathStart = a;
        break;
      }
      case 'S':
      case 's':
        recordPath(i, 'stroke');
        break;
      case 'f':
      case 'F':
      case 'f*':
        recordPath(i, 'fill');
        break;
      case 'B':
      case 'B*':
      case 'b':
      case 'b*':
        recordPath(i, 'fillstroke');
        break;
      case 'n':
        pathPoints = [];
        pathStartOp = -1;
        pathSegments = [];
        lastPoint = subpathStart = null;
        break;
      case 'BI': {
        const quad = [applyPoint(gs.ctm, 0, 0), applyPoint(gs.ctm, 1, 0), applyPoint(gs.ctm, 1, 1), applyPoint(gs.ctm, 0, 1)];
        model.images.push({
          opIndex: i,
          name: null,
          ref: null,
          inline: true,
          ctm: gs.ctm,
          quad,
          bbox: boundsOfPoints(quad),
          mc: currentMc(),
        });
        break;
      }
      case 'Do': {
        const name = args[0] instanceof PdfName ? args[0].name : null;
        if (!name || !xobjDict) break;
        const ref = xobjDict.get(N(name));
        const xobj = resolve(context, ref);
        if (!(xobj instanceof PDFStream)) break;
        const subtype = nameOf(xobj.dict.get(N('Subtype')));
        if (subtype === 'Image') {
          const quad = [applyPoint(gs.ctm, 0, 0), applyPoint(gs.ctm, 1, 0), applyPoint(gs.ctm, 1, 1), applyPoint(gs.ctm, 0, 1)];
          model.images.push({
            opIndex: i,
            name,
            ref: ref instanceof PDFRef ? ref : null,
            stream: xobj,
            inline: false,
            ctm: gs.ctm,
            quad,
            bbox: boundsOfPoints(quad),
            mc: currentMc(),
            width: numberOf(context, xobj.dict.get(N('Width')), 0),
            height: numberOf(context, xobj.dict.get(N('Height')), 0),
          });
        } else if (subtype === 'Form') {
          if (depth >= MAX_FORM_DEPTH || formStack.includes(xobj)) break;
          const mArr = getArray(context, xobj.dict, 'Matrix');
          const matrix = mArr && mArr.size() >= 6 ? [0, 1, 2, 3, 4, 5].map((k) => numberOf(context, mArr.get(k), k === 0 || k === 3 ? 1 : 0)) : [1, 0, 0, 1, 0, 0];
          const formResources = getDict(context, xobj.dict, 'Resources') || resources;
          const ctm = multiply(matrix, gs.ctm);
          let sub = null;
          try {
            sub = interpretContent({
              context,
              bytes: streamContents(xobj),
              resources: formResources,
              fontCache,
              baseCtm: ctm,
              initialState: gs,
              depth: depth + 1,
              formStack: [...formStack, xobj],
              collectPaths,
            });
          } catch {
            sub = null;
          }
          const bboxArr = getArray(context, xobj.dict, 'BBox');
          model.forms.push({
            opIndex: i,
            name,
            ref: ref instanceof PDFRef ? ref : refOf(context, xobj),
            stream: xobj,
            matrix,
            ctm: gs.ctm,
            model: sub,
            ownResources: !!getDict(context, xobj.dict, 'Resources'),
            bbox: bboxArr ? bboxArr : null,
            mc: currentMc(),
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return model;
}

// Flattens text runs of a content model including nested forms.
// Each entry: { run, path: [formOpIndex..., opIndex] }
export function allTextRuns(model, prefix = []) {
  const out = [];
  if (!model) return out;
  for (const run of model.textRuns) out.push({ run, path: [...prefix, run.opIndex] });
  for (const f of model.forms) out.push(...allTextRuns(f.model, [...prefix, f.opIndex]));
  return out;
}

export function allImages(model, prefix = []) {
  const out = [];
  if (!model) return out;
  for (const img of model.images) out.push({ image: img, path: [...prefix, img.opIndex] });
  for (const f of model.forms) out.push(...allImages(f.model, [...prefix, f.opIndex]));
  return out;
}

export function allPaths(model, prefix = []) {
  const out = [];
  if (!model) return out;
  for (const p of model.paths) out.push({ pathItem: p, path: [...prefix, p.endOp] });
  for (const f of model.forms) out.push(...allPaths(f.model, [...prefix, f.opIndex]));
  return out;
}

export function runText(run) {
  // Rough text decoding for debugging (single-byte codes as Latin-1).
  let s = '';
  for (const g of run.glyphs) s += g.len === 1 ? String.fromCharCode(g.code) : '�';
  return s;
}
