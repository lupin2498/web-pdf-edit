// Creating new PDFs: blank documents and PDFs from images.
import { PDFDocument } from '@cantoo/pdf-lib';
import { h, basename, stripExt } from '../ui/dom.js';
import { openDialog, withBusy, alertDialog } from '../ui/dialogs.js';
import { prepareImageFile } from '../doc/image-tools.js';
import { IMAGE_EXTENSIONS } from './insert.js';
import { t, errorMessage } from '../i18n.js';

export const PAGE_SIZES = {
  A4: [595.28, 841.89],
  A3: [841.89, 1190.55],
  A5: [419.53, 595.28],
  Letter: [612, 792],
  Legal: [612, 1008],
};

export async function imagesToPdfBytes(images, { pageSize = 'fit', orientation = 'auto', margin = 0 } = {}) {
  const doc = await PDFDocument.create();
  for (const img of images) {
    const prepared = await prepareImageFile(img.bytes, img.name || '');
    const embedded = /jpe?g/.test(prepared.mime) ? await doc.embedJpg(prepared.bytes) : await doc.embedPng(prepared.bytes);
    let pw;
    let ph;
    // Images are placed at 96 dpi when using their natural size.
    const iw = (prepared.width * 72) / 96;
    const ih = (prepared.height * 72) / 96;
    if (pageSize === 'fit') {
      pw = iw + margin * 2;
      ph = ih + margin * 2;
    } else {
      [pw, ph] = PAGE_SIZES[pageSize] || PAGE_SIZES.A4;
      const landscape = orientation === 'landscape' || (orientation === 'auto' && prepared.width > prepared.height);
      if (landscape) [pw, ph] = [ph, pw];
    }
    const page = doc.addPage([pw, ph]);
    const availW = pw - margin * 2;
    const availH = ph - margin * 2;
    const scale = pageSize === 'fit' ? 1 : Math.min(availW / iw, availH / ih, 1e9);
    const w = iw * scale;
    const hh = ih * scale;
    page.drawImage(embedded, { x: (pw - w) / 2, y: (ph - hh) / 2, width: w, height: hh });
  }
  return doc.save();
}

export async function blank(app) {
  const size = h('select', { class: 'input' }, Object.keys(PAGE_SIZES).map((k) => h('option', { value: k }, k)));
  const orient = h('select', { class: 'input' }, h('option', { value: 'portrait' }, t('create.portrait')), h('option', { value: 'landscape' }, t('create.landscape')));
  const count = h('input', { class: 'input', type: 'number', min: 1, max: 500, value: 1 });
  const res = await openDialog({
    title: t('create.blank'),
    content: [h('div', { class: 'form-grid three' }, h('div', { class: 'form-row' }, h('label', null, t('create.pageSize')), size), h('div', { class: 'form-row' }, h('label', null, t('create.orientation')), orient), h('div', { class: 'form-row' }, h('label', null, t('create.pageCount')), count))],
    buttons: [
      { label: t('common.cancel'), value: null },
      { label: t('common.create'), primary: true, onClick: () => ({ size: size.value, orient: orient.value, count: Math.max(1, Math.min(500, parseInt(count.value, 10) || 1)) }) },
    ],
  }).promise;
  if (!res) return;
  let [w, hh] = PAGE_SIZES[res.size];
  if (res.orient === 'landscape') [w, hh] = [hh, w];
  const doc = await PDFDocument.create();
  for (let i = 0; i < res.count; i++) doc.addPage([w, hh]);
  const bytes = await doc.save();
  await app.openBytes(bytes, { name: `${t('create.untitled')}.pdf`, isNew: true });
}

export async function fromImages(app) {
  const paths = await window.api.dialog.open({ multiple: true, filters: [{ name: t('filter.images'), extensions: IMAGE_EXTENSIONS }] });
  if (paths.length) await fromImagePaths(app, paths);
}

export async function fromImagePaths(app, paths) {
  const size = h('select', { class: 'input' }, h('option', { value: 'fit' }, t('create.fitImage')), Object.keys(PAGE_SIZES).map((k) => h('option', { value: k }, k)));
  const margin = h('input', { class: 'input', type: 'number', min: 0, max: 100, value: 0 });
  const res = await openDialog({
    title: t('create.fromImages'),
    content: [h('div', null, t('create.imagesSelected', { n: paths.length })), h('div', { class: 'form-grid' }, h('div', { class: 'form-row' }, h('label', null, t('create.pageSize')), size), h('div', { class: 'form-row' }, h('label', null, t('create.marginMm')), margin))],
    buttons: [
      { label: t('common.cancel'), value: null },
      { label: t('common.create'), primary: true, onClick: () => ({ size: size.value, margin: (parseFloat(margin.value) || 0) * 2.8346 }) },
    ],
  }).promise;
  if (!res) return;
  try {
    const bytes = await withBusy(t('create.creating'), async () => {
      const images = [];
      for (const p of paths) images.push({ bytes: await window.api.file.read(p), name: basename(p) });
      return imagesToPdfBytes(images, { pageSize: res.size, margin: res.margin });
    });
    await app.openBytes(bytes, { name: `${stripExt(basename(paths[0]))}.pdf`, isNew: true });
  } catch (e) {
    alertDialog(t('error.imageFailed', { message: errorMessage(e) }));
  }
}
