// Interactive tools: drawing, markup, text, images, links, redaction, crop.
import { h, svgEl, cssColor, uid } from '../ui/dom.js';
import { viewRect, userRect } from './viewport.js';
import { snapAngle, smoothSvgPath, objectBounds } from './overlay.js';
import { CSS_UNITS } from '../pdf/pdfjs.js';
import { rectFromLocal, frameForRect } from '../../../core/text-layout.js';
import { t } from '../i18n.js';

// Tools that need the interaction layer to capture pointer events.
const DRAW_TOOLS = new Set(['note', 'freetext', 'addText', 'rect', 'ellipse', 'line', 'arrow', 'polyline', 'polygon', 'ink', 'eraser', 'stamp', 'signature', 'image', 'link', 'redact', 'whiteout', 'crop', 'areaHighlight']);
export const MARKUP_TOOLS = new Set(['highlight', 'underline', 'strikeout', 'squiggly']);
export const TEXT_SELECT_TOOLS = new Set(['select', 'highlight', 'underline', 'strikeout', 'squiggly', 'redactText']);

export class ToolController {
  constructor(docView) {
    this.docView = docView;
    this.tool = 'select';
    this.pending = null; // e.g. image asset waiting to be placed
    this.poly = null;
    this.bindEvents();
  }

  get viewer() {
    return this.docView.viewer;
  }

  get session() {
    return this.docView.session;
  }

  setTool(tool, options = {}) {
    if (this.poly) this.finishPoly(false);
    this.tool = tool;
    this.options = options;
    const container = this.viewer.container;
    container.className = container.className.replace(/\btool-\S+/g, '').trim();
    container.classList.add(`tool-${tool}`);
    container.classList.toggle('no-annot-layer', !(tool === 'select' || tool === 'hand'));
    container.classList.toggle('edit-mode', tool === 'edit');
    container.classList.toggle('show-links', tool === 'link');
    const drawing = DRAW_TOOLS.has(tool);
    for (const pv of this.viewer.pageViews.values()) {
      pv.interactionLayer.classList.toggle('active', drawing);
      pv.interactionLayer.classList.toggle('text-cursor', tool === 'addText');
      pv.textLayerDiv.style.pointerEvents = TEXT_SELECT_TOOLS.has(tool) ? '' : 'none';
    }
    this.docView.toolChanged(tool);
  }

  applyLayerState(pv) {
    const drawing = DRAW_TOOLS.has(this.tool);
    pv.interactionLayer.classList.toggle('active', drawing);
    pv.interactionLayer.classList.toggle('text-cursor', this.tool === 'addText');
    pv.textLayerDiv.style.pointerEvents = TEXT_SELECT_TOOLS.has(this.tool) ? '' : 'none';
  }

  bindEvents() {
    const container = this.viewer.container;
    container.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    container.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    container.addEventListener('mouseup', (e) => this.onMouseUp(e));
    container.addEventListener('contextmenu', (e) => this.onContextMenu(e));
  }

  pageViewFromEvent(e) {
    const pageEl = e.target.closest && e.target.closest('.page');
    return pageEl ? pageEl._pageView : null;
  }

