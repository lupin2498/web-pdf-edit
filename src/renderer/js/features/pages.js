// Page operations: insert, extract, split and replace.
import { h, basename, stripExt, joinPath, dirname, uid } from '../ui/dom.js';
import { openDialog, passwordDialog, withBusy, alertDialog, toast, confirmDialog } from '../ui/dialogs.js';
import { parsePageRanges, formatPageRanges } from '../../../core/page-ranges.js';
import { imagesToPdfBytes, PAGE_SIZES } from './create.js';
import { IMAGE_EXTENSIONS } from './insert.js';
import { t, errorMessage } from '../i18n.js';
import { authorize } from '../../../web/billing.js';

export function insertMenu(doc) {
  const sel = doc.selectedPageUids();
  const after = sel.length ? Math.max(...sel.map((u) => doc.session.pageIndex(u))) + 1 : doc.session.state.pages.length;
  return [
    { label: t('page.insertBlank'), icon: 'blank', onClick: () => insertBlank(doc, after) },
    { label: t('page.insertFile'), icon: 'insert', onClick: () => insertFromFile(doc, after) },
    { label: t('page.insertImages'), icon: 'image', onClick: () => insertImagesDialog(doc, after) },
  ];
}

function positionControls(doc, defaultIndex) {
  const n = doc.session.state.pages.length;
  const where = h('select', { class: 'input' }, h('option', { value: 'after' }, t('page.posAfter')), h('option', { value: 'before' }, t('page.posBefore')), h('option', { value: 'start' }, t('page.posStart')), h('option', { value: 'end' }, t('page.posEnd')));
  const page = h('input', { class: 'input', type: 'number', min: 1, max: n, value: Math.max(1, Math.min(n, defaultIndex)) });
  where.addEventListener('change', () => (page.disabled = where.value === 'start' || where.value === 'end'));
  const el = h('div', { class: 'form-grid' }, h('div', { class: 'form-row' }, h('label', null, t('page.position')), where), h('div', { class: 'form-row' }, h('label', null, t('page.pageNumber')), page));
  const index = () => {
    const p = Math.max(1, Math.min(n, parseInt(page.value, 10) || 1));
    if (where.value === 'start') return 0;
    if (where.value === 'end') return n;
    return where.value === 'after' ? p : p - 1;
  };
  return { el, index };
}

export async function insertBlank(doc, at) {
  if (doc.isReadOnly()) return doc.warnReadOnly();
  const cur = doc.viewer.pageViewAt(Math.max(0, at - 1));
  const g = cur && cur.geometry;
  const size = h('select', { class: 'input' }, h('option', { value: 'same' }, t('page.sameSize')), Object.keys(PAGE_SIZES).map((k) => h('option', { value: k }, k)));
  const orient = h('select', { class: 'input' }, h('option', { value: 'portrait' }, t('create.portrait')), h('option', { value: 'landscape' }, t('create.landscape')));
  const count = h('input', { class: 'input', type: 'number', min: 1, max: 100, value: 1 });
  const pos = positionControls(doc, at);
  const res = await openDialog({
    title: t('page.insertBlank'),
    content: [h('div', { class: 'form-grid three' }, h('div', { class: 'form-row' }, h('label', null, t('create.pageSize')), size), h('div', { class: 'form-row' }, h('label', null, t('create.orientation')), orient), h('div', { class: 'form-row' }, h('label', null, t('create.pageCount')), count)), pos.el],
    buttons: [
      { label: t('common.cancel'), value: null },
      { label: t('page.insert'), primary: true, onClick: () => ({ size: size.value, orient: orient.value, count: Math.max(1, Math.min(100, parseInt(count.value, 10) || 1)), index: pos.index() }) },
    ],
  }).promise;
  if (!res) return;
  let w;
  let hh;
  if (res.size === 'same' && g) {
    w = g.width;
    hh = g.height;
  } else {
    [w, hh] = PAGE_SIZES[res.size === 'same' ? 'A4' : res.size];
  }
  const landscape = res.orient === 'landscape';
  if (landscape !== w > hh) [w, hh] = [hh, w];
  doc.session.insertBlank(res.index, w, hh, res.count);
}

