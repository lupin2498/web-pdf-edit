// Grid/list of page thumbnails with selection and drag & drop reordering.
// Used by the sidebar thumbnails panel and the page organizer.
import { h, clear } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { CSS_UNITS } from '../pdf/pdfjs.js';
import { t } from '../i18n.js';

export class PageGrid {
  constructor(docView, { mode = 'sidebar', thumbWidth = 140 } = {}) {
    this.docView = docView;
    this.mode = mode;
    this.thumbWidth = thumbWidth;
    this.selection = new Set();
    this.anchor = null;
    this.items = new Map();
    this.el = h('div', { class: mode === 'sidebar' ? 'thumbs' : 'org-grid', tabindex: '0' });
    this.observer = new IntersectionObserver((entries) => this.onIntersect(entries), { root: null, rootMargin: '400px' });
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.dragUids = null;
  }

  get session() {
    return this.docView.session;
  }

  setThumbWidth(w) {
    this.thumbWidth = w;
    for (const item of this.items.values()) item.drawnKey = null;
    this.render();
  }

  render() {
    const pages = this.session.state.pages;
    const old = this.items;
    this.items = new Map();
    const frag = document.createDocumentFragment();
    pages.forEach((entry, i) => {
      let item = old.get(entry.uid);
      if (item) old.delete(entry.uid);
      else item = this.createItem(entry);
      item.entry = entry;
      item.index = i;
      item.label.textContent = String(i + 1);
      item.el.classList.toggle('selected', this.selection.has(entry.uid));
      this.items.set(entry.uid, item);
      frag.appendChild(item.el);
      this.sizeItem(item);
      if (item.visible) this.drawItem(item);
    });
    for (const item of old.values()) this.observer.unobserve(item.el);
    for (const uid of [...this.selection]) if (!this.items.has(uid)) this.selection.delete(uid);
    clear(this.el);
    this.el.appendChild(frag);
    this.setCurrent(this.docView.viewer ? this.docView.viewer.currentIndex : 0);
  }

