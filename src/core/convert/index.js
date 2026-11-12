// PDF to Word conversion that preserves the page layout.
//
//   convertPdfToDocx(pdf, { OPS, pages, onProgress, ... }) -> Uint8Array
//
// `pdf` is a pdf.js document opened with `fontExtraProperties: true` and
// `isOffscreenCanvasSupported: false` (images are then delivered as raw
// pixels in every environment).
import { buildPageModel } from './page-model.js';
import { layoutPage } from './layout.js';
import { buildLayoutDocx } from './docx-layout.js';
import { encodePdfjsImage, encodeMaskPng, encodePngRgba } from './png.js';

export { buildPageModel, layoutPage, buildLayoutDocx };

// Options pdf.js needs for conversion (merged into getDocument parameters).
export const PDFJS_CONVERT_OPTIONS = Object.freeze({ fontExtraProperties: true, isOffscreenCanvasSupported: false, isImageDecoderSupported: false });

function getObject(page, id) {
  const store = typeof id === 'string' && id.startsWith('g_') ? page.commonObjs : page.objs;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    try {
      if (store.has(id)) {
        finish(store.get(id));
        return;
      }
      store.get(id, (v) => finish(v));
    } catch {
      finish(null);
    }
    // Never wait forever for an image that failed to decode.
    setTimeout(() => finish(null), 15000);
  });
}

// Pixels of a pdf.js image object as { width, height, kind, data }.
async function rawImage(img) {
  if (!img) return null;
  if (img.data && img.width && img.height) return img;
  if (img.bitmap && typeof OffscreenCanvas !== 'undefined') {
    const w = img.bitmap.width;
    const h = img.bitmap.height;
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img.bitmap, 0, 0);
    return { width: w, height: h, kind: 3, data: ctx.getImageData(0, 0, w, h).data };
  }
  return null;
}

/**
 * Loads and encodes the image of an image float.
 * encodeImage(raw, { opaque }) may return { bytes, ext } (e.g. JPEG from a
 * canvas); otherwise PNG is produced.
 */
async function loadImage(page, source, cache, encodeImage) {
  const keyBase = source.objId || null;
  const key = keyBase ? `${keyBase}|${source.maskColor || ''}` : null;
  if (key && cache.has(key)) return cache.get(key);
  let result = null;
  try {
    if (source.maskObj) {
      let m = source.maskObj;
      if (m && typeof m.data === 'string') m = { ...m, ...(await getObject(page, m.data)) };
      const raw = m && m.data && m.width && m.height ? m : await rawImage(m);
      if (raw && raw.data) {
        if (raw.kind === 3 || raw.data.length === raw.width * raw.height * 4) result = { bytes: encodePngRgba(raw.width, raw.height, raw.data), ext: 'png' };
        else result = encodeMaskPng(raw.width, raw.height, raw.data, source.maskColor || '#000000');
      }
    } else {
      const obj = source.inline || (await getObject(page, source.objId));
      const raw = await rawImage(obj);
      if (raw) {
        if (encodeImage) result = await encodeImage(raw);
        if (!result) result = encodePdfjsImage(raw);
      }
    }
  } catch {
    result = null;
  }
  if (key) cache.set(key, result);
  return result;
}

/**
 * Lays out the given pages of a pdf.js document.
 * Returns layout pages ready for buildLayoutDocx().
 *
 * Fonts: by default every PDF font is mapped to a Word family by its name.
 * resolveFont(mapped, fontRecord) may return replacements for that mapping
 * ({ family, ascent, descent, space, ... }), measure(text, style) the natural
 * width of text in the font actually used (pt, 0 = unknown), and
 * prepareFonts(fontRecords) is awaited before a page is laid out.
 * renderPage(page, viewport) may return a picture { bytes, ext } of a page;
 * it is used for a page whose content cannot be analysed.
 */
export async function layoutDocument(pdf, { OPS, pages = null, onProgress = null, prepareFonts = null, resolveFont = null, measure = null, encodeImage = null, renderPage = null, images = true } = {}) {
  const indices = pages || Array.from({ length: pdf.numPages }, (_, i) => i);
  const out = [];
  // Horizontal scale of replacement fonts, shared by all pages.
  const fits = new Map();
  for (let k = 0; k < indices.length; k++) {
    const page = await pdf.getPage(indices[k] + 1);
    const viewport = page.getViewport({ scale: 1 });
    let layout;
    try {
      const opList = await page.getOperatorList();
      const model = buildPageModel(opList, {
        OPS,
        getFont: (id) => (page.commonObjs.has(id) ? page.commonObjs.get(id) : null),
        getPattern: (id) => (page.objs.has(id) ? page.objs.get(id) : page.commonObjs.has(id) ? page.commonObjs.get(id) : null),
        transform: viewport.transform,
        width: viewport.width,
        height: viewport.height,
      });
      // Lets the caller load what resolveFont / measure need for these fonts.
      if (prepareFonts) await prepareFonts(model.fonts);
      layout = layoutPage(model, { resolveFont, measure, fits });
      layout.stats = model.stats;
      if (images) {
        const cache = new Map();
        for (const f of layout.floats) {
          if (f.type !== 'image') continue;
          f.data = await loadImage(page, f.source, cache, encodeImage);
          delete f.source;
        }
      }
    } catch (err) {
      // A page that cannot be analysed becomes a picture of itself rather
      // than failing the whole document.
      if (!renderPage) throw err;
      const data = await renderPage(page, viewport);
      if (!data || !data.bytes) throw err;
      layout = { width: viewport.width, height: viewport.height, blocks: [], floats: [{ type: 'image', x: 0, y: 0, w: viewport.width, h: viewport.height, rot: 0, flipH: false, flipV: false, alpha: 1, crop: null, seq: 0, data }], lines: [], tables: [], stats: { failed: String((err && err.message) || err) } };
    }
    out.push(layout);
    try {
      page.cleanup();
    } catch {
      /* ignore */
    }
    if (onProgress) onProgress((k + 1) / indices.length);
  }
  return out;
}

export async function convertPdfToDocx(pdf, options = {}) {
  const pages = await layoutDocument(pdf, options);
  return buildLayoutDocx(pages, { title: options.title || '', author: options.author || 'PDF Edit' });
}
