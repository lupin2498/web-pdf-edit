// Combine multiple PDF (and image) files into one document.
import { h, clear, basename, formatBytes, uid } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { openDialog, passwordDialog, withBusy, alertDialog, toast } from '../ui/dialogs.js';
import { openPdfjs, destroyPdf } from '../pdf/pdfjs.js';
import { DocSession, newPageEntry } from '../doc/session.js';
import { parsePageRanges } from '../../../core/page-ranges.js';
import { imagesToPdfBytes } from './create.js';
import { IMAGE_EXTENSIONS } from './insert.js';
import { t, errorMessage } from '../i18n.js';

async function loadItem(path, bytes = null, name = null) {
  bytes = bytes || (await window.api.file.read(path));
  name = name || basename(path);
  if (/\.(png|jpe?g|gif|bmp|webp|tiff?)$/i.test(name)) {
    const pdf = await imagesToPdfBytes([{ bytes, name }], { pageSize: 'fit' });
    return { id: uid('f'), name, path, bytes: pdf, numPages: 1, size: bytes.length, range: '', image: true };
  }
  let password;
  let retry = false;
  for (;;) {
    try {
      const pdf = await openPdfjs(bytes, password);
      const n = pdf.numPages;
      destroyPdf(pdf);
      return { id: uid('f'), name, path, bytes, password, numPages: n, size: bytes.length, range: '' };
    } catch (e) {
      if (e && e.name === 'PasswordException') {
        password = await passwordDialog(name, { retry });
        if (password === null) return null;
        retry = true;
        continue;
      }
      throw e;
    }
  }
}

