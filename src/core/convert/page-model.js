// Builds a geometric model of a PDF page from a pdf.js operator list: text
// glyphs (with Unicode, position and style), vector paths and images, all in
// "view space" (points, origin at the top-left corner of the displayed page).
// The model is the input of the PDF-to-Word layout analysis.
import { multiply, applyPoint, IDENTITY } from '../matrix.js';
import { classifyFontName, stripSubsetPrefix } from '../font-info.js';

const LIGATURES = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };

export function intersectRect(a, b) {
  if (!a) return b;
  if (!b) return a;
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
}

function rectOfPoints(pts) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  return [x0, y0, x1, y1];
}

function toHex(v) {
  if (typeof v === 'string') return v.length === 7 ? v.toLowerCase() : '#000000';
  return null;
}

function rgbArgsToHex(args) {
  if (!args) return '#000000';
  if (typeof args[0] === 'string') return toHex(args[0]) || '#000000';
  if (args.length >= 3 && typeof args[0] === 'number') {
    const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return `#${c(args[0])}${c(args[1])}${c(args[2])}`;
  }
  return '#000000';
}

// Mean colour of a gradient (used where only a flat colour is possible).
function meanColor(stops) {
  let r = 0;
  let g = 0;
  let b = 0;
  let total = 0;
  for (let i = 0; i < stops.length; i++) {
    const prev = i > 0 ? stops[i - 1].pos : 0;
    const next = i + 1 < stops.length ? stops[i + 1].pos : 1;
    const w = Math.max(1e-3, (next - prev) / 2);
    const c = stops[i].color;
    r += parseInt(c.slice(1, 3), 16) * w;
    g += parseInt(c.slice(3, 5), 16) * w;
    b += parseInt(c.slice(5, 7), 16) * w;
    total += w;
  }
  const h = (v) => Math.round(v / total).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function cloneState(s) {
  return { ...s };
}

function fontRecord(id, font) {
  const name = stripSubsetPrefix((font && font.name) || '');
  const cls = classifyFontName(name);
  return {
    id,
    name,
    bold: !!(cls.bold || (font && (font.bold || font.black))),
    italic: !!(cls.italic || (font && font.italic)),
    serif: !!(font && font.isSerifFont) || cls.serif,
    mono: !!(font && font.isMonospace) || cls.mono,
    ascent: font && typeof font.ascent === 'number' && font.ascent > 0 ? font.ascent : 0.9,
    descent: font && typeof font.descent === 'number' && font.descent < 0 ? font.descent : -0.22,
    type3: !!(font && font.isType3Font),
    vertical: !!(font && font.vertical),
    fontMatrix: (font && font.fontMatrix) || [0.001, 0, 0, 0.001, 0, 0],
    em: font && font.isType3Font ? type3Em(font) : 1,
    spaceWidth: 0,
  };
}

// A Type 3 font draws its glyphs in units of its own; the height of its
// bounding box tells how large one "em" of the font really is.
function type3Em(font) {
  const fm = font.fontMatrix || [0.001, 0, 0, 0.001, 0, 0];
  const bbox = font.bbox;
  if (Array.isArray(bbox) && bbox.length === 4) {
    const h = Math.abs(bbox[3] - bbox[1]) * Math.abs(fm[3]);
    if (h > 0.05 && h < 50) return h / 1.15;
  }
  const k = Math.abs(fm[3]) / 0.001;
  return k > 0.05 && k < 50 ? k : 1;
}

/**
 * @param opList { fnArray, argsArray } from PDFPageProxy.getOperatorList()
 * @param env { OPS, getFont(id), transform, width, height }
 *   transform: user space -> view space (pdf.js viewport transform at scale 1)
 */
export function buildPageModel(opList, env) {
  const { OPS, getFont, getPattern = null, transform = IDENTITY, width, height } = env;
  const { fnArray, argsArray } = opList;
  const glyphs = [];
  const paths = [];
  const images = [];
  const stats = { shadings: 0, patterns: 0, type3: 0, invisibleText: 0, clippedText: 0 };
  const fonts = new Map();
  const pageClip = [0, 0, width, height];

  const initial = () => ({
    ctm: transform,
    clip: null,
    fill: '#000000',
    stroke: '#000000',
    fillGrad: null,
    fillAlpha: 1,
    strokeAlpha: 1,
    lineWidth: 1,
    dash: null,
    textMatrix: IDENTITY,
    x: 0,
    y: 0,
    lineX: 0,
    lineY: 0,
    charSpacing: 0,
    wordSpacing: 0,
    hScale: 1,
    leading: 0,
    rise: 0,
    render: 0,
    font: null,
    fontSize: 0,
    fontDir: 1,
  });
  let gs = initial();
  const stack = [];
  let pendingClip = false;
  let seq = 0;
  // Depth counter while inside a soft-mask group (its content is not painted).
  let skipDepth = 0;
  const groupStack = [];

  // Axial / radial shading as { kind, stops: [{ pos, color }], p0, p1 } in
  // view space; `base` maps the pattern space to view space.
  const gradientOf = (id, base) => {
    if (!getPattern || typeof id !== 'string') return null;
    let ir = null;
    try {
      ir = getPattern(id);
    } catch {
      ir = null;
    }
    if (!Array.isArray(ir) || ir[0] !== 'RadialAxial' || !Array.isArray(ir[3]) || !ir[4] || !ir[5]) return null;
    const stops = ir[3].filter((st) => Array.isArray(st) && /^#[0-9a-f]{6}$/i.test(st[1])).map((st) => ({ pos: Math.min(1, Math.max(0, +st[0] || 0)), color: st[1].toLowerCase() }));
    if (stops.length < 2) return null;
    stops.sort((x, y) => x.pos - y.pos);
    return { kind: ir[1] === 'radial' ? 'radial' : 'axial', stops, p0: applyPoint(base, ir[4][0], ir[4][1]), p1: applyPoint(base, ir[5][0], ir[5][1]), color: meanColor(stops) };
  };

  const save = () => stack.push(cloneState(gs));
  const restore = () => {
    if (stack.length) gs = stack.pop();
  };

  const getFontRecord = (id) => {
    let rec = fonts.get(id);
    if (!rec) {
      let font = null;
      try {
        font = getFont(id);
      } catch {
        font = null;
      }
      rec = fontRecord(id, font);
      fonts.set(id, rec);
    }
    return rec;
  };

  const setFont = (id, size) => {
    gs.font = getFontRecord(id);
    if (size < 0) {
      gs.fontSize = -size;
      gs.fontDir = -1;
    } else {
      gs.fontSize = size;
      gs.fontDir = 1;
    }
  };

  const inClip = (x, y, tol = 1) => {
    const c = gs.clip;
    if (!c) return x >= -tol && y >= -tol && x <= width + tol && y <= height + tol;
    return x >= c[0] - tol && x <= c[2] + tol && y >= c[1] - tol && y <= c[3] + tol;
  };

  const lineScale = () => Math.sqrt(Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2])) || 1;

  const showText = (items) => {
    const font = gs.font;
    const fontSize = gs.fontSize;
    if (!font || !fontSize || !Array.isArray(items)) return;
    const visible = (gs.render & 3) !== 3 && gs.fillAlpha > 0.02;
    const fm = font.fontMatrix;
    const was = fontSize * fm[0];
    const hs = gs.hScale * gs.fontDir;
    const M = multiply(gs.textMatrix, gs.ctm);
    // Unit vectors of the text space axes in view space.
    const ux = Math.hypot(M[0], M[1]) || 1e-9;
    const uy = Math.hypot(M[2], M[3]) || 1e-9;
    const sign = hs < 0 ? -1 : 1;
    const ax = (M[0] / ux) * sign;
    const ay = (M[1] / ux) * sign;
    const size = fontSize * uy * font.em;
    const scaleX = ux * Math.abs(hs);
    const hRatio = scaleX / uy;
    // Text painted with a pattern or shading keeps its place in black.
    let color = (gs.render & 3) === 1 ? gs.stroke : gs.fill;
    if (color === 'pattern') color = '#000000';
    // Stroked text is outline text; filled and stroked in one colour with a
    // visible line is the usual way to fake bold.
    const mode = gs.render & 3;
    const outline = mode === 1;
    const faux = mode === 2 && gs.stroke === gs.fill && (gs.lineWidth * lineScale()) / (size || 1) > 0.012;
    let xacc = 0;
    for (const g of items) {
      if (typeof g === 'number') {
        xacc += ((font.vertical ? 1 : -1) * g * fontSize) / 1000;
        continue;
      }
      if (!g) continue;
      const spacing = (g.isSpace ? gs.wordSpacing : 0) + gs.charSpacing;
      let gw = g.width || 0;
      let tx;
      let ty;
      let adv;
      if (font.vertical && g.vmetric) {
        const vm = g.vmetric;
        tx = gs.x + -vm[1] * was * hs;
        ty = gs.y + gs.rise - (xacc + vm[2] * was);
        gw = -vm[0];
        adv = gw * was - spacing * gs.fontDir;
      } else {
        tx = gs.x + xacc * hs;
        ty = gs.y + gs.rise;
        adv = gw * was + spacing * gs.fontDir;
      }
      const natural = Math.abs(gw * was) * scaleX;
      let s = typeof g.unicode === 'string' ? g.unicode : '';
      if (LIGATURES[s]) s = LIGATURES[s];
      // Strip control characters that are not valid in XML text.
      // eslint-disable-next-line no-control-regex
      s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
      // pdf.js sets g.isSpace for character code 32 (the code word spacing
      // applies to); in a subset font that code can be any letter.
      const isSpace = s.length > 0 ? !s.trim() : !!g.isSpace;
      if (s && visible && color) {
        const [px, py] = applyPoint(M, tx, ty);
        // Centre of the glyph box, used for clipping.
        const cx = px + ax * (natural / 2) + ay * 0.3 * size;
        const cy = py + ay * (natural / 2) - ax * 0.3 * size;
        if (inClip(cx, cy, Math.max(1, size * 0.25))) {
          if (isSpace && !font.spaceWidth && gw > 0) font.spaceWidth = Math.abs(gw * fm[0]);
          glyphs.push({ s: isSpace ? ' ' : s, x: px, y: py, w: font.vertical ? size : natural, size, hs: hRatio, ax, ay, font, color, space: isSpace, seq, outline, faux });
        } else {
          stats.clippedText++;
        }
      } else if (s && !isSpace) {
        stats.invisibleText++;
      }
      xacc += adv;
    }
    if (font.vertical) gs.y -= xacc;
    else gs.x += xacc * hs;
    seq++;
  };

  const paintPath = (op, data) => {
    const d = [];
    const pts = [];
    if (data && data.length) {
      const m = gs.ctm;
      for (let i = 0; i < data.length; ) {
        switch (data[i++]) {
          case 0: {
            const p = applyPoint(m, data[i++], data[i++]);
            d.push(['M', p[0], p[1]]);
            pts.push(p);
            break;
          }
          case 1: {
            const p = applyPoint(m, data[i++], data[i++]);
            d.push(['L', p[0], p[1]]);
            pts.push(p);
            break;
          }
          case 2: {
            const p1 = applyPoint(m, data[i++], data[i++]);
            const p2 = applyPoint(m, data[i++], data[i++]);
            const p3 = applyPoint(m, data[i++], data[i++]);
            d.push(['C', p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]]);
            pts.push(p1, p2, p3);
            break;
          }
          case 3: {
            const p1 = applyPoint(m, data[i++], data[i++]);
            const p2 = applyPoint(m, data[i++], data[i++]);
            d.push(['Q', p1[0], p1[1], p2[0], p2[1]]);
            pts.push(p1, p2);
            break;
          }
          case 4:
            d.push(['Z']);
            break;
          default:
            i = data.length;
            break;
        }
      }
    }
    const bbox = pts.length ? rectOfPoints(pts) : null;
    let fill = false;
    let stroke = false;
    let evenOdd = false;
    let close = false;
    switch (op) {
      case OPS.stroke:
        stroke = true;
        break;
      case OPS.closeStroke:
        stroke = true;
        close = true;
        break;
      case OPS.fill:
        fill = true;
        break;
      case OPS.eoFill:
        fill = true;
        evenOdd = true;
        break;
      case OPS.fillStroke:
        fill = stroke = true;
        break;
      case OPS.eoFillStroke:
        fill = stroke = true;
        evenOdd = true;
        break;
      case OPS.closeFillStroke:
        fill = stroke = close = true;
        break;
      case OPS.closeEOFillStroke:
        fill = stroke = close = true;
        evenOdd = true;
        break;
      default:
        break;
    }
    if (close && d.length && d[d.length - 1][0] !== 'Z') d.push(['Z']);
    if (bbox && (fill || stroke)) {
      const fillColor = fill && gs.fillAlpha > 0.02 ? gs.fill : null;
      const strokeColor = stroke && gs.strokeAlpha > 0.02 ? gs.stroke : null;
      if (fillColor === 'pattern' || strokeColor === 'pattern') stats.patterns++;
      const grad = fillColor === 'pattern' ? gs.fillGrad : null;
      const f = grad ? grad.color : fillColor && fillColor !== 'pattern' ? fillColor : null;
      const s = strokeColor && strokeColor !== 'pattern' ? strokeColor : null;
      const visibleBox = intersectRect(bbox, gs.clip || pageClip);
      const lw = Math.max(0.1, gs.lineWidth * lineScale());
      const pad = s ? lw / 2 : 0;
      if ((f || s) && visibleBox[2] + pad >= visibleBox[0] - pad && visibleBox[3] + pad >= visibleBox[1] - pad) {
        paths.push({
          d,
          fill: f,
          evenOdd,
          stroke: s,
          lw,
          dash: s && gs.dash && gs.dash.length ? gs.dash.map((v) => v * lineScale()) : null,
          alpha: f ? gs.fillAlpha : gs.strokeAlpha,
          bbox,
          clip: gs.clip,
          seq,
          grad,
        });
        seq++;
      }
    }
    if (pendingClip) {
      if (bbox) gs.clip = intersectRect(gs.clip, bbox);
      pendingClip = false;
    }
  };

  const pushImage = (m, ref, extra = {}) => {
    const quad = [applyPoint(m, 0, 0), applyPoint(m, 1, 0), applyPoint(m, 1, 1), applyPoint(m, 0, 1)];
    const bbox = rectOfPoints(quad);
    const vis = intersectRect(bbox, gs.clip || pageClip);
    if (vis[2] <= vis[0] || vis[3] <= vis[1]) return;
    if (gs.fillAlpha <= 0.02) return;
    images.push({ m, bbox, clip: gs.clip, alpha: gs.fillAlpha, seq, ...ref, ...extra });
    seq++;
  };

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (skipDepth) {
      if (fn === OPS.beginGroup) skipDepth++;
      else if (fn === OPS.endGroup) skipDepth--;
      continue;
    }
    switch (fn) {
      case OPS.save:
        save();
        break;
      case OPS.restore:
        restore();
        break;
      case OPS.transform:
        gs.ctm = multiply([args[0], args[1], args[2], args[3], args[4], args[5]], gs.ctm);
        break;
      case OPS.setLineWidth:
        gs.lineWidth = args[0];
        break;
      case OPS.setDash:
        gs.dash = args[0] && args[0].length ? Array.from(args[0]) : null;
        break;
      case OPS.setGState:
        for (const [key, value] of args[0] || []) {
          switch (key) {
            case 'LW':
              gs.lineWidth = value;
              break;
            case 'D':
              gs.dash = value && value[0] && value[0].length ? Array.from(value[0]) : null;
              break;
            case 'CA':
              gs.strokeAlpha = value;
              break;
            case 'ca':
              gs.fillAlpha = value;
              break;
            case 'Font':
              setFont(value[0], value[1]);
              break;
            default:
              break;
          }
        }
        break;
      case OPS.setFillRGBColor:
        gs.fill = rgbArgsToHex(args);
        gs.fillGrad = null;
        break;
      case OPS.setStrokeRGBColor:
        gs.stroke = rgbArgsToHex(args);
        break;
      case OPS.setFillColorN:
        gs.fill = 'pattern';
        // ["Shading", id, matrix]: the matrix maps to the page's user space.
        gs.fillGrad = args && args[0] === 'Shading' ? gradientOf(args[1], multiply(args[2] || IDENTITY, transform)) : null;
        break;
      case OPS.setStrokeColorN:
        gs.stroke = 'pattern';
        break;
      case OPS.setFillTransparent:
        gs.fill = null;
        gs.fillGrad = null;
        break;
      case OPS.setStrokeTransparent:
        gs.stroke = null;
        break;
      case OPS.shadingFill: {
        // Paints the clip region with a shading.
        stats.shadings++;
        const grad = gradientOf(args && args[0], gs.ctm);
        const c = intersectRect(gs.clip, pageClip);
        if (grad && gs.fillAlpha > 0.02 && c && c[2] - c[0] > 0.5 && c[3] - c[1] > 0.5) {
          paths.push({ d: [['M', c[0], c[1]], ['L', c[2], c[1]], ['L', c[2], c[3]], ['L', c[0], c[3]], ['Z']], fill: grad.color, evenOdd: false, stroke: null, lw: 0, dash: null, alpha: gs.fillAlpha, bbox: c, clip: gs.clip, seq, grad });
          seq++;
        }
        break;
      }

      // ---- text state
      case OPS.beginText:
        gs.textMatrix = IDENTITY;
        gs.x = gs.lineX = 0;
        gs.y = gs.lineY = 0;
        break;
      case OPS.setCharSpacing:
        gs.charSpacing = args[0];
        break;
      case OPS.setWordSpacing:
        gs.wordSpacing = args[0];
        break;
      case OPS.setHScale:
        gs.hScale = args[0] / 100;
        break;
      case OPS.setLeading:
        gs.leading = -args[0];
        break;
      case OPS.setFont:
        setFont(args[0], args[1]);
        break;
      case OPS.setTextRenderingMode:
        gs.render = args[0];
        break;
      case OPS.setTextRise:
        gs.rise = args[0];
        break;
      case OPS.moveText:
        gs.x = gs.lineX += args[0];
        gs.y = gs.lineY += args[1];
        break;
      case OPS.setLeadingMoveText:
        gs.leading = args[1];
        gs.x = gs.lineX += args[0];
        gs.y = gs.lineY += args[1];
        break;
      case OPS.setTextMatrix: {
        const m = args[0] && args[0].length >= 6 ? args[0] : args;
        gs.textMatrix = [m[0], m[1], m[2], m[3], m[4], m[5]];
        gs.x = gs.lineX = 0;
        gs.y = gs.lineY = 0;
        break;
      }
      case OPS.nextLine:
        gs.y = gs.lineY += gs.leading;
        gs.x = gs.lineX;
        break;
      case OPS.showText:
        showText(args[0]);
        break;
      case OPS.showSpacedText:
        showText(args[0]);
        break;
      case OPS.nextLineShowText:
        gs.y = gs.lineY += gs.leading;
        gs.x = gs.lineX;
        showText(args[0]);
        break;
      case OPS.nextLineSetSpacingShowText:
        gs.wordSpacing = args[0];
        gs.charSpacing = args[1];
        gs.y = gs.lineY += gs.leading;
        gs.x = gs.lineX;
        showText(args[2]);
        break;

      // ---- paths
      case OPS.clip:
      case OPS.eoClip:
        pendingClip = true;
        break;
      case OPS.constructPath:
        paintPath(args[0], args[1] ? args[1][0] : null);
        break;
      case OPS.endPath:
        pendingClip = false;
        break;

      // ---- images
      case OPS.paintImageXObject:
        pushImage(gs.ctm, { objId: args[0], pw: args[1], ph: args[2] });
        break;
      case OPS.paintInlineImageXObject:
        pushImage(gs.ctm, { inline: args[0] });
        break;
      case OPS.paintImageMaskXObject:
        if (gs.fill && gs.fill !== 'pattern') pushImage(gs.ctm, { maskObj: args[0] }, { maskColor: gs.fill });
        break;
      case OPS.paintSolidColorImageMask:
        if (gs.fill && gs.fill !== 'pattern') {
          const q = [applyPoint(gs.ctm, 0, 0), applyPoint(gs.ctm, 1, 0), applyPoint(gs.ctm, 1, 1), applyPoint(gs.ctm, 0, 1)];
          paths.push({ d: [['M', ...q[0]], ['L', ...q[1]], ['L', ...q[2]], ['L', ...q[3]], ['Z']], fill: gs.fill, evenOdd: false, stroke: null, lw: 0, dash: null, alpha: gs.fillAlpha, bbox: rectOfPoints(q), clip: gs.clip, seq });
          seq++;
        }
        break;
      case OPS.paintImageXObjectRepeat: {
        const [objId, sx, sy, positions] = args;
        for (let k = 0; positions && k + 1 < positions.length; k += 2) {
          pushImage(multiply([sx, 0, 0, sy, positions[k], positions[k + 1]], gs.ctm), { objId });
        }
        break;
      }
      case OPS.paintInlineImageXObjectGroup: {
        const [imgData, map] = args;
        for (const entry of map || []) {
          if (entry && entry.transform) pushImage(multiply(Array.from(entry.transform), gs.ctm), { inline: imgData });
        }
        break;
      }

      // ---- nested content
      case OPS.paintFormXObjectBegin: {
        save();
        const [matrix, bbox] = args;
        if (matrix) gs.ctm = multiply(Array.from(matrix), gs.ctm);
        if (bbox) {
          const q = [applyPoint(gs.ctm, bbox[0], bbox[1]), applyPoint(gs.ctm, bbox[2], bbox[1]), applyPoint(gs.ctm, bbox[2], bbox[3]), applyPoint(gs.ctm, bbox[0], bbox[3])];
          gs.clip = intersectRect(gs.clip, rectOfPoints(q));
        }
        break;
      }
      case OPS.paintFormXObjectEnd:
        restore();
        break;
      case OPS.beginGroup: {
        const group = args[0] || {};
        if (group.smask) {
          skipDepth = 1;
          break;
        }
        save();
        groupStack.push(true);
        break;
      }
      case OPS.endGroup:
        if (groupStack.length) {
          groupStack.pop();
          restore();
        }
        break;
      case OPS.beginAnnotation: {
        save();
        const [, rect, tr, matrix] = args;
        // Annotations are painted from the page's base state.
        gs = { ...initial(), ctm: transform };
        if (rect) {
          const q = [applyPoint(gs.ctm, rect[0], rect[1]), applyPoint(gs.ctm, rect[2], rect[1]), applyPoint(gs.ctm, rect[2], rect[3]), applyPoint(gs.ctm, rect[0], rect[3])];
          gs.clip = rectOfPoints(q);
        }
        if (tr) gs.ctm = multiply(Array.from(tr), gs.ctm);
        if (matrix) gs.ctm = multiply(Array.from(matrix), gs.ctm);
        break;
      }
      case OPS.endAnnotation:
        restore();
        break;
      default:
        break;
    }
  }
  return { width, height, glyphs, paths, images, fonts: [...fonts.values()], stats };
}
