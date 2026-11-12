// Conversions: PDF to images, text, Word and HTML.
import { h, stripExt, joinPath, basename } from '../ui/dom.js';
import { openDialog, withBusy, alertDialog, toast } from '../ui/dialogs.js';
import { openPdfjs, makeViewport, pdfjsLib, destroyPdf } from '../pdf/pdfjs.js';
import { parsePageRanges } from '../../../core/page-ranges.js';
import { loadPdf } from '../../../core/builder.js';
import { analyzePageContent } from '../../../core/content-editor.js';
import { allImages } from '../../../core/interpreter.js';
import { buildTextBlocks } from '../doc/text-blocks.js';
import { decodeImageXObject, imageDataToBytes, canvasToBytes } from '../doc/image-tools.js';
import { buildHtml } from '../../../core/html-writer.js';
import { convertPdfToDocx, PDFJS_CONVERT_OPTIONS } from '../../../core/convert/index.js';
import { mapFont } from '../../../core/convert/font-map.js';
import { registry, loadSystemFonts } from '../pdf/fonts.js';
import { t, errorMessage } from '../i18n.js';
import { authorize } from '../../../web/billing.js';

async function builtDocument(doc) {
  doc.overlay.commitEditing();
  const { bytes } = await doc.session.buildBytes({ security: null });
  const pdf = await openPdfjs(bytes);
  return { bytes, pdf };
}

function rangeRow(n) {
  const input = h('input', { class: 'input', placeholder: `1-${n}` });
  return { el: h('div', { class: 'form-row' }, h('label', null, t('page.range')), input, h('div', { class: 'hint' }, t('combine.rangeHint'))), get: () => parsePageRanges(input.value, n) };
}

function defaultOut(doc, ext) {
  return `${stripExt(doc.session.name)}.${ext}`;
}

export async function toImages(doc) {
  const n = doc.session.state.pages.length;
  const format = h('select', { class: 'input' }, h('option', { value: 'png' }, 'PNG'), h('option', { value: 'jpeg' }, 'JPG'));
  const dpi = h('select', { class: 'input' }, [72, 96, 150, 200, 300].map((d) => h('option', { value: d, selected: d === 150 }, `${d} DPI`)));
  const range = rangeRow(n);
  const res = await openDialog({
    title: t('convert.toImage'),
    content: [h('div', { class: 'form-grid' }, h('div', { class: 'form-row' }, h('label', null, t('convert.format')), format), h('div', { class: 'form-row' }, h('label', null, t('convert.resolution')), dpi)), range.el],
    buttons: [
      { label: t('common.cancel'), value: null },
      { label: t('convert.run'), primary: true, onClick: () => { try { return { idx: range.get(), format: format.value, dpi: parseInt(dpi.value, 10) }; } catch (e) { alertDialog(errorMessage(e)); return false; } } },
    ],
  }).promise;
  if (!res || !res.idx.length) return;
  const pages = doc.session.state.pages;
  const ticket = await authorize(doc.session, res.idx.map((i) => pages[i]), 'to-image');
  if (!ticket) return;
  const folder = await window.api.dialog.folder({ title: t('split.chooseFolder') });
  if (!folder) return;
  const base = stripExt(doc.session.name);
  try {
    await withBusy(t('convert.running'), async (busy) => {
      const { pdf } = await builtDocument(doc);
      try {
        for (let k = 0; k < res.idx.length; k++) {
          const i = res.idx[k];
          const page = await pdf.getPage(i + 1);
          const vp = makeViewport(page, { scale: res.dpi / 72, rotation: page.rotate });
          const canvas = new OffscreenCanvas(Math.max(1, Math.round(vp.width)), Math.max(1, Math.round(vp.height)));
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, canvas, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
          const bytes = await canvasToBytes(canvas, res.format === 'png' ? 'image/png' : 'image/jpeg', 0.9);
          await window.api.file.write(joinPath(folder, `${base}_${String(i + 1).padStart(3, '0')}.${res.format === 'png' ? 'png' : 'jpg'}`), bytes);
          busy.set((k + 1) / res.idx.length);
        }
      } finally {
        destroyPdf(pdf);
      }
    });
    if (!(await ticket.commit())) return window.api.folder.discard(folder);
    await window.api.folder.commit(folder, `${base}_${res.format === 'png' ? 'png' : 'jpg'}.zip`);
    toast(t('convert.done'), { type: 'success' });
  } catch (e) {
    window.api.folder.discard(folder);
    alertDialog(errorMessage(e));
  }
}

function linesFromTextContent(tc) {
  const items = tc.items.filter((i) => typeof i.str === 'string');
  const lines = [];
  let cur = null;
  for (const it of items) {
    const y = it.transform[5];
    if (!cur || Math.abs(cur.y - y) > Math.max(2, (it.height || 10) * 0.5)) {
      cur = { y, parts: [] };
      lines.push(cur);
    }
    cur.parts.push(it);
  }
  return lines.map((l) => {
    l.parts.sort((a, b) => a.transform[4] - b.transform[4]);
    let s = '';
    let lastEnd = null;
    for (const p of l.parts) {
      if (lastEnd !== null && p.transform[4] - lastEnd > (p.height || 10) * 0.2 && !s.endsWith(' ') && !p.str.startsWith(' ')) s += ' ';
      s += p.str;
      lastEnd = p.transform[4] + (p.width || 0);
    }
    return s.replace(/\s+$/, '');
  });
}

