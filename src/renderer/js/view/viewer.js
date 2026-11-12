// Continuous page viewer with virtualization, zoom and pdf.js layers.
import { pdfjsLib, makeViewport, CSS_UNITS } from '../pdf/pdfjs.js';
import { SimpleViewport } from './viewport.js';
import { h, clear, throttleRaf, debounce } from '../ui/dom.js';
import { needsPreview } from '../doc/session.js';
import { t } from '../i18n.js';

const GAP = 14;
const PAD_TOP = 18;
const PAD_BOTTOM = 40;
const PAD_X = 24;
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;
export const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6.4];
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 6.4;

function mulMatrix(a, b) {
  return [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
}

export class PageView {
  constructor(viewer, entry, index) {
    this.viewer = viewer;
    this.entry = entry;
    this.index = index;
    this.geometry = null;
    this.estimated = true;
    this.viewport = null;
    this.renderedKey = null;
    this.renderToken = 0;
    this.renderTask = null;
    this.textLayer = null;
    this.visible = false;
    this.el = h('div', { class: 'page', dataset: { uid: entry.uid } });
    this.canvasWrap = h('div', { class: 'canvas-wrap', style: { position: 'absolute', inset: '0', overflow: 'hidden' } });
    this.textLayerDiv = h('div', { class: 'textLayer' });
    this.annotationLayerDiv = h('div', { class: 'annotationLayer' });
    this.searchLayer = h('div', { class: 'search-layer', style: { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: 1 } });
    this.objectsLayer = h('div', { class: 'objects-layer' });
    this.editLayer = h('div', { class: 'edit-layer' });
    this.interactionLayer = h('div', { class: 'interaction-layer' });
    this.loading = h('div', { class: 'page-loading' }, '');
    this.badge = h('div', { class: 'page-number-badge' });
    this.el.append(this.canvasWrap, this.loading, this.textLayerDiv, this.searchLayer, this.annotationLayerDiv, this.objectsLayer, this.editLayer, this.interactionLayer, this.badge);
    this.el._pageView = this;
  }

  get session() {
    return this.viewer.session;
  }

  setEntry(entry, index) {
    const prev = this.entry;
    this.entry = entry;
    this.index = index;
    this.badge.textContent = '';
    if (prev !== entry) {
      const contentChanged = prev && (needsPreview(prev) !== needsPreview(entry) || JSON.stringify([prev.removals, prev.imageEdits, prev.annotEdits]) !== JSON.stringify([entry.removals, entry.imageEdits, entry.annotEdits]));
      const geomChanged = prev && (prev.rotate !== entry.rotate || JSON.stringify(prev.crop) !== JSON.stringify(entry.crop));
      if (contentChanged || geomChanged) this.renderedKey = null;
      if (geomChanged) this.geometry = null;
    }
  }

  async loadGeometry() {
    const g = await this.session.pageGeometry(this.entry);
    this.geometry = g;
    this.estimated = false;
    return g;
  }

  cssSize() {
    const g = this.geometry || this.viewer.defaultGeometry;
    const s = this.viewer.scale * CSS_UNITS;
    return { width: Math.round(g.width * s), height: Math.round(g.height * s) };
  }

  applySize() {
    const { width, height } = this.cssSize();
    this.el.style.width = `${width}px`;
    this.el.style.height = `${height}px`;
    this.el.style.setProperty('--scale-factor', String(this.viewer.scale * CSS_UNITS));
  }

  renderKey() {
    const e = this.entry;
    return JSON.stringify([this.viewer.scale, e.rotate, e.crop, e.src, e.blank, needsPreview(e) ? [e.removals, e.imageEdits, e.annotEdits] : null]);
  }

  makeViewport(pdfPage) {
    const g = this.geometry;
    const scale = this.viewer.scale * CSS_UNITS;
    if (pdfPage) return makeViewport(pdfPage, { viewBox: g.view, scale, rotation: g.rotation });
    return new SimpleViewport({ viewBox: g.view, scale, rotation: g.rotation });
  }

  // Viewport usable for coordinate conversion even before rendering.
  getViewport() {
    const g = this.geometry || this.viewer.defaultGeometry;
    const scale = this.viewer.scale * CSS_UNITS;
    if (this.viewport && this.viewport.scale === scale && this.viewport.rotation === g.rotation && JSON.stringify(this.viewport.viewBox) === JSON.stringify(g.view)) return this.viewport;
    return new SimpleViewport({ viewBox: g.view, scale, rotation: g.rotation });
  }

  toView(x, y) {
    return this.getViewport().convertToViewportPoint(x, y);
  }

  toPdf(vx, vy) {
    return this.getViewport().convertToPdfPoint(vx, vy);
  }

  cancel() {
    if (this.renderTask) {
      try {
        this.renderTask.cancel();
      } catch {
        /* ignore */
      }
      this.renderTask = null;
    }
    if (this.textLayer) {
      try {
        this.textLayer.cancel();
      } catch {
        /* ignore */
      }
      this.textLayer = null;
    }
  }

  release() {
    this.cancel();
    this.renderToken++;
    clear(this.canvasWrap);
    clear(this.textLayerDiv);
    clear(this.annotationLayerDiv);
    this.renderedKey = null;
    this.layersKey = null;
  }

  async render() {
    if (!this.geometry) await this.loadGeometry();
    const key = this.renderKey();
    if (this.renderedKey === key && this.canvasWrap.firstChild) {
      this.viewer.overlay.renderPage(this);
      return;
    }
    const token = ++this.renderToken;
    this.cancel();
    let pdfPage = null;
    try {
      if (this.entry.src) pdfPage = await this.session.getRenderPage(this.entry);
    } catch (e) {
      console.error(e);
      this.loading.textContent = t('viewer.renderError');
      return;
    }
    if (token !== this.renderToken || this.session.closed) return;
    const vp = this.makeViewport(pdfPage);
    this.viewport = vp;
    this.applySize();
    const dpr = window.devicePixelRatio || 1;
    let outputScale = dpr;
    const pixels = vp.width * vp.height * dpr * dpr;
    if (pixels > MAX_CANVAS_PIXELS) outputScale = Math.sqrt(MAX_CANVAS_PIXELS / (vp.width * vp.height));
    const canvas = document.createElement('canvas');
    canvas.className = 'page-canvas';
    canvas.width = Math.max(1, Math.floor(vp.width * outputScale));
    canvas.height = Math.max(1, Math.floor(vp.height * outputScale));
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Annotations with their own canvas (check boxes, notes, ...) are drawn
    // into separate canvases by pdf.js.
    const ownCanvases = new Map();
    this.annotationCanvases = null;
    if (pdfPage) {
      try {
        this.renderTask = pdfPage.render({
          canvasContext: ctx,
          canvas,
          viewport: vp,
          transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
          annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
          annotationCanvasMap: ownCanvases,
        });
        await this.renderTask.promise;
        if (ownCanvases.size) await this.placeOwnCanvases(ownCanvases, pdfPage, vp, outputScale, ctx);
      } catch (e) {
        if ((e && e.name === 'RenderingCancelledException') || this.session.closed) return;
        console.error('render failed', e);
        this.loading.textContent = t('viewer.renderError');
        return;
      } finally {
        this.renderTask = null;
      }
    }
    if (token !== this.renderToken) return;
    clear(this.canvasWrap);
    this.canvasWrap.appendChild(canvas);
    this.loading.textContent = '';
    this.renderedKey = key;
    this.viewer.overlay.renderPage(this);
    await this.renderLayers(pdfPage, vp, token);
    this.viewer.emit('pagerendered', { pageView: this });
  }

  async renderLayers(pdfPage, vp, token) {
    clear(this.textLayerDiv);
    clear(this.annotationLayerDiv);
    if (!pdfPage) return;
    try {
      const textContent = await this.session.getTextContent(this.entry);
      if (token !== this.renderToken) return;
      this.textLayer = new pdfjsLib.TextLayer({ textContentSource: textContent, container: this.textLayerDiv, viewport: vp });
      await this.textLayer.render();
      this.textLayerDiv.appendChild(h('div', { class: 'endOfContent' }));
      this.textLayer = null;
    } catch (e) {
      if (!(e && e.name === 'AbortException')) console.warn('text layer', e);
    }
    if (token !== this.renderToken) return;
    try {
      await this.renderAnnotationLayer(token);
    } catch (e) {
      console.warn('annotation layer', e);
    }
    if (token !== this.renderToken) return;
    this.viewer.emit('layersrendered', { pageView: this });
  }

  // Source annotations shown as HTML: form fields and links that were not
  // moved or deleted (those are drawn from the edited page preview).
  async layerAnnotations() {
    const entry = this.entry;
    if (!entry.src) return [];
    const annotations = await this.session.getSourceAnnotations(entry);
    const edits = entry.annotEdits || {};
    return annotations.filter((a) => {
      if (edits[a.id] && (edits[a.id].deleted || edits[a.id].dx || edits[a.id].dy)) return false;
      return a.annotationType === pdfjsLib.AnnotationType.WIDGET || a.annotationType === pdfjsLib.AnnotationType.LINK;
    });
  }

  // Hands the own canvases of form fields to the annotation layer and paints
  // all others back onto the page canvas.
  async placeOwnCanvases(ownCanvases, pdfPage, vp, outputScale, ctx) {
    const fromSource = !needsPreview(this.entry);
    const formsShown = !this.session.readOnlyForms;
    const layerIds = fromSource ? new Set((await this.layerAnnotations()).map((a) => a.id)) : new Set();
    const attached = new Map();
    const rest = [];
    for (const [id, c] of ownCanvases) {
      if (layerIds.has(id) && (formsShown || !Array.isArray(c))) attached.set(id, c);
      else rest.push([id, c]);
    }
    this.annotationCanvases = attached;
    if (!rest.length) return;
    const annots = await pdfPage.getAnnotations({ intent: 'display' });
    const byId = new Map(annots.map((a) => [a.id, a]));
    const storage = fromSource ? this.session.sources.get(this.entry.src.doc)?.pdf.annotationStorage : null;
    for (const [id, c] of rest) {
      const data = byId.get(id);
      if (!data || !data.rect) continue;
      let cv = c;
      if (Array.isArray(c)) {
        // Check box / radio button states. With interactive forms the HTML
        // control shows the live state (see app.css).
        if (formsShown) continue;
        const stored = storage?.getRawValue(id);
        const on = stored && 'value' in stored ? !!stored.value : data.checkBox ? data.fieldValue === data.exportValue : data.fieldValue === data.buttonValue;
        cv = c.find((x) => x.getAttribute('data-canvas-name') === (on ? 'checked' : 'unchecked'));
        if (!cv) continue;
      }
      if (!cv.width || !cv.height) continue;
      const [x1, y1, x2, y2] = data.rect;
      // Own canvas pixels -> PDF user space -> viewport -> device pixels.
      const toPdf = [(x2 - x1) / cv.width, 0, 0, -(y2 - y1) / cv.height, x1, y2];
      const m = mulMatrix(mulMatrix(toPdf, vp.transform), [outputScale, 0, 0, outputScale, 0, 0]);
      ctx.save();
      ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
      ctx.drawImage(cv, 0, 0);
      ctx.restore();
    }
  }

  async renderAnnotationLayer(token) {
    const entry = this.entry;
    if (!entry.src) return;
    const list = await this.layerAnnotations();
    if (!list.length || token !== this.renderToken) return;
    const srcPage = await this.session.getPdfPage(entry.src.doc, entry.src.index);
    const src = this.session.sources.get(entry.src.doc);
    const vp = makeViewport(srcPage, { viewBox: this.geometry.view, scale: this.viewer.scale * CSS_UNITS, rotation: this.geometry.rotation });
    const layerVp = vp.clone({ dontFlip: true });
    // pdf.js shows the original appearance text of a re-created text field
    // unless the storage carries a formatted value; keep it in sync with what
    // the user typed so values survive re-rendering.
    const storage = src.pdf.annotationStorage;
    for (const a of list) {
      if (a.fieldType !== 'Tx') continue;
      const raw = storage.getRawValue(a.id);
      if (raw && typeof raw.value === 'string' && raw.formattedValue !== raw.value) storage.setValue(a.id, { formattedValue: raw.value });
    }
    const layer = new pdfjsLib.AnnotationLayer({
      div: this.annotationLayerDiv,
      accessibilityManager: null,
      annotationCanvasMap: this.annotationCanvases?.size ? this.annotationCanvases : null,
      annotationEditorUIManager: null,
      page: srcPage,
      viewport: layerVp,
      structTreeLayer: null,
      linkService: this.viewer.linkServiceFor(entry),
      annotationStorage: src.pdf.annotationStorage,
    });
    await layer.render({
      annotations: list,
      viewport: layerVp,
      div: this.annotationLayerDiv,
      page: srcPage,
      linkService: this.viewer.linkServiceFor(entry),
      downloadManager: null,
      annotationStorage: src.pdf.annotationStorage,
      renderForms: !this.session.readOnlyForms,
      enableScripting: false,
      hasJSActions: false,
      fieldObjects: null,
      imageResourcesPath: '',
    });
  }
}

export class Viewer extends EventTarget {
  constructor(docView, container) {
    super();
    this.docView = docView;
    this.session = docView.session;
    this.container = container;
    this.pagesEl = h('div', { class: 'pages' });
    this.container.appendChild(this.pagesEl);
    this.pageViews = new Map();
    this.order = [];
    this.scale = 1;
    this.zoomMode = 'auto';
    this.currentIndex = 0;
    this.defaultGeometry = { view: [0, 0, 595, 842], rotation: 0, width: 595, height: 842 };
    this.positions = [];
    this.overlay = docView.overlay;
    this.renderQueue = new Set();
    this.rendering = 0;
    this.onScroll = throttleRaf(() => this.updateVisible());
    this.container.addEventListener('scroll', this.onScroll, { passive: true });
    this.resizeObserver = new ResizeObserver(
      debounce(() => {
        // Ignore size changes while the viewer is hidden (e.g. organizer mode).
        if (!this.container.clientWidth || !this.container.clientHeight) return;
        if (this.zoomMode !== 'custom') this.applyZoomMode(true);
        else this.updateVisible();
      }, 80),
    );
    this.resizeObserver.observe(this.container);
    this.rerenderDebounced = debounce(() => this.rerenderVisible(), 160);
    this.container.addEventListener(
      'wheel',
      (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const factor = Math.exp(-e.deltaY * 0.0022);
          this.setScale(this.scale * factor, { clientX: e.clientX, clientY: e.clientY });
        }
      },
      { passive: false },
    );
    this.linkServices = new Map();
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  linkServiceFor(entry) {
    const srcId = entry.src ? entry.src.doc : null;
    if (this.linkServices.has(srcId)) return this.linkServices.get(srcId);
    const viewer = this;
    const svc = {
      externalLinkEnabled: true,
      isInPresentationMode: false,
      eventBus: { dispatch() {} },
      pagesCount: 0,
      page: 1,
      rotation: 0,
      addLinkAttributes(link, url) {
        link.href = url;
        link.title = url;
        link.rel = 'noopener noreferrer nofollow';
        link.addEventListener('click', (e) => {
          e.preventDefault();
          viewer.docView.openExternalLink(url);
        });
      },
      getDestinationHash() {
        return '#';
      },
      getAnchorUrl() {
        return '#';
      },
      setHash() {},
      async goToDestination(dest) {
        await viewer.goToDestination(srcId, dest);
      },
      goToPage(n) {
        viewer.goToSourcePage(srcId, n - 1);
      },
      goToXY(n) {
        viewer.goToSourcePage(srcId, n - 1);
      },
      executeNamedAction(action) {
        if (action === 'NextPage') viewer.goToIndex(viewer.currentIndex + 1);
        else if (action === 'PrevPage') viewer.goToIndex(viewer.currentIndex - 1);
        else if (action === 'FirstPage') viewer.goToIndex(0);
        else if (action === 'LastPage') viewer.goToIndex(viewer.order.length - 1);
      },
      executeSetOCGState() {},
      cachePageRef() {},
      isPageVisible() {
        return true;
      },
      isPageCached() {
        return true;
      },
    };
    this.linkServices.set(srcId, svc);
    return svc;
  }

  async goToDestination(srcId, dest) {
    const src = this.session.sources.get(srcId);
    if (!src) return;
    let explicit = dest;
    try {
      if (typeof dest === 'string') explicit = await src.pdf.getDestination(dest);
      if (!Array.isArray(explicit)) return;
      const ref = explicit[0];
      const pageIndex = typeof ref === 'object' && ref !== null ? await src.pdf.getPageIndex(ref) : Number.isInteger(ref) ? ref : -1;
      if (pageIndex < 0) return;
      let top = null;
      if (explicit[1] && explicit[1].name === 'XYZ' && typeof explicit[3] === 'number') top = explicit[3];
      else if (explicit[1] && explicit[1].name === 'FitH' && typeof explicit[2] === 'number') top = explicit[2];
      this.goToSourcePage(srcId, pageIndex, top);
    } catch (e) {
      console.warn('destination', e);
    }
  }

  goToSourcePage(srcId, index, top = null) {
    const i = this.session.state.pages.findIndex((p) => p.src && p.src.doc === srcId && p.src.index === index);
    if (i >= 0) this.goToIndex(i, top);
  }

  async rebuild() {
    const pages = this.session.state.pages;
    const old = this.pageViews;
    this.pageViews = new Map();
    this.order = pages.map((p) => p.uid);
    const frag = document.createDocumentFragment();
    for (let i = 0; i < pages.length; i++) {
      const entry = pages[i];
      let pv = old.get(entry.uid);
      if (pv) {
        old.delete(entry.uid);
        pv.setEntry(entry, i);
      } else {
        pv = new PageView(this, entry, i);
      }
      this.pageViews.set(entry.uid, pv);
      frag.appendChild(pv.el);
    }
    for (const pv of old.values()) {
      pv.release();
      pv.el.remove();
    }
    clear(this.pagesEl);
    this.pagesEl.appendChild(frag);
    // Geometry: load the first page eagerly to size placeholders.
    const first = this.pageViews.get(this.order[0]);
    if (first && !first.geometry) await first.loadGeometry();
    if (first && first.geometry) this.defaultGeometry = first.geometry;
    this.loadAllGeometry();
    this.layout();
    if (this.zoomMode !== 'custom') this.applyZoomMode(true);
    this.updateVisible();
  }

  async loadAllGeometry() {
    const token = (this.geomToken = (this.geomToken || 0) + 1);
    let changed = false;
    const views = this.order.map((u) => this.pageViews.get(u));
    for (let i = 0; i < views.length; i++) {
      if (token !== this.geomToken) return;
      const pv = views[i];
      if (!pv || pv.geometry) continue;
      try {
        await pv.loadGeometry();
        changed = true;
      } catch {
        /* ignore */
      }
      if (i % 50 === 49 && changed) {
        this.layout();
        changed = false;
      }
    }
    if (changed && token === this.geomToken) {
      this.layout();
      this.updateVisible();
    }
  }

  layout() {
    let y = PAD_TOP;
    this.positions = [];
    for (const uid of this.order) {
      const pv = this.pageViews.get(uid);
      pv.applySize();
      const { height } = pv.cssSize();
      this.positions.push({ top: y, height });
      y += height + GAP;
    }
    this.totalHeight = y - GAP + PAD_BOTTOM;
  }

  pageViewAt(index) {
    return this.pageViews.get(this.order[index]) || null;
  }

  visibleRange(margin = 0) {
    const top = this.container.scrollTop - margin;
    const bottom = this.container.scrollTop + this.container.clientHeight + margin;
    let first = -1;
    let last = -1;
    for (let i = 0; i < this.positions.length; i++) {
      const p = this.positions[i];
      if (p.top + p.height >= top && p.top <= bottom) {
        if (first < 0) first = i;
        last = i;
      } else if (first >= 0) break;
    }
    return { first, last };
  }

  updateVisible() {
    if (!this.positions.length) return;
    const { first, last } = this.visibleRange(this.container.clientHeight * 0.5);
    const keep = this.visibleRange(this.container.clientHeight * 4);
    for (let i = 0; i < this.order.length; i++) {
      const pv = this.pageViewAt(i);
      if (!pv) continue;
      const inView = i >= first && i <= last;
      pv.visible = inView;
      if (inView) this.queueRender(pv);
      else if ((i < keep.first || i > keep.last) && (pv.renderedKey || pv.canvasWrap.firstChild)) {
        pv.release();
        this.overlay.clearPage(pv);
      }
    }
    // Current page = page under the upper third of the viewport.
    const probe = this.container.scrollTop + this.container.clientHeight * 0.33;
    let current = 0;
    for (let i = 0; i < this.positions.length; i++) {
      if (this.positions[i].top <= probe) current = i;
      else break;
    }
    if (this.container.scrollTop + this.container.clientHeight >= this.container.scrollHeight - 2 && this.positions.length) {
      const vis = this.visibleRange(0);
      if (vis.last >= 0 && this.positions[vis.last].top < this.container.scrollTop + this.container.clientHeight * 0.5) current = vis.last;
    }
    if (current !== this.currentIndex) {
      const prev = this.pageViewAt(this.currentIndex);
      if (prev) prev.el.classList.remove('current');
      this.currentIndex = current;
      this.emit('pagechange', { index: current });
    }
    const cur = this.pageViewAt(current);
    if (cur) cur.el.classList.add('current');
  }

  queueRender(pv) {
    this.renderQueue.add(pv);
    this.pumpRender();
  }

  pumpRender() {
    if (this.destroyed) return;
    while (this.rendering < 3 && this.renderQueue.size) {
      // Prefer pages closest to the current page.
      let best = null;
      for (const pv of this.renderQueue) {
        if (!best || Math.abs(pv.index - this.currentIndex) < Math.abs(best.index - this.currentIndex)) best = pv;
      }
      this.renderQueue.delete(best);
      if (!best.visible || !this.pageViews.has(best.entry.uid)) continue;
      this.rendering++;
      best
        .render()
        .catch((e) => console.error(e))
        .finally(() => {
          this.rendering--;
          this.pumpRender();
        });
    }
  }

  rerenderVisible() {
    for (const pv of this.pageViews.values()) {
      if (pv.visible) this.queueRender(pv);
    }
  }

  invalidatePages(uids, { content = true } = {}) {
    for (const uid of uids) {
      const pv = this.pageViews.get(uid);
      if (!pv) continue;
      const entry = this.session.page(uid);
      if (entry) pv.setEntry(entry, this.order.indexOf(uid));
      if (content) pv.renderedKey = null;
      if (pv.visible) this.queueRender(pv);
    }
  }

  refreshEntries() {
    const pages = this.session.state.pages;
    pages.forEach((entry, i) => {
      const pv = this.pageViews.get(entry.uid);
      if (pv) pv.setEntry(entry, i);
    });
  }

  // ------------------------------------------------------------------ zoom

  fitScale(mode) {
    if (!this.container.clientWidth) return this.scale;
    const pv = this.pageViewAt(this.currentIndex) || this.pageViewAt(0);
    const g = (pv && pv.geometry) || this.defaultGeometry;
    const availW = Math.max(100, this.container.clientWidth - PAD_X * 2 - 14);
    const availH = Math.max(100, this.container.clientHeight - PAD_TOP - 20);
    const sw = availW / (g.width * CSS_UNITS);
    const sh = availH / (g.height * CSS_UNITS);
    if (mode === 'page-width') return sw;
    if (mode === 'page-fit') return Math.min(sw, sh);
    return Math.min(1.25, sw);
  }

  applyZoomMode(keepPosition = false) {
    if (this.zoomMode === 'custom') return;
    const s = this.fitScale(this.zoomMode);
    this.setScale(s, { mode: this.zoomMode, keepPosition });
  }

  setZoomMode(mode) {
    this.zoomMode = mode;
    this.applyZoomMode(true);
  }

  setScale(scale, { clientX = null, clientY = null, mode = 'custom' } = {}) {
    scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale));
    this.zoomMode = mode;
    if (Math.abs(scale - this.scale) < 1e-4) {
      this.emit('zoom', { scale: this.scale, mode: this.zoomMode });
      return;
    }
    // Anchor: keep the document point under (clientX, clientY) fixed.
    const rect = this.container.getBoundingClientRect();
    const ax = clientX !== null ? clientX - rect.left : this.container.clientWidth / 2;
    const ay = clientY !== null ? clientY - rect.top : 0;
    const docY = this.container.scrollTop + ay;
    let anchorIndex = 0;
    for (let i = 0; i < this.positions.length; i++) if (this.positions[i].top <= docY) anchorIndex = i;
    const p = this.positions[anchorIndex];
    const relY = p ? (docY - p.top) / Math.max(1, p.height) : 0;
    const docX = this.container.scrollLeft + ax;
    const relX = this.pagesEl.scrollWidth ? docX / this.pagesEl.scrollWidth : 0;
    this.scale = scale;
    this.layout();
    const np = this.positions[anchorIndex];
    if (np) this.container.scrollTop = np.top + relY * np.height - ay;
    this.container.scrollLeft = relX * this.pagesEl.scrollWidth - ax;
    this.overlay.scaleChanged();
    this.updateVisible();
    this.rerenderDebounced();
    this.emit('zoom', { scale: this.scale, mode: this.zoomMode });
  }

  zoomIn() {
    const next = ZOOM_STEPS.find((z) => z > this.scale + 0.001) || MAX_ZOOM;
    this.setScale(next);
  }

  zoomOut() {
    const prev = [...ZOOM_STEPS].reverse().find((z) => z < this.scale - 0.001) || MIN_ZOOM;
    this.setScale(prev);
  }

  // ------------------------------------------------------------------ navigation

  goToIndex(index, topPoints = null) {
    if (!this.positions.length) return;
    index = Math.max(0, Math.min(this.order.length - 1, index));
    const p = this.positions[index];
    let y = p.top - 8;
    if (topPoints !== null) {
      const pv = this.pageViewAt(index);
      if (pv && pv.geometry) {
        const vp = pv.getViewport();
        const [, vy] = vp.convertToViewportPoint(pv.geometry.view[0], topPoints);
        y = p.top + Math.max(0, vy) - 8;
      }
    }
    this.container.scrollTop = y;
    this.updateVisible();
    if (this.currentIndex !== index && topPoints === null) {
      const prev = this.pageViewAt(this.currentIndex);
      if (prev) prev.el.classList.remove('current');
      this.currentIndex = index;
      this.emit('pagechange', { index });
      const cur = this.pageViewAt(index);
      if (cur) cur.el.classList.add('current');
    }
  }

  // Scrolls so that a user-space rect on a page is visible.
  scrollToRect(index, rect) {
    const pv = this.pageViewAt(index);
    const p = this.positions[index];
    if (!pv || !p) return;
    const vp = pv.getViewport();
    const a = vp.convertToViewportPoint(rect[0], rect[1]);
    const b = vp.convertToViewportPoint(rect[2], rect[3]);
    const r = [a[0], a[1], b[0], b[1]];
    const top = p.top + Math.min(r[1], r[3]);
    const bottom = p.top + Math.max(r[1], r[3]);
    const st = this.container.scrollTop;
    const ch = this.container.clientHeight;
    if (top < st + 20 || bottom > st + ch - 20) this.container.scrollTop = Math.max(0, top - ch / 3);
    const left = pv.el.offsetLeft + Math.min(r[0], r[2]);
    const sl = this.container.scrollLeft;
    const cw = this.container.clientWidth;
    if (left < sl || left > sl + cw - 40) this.container.scrollLeft = Math.max(0, left - cw / 3);
    this.updateVisible();
  }

  destroy() {
    this.destroyed = true;
    this.renderQueue.clear();
    this.resizeObserver.disconnect();
    for (const pv of this.pageViews.values()) pv.release();
  }
}
