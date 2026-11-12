// Renders editor objects on top of pages and handles selection, moving,
// resizing and in-place text editing.
import { h, clear, svgEl, cssColor, clamp } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { CSS_UNITS } from '../pdf/pdfjs.js';
import { viewRect, userRect } from './viewport.js';
import { getShaper, cssNameFor } from '../pdf/fonts.js';
import { layoutTextBox, frameForRect, localToUser } from '../../../core/text-layout.js';
import { arrowHeadPoints } from '../../../core/graphics.js';
import { stampLabelLayout } from '../../../core/annotations.js';
import { MARK_TYPES, layoutMark, collectTexts } from '../../../core/page-marks.js';
import { t } from '../i18n.js';

const BOX_TYPES = new Set(['text', 'image', 'freetext', 'rect', 'ellipse', 'stamp', 'signature', 'link', 'redact', 'whiteout', 'box', 'note']);
const POINT_TYPES = new Set(['line', 'arrow']);
const PATH_TYPES = new Set(['polyline', 'polygon', 'ink']);
const MARKUP_TYPES = new Set(['highlight', 'underline', 'strikeout', 'squiggly']);

export function objectBounds(obj) {
  if (obj.rect) return obj.rect.slice();
  if (POINT_TYPES.has(obj.type)) {
    const w = (obj.width || 2) * 3;
    return [Math.min(obj.p1[0], obj.p2[0]) - w, Math.min(obj.p1[1], obj.p2[1]) - w, Math.max(obj.p1[0], obj.p2[0]) + w, Math.max(obj.p1[1], obj.p2[1]) + w];
  }
  const pts = obj.type === 'ink' ? obj.paths.flat() : obj.points || [];
  if (MARKUP_TYPES.has(obj.type)) {
    const r = obj.rects;
    return [Math.min(...r.map((x) => x[0])), Math.min(...r.map((x) => x[1])), Math.max(...r.map((x) => x[2])), Math.max(...r.map((x) => x[3]))];
  }
  if (!pts.length) return [0, 0, 0, 0];
  const w = (obj.width || 2) * 1.5;
  return [Math.min(...pts.map((p) => p[0])) - w, Math.min(...pts.map((p) => p[1])) - w, Math.max(...pts.map((p) => p[0])) + w, Math.max(...pts.map((p) => p[1])) + w];
}

// Applies a user-space translation to an object (returns patch).
export function translateObject(obj, dx, dy) {
  const mv = (p) => [p[0] + dx, p[1] + dy];
  const patch = {};
  if (obj.rect) patch.rect = [obj.rect[0] + dx, obj.rect[1] + dy, obj.rect[2] + dx, obj.rect[3] + dy];
  if (obj.p1) patch.p1 = mv(obj.p1);
  if (obj.p2) patch.p2 = mv(obj.p2);
  if (obj.points) patch.points = obj.points.map(mv);
  if (obj.paths) patch.paths = obj.paths.map((path) => path.map(mv));
  if (obj.rects) patch.rects = obj.rects.map((r) => [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]);
  return patch;
}

// Maps an object's geometry from one bounding box to another (resize).
export function scaleObject(obj, from, to) {
  const sx = (to[2] - to[0]) / Math.max(1e-6, from[2] - from[0]);
  const sy = (to[3] - to[1]) / Math.max(1e-6, from[3] - from[1]);
  const mp = (p) => [to[0] + (p[0] - from[0]) * sx, to[1] + (p[1] - from[1]) * sy];
  const patch = {};
  if (obj.rect) patch.rect = to.slice();
  if (obj.p1) patch.p1 = mp(obj.p1);
  if (obj.p2) patch.p2 = mp(obj.p2);
  if (obj.points) patch.points = obj.points.map(mp);
  if (obj.paths) patch.paths = obj.paths.map((path) => path.map(mp));
  return patch;
}

export class Overlay {
  constructor(docView) {
    this.docView = docView;
    this.selection = null; // {pageUid, kind: 'object'|'annot'|'image', id}
    this.editing = null; // {id, el, pageUid}
    this.hidden = new Set();
    this.temp = new Map(); // id -> temporary geometry during drags
  }

  get session() {
    return this.docView.session;
  }

  get viewer() {
    return this.docView.viewer;
  }

  scale() {
    return this.viewer.scale * CSS_UNITS;
  }

  clearPage(pv) {
    if (this.editing && this.editing.pageUid === pv.entry.uid) return;
    clear(pv.objectsLayer);
  }

  scaleChanged() {
    for (const pv of this.viewer.pageViews.values()) {
      if (pv.visible || pv.objectsLayer.firstChild) this.renderPage(pv);
    }
  }

  refreshPages(uids) {
    for (const uid of uids) {
      const pv = this.viewer.pageViews.get(uid);
      if (pv && (pv.visible || pv.objectsLayer.firstChild)) this.renderPage(pv);
    }
  }

