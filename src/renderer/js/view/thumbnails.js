// Thumbnail rendering with a small cache and limited concurrency.
import { makeViewport, pdfjsLib, openPdfjs, destroyPdf } from '../pdf/pdfjs.js';
import { needsPreview } from '../doc/session.js';

export class ThumbnailService {
  constructor(session) {
    this.session = session;
    this.cache = new Map();
    this.queue = [];
    this.active = 0;
  }

  key(entry, width) {
    const objects = (entry.objects || []).filter((o) => !o.hidden);
    return JSON.stringify([entry.src, entry.rotate, entry.crop, entry.blank, needsPreview(entry) ? [entry.removals, entry.imageEdits, entry.annotEdits] : null, objects.length ? objects : null, width]);
  }

  // Draws the thumbnail into `canvas` (sized to fit `width`).
  draw(entry, canvas, width) {
    const key = this.key(entry, width);
    const cached = this.cache.get(key);
    if (cached && cached.bitmap) {
      paint(canvas, cached.bitmap);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push({ entry, key, width, resolve: (bitmap) => {
        if (bitmap) paint(canvas, bitmap);
        resolve();
      } });
      this.pump();
    });
  }

  pump() {
    while (this.active < 2 && this.queue.length) {
      const job = this.queue.shift();
      const cached = this.cache.get(job.key);
      if (cached && cached.bitmap) {
        job.resolve(cached.bitmap);
        continue;
      }
      this.active++;
      this.renderJob(job)
        .then((bitmap) => job.resolve(bitmap))
        .catch(() => job.resolve(null))
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }

  async renderJob({ entry, key, width }) {
    const geom = await this.session.pageGeometry(entry);
    const scale = width / geom.width;
    const w = Math.max(1, Math.round(geom.width * scale));
    const hgt = Math.max(1, Math.round(geom.height * scale));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const canvas = new OffscreenCanvas(Math.round(w * dpr), Math.round(hgt * dpr));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if ((entry.objects || []).some((o) => !o.hidden)) {
      // Pages with new objects: render a one-page build so the thumbnail shows them.
      const { bytes } = await this.session.buildBytes({ pages: [entry], outline: [], security: null, standalone: true });
      const pdf = await openPdfjs(bytes);
      try {
        const page = await pdf.getPage(1);
        const vp = makeViewport(page, { viewBox: page.view, scale: scale * dpr, rotation: page.rotate });
        await page.render({ canvasContext: ctx, canvas, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
      } finally {
        destroyPdf(pdf);
      }
    } else if (entry.src) {
      const page = await this.session.getRenderPage(entry);
      const vp = makeViewport(page, { viewBox: geom.view, scale: scale * dpr, rotation: geom.rotation });
      // Thumbnails have no form layer: draw fields with their current values.
      await page.render({ canvasContext: ctx, canvas, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE }).promise;
    }
    const bitmap = canvas.transferToImageBitmap();
    if (this.cache.size > 400) {
      const first = this.cache.keys().next().value;
      const old = this.cache.get(first);
      if (old && old.bitmap && old.bitmap.close) old.bitmap.close();
      this.cache.delete(first);
    }
    this.cache.set(key, { bitmap, cssWidth: w, cssHeight: hgt });
    return bitmap;
  }

  clear() {
    for (const v of this.cache.values()) if (v.bitmap && v.bitmap.close) v.bitmap.close();
    this.cache.clear();
    this.queue = [];
  }
}

function paint(canvas, bitmap) {
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
}