export async function toText(doc) {
  const ticket = await authorize(doc.session, doc.session.state.pages, 'to-text');
  if (!ticket) return;
  const out = await window.api.dialog.save({ defaultPath: defaultOut(doc, 'txt'), filters: [{ name: t('filter.text'), extensions: ['txt'] }] });
  if (!out) return;
  try {
    const text = await withBusy(t('convert.running'), async (busy) => {
      const { pdf } = await builtDocument(doc);
      try {
        const parts = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const tc = await page.getTextContent();
          parts.push(linesFromTextContent(tc).join('\r\n'));
          busy.set(i / pdf.numPages);
        }
        // The byte-order mark makes Notepad read the file as UTF-8.
        return '\ufeff' + parts.join('\r\n\f\r\n');
      } finally {
        destroyPdf(pdf);
      }
    });
    if (!(await ticket.commit())) return;
    await window.api.file.write(out, new TextEncoder().encode(text));
    toast(t('common.savedTo', { path: basename(out) }), { type: 'success' });
  } catch (e) {
    alertDialog(errorMessage(e));
  }
}

async function extractFlow(doc, busy) {
  const { bytes, pdf } = await builtDocument(doc);
  const lib = await loadPdf(bytes);
  const pages = [];
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      const analysis = analyzePageContent(lib, lib.getPage(i - 1));
      const blocks = buildTextBlocks(tc, { mode: 'paragraph', analysis }).filter((b) => !b.invisible && b.orientation === 0);
      const items = [];
      for (const b of blocks) {
        const family = b.font ? registry.matchFamily(b.font.name, b.font) : 'Arial';
        items.push({ kind: 'paragraph', top: b.rect[3], left: b.rect[0], text: b.lineTexts.length > 1 && b.align !== 'left' ? b.lineTexts.join('\n') : b.text, size: Math.round(b.size * 2) / 2, bold: b.font?.bold, italic: b.font?.italic, color: b.color, align: b.align, font: family.replace(/^Liberation Sans$/, 'Arial').replace(/^Liberation Serif$/, 'Times New Roman').replace(/^Liberation Mono$/, 'Courier New') });
      }
      for (const { image } of allImages(analysis)) {
        const w = image.bbox[2] - image.bbox[0];
        const hgt = image.bbox[3] - image.bbox[1];
        if (w < 12 || hgt < 12 || !image.stream) continue;
        try {
          const { imageData, jpeg } = await decodeImageXObject(lib.context, image.stream);
          const imgBytes = jpeg ? image.stream.contents : await imageDataToBytes(imageData, 'image/png');
          items.push({ kind: 'image', top: image.bbox[3], left: image.bbox[0], bytes: imgBytes, ext: jpeg ? 'jpeg' : 'png', width: w, height: hgt });
        } catch {
          /* unsupported image */
        }
      }
      items.sort((a, b) => b.top - a.top || a.left - b.left);
      let prevBottom = null;
      for (const it of items) {
        if (it.kind === 'paragraph' && prevBottom !== null) it.spaceBefore = Math.min(24, Math.max(0, prevBottom - it.top - (it.size || 11) * 0.6));
        prevBottom = it.kind === 'image' ? it.top - it.height : it.top - (it.size || 11) * 1.2;
      }
      const [x0, y0, x1, y1] = page.view;
      const rotated = page.rotate % 180 !== 0;
      pages.push({ width: rotated ? y1 - y0 : x1 - x0, height: rotated ? x1 - x0 : y1 - y0, items });
      if (busy) busy.set(i / pdf.numPages);
    }
  } finally {
    destroyPdf(pdf);
  }
  return pages;
}

// Fonts for the Word export. A PDF font that is neither a standard Windows /
// Office family nor installed here is replaced by the matching standard
// family; the text is then measured in that family so that every word keeps
// its position.
function wordFontHooks() {
  const advances = new WeakMap();
  const advance = (metrics, ch) => {
    let cache = advances.get(metrics);
    if (!cache) {
      cache = new Map();
      advances.set(metrics, cache);
    }
    let w = cache.get(ch);
    if (w === undefined) {
      // -1: the font has no glyph for the character (Word will take it
      // from another font, whose widths are unknown).
      w = -1;
      try {
        if (metrics.hasChar(ch)) w = metrics.font.glyphForCodePoint(ch.codePointAt(0)).advanceWidth / metrics.upm;
      } catch {
        w = -1;
      }
      if (!(w >= 0)) w = -1;
      cache.set(ch, w);
    }
    return w;
  };
  return {
    async prepareFonts(records) {
      for (const rec of records) {
        if (rec.substitute !== undefined) continue;
        rec.substitute = null;
        const mapped = mapFont(rec.name, rec);
        if (mapped.known || registry.hasFamily(mapped.family)) continue;
        const family = mapped.mono ? 'Courier New' : mapped.serif ? 'Times New Roman' : 'Arial';
        try {
          // The installed family, or the bundled font with the same metrics.
          const local = registry.matchFamily(family, { serif: mapped.serif, mono: mapped.mono });
          const shaper = await registry.getShaper(local, mapped.bold, mapped.italic, '');
          const target = mapFont(family, {});
          const space = advance(shaper.metrics, ' ');
          rec.substitute = { family, ascent: target.ascent, descent: target.descent, known: true, space: space > 0 ? space : 0.25, metrics: shaper.metrics };
        } catch {
          rec.substitute = null;
        }
      }
    },
    resolveFont(mapped, rec) {
      return rec.substitute || null;
    },
    measure(text, style) {
      const metrics = style.font && style.font.metrics;
      if (!metrics) return 0;
      let w = 0;
      for (const ch of text) {
        const a = advance(metrics, ch);
        if (a < 0) return 0;
        w += a;
      }
      return w * style.size * ((style.scale || 100) / 100);
    },
  };
}