  refreshAll() {
    for (const pv of this.viewer.pageViews.values()) if (pv.visible) this.renderPage(pv);
  }

  renderPage(pv) {
    const entry = this.session.page(pv.entry.uid) || pv.entry;
    const layer = pv.objectsLayer;
    const editor = this.editing && this.editing.pageUid === entry.uid ? this.editing.el : null;
    // The text editor stays attached: detaching it would drop the focus (and
    // commit the edit) while the user is typing.
    const keepEditor = editor && editor.parentNode === layer ? editor : null;
    for (const child of [...layer.children]) if (child !== keepEditor) child.remove();
    if (editor && !keepEditor) layer.appendChild(editor);
    if (!pv.geometry) return;
    const vp = pv.getViewport();
    const token = (pv.overlayToken = (pv.overlayToken || 0) + 1);
    // Existing annotations from the source page (selectable for move/delete).
    if (entry.src && this.docView.annotationsSelectable()) {
      this.session.getSourceAnnotations(entry).then((annots) => {
        if (token !== pv.overlayToken) return;
        const edits = entry.annotEdits || {};
        for (const a of annots) {
          if (!a.rect || a.annotationType === 20 /* widget */ || a.subtype === 'Popup' || a.subtype === 'Link' || a.subtype === 'Widget') continue;
          const e = edits[a.id];
          if (e && e.deleted) continue;
          const rect = [a.rect[0] + (e?.dx || 0), a.rect[1] + (e?.dy || 0), a.rect[2] + (e?.dx || 0), a.rect[3] + (e?.dy || 0)];
          const vr = viewRect(vp, rect);
          const el = h('div', {
            class: 'obj existing-annot',
            dataset: { annot: a.id },
            title: [a.titleObj?.str, a.contentsObj?.str].filter(Boolean).join(': '),
            style: { left: `${vr.left}px`, top: `${vr.top}px`, width: `${Math.max(4, vr.width)}px`, height: `${Math.max(4, vr.height)}px` },
          });
          layer.insertBefore(el, layer.firstChild);
          if (this.selection && this.selection.kind === 'annot' && this.selection.id === a.id && this.selection.pageUid === entry.uid) this.drawSelection(pv, rect, { kind: 'annot', annot: a });
        }
      });
    }
    for (const obj of entry.objects || []) {
      if (this.hidden.has(obj.id)) continue;
      const o = this.temp.get(obj.id) ? { ...obj, ...this.temp.get(obj.id) } : obj;
      const el = this.buildObject(pv, vp, o);
      if (el) layer.insertBefore(el, editor);
    }
    if (this.selection && this.selection.pageUid === entry.uid && this.selection.kind === 'object') {
      const obj = (entry.objects || []).find((x) => x.id === this.selection.id);
      if (obj) {
        const o = this.temp.get(obj.id) ? { ...obj, ...this.temp.get(obj.id) } : obj;
        this.drawSelection(pv, objectBounds(o), { kind: 'object', obj: o });
      } else this.selection = null;
    }
  }

  // ------------------------------------------------------------------ builders

  buildObject(pv, vp, obj) {
    if (MARK_TYPES.has(obj.type)) return this.buildMark(pv, vp, obj);
    const s = this.scale();
    const viewRot = pv.geometry.rotation;
    const bounds = objectBounds(obj);
    const vr = viewRect(vp, bounds);
    const el = h('div', { class: `obj ${obj.type}-obj`, dataset: { id: obj.id }, style: { left: `${vr.left}px`, top: `${vr.top}px`, width: `${vr.width}px`, height: `${vr.height}px` } });
    if (obj.opacity !== undefined && obj.opacity < 1 && !MARKUP_TYPES.has(obj.type) && obj.type !== 'highlight') el.style.opacity = obj.opacity;
    const inner = (fw, fh, rot) => {
      const disp = (((viewRot - (rot || 0)) % 360) + 360) % 360;
      const box = h('div', {
        class: 'obj-inner',
        style: { width: `${fw * s}px`, height: `${fh * s}px`, transform: `translate(-50%, -50%) rotate(${disp}deg)` },
      });
      el.appendChild(box);
      return box;
    };
    switch (obj.type) {
      case 'text':
      case 'freetext': {
        el.classList.add('text-obj');
        const f = frameForRect(obj.rect, obj.rot || 0);
        const box = inner(f.width, f.height, obj.rot);
        if (obj.type === 'freetext') {
          if (obj.fill) box.style.background = cssColor(obj.fill);
          if (obj.border) box.style.boxShadow = `inset 0 0 0 ${Math.max(1, (obj.borderWidth ?? 1) * s)}px ${cssColor(obj.border)}`;
        } else if (obj.fill) box.style.background = cssColor(obj.fill);
        if (this.editing && this.editing.id === obj.id) el.classList.add('editing');
        this.renderTextInto(box, obj, f, s);
        break;
      }
      case 'image':
      case 'signature':
      case 'stamp': {
        const f = frameForRect(obj.rect, obj.rot || 0);
        const box = inner(f.width, f.height, obj.rot);
        if (obj.asset) {
          const asset = this.session.assets.get(obj.asset);
          if (asset) box.appendChild(h('img', { src: asset.url, draggable: 'false', style: { width: '100%', height: '100%', display: 'block', pointerEvents: 'none' } }));
        } else {
          this.renderTextStamp(box, obj, f, s);
        }
        break;
      }
      case 'note': {
        el.classList.add('note-obj');
        const c = obj.color || [1, 0.85, 0.2];
        const ico = icon('note');
        ico.style.cssText = `width:100%;height:100%;color:#333;background:${cssColor(c)};border-radius:3px;padding:1px`;
        el.appendChild(ico);
        el.title = obj.contents || '';
        break;
      }
      case 'link':
        el.classList.add('link-obj');
        el.title = obj.action?.type === 'url' ? obj.action.url : t('link.toPage');
        break;
      case 'redact':
        el.classList.add('redact-obj');
        if (obj.applied) el.classList.add('applied');
        break;
      case 'whiteout':
      case 'box':
        el.style.background = cssColor(obj.fill || [1, 1, 1]);
        if (obj.type === 'whiteout') el.style.boxShadow = '0 0 0 1px rgba(127,127,127,0.25)';
        break;
      case 'highlight':
      case 'underline':
      case 'strikeout':
      case 'squiggly':
        el.classList.add('markup');
        this.renderMarkup(el, vp, obj, vr);
        break;
      default:
        this.renderVector(el, vp, obj, vr, s);
    }
    return el;
  }

