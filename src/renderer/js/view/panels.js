// Sidebar panels: bookmarks, comments, search and attachments.
import { h, clear, debounce, uid, cssColor, formatBytes, keepPlainKeys } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { promptDialog, confirmDialog, showMenu, toast } from '../ui/dialogs.js';
import { searchDocument } from '../doc/search.js';
import { t, formatDate } from '../i18n.js';
import { viewRect } from './viewport.js';

// ------------------------------------------------------------------ bookmarks

export class OutlinePanel {
  constructor(docView) {
    this.docView = docView;
    this.items = null;
    this.selected = null;
    this.expanded = new Set();
    this.body = h('div', { class: 'tree' });
    this.el = h(
      'div',
      { class: 'panel-content', style: { display: 'flex', flexDirection: 'column', height: '100%' } },
      h(
        'div',
        { class: 'panel-header' },
        h('span', null, t('panel.bookmarks')),
        h(
          'div',
          { class: 'ph-actions' },
          h('button', { class: 'icon-btn', 'data-tip': t('outline.add'), onclick: () => this.add() }, icon('plus')),
          h('button', { class: 'icon-btn', 'data-tip': t('outline.rename'), onclick: () => this.rename() }, icon('edit')),
          h('button', { class: 'icon-btn', 'data-tip': t('outline.moveUp'), onclick: () => this.move(-1) }, icon('moveUp')),
          h('button', { class: 'icon-btn', 'data-tip': t('outline.moveDown'), onclick: () => this.move(1) }, icon('moveDown')),
          h('button', { class: 'icon-btn', 'data-tip': t('outline.delete'), onclick: () => this.remove() }, icon('trash')),
        ),
      ),
      h('div', { class: 'panel-body' }, this.body),
    );
  }

  get session() {
    return this.docView.session;
  }

  async load() {
    if (this.session.state.outline !== undefined) {
      this.items = structuredClone(this.session.state.outline);
    } else {
      this.items = await this.readSourceOutline();
    }
    this.render();
  }

  async readSourceOutline() {
    const src = this.session.sources.get(this.session.baseId);
    if (!src) return [];
    let outline = null;
    try {
      outline = await src.pdf.getOutline();
    } catch {
      outline = null;
    }
    if (!outline) return [];
    const pages = this.session.state.pages;
    const convert = async (list) => {
      const out = [];
      for (const it of list || []) {
        let pageUid = null;
        try {
          let dest = it.dest;
          if (typeof dest === 'string') dest = await src.pdf.getDestination(dest);
          if (Array.isArray(dest) && dest[0]) {
            const idx = typeof dest[0] === 'object' ? await src.pdf.getPageIndex(dest[0]) : dest[0];
            const entry = pages.find((p) => p.src && p.src.doc === src.id && p.src.index === idx);
            if (entry) pageUid = entry.uid;
          }
        } catch {
          pageUid = null;
        }
        out.push({ id: uid('b'), title: it.title || '', pageUid, url: it.url || null, children: await convert(it.items), open: false });
      }
      return out;
    };
    return convert(outline);
  }

  commit() {
    const clean = (list) => list.map((it) => ({ id: it.id, title: it.title, pageUid: it.pageUid, children: clean(it.children || []), open: !!it.open }));
    this.session.update('editOutline', (s) => {
      s.outline = clean(this.items);
    });
  }

