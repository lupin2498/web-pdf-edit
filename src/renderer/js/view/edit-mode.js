// Edit mode: edit existing text blocks and images of the page content.
import { h, clear, uid } from '../ui/dom.js';
import { viewRect, userRect } from './viewport.js';
import { buildTextBlocks } from '../doc/text-blocks.js';
import { allImages } from '../../../core/interpreter.js';
import { rectToRectMatrix, transformRect, multiply } from '../../../core/matrix.js';
import { getShaper, registry, loadSystemFonts } from '../pdf/fonts.js';
import { needsPreview } from '../doc/session.js';
import { t } from '../i18n.js';

function previewKeyOf(entry) {
  return JSON.stringify([entry.removals, entry.imageEdits]);
}

export class EditMode {
  constructor(docView) {
    this.docView = docView;
    this.active = false;
    this.lineMode = false;
    this.cache = new Map(); // pageUid -> {key, blocks, images}
    this.selectedImage = null; // {pageUid, path}
  }

  get session() {
    return this.docView.session;
  }

  get viewer() {
    return this.docView.viewer;
  }

  setActive(on) {
    this.active = on;
    if (!on) this.selectedImage = null;
    for (const pv of this.viewer.pageViews.values()) {
      if (on && pv.visible) this.renderPage(pv);
      else clear(pv.editLayer);
    }
  }

  setLineMode(on) {
    this.lineMode = on;
    this.cache.clear();
    this.refresh();
  }

  refresh(uids = null) {
    if (!this.active) return;
    for (const pv of this.viewer.pageViews.values()) {
      if (uids && !uids.has(pv.entry.uid)) continue;
      if (pv.visible) this.renderPage(pv);
    }
  }

  async pageData(pv) {
    const entry = this.session.page(pv.entry.uid) || pv.entry;
    const key = JSON.stringify([previewKeyOf(entry), this.lineMode, entry.src]);
    const cached = this.cache.get(entry.uid);
    if (cached && cached.key === key) return cached;
    const result = { key, blocks: [], images: [] };
    this.cache.set(entry.uid, result);
    if (!entry.src) return result;
    try {
      const [textContent, analysis] = await Promise.all([this.session.getTextContent(entry), this.session.analyze(entry)]);
      result.blocks = buildTextBlocks(textContent, { mode: this.lineMode ? 'line' : 'paragraph', analysis }).filter((b) => !b.invisible);
      const edits = new Map((entry.imageEdits || []).map((e) => [JSON.stringify(e.path), e]));
      result.images = allImages(analysis)
        .map(({ image, path }) => {
          const edit = edits.get(JSON.stringify(path));
          if (edit && edit.action === 'delete') return null;
          const bbox = edit && edit.matrix ? transformRect(edit.matrix, image.bbox) : image.bbox;
          return { path, image, bbox, origBBox: image.bbox, edit };
        })
        .filter((x) => x && x.bbox[2] - x.bbox[0] > 2 && x.bbox[3] - x.bbox[1] > 2);
    } catch (e) {
      console.warn('edit analysis failed', e);
    }
    return result;
  }

  async renderPage(pv) {
    if (!this.active) return;
    const token = (pv.editToken = (pv.editToken || 0) + 1);
    const data = await this.pageData(pv);
    if (token !== pv.editToken || !this.active) return;
    const layer = pv.editLayer;
    clear(layer);
    const vp = pv.getViewport();
    for (const img of data.images) {
      const vr = viewRect(vp, img.bbox);
      const sel = this.selectedImage && this.selectedImage.pageUid === pv.entry.uid && JSON.stringify(this.selectedImage.path) === JSON.stringify(img.path);
      const el = h('div', {
        class: `edit-image ${sel ? 'selected' : ''}`,
        dataset: { path: JSON.stringify(img.path) },
        title: t('edit.imageHint'),
        style: { left: `${vr.left}px`, top: `${vr.top}px`, width: `${vr.width}px`, height: `${vr.height}px` },
      });
      layer.appendChild(el);
      if (sel) this.drawImageHandles(pv, el, img);
    }
    for (const b of data.blocks) {
      const vr = viewRect(vp, b.rect);
      layer.appendChild(
        h('div', {
          class: 'edit-block',
          dataset: { block: b.id },
          title: b.text.slice(0, 120),
          style: { left: `${vr.left - 1}px`, top: `${vr.top - 1}px`, width: `${vr.width + 2}px`, height: `${vr.height + 2}px` },
        }),
      );
    }
  }