export async function open(app, { paths = [] } = {}) {
  const items = [];
  const list = h('div', { class: 'file-list' });
  const bookmarks = h('input', { type: 'checkbox', checked: true });
  const summary = h('div', { class: 'hint' });
  let dragId = null;

  const render = () => {
    clear(list);
    if (!items.length) list.appendChild(h('div', { class: 'empty-note' }, t('combine.empty')));
    items.forEach((it, i) => {
      const range = h('input', { class: 'input fr-range', placeholder: t('combine.allPages'), value: it.range, title: t('combine.rangeHint') });
      range.addEventListener('change', () => (it.range = range.value));
      range.addEventListener('keydown', (e) => e.stopPropagation());
      const row = h(
        'div',
        { class: 'file-row', draggable: 'true' },
        h('span', { style: { color: 'var(--muted)', cursor: 'grab' } }, icon('dragHandle')),
        h('span', { class: 'fr-name', title: it.path || it.name }, `${i + 1}. ${it.name}`),
        h('span', { class: 'fr-meta' }, `${t('combine.pages', { n: it.numPages })} · ${formatBytes(it.size)}`),
        range,
        h('button', { class: 'icon-btn', title: t('outline.moveUp'), disabled: i === 0, onclick: () => move(i, -1) }, icon('moveUp')),
        h('button', { class: 'icon-btn', title: t('outline.moveDown'), disabled: i === items.length - 1, onclick: () => move(i, 1) }, icon('moveDown')),
        h('button', { class: 'icon-btn', title: t('common.remove'), onclick: () => { items.splice(i, 1); render(); } }, icon('close')),
      );
      row.addEventListener('dragstart', (e) => {
        dragId = it.id;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragend', () => {
        dragId = null;
        render();
      });
      row.addEventListener('dragover', (e) => {
        if (!dragId) return;
        e.preventDefault();
        row.classList.add('drop-target');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        if (!dragId) return;
        const from = items.findIndex((x) => x.id === dragId);
        const [moved] = items.splice(from, 1);
        const to = items.findIndex((x) => x.id === it.id);
        items.splice(from <= to ? to + 1 : to, 0, moved);
        dragId = null;
        render();
      });
      list.appendChild(row);
    });
    const total = items.reduce((a, it) => a + it.numPages, 0);
    summary.textContent = items.length ? t('combine.summary', { files: items.length, pages: total }) : '';
    if (dlg) dlg.setButtonDisabled(1, items.length < 1);
  };
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    render();
  };
  const addPaths = async (paths) => {
    for (const p of paths) {
      try {
        const it = await loadItem(p);
        if (it) items.push(it);
      } catch (e) {
        toast(t('error.openFailed', { name: basename(p), message: errorMessage(e) }), { type: 'error' });
      }
      render();
    }
  };
  const addBtn = h('button', { class: 'btn', onclick: async () => addPaths(await window.api.dialog.open({ multiple: true, filters: [{ name: t('filter.pdfAndImages'), extensions: ['pdf', ...IMAGE_EXTENSIONS] }] })) }, icon('plus'), t('combine.addFiles'));
  const addOpen = h(
    'button',
    {
      class: 'btn',
      onclick: async () => {
        for (const tab of app.tabs) {
          if (tab.kind !== 'doc') continue;
          const s = tab.view.session;
          try {
            const { bytes } = await s.buildBytes({ security: null });
            items.push({ id: uid('f'), name: s.name, path: s.filePath, bytes, numPages: s.state.pages.length, size: bytes.length, range: '' });
          } catch (e) {
            toast(errorMessage(e), { type: 'error' });
          }
        }
        render();
      },
    },
    icon('layers'),
    t('combine.addOpen'),
  );
  const dropZone = h('div', { class: 'hint' }, t('combine.dropHint'));
  const content = [h('div', { class: 'form-inline' }, addBtn, addOpen), list, h('label', { class: 'check' }, bookmarks, t('combine.bookmarks')), summary, dropZone];
  let dlg = null;
  dlg = openDialog({
    title: t('tools.combine'),
    width: 720,
    content,
    buttons: [
      { label: t('common.cancel'), value: null },
      {
        label: t('combine.run'),
        primary: true,
        disabled: true,
        onClick: async () => {
          try {
            const bytes = await withBusy(t('combine.running'), (busy) => combineItems(items, { bookmarks: bookmarks.checked, onProgress: (f) => busy.set(f) }));
            if (!bytes) return false;
            setTimeout(() => app.openBytes(bytes, { name: `${t('combine.resultName')}.pdf`, isNew: true }), 0);
            return true;
          } catch (e) {
            alertDialog(errorMessage(e));
            return false;
          }
        },
      },
    ],
  });
  dlg.el.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault();
  });
  dlg.el.addEventListener('drop', async (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    e.stopPropagation();
    for (const f of e.dataTransfer.files) {
      const p = window.api.pathForFile(f);
      try {
        const it = await loadItem(p || f.name, new Uint8Array(await f.arrayBuffer()), f.name);
        if (it) items.push(it);
      } catch (err) {
        toast(t('error.openFailed', { name: f.name, message: errorMessage(err) }), { type: 'error' });
      }
    }
    render();
  });
  // Start with the files that were handed over, else with the active document.
  const doc = app.activeDoc;
  if (paths.length) await addPaths(paths);
  else if (doc) {
    try {
      const s = doc.session;
      doc.overlay.commitEditing();
      const { bytes } = await s.buildBytes({ security: null });
      items.push({ id: uid('f'), name: s.name, path: s.filePath, bytes, numPages: s.state.pages.length, size: bytes.length, range: '' });
    } catch (e) {
      console.warn('combine: cannot add the active document', e);
    }
  }
  render();
}

export async function combineItems(items, { bookmarks = true, onProgress } = {}) {
  if (!items.length) return null;
  const session = new DocSession({ name: 'combined.pdf' });
  const pages = [];
  const outline = [];
  for (const it of items) {
    const src = await session.addSource(it.bytes, { name: it.name, password: it.password });
    let indices;
    try {
      indices = parsePageRanges(it.range, src.numPages);
    } catch (e) {
      e.message = `${it.name}: ${errorMessage(e)}`;
      throw e;
    }
    if (!indices.length) continue;
    const entries = indices.map((i) => newPageEntry(src.id, i));
    pages.push(...entries);
    if (bookmarks) outline.push({ id: uid('b'), title: it.name.replace(/\.pdf$/i, ''), pageUid: entries[0].uid, children: [], open: false });
  }
  if (!pages.length) throw new Error(t('combine.noPages'));
  session.baseId = null;
  session.state = { pages, meta: null, outline: bookmarks ? outline : [], security: null };
  try {
    const { bytes } = await session.buildBytes({ onProgress, security: null });
    return bytes;
  } finally {
    session.destroy();
  }
}
