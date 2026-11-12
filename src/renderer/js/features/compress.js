// Compress: re-encodes images at a lower resolution/quality and removes
// unused objects.
import { PDFName, PDFNumber, PDFRawStream, PDFRef, PDFDict, PDFArray } from '@cantoo/pdf-lib';
import { h, stripExt, formatBytes } from '../ui/dom.js';
import { openDialog, withBusy, alertDialog, toast } from '../ui/dialogs.js';
import { loadPdf } from '../../../core/builder.js';
import { analyzePageContent } from '../../../core/content-editor.js';
import { allImages } from '../../../core/interpreter.js';
import { collectGarbage } from '../../../core/pdf-gc.js';
import { decodeImageXObject } from '../doc/image-tools.js';
import { t, errorMessage } from '../i18n.js';
import { authorize } from '../../../web/billing.js';

const LEVELS = {
  low: { dpi: 200, quality: 0.85 },
  medium: { dpi: 144, quality: 0.72 },
  high: { dpi: 96, quality: 0.55 },
};

export async function compressBytes(bytes, level, onProgress) {
  const { dpi, quality } = LEVELS[level] || LEVELS.medium;
  const doc = await loadPdf(bytes);
  const ctx = doc.context;
  // Largest displayed size (points) per image object.
  const display = new Map();
  const pages = doc.getPages();
  for (const page of pages) {
    let model;
    try {
      model = analyzePageContent(doc, page, { collectPaths: false });
    } catch {
      continue;
    }
    for (const { image } of allImages(model)) {
      if (!image.ref) continue;
      const w = image.bbox[2] - image.bbox[0];
      const hh = image.bbox[3] - image.bbox[1];
      const cur = display.get(image.ref.tag) || { w: 0, h: 0, ref: image.ref };
      display.set(image.ref.tag, { ref: image.ref, w: Math.max(cur.w, w), h: Math.max(cur.h, hh) });
    }
  }
  let done = 0;
  let replaced = 0;
  for (const { ref, w, h: hh } of display.values()) {
    done++;
    if (onProgress) onProgress(done / Math.max(1, display.size));
    const stream = ctx.lookup(ref);
    if (!(stream instanceof PDFRawStream)) continue;
    const dict = stream.dict;
    if (dict.get(PDFName.of('ImageMask')) || dict.get(PDFName.of('Decode')) || dict.get(PDFName.of('Mask'))) continue;
    const width = dict.lookup(PDFName.of('Width'))?.asNumber?.() || 0;
    const height = dict.lookup(PDFName.of('Height'))?.asNumber?.() || 0;
    if (width * height < 64 * 64) continue;
    const targetW = Math.max(16, Math.round((w / 72) * dpi));
    const targetH = Math.max(16, Math.round((hh / 72) * dpi));
    const scale = Math.min(1, targetW / width, targetH / height);
    let decoded;
    try {
      decoded = await decodeImageXObject(ctx, stream);
    } catch {
      continue;
    }
    const nw = Math.max(1, Math.round(width * scale));
    const nh = Math.max(1, Math.round(height * scale));
    const src = new OffscreenCanvas(width, height);
    src.getContext('2d').putImageData(decoded.imageData, 0, 0);
    const dst = new OffscreenCanvas(nw, nh);
    const dctx = dst.getContext('2d');
    dctx.imageSmoothingQuality = 'high';
    dctx.fillStyle = '#fff';
    dctx.fillRect(0, 0, nw, nh);
    dctx.drawImage(src, 0, 0, nw, nh);
    const blob = await dst.convertToBlob({ type: 'image/jpeg', quality });
    const jpg = new Uint8Array(await blob.arrayBuffer());
    if (jpg.length >= stream.contents.length * 0.95) continue;
    const newDict = ctx.obj({ Type: 'XObject', Subtype: 'Image', Width: nw, Height: nh, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode', Length: jpg.length });
    const smask = dict.get(PDFName.of('SMask'));
    if (smask) newDict.set(PDFName.of('SMask'), smask);
    const interp = dict.get(PDFName.of('Interpolate'));
    if (interp) newDict.set(PDFName.of('Interpolate'), interp);
    ctx.assign(ref, PDFRawStream.of(newDict, jpg));
    replaced++;
  }
  collectGarbage(doc);
  const out = await doc.save({ useObjectStreams: true, updateFieldAppearances: false });
  return { bytes: out, replaced };
}

export async function open(doc) {
  const level = h('select', { class: 'input' }, Object.keys(LEVELS).map((k) => h('option', { value: k, selected: k === 'medium' }, t(`compress.${k}`))));
  const res = await openDialog({
    title: t('tools.compress'),
    content: [h('div', { class: 'hint' }, t('compress.hint')), h('div', { class: 'form-row' }, h('label', null, t('compress.level')), level)],
    buttons: [
      { label: t('common.cancel'), value: null },
      { label: t('compress.run'), primary: true, onClick: () => ({ level: level.value }) },
    ],
  }).promise;
  if (!res) return;
  const ticket = await authorize(doc.session, doc.session.state.pages, 'compress');
  if (!ticket) return;
  try {
    const result = await withBusy(t('compress.running'), async (busy) => {
      doc.overlay.commitEditing();
      const built = await doc.session.buildBytes();
      const secured = doc.session.effectiveSecurity();
      const plain = secured ? (await doc.session.buildBytes({ security: null })).bytes : built.bytes;
      const r = await compressBytes(plain, res.level, (f) => busy.set(f * 0.9));
      return { before: built.bytes.length, ...r };
    });
    const out = await window.api.dialog.save({ defaultPath: `${stripExt(doc.session.name)}_${t('compress.suffix')}.pdf`, filters: [{ name: t('filter.pdf'), extensions: ['pdf'] }] });
    if (!out) return;
    if (!(await ticket.commit())) return;
    await window.api.file.write(out, result.bytes);
    const pct = Math.max(0, Math.round((1 - result.bytes.length / result.before) * 100));
    toast(t('compress.done', { before: formatBytes(result.before), after: formatBytes(result.bytes.length), pct }), { type: 'success', timeout: 6000, action: { label: t('common.open'), onClick: () => doc.app.openPaths([out]) } });
  } catch (e) {
    console.error(e);
    alertDialog(errorMessage(e));
  }
}

export { PDFNumber, PDFRef, PDFDict, PDFArray };