  buildMark(pv, vp, obj) {
    const el = h('div', { class: 'obj pass mark-obj', dataset: { id: obj.id }, style: { left: '0', top: '0', width: '100%', height: '100%' } });
    const index = this.session.pageIndex(pv.entry.uid);
    const ctx = { view: pv.geometry.view, rotation: pv.geometry.rotation, pageNumber: index + 1, pageCount: this.session.state.pages.length, fileName: this.session.name, date: new Date() };
    const texts = collectTexts(obj, ctx);
    Promise.all(texts.map((tx) => getShaper(obj.font || {}, tx))).then((shapers) => {
      const map = new Map(texts.map((tx, i) => [tx, shapers[i]]));
      const measure = (text) => (map.get(text) ? map.get(text).measure(text) : text.length * 0.5);
      const items = layoutMark(obj, ctx, measure);
      const svg = svgEl('svg', { width: '100%', height: '100%', style: 'overflow:visible;pointer-events:none;position:absolute;left:0;top:0' });
      const m = vp.transform;
      for (const it of items) {
        if (it.kind === 'rect') {
          const vr = viewRect(vp, it.rect);
          svg.appendChild(svgEl('rect', { x: vr.left, y: vr.top, width: vr.width, height: vr.height, fill: cssColor(it.color), 'fill-opacity': it.opacity, style: 'mix-blend-mode:multiply' }));
        } else if (it.kind === 'image') {
          const asset = this.session.assets.get(it.asset);
          if (!asset) continue;
          // unit square (SVG y down) -> PDF image space -> user space -> view.
          const flip = [1, 0, 0, -1, 0, 1];
          const mm = mulM(mulM(flip, it.matrix), m);
          svg.appendChild(svgEl('image', { href: asset.url, x: 0, y: 0, width: 1, height: 1, preserveAspectRatio: 'none', opacity: it.opacity, transform: `matrix(${mm.join(' ')})` }));
        } else if (it.kind === 'text') {
          const shaper = map.get(it.text);
          if (!shaper) continue;
          const p = vp.convertToViewportPoint(it.x, it.y);
          const rad = (it.angle * Math.PI) / 180;
          const q = vp.convertToViewportPoint(it.x + Math.cos(rad), it.y + Math.sin(rad));
          const ang = (Math.atan2(q[1] - p[1], q[0] - p[0]) * 180) / Math.PI;
          const g = svgEl('g', { transform: `translate(${p[0]} ${p[1]}) rotate(${ang})`, opacity: it.opacity });
          let x = 0;
          const fs = it.size * this.scale();
          for (const run of shaper.runs(it.text)) {
            const tEl = svgEl('text', { x, y: 0, 'font-family': `"${cssNameFor(run.face.descriptor)}"`, 'font-size': fs, fill: cssColor(it.color) });
            tEl.setAttribute('xml:space', 'preserve');
            if (run.face.synthBold || shaper.synthBold) {
              tEl.setAttribute('stroke', cssColor(it.color));
              tEl.setAttribute('stroke-width', fs * 0.035);
            }
            tEl.textContent = run.text;
            g.appendChild(tEl);
            x += run.face.metrics.measure(run.text) * fs;
          }
          svg.appendChild(g);
        }
      }
      el.appendChild(svg);
    });
    return el;
  }