  async pointerDown(e, pv) {
    const blockEl = e.target.closest('.edit-block');
    const imgEl = e.target.closest('.edit-image');
    if (e.target.closest('.handle')) return;
    if (this.docView.isReadOnly()) {
      if (blockEl || imgEl) this.docView.warnReadOnly();
      return;
    }
    const data = await this.pageData(pv);
    if (imgEl) {
      e.preventDefault();
      const path = JSON.parse(imgEl.dataset.path);
      const img = data.images.find((i) => JSON.stringify(i.path) === JSON.stringify(path));
      if (!img) return;
      this.docView.overlay.clearSelection();
      this.selectedImage = { pageUid: pv.entry.uid, path };
      this.renderPage(pv);
      this.docView.selectionChanged();
      this.startImageDrag(e, pv, img, 'move');
      return;
    }
    if (blockEl) {
      e.preventDefault();
      const block = data.blocks.find((b) => b.id === blockEl.dataset.block);
      if (block) await this.editBlock(pv, block, e);
      return;
    }
    if (this.selectedImage) {
      this.selectedImage = null;
      this.renderPage(pv);
      this.docView.selectionChanged();
    }
    this.docView.overlay.clearSelection();
  }

  async editBlock(pv, block, e) {
    // Match against installed fonts too (they load shortly after startup).
    await loadSystemFonts();
    const font = { family: registry.matchFamily(block.font?.name || '', block.font || {}), bold: !!block.font?.bold, italic: !!block.font?.italic };
    const size = Math.round(block.size * 10) / 10;
    const shaper = await getShaper(font, block.text);
    const lineHeight = Math.round(block.lineHeight * 100) / 100;
    // Place the new box so its first baseline matches the original one.
    const [u0, , u1, v1] = block.localRect;
    const firstBaseline = v1 - block.firstBaselineOffset;
    const lh = lineHeight * size;
    const halfLeading = (lh - (shaper.metrics.ascent - shaper.metrics.descent) * size) / 2;
    const topV = firstBaseline + halfLeading + shaper.metrics.ascent * size;
    const width = u1 - u0;
    const tolerance = Math.max(2, width * 0.03);
    const nLines = block.lineTexts.length;
    const local = [u0, topV - nLines * lh, u1 + tolerance, topV];
    const rect = localToUserRect(block.orientation, local);
    const pad = 0.6;
    const region = [block.rect[0] - pad, block.rect[1] - pad, block.rect[2] + pad, block.rect[3] + pad];
    const objId = uid('o');
    const removalId = uid('r');
    const now = new Date().toISOString();
    const obj = {
      id: objId,
      type: 'text',
      rect,
      rot: block.rot,
      text: block.text,
      size,
      font,
      color: block.color || [0, 0, 0],
      align: block.align,
      lineHeight,
      // A single line grows sideways while typing (like the original line);
      // paragraphs keep their width and wrap.
      wrap: nLines > 1,
      fromBlock: removalId,
      created: now,
      modified: now,
    };
    const ok = this.session.updatePage(pv.entry.uid, 'editText', (p) => {
      p.removals = p.removals || [];
      p.removals.push({ id: removalId, region, kind: 'text', objectId: objId });
      p.objects = p.objects || [];
      p.objects.push(obj);
    });
    if (!ok) return;
    this.docView.markTransient(objId, { original: block.text, style: JSON.stringify([obj.font, obj.size, obj.color]) });
    this.docView.overlay.startEditing(pv, obj, e);
  }