  render() {
    clear(this.body);
    if (!this.items || !this.items.length) {
      this.body.appendChild(h('div', { class: 'empty-note' }, t('outline.empty')));
      return;
    }
    const pages = this.session.state.pages;
    const renderList = (list, container) => {
      for (const it of list) {
        const hasChildren = it.children && it.children.length;
        const open = this.expanded.has(it.id);
        const idx = it.pageUid ? pages.findIndex((p) => p.uid === it.pageUid) : -1;
        const row = h(
          'div',
          { class: `tree-item ${this.selected === it.id ? 'selected' : ''}` },
          h(
            'span',
            {
              class: 'tree-toggle',
              onclick: (e) => {
                e.stopPropagation();
                if (open) this.expanded.delete(it.id);
                else this.expanded.add(it.id);
                this.render();
              },
            },
            hasChildren ? icon(open ? 'chevronDown' : 'chevronRight') : null,
          ),
          h('span', { class: 'tree-title', title: it.title }, it.title || t('outline.untitled')),
          idx >= 0 ? h('span', { class: 'tree-page' }, String(idx + 1)) : null,
        );
        row.addEventListener('click', () => {
          this.selected = it.id;
          this.render();
          if (idx >= 0) this.docView.viewer.goToIndex(idx);
        });
        row.addEventListener('dblclick', () => this.rename());
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          this.selected = it.id;
          this.render();
          showMenu({ x: e.clientX, y: e.clientY }, [
            { label: t('outline.add'), icon: 'plus', onClick: () => this.add() },
            { label: t('outline.addChild'), icon: 'plus', onClick: () => this.add(true) },
            { label: t('outline.rename'), icon: 'edit', onClick: () => this.rename() },
            { label: t('outline.setPage'), icon: 'bookmark', onClick: () => this.setToCurrentPage() },
            { separator: true },
            { label: t('outline.delete'), icon: 'trash', onClick: () => this.remove() },
          ]);
        });
        container.appendChild(row);
        if (hasChildren && open) {
          const sub = h('div', { class: 'tree-children' });
          renderList(it.children, sub);
          container.appendChild(sub);
        }
      }
    };
    renderList(this.items, this.body);
  }

  find(id, list = this.items, parent = null) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) return { item: list[i], list, index: i, parent };
      const r = this.find(id, list[i].children || [], list[i]);
      if (r) return r;
    }
    return null;
  }

  async add(asChild = false) {
    if (!this.items) await this.load();
    const idx = this.docView.viewer.currentIndex;
    const page = this.session.state.pages[idx];
    const title = await promptDialog(t('outline.titlePrompt'), t('outline.defaultTitle', { page: idx + 1 }), { title: t('outline.add') });
    if (title === null) return;
    const item = { id: uid('b'), title, pageUid: page ? page.uid : null, children: [], open: false };
    const sel = this.selected ? this.find(this.selected) : null;
    if (sel && asChild) {
      sel.item.children = sel.item.children || [];
      sel.item.children.push(item);
      this.expanded.add(sel.item.id);
    } else if (sel) sel.list.splice(sel.index + 1, 0, item);
    else this.items.push(item);
    this.selected = item.id;
    this.commit();
    this.render();
  }

  async rename() {
    const sel = this.selected ? this.find(this.selected) : null;
    if (!sel) return;
    const title = await promptDialog(t('outline.titlePrompt'), sel.item.title, { title: t('outline.rename') });
    if (title === null) return;
    sel.item.title = title;
    this.commit();
    this.render();
  }

  setToCurrentPage() {
    const sel = this.selected ? this.find(this.selected) : null;
    if (!sel) return;
    const page = this.session.state.pages[this.docView.viewer.currentIndex];
    sel.item.pageUid = page ? page.uid : null;
    this.commit();
    this.render();
  }

  move(dir) {
    const sel = this.selected ? this.find(this.selected) : null;
    if (!sel) return;
    const j = sel.index + dir;
    if (j < 0 || j >= sel.list.length) return;
    const [it] = sel.list.splice(sel.index, 1);
    sel.list.splice(j, 0, it);
    this.commit();
    this.render();
  }

  async remove() {
    const sel = this.selected ? this.find(this.selected) : null;
    if (!sel) return;
    if (sel.item.children && sel.item.children.length && !(await confirmDialog(t('outline.deleteConfirm')))) return;
    sel.list.splice(sel.index, 1);
    this.selected = null;
    this.commit();
    this.render();
  }

  sessionChanged(diff) {
    if (diff.outline || diff.structure) {
      if (this.session.state.outline !== undefined) this.items = structuredClone(this.session.state.outline);
      this.render();
    }
  }
}

// ------------------------------------------------------------------ comments

const TYPE_LABEL_KEYS = {
  highlight: 'tool.highlight',
  underline: 'tool.underline',
  strikeout: 'tool.strikeout',
  squiggly: 'tool.squiggly',
  note: 'tool.note',
  freetext: 'tool.textbox',
  rect: 'tool.rect',
  ellipse: 'tool.ellipse',
  line: 'tool.line',
  arrow: 'tool.arrow',
  polyline: 'tool.polyline',
  polygon: 'tool.polygon',
  ink: 'tool.pencil',
  stamp: 'tool.stamp',
  signature: 'tool.signature',
  redact: 'tool.redact',
};

