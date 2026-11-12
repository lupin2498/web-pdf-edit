// pdf.js configuration for the renderer.
// The legacy build bundles the polyfills needed by browsers that are a few
// years old.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

// Set by the build (scripts/build.mjs).
const BASE = new URL(__PDFJS_BASE__, document.baseURI).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.mjs';

export { pdfjsLib };

export function openPdfjs(bytes, password, options = null) {
  // pdf.js transfers the buffer to its worker, so always pass a copy.
  const data = bytes.slice();
  const task = pdfjsLib.getDocument({
    data,
    password: password || undefined,
    cMapUrl: BASE + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: BASE + 'standard_fonts/',
    wasmUrl: BASE + 'wasm/',
    iccUrl: BASE + 'iccs/',
    isEvalSupported: false,
    enableXfa: false,
    useSystemFonts: true,
    disableAutoFetch: true,
    verbosity: 0,
    ...(options || {}),
  });
  return task.promise;
}

export function makeViewport(pdfPage, { viewBox, scale = 1, rotation = 0 }) {
  const base = pdfPage.getViewport({ scale: 1 });
  const ViewportClass = base.constructor;
  return new ViewportClass({
    viewBox: viewBox || pdfPage.view,
    userUnit: pdfPage.userUnit || 1,
    scale,
    rotation: ((rotation % 360) + 360) % 360,
    offsetX: 0,
    offsetY: 0,
  });
}

export const CSS_UNITS = 96 / 72;

// pdf.js 6 removed PDFDocumentProxy.destroy(); the loading task owns cleanup.
export function destroyPdf(pdf) {
  if (!pdf) return Promise.resolve();
  try {
    const task = pdf.loadingTask;
    if (task && typeof task.destroy === 'function') return task.destroy().catch(() => {});
    if (typeof pdf.destroy === 'function') return pdf.destroy().catch(() => {});
  } catch {
    /* ignore */
  }
  return Promise.resolve();
}