  async renderTextInto(box, obj, frame, s) {
    const shaper = await getShaper(obj.font || {}, obj.text || '');
    const padding = obj.type === 'freetext' ? obj.padding ?? 4 : 0;
    const size = obj.size || 12;
    const layout = layoutTextBox({
      text: obj.text || '',
      measure: shaper.measure,
      size,
      boxWidth: frame.width,
      wrap: obj.wrap !== false,
      align: obj.align || 'left',
      lineHeight: obj.lineHeight || 1.2,
      ascent: shaper.metrics.ascent,
      descent: shaper.metrics.descent,
      padding,
    });
    const svg = svgEl('svg', { class: 'text-svg', width: frame.width * s, height: frame.height * s, viewBox: `0 0 ${frame.width} ${frame.height}`, style: 'overflow:visible;pointer-events:none' });
    const color = cssColor(obj.color || [0, 0, 0]);
    for (const line of layout.lines) {
      if (!line.text) continue;
      let x = line.x;
      for (const run of shaper.runs(line.text)) {
        const name = cssNameFor(run.face.descriptor);
        const el = svgEl('text', { x, y: line.baseline, 'font-family': `"${name}"`, 'font-size': size, fill: color });
        el.setAttribute('xml:space', 'preserve');
        if (run.face.synthBold || shaper.synthBold) {
          el.setAttribute('stroke', color);
          el.setAttribute('stroke-width', size * 0.035);
        }
        if (run.face.synthItalic || shaper.synthItalic) el.setAttribute('transform', `translate(${x} ${line.baseline}) skewX(-11.9) translate(${-x} ${-line.baseline})`);
        el.textContent = run.text;
        svg.appendChild(el);
        x += run.face.metrics.measure(run.text) * size;
      }
      const deco = [];
      if (obj.underline) deco.push(0.12 * size);
      if (obj.strike) deco.push(-0.28 * size);
      for (const off of deco) {
        svg.appendChild(svgEl('line', { x1: line.x, x2: line.x + line.width, y1: line.baseline + off, y2: line.baseline + off, stroke: color, 'stroke-width': Math.max(0.5, size * 0.06) }));
      }
    }
    box.querySelectorAll('svg.text-svg').forEach((n) => n.remove());
    box.appendChild(svg);
  }

  async renderTextStamp(box, obj, f, s) {
    const label = obj.label || 'APPROVED';
    const sub = obj.subLabel || '';
    const c = cssColor(obj.color || [0.8, 0.1, 0.1]);
    const shaper = await getShaper({ family: obj.font?.family || 'Liberation Sans', bold: true }, label + sub);
    const bw = Math.max(1, Math.min(f.width, f.height) * 0.06);
    const svg = svgEl('svg', { width: f.width * s, height: f.height * s, viewBox: `0 0 ${f.width} ${f.height}`, style: 'overflow:visible;pointer-events:none' });
    svg.appendChild(svgEl('rect', { x: bw / 2, y: bw / 2, width: f.width - bw, height: f.height - bw, rx: Math.min(f.width, f.height) * 0.18, fill: 'none', stroke: c, 'stroke-width': bw }));
    const { ascent, descent } = shaper.metrics;
    for (const line of stampLabelLayout(f.width, f.height, label, sub, shaper.measure)) {
      const w = shaper.measure(line.text) * line.size;
      const y = line.top + (line.size - (ascent - descent) * line.size) / 2 + ascent * line.size;
      const el = svgEl('text', { x: (f.width - w) / 2, y, 'font-family': `"${cssNameFor(shaper.descriptor)}"`, 'font-size': line.size, fill: c });
      el.setAttribute('xml:space', 'preserve');
      el.textContent = line.text;
      svg.appendChild(el);
    }
    box.appendChild(svg);
  }