export class CommentsPanel {
  constructor(docView) {
    this.docView = docView;
    this.body = h('div', null);
    this.el = h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } }, h('div', { class: 'panel-header' }, h('span', null, t('panel.comments'))), h('div', { class: 'panel-body' }, this.body));
    this.refreshDebounced = debounce(() => this.render(), 250);
  }

  get session() {
    return this.docView.session;
  }

  async render() {
    const token = (this.token = (this.token || 0) + 1);
    const pages = this.session.state.pages;
    const groups = [];
    for (let i = 0; i < pages.length; i++) {
      const entry = pages[i];
      const items = [];
      for (const o of entry.objects || []) {
        if (!TYPE_LABEL_KEYS[o.type]) continue;
        items.push({ kind: 'object', id: o.id, type: t(TYPE_LABEL_KEYS[o.type]), color: o.color || o.stroke || [0.5, 0.5, 0.5], text: o.contents || o.text || '', author: o.author, date: o.modified || o.created });
      }
      if (entry.src) {
        let annots = [];
        try {
          annots = await this.session.getSourceAnnotations(entry);
        } catch {
          annots = [];
        }
        if (token !== this.token) return;
        const edits = entry.annotEdits || {};
        for (const a of annots) {
          if (['Widget', 'Link', 'Popup'].includes(a.subtype)) continue;
          if (edits[a.id] && edits[a.id].deleted) continue;
          const c = a.color ? Array.from(a.color).map((v) => v / 255) : [0.6, 0.6, 0.6];
          items.push({ kind: 'annot', id: a.id, annot: a, type: a.subtype, color: c, text: edits[a.id]?.contents ?? a.contentsObj?.str ?? '', author: a.titleObj?.str || '', date: a.modificationDate || a.creationDate });
        }
      }
      if (items.length) groups.push({ index: i, entry, items });
    }
    if (token !== this.token) return;
    clear(this.body);
    if (!groups.length) {
      this.body.appendChild(h('div', { class: 'empty-note' }, t('comments.empty')));
      return;
    }
    const sel = this.docView.overlay.selection;
    for (const g of groups) {
      this.body.appendChild(h('div', { class: 'comment-group-title' }, t('common.pageN', { n: g.index + 1 }), ` (${g.items.length})`));
      for (const it of g.items) {
        const selected = sel && sel.id === it.id;
        const card = h(
          'div',
          { class: `comment-item ${selected ? 'selected' : ''}` },
          h('div', { class: 'ci-head' }, h('span', { class: 'ci-dot', style: { background: cssColor(it.color) } }), h('span', { class: 'ci-type' }, it.type), h('span', { class: 'ci-date' }, formatDate(parsePdfDate(it.date)))),
          it.author ? h('div', { class: 'ci-author' }, it.author) : null,
          it.text ? h('div', { class: 'ci-text' }, it.text.slice(0, 400)) : null,
        );
        card.addEventListener('click', () => this.docView.revealItem(g.entry.uid, it));
        card.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showMenu({ x: e.clientX, y: e.clientY }, [
            { label: t('comments.edit'), icon: 'edit', onClick: () => this.docView.editItemContents(g.entry.uid, it) },
            { label: t('common.delete'), icon: 'trash', onClick: () => this.docView.deleteItem(g.entry.uid, it) },
          ]);
        });
        this.body.appendChild(card);
      }
    }
  }
}

export function parsePdfDate(s) {
  if (!s) return null;
  if (typeof s !== 'string') return s;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return new Date(s);
  const m = /D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(s);
  if (!m) return null;
  return new Date(+m[1], (+m[2] || 1) - 1, +m[3] || 1, +m[4] || 0, +m[5] || 0, +m[6] || 0);
}

// ------------------------------------------------------------------ search