  local(pv, e) {
    const r = pv.el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  onContextMenu(e) {
    const pv = this.pageViewFromEvent(e);
    if (!pv) return;
    const objEl = e.target.closest('.obj');
    if (objEl && objEl.dataset.id) {
      e.preventDefault();
      const obj = (this.session.page(pv.entry.uid)?.objects || []).find((o) => o.id === objEl.dataset.id);
      if (obj) {
        this.docView.overlay.select(pv.entry.uid, obj.id);
        this.docView.objectContextMenu(e, pv, obj, null);
      }
      return;
    }
    if (this.tool === 'select') {
      e.preventDefault();
      this.docView.pageContextMenu(e, pv);
    }
  }

  onPointerDown(e) {
    if (e.button !== 0) return;
    const pv = this.pageViewFromEvent(e);
    const overlay = this.docView.overlay;
    if (this.tool === 'hand') {
      this.startPan(e);
      return;
    }
    if (!pv) {
      if (!e.target.closest('.sel-box') && !e.target.closest('.text-editor')) overlay.clearSelection();
      return;
    }
    if (e.target.closest('.text-editor') || e.target.closest('.sel-box') || e.target.closest('.note-popup')) return;
    if (e.target.closest('.annotationLayer section') && (this.tool === 'select')) return;
    // Object hit (select tool and most tools allow selecting objects).
    const objEl = e.target.closest('.obj');
    if (objEl && !DRAW_TOOLS.has(this.tool) && this.tool !== 'edit') {
      if (objEl.dataset.id) {
        overlay.select(pv.entry.uid, objEl.dataset.id, 'object');
        // Allow immediate drag after selecting.
        requestAnimationFrame(() => {
          const move = pv.objectsLayer.querySelector('.sel-box .move-area');
          if (move && e.isPrimary) {
            const ev = new PointerEvent('pointerdown', e);
            move.dispatchEvent(ev);
          }
        });
        e.preventDefault();
        return;
      }
      if (objEl.dataset.annot) {
        this.session.getSourceAnnotations(pv.entry).then((annots) => {
          const a = annots.find((x) => x.id === objEl.dataset.annot);
          if (a) overlay.select(pv.entry.uid, a.id, 'annot', { annot: a });
        });
        e.preventDefault();
        return;
      }
    }
    if (this.tool === 'edit') {
      this.docView.editMode.pointerDown(e, pv);
      return;
    }
    if (!DRAW_TOOLS.has(this.tool)) {
      overlay.clearSelection();
      return;
    }
    if (this.docView.isReadOnly()) {
      this.docView.warnReadOnly();
      return;
    }
    e.preventDefault();
    this.startDraw(e, pv);
  }

  onDoubleClick(e) {
    const pv = this.pageViewFromEvent(e);
    if (!pv) return;
    if (this.poly && (this.tool === 'polyline' || this.tool === 'polygon')) {
      this.finishPoly(true);
      return;
    }
    const objEl = e.target.closest('.obj');
    if (objEl && objEl.dataset.id) {
      const obj = (this.session.page(pv.entry.uid)?.objects || []).find((o) => o.id === objEl.dataset.id);
      if (obj) this.docView.objectDoubleClicked(pv, obj, e);
    }
  }

  onMouseUp(e) {
    if (!MARKUP_TOOLS.has(this.tool) && this.tool !== 'redactText') return;
    setTimeout(() => this.createMarkupFromSelection(), 0);
  }

  startPan(e) {
    const c = this.viewer.container;
    const sx = e.clientX;
    const sy = e.clientY;
    const sl = c.scrollLeft;
    const st = c.scrollTop;
    c.classList.add('panning');
    const move = (ev) => {
      c.scrollLeft = sl - (ev.clientX - sx);
      c.scrollTop = st - (ev.clientY - sy);
    };
    const up = () => {
      c.classList.remove('panning');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    e.preventDefault();
  }

  // ------------------------------------------------------------------ markup from text selection

  createMarkupFromSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    if (this.docView.isReadOnly()) return this.docView.warnReadOnly();
    const range = sel.getRangeAt(0);
    const byPage = new Map();
    const rects = range.getClientRects();
    for (const pv of this.viewer.pageViews.values()) {
      if (!pv.visible || !pv.geometry) continue;
      const pr = pv.el.getBoundingClientRect();
      for (const r of rects) {
        if (r.width < 1 || r.height < 1) continue;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (cx < pr.left || cx > pr.right || cy < pr.top || cy > pr.bottom) continue;
        if (!byPage.has(pv)) byPage.set(pv, []);
        byPage.get(pv).push([r.left - pr.left, r.top - pr.top, r.width, r.height]);
      }
    }
    const text = sel.toString();
    sel.removeAllRanges();
    for (const [pv, list] of byPage) {
      const vp = pv.getViewport();
      const merged = mergeLineRects(list);
      const userRects = merged.map(([l, tp, w, hh]) => userRect(vp, l, tp, w, hh));
      if (!userRects.length) continue;
      const rot = pv.geometry.rotation;
      if (this.tool === 'redactText') {
        for (const r of userRects) this.docView.addObject(pv, { type: 'redact', rect: r, fill: [0, 0, 0] }, { select: false });
        continue;
      }
      const style = this.docView.toolStyle(this.tool);
      this.docView.addObject(pv, { type: this.tool, rects: userRects, rot, color: style.color, opacity: style.opacity ?? (this.tool === 'highlight' ? 0.5 : 1), text }, { select: false });
    }
  }

  // ------------------------------------------------------------------ drawing

  startDraw(e, pv) {
    const vp = pv.getViewport();
    const start = this.local(pv, e);
    const startPdf = vp.convertToPdfPoint(...start);
    const tool = this.tool;
    const layer = pv.interactionLayer;
    layer.setPointerCapture(e.pointerId);
    const preview = svgEl('svg', { class: 'draw-preview', width: '100%', height: '100%' });
    layer.appendChild(preview);
    const style = this.docView.toolStyle(tool);
    const s = this.viewer.scale * CSS_UNITS;
    let points = [start];
    let current = start;
    let moved = false;

    if (tool === 'polyline' || tool === 'polygon') {
      layer.releasePointerCapture(e.pointerId);
      preview.remove();
      this.addPolyPoint(pv, startPdf);
      return;
    }
    if (tool === 'eraser') {
      this.eraseAt(pv, startPdf);
    }

    const drawPreview = () => {
      preview.innerHTML = '';
      const stroke = cssColor(style.stroke || style.color || [0.18, 0.42, 1]);
      const sw = Math.max(1, (style.width ?? 2) * s);
      if (tool === 'ink') {
        preview.appendChild(svgEl('path', { d: smoothSvgPath(points), stroke, 'stroke-width': sw, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-opacity': style.opacity ?? 1 }));
      } else if (tool === 'line' || tool === 'arrow') {
        preview.appendChild(svgEl('line', { x1: start[0], y1: start[1], x2: current[0], y2: current[1], stroke, 'stroke-width': sw, 'stroke-linecap': 'round' }));
      } else if (tool === 'eraser') {
        preview.appendChild(svgEl('circle', { cx: current[0], cy: current[1], r: 8, fill: 'rgba(229,72,77,0.15)', stroke: '#e5484d' }));
      } else {
        const x = Math.min(start[0], current[0]);
        const y = Math.min(start[1], current[1]);
        const w = Math.abs(current[0] - start[0]);
        const hh = Math.abs(current[1] - start[1]);
        if (tool === 'ellipse') {
          preview.appendChild(svgEl('ellipse', { cx: x + w / 2, cy: y + hh / 2, rx: w / 2, ry: hh / 2, stroke, 'stroke-width': sw, fill: style.fill ? cssColor(style.fill) : 'none' }));
        } else {
          const fill = tool === 'redact' ? 'rgba(229,72,77,0.15)' : tool === 'whiteout' ? '#ffffff' : tool === 'crop' ? 'rgba(47,107,255,0.08)' : style.fill ? cssColor(style.fill) : 'none';
          const st = tool === 'redact' ? '#e5484d' : tool === 'whiteout' ? '#999' : tool === 'rect' ? stroke : '#2f6bff';
          preview.appendChild(svgEl('rect', { x, y, width: w, height: hh, stroke: st, 'stroke-width': tool === 'rect' ? sw : 1, 'stroke-dasharray': tool === 'rect' ? null : '4 3', fill }));
        }
      }
    };

    const onMove = (ev) => {
      let p = this.local(pv, ev);
      p = [Math.max(0, Math.min(pv.el.clientWidth, p[0])), Math.max(0, Math.min(pv.el.clientHeight, p[1]))];
      if (Math.hypot(p[0] - start[0], p[1] - start[1]) > 3) moved = true;
      if ((tool === 'rect' || tool === 'ellipse') && ev.shiftKey) {
        const d = Math.max(Math.abs(p[0] - start[0]), Math.abs(p[1] - start[1]));
        p = [start[0] + Math.sign(p[0] - start[0] || 1) * d, start[1] + Math.sign(p[1] - start[1] || 1) * d];
      }
      if ((tool === 'line' || tool === 'arrow') && ev.shiftKey) p = snapAngle(start, p);
      current = p;
      if (tool === 'ink') {
        const last = points[points.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 1.5) points.push(p);
      }
      if (tool === 'eraser') this.eraseAt(pv, vp.convertToPdfPoint(...p));
      drawPreview();
    };
    const onUp = () => {
      layer.removeEventListener('pointermove', onMove);
      layer.removeEventListener('pointerup', onUp);
      layer.removeEventListener('pointercancel', onUp);
      preview.remove();
      this.finishDraw(pv, tool, start, current, points, moved, style);
    };
    layer.addEventListener('pointermove', onMove);
    layer.addEventListener('pointerup', onUp);
    layer.addEventListener('pointercancel', onUp);
    drawPreview();
  }

  finishDraw(pv, tool, start, end, points, moved, style) {
    const vp = pv.getViewport();
    const rot = pv.geometry.rotation;
    const s = this.viewer.scale * CSS_UNITS;
    const toUser = (p) => vp.convertToPdfPoint(p[0], p[1]);
    const box = () => userRect(vp, Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.abs(end[0] - start[0]), Math.abs(end[1] - start[1]));
    const sizedBox = (w, hh) => {
      // Box of w x hh points (in view orientation) with its top-left at the click.
      const p = toUser(start);
      return rectFromLocal(p, w, hh, rot);
    };
    const dv = this.docView;
    switch (tool) {
      case 'rect':
      case 'ellipse': {
        if (!moved) return;
        dv.addObject(pv, { type: tool, rect: box(), stroke: style.stroke ?? [0.9, 0.1, 0.1], fill: style.fill || null, width: style.width ?? 2, opacity: style.opacity ?? 1, dash: !!style.dash });
        break;
      }
      case 'line':
      case 'arrow': {
        if (!moved) return;
        dv.addObject(pv, { type: tool, p1: toUser(start), p2: toUser(end), stroke: style.stroke ?? [0.9, 0.1, 0.1], width: style.width ?? 2, opacity: style.opacity ?? 1, endHead: tool === 'arrow' ? style.endHead || 'OpenArrow' : 'None', startHead: style.startHead || 'None', dash: !!style.dash });
        break;
      }
      case 'ink': {
        if (points.length < 2 && !moved) points = [start, [start[0] + 0.5, start[1] + 0.5]];
        dv.addObject(pv, { type: 'ink', paths: [points.map(toUser)], stroke: style.stroke ?? [0.9, 0.1, 0.1], width: style.width ?? 2, opacity: style.opacity ?? 1 }, { select: false });
        break;
      }
      case 'note': {
        const rect = sizedBox(20, 20);
        const id = dv.addObject(pv, { type: 'note', rect, color: style.color || [1, 0.82, 0.2], contents: '', icon: 'Comment' }, { select: true });
        dv.openNotePopup(pv, id);
        break;
      }
      case 'freetext':
      case 'addText': {
        const font = { family: style.font?.family || 'Liberation Sans', bold: !!style.font?.bold, italic: !!style.font?.italic };
        const size = style.size || 12;
        let rect;
        let wrap = true;
        if (moved) {
          rect = box();
        } else if (tool === 'addText') {
          rect = sizedBox(size * 0.6, size * 1.2);
          wrap = false;
        } else {
          rect = sizedBox(160, size * 1.2 + 8 + 6);
        }
        const obj =
          tool === 'freetext'
            ? { type: 'freetext', rect, rot, text: '', font, size, color: style.color || [0, 0, 0], border: style.border === undefined ? [0.9, 0.1, 0.1] : style.border, fill: style.fill || null, borderWidth: 1, align: style.align || 'left', wrap: true, padding: 4 }
            : { type: 'text', rect, rot, text: '', font, size, color: style.color || [0, 0, 0], align: style.align || 'left', wrap, lineHeight: 1.2 };
        const id = dv.addObject(pv, obj, { select: true, transient: true });
        dv.startEditingById(pv, id);
        break;
      }
      case 'stamp': {
        const st = this.options?.stamp || dv.currentStamp();
        if (!st) return;
        const w = st.width || 150;
        const hh = st.height || 48;
        const p = toUser(start);
        const f = frameForRect([0, 0, 0, 0], rot);
        const origin = [p[0] - (w / 2) * f.right[0] - (hh / 2) * f.down[0], p[1] - (w / 2) * f.right[1] - (hh / 2) * f.down[1]];
        const rect = moved ? box() : rectFromLocal(origin, w, hh, rot);
        dv.addObject(pv, { type: 'stamp', rect, rot, label: st.label, subLabel: st.subLabel, color: st.color, asset: st.asset || null, stampName: st.name || 'Draft' });
        break;
      }
      case 'signature':
      case 'image': {
        const pending = this.pending;
        if (!pending) return;
        const ratio = pending.height / pending.width;
        let rect;
        if (moved) {
          const f = frameForRect(box(), rot);
          rect = rectFromLocal(f.origin, f.width, f.width * ratio, rot);
        } else {
          const w = Math.min(pending.defaultWidth || 200, (pv.geometry.width || 400) * 0.6);
          const p = toUser(start);
          const f = frameForRect([0, 0, 0, 0], rot);
          const origin = [p[0] - (w / 2) * f.right[0] - ((w * ratio) / 2) * f.down[0], p[1] - (w / 2) * f.right[1] - ((w * ratio) / 2) * f.down[1]];
          rect = rectFromLocal(origin, w, w * ratio, rot);
        }
        dv.addObject(pv, { type: tool === 'signature' ? 'signature' : 'image', rect, rot, asset: pending.asset });
        if (!pending.keep) {
          this.pending = null;
          dv.setTool('select');
        }
        break;
      }
      case 'link': {
        if (!moved) return;
        dv.createLink(pv, box());
        break;
      }
      case 'redact': {
        if (!moved) return;
        dv.addObject(pv, { type: 'redact', rect: box(), fill: [0, 0, 0] }, { select: false });
        break;
      }
      case 'whiteout': {
        if (!moved) return;
        dv.addObject(pv, { type: 'whiteout', rect: box(), fill: [1, 1, 1] }, { select: false });
        break;
      }
      case 'crop': {
        if (!moved) return;
        dv.cropFromRect(pv, box());
        break;
      }
      default:
        break;
    }
  }

  eraseAt(pv, p) {
    const entry = this.session.page(pv.entry.uid);
    if (!entry) return;
    const tol = 6 / (this.viewer.scale * CSS_UNITS);
    const ids = [];
    for (const o of entry.objects || []) {
      if (o.type !== 'ink' && o.type !== 'line' && o.type !== 'arrow' && o.type !== 'polyline') continue;
      const paths = o.type === 'ink' ? o.paths : o.type === 'polyline' ? [o.points] : [[o.p1, o.p2]];
      for (const path of paths) {
        for (let i = 0; i < path.length; i++) {
          const a = path[i];
          const b = path[i + 1] || a;
          if (distToSegment(p, a, b) <= tol + (o.width || 2) / 2) {
            ids.push(o.id);
            break;
          }
        }
        if (ids.includes(o.id)) break;
      }
    }
    if (ids.length) this.session.removeObjects(ids, 'erase');
  }

  // ------------------------------------------------------------------ polylines

  addPolyPoint(pv, p) {
    if (!this.poly || this.poly.pv !== pv) {
      if (this.poly) this.finishPoly(true);
      const svg = svgEl('svg', { class: 'draw-preview', width: '100%', height: '100%' });
      pv.interactionLayer.appendChild(svg);
      this.poly = { pv, points: [], svg };
      const move = (e) => {
        if (!this.poly) return;
        this.poly.hover = pv.getViewport().convertToPdfPoint(...this.local(pv, e));
        this.drawPoly();
      };
      pv.interactionLayer.addEventListener('pointermove', move);
      this.poly.cleanup = () => pv.interactionLayer.removeEventListener('pointermove', move);
    }
    this.poly.points.push(p);
    this.drawPoly();
  }

  drawPoly() {
    const { pv, points, svg, hover } = this.poly;
    const vp = pv.getViewport();
    const style = this.docView.toolStyle(this.tool);
    const pts = [...points, ...(hover ? [hover] : [])].map((p) => vp.convertToViewportPoint(...p));
    svg.innerHTML = '';
    svg.appendChild(svgEl(this.tool === 'polygon' ? 'polygon' : 'polyline', { points: pts.map((p) => p.join(',')).join(' '), stroke: cssColor(style.stroke || [0.9, 0.1, 0.1]), 'stroke-width': Math.max(1, (style.width ?? 2) * this.viewer.scale * CSS_UNITS), fill: 'none' }));
    for (const p of pts.slice(0, points.length)) svg.appendChild(svgEl('circle', { cx: p[0], cy: p[1], r: 3, fill: '#fff', stroke: '#2f6bff' }));
  }

  finishPoly(commit) {
    const poly = this.poly;
    if (!poly) return;
    this.poly = null;
    poly.svg.remove();
    poly.cleanup && poly.cleanup();
    // Double-click adds a duplicate final point; drop near-duplicates.
    const pts = poly.points.filter((p, i, arr) => i === 0 || Math.hypot(p[0] - arr[i - 1][0], p[1] - arr[i - 1][1]) > 0.5);
    if (!commit || pts.length < 2) return;
    const style = this.docView.toolStyle(this.tool);
    this.docView.addObject(poly.pv, { type: this.tool, points: pts, stroke: style.stroke ?? [0.9, 0.1, 0.1], fill: this.tool === 'polygon' ? style.fill || null : null, width: style.width ?? 2, opacity: style.opacity ?? 1 });
  }

  keyDown(e) {
    if (this.poly) {
      if (e.key === 'Enter') {
        this.finishPoly(true);
        return true;
      }
      if (e.key === 'Escape') {
        this.finishPoly(false);
        return true;
      }
    }
    return false;
  }
}

function distToSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let tt = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  tt = Math.max(0, Math.min(1, tt));
  return Math.hypot(p[0] - (a[0] + tt * dx), p[1] - (a[1] + tt * dy));
}

// Merges selection rectangles that belong to the same text line.
export function mergeLineRects(list) {
  const sorted = list.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last) {
      const lastMid = last[1] + last[3] / 2;
      const mid = r[1] + r[3] / 2;
      const sameLine = Math.abs(lastMid - mid) < Math.min(last[3], r[3]) * 0.5;
      const gap = r[0] - (last[0] + last[2]);
      if (sameLine && gap < Math.max(last[3], r[3]) * 1.5 && gap > -last[2]) {
        const x0 = Math.min(last[0], r[0]);
        const y0 = Math.min(last[1], r[1]);
        const x1 = Math.max(last[0] + last[2], r[0] + r[2]);
        const y1 = Math.max(last[1] + last[3], r[1] + r[3]);
        out[out.length - 1] = [x0, y0, x1 - x0, y1 - y0];
        continue;
      }
    }
    out.push(r.slice());
  }
  return out;
}

export { DRAW_TOOLS, objectBounds, viewRect, uid };
