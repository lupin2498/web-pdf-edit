// Printing: renders pages (with edits) to images and uses the system dialog.
import { h, clear } from '../ui/dom.js';
import { openDialog, withBusy, alertDialog } from '../ui/dialogs.js';
import { openPdfjs, makeViewport, pdfjsLib, destroyPdf } from '../pdf/pdfjs.js';
import { parsePageRanges } from '../../../core/page-ranges.js';
import { t, errorMessage } from '../i18n.js';
import { authorize } from '../../../web/billing.js';

export async function open(doc) {
  if (!doc) return;
  const n = doc.session.state.pages.length;
  const scope = h('select', { class: 'input' }, h('option', { value: 'all' }, t('crop.all')), h('option', { value: 'current' }, t('crop.current')), h('option', { value: 'range' }, t('crop.range')));
  const range = h('input', { class: 'input', placeholder: `1-${n}`, disabled: true });
  scope.addEventListener('change', () => (range.disabled = scope.value !== 'range'));
  const quality = h('select', { class: 'input' }, h('option', { value: '150' }, t('print.normal')), h('option', { value: '300' }, t('print.high')));
  const annotations = h('input', { type: 'checkbox', checked: true });
  const res = await openDialog({
    title: t('file.print'),
    content: [
      h('div', { class: 'form-grid' }, h('div', { class: 'form-row' }, h('label', null, t('marks.pages')), scope), h('div', { class: 'form-row' }, h('label', null, t('page.range')), range)),
      h('div', { class: 'form-row' }, h('label', null, t('print.quality')), quality),
      h('label', { class: 'check' }, annotations, t('print.annotations')),
    ],
    buttons: [
      { label: t('common.cancel'), value: null },
      {
        label: t('print.print'),
        primary: true,
        onClick: () => {
          try {
            let idx;
            if (scope.value === 'all') idx = Array.from({ length: n }, (_, i) => i);
            else if (scope.value === 'current') idx = [doc.viewer.currentIndex];
            else idx = parsePageRanges(range.value, n);
            return { idx, dpi: parseInt(quality.value, 10), annotations: annotations.checked };
          } catch (e) {
            alertDialog(errorMessage(e));
            return false;
          }
        },
      },
    ],
  }).promise;
  if (!res || !res.idx.length) return;
  const statePages = doc.session.state.pages;
  const ticket = await authorize(doc.session, res.idx.map((i) => statePages[i]), 'print');
  if (!ticket) return;
  const container = document.getElementById('print-container');
  const urls = [];
  try {
    await withBusy(t('print.preparing'), async (busy) => {
      doc.overlay.commitEditing();
      const { bytes } = await doc.session.buildBytes({ security: null });
      const pdf = await openPdfjs(bytes);
      clear(container);
      let style = document.getElementById('print-page-style');
      if (!style) {
        style = document.createElement('style');
        style.id = 'print-page-style';
        document.head.appendChild(style);
      }
      try {
        for (let k = 0; k < res.idx.length; k++) {
          const page = await pdf.getPage(res.idx[k] + 1);
          const vp1 = makeViewport(page, { scale: 1, rotation: page.rotate });
          if (k === 0) style.textContent = `@page { size: ${vp1.width}pt ${vp1.height}pt; margin: 0; }`;
          const vp = makeViewport(page, { scale: res.dpi / 72, rotation: page.rotate });
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(vp.width);
          canvas.height = Math.round(vp.height);
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, canvas, viewport: vp, intent: 'print', annotationMode: res.annotations ? pdfjsLib.AnnotationMode.ENABLE_STORAGE : pdfjsLib.AnnotationMode.DISABLE }).promise;
          const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
          const url = URL.createObjectURL(blob);
          urls.push(url);
          const img = h('img', { src: url, style: { width: `${vp1.width}pt`, height: `${vp1.height}pt` } });
          container.appendChild(h('div', { class: 'print-page', style: { width: `${vp1.width}pt`, height: `${vp1.height}pt` } }, img));
          busy.set((k + 1) / res.idx.length);
        }
      } finally {
        destroyPdf(pdf);
      }
      await Promise.all([...container.querySelectorAll('img')].map((img) => (img.complete ? Promise.resolve() : new Promise((r) => (img.onload = img.onerror = r)))));
    });
    if (!(await ticket.commit())) return;
    const result = await window.api.print({});
    if (result && !result.success && result.reason && !/cancel/i.test(result.reason)) alertDialog(t('print.failed', { reason: result.reason }));
  } catch (e) {
    alertDialog(errorMessage(e));
  } finally {
    clear(container);
    for (const u of urls) URL.revokeObjectURL(u);
  }
}