export class SearchPanel {
  constructor(docView) {
    this.docView = docView;
    this.results = [];
    this.active = -1;
    this.input = h('input', { class: 'input', type: 'search', placeholder: t('search.placeholder'), style: { width: '100%' } });
    this.matchCase = h('input', { type: 'checkbox' });
    this.wholeWord = h('input', { type: 'checkbox' });
    this.status = h('div', { class: 'search-status' });
    this.list = h('div', null);
    this.el = h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', height: '100%' } },
      h('div', { class: 'panel-header' }, h('span', null, t('panel.search'))),
      h(
        'div',
        { class: 'search-box' },
        this.input,
        h('div', { class: 'search-options' }, h('label', { class: 'check' }, this.matchCase, t('search.matchCase')), h('label', { class: 'check' }, this.wholeWord, t('search.wholeWord'))),
        h(
          'div',
          { class: 'form-inline' },
          h('button', { class: 'btn small', onclick: () => this.step(-1) }, icon('chevronUp')),
          h('button', { class: 'btn small', onclick: () => this.step(1) }, icon('chevronDown')),
          h('button', { class: 'btn small redact-results', onclick: () => this.docView.searchAndRedact(this.input.value, this.options()) }, icon('redact'), t('search.redactAll')),
        ),
        this.status,
      ),
      h('div', { class: 'panel-body' }, this.list),
    );
    const run = debounce(() => this.run(), 300);
    this.input.addEventListener('input', run);
    this.input.addEventListener('keydown', (e) => {
      keepPlainKeys(e);
      if (e.key === 'Enter') {
        e.preventDefault();
        if (this.lastQuery !== this.input.value) this.run().then(() => this.step(e.shiftKey ? -1 : 1));
        else this.step(e.shiftKey ? -1 : 1);
      }
      if (e.key === 'Escape') this.clear();
    });
    this.matchCase.addEventListener('change', () => this.run());
    this.wholeWord.addEventListener('change', () => this.run());
  }

  options() {
    return { matchCase: this.matchCase.checked, wholeWord: this.wholeWord.checked };
  }

  focus(text) {
    if (text) this.input.value = text;
    this.input.focus();
    this.input.select();
    if (text) this.run();
  }

  clear() {
    this.input.value = '';
    this.results = [];
    this.active = -1;
    this.lastQuery = '';
    clear(this.list);
    this.status.textContent = '';
    this.docView.setSearchHighlights([], -1);
  }

  async run() {
    const query = this.input.value.trim();
    this.lastQuery = this.input.value;
    const token = (this.token = (this.token || 0) + 1);
    if (!query) {
      this.clear();
      return;
    }
    this.status.textContent = t('search.searching');
    const results = await searchDocument(this.docView.session, query, this.options(), (done, total) => {
      if (token === this.token) this.status.textContent = t('search.progress', { done, total });
    }, () => token !== this.token);
    if (token !== this.token) return;
    this.results = results;
    this.active = -1;
    this.status.textContent = results.length ? t('search.count', { n: results.length }) : t('search.none');
    clear(this.list);
    results.slice(0, 1000).forEach((r, i) => {
      const row = h('div', { class: 'search-result' }, h('div', { class: 'sr-page' }, t('common.pageN', { n: r.pageIndex + 1 })), h('div', null, r.before, h('mark', null, r.match), r.after));
      row.addEventListener('click', () => this.activate(i));
      this.list.appendChild(row);
    });
    this.docView.setSearchHighlights(results, -1);
  }

  step(dir) {
    if (!this.results.length) return;
    let i = this.active + dir;
    if (i < 0) i = this.results.length - 1;
    if (i >= this.results.length) i = 0;
    this.activate(i);
  }

  activate(i) {
    this.active = i;
    [...this.list.children].forEach((el, k) => el.classList.toggle('active', k === i));
    const row = this.list.children[i];
    if (row) row.scrollIntoView({ block: 'nearest' });
    this.status.textContent = t('search.position', { i: i + 1, n: this.results.length });
    this.docView.setSearchHighlights(this.results, i);
    const r = this.results[i];
    if (r && r.rects.length) this.docView.viewer.scrollToRect(r.pageIndex, r.rects[0]);
  }

  sessionChanged(diff) {
    if (diff.structure || diff.content.size) {
      if (this.results.length) this.run();
    }
  }
}

// ------------------------------------------------------------------ attachments

export class AttachmentsPanel {
  constructor(docView) {
    this.docView = docView;
    this.body = h('div', null);
    this.el = h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } }, h('div', { class: 'panel-header' }, h('span', null, t('panel.attachments'))), h('div', { class: 'panel-body' }, this.body));
  }

  async render() {
    clear(this.body);
    const src = this.docView.session.sources.get(this.docView.session.baseId);
    let att = null;
    try {
      att = src ? await src.pdf.getAttachments() : null;
    } catch {
      att = null;
    }
    const list = !att ? [] : att instanceof Map ? [...att.entries()] : Object.entries(att);
    if (!list.length) {
      this.body.appendChild(h('div', { class: 'empty-note' }, t('attachments.empty')));
      return;
    }
    for (const [id, a] of list) {
      const name = a.filename || a.rawFilename || id;
      const row = h(
        'div',
        { class: 'file-row' },
        icon('paperclip'),
        h('span', { class: 'fr-name', title: a.description || name }, name),
        a.content ? h('span', { class: 'fr-meta' }, formatBytes(a.content.length)) : null,
        h(
          'button',
          {
            class: 'icon-btn',
            title: t('common.save'),
            onclick: async () => {
              let content = a.content;
              if (!content && src.pdf.getAttachmentContent) {
                try {
                  const r = await src.pdf.getAttachmentContent(id);
                  content = r && r.content ? r.content : r;
                } catch {
                  content = null;
                }
              }
              if (!content) return toast(t('attachments.unreadable'), { type: 'error' });
              const p = await window.api.dialog.save({ defaultPath: name, filters: [{ name: '*', extensions: ['*'] }] });
              if (!p) return;
              await window.api.file.write(p, content);
              toast(t('common.savedTo', { path: p }), { type: 'success' });
            },
          },
          icon('download'),
        ),
      );
      this.body.appendChild(row);
    }
  }
}

export { viewRect };
