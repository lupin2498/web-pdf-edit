// Page marks: watermark, background, header/footer and Bates numbering.
// They are drawn as page content wrapped in /Artifact marked content so they
// can be found (and removed) later.
import { fmt, rgbOp, matrixStr } from './graphics.js';
import { frameForRect, localToUser } from './text-layout.js';

export const MARK_TYPES = new Set(['watermark', 'background', 'headerFooter', 'bates']);

export const ARTIFACT_SUBTYPE = {
  watermark: 'Watermark',
  background: 'Background',
  headerFooter: 'Header',
  bates: 'BatesN',
};

function pad(n, digits) {
  return String(n).padStart(digits, '0');
}

export function formatDateToken(d, fmtStr = 'dd/mm/yyyy') {
  const dd = pad(d.getDate(), 2);
  const mm = pad(d.getMonth() + 1, 2);
  const yyyy = String(d.getFullYear());
  return fmtStr.replace('dd', dd).replace('mm', mm).replace('yyyy', yyyy);
}

// Replaces <<page>>, <<total>>, <<date>>, <<file>> and <<bates>> tokens.
export function expandTokens(template, ctx) {
  return String(template || '')
    .replace(/<<page>>/gi, String(ctx.pageNumber))
    .replace(/<<total>>/gi, String(ctx.pageCount))
    .replace(/<<date>>/gi, formatDateToken(ctx.date || new Date(), ctx.dateFormat))
    .replace(/<<file>>/gi, ctx.fileName || '')
    .replace(/<<bates>>/gi, ctx.bates || '');
}

export function batesLabel(obj, ctx) {
  const n = (obj.start || 1) + (ctx.pageNumber - 1) - (obj.firstPageNumber ? obj.firstPageNumber - 1 : 0);
  return `${obj.prefix || ''}${pad(n, obj.digits || 6)}${obj.suffix || ''}`;
}