  createItem(entry) {
    const canvas = h('canvas', { style: { width: '100%', height: '100%', display: 'block' } });
    const holder = h('div', { class: this.mode === 'sidebar' ? 'thumb-img' : 'org-thumb' }, canvas);
    const label = h('div', { class: this.mode === 'sidebar' ? 'thumb-label' : 'org-label' });
    const el = h('div', { class: this.mode === 'sidebar' ? 'thumb' : 'org-item', draggable: 'true', dataset: { uid: entry.uid } }, holder, label);
    const item = { el, canvas, holder, label, entry, index: 0, visible: false, drawnKey: null };
    if (this.mode === 'organizer') {
      const tools = h(
        'div',
        { class: 'org-tools' },
        h('button', { class: 'icon-btn', title: t('page.rotateLeft'), onclick: (e) => { e.stopPropagation(); this.session.rotatePages([item.entry.uid], -90); } }, icon('rotateLeft')),
        h('button', { class: 'icon-btn', title: t('page.rotateRight'), onclick: (e) => { e.stopPropagation(); this.session.rotatePages([item.entry.uid], 90); } }, icon('rotateRight')),
        h('button', { class: 'icon-btn', title: t('page.delete'), onclick: (e) => { e.stopPropagation(); this.docView.deletePages([item.entry.uid]); } }, icon('trash')),
      );
      el.appendChild(tools);
    }
    el.addEventListener('click', (e) => this.onClick(e, item));
    el.addEventListener('dblclick', () => this.docView.openPageInViewer(item.index));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!this.selection.has(item.entry.uid)) this.selectOnly(item.entry.uid);
      this.docView.pagesContextMenu(e, [...this.selection]);
    });
    el.addEventListener('dragstart', (e) => this.onDragStart(e, item));
    el.addEventListener('dragend', () => this.clearDropMarks());
    el.addEventListener('dragover', (e) => this.onDragOver(e, item));
    el.addEventListener('drop', (e) => this.onDrop(e, item));
    this.observer.observe(el);
    return item;
  }

  sizeItem(item) {
    const g = this.docView.viewer?.pageViews.get(item.entry.uid)?.geometry || this.docView.viewer?.defaultGeometry || { width: 595, height: 842 };
    const w = this.thumbWidth;
    const hgt = Math.round((w * g.height) / g.width);
    item.holder.style.width = `${w}px`;
    item.holder.style.height = `${hgt}px`;
  }

  onIntersect(entries) {
    for (const e of entries) {
      const uid = e.target.dataset.uid;
      const item = this.items.get(uid);
      if (!item) continue;
      item.visible = e.isIntersecting;
      if (item.visible) this.drawItem(item);
    }
  }

  async drawItem(item) {
    const svc = this.docView.thumbs;
    const key = svc.key(item.entry, this.thumbWidth);
    if (item.drawnKey === key) return;
    item.drawnKey = key;
    const geom = await this.session.pageGeometry(item.entry).catch(() => null);
    if (geom) {
      const hgt = Math.round((this.thumbWidth * geom.height) / geom.width);
      item.holder.style.height = `${hgt}px`;
    }
    await svc.draw(item.entry, item.canvas, this.thumbWidth);
  }

  invalidate(uids) {
    for (const uid of uids) {
      const item = this.items.get(uid);
      if (item) {
        item.drawnKey = null;
        item.entry = this.session.page(uid) || item.entry;
        if (item.visible) this.drawItem(item);
      }
    }
  }

  setCurrent(index) {
    if (this.mode !== 'sidebar') return;
    for (const item of this.items.values()) item.el.classList.toggle('current', item.index === index);
    const cur = [...this.items.values()].find((i) => i.index === index);
    if (cur && this.el.offsetParent) {
      const parent = this.el.parentElement;
      if (parent) {
        const top = cur.el.offsetTop - parent.offsetTop;
        if (top < parent.scrollTop || top + cur.el.offsetHeight > parent.scrollTop + parent.clientHeight) parent.scrollTop = top - 20;
      }
    }
  }

  // ------------------------------------------------------------------ selection

  selectOnly(uid) {
    this.selection = new Set([uid]);
    this.anchor = uid;
    this.syncSelection();
  }

  selectAll() {
    this.selection = new Set(this.session.state.pages.map((p) => p.uid));
    this.syncSelection();
  }

  selectWhere(fn) {
    this.selection = new Set(this.session.state.pages.filter((p, i) => fn(i, p)).map((p) => p.uid));
    this.syncSelection();
  }

  syncSelection() {
    for (const [uid, item] of this.items) item.el.classList.toggle('selected', this.selection.has(uid));
    this.docView.pageSelectionChanged();
  }

  selectedUids() {
    return this.session.state.pages.filter((p) => this.selection.has(p.uid)).map((p) => p.uid);
  }

  onClick(e, item) {
    const uid = item.entry.uid;
    if (e.shiftKey && this.anchor && this.items.has(this.anchor)) {
      const a = this.items.get(this.anchor).index;
      const b = item.index;
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const pages = this.session.state.pages;
      this.selection = new Set(pages.slice(lo, hi + 1).map((p) => p.uid));
      this.syncSelection();
    } else if (e.ctrlKey || e.metaKey) {
      if (this.selection.has(uid)) this.selection.delete(uid);
      else this.selection.add(uid);
      this.anchor = uid;
      this.syncSelection();
    } else {
      this.selectOnly(uid);
      if (this.mode === 'sidebar') this.docView.viewer.goToIndex(item.index);
    }
    this.el.focus({ preventScroll: true });
  }

  onKey(e) {
    const pages = this.session.state.pages;
    if (e.key === 'Delete') {
      e.preventDefault();
      e.stopPropagation();
      const uids = this.selectedUids();
      if (uids.length) this.docView.deletePages(uids);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      e.stopPropagation();
      this.selectAll();
    } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      const cur = this.anchor && this.items.has(this.anchor) ? this.items.get(this.anchor).index : 0;
      let step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
      if (this.mode === 'organizer' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const perRow = Math.max(1, Math.floor(this.el.clientWidth / (this.thumbWidth + 40)));
        step *= perRow;
      }
      const next = Math.max(0, Math.min(pages.length - 1, cur + step));
      this.selectOnly(pages[next].uid);
      const item = this.items.get(pages[next].uid);
      item.el.scrollIntoView({ block: 'nearest' });
      if (this.mode === 'sidebar') this.docView.viewer.goToIndex(next);
    }
  }

  // ------------------------------------------------------------------ drag & drop

  onDragStart(e, item) {
    const uid = item.entry.uid;
    if (!this.selection.has(uid)) this.selectOnly(uid);
    this.dragUids = this.selectedUids();
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-pdfedit-pages', JSON.stringify(this.dragUids));
    for (const u of this.dragUids) this.items.get(u)?.el.classList.add('dragging');
  }

  dropPosition(e, item) {
    const r = item.el.getBoundingClientRect();
    if (this.mode === 'sidebar') return e.clientY < r.top + r.height / 2 ? 'before' : 'after';
    return e.clientX < r.left + r.width / 2 ? 'before' : 'after';
  }

  clearDropMarks() {
    for (const it of this.items.values()) it.el.classList.remove('drop-before', 'drop-after', 'drop-left', 'drop-right', 'dragging');
  }

  onDragOver(e, item) {
    const types = e.dataTransfer.types;
    const internal = types.includes('application/x-pdfedit-pages');
    const external = types.includes('Files');
    if (!internal && !external) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = internal ? 'move' : 'copy';
    this.clearDropMarks();
    if (this.dragUids) for (const u of this.dragUids) this.items.get(u)?.el.classList.add('dragging');
    const pos = this.dropPosition(e, item);
    const cls = this.mode === 'sidebar' ? (pos === 'before' ? 'drop-before' : 'drop-after') : pos === 'before' ? 'drop-left' : 'drop-right';
    item.el.classList.add(cls);
  }

  onDrop(e, item) {
    e.preventDefault();
    e.stopPropagation();
    const pos = this.dropPosition(e, item);
    const index = item.index + (pos === 'after' ? 1 : 0);
    this.clearDropMarks();
    const data = e.dataTransfer.getData('application/x-pdfedit-pages');
    if (data) {
      const uids = JSON.parse(data);
      this.dragUids = null;
      this.session.movePages(uids, index);
      return;
    }
    const files = [...(e.dataTransfer.files || [])];
    if (files.length) this.docView.insertDroppedFiles(files, index);
  }
}

export { CSS_UNITS };