  renderMarkup(el, vp, obj, vr) {
    const color = obj.color || [1, 0.85, 0];
    const svg = svgEl('svg', { width: vr.width, height: vr.height, style: 'overflow:visible' });
    const toLocal = (x, y) => {
      const p = vp.convertToViewportPoint(x, y);
      return [p[0] - vr.left, p[1] - vr.top];
    };
    for (const r of obj.rects) {
      const f = frameForRect(r, obj.rot || 0);
      const rv = viewRect(vp, r);
      const hit = h('div', { class: 'markup-rect', style: { left: `${rv.left - vr.left}px`, top: `${rv.top - vr.top}px`, width: `${rv.width}px`, height: `${rv.height}px` } });
      el.appendChild(hit);
      if (obj.type === 'highlight') {
        const pts = [localToUser(f, 0, 0), localToUser(f, f.width, 0), localToUser(f, f.width, f.height), localToUser(f, 0, f.height)].map((p) => toLocal(...p));
        svg.appendChild(svgEl('polygon', { points: pts.map((p) => p.join(',')).join(' '), fill: cssColor(color), 'fill-opacity': obj.opacity ?? 1, style: 'mix-blend-mode:multiply' }));
      } else {
        const hgt = f.height;
        const lw = Math.max(0.6, hgt * 0.07) * this.scale();
        if (obj.type === 'squiggly') {
          const amp = Math.max(1, hgt * 0.06);
          const step = Math.max(2, hgt * 0.12);
          const base = hgt - amp * 1.5;
          const pts = [];
          let up = false;
          for (let u = 0; u <= f.width + 0.01; u += step) {
            pts.push(toLocal(...localToUser(f, Math.min(u, f.width), base + (up ? -amp : amp))));
            up = !up;
          }
          svg.appendChild(svgEl('polyline', { points: pts.map((p) => p.join(',')).join(' '), fill: 'none', stroke: cssColor(color), 'stroke-width': lw, 'stroke-opacity': obj.opacity ?? 1 }));
        } else {
          const v = obj.type === 'underline' ? hgt - hgt * 0.1 : hgt * 0.55;
          const a = toLocal(...localToUser(f, 0, v));
          const b = toLocal(...localToUser(f, f.width, v));
          svg.appendChild(svgEl('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: cssColor(color), 'stroke-width': lw, 'stroke-opacity': obj.opacity ?? 1 }));
        }
      }
    }
    el.insertBefore(svg, el.firstChild);
  }

  renderVector(el, vp, obj, vr, s) {
    const svg = svgEl('svg', { width: vr.width, height: vr.height, style: 'overflow:visible' });
    const toLocal = (p) => {
      const v = vp.convertToViewportPoint(p[0], p[1]);
      return [v[0] - vr.left, v[1] - vr.top];
    };
    const sw = (obj.width ?? 2) * s;
    const stroke = obj.stroke ? cssColor(obj.stroke) : 'none';
    const fill = obj.fill ? cssColor(obj.fill) : 'none';
    const dash = obj.dash ? `${Math.max(2, (obj.width ?? 2) * 3) * s} ${Math.max(2, (obj.width ?? 2) * 3) * s}` : null;
    const common = { stroke, 'stroke-width': sw, fill, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-dasharray': dash };
    const hitAttrs = { class: 'hit', stroke: 'transparent', 'stroke-width': Math.max(10, sw + 8), fill: 'none' };
    if (obj.type === 'rect') {
      svg.appendChild(svgEl('rect', { x: sw / 2, y: sw / 2, width: Math.max(0, vr.width - sw), height: Math.max(0, vr.height - sw), ...common }));
      el.style.pointerEvents = obj.fill ? 'auto' : 'none';
      svg.appendChild(svgEl('rect', { x: sw / 2, y: sw / 2, width: Math.max(0, vr.width - sw), height: Math.max(0, vr.height - sw), ...hitAttrs }));
    } else if (obj.type === 'ellipse') {
      svg.appendChild(svgEl('ellipse', { cx: vr.width / 2, cy: vr.height / 2, rx: Math.max(0.5, (vr.width - sw) / 2), ry: Math.max(0.5, (vr.height - sw) / 2), ...common }));
      el.style.pointerEvents = obj.fill ? 'auto' : 'none';
      svg.appendChild(svgEl('ellipse', { cx: vr.width / 2, cy: vr.height / 2, rx: Math.max(0.5, (vr.width - sw) / 2), ry: Math.max(0.5, (vr.height - sw) / 2), ...hitAttrs }));
    } else if (obj.type === 'line' || obj.type === 'arrow') {
      el.style.pointerEvents = 'none';
      const a = toLocal(obj.p1);
      const b = toLocal(obj.p2);
      svg.appendChild(svgEl('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], ...common, fill: 'none' }));
      svg.appendChild(svgEl('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], ...hitAttrs }));
      const heads = [
        [obj.startHead, obj.p2, obj.p1],
        [obj.endHead || (obj.type === 'arrow' ? 'OpenArrow' : 'None'), obj.p1, obj.p2],
      ];
      for (const [kind, from, tip] of heads) {
        if (!kind || kind === 'None') continue;
        const ah = arrowHeadPoints(from, tip, obj.width ?? 2, kind);
        const pts = ah.points.map(toLocal).map((p) => p.join(',')).join(' ');
        svg.appendChild(svgEl(ah.closed ? 'polygon' : 'polyline', { points: pts, stroke, 'stroke-width': sw, fill: ah.closed ? stroke : 'none', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      }
    } else if (obj.type === 'polyline' || obj.type === 'polygon') {
      el.style.pointerEvents = obj.type === 'polygon' && obj.fill ? 'auto' : 'none';
      const pts = obj.points.map(toLocal).map((p) => p.join(',')).join(' ');
      svg.appendChild(svgEl(obj.type, { points: pts, ...common, fill: obj.type === 'polygon' ? fill : 'none' }));
      svg.appendChild(svgEl(obj.type, { points: pts, ...hitAttrs }));
    } else if (obj.type === 'ink') {
      el.style.pointerEvents = 'none';
      for (const path of obj.paths) {
        const d = smoothSvgPath(path.map(toLocal));
        svg.appendChild(svgEl('path', { d, ...common, fill: 'none' }));
        svg.appendChild(svgEl('path', { d, ...hitAttrs }));
      }
    }
    el.appendChild(svg);
  }

  // ------------------------------------------------------------------ selection

  select(pageUid, id, kind = 'object', extra = null) {
    if (this.editing && this.editing.id !== id) this.commitEditing();
    const prev = this.selection;
    this.selection = id ? { pageUid, id, kind, ...(extra || {}) } : null;
    if (prev && prev.pageUid !== pageUid) this.refreshPages([prev.pageUid]);
    if (pageUid) this.refreshPages([pageUid]);
    this.docView.selectionChanged();
  }

  clearSelection() {
    if (!this.selection) return;
    const prev = this.selection;
    this.selection = null;
    this.refreshPages([prev.pageUid]);
    this.docView.selectionChanged();
  }

  selectedObject() {
    if (!this.selection || this.selection.kind !== 'object') return null;
    const page = this.session.page(this.selection.pageUid);
    if (!page) return null;
    return (page.objects || []).find((o) => o.id === this.selection.id) || null;
  }

  drawSelection(pv, bounds, { kind, obj = null, annot = null }) {
    const vp = pv.getViewport();
    const vr = viewRect(vp, bounds);
    const pad = 3;
    const box = h('div', { class: 'sel-box', style: { left: `${vr.left - pad}px`, top: `${vr.top - pad}px`, width: `${vr.width + pad * 2}px`, height: `${vr.height + pad * 2}px` } });
    const markup = obj && MARKUP_TYPES.has(obj.type);
    if (!markup && !(obj && this.editing && this.editing.id === obj.id)) {
      const move = h('div', { class: 'move-area' });
      box.appendChild(move);
      move.addEventListener('pointerdown', (e) => this.startDrag(e, pv, 'move', bounds, obj, annot));
      move.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        if (obj) this.docView.objectDoubleClicked(pv, obj, e);
        else if (annot) this.docView.annotDoubleClicked(pv, annot);
      });
      move.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.docView.objectContextMenu(e, pv, obj, annot);
      });
    } else {
      box.style.border = 'none';
    }
    if (obj && !markup && !(this.editing && this.editing.id === obj.id)) {
      if (POINT_TYPES.has(obj.type)) {
        box.classList.add('line-sel');
        for (const which of ['p1', 'p2']) {
          const p = vp.convertToViewportPoint(...obj[which]);
          const hd = h('div', { class: 'handle pt', style: { left: `${p[0] - vr.left + pad}px`, top: `${p[1] - vr.top + pad}px` } });
          hd.addEventListener('pointerdown', (e) => this.startDrag(e, pv, which, bounds, obj));
          box.appendChild(hd);
        }
      } else if (obj.type !== 'note') {
        const handles = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
        for (const [name, [fx, fy]] of Object.entries(handles)) {
          if ((obj.type === 'text' || obj.type === 'freetext') && (name === 'n' || name === 's')) continue;
          const hd = h('div', { class: `handle ${name}`, style: { left: `${fx * (vr.width + pad * 2)}px`, top: `${fy * (vr.height + pad * 2)}px` } });
          hd.addEventListener('pointerdown', (e) => this.startDrag(e, pv, name, bounds, obj));
          box.appendChild(hd);
        }
      }
    }
    pv.objectsLayer.appendChild(box);
  }

  startDrag(e, pv, mode, bounds, obj, annot) {
    if (e.button !== 0) return;
    if (this.docView.isReadOnly()) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const vp = pv.getViewport();
    const startPdf = vp.convertToPdfPoint(...this.localPoint(pv, e));
    const vb = viewRect(vp, bounds);
    const startView = this.localPoint(pv, e);
    let moved = false;
    let patch = null;
    let annotDelta = null;
    const onMove = (ev) => {
      const cur = this.localPoint(pv, ev);
      if (!moved && Math.hypot(cur[0] - startView[0], cur[1] - startView[1]) < 2) return;
      moved = true;
      const p = vp.convertToPdfPoint(...cur);
      if (mode === 'move') {
        let dx = p[0] - startPdf[0];
        let dy = p[1] - startPdf[1];
        if (ev.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        if (obj) {
          patch = translateObject(obj, dx, dy);
          this.temp.set(obj.id, patch);
        } else if (annot) {
          annotDelta = [dx, dy];
          this.temp.set(`annot:${annot.id}`, annotDelta);
          this.previewAnnotMove(pv, annot, dx, dy);
          return;
        }
      } else if (mode === 'p1' || mode === 'p2') {
        let np = p;
        if (ev.shiftKey) np = snapAngle(mode === 'p1' ? obj.p2 : obj.p1, p);
        patch = { [mode]: np };
        this.temp.set(obj.id, patch);
      } else {
        // Resize in view space then convert to user space.
        let { left, top, width, height } = vb;
        let right = left + width;
        let bottom = top + height;
        const dx = cur[0] - startView[0];
        const dy = cur[1] - startView[1];
        if (mode.includes('w')) left += dx;
        if (mode.includes('e')) right += dx;
        if (mode.includes('n')) top += dy;
        if (mode.includes('s')) bottom += dy;
        const keepAspect = ev.shiftKey || ((obj.type === 'image' || obj.type === 'signature' || obj.type === 'stamp') && mode.length === 2);
        if (keepAspect && width > 0 && height > 0) {
          const ratio = width / height;
          let nw = Math.abs(right - left);
          let nh = Math.abs(bottom - top);
          if (nw / nh > ratio) nw = nh * ratio;
          else nh = nw / ratio;
          if (mode.includes('w')) left = right - nw;
          else right = left + nw;
          if (mode.includes('n')) top = bottom - nh;
          else bottom = top + nh;
        }
        const nl = Math.min(left, right);
        const nt = Math.min(top, bottom);
        const nr = Math.max(left, right, nl + 4);
        const nb = Math.max(top, bottom, nt + 4);
        const to = userRect(vp, nl, nt, nr - nl, nb - nt);
        patch = scaleObject(obj, bounds, to);
        if (obj.type === 'text' || obj.type === 'freetext') {
          patch = { rect: to, wrap: true };
        }
        this.temp.set(obj.id, patch);
      }
      this.renderPage(pv);
    };
    const onUp = (ev) => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      try {
        target.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      if (obj) this.temp.delete(obj.id);
      if (annot) this.temp.delete(`annot:${annot.id}`);
      if (!moved) return;
      if (obj && patch) {
        if ((obj.type === 'text' || obj.type === 'freetext') && patch.rect) this.docView.commitTextResize(obj, patch);
        else this.session.updateObject(obj.id, patch, mode === 'move' ? 'moveObject' : 'resizeObject');
      } else if (annot && annotDelta) {
        this.docView.moveExistingAnnotation(pv.entry.uid, annot, annotDelta[0], annotDelta[1]);
      }
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  }

  previewAnnotMove(pv, annot, dx, dy) {
    const el = pv.objectsLayer.querySelector(`[data-annot="${CSS.escape(annot.id)}"]`);
    const sel = pv.objectsLayer.querySelector('.sel-box');
    const vp = pv.getViewport();
    const a = vp.convertToViewportPoint(0, 0);
    const b = vp.convertToViewportPoint(dx, dy);
    const tx = b[0] - a[0];
    const ty = b[1] - a[1];
    for (const n of [el, sel]) if (n) n.style.transform = `translate(${tx}px, ${ty}px)`;
  }

  localPoint(pv, e) {
    const r = pv.el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  // ------------------------------------------------------------------ text editing

  startEditing(pv, obj, clickEvent = null) {
    if (this.editing) this.commitEditing();
    const s = this.scale();
    const vp = pv.getViewport();
    const f = frameForRect(obj.rect, obj.rot || 0);
    const vr = viewRect(vp, obj.rect);
    const viewRot = pv.geometry.rotation;
    const disp = (((viewRot - (obj.rot || 0)) % 360) + 360) % 360;
    const padding = (obj.type === 'freetext' ? obj.padding ?? 4 : 0) * s;
    const editor = h('div', {
      class: 'text-editor',
      contenteditable: 'plaintext-only',
      spellcheck: 'false',
      dataset: { editing: obj.id },
    });
    const font = obj.font || {};
    getShaper(font, obj.text || '').then((shaper) => {
      const name = cssNameFor(shaper.descriptor);
      const fallbackNames = shaper.faces.slice(1).map((fc) => `"${cssNameFor(fc.descriptor)}"`);
      editor.style.fontFamily = [`"${name}"`, ...fallbackNames, 'sans-serif'].join(', ');
      if (shaper.synthBold) editor.style.fontWeight = '700';
      if (shaper.synthItalic) editor.style.fontStyle = 'italic';
    });
    const size = (obj.size || 12) * s;
    const lineHeight = obj.lineHeight || 1.2;
    Object.assign(editor.style, {
      left: `${vr.left + vr.width / 2}px`,
      top: `${vr.top + vr.height / 2}px`,
      width: obj.wrap === false ? 'auto' : `${f.width * s}px`,
      minWidth: `${Math.max(20, obj.wrap === false ? 20 : f.width * s)}px`,
      minHeight: `${f.height * s}px`,
      fontSize: `${size}px`,
      lineHeight: `${lineHeight}`,
      color: cssColor(obj.color || [0, 0, 0]),
      textAlign: obj.align || 'left',
      padding: `${padding}px`,
      transform: `translate(-50%, -50%) rotate(${disp}deg)`,
      textDecoration: [obj.underline ? 'underline' : '', obj.strike ? 'line-through' : ''].join(' ').trim() || 'none',
      whiteSpace: obj.wrap === false ? 'pre' : 'pre-wrap',
      background: obj.type === 'freetext' && obj.fill ? cssColor(obj.fill) : obj.fromBlock ? '#ffffff' : 'rgba(255,255,255,0.0)',
      zIndex: 7,
    });
    if (obj.wrap === false) {
      // Anchor at the top-left corner for auto-width text.
      const tl = vp.convertToViewportPoint(...localToUser(f, 0, 0));
      editor.style.left = `${tl[0]}px`;
      editor.style.top = `${tl[1]}px`;
      editor.style.transformOrigin = '0 0';
      editor.style.transform = `rotate(${disp}deg)`;
    }
    editor.textContent = obj.text || '';
    this.editing = { id: obj.id, el: editor, pageUid: pv.entry.uid, original: obj.text || '' };
    this.hidden.add(obj.id);
    this.selection = { pageUid: pv.entry.uid, id: obj.id, kind: 'object' };
    this.renderPage(pv);
    pv.objectsLayer.appendChild(editor);
    editor.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        this.commitEditing();
      }
    });
    editor.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, text);
    });
    editor.addEventListener('input', () => this.docView.editorInput(editor));
    editor.addEventListener('blur', () => {
      setTimeout(() => {
        if (this.editing && this.editing.el === editor && document.activeElement !== editor && !this.docView.focusInProps()) this.commitEditing();
      }, 0);
    });
    editor.focus();
    placeCaret(editor, clickEvent);
    this.docView.selectionChanged();
  }

  applyEditorStyle(obj) {
    if (!this.editing || this.editing.id !== obj.id) return;
    const pv = this.viewer.pageViews.get(this.editing.pageUid);
    if (!pv) return;
    const editor = this.editing.el;
    const text = editor.innerText;
    const s = this.scale();
    editor.style.fontSize = `${(obj.size || 12) * s}px`;
    editor.style.lineHeight = `${obj.lineHeight || 1.2}`;
    editor.style.color = cssColor(obj.color || [0, 0, 0]);
    editor.style.textAlign = obj.align || 'left';
    editor.style.textDecoration = [obj.underline ? 'underline' : '', obj.strike ? 'line-through' : ''].join(' ').trim() || 'none';
    getShaper(obj.font || {}, text).then((shaper) => {
      editor.style.fontFamily = [`"${cssNameFor(shaper.descriptor)}"`, ...shaper.faces.slice(1).map((fc) => `"${cssNameFor(fc.descriptor)}"`), 'sans-serif'].join(', ');
      editor.style.fontWeight = shaper.synthBold ? '700' : '400';
      editor.style.fontStyle = shaper.synthItalic ? 'italic' : 'normal';
    });
  }

  commitEditing() {
    if (!this.editing) return;
    const { id, el, pageUid } = this.editing;
    let text = el.innerText.replace(/\r/g, '');
    if (text.endsWith('\n') && !this.editing.original.endsWith('\n')) text = text.replace(/\n$/, '');
    this.editing = null;
    this.hidden.delete(id);
    el.remove();
    this.docView.finishTextEdit(pageUid, id, text);
  }

  cancelEditing() {
    if (!this.editing) return;
    const { id, el, pageUid } = this.editing;
    this.editing = null;
    this.hidden.delete(id);
    el.remove();
    this.refreshPages([pageUid]);
  }
}

function mulM(a, b) {
  return [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
}

function placeCaret(el, e) {
  const sel = window.getSelection();
  let range = null;
  if (e && document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
    if (pos && el.contains(pos.offsetNode)) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
    }
  }
  if (!range) {
    range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

export function snapAngle(origin, p) {
  const dx = p[0] - origin[0];
  const dy = p[1] - origin[1];
  const len = Math.hypot(dx, dy);
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return [origin[0] + Math.cos(ang) * len, origin[1] + Math.sin(ang) * len];
}

export function smoothSvgPath(pts) {
  if (!pts.length) return '';
  if (pts.length < 3) return `M${pts[0][0]},${pts[0][1]} ` + pts.slice(1).map((p) => `L${p[0]},${p[1]}`).join(' ') + (pts.length === 1 ? ` l0.01,0` : '');
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mid = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2];
    d += ` Q${pts[i][0]},${pts[i][1]} ${mid[0]},${mid[1]}`;
  }
  const last = pts[pts.length - 1];
  d += ` L${last[0]},${last[1]}`;
  return d;
}

export { BOX_TYPES, POINT_TYPES, PATH_TYPES, MARKUP_TYPES, clamp };
