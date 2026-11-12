// Document workspace: sidebar, viewer, organizer, properties panel and
// status bar for one open document.
import { h, clear, debounce, uid, basename, stripExt, cssColor, keepPlainKeys } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { showMenu, toast, confirmDialog, promptDialog, openDialog, alertDialog, withBusy, passwordDialog } from '../ui/dialogs.js';
import { Viewer, ZOOM_STEPS } from './viewer.js';
import { Overlay, objectBounds, translateObject } from './overlay.js';
import { ToolController, MARKUP_TOOLS } from './tools.js';
import { EditMode } from './edit-mode.js';
import { PropertiesPanel, toolStyle } from './props.js';
import { PageGrid } from './page-grid.js';
import { ThumbnailService } from './thumbnails.js';
import { OutlinePanel, CommentsPanel, SearchPanel, AttachmentsPanel } from './panels.js';
import { viewRect } from './viewport.js';
import { getShaper } from '../pdf/fonts.js';
import { layoutTextBox, frameForRect, rectFromLocal } from '../../../core/text-layout.js';
import { searchDocument } from '../doc/search.js';
import { prepareImageFile, decodeImageXObject, imageDataToBytes } from '../doc/image-tools.js';
import { settings } from '../settings.js';
import { t, errorMessage, hasKey } from '../i18n.js';
import { getCurrentStamp } from '../features/signature.js';

let clipboard = null;

// Phones and small tablets: the side panels open over the document.
export const isCompact = () => window.matchMedia('(max-width: 760px)').matches;

export class DocView {
  constructor(app, session) {
    this.app = app;
    this.session = session;
    this.mode = 'view';
    this.transient = new Map();
    this.searchHits = { results: [], active: -1 };
    this.el = h('div', { class: 'view doc-view' });
    this.banner = h('div', { class: 'banner hidden' });
    this.overlay = new Overlay(this);
    this.thumbs = new ThumbnailService(session);
    this.viewerEl = h('div', { class: 'viewer', tabindex: '0' });
    this.organizerEl = h('div', { class: 'organizer hidden', tabindex: '-1' });
    this.viewer = new Viewer(this, this.viewerEl);
    this.tools = new ToolController(this);
    this.editMode = new EditMode(this);
    this.props = new PropertiesPanel(this);
    this.thumbGrid = new PageGrid(this, { mode: 'sidebar', thumbWidth: 150 });
    this.organizer = new PageGrid(this, { mode: 'organizer', thumbWidth: 170 });
    this.organizerEl.appendChild(this.organizer.el);
    this.outline = new OutlinePanel(this);
    this.comments = new CommentsPanel(this);
    this.search = new SearchPanel(this);
    this.attachments = new AttachmentsPanel(this);
    this.buildLayout();
    this.bindSession();
    this.bindViewer();
  }

  // ------------------------------------------------------------------ layout

