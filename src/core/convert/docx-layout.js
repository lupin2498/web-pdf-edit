// DOCX writer for laid out pages (see layout.js).
//
// Every PDF page becomes one section with the same page size. The flow of a
// page is a sequence of single-line paragraphs and real tables whose row
// heights, column widths and paragraph positions are exact, so the Word
// document reproduces the PDF layout:
//   - line boxes use an exact height chosen so that every layout engine puts
//     the baseline at the same place (80% of the box),
//   - table rows have exact heights equal to the distance between rules,
//   - images, lines, shapes and out-of-flow text are anchored to the page.
import { zipSync, strToU8 } from 'fflate';
import { alignmentOf } from './layout.js';

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" ' +
  'xmlns:v="urn:schemas-microsoft-com:vml" ' +
  'xmlns:o="urn:schemas-microsoft-com:office:office" ' +
  'xmlns:w10="urn:schemas-microsoft-com:office:word"';

const tw = (pt) => Math.round(pt * 20);
const emu = (pt) => Math.round(pt * 12700);

export function escXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const hexColor = (c) => (c || '#000000').replace('#', '').toUpperCase();

// ---------------------------------------------------------------------------
// Runs and paragraphs

function rprXml(style, extra, defaults) {
  if (!style) return '';
  const parts = [];
  const fam = style.family;
  if (fam && fam !== defaults.family) {
    const f = escXml(fam);
    parts.push(`<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:eastAsia="${f}" w:cs="${f}"/>`);
  }
  if (style.bold) parts.push('<w:b/><w:bCs/>');
  if (style.italic) parts.push('<w:i/><w:iCs/>');
  if (extra && extra.strike) parts.push('<w:strike/>');
  if (style.outline) parts.push('<w:outline/>');
  const color = hexColor(style.color);
  if (color !== '000000') parts.push(`<w:color w:val="${color}"/>`);
  if (extra && extra.spacing) parts.push(`<w:spacing w:val="${tw(extra.spacing)}"/>`);
  if (style.scale && style.scale !== 100) parts.push(`<w:w w:val="${Math.max(1, Math.min(600, style.scale))}"/>`);
  if (extra && extra.rise) parts.push(`<w:position w:val="${Math.round(extra.rise * 2)}"/>`);
  const sz = Math.max(2, Math.round(style.size * 2));
  if (sz !== defaults.sz) parts.push(`<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>`);
  if (extra && extra.underline) parts.push('<w:u w:val="single"/>');
  return parts.join('');
}

/**
 * Paragraph for one text line.
 * ctx: { originX (pt), yTw (twips, updated), defaults, areaLeft, areaRight, clampIndent }
 */