  // ------------------------------------------------------------------ images

  drawImageHandles(pv, el, img) {
    for (const name of ['nw', 'ne', 'se', 'sw']) {
      const pos = { nw: [0, 0], ne: [1, 0], se: [1, 1], sw: [0, 1] }[name];
      const hd = h('div', { class: `handle ${name}`, style: { position: 'absolute', left: `${pos[0] * 100}%`, top: `${pos[1] * 100}%`, width: '9px', height: '9px', margin: '-5px 0 0 -5px', background: '#fff', border: '1.5px solid var(--selection)', borderRadius: '2px' } });
      hd.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.startImageDrag(e, pv, img, name);
      });
      el.appendChild(hd);
    }
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.docView.imageContextMenu(e, pv, img);
    });
  }

  startImageDrag(e, pv, img, mode) {
    const target = e.target;
    target.setPointerCapture && target.setPointerCapture(e.pointerId);
    const vp = pv.getViewport();
    const r = pv.el.getBoundingClientRect();
    const start = [e.clientX - r.left, e.clientY - r.top];
    const vb = viewRect(vp, img.bbox);
    const el = pv.editLayer.querySelector(`.edit-image[data-path='${JSON.stringify(img.path)}']`);
    let newRect = null;
    const move = (ev) => {
      const cur = [ev.clientX - r.left, ev.clientY - r.top];
      const dx = cur[0] - start[0];
      const dy = cur[1] - start[1];
      if (Math.abs(dx) + Math.abs(dy) < 2 && !newRect) return;
      let { left, top, width, height } = vb;
      if (mode === 'move') {
        left += dx;
        top += dy;
      } else {
        let right = left + width;
        let bottom = top + height;
        if (mode.includes('w')) left += dx;
        if (mode.includes('e')) right += dx;
        if (mode.includes('n')) top += dy;
        if (mode.includes('s')) bottom += dy;
        if (!ev.altKey) {
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
        width = Math.max(4, Math.abs(right - left));
        height = Math.max(4, Math.abs(bottom - top));
        left = Math.min(left, right);
        top = Math.min(top, bottom);
      }
      newRect = { left, top, width, height };
      if (el) Object.assign(el.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!newRect) return;
      const to = userRect(vp, newRect.left, newRect.top, newRect.width, newRect.height);
      const matrix = rectToRectMatrix(img.origBBox, to);
      this.setImageEdit(pv.entry.uid, img.path, { action: img.edit && img.edit.action === 'replace' ? 'replace' : 'transform', matrix, asset: img.edit && img.edit.asset });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  setImageEdit(pageUid, path, edit) {
    const key = JSON.stringify(path);
    this.session.updatePage(pageUid, edit.action === 'delete' ? 'deleteImage' : 'editImage', (p) => {
      p.imageEdits = (p.imageEdits || []).filter((x) => JSON.stringify(x.path) !== key);
      p.imageEdits.push({ path, ...edit });
    });
  }

  deleteSelectedImage() {
    if (!this.selectedImage) return false;
    const { pageUid, path } = this.selectedImage;
    this.selectedImage = null;
    this.setImageEdit(pageUid, path, { action: 'delete' });
    this.docView.selectionChanged();
    return true;
  }

  async selectedImageData() {
    if (!this.selectedImage) return null;
    const pv = this.viewer.pageViews.get(this.selectedImage.pageUid);
    if (!pv) return null;
    const data = await this.pageData(pv);
    return { pv, img: data.images.find((i) => JSON.stringify(i.path) === JSON.stringify(this.selectedImage.path)) };
  }
}

function localToUserRect(o, r) {
  const from = (u, v) => {
    switch (o) {
      case 90:
        return [-v, u];
      case 180:
        return [-u, -v];
      case 270:
        return [v, -u];
      default:
        return [u, v];
    }
  };
  const a = from(r[0], r[1]);
  const b = from(r[2], r[3]);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

export { multiply, needsPreview };