// Layout description of a mark for a page view: list of drawable items in
// user space. Shared by the PDF writer and the on-screen preview.
// Items: {kind:'rect', rect, color, opacity} | {kind:'text', text, x, y (baseline origin), angle (deg, user space), size, font, color, opacity}
//        | {kind:'image', asset, matrix, opacity}
export function layoutMark(obj, { view, rotation, pageNumber, pageCount, fileName, date }, measure) {
  const frame = frameForRect(view, rotation);
  const W = frame.width;
  const H = frame.height;
  // Angle of the page's "right" direction in user space.
  const baseAngle = (Math.atan2(frame.right[1], frame.right[0]) * 180) / Math.PI;
  const ctx = { pageNumber, pageCount, fileName, date, dateFormat: obj.dateFormat };
  const items = [];
  if (obj.type === 'background') {
    if (obj.asset) {
      const m = imageMatrixFor(frame, 0, 0, W, H);
      items.push({ kind: 'image', asset: obj.asset, matrix: m, opacity: obj.opacity ?? 1 });
    } else {
      items.push({ kind: 'rect', rect: view.slice(), color: obj.color || [1, 1, 0.9], opacity: obj.opacity ?? 1 });
    }
    return items;
  }
  if (obj.type === 'watermark') {
    const pos = positionFor(obj.position || 'center', W, H, obj.offsetX || 0, obj.offsetY || 0);
    const angle = obj.angle || 0;
    if (obj.asset) {
      const w = (obj.imageWidth || 200) * (obj.scale || 1);
      const hh = (obj.imageHeight || 100) * (obj.scale || 1);
      // Rotate around the anchor point (counterclockwise in view terms).
      const c = localToUser(frame, pos[0], pos[1]);
      const rad = ((baseAngle + angle) * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const m = [w * cos, w * sin, -hh * sin, hh * cos, c[0] - (w / 2) * cos + (hh / 2) * sin, c[1] - (w / 2) * sin - (hh / 2) * cos];
      items.push({ kind: 'image', asset: obj.asset, matrix: m, opacity: obj.opacity ?? 0.3 });
    } else {
      const size = obj.size || 48;
      const lines = String(obj.text || '').split(/\r?\n/);
      const lh = size * 1.15;
      const c = localToUser(frame, pos[0], pos[1]);
      const rad = ((baseAngle + angle) * Math.PI) / 180;
      const dir = [Math.cos(rad), Math.sin(rad)];
      const up = [-dir[1], dir[0]];
      lines.forEach((line, i) => {
        const w = measure(line, obj.font) * size;
        // Center the block of lines around the anchor.
        const v = (lines.length - 1) * lh * 0.5 - i * lh - size * 0.35;
        const x = c[0] - dir[0] * (w / 2) + up[0] * v;
        const y = c[1] - dir[1] * (w / 2) + up[1] * v;
        items.push({ kind: 'text', text: line, x, y, angle: baseAngle + angle, size, font: obj.font, color: obj.color || [0.8, 0.1, 0.1], opacity: obj.opacity ?? 0.3 });
      });
    }
    return items;
  }
  if (obj.type === 'headerFooter' || obj.type === 'bates') {
    const size = obj.size || 10;
    const m = obj.margins || { top: 28, bottom: 28, left: 36, right: 36 };
    const slots = obj.type === 'bates' ? { [obj.slot || 'br']: '<<bates>>' } : obj.slots || {};
    const tokenCtx = { ...ctx, bates: obj.type === 'bates' ? batesLabel(obj, ctx) : '' };
    for (const [slot, template] of Object.entries(slots)) {
      if (!template) continue;
      const text = expandTokens(template, { ...tokenCtx, pageNumber: pageNumber + (obj.startNumber ? obj.startNumber - 1 : 0) });
      const w = measure(text, obj.font) * size;
      const top = slot[0] === 't';
      const v = top ? m.top + size * 0.8 : H - m.bottom;
      let u;
      if (slot[1] === 'l') u = m.left;
      else if (slot[1] === 'r') u = W - m.right - w;
      else u = (W - w) / 2;
      const p = localToUser(frame, u, v);
      items.push({ kind: 'text', text, x: p[0], y: p[1], angle: baseAngle, size, font: obj.font, color: obj.color || [0, 0, 0], opacity: obj.opacity ?? 1 });
    }
    return items;
  }
  return items;
}

function positionFor(position, W, H, ox, oy) {
  const map = {
    center: [W / 2, H / 2],
    top: [W / 2, H * 0.18],
    bottom: [W / 2, H * 0.82],
    tl: [W * 0.25, H * 0.2],
    tr: [W * 0.75, H * 0.2],
    bl: [W * 0.25, H * 0.8],
    br: [W * 0.75, H * 0.8],
  };
  const p = map[position] || map.center;
  return [p[0] + ox, p[1] + oy];
}

function imageMatrixFor(frame, u, v, w, h) {
  const o = localToUser(frame, u, v + h);
  return [w * frame.right[0], w * frame.right[1], -h * frame.down[0], -h * frame.down[1], o[0], o[1]];
}

/**
 * Produces content operators for a mark.
 * ctx: { view, rotation, pageNumber, pageCount, fileName, date }
 * helpers: { getShaper(font, text), embedFace(desc), embedImage(assetId), collector }
 */
export async function markOps(obj, ctx, helpers) {
  const { collector } = helpers;
  const shapers = new Map();
  const shaperFor = async (font, text) => {
    const key = `${font?.family}|${font?.bold}|${font?.italic}|${text}`;
    if (!shapers.has(key)) shapers.set(key, await helpers.getShaper(font || {}, text));
    return shapers.get(key);
  };
  // Pre-load shapers so the synchronous measure function works.
  const texts = collectTexts(obj, ctx);
  for (const tx of texts) await shaperFor(obj.font, tx);
  const measure = (text, font) => {
    const s = shapers.get(`${font?.family}|${font?.bold}|${font?.italic}|${text}`);
    return s ? s.measure(text) : text.length * 0.5;
  };
  const items = layoutMark(obj, ctx, measure);
  const subtype = ARTIFACT_SUBTYPE[obj.type] || 'Watermark';
  const type = obj.type === 'headerFooter' || obj.type === 'bates' ? 'Pagination' : obj.type === 'background' ? 'Background' : 'Pagination';
  const ops = [`/Artifact <</Type /${type} /Subtype /${subtype}>> BDC`, 'q'];
  for (const it of items) {
    const gs = collector.opacity(it.opacity ?? 1);
    ops.push('q');
    if (gs) ops.push(`/${gs} gs`);
    if (it.kind === 'rect') {
      ops.push(rgbOp(it.color), `${fmt(it.rect[0])} ${fmt(it.rect[1])} ${fmt(it.rect[2] - it.rect[0])} ${fmt(it.rect[3] - it.rect[1])} re f`);
    } else if (it.kind === 'image') {
      const image = await helpers.embedImage(it.asset);
      const key = collector.xobject(image.ref);
      ops.push(`${matrixStr(it.matrix)} cm`, `/${key} Do`);
    } else if (it.kind === 'text' && it.text) {
      const shaper = await shaperFor(obj.font, it.text);
      const rad = (it.angle * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      ops.push(rgbOp(it.color), 'BT');
      let x = 0;
      for (const run of shaper.runs(it.text)) {
        const font = await helpers.embedFace(run.face.descriptor);
        const key = collector.font(font.ref);
        const px = it.x + cos * x;
        const py = it.y + sin * x;
        const skew = run.face.synthItalic || shaper.synthItalic ? 0.21 : 0;
        ops.push(`/${key} ${fmt(it.size)} Tf`);
        ops.push(run.face.synthBold || shaper.synthBold ? `2 Tr ${fmt(it.size * 0.035)} w ${rgbOp(it.color, true)}` : '0 Tr');
        ops.push(`${matrixStr([cos, sin, -sin + skew * cos, cos + skew * sin, px, py])} Tm`);
        ops.push(`${font.encodeText(run.text).toString()} Tj`);
        x += run.face.metrics.measure(run.text) * it.size;
      }
      ops.push('ET');
    }
    ops.push('Q');
  }
  ops.push('Q', 'EMC');
  return ops.join('\n');
}

export function collectTexts(obj, ctx) {
  if (obj.type === 'watermark' && !obj.asset) return String(obj.text || '').split(/\r?\n/);
  if (obj.type === 'headerFooter' || obj.type === 'bates') {
    const tokenCtx = { ...ctx, dateFormat: obj.dateFormat, bates: obj.type === 'bates' ? batesLabel(obj, ctx) : '' };
    const slots = obj.type === 'bates' ? { [obj.slot || 'br']: '<<bates>>' } : obj.slots || {};
    return Object.values(slots)
      .filter(Boolean)
      .map((tpl) => expandTokens(tpl, { ...tokenCtx, pageNumber: ctx.pageNumber + (obj.startNumber ? obj.startNumber - 1 : 0) }));
  }
  return [];
}