async function readPdfWithPassword(doc, bytes, name) {
  let password;
  let retry = false;
  for (;;) {
    try {
      return await doc.session.addSource(bytes, { name, password });
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

async function chooseRange(title, src, extra = null) {
  const range = h('input', { class: 'input', placeholder: t('combine.allPages') });
  const res = await openDialog({
    title,
    content: [h('div', null, t('page.fileInfo', { name: src.name, n: src.numPages })), h('div', { class: 'form-row' }, h('label', null, t('page.range')), range, h('div', { class: 'hint' }, t('combine.rangeHint'))), extra ? extra.el : null],
    buttons: [
      { label: t('common.cancel'), value: null },
      {
        label: t('common.ok'),
        primary: true,
        onClick: () => {
          try {
            const indices = parsePageRanges(range.value, src.numPages);
            return { indices, index: extra ? extra.index() : null };
          } catch (e) {
            alertDialog(errorMessage(e));
            return false;
          }
        },
      },
    ],
  }).promise;
  return res || null;
}

export async function insertFromFile(doc, at) {
  if (doc.isReadOnly()) return doc.warnReadOnly();
  const paths = await window.api.dialog.open({ filters: [{ name: t('filter.pdfAndImages'), extensions: ['pdf', ...IMAGE_EXTENSIONS] }], multiple: true });
  if (!paths.length) return;
  const images = paths.filter((p) => /\.(png|jpe?g|gif|bmp|webp)$/i.test(p));
  const pdfs = paths.filter((p) => !images.includes(p));
  let index = at;
  for (const p of pdfs) {
    try {
      const bytes = await window.api.file.read(p);
      const src = await readPdfWithPassword(doc, bytes, basename(p));
      if (!src) continue;
      const pos = positionControls(doc, index);
      const res = await chooseRange(t('page.insertFile'), src, pos);
      if (!res) continue;
      doc.session.insertSourcePages(src, res.indices, res.index);
      index = res.index + res.indices.length;
    } catch (e) {
      alertDialog(t('error.openFailed', { name: basename(p), message: errorMessage(e) }));
    }
  }
  if (images.length) {
    const list = [];
    for (const p of images) list.push({ bytes: await window.api.file.read(p), name: basename(p) });
    await insertImagePages(doc, list, index);
  }
}

export async function insertPdfBytes(doc, bytes, name, index) {
  if (doc.isReadOnly()) return doc.warnReadOnly();
  try {
    const src = await readPdfWithPassword(doc, bytes, name);
    if (!src) return;
    doc.session.insertSourcePages(src, Array.from({ length: src.numPages }, (_, i) => i), index);
    toast(t('page.inserted', { n: src.numPages }), { type: 'success' });
  } catch (e) {
    alertDialog(t('error.openFailed', { name, message: errorMessage(e) }));
  }
}

export async function insertImagesDialog(doc, at) {
  const paths = await window.api.dialog.open({ multiple: true, filters: [{ name: t('filter.images'), extensions: IMAGE_EXTENSIONS }] });
  if (!paths.length) return;
  const list = [];
  for (const p of paths) list.push({ bytes: await window.api.file.read(p), name: basename(p) });
  await insertImagePages(doc, list, at);
}

export async function insertImagePages(doc, images, index) {
  if (doc.isReadOnly()) return doc.warnReadOnly();
  try {
    const cur = doc.viewer.pageViewAt(Math.max(0, index - 1));
    const g = cur && cur.geometry;
    const bytes = await imagesToPdfBytes(images, { pageSize: 'A4', margin: 20 });
    const src = await doc.session.addSource(bytes, { name: images[0].name });
    doc.session.insertSourcePages(src, Array.from({ length: src.numPages }, (_, i) => i), index);
    void g;
  } catch (e) {
    alertDialog(t('error.imageFailed', { message: errorMessage(e) }));
  }
}

export async function replace(doc, uids) {
  if (doc.isReadOnly()) return doc.warnReadOnly();
  if (!uids.length) return;
  const paths = await window.api.dialog.open({ filters: [{ name: t('filter.pdf'), extensions: ['pdf'] }] });
  if (!paths.length) return;
  try {
    const bytes = await window.api.file.read(paths[0]);
    const src = await readPdfWithPassword(doc, bytes, basename(paths[0]));
    if (!src) return;
    const res = await chooseRange(t('page.replaceWith', { n: uids.length }), src);
    if (!res) return;
    doc.session.replacePages(uids, src, res.indices);
  } catch (e) {
    alertDialog(t('error.openFailed', { name: basename(paths[0]), message: errorMessage(e) }));
  }
}

export async function extract(doc, uids) {
  const pages = doc.session.state.pages;
  const preset = formatPageRanges(uids.map((u) => doc.session.pageIndex(u)).filter((i) => i >= 0));
  const range = h('input', { class: 'input', value: preset });
  const separate = h('input', { type: 'checkbox' });
  const remove = h('input', { type: 'checkbox' });
  const res = await openDialog({
    title: t('page.extract'),
    content: [
      h('div', { class: 'form-row' }, h('label', null, t('page.range')), range, h('div', { class: 'hint' }, t('combine.rangeHint'))),
      h('label', { class: 'check' }, separate, t('extract.separate')),
      h('label', { class: 'check' }, remove, t('extract.delete')),
    ],
    buttons: [
      { label: t('common.cancel'), value: null },
      {
        label: t('page.extract'),
        primary: true,
        onClick: () => {
          try {
            const idx = parsePageRanges(range.value, pages.length);
            if (!idx.length) return false;
            return { idx, separate: separate.checked, remove: remove.checked };
          } catch (e) {
            alertDialog(errorMessage(e));
            return false;
          }
        },
      },
    ],
  }).promise;
  if (!res) return;
  const base = stripExt(doc.session.name);
  const ticket = await authorize(doc.session, res.idx.map((i) => pages[i]), 'extract');
  if (!ticket) return;
  try {
    if (res.separate) {
      const folder = await window.api.dialog.folder({ title: t('split.chooseFolder') });
      if (!folder) return;
      try {
        await withBusy(t('extract.running'), async (busy) => {
          for (let k = 0; k < res.idx.length; k++) {
            const i = res.idx[k];
            const { bytes } = await doc.session.buildBytes({ pages: [pages[i]], outline: [] });
            await window.api.file.write(joinPath(folder, `${base}_${t('common.page')}${i + 1}.pdf`), bytes);
            busy.set((k + 1) / res.idx.length);
          }
        });
        if (!(await ticket.commit())) return window.api.folder.discard(folder);
        await window.api.folder.commit(folder, `${base}_${t('extract.suffix')}.zip`);
      } catch (e) {
        window.api.folder.discard(folder);
        throw e;
      }
      toast(t('extract.done', { n: res.idx.length }), { type: 'success' });
    } else {
      const defaultPath = `${base}_${t('extract.suffix')}.pdf`;
      const out = await window.api.dialog.save({ defaultPath, filters: [{ name: t('filter.pdf'), extensions: ['pdf'] }] });
      if (!out) return;
      const { bytes } = await withBusy(t('extract.running'), () => doc.session.buildBytes({ pages: res.idx.map((i) => pages[i]), outline: [] }));
      if (!(await ticket.commit())) return;
      await window.api.file.write(out, bytes);
      toast(t('common.savedTo', { path: basename(out) }), { type: 'success', action: { label: t('common.open'), onClick: () => doc.app.openPaths([out]) } });
    }
    if (res.remove) {
      const removeUids = res.idx.map((i) => pages[i].uid);
      if (removeUids.length < pages.length) doc.session.deletePages(removeUids);
    }
  } catch (e) {
    alertDialog(errorMessage(e));
  }
}

export async function split(doc) {
  const pages = doc.session.state.pages;
  const mode = h('select', { class: 'input' }, h('option', { value: 'count' }, t('split.byCount')), h('option', { value: 'ranges' }, t('split.byRanges')), h('option', { value: 'bookmarks' }, t('split.byBookmarks')));
  const count = h('input', { class: 'input', type: 'number', min: 1, max: Math.max(1, pages.length), value: Math.max(1, Math.min(5, pages.length)) });
  const ranges = h('input', { class: 'input', placeholder: '1-3; 4-6; 7-' });
  const countRow = h('div', { class: 'form-row' }, h('label', null, t('split.pagesPerFile')), count);
  const rangesRow = h('div', { class: 'form-row hidden' }, h('label', null, t('split.rangesLabel')), ranges, h('div', { class: 'hint' }, t('split.rangesHint')));
  mode.addEventListener('change', () => {
    countRow.classList.toggle('hidden', mode.value !== 'count');
    rangesRow.classList.toggle('hidden', mode.value !== 'ranges');
  });
  const res = await openDialog({
    title: t('page.split'),
    content: [h('div', { class: 'form-row' }, h('label', null, t('split.method')), mode), countRow, rangesRow, h('div', { class: 'hint' }, t('split.total', { n: pages.length }))],
    buttons: [
      { label: t('common.cancel'), value: null },
      { label: t('page.split'), primary: true, onClick: () => ({ mode: mode.value, count: Math.max(1, parseInt(count.value, 10) || 1), ranges: ranges.value }) },
    ],
  }).promise;
  if (!res) return;
  let groups = [];
  try {
    if (res.mode === 'count') {
      for (let i = 0; i < pages.length; i += res.count) groups.push({ idx: Array.from({ length: Math.min(res.count, pages.length - i) }, (_, k) => i + k) });
    } else if (res.mode === 'ranges') {
      for (const part of res.ranges.split(';').map((s) => s.trim()).filter(Boolean)) groups.push({ idx: parsePageRanges(part, pages.length) });
    } else {
      await doc.outline.load();
      const top = (doc.outline.items || []).map((it) => ({ title: it.title, start: pages.findIndex((p) => p.uid === it.pageUid) })).filter((x) => x.start >= 0).sort((a, b) => a.start - b.start);
      if (!top.length) return alertDialog(t('split.noBookmarks'));
      if (top[0].start > 0) top.unshift({ title: t('split.beginning'), start: 0 });
      top.forEach((b, i) => {
        const end = i + 1 < top.length ? top[i + 1].start : pages.length;
        if (end > b.start) groups.push({ idx: Array.from({ length: end - b.start }, (_, k) => b.start + k), title: b.title });
      });
    }
  } catch (e) {
    return alertDialog(errorMessage(e));
  }
  groups = groups.filter((g) => g.idx.length);
  if (!groups.length) return;
  const ticket = await authorize(doc.session, groups.flatMap((g) => g.idx.map((i) => pages[i])), 'split');
  if (!ticket) return;
  const folder = await window.api.dialog.folder({ title: t('split.chooseFolder') });
  if (!folder) return;
  const base = stripExt(doc.session.name);
  try {
    await withBusy(t('split.running'), async (busy) => {
      for (let g = 0; g < groups.length; g++) {
        const group = groups[g];
        const { bytes } = await doc.session.buildBytes({ pages: group.idx.map((i) => pages[i]), outline: [] });
        const safeTitle = group.title ? `_${group.title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60)}` : '';
        await window.api.file.write(joinPath(folder, `${base}_${String(g + 1).padStart(2, '0')}${safeTitle}.pdf`), bytes);
        busy.set((g + 1) / groups.length);
      }
    });
    if (!(await ticket.commit())) return window.api.folder.discard(folder);
    await window.api.folder.commit(folder, `${base}_${t('split.suffix')}.zip`);
    toast(t('split.done', { n: groups.length }), { type: 'success' });
  } catch (e) {
    window.api.folder.discard(folder);
    alertDialog(errorMessage(e));
  }
}

export { uid, confirmDialog };