function linePara(p, ctx, opts = {}) {
  const topTw = tw(p.top);
  const before = Math.max(0, topTw - ctx.yTw);
  const lineTw = Math.max(10, tw(p.height));
  ctx.yTw += before + lineTw;
  const ppr = [];
  const tabs = [];
  for (const t of p.tokens) if (t.t === 'tab') tabs.push(tw(t.pos - ctx.originX));
  if (tabs.length) {
    const uniq = [...new Set(tabs)].filter((v) => v > 0).sort((a, b) => a - b);
    if (uniq.length) ppr.push(`<w:tabs>${uniq.map((v) => `<w:tab w:val="left" w:pos="${v}"/>`).join('')}</w:tabs>`);
  }
  ppr.push(`<w:spacing w:before="${before}" w:after="${opts.after || 0}" w:line="${lineTw}" w:lineRule="exact"/>`);
  // A rendering that is a little wider than expected (another font, another
  // text engine) must not wrap the line: the paragraph may reach beyond the
  // text area by `need` on the side the text grows to.
  const width = p.x1 - p.x;
  const need = Math.max(9, 0.15 * width);
  let left;
  let right;
  let jc = '';
  if (p.align === 'center') {
    // Centre on the line's own centre inside the text area.
    const off = 2 * ((p.x + p.x1) / 2) - ctx.areaLeft - ctx.areaRight;
    // (an offset below a third of a point is measuring noise)
    left = off > 0.3 ? off : 0;
    right = off < -0.3 ? -off : 0;
    const room = (ctx.areaRight - ctx.areaLeft - left - right - width) / 2;
    if (room < need / 2) {
      left -= need / 2 - room;
      right -= need / 2 - room;
    }
    jc = '<w:jc w:val="center"/>';
  } else if (p.align === 'right') {
    right = Math.max(0, ctx.areaRight - p.x1);
    if (right < 0.05) right = 0;
    const room = p.x - ctx.areaLeft;
    left = room < need ? room - need : 0;
    jc = '<w:jc w:val="right"/>';
  } else {
    left = p.x - ctx.originX;
    if (ctx.clampIndent && left < 0) left = 0;
    const room = ctx.areaRight - p.x1;
    right = room < need ? room - need : 0;
  }
  if (tw(left) || tw(right)) ppr.push(`<w:ind w:left="${tw(left)}"${tw(right) ? ` w:right="${tw(right)}"` : ''}/>`);
  if (jc) ppr.push(jc);
  const markRpr = rprXml(p.style, null, ctx.defaults);
  if (markRpr) ppr.push(`<w:rPr>${markRpr}</w:rPr>`);
  if (opts.sectPr) ppr.push(opts.sectPr);

  // Runs: merge neighbours with identical properties.
  const runs = [];
  let cur = null;
  const push = (rpr, text) => {
    if (cur && cur.rpr === rpr) cur.text += text;
    else {
      cur = { rpr, text };
      runs.push(cur);
    }
  };
  for (const t of p.tokens) {
    if (t.t === 'tab') {
      cur = null;
      runs.push({ tab: true });
    } else if (t.t === 'space') {
      push(rprXml(t.style, { spacing: t.extra, underline: t.underline }, ctx.defaults), ' '.repeat(t.n));
    } else {
      push(rprXml(t.style, { spacing: t.spacing, rise: t.rise, underline: t.underline, strike: t.strike }, ctx.defaults), t.text);
    }
  }
  const body = runs
    .map((r) => (r.tab ? '<w:r><w:tab/></w:r>' : `<w:r>${r.rpr ? `<w:rPr>${r.rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${escXml(r.text)}</w:t></w:r>`))
    .join('');
  return `<w:p><w:pPr>${ppr.join('')}</w:pPr>${opts.prefix || ''}${body}</w:p>`;
}

// An empty paragraph with an exact height.
function spacerPara(heightTw, { after = 0, sectPr = '', content = '', sz = 2 } = {}) {
  const line = Math.max(1, heightTw);
  return `<w:p><w:pPr><w:spacing w:before="0" w:after="${after}" w:line="${line}" w:lineRule="exact"/><w:rPr><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr>${sectPr}</w:pPr>${content}</w:p>`;
}

// ---------------------------------------------------------------------------
// Tables

function borderXml(tag, b) {
  if (!b) return '';
  const sz = Math.max(2, Math.min(96, Math.round(b.t * 8)));
  let val = 'single';
  if (b.dash && b.dash.length) val = b.dash[0] <= b.t * 2.2 ? 'dotted' : 'dashed';
  return `<w:${tag} w:val="${val}" w:sz="${sz}" w:space="0" w:color="${hexColor(b.color)}"/>`;
}

function tableXml(block, ctx) {
  const t = block.table;
  const { xs, ys, cells, cols, rows } = t;
  const xTw = xs.map(tw);
  const yTw = ys.map(tw);
  const colW = [];
  for (let i = 0; i < cols; i++) colW.push(Math.max(1, xTw[i + 1] - xTw[i]));
  const total = colW.reduce((a, b) => a + b, 0);
  // Cells by row, in column order.
  const byRow = Array.from({ length: rows }, () => []);
  for (const c of cells) for (let j = c.r0; j <= c.r1; j++) byRow[j].push(c);
  for (const list of byRow) list.sort((a, b) => a.c0 - b.c0);

  const out = [];
  out.push('<w:tbl><w:tblPr>');
  out.push(`<w:tblW w:w="${total}" w:type="dxa"/>`);
  out.push(`<w:tblInd w:w="${xTw[0] - tw(ctx.areaLeft)}" w:type="dxa"/>`);
  out.push('<w:tblLayout w:type="fixed"/>');
  const marL = tw(t.marL || 0);
  const marR = tw(t.marR || 0);
  out.push(`<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="${marL}" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="${marR}" w:type="dxa"/></w:tblCellMar>`);
  out.push('<w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/>');
  out.push('</w:tblPr><w:tblGrid>');
  for (const w of colW) out.push(`<w:gridCol w:w="${w}"/>`);
  out.push('</w:tblGrid>');

  const emptySz = ctx.defaults.sz;
  for (let j = 0; j < rows; j++) {
    const rowH = Math.max(1, yTw[j + 1] - yTw[j]);
    out.push(`<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${rowH}" w:hRule="exact"/></w:trPr>`);
    for (const c of byRow[j]) {
      let w = 0;
      for (let i = c.c0; i <= c.c1; i++) w += colW[i];
      const span = c.c1 - c.c0 + 1;
      const first = j === c.r0;
      const last = j === c.r1;
      const tcPr = [`<w:tcW w:w="${w}" w:type="dxa"/>`];
      if (span > 1) tcPr.push(`<w:gridSpan w:val="${span}"/>`);
      if (c.r1 > c.r0) tcPr.push(first ? '<w:vMerge w:val="restart"/>' : '<w:vMerge/>');
      const b = c.borders;
      const borders = borderXml('top', first ? b.top : null) + borderXml('left', b.left) + borderXml('bottom', last ? b.bottom : null) + borderXml('right', b.right);
      if (borders) tcPr.push(`<w:tcBorders>${borders}</w:tcBorders>`);
      if (c.fill) tcPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${hexColor(c.fill)}"/>`);
      const cl = c.marL ?? t.marL ?? 0;
      const cr = c.marR ?? t.marR ?? 0;
      if (tw(cl) !== marL || tw(cr) !== marR) tcPr.push(`<w:tcMar><w:left w:w="${tw(cl)}" w:type="dxa"/><w:right w:w="${tw(cr)}" w:type="dxa"/></w:tcMar>`);
      out.push(`<w:tc><w:tcPr>${tcPr.join('')}</w:tcPr>`);
      if (first && c.paras && c.paras.length) {
        const topT = t.hT[c.r0] || 0;
        const cctx = { originX: c.x0 + cl, yTw: tw(c.y0 + topT / 2), defaults: ctx.defaults, areaLeft: c.x0 + cl, areaRight: c.x1 - cr, clampIndent: true };
        for (const p of c.paras) out.push(linePara(p, cctx));
      } else {
        // Empty cell: keep the default font so that typed text looks right.
        const avail = (first ? yTw[c.r1 + 1] : yTw[j + 1]) - yTw[j];
        const line = Math.max(10, Math.min(Math.round(emptySz * 11.5), avail - 10));
        out.push(`<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="${line}" w:lineRule="exact"/></w:pPr></w:p>`);
      }
      out.push('</w:tc>');
    }
    out.push('</w:tr>');
  }
  out.push('</w:tbl>');
  return out.join('');
}

// ---------------------------------------------------------------------------
// Floating objects

function anchorOpen(f, id, { behind = false, z = 0 } = {}) {
  return (
    `<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${251658240 + z}" behindDoc="${behind ? 1 : 0}" locked="0" layoutInCell="0" allowOverlap="1">` +
    '<wp:simplePos x="0" y="0"/>' +
    `<wp:positionH relativeFrom="page"><wp:posOffset>${emu(f.x)}</wp:posOffset></wp:positionH>` +
    `<wp:positionV relativeFrom="page"><wp:posOffset>${emu(f.y)}</wp:posOffset></wp:positionV>` +
    `<wp:extent cx="${Math.max(0, emu(f.w))}" cy="${Math.max(0, emu(f.h))}"/>` +
    '<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>'
  );
}

function xfrm(f, cx, cy) {
  const attrs = [];
  if (f.rot) attrs.push(`rot="${Math.round((((f.rot % 360) + 360) % 360) * 60000)}"`);
  if (f.flipH) attrs.push('flipH="1"');
  if (f.flipV) attrs.push('flipV="1"');
  return `<a:xfrm${attrs.length ? ` ${attrs.join(' ')}` : ''}><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
}

function pictureXml(f, id, rid, opts) {
  const cx = Math.max(1, emu(f.w));
  const cy = Math.max(1, emu(f.h));
  const pct = (v) => Math.round(v * 100000);
  const src = f.crop ? `<a:srcRect l="${pct(f.crop.l)}" t="${pct(f.crop.t)}" r="${pct(f.crop.r)}" b="${pct(f.crop.b)}"/>` : '';
  const alpha = f.alpha < 0.98 ? `<a:alphaModFix amt="${Math.round(f.alpha * 100000)}"/>` : '';
  return (
    `<w:r><w:drawing>${anchorOpen(f, id, opts)}<wp:docPr id="${id}" name="Picture ${id}"/>` +
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rid}">${alpha}</a:blip>${src}<a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr>${xfrm(f, cx, cy)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    '</pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>'
  );
}

function solidFill(color, alpha = 1) {
  const a = alpha < 0.98 ? `<a:alpha val="${Math.round(alpha * 100000)}"/>` : '';
  return `<a:solidFill><a:srgbClr val="${hexColor(color)}">${a}</a:srgbClr></a:solidFill>`;
}

// Gradient fill of a shape with bounding box `bbox`. DrawingML runs a linear
// gradient across the whole shape, so the stops of the PDF axis are mapped
// onto the part of the axis the shape covers.
function gradFill(g, bbox, alpha = 1) {
  const a = alpha < 0.98 ? `<a:alpha val="${Math.round(alpha * 100000)}"/>` : '';
  const stop = (pos, color) => `<a:gs pos="${Math.round(Math.min(1, Math.max(0, pos)) * 100000)}"><a:srgbClr val="${hexColor(color)}">${a}</a:srgbClr></a:gs>`;
  const dx = g.p1[0] - g.p0[0];
  const dy = g.p1[1] - g.p0[1];
  const len2 = dx * dx + dy * dy;
  if (g.kind !== 'axial' || len2 < 1e-6) {
    return `<a:gradFill rotWithShape="1"><a:gsLst>${g.stops.map((st) => stop(st.pos, st.color)).join('')}</a:gsLst><a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path></a:gradFill>`;
  }
  const [x0, y0, x1, y1] = bbox;
  const ts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => ((x - g.p0[0]) * dx + (y - g.p0[1]) * dy) / len2);
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  const span = Math.max(1e-6, t1 - t0);
  const first = g.stops[0];
  const last = g.stops[g.stops.length - 1];
  const list = [];
  if ((first.pos - t0) / span > 0.001) list.push([0, first.color]);
  for (const st of g.stops) {
    const p = (st.pos - t0) / span;
    if (p >= -0.001 && p <= 1.001) list.push([p, st.color]);
  }
  if ((last.pos - t0) / span < 0.999) list.push([1, last.color]);
  if (list.length < 2) return solidFill(g.color, alpha);
  const ang = ((Math.round((Math.atan2(dy, dx) * 180) / Math.PI * 60000) % 21600000) + 21600000) % 21600000;
  return `<a:gradFill rotWithShape="1"><a:gsLst>${list.map(([p, c]) => stop(p, c)).join('')}</a:gsLst><a:lin ang="${ang}" scaled="0"/></a:gradFill>`;
}

function lineProps(color, width, dash, alpha = 1) {
  if (!color) return '<a:ln><a:noFill/></a:ln>';
  let d = '';
  if (dash && dash.length) {
    // The exact pattern, in 1/1000 % of the line width.
    const w = Math.max(0.05, width);
    const list = dash.length % 2 ? [...dash, ...dash] : dash;
    const unit = (v) => Math.max(1000, Math.min(100000000, Math.round((v / w) * 100000)));
    const stops = [];
    for (let i = 0; i + 1 < list.length && stops.length < 8; i += 2) stops.push(`<a:ds d="${unit(list[i])}" sp="${unit(list[i + 1])}"/>`);
    d = `<a:custDash>${stops.join('')}</a:custDash>`;
  }
  return `<a:ln w="${Math.max(3175, emu(width))}" cap="flat">${solidFill(color, alpha)}${d}</a:ln>`;
}

function shapeWrap(f, id, opts, geom, fill, ln, body = '<wps:bodyPr/>', txbx = '', fallback = '', connector = false) {
  const cx = Math.max(0, emu(f.w));
  const cy = Math.max(0, emu(f.h));
  return (
    '<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing>' +
    anchorOpen(f, id, opts) +
    `<wp:docPr id="${id}" name="Shape ${id}"/><wp:cNvGraphicFramePr/>` +
    '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp>' +
    `${connector ? '<wps:cNvCnPr/>' : `<wps:cNvSpPr${txbx ? ' txBox="1"' : ''}/>`}<wps:spPr>${xfrm(f, cx, cy)}${geom}${fill}${ln}</wps:spPr>${txbx}${body}` +
    '</wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice>' +
    `<mc:Fallback>${fallback}</mc:Fallback></mc:AlternateContent></w:r>`
  );
}

// A straight connector, as Word writes its lines (LibreOffice turns a plain
// "line" preset that is nearly as tall as the page on its side).
function lineShapeXml(f, id, opts) {
  const box = f.o === 'h' ? { x: f.a, y: f.pos, w: f.b - f.a, h: 0 } : { x: f.pos, y: f.a, w: 0, h: f.b - f.a };
  return shapeWrap(box, id, opts, '<a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom>', '', lineProps(f.color, f.t, f.dash), '<wps:bodyPr/>', '', '', true);
}

function rectShapeXml(f, id, opts) {
  return shapeWrap(f, id, opts, '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>', solidFill(f.fill, f.alpha ?? 1), '<a:ln><a:noFill/></a:ln>');
}

function pathShapeXml(f, id, opts) {
  const [x0, y0, x1, y1] = f.bbox;
  const box = { x: x0, y: y0, w: Math.max(0.05, x1 - x0), h: Math.max(0.05, y1 - y0) };
  const W = Math.max(1, emu(box.w));
  const H = Math.max(1, emu(box.h));
  const px = (x) => Math.round((x - box.x) * 12700);
  const py = (y) => Math.round((y - box.y) * 12700);
  const pt = (x, y) => `<a:pt x="${px(x)}" y="${py(y)}"/>`;
  const parts = [];
  for (const c of f.d) {
    if (c[0] === 'M') parts.push(`<a:moveTo>${pt(c[1], c[2])}</a:moveTo>`);
    else if (c[0] === 'L') parts.push(`<a:lnTo>${pt(c[1], c[2])}</a:lnTo>`);
    else if (c[0] === 'C') parts.push(`<a:cubicBezTo>${pt(c[1], c[2])}${pt(c[3], c[4])}${pt(c[5], c[6])}</a:cubicBezTo>`);
    else if (c[0] === 'Q') parts.push(`<a:quadBezTo>${pt(c[1], c[2])}${pt(c[3], c[4])}</a:quadBezTo>`);
    else if (c[0] === 'Z') parts.push('<a:close/>');
  }
  const geom = `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="${W}" b="${H}"/><a:pathLst><a:path w="${W}" h="${H}"${f.fill ? '' : ' fill="none"'}>${parts.join('')}</a:path></a:pathLst></a:custGeom>`;
  const fill = f.grad ? gradFill(f.grad, f.bbox, f.alpha ?? 1) : f.fill ? solidFill(f.fill, f.alpha ?? 1) : '<a:noFill/>';
  return shapeWrap(box, id, opts, geom, fill, lineProps(f.stroke, f.lw, f.dash, f.fill ? 1 : (f.alpha ?? 1)));
}

function textBoxXml(f, id, opts, defaults) {
  // A little extra length keeps the line from wrapping when the fonts differ.
  const slack = Math.max(4, f.w * 0.04);
  const len = f.w + slack;
  let angle = ((((f.rot || 0) % 360) + 540) % 360) - 180; // (-180, 180]
  if (Math.abs(angle) < 0.5) angle = 0;
  let box;
  let vert = 'horz';
  if (!angle) {
    box = { x: f.x, y: f.y, w: len, h: f.h, rot: 0 };
  } else {
    const cx = f.cx ?? f.x + f.w / 2;
    const cy = f.cy ?? f.y + f.h / 2;
    if (Math.abs(angle - 90) < 0.5) {
      // Reads downwards: vertical text (understood by every application).
      vert = 'vert';
      box = { x: cx - f.h / 2, y: cy - f.w / 2, w: f.h, h: len, rot: 0 };
    } else if (Math.abs(angle + 90) < 0.5) {
      vert = 'vert270';
      box = { x: cx - f.h / 2, y: cy + f.w / 2 - len, w: f.h, h: len, rot: 0 };
    } else {
      // The box is rotated about its centre; the start of the text stays put.
      const r = (angle * Math.PI) / 180;
      const ccx = cx + (slack / 2) * Math.cos(r);
      const ccy = cy + (slack / 2) * Math.sin(r);
      box = { x: ccx - len / 2, y: ccy - f.h / 2, w: len, h: f.h, rot: angle };
    }
  }
  const local = !!f.para.local || vert !== 'horz' || !!box.rot;
  const originX = local ? (f.para.local ? f.para.x0 ?? 0 : f.para.x) : box.x;
  const ctx = { originX, yTw: tw(local ? (f.para.local ? 0 : f.para.top) : box.y), defaults, areaLeft: originX, areaRight: originX + len, clampIndent: true };
  const para = { ...f.para, x: f.para.local ? f.para.x0 ?? 0 : f.para.x, top: f.para.local ? 0 : f.para.top, align: 'left' };
  const content = linePara(para, ctx);
  const txbx = `<wps:txbx><w:txbxContent>${content}</w:txbxContent></wps:txbx>`;
  const body = `<wps:bodyPr rot="0" vert="${vert}" wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t" anchorCtr="0"><a:noAutofit/></wps:bodyPr>`;
  const style = [
    'position:absolute',
    `margin-left:${box.x.toFixed(2)}pt`,
    `margin-top:${box.y.toFixed(2)}pt`,
    `width:${box.w.toFixed(2)}pt`,
    `height:${Math.max(1, box.h).toFixed(2)}pt`,
    `z-index:${251658240 + (opts.z || 0)}`,
    'mso-wrap-style:none',
    'mso-position-horizontal-relative:page',
    'mso-position-vertical-relative:page',
  ];
  if (box.rot) style.push(`rotation:${Math.round(box.rot)}`);
  const flow = vert === 'vert' ? ' style="layout-flow:vertical"' : vert === 'vert270' ? ' style="layout-flow:vertical;mso-layout-flow-alt:bottom-to-top"' : '';
  const fallback = `<w:pict><v:rect id="tb${id}" style="${style.join(';')}" filled="f" stroked="f"><v:textbox${flow} inset="0,0,0,0"><w:txbxContent>${content}</w:txbxContent></v:textbox><w10:wrap anchorx="page" anchory="page"/></v:rect></w:pict>`;
  return shapeWrap(box, id, opts, '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>', '<a:noFill/>', '<a:ln><a:noFill/></a:ln>', body, txbx, fallback);
}

// A table that cannot be part of the flow (it stands beside another table):
// inside a text box at its place on the page.
function tableBoxXml(block, id, opts, defaults) {
  const t = block.table;
  const pad = 2 + (t.vT[0] || 0) / 2;
  const box = { x: t.x0 - pad, y: block.top, w: t.x1 - t.x0 + 2 * pad + 2, h: block.bottom - block.top + 3 };
  const ctx = { originX: box.x, yTw: tw(box.y), defaults, areaLeft: box.x, areaRight: box.x + box.w, clampIndent: false };
  const content = tableXml(block, ctx) + spacerPara(20);
  const txbx = `<wps:txbx><w:txbxContent>${content}</w:txbxContent></wps:txbx>`;
  const body = '<wps:bodyPr rot="0" vert="horz" wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t" anchorCtr="0"><a:noAutofit/></wps:bodyPr>';
  return shapeWrap(box, id, opts, '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>', '<a:noFill/>', '<a:ln><a:noFill/></a:ln>', body, txbx);
}

// ---------------------------------------------------------------------------
// Document

function dominantStyle(pages) {
  const count = new Map();
  for (const page of pages) {
    for (const l of page.lines || []) {
      for (const w of l.words) {
        for (const r of w.runs) {
          const k = `${r.style.family}|${r.style.size}`;
          const e = count.get(k) || { n: 0, style: r.style };
          e.n += r.chars;
          count.set(k, e);
        }
      }
    }
  }
  let best = null;
  for (const e of count.values()) if (!best || e.n > best.n) best = e;
  const style = best ? best.style : { family: 'Times New Roman', size: 12 };
  return { family: style.family, sz: Math.round(style.size * 2) };
}

function overlapsText(f, page) {
  const x0 = f.x;
  const x1 = f.x + f.w;
  const y0 = f.y;
  const y1 = f.y + f.h;
  for (const l of page.lines || []) {
    if (l.x1 < x0 || l.x0 > x1) continue;
    if (l.y < y0 || l.y - l.size * 0.7 > y1) continue;
    return true;
  }
  return false;
}

// Groups values that lie within half a point of each other; every group is
// represented by its most frequent value (`pick`, Math.min or Math.max,
// breaks ties). Returns { snap(v), common } where `common` represents the
// largest group.
function clusterValues(values, pick) {
  const sorted = values.slice().sort((x, y) => x - y);
  const groups = [];
  for (const v of sorted) {
    const g = groups[groups.length - 1];
    if (g && v - g.last <= 0.5) {
      g.items.push(v);
      g.last = v;
    } else groups.push({ items: [v], last: v });
  }
  for (const g of groups) {
    const count = new Map();
    for (const v of g.items) {
      const k = Math.round(v * 20) / 20;
      count.set(k, (count.get(k) || 0) + 1);
    }
    let rep = null;
    let n = 0;
    for (const [k, c] of count) {
      if (c > n || (c === n && pick(k, rep) === k)) {
        rep = k;
        n = c;
      }
    }
    g.rep = rep;
    g.lo = g.items[0];
  }
  let common = null;
  for (const g of groups) if (!common || g.items.length > common.items.length || (g.items.length === common.items.length && pick(g.rep, common.rep) === g.rep)) common = g;
  return {
    common: common ? common.rep : null,
    snap(v) {
      for (const g of groups) if (v >= g.lo - 1e-6 && v <= g.last + 1e-6) return g.rep;
      return v;
    },
  };
}

/**
 * Page margins, as close as possible to the margins of the original
 * document: the text area of a page is given by its tables and by the edge
 * several lines share. Pages without such content (a title, a picture) use
 * the text area most pages of that size have. The top and bottom margins are
 * the smallest any page of the size needs.
 * Sets page.plan = { left, right, top, bottom, extraHeight }.
 */
function planMargins(pages) {
  const groups = new Map();
  for (const page of pages) {
    const flow = page.blocks.filter((b) => !b.overlaps);
    const plan = { flow: flow.length > 0, left: 36, right: 36, top: 36, bottom: 36, extraHeight: 0 };
    if (plan.flow) {
      // Text edges: a table reaches beyond them by its cell margin.
      const leftEdge = (b) => (b.type === 'table' ? b.x0 + (b.table.marL || 0) : b.x0);
      const rightEdge = (b) => (b.type === 'table' ? b.x1 - (b.table.marR || 0) : b.x1);
      // The outermost edge that a table or at least three lines share
      // defines the text area; a stray label further out does not.
      const defined = (edge, values) => {
        for (const at of values) {
          const near = flow.filter((b) => Math.abs(edge(b) - at) <= 1);
          if (near.length >= 3 || near.some((b) => b.type === 'table')) return at;
        }
        return null;
      };
      const lefts = flow.map(leftEdge).sort((x, y) => x - y);
      const rights = flow.map(rightEdge).sort((x, y) => y - x);
      const ownL = defined(leftEdge, lefts);
      const ownR = defined(rightEdge, rights);
      plan.ownLeft = ownL !== null;
      plan.ownRight = ownR !== null;
      plan.minX = Math.max(0, Math.min(page.width / 2, plan.ownLeft ? ownL : lefts[0]));
      plan.maxX = Math.min(page.width, Math.max(plan.minX + 1, plan.ownRight ? ownR : rights[0]));
      plan.first = Math.max(0, Math.min(...flow.map((b) => b.top)) - 1);
      plan.room = Math.max(0, page.height - Math.max(...flow.map((b) => b.bottom)));
    }
    page.plan = plan;
    const key = `${Math.round(page.width)}x${Math.round(page.height)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(page);
  }
  for (const list of groups.values()) {
    const used = list.filter((pg) => pg.plan.flow).map((pg) => pg.plan);
    if (!used.length) continue;
    const width = list[0].width;
    const anyLeft = used.some((pl) => pl.ownLeft);
    const anyRight = used.some((pl) => pl.ownRight);
    const lefts = clusterValues((anyLeft ? used.filter((pl) => pl.ownLeft) : used).map((pl) => pl.minX), Math.min);
    const rights = clusterValues((anyRight ? used.filter((pl) => pl.ownRight) : used).map((pl) => pl.maxX), Math.max);
    // An edge no content defines (short lines only) mirrors the other one.
    const farLeft = Math.min(...used.map((pl) => pl.minX));
    const farRight = Math.max(...used.map((pl) => pl.maxX));
    if (!anyLeft && !anyRight) {
      const m = Math.max(0, Math.min(farLeft, width - farRight));
      lefts.common = m;
      rights.common = width - m;
    } else if (!anyRight) rights.common = Math.max(farRight, width - lefts.common);
    else if (!anyLeft) lefts.common = Math.max(0, Math.min(farLeft, width - rights.common));
    const top = Math.min(...used.map((pl) => pl.first));
    // Below the content: the 1 pt paragraph that ends the page plus some
    // reserve, so that a slightly taller rendering never spills onto a new
    // page; the rest is the bottom margin (kept as large as possible, since
    // printers complain about very small margins).
    const bottom = Math.max(0, Math.min(43, ...used.map((pl) => pl.room - Math.max(6, pl.room * 0.3))));
    for (const page of list) {
      const pl = page.plan;
      let minX = lefts.common;
      let maxX = rights.common;
      if (pl.flow) {
        if (pl.ownLeft) minX = lefts.snap(pl.minX);
        else if (pl.minX < minX - 0.5) minX = pl.minX;
        if (pl.ownRight) maxX = rights.snap(pl.maxX);
        else if (pl.maxX > maxX + 0.5) maxX = pl.maxX;
      }
      if (maxX - minX < 36) {
        minX = Math.min(minX, pl.flow ? pl.minX : minX);
        maxX = Math.max(maxX, pl.flow ? pl.maxX : maxX, minX + 36);
      }
      pl.left = Math.floor(Math.max(0, minX) * 20) / 20;
      pl.right = Math.max(0, Math.floor((page.width - maxX) * 20) / 20);
      pl.top = Math.floor(top * 20) / 20;
      pl.bottom = Math.floor(bottom * 20) / 20;
      // Content that reaches the bottom edge: make the page a trifle taller
      // rather than let the last paragraph fall onto a new page.
      const spare = pl.flow ? pl.room - pl.bottom - 1.2 : 1;
      if (spare < 0) pl.extraHeight = Math.ceil(-spare * 20) / 20;
    }
  }
}

/**
 * pages: results of layoutPage(); image floats carry `data: { bytes, ext }`.
 */
export function buildLayoutDocx(pages, { title = '', author = 'PDF Edit' } = {}) {
  const defaults = dominantStyle(pages);
  const media = [];
  const mediaByKey = new Map();
  let nextId = 1;
  const body = [];

  const addMedia = (data) => {
    // The same picture on several pages is stored once.
    let hash = 0x811c9dc5;
    for (let i = 0; i < data.bytes.length; i++) hash = Math.imul(hash ^ data.bytes[i], 0x01000193);
    const key = `${data.bytes.length}:${hash >>> 0}:${data.ext}`;
    let m = mediaByKey.get(key);
    if (!m) {
      const n = media.length + 1;
      m = { name: `image${n}.${data.ext === 'jpeg' ? 'jpeg' : 'png'}`, bytes: data.bytes, rid: `rIdImg${n}` };
      media.push(m);
      mediaByKey.set(key, m);
    }
    return m.rid;
  };

  planMargins(pages);
  pages.forEach((page, pi) => {
    const lastPage = pi === pages.length - 1;
    const flow = page.blocks.filter((b) => !b.overlaps);
    const floatingTables = page.blocks.filter((b) => b.overlaps);
    const { left, right, top, bottom, extraHeight } = page.plan;
    const ctx = { originX: left, yTw: tw(top), defaults, areaLeft: left, areaRight: page.width - right, clampIndent: false };
    for (const b of flow) if (b.type === 'para') b.para.align = alignmentOf(b.para, ctx.areaLeft, ctx.areaRight);

    // ---- floating objects, anchored in the first paragraph of the page
    const drawings = [];
    page.floats.forEach((f, k) => {
      const id = nextId++;
      const opts = { z: k * 16, behind: false };
      if (f.type === 'image') {
        if (!f.data || !f.data.bytes) return;
        opts.behind = overlapsText(f, page);
        drawings.push(pictureXml(f, id, addMedia(f.data), opts));
      } else if (f.type === 'line') {
        drawings.push(lineShapeXml(f, id, opts));
      } else if (f.type === 'rect') {
        opts.behind = true;
        drawings.push(rectShapeXml(f, id, opts));
      } else if (f.type === 'path') {
        opts.behind = !!f.fill && overlapsText({ x: f.bbox[0], y: f.bbox[1], w: f.bbox[2] - f.bbox[0], h: f.bbox[3] - f.bbox[1] }, page);
        drawings.push(pathShapeXml(f, id, opts));
      } else if (f.type === 'textbox') {
        drawings.push(textBoxXml(f, id, opts, defaults));
      }
    });

    for (const b of floatingTables) drawings.push(tableBoxXml(b, nextId++, { z: 0, behind: false }, defaults));

    // ---- flow
    const items = [];
    const anchor = { kind: 'spacer', height: 20, after: 0, content: drawings.join('') };
    items.push(anchor);
    ctx.yTw += 20;
    let lastPara = anchor;
    for (const b of flow) {
      if (b.type === 'table') {
        const gap = tw(b.top) - ctx.yTw;
        if (lastPara) {
          if (gap > 0) {
            lastPara.after = (lastPara.after || 0) + gap;
            ctx.yTw += gap;
          }
        } else {
          // Two tables in a row need a paragraph between them.
          const h = Math.max(20, gap);
          items.push({ kind: 'spacer', height: h, after: 0, content: '' });
          ctx.yTw += h;
        }
        items.push({ kind: 'xml', xml: tableXml(b, ctx) });
        ctx.yTw = Math.max(ctx.yTw, tw(b.bottom));
        lastPara = null;
      } else {
        const item = { kind: 'line', para: b.para, after: 0, ctxBefore: ctx.yTw };
        // Positions are resolved now; the XML is produced later so that the
        // spacing after the paragraph can still change.
        const topTw = tw(b.para.top);
        item.before = Math.max(0, topTw - ctx.yTw);
        item.lineTw = Math.max(10, tw(b.para.height));
        ctx.yTw += item.before + item.lineTw;
        items.push(item);
        lastPara = item;
      }
    }
    const sectPr =
      `<w:sectPr><w:pgSz w:w="${tw(page.width)}" w:h="${tw(page.height + extraHeight)}"${page.width > page.height ? ' w:orient="landscape"' : ''}/>` +
      `<w:pgMar w:top="${tw(top)}" w:right="${tw(right)}" w:bottom="${tw(bottom)}" w:left="${tw(left)}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`;
    // The paragraph that ends the section (and the page).
    items.push({ kind: 'spacer', height: 20, after: 0, content: '', sectPr: lastPage ? '' : sectPr });

    for (const it of items) {
      if (it.kind === 'xml') body.push(it.xml);
      else if (it.kind === 'spacer') body.push(spacerPara(it.height, { after: it.after || 0, content: it.content, sectPr: it.sectPr || '' }));
      else {
        const lctx = { ...ctx, yTw: it.ctxBefore };
        body.push(linePara(it.para, lctx, { after: it.after || 0 }));
      }
    }
    if (lastPage) body.push(sectPr);
  });

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body.join('')}</w:body></w:document>`;

  const fam = escXml(defaults.family);
  const styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${fam}" w:hAnsi="${fam}" w:eastAsia="${fam}" w:cs="${fam}"/><w:noProof/><w:sz w:val="${defaults.sz}"/><w:szCs w:val="${defaults.sz}"/></w:rPr></w:rPrDefault>` +
    '<w:pPrDefault><w:pPr><w:widowControl w:val="0"/><w:autoSpaceDE w:val="0"/><w:autoSpaceDN w:val="0"/><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>' +
    '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
    '</w:styles>';
  const settings =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/>' +
    '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>' +
    '<w:compatSetting w:name="overrideTableStyleFontSizeAndJustification" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/>' +
    '<w:compatSetting w:name="enableOpenTypeFeatures" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/>' +
    '<w:compatSetting w:name="doNotFlipMirrorIndents" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/>' +
    '<w:compatSetting w:name="differentiateMultirowTableHeaders" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/></w:compat>' +
    '</w:settings>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>' +
    media.map((m) => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join('') +
    '</Relationships>';
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const core =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${escXml(title)}</dc:title><dc:creator>${escXml(author)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
  const app =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>PDF Edit</Application></Properties>';
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';
  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>';
  const files = {
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rootRels),
    'docProps/core.xml': strToU8(core),
    'docProps/app.xml': strToU8(app),
    'word/document.xml': strToU8(documentXml),
    'word/styles.xml': strToU8(styles),
    'word/settings.xml': strToU8(settings),
    'word/_rels/document.xml.rels': strToU8(rels),
  };
  for (const m of media) files[`word/media/${m.name}`] = [m.bytes, { level: 0 }];
  return zipSync(files, { level: 6 });
}