  buildLayout() {
    this.panelBody = h('div', { class: 'panel-host', style: { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' } });
    this.thumbPanel = h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } }, h('div', { class: 'panel-header' }, h('span', null, t('panel.thumbnails'))), h('div', { class: 'panel-body' }, this.thumbGrid.el));
    const handle = h('div', { class: 'resize-handle' });
    this.sidePanel = h('div', { class: 'side-panel' }, this.panelBody, handle);
    handle.addEventListener('pointerdown', (e) => {
      const startX = e.clientX;
      const startW = this.sidePanel.offsetWidth;
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        this.sidePanel.style.width = `${Math.max(160, Math.min(520, startW + ev.clientX - startX))}px`;
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
    const railBtn = (id, ic, label) => {
      const b = h('button', { class: 'rail-btn', 'data-tip': label, 'data-panel': id, onclick: () => this.togglePanel(id) }, icon(ic));
      return b;
    };
    this.rail = h('div', { class: 'rail' }, railBtn('thumbnails', 'thumbnails', t('panel.thumbnails')), railBtn('bookmarks', 'bookmark', t('panel.bookmarks')), railBtn('comments', 'comments', t('panel.comments')), railBtn('search', 'search', t('panel.search')), railBtn('attachments', 'paperclip', t('panel.attachments')));
    this.pageInput = h('input', { class: 'page-input', value: '1' });
    this.pageTotal = h('span', null, '/ 0');
    this.zoomSelect = h('select', null);
    this.statusMsg = h('span', { class: 'sb-msg' });
    this.statusbar = h(
      'div',
      { class: 'statusbar' },
      h(
        'div',
        { class: 'sb-group' },
        h('button', { class: 'icon-btn', 'data-tip': t('nav.first'), onclick: () => this.viewer.goToIndex(0) }, icon('first')),
        h('button', { class: 'icon-btn', 'data-tip': t('nav.prev'), onclick: () => this.viewer.goToIndex(this.viewer.currentIndex - 1) }, icon('chevronLeft')),
        this.pageInput,
        this.pageTotal,
        h('button', { class: 'icon-btn', 'data-tip': t('nav.next'), onclick: () => this.viewer.goToIndex(this.viewer.currentIndex + 1) }, icon('chevronRight')),
        h('button', { class: 'icon-btn', 'data-tip': t('nav.last'), onclick: () => this.viewer.goToIndex(this.session.state.pages.length - 1) }, icon('last')),
      ),
      this.statusMsg,
      h('div', { class: 'sb-spacer' }),
      h(
        'div',
        { class: 'sb-group' },
        h('button', { class: 'icon-btn', 'data-tip': t('zoom.fitWidth'), onclick: () => this.viewer.setZoomMode('page-width') }, icon('fitWidth')),
        h('button', { class: 'icon-btn', 'data-tip': t('zoom.fitPage'), onclick: () => this.viewer.setZoomMode('page-fit') }, icon('fitPage')),
        h('button', { class: 'icon-btn', 'data-tip': t('zoom.out'), onclick: () => this.viewer.zoomOut() }, icon('zoomOut')),
        this.zoomSelect,
        h('button', { class: 'icon-btn', 'data-tip': t('zoom.in'), onclick: () => this.viewer.zoomIn() }, icon('zoomIn')),
      ),
    );
    this.pageInput.addEventListener('keydown', (e) => {
      keepPlainKeys(e);
      if (e.key === 'Enter') {
        const n = parseInt(this.pageInput.value, 10);
        if (Number.isFinite(n)) this.viewer.goToIndex(n - 1);
        this.pageInput.blur();
      }
    });
    this.pageInput.addEventListener('focus', () => this.pageInput.select());
    this.zoomSelect.addEventListener('change', () => {
      const v = this.zoomSelect.value;
      if (v === 'page-width' || v === 'page-fit' || v === 'auto') this.viewer.setZoomMode(v);
      else this.viewer.setScale(parseFloat(v));
    });
    this.propsVisible = true;
    this.main = h('div', { class: 'doc-main' }, this.rail, this.sidePanel, this.viewerEl, this.organizerEl, this.props.el);
    this.el.append(this.banner, this.main, this.statusbar);
    this.organizerEl.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('application/x-pdfedit-pages')) e.preventDefault();
    });
    this.organizerEl.addEventListener('drop', (e) => {
      if (e.target.closest('.org-item')) return;
      e.preventDefault();
      const data = e.dataTransfer.getData('application/x-pdfedit-pages');
      if (data) this.session.movePages(JSON.parse(data), this.session.state.pages.length);
      else if (e.dataTransfer.files.length) this.insertDroppedFiles([...e.dataTransfer.files], this.session.state.pages.length);
    });
    this.organizerEl.addEventListener('click', (e) => {
      if (e.target === this.organizerEl || e.target === this.organizer.el) {
        this.organizer.selection.clear();
        this.organizer.syncSelection();
      }
    });
    // On small screens the panels cover the document: a page picked in the
    // thumbnails, or a tap on the document, closes them.
    this.sidePanel.addEventListener('click', (e) => {
      if (isCompact() && this.activePanel === 'thumbnails' && e.target.closest('.thumb')) setTimeout(() => this.togglePanel('thumbnails', false), 120);
    });
    this.viewerEl.addEventListener('pointerdown', () => {
      if (!isCompact()) return;
      if (this.activePanel) this.togglePanel(this.activePanel, false);
    });
    this.updateZoomSelect();
  }

  togglePanel(id, force = null) {
    const open = force !== null ? force : this.activePanel !== id || this.sidePanel.classList.contains('hidden');
    for (const b of this.rail.querySelectorAll('.rail-btn')) b.classList.toggle('active', open && b.dataset.panel === id);
    if (!open) {
      this.sidePanel.classList.add('hidden');
      this.activePanel = null;
      return;
    }
    this.sidePanel.classList.remove('hidden');
    this.activePanel = id;
    clear(this.panelBody);
    if (id === 'thumbnails') {
      this.panelBody.appendChild(this.thumbPanel);
      this.thumbGrid.render();
    } else if (id === 'bookmarks') {
      this.panelBody.appendChild(this.outline.el);
      this.outline.load();
    } else if (id === 'comments') {
      this.panelBody.appendChild(this.comments.el);
      this.comments.render();
    } else if (id === 'search') {
      this.panelBody.appendChild(this.search.el);
      setTimeout(() => this.search.focus(), 0);
    } else if (id === 'attachments') {
      this.panelBody.appendChild(this.attachments.el);
      this.attachments.render();
    }
  }

  toggleProps(force = null) {
    this.propsVisible = force !== null ? force : !this.propsVisible;
    this.props.el.classList.toggle('hidden', !this.propsVisible || this.mode === 'organize');
    this.app.updateRibbonState();
  }

  async init() {
    const compact = isCompact();
    if (compact) this.toggleProps(false);
    await this.viewer.rebuild();
    this.updatePageStatus();
    this.togglePanel('thumbnails', !compact);
    this.tools.setTool('select');
    this.updateBanner();
    this.props.update();
    this.viewerEl.focus({ preventScroll: true });
  }

  setMode(mode) {
    if (this.mode === mode) return;
    this.overlay.commitEditing();
    this.mode = mode;
    const org = mode === 'organize';
    this.organizerEl.classList.toggle('hidden', !org);
    this.viewerEl.classList.toggle('hidden', org);
    this.props.el.classList.toggle('hidden', org || !this.propsVisible);
    if (org) {
      this.organizer.render();
      const cur = this.session.state.pages[this.viewer.currentIndex];
      if (cur && !this.organizer.selection.size) this.organizer.selectOnly(cur.uid);
      this.organizerEl.focus({ preventScroll: true });
    } else {
      requestAnimationFrame(() => {
        if (this.viewer.zoomMode !== 'custom') this.viewer.applyZoomMode(true);
        this.viewer.updateVisible();
      });
      this.viewerEl.focus({ preventScroll: true });
    }
    this.app.updateRibbonState();
  }

  openPageInViewer(index) {
    this.setMode('view');
    this.app.selectRibbonTab('home');
    requestAnimationFrame(() => this.viewer.goToIndex(index));
  }

  // ------------------------------------------------------------------ session wiring

  bindSession() {
    this.session.addEventListener('change', (e) => this.onSessionChange(e.detail));
    this.session.addEventListener('dirty', () => this.app.updateTabs());
    this.session.addEventListener('restrictions', () => {
      this.updateBanner();
      this.app.updateRibbonState();
    });
    this.pendingThumbs = new Set();
    this.flushThumbs = debounce(() => {
      const uids = [...this.pendingThumbs];
      this.pendingThumbs.clear();
      this.thumbGrid.invalidate(uids);
      if (this.mode === 'organize') this.organizer.invalidate(uids);
    }, 700);
    this.commentsRefresh = debounce(() => {
      if (this.activePanel === 'comments') this.comments.render();
    }, 200);
  }

  async onSessionChange(diff) {
    if (diff.structure) {
      this.thumbs.clear();
      await this.viewer.rebuild();
      this.thumbGrid.render();
      if (this.mode === 'organize') this.organizer.render();
      this.editMode.cache.clear();
      this.editMode.refresh();
    } else {
      this.viewer.refreshEntries();
    }
    if (diff.content && diff.content.size) {
      this.viewer.invalidatePages(diff.content);
      this.thumbGrid.invalidate(diff.content);
      if (this.mode === 'organize') this.organizer.invalidate(diff.content);
      for (const u of diff.content) this.editMode.cache.delete(u);
    }
    if (diff.objects && diff.objects.size) {
      this.overlay.refreshPages(diff.objects);
      for (const u of diff.objects) this.pendingThumbs.add(u);
      this.flushThumbs();
    }
    if (diff.structure) this.overlay.refreshAll();
    if (this.overlay.selection && !this.session.page(this.overlay.selection.pageUid)) this.overlay.selection = null;
    if (this.overlay.selection && this.overlay.selection.kind === 'object' && !this.overlay.selectedObject()) this.overlay.selection = null;
    this.outline.sessionChanged(diff);
    this.search.sessionChanged(diff);
    this.commentsRefresh();
    this.updatePageStatus();
    this.props.update();
    this.app.updateTabs();
    this.app.updateRibbonState();
    if (diff.label && (diff.undo || diff.redo)) {
      const key = `action.${diff.label}`;
      this.setStatus(t(diff.undo ? 'status.undone' : 'status.redone', { action: hasKey(key) ? t(key) : t('action.generic') }));
    }
  }

  bindViewer() {
    this.viewer.addEventListener('pagechange', (e) => {
      this.updatePageStatus();
      this.thumbGrid.setCurrent(e.detail.index);
    });
    this.viewer.addEventListener('zoom', () => this.updateZoomSelect());
    this.viewer.addEventListener('pagerendered', (e) => {
      const pv = e.detail.pageView;
      this.tools.applyLayerState(pv);
      if (this.editMode.active) this.editMode.renderPage(pv);
      this.renderSearchHits(pv);
    });
    this.viewerEl.addEventListener('scroll', () => {
      if (this.notePopup) this.closeNotePopup();
    });
  }

  updatePageStatus() {
    const n = this.session.state.pages.length;
    this.pageTotal.textContent = `/ ${n}`;
    if (document.activeElement !== this.pageInput) this.pageInput.value = String(Math.min(n, this.viewer.currentIndex + 1));
  }

  updateZoomSelect() {
    const opts = [
      ['auto', t('zoom.auto')],
      ['page-width', t('zoom.fitWidth')],
      ['page-fit', t('zoom.fitPage')],
      ...ZOOM_STEPS.filter((z) => z >= 0.25 && z <= 4).map((z) => [String(z), `${Math.round(z * 100)}%`]),
    ];
    const cur = this.viewer.zoomMode !== 'custom' ? this.viewer.zoomMode : String(this.viewer.scale);
    clear(this.zoomSelect);
    let found = false;
    for (const [v, label] of opts) {
      const o = h('option', { value: v }, v === this.viewer.zoomMode ? `${label} (${Math.round(this.viewer.scale * 100)}%)` : label);
      if (v === cur) {
        o.selected = true;
        found = true;
      }
      this.zoomSelect.appendChild(o);
    }
    if (!found) this.zoomSelect.insertBefore(h('option', { value: cur, selected: true }, `${Math.round(this.viewer.scale * 100)}%`), this.zoomSelect.firstChild);
    this.app.updateRibbonState();
  }

  setStatus(msg) {
    this.statusMsg.textContent = msg || '';
    clearTimeout(this.statusTimer);
    if (msg) this.statusTimer = setTimeout(() => (this.statusMsg.textContent = ''), 5000);
  }

  updateBanner() {
    clear(this.banner);
    if (this.session.restricted) {
      this.banner.append(
        icon('lock'),
        h('span', null, t('banner.restricted')),
        h('div', { class: 'banner-spacer' }),
        h('button', { class: 'btn small', onclick: () => this.unlockRestrictions() }, t('banner.enterPassword')),
      );
      this.banner.classList.remove('hidden');
    } else {
      this.banner.classList.add('hidden');
    }
  }

  async unlockRestrictions() {
    const pw = await passwordDialog(this.session.name);
    if (pw === null) return;
    const ok = await this.session.unlockRestrictions(pw);
    if (!ok) toast(t('password.wrongOwner'), { type: 'error' });
    else toast(t('banner.unlocked'), { type: 'success' });
  }

  isReadOnly() {
    return !!this.session.restricted;
  }

  warnReadOnly() {
    toast(t('banner.restricted'), { type: 'error' });
  }

  // ------------------------------------------------------------------ tools & selection

  setTool(tool, options) {
    if (this.overlay.editing) this.overlay.commitEditing();
    if (tool !== 'edit' && this.editMode.active) this.editMode.setActive(false);
    this.tools.setTool(tool, options);
    if (tool === 'edit') {
      this.editMode.setActive(true);
      this.props.update();
    }
    if (tool !== 'select') this.overlay.clearSelection();
  }

  toolChanged() {
    this.overlay.refreshAll();
    this.props.update();
    this.app.updateRibbonState();
  }

  toolStyle(tool) {
    return toolStyle(tool === 'freetext' ? 'freetext' : tool);
  }

  currentStamp() {
    return getCurrentStamp();
  }

  annotationsSelectable() {
    return this.tools.tool === 'select';
  }

  selectionChanged() {
    this.props.update();
    this.app.updateRibbonState();
    if (this.activePanel === 'comments') this.comments.render();
  }

  focusInProps() {
    return this.props.el.contains(document.activeElement);
  }

  pageSelectionChanged() {
    this.app.updateRibbonState();
  }

  selectedPageUids() {
    if (this.mode === 'organize') {
      const uids = this.organizer.selectedUids();
      if (uids.length) return uids;
    } else if (this.activePanel === 'thumbnails' && this.thumbGrid.selection.size > 1) {
      return this.thumbGrid.selectedUids();
    }
    const cur = this.session.state.pages[this.viewer.currentIndex];
    return cur ? [cur.uid] : [];
  }

  addObject(pv, obj, { select = true, transient = false } = {}) {
    const id = this.session.addObject(pv.entry.uid, obj, `add_${obj.type}`);
    if (transient) this.transient.set(id, { original: obj.text || '', created: true, seq: this.session.changeSeq });
    if (select) this.overlay.select(pv.entry.uid, id);
    return id;
  }

  markTransient(id, info) {
    this.transient.set(id, { ...info, seq: this.session.changeSeq });
  }

  startEditingById(pv, id) {
    const obj = (this.session.page(pv.entry.uid)?.objects || []).find((o) => o.id === id);
    if (obj) this.overlay.startEditing(pv, obj);
  }

  editorInput() {
    // The contenteditable grows naturally; nothing to do until commit.
  }

  async fitTextRect(obj, text) {
    const shaper = await getShaper(obj.font || {}, text);
    const f = frameForRect(obj.rect, obj.rot || 0);
    const size = obj.size || 12;
    const padding = obj.type === 'freetext' ? obj.padding ?? 4 : 0;
    const layout = layoutTextBox({ text, measure: shaper.measure, size, boxWidth: f.width, wrap: obj.wrap !== false, align: obj.align || 'left', lineHeight: obj.lineHeight || 1.2, ascent: shaper.metrics.ascent, descent: shaper.metrics.descent, padding });
    const w = obj.wrap === false ? Math.max(layout.width, size * 0.6) + 1 : f.width;
    let hgt = Math.max(layout.height, size * (obj.lineHeight || 1.2) + padding * 2);
    if (obj.type === 'freetext') hgt = Math.max(hgt, f.height);
    return rectFromLocal(f.origin, w, hgt, obj.rot || 0);
  }

  async finishTextEdit(pageUid, id, text) {
    const found = this.session.findObject(id);
    if (!found) return;
    const obj = found.object;
    const tr = this.transient.get(id);
    this.transient.delete(id);
    // True while nothing else changed since the box was created or the text
    // block was taken over, so the edit can be folded into that undo step.
    const pristine = !!tr && tr.seq === this.session.changeSeq;
    const dropCreation = () => {
      this.session.undo();
      this.session.redoStack.pop();
    };
    const unchanged = text === (obj.text || '');
    if (pristine && unchanged && tr.original === text) {
      // Nothing changed: drop the creation step entirely.
      dropCreation();
      this.overlay.selection = null;
      this.props.update();
      return;
    }
    if (!text.trim()) {
      if (pristine && tr.created) dropCreation();
      else this.session.removeObjects([id], 'deleteText', { merge: pristine });
      this.overlay.selection = null;
      this.props.update();
      return;
    }
    if (unchanged) {
      this.overlay.refreshPages([pageUid]);
      return;
    }
    const rect = await this.fitTextRect(obj, text);
    this.session.updateObject(id, { text, rect }, 'editText', { merge: pristine });
  }

  async commitTextResize(obj, patch) {
    const next = { ...obj, ...patch };
    const rect = await this.fitTextRect(next, next.text || '');
    this.session.updateObject(obj.id, { ...patch, rect }, 'resizeObject');
  }

  objectDoubleClicked(pv, obj, e) {
    if (this.isReadOnly()) return;
    if (obj.type === 'text' || obj.type === 'freetext') this.overlay.startEditing(pv, obj, e);
    else if (obj.type === 'note') this.openNotePopup(pv, obj.id);
    else if (obj.type === 'link') this.editLink(obj);
    else if (obj.type === 'stamp' && !obj.asset) this.props.update();
  }

  async annotDoubleClicked(pv, annot) {
    const page = this.session.page(pv.entry.uid);
    const cur = page?.annotEdits?.[annot.id]?.contents ?? annot.contentsObj?.str ?? '';
    const v = await promptDialog(t('props.comment'), cur, { title: t('comments.edit') });
    if (v !== null) this.setAnnotEdit(pv.entry.uid, annot.id, { contents: v });
  }

  setAnnotEdit(pageUid, id, patch) {
    this.session.updatePage(pageUid, 'editAnnotation', (p) => {
      p.annotEdits = p.annotEdits || {};
      p.annotEdits[id] = { ...(p.annotEdits[id] || {}), ...patch };
    });
  }

  moveExistingAnnotation(pageUid, annot, dx, dy) {
    const page = this.session.page(pageUid);
    const cur = page?.annotEdits?.[annot.id] || {};
    this.setAnnotEdit(pageUid, annot.id, { dx: (cur.dx || 0) + dx, dy: (cur.dy || 0) + dy });
  }

  deleteSelection() {
    if (this.isReadOnly()) return this.warnReadOnly();
    const sel = this.overlay.selection;
    if (this.editMode.active && this.editMode.selectedImage) return this.editMode.deleteSelectedImage();
    if (!sel) return false;
    if (sel.kind === 'object') {
      this.overlay.selection = null;
      this.session.removeObjects([sel.id]);
    } else if (sel.kind === 'annot') {
      this.overlay.selection = null;
      this.setAnnotEdit(sel.pageUid, sel.id, { deleted: true });
    }
    this.props.update();
    return true;
  }

  duplicateSelection() {
    const obj = this.overlay.selectedObject();
    if (!obj) return;
    const pageUid = this.overlay.selection.pageUid;
    const copy = { ...structuredClone(obj), ...translateObject(obj, 10, -10), id: uid('o') };
    delete copy.fromBlock;
    this.session.addObject(pageUid, copy, 'duplicate');
    this.overlay.select(pageUid, copy.id);
  }

  copySelection() {
    const obj = this.overlay.selectedObject();
    if (!obj) return false;
    const assets = {};
    if (obj.asset) assets[obj.asset] = this.session.assets.get(obj.asset);
    clipboard = { obj: structuredClone(obj), assets, from: this.session.id };
    return true;
  }

  cutSelection() {
    if (this.copySelection()) this.deleteSelection();
  }

  pasteObject() {
    if (!clipboard) return false;
    const pv = this.viewer.pageViewAt(this.viewer.currentIndex);
    if (!pv) return false;
    const obj = structuredClone(clipboard.obj);
    if (obj.asset && clipboard.from !== this.session.id) {
      const a = clipboard.assets[obj.asset];
      if (a) obj.asset = this.session.addAsset(a.bytes, a.mime, { width: a.width, height: a.height });
    }
    const sameDoc = clipboard.from === this.session.id;
    Object.assign(obj, translateObject(obj, sameDoc ? 12 : 0, sameDoc ? -12 : 0));
    obj.id = uid('o');
    delete obj.fromBlock;
    this.session.addObject(pv.entry.uid, obj, 'paste');
    this.overlay.select(pv.entry.uid, obj.id);
    clipboard.obj = structuredClone(obj);
    return true;
  }

  nudgeSelection(dx, dy) {
    const obj = this.overlay.selectedObject();
    if (obj) {
      this.session.updateObject(obj.id, translateObject(obj, dx, dy), 'moveObject');
      return true;
    }
    const sel = this.overlay.selection;
    if (sel && sel.kind === 'annot') {
      this.moveExistingAnnotation(sel.pageUid, sel.annot, dx, dy);
      return true;
    }
    return false;
  }

  rotateObject(id, delta) {
    const found = this.session.findObject(id);
    if (!found) return;
    const o = found.object;
    const r = o.rect;
    const cx = (r[0] + r[2]) / 2;
    const cy = (r[1] + r[3]) / 2;
    const w = r[2] - r[0];
    const hh = r[3] - r[1];
    const rect = [cx - hh / 2, cy - w / 2, cx + hh / 2, cy + w / 2];
    this.session.updateObject(id, { rect, rot: ((((o.rot || 0) + delta) % 360) + 360) % 360 }, 'rotateObject');
  }

  // ------------------------------------------------------------------ menus

  objectContextMenu(e, pv, obj, annot) {
    const items = [];
    if (obj) {
      if (obj.type === 'text' || obj.type === 'freetext') items.push({ label: t('menu.editText'), icon: 'editText', onClick: () => this.overlay.startEditing(pv, obj) });
      if (obj.type === 'note') items.push({ label: t('menu.openNote'), icon: 'note', onClick: () => this.openNotePopup(pv, obj.id) });
      if (obj.type === 'link') items.push({ label: t('menu.editLink'), icon: 'link', onClick: () => this.editLink(obj) });
      items.push({ label: t('common.copy'), icon: 'copy', shortcut: 'Ctrl+C', onClick: () => this.copySelection() });
      items.push({ label: t('common.duplicate'), icon: 'copy', shortcut: 'Ctrl+D', onClick: () => this.duplicateSelection() });
      if (obj.type === 'image' || obj.type === 'signature') {
        items.push({ label: t('props.rotateLeft'), icon: 'rotateLeft', onClick: () => this.rotateObject(obj.id, -90) });
        items.push({ label: t('props.rotateRight'), icon: 'rotateRight', onClick: () => this.rotateObject(obj.id, 90) });
      }
      items.push({ separator: true });
      items.push({ label: t('common.delete'), icon: 'trash', shortcut: 'Del', onClick: () => this.deleteSelection() });
    } else if (annot) {
      items.push({ label: t('comments.edit'), icon: 'edit', onClick: () => this.annotDoubleClicked(pv, annot) });
      items.push({ label: t('common.delete'), icon: 'trash', onClick: () => this.deleteSelection() });
    }
    showMenu({ x: e.clientX, y: e.clientY }, items);
  }

  pageContextMenu(e, pv) {
    const uid = pv.entry.uid;
    const text = window.getSelection().toString();
    const items = [];
    if (text) {
      items.push({ label: t('common.copy'), icon: 'copy', onClick: () => navigator.clipboard.writeText(text) });
      items.push({ label: t('tool.highlight'), icon: 'highlight', onClick: () => this.markupSelection('highlight') });
      items.push({ label: t('tool.underline'), icon: 'underline', onClick: () => this.markupSelection('underline') });
      items.push({ label: t('tool.strikeout'), icon: 'strike', onClick: () => this.markupSelection('strikeout') });
      items.push({ label: t('search.searchFor'), icon: 'search', onClick: () => { this.togglePanel('search', true); this.search.focus(text); } });
      items.push({ separator: true });
    }
    if (clipboard) items.push({ label: t('common.paste'), icon: 'copy', onClick: () => this.pasteObject() });
    items.push({ label: t('page.rotateLeft'), icon: 'rotateLeft', onClick: () => this.session.rotatePages([uid], -90) });
    items.push({ label: t('page.rotateRight'), icon: 'rotateRight', onClick: () => this.session.rotatePages([uid], 90) });
    items.push({ label: t('page.insertBlankAfter'), icon: 'blank', onClick: () => this.app.features.pages.insertBlank(this, this.session.pageIndex(uid) + 1) });
    items.push({ label: t('page.extract'), icon: 'extract', onClick: () => this.app.features.pages.extract(this, [uid]) });
    items.push({ separator: true });
    items.push({ label: t('page.delete'), icon: 'trash', onClick: () => this.deletePages([uid]) });
    showMenu({ x: e.clientX, y: e.clientY }, items);
  }

  pagesContextMenu(e, uids) {
    const P = this.app.features.pages;
    const idx = Math.max(...uids.map((u) => this.session.pageIndex(u)));
    showMenu({ x: e.clientX, y: e.clientY }, [
      { label: t('page.rotateLeft'), icon: 'rotateLeft', onClick: () => this.session.rotatePages(uids, -90) },
      { label: t('page.rotateRight'), icon: 'rotateRight', onClick: () => this.session.rotatePages(uids, 90) },
      { label: t('page.duplicate'), icon: 'copy', onClick: () => this.session.duplicatePages(uids) },
      { separator: true },
      { label: t('page.insertBlankAfter'), icon: 'blank', onClick: () => P.insertBlank(this, idx + 1) },
      { label: t('page.insertFile'), icon: 'insert', onClick: () => P.insertFromFile(this, idx + 1) },
      { label: t('page.extract'), icon: 'extract', onClick: () => P.extract(this, uids) },
      { label: t('page.replace'), icon: 'replace', onClick: () => P.replace(this, uids) },
      { separator: true },
      { label: t('page.delete'), icon: 'trash', onClick: () => this.deletePages(uids) },
    ]);
  }

  imageContextMenu(e, pv, img) {
    showMenu({ x: e.clientX, y: e.clientY }, [
      { label: t('edit.replaceImage'), icon: 'replace', onClick: () => this.replaceSelectedContentImage() },
      { label: t('edit.extractImage'), icon: 'download', onClick: () => this.extractSelectedContentImage() },
      { separator: true },
      { label: t('common.delete'), icon: 'trash', onClick: () => this.editMode.deleteSelectedImage() },
    ]);
  }

  markupSelection(type) {
    const prev = this.tools.tool;
    this.tools.tool = type;
    this.tools.createMarkupFromSelection();
    this.tools.tool = prev;
  }

  // ------------------------------------------------------------------ notes, links

  openNotePopup(pv, id) {
    this.closeNotePopup();
    const found = this.session.findObject(id);
    if (!found) return;
    const obj = found.object;
    const vp = pv.getViewport();
    const vr = viewRect(vp, obj.rect);
    const ta = h('textarea', { placeholder: t('props.commentPlaceholder') }, obj.contents || '');
    const popup = h(
      'div',
      { class: 'note-popup', style: { left: `${vr.left + vr.width + 6}px`, top: `${vr.top}px` } },
      h('div', { class: 'np-head' }, h('b', null, obj.author || settings.author || t('tool.note')), h('button', { class: 'icon-btn', onclick: () => this.closeNotePopup() }, icon('close'))),
      ta,
    );
    ta.addEventListener('keydown', (e) => {
      keepPlainKeys(e);
      if (e.key === 'Escape') this.closeNotePopup();
    });
    ta.addEventListener('pointerdown', (e) => e.stopPropagation());
    pv.el.appendChild(popup);
    this.notePopup = { el: popup, ta, id, original: obj.contents || '' };
    ta.focus();
  }

  closeNotePopup() {
    const np = this.notePopup;
    if (!np) return;
    this.notePopup = null;
    np.el.remove();
    if (np.ta.value !== np.original) this.session.updateObject(np.id, { contents: np.ta.value }, 'editComment');
  }

  async linkDialog(initial = null) {
    const pages = this.session.state.pages;
    const kind = h('select', { class: 'input' }, h('option', { value: 'url' }, t('link.url')), h('option', { value: 'page' }, t('link.page')));
    const url = h('input', { class: 'input', placeholder: 'https://', value: initial?.type === 'url' ? initial.url : '' });
    const page = h('input', { class: 'input', type: 'number', min: 1, max: pages.length, value: initial?.type === 'page' ? Math.max(1, pages.findIndex((p) => p.uid === initial.pageUid) + 1) : 1 });
    kind.value = initial?.type || 'url';
    const urlRow = h('div', { class: 'form-row' }, h('label', null, t('link.url')), url);
    const pageRow = h('div', { class: 'form-row' }, h('label', null, t('link.page')), page);
    const sync = () => {
      urlRow.classList.toggle('hidden', kind.value !== 'url');
      pageRow.classList.toggle('hidden', kind.value !== 'page');
    };
    kind.addEventListener('change', sync);
    sync();
    const res = await openDialog({
      title: t('link.title'),
      content: [h('div', { class: 'form-row' }, h('label', null, t('link.type')), kind), urlRow, pageRow],
      buttons: [
        { label: t('common.cancel'), value: null },
        {
          label: t('common.ok'),
          primary: true,
          onClick: () => {
            if (kind.value === 'url') {
              let u = url.value.trim();
              if (!u) return false;
              if (!/^[a-z]+:/i.test(u)) u = /@/.test(u) && !/\//.test(u) ? `mailto:${u}` : `https://${u}`;
              return { type: 'url', url: u };
            }
            const n = Math.max(1, Math.min(pages.length, parseInt(page.value, 10) || 1));
            return { type: 'page', pageUid: pages[n - 1].uid };
          },
        },
      ],
    }).promise;
    return res || null;
  }

  async createLink(pv, rect) {
    const action = await this.linkDialog();
    if (action) this.addObject(pv, { type: 'link', rect, action });
  }

  async editLink(obj) {
    const action = await this.linkDialog(obj.action);
    if (action) this.session.updateObject(obj.id, { action }, 'editLink');
  }

  async openExternalLink(url) {
    if (!/^(https?|mailto):/i.test(url)) return;
    const ok = await confirmDialog(t('link.openConfirm', { url }), { okLabel: t('link.open') });
    if (ok) window.api.shell.openExternal(url);
  }

  // ------------------------------------------------------------------ pages

  async deletePages(uids) {
    if (this.isReadOnly()) return this.warnReadOnly();
    if (uids.length >= this.session.state.pages.length) {
      toast(t('page.cannotDeleteAll'), { type: 'error' });
      return;
    }
    if (uids.length > 1 && !(await confirmDialog(t('page.deleteConfirm', { n: uids.length }), { danger: true, okLabel: t('common.delete') }))) return;
    this.session.deletePages(uids);
    this.organizer.selection.clear();
    this.thumbGrid.selection.clear();
  }

  async insertDroppedFiles(files, index) {
    for (const f of files) {
      const name = f.name || '';
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (/\.pdf$/i.test(name) || (bytes[0] === 0x25 && bytes[1] === 0x50)) {
        await this.app.features.pages.insertPdfBytes(this, bytes, name, index);
      } else if (/\.(png|jpe?g|gif|bmp|webp|tiff?)$/i.test(name)) {
        await this.app.features.pages.insertImagePages(this, [{ bytes, name }], index);
      }
    }
  }

  async cropFromRect(pv, rect) {
    const g = pv.geometry;
    const view = g.view;
    const margins = { left: rect[0] - view[0], bottom: rect[1] - view[1], right: view[2] - rect[2], top: view[3] - rect[3] };
    const scope = h('select', { class: 'input' }, h('option', { value: 'current' }, t('crop.current')), h('option', { value: 'all' }, t('crop.all')), h('option', { value: 'range' }, t('crop.range')));
    const range = h('input', { class: 'input', placeholder: '1-3, 5', disabled: true });
    scope.addEventListener('change', () => (range.disabled = scope.value !== 'range'));
    const fmt = (v) => `${(v / 72 * 25.4).toFixed(1)} mm`;
    const res = await openDialog({
      title: t('crop.title'),
      content: [
        h('div', { class: 'hint' }, t('crop.margins', { left: fmt(margins.left), right: fmt(margins.right), top: fmt(margins.top), bottom: fmt(margins.bottom) })),
        h('div', { class: 'form-row' }, h('label', null, t('crop.applyTo')), scope),
        h('div', { class: 'form-row' }, range),
      ],
      buttons: [
        { label: t('common.cancel'), value: null },
        { label: t('crop.apply'), primary: true, onClick: () => ({ scope: scope.value, range: range.value }) },
      ],
    }).promise;
    if (!res) return;
    const pages = this.session.state.pages;
    let targets = [pv.entry.uid];
    if (res.scope === 'all') targets = pages.map((p) => p.uid);
    if (res.scope === 'range') {
      try {
        const { parsePageRanges } = await import('../../../core/page-ranges.js');
        targets = parsePageRanges(res.range, pages.length).map((i) => pages[i].uid);
      } catch (e) {
        return alertDialog(errorMessage(e));
      }
    }
    // Apply the same margins to every target page relative to its own box.
    const geoms = await Promise.all(targets.map(async (u) => [u, await this.session.pageGeometry({ ...this.session.page(u), crop: null })]));
    this.session.update('cropPages', (s) => {
      for (const [u, geo] of geoms) {
        const p = s.pages.find((x) => x.uid === u);
        const v = geo.view;
        const box = [v[0] + margins.left, v[1] + margins.bottom, v[2] - margins.right, v[3] - margins.top];
        if (box[2] - box[0] > 10 && box[3] - box[1] > 10) p.crop = box;
      }
    });
    this.setTool('select');
  }

  // ------------------------------------------------------------------ comments panel helpers

  revealItem(pageUid, it) {
    const index = this.session.pageIndex(pageUid);
    if (index < 0) return;
    if (this.mode !== 'view') this.setMode('view');
    if (this.tools.tool !== 'select') this.setTool('select');
    if (it.kind === 'object') {
      const found = this.session.findObject(it.id);
      if (found) this.viewer.scrollToRect(index, objectBounds(found.object));
      this.overlay.select(pageUid, it.id);
    } else {
      const e = this.session.page(pageUid).annotEdits?.[it.id] || {};
      const r = it.annot.rect;
      this.viewer.scrollToRect(index, [r[0] + (e.dx || 0), r[1] + (e.dy || 0), r[2] + (e.dx || 0), r[3] + (e.dy || 0)]);
      this.overlay.select(pageUid, it.id, 'annot', { annot: it.annot });
    }
  }

  async editItemContents(pageUid, it) {
    if (it.kind === 'object') {
      const found = this.session.findObject(it.id);
      if (!found) return;
      const v = await promptDialog(t('props.comment'), found.object.contents || '', { title: t('comments.edit') });
      if (v !== null) this.session.updateObject(it.id, { contents: v }, 'editComment');
    } else {
      const v = await promptDialog(t('props.comment'), it.text || '', { title: t('comments.edit') });
      if (v !== null) this.setAnnotEdit(pageUid, it.id, { contents: v });
    }
  }

  deleteItem(pageUid, it) {
    if (it.kind === 'object') this.session.removeObjects([it.id]);
    else this.setAnnotEdit(pageUid, it.id, { deleted: true });
  }

  // ------------------------------------------------------------------ search highlights

  setSearchHighlights(results, active) {
    this.searchHits = { results, active };
    for (const pv of this.viewer.pageViews.values()) this.renderSearchHits(pv);
  }

  renderSearchHits(pv) {
    clear(pv.searchLayer);
    const { results, active } = this.searchHits;
    if (!results.length || !pv.geometry) return;
    const vp = pv.getViewport();
    results.forEach((r, i) => {
      if (r.pageUid !== pv.entry.uid) return;
      for (const rect of r.rects) {
        const vr = viewRect(vp, rect);
        pv.searchLayer.appendChild(h('div', { class: `search-hit ${i === active ? 'active' : ''}`, style: { left: `${vr.left}px`, top: `${vr.top}px`, width: `${vr.width}px`, height: `${vr.height}px` } }));
      }
    });
  }

  async searchAndRedact(query, opts) {
    if (!query || !query.trim()) return;
    if (this.isReadOnly()) return this.warnReadOnly();
    const results = await withBusy(t('search.searching'), () => searchDocument(this.session, query.trim(), opts));
    if (!results.length) return toast(t('search.none'));
    this.session.update('markRedactions', (s) => {
      for (const r of results) {
        const p = s.pages.find((x) => x.uid === r.pageUid);
        for (const rect of r.rects) p.objects.push({ id: uid('o'), type: 'redact', rect: [rect[0] - 1, rect[1] - 1, rect[2] + 1, rect[3] + 1], fill: [0, 0, 0], created: new Date().toISOString() });
      }
    });
    toast(t('redact.marked', { n: results.length }), { type: 'success' });
  }

  async applyRedactions() {
    const marks = [];
    for (const p of this.session.state.pages) for (const o of p.objects || []) if (o.type === 'redact' && !o.applied) marks.push(o);
    if (!marks.length) return toast(t('redact.noneMarked'));
    const ok = await confirmDialog(t('redact.applyConfirm', { n: marks.length }), { danger: true, okLabel: t('redact.apply') });
    if (!ok) return;
    this.overlay.selection = null;
    this.session.update('applyRedactions', (s) => {
      for (const p of s.pages) {
        const keep = [];
        for (const o of p.objects || []) {
          if (o.type === 'redact' && !o.applied) {
            p.removals = p.removals || [];
            p.removals.push({ id: uid('r'), region: o.rect, kind: 'redact' });
            keep.push({ id: uid('o'), type: 'box', rect: o.rect, fill: o.fill || [0, 0, 0] });
            if (o.overlayText) keep.push({ id: uid('o'), type: 'text', rect: o.rect, rot: 0, text: o.overlayText, size: Math.max(6, Math.min(12, (o.rect[3] - o.rect[1]) * 0.6)), color: [1, 1, 1], font: { family: 'Liberation Sans' }, align: 'center', wrap: true });
          } else keep.push(o);
        }
        p.objects = keep;
      }
    });
    toast(t('redact.applied'), { type: 'success' });
  }

  // ------------------------------------------------------------------ content images (edit mode)

  async replaceSelectedContentImage() {
    const sel = this.editMode.selectedImage;
    if (!sel) return;
    const paths = await window.api.dialog.open({ filters: [{ name: t('filter.images'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] }] });
    if (!paths.length) return;
    const bytes = await window.api.file.read(paths[0]);
    const img = await prepareImageFile(bytes, paths[0]);
    const asset = this.session.addAsset(img.bytes, img.mime, { width: img.width, height: img.height });
    const data = await this.editMode.selectedImageData();
    const existing = data?.img?.edit;
    this.editMode.setImageEdit(sel.pageUid, sel.path, { action: 'replace', asset, matrix: existing && existing.matrix ? existing.matrix : [1, 0, 0, 1, 0, 0] });
  }

  async extractSelectedContentImage() {
    const data = await this.editMode.selectedImageData();
    if (!data || !data.img) return;
    const { img } = data;
    if (!img.image.stream) return toast(t('edit.extractUnsupported'), { type: 'error' });
    try {
      const doc = await this.session.getLibDoc(this.session.page(data.pv.entry.uid).src.doc);
      const { imageData, jpeg } = await decodeImageXObject(doc.context, img.image.stream);
      const ext = jpeg ? 'jpg' : 'png';
      const bytes = jpeg ? img.image.stream.contents : await imageDataToBytes(imageData, 'image/png');
      const p = await window.api.dialog.save({ defaultPath: `${stripExt(this.session.name)}_image.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
      if (!p) return;
      await window.api.file.write(p, bytes);
      toast(t('common.savedTo', { path: basename(p) }), { type: 'success' });
    } catch (e) {
      console.error(e);
      toast(t('edit.extractUnsupported'), { type: 'error' });
    }
  }

  async replaceObjectImage(id) {
    const paths = await window.api.dialog.open({ filters: [{ name: t('filter.images'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] }] });
    if (!paths.length) return;
    const bytes = await window.api.file.read(paths[0]);
    const img = await prepareImageFile(bytes, paths[0]);
    const asset = this.session.addAsset(img.bytes, img.mime, { width: img.width, height: img.height });
    const found = this.session.findObject(id);
    if (!found) return;
    const o = found.object;
    const f = frameForRect(o.rect, o.rot || 0);
    const rect = rectFromLocal(f.origin, f.width, (f.width * img.height) / img.width, o.rot || 0);
    this.session.updateObject(id, { asset, rect }, 'replaceImage');
  }

  // ------------------------------------------------------------------ keyboard

  handleKey(e) {
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (this.overlay.editing) return false;
    if (this.tools.keyDown(e)) return true;
    if (k === 'Escape') {
      if (this.overlay.selection) this.overlay.clearSelection();
      else if (this.editMode.selectedImage) {
        this.editMode.selectedImage = null;
        this.editMode.refresh();
        this.selectionChanged();
      } else if (this.tools.tool !== 'select') this.setTool('select');
      return true;
    }
    if ((k === 'Delete' || k === 'Backspace') && !ctrl) {
      if (this.mode === 'organize') {
        const uids = this.organizer.selectedUids();
        if (uids.length) this.deletePages(uids);
        return true;
      }
      return this.deleteSelection();
    }
    if (ctrl && k.toLowerCase() === 'c' && !e.shiftKey) {
      if (window.getSelection().toString()) return false;
      return this.copySelection();
    }
    if (ctrl && k.toLowerCase() === 'x') {
      if (window.getSelection().toString()) return false;
      this.cutSelection();
      return true;
    }
    if (ctrl && k.toLowerCase() === 'v') return this.pasteObject();
    if (ctrl && k.toLowerCase() === 'd') {
      this.duplicateSelection();
      return true;
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(k) && this.mode === 'view') {
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[k];
      if (this.overlay.selection) return this.nudgeSelection(d[0], d[1]);
      if (k === 'ArrowLeft' && this.viewerEl.scrollWidth <= this.viewerEl.clientWidth) {
        this.viewer.goToIndex(this.viewer.currentIndex - 1);
        return true;
      }
      if (k === 'ArrowRight' && this.viewerEl.scrollWidth <= this.viewerEl.clientWidth) {
        this.viewer.goToIndex(this.viewer.currentIndex + 1);
        return true;
      }
      return false;
    }
    if (k === 'PageDown' && this.mode === 'view' && ctrl) {
      this.viewer.goToIndex(this.viewer.currentIndex + 1);
      return true;
    }
    if (k === 'PageUp' && this.mode === 'view' && ctrl) {
      this.viewer.goToIndex(this.viewer.currentIndex - 1);
      return true;
    }
    if (k === 'Home' && ctrl) {
      this.viewer.goToIndex(0);
      return true;
    }
    if (k === 'End' && ctrl) {
      this.viewer.goToIndex(this.session.state.pages.length - 1);
      return true;
    }
    return false;
  }

  destroy() {
    this.viewer.destroy();
    this.thumbs.clear();
    this.session.destroy();
    this.el.remove();
  }
}

export { MARKUP_TOOLS, cssColor, basename };