// Photographs are stored as JPEG (a scanned page as PNG would be huge);
// drawings and anything with transparency stay lossless.
async function encodePhoto(raw) {
  const { width, height, data, kind } = raw;
  if (!data || kind === 1 || width * height < 160 * 160 || typeof OffscreenCanvas === 'undefined') return null;
  const n = width * height;
  const bpp = data.length >= n * 4 ? 4 : data.length >= n * 3 ? 3 : 0;
  if (!bpp) return null;
  const colours = new Set();
  const step = Math.max(1, Math.floor(n / 6000));
  for (let i = 0; i < n; i += step) {
    const q = i * bpp;
    if (bpp === 4 && data[q + 3] !== 255) return null;
    colours.add((data[q] << 16) | (data[q + 1] << 8) | data[q + 2]);
  }
  if (colours.size < 500) return null;
  const rgba = new Uint8ClampedArray(n * 4);
  if (bpp === 4) rgba.set(data.subarray(0, n * 4));
  else {
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      rgba[j] = data[i * 3];
      rgba[j + 1] = data[i * 3 + 1];
      rgba[j + 2] = data[i * 3 + 2];
      rgba[j + 3] = 255;
    }
  }
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
  const bytes = await canvasToBytes(canvas, 'image/jpeg', 0.9);
  return bytes && bytes.length ? { bytes, ext: 'jpeg', width, height } : null;
}

// Picture of a whole page (150 dpi), for pages that cannot be analysed.
async function renderPagePicture(page, viewport) {
  const scale = Math.min(150 / 72, 4000 / Math.max(viewport.width, viewport.height));
  const vp = makeViewport(page, { scale, rotation: page.rotate });
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(vp.width)), Math.max(1, Math.round(vp.height)));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
  return { bytes: await canvasToBytes(canvas, 'image/jpeg', 0.9), ext: 'jpeg' };
}

/**
 * PDF to Word with the page layout preserved (tables, text positions,
 * pictures and drawings). Returns the DOCX bytes.
 */
export async function buildWordDocument(doc, onProgress = null) {
  doc.overlay.commitEditing();
  const { bytes } = await doc.session.buildBytes({ security: null });
  await loadSystemFonts();
  const pdf = await openPdfjs(bytes, undefined, PDFJS_CONVERT_OPTIONS);
  try {
    return await convertPdfToDocx(pdf, { OPS: pdfjsLib.OPS, title: stripExt(doc.session.name), onProgress, encodeImage: encodePhoto, renderPage: renderPagePicture, ...wordFontHooks() });
  } finally {
    destroyPdf(pdf);
  }
}

export async function toWord(doc) {
  const ticket = await authorize(doc.session, doc.session.state.pages, 'to-word');
  if (!ticket) return;
  const out = await window.api.dialog.save({ defaultPath: defaultOut(doc, 'docx'), filters: [{ name: 'Word', extensions: ['docx'] }] });
  if (!out) return;
  try {
    const bytes = await withBusy(t('convert.running'), (busy) => buildWordDocument(doc, (v) => busy.set(v)));
    if (!(await ticket.commit())) return;
    await window.api.file.write(out, bytes);
    toast(t('common.savedTo', { path: basename(out) }), { type: 'success' });
  } catch (e) {
    console.error(e);
    alertDialog(errorMessage(e));
  }
}

export async function toHtml(doc) {
  const ticket = await authorize(doc.session, doc.session.state.pages, 'to-html');
  if (!ticket) return;
  const out = await window.api.dialog.save({ defaultPath: defaultOut(doc, 'html'), filters: [{ name: 'HTML', extensions: ['html'] }] });
  if (!out) return;
  try {
    const html = await withBusy(t('convert.running'), async (busy) => buildHtml(await extractFlow(doc, busy), { title: stripExt(doc.session.name) }));
    if (!(await ticket.commit())) return;
    await window.api.file.write(out, new TextEncoder().encode(html));
    toast(t('common.savedTo', { path: basename(out) }), { type: 'success' });
  } catch (e) {
    alertDialog(errorMessage(e));
  }
}
