// Flattening: draws annotation appearances and form fields into page content.
import { PDFDict, PDFArray, PDFStream, PDFName, PDFRef } from '@cantoo/pdf-lib';
import { N, get, getDict, getArray, resolve, nameOf, numberOf } from './pdf-objects.js';
import { transformRect, rectToRectMatrix } from './matrix.js';
import { privatePageResources, ResourceCollector, matrixStr } from './graphics.js';

const SKIP = new Set(['Popup', 'Link', 'Widget']);
const HIDDEN = 2;
const NOVIEW = 32;

function appearanceStream(context, annot) {
  const ap = getDict(context, annot, 'AP');
  if (!ap) return null;
  const n = get(context, ap, 'N');
  if (n instanceof PDFStream) return ap.get(N('N'));
  if (n instanceof PDFDict) {
    const as = nameOf(get(context, annot, 'AS'));
    if (as && n.get(N(as))) return n.get(N(as));
  }
  return null;
}

export function flattenAnnotations(doc, { includeForms = false, onlyForms = false } = {}) {
  const context = doc.context;
  let count = 0;
  for (const page of doc.getPages()) {
    const annots = getArray(context, page.node, 'Annots');
    if (!annots) continue;
    const keep = context.obj([]);
    const ops = [];
    let collector = null;
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      const annot = resolve(context, ref);
      if (!(annot instanceof PDFDict)) continue;
      const subtype = nameOf(get(context, annot, 'Subtype'));
      if (onlyForms && subtype !== 'Widget') {
        keep.push(ref);
        continue;
      }
      if (subtype === 'Popup') continue;
      if (SKIP.has(subtype) && !(includeForms && subtype === 'Widget')) {
        keep.push(ref);
        continue;
      }
      const flags = numberOf(context, annot.get(N('F')), 0);
      if (flags & (HIDDEN | NOVIEW)) continue;
      const apRef = appearanceStream(context, annot);
      const ap = resolve(context, apRef);
      if (!(ap instanceof PDFStream)) {
        if (subtype === 'Widget') keep.push(ref);
        continue;
      }
      const rectArr = getArray(context, annot, 'Rect');
      const bboxArr = getArray(context, ap.dict, 'BBox');
      if (!rectArr || !bboxArr) continue;
      const rect = [0, 1, 2, 3].map((k) => numberOf(context, rectArr.get(k), 0));
      const bbox = [0, 1, 2, 3].map((k) => numberOf(context, bboxArr.get(k), 0));
      const mArr = getArray(context, ap.dict, 'Matrix');
      const matrix = mArr ? [0, 1, 2, 3, 4, 5].map((k) => numberOf(context, mArr.get(k), k === 0 || k === 3 ? 1 : 0)) : [1, 0, 0, 1, 0, 0];
      const tb = transformRect(matrix, bbox);
      if (tb[2] - tb[0] <= 0 || tb[3] - tb[1] <= 0) continue;
      const nr = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
      const A = rectToRectMatrix(tb, nr);
      if (!collector) collector = new ResourceCollector(context, privatePageResources(context, page));
      const key = collector.xobject(apRef instanceof PDFRef ? apRef : context.register(ap));
      ops.push(`q ${matrixStr(A)} cm /${key} Do Q`);
      count++;
    }
    if (ops.length) {
      page.node.normalize();
      page.node.addContentStream(context.register(context.flateStream(ops.join('\n'), {})));
    }
    page.node.set(N('Annots'), keep);
  }
  if (includeForms) {
    const form = getDict(context, doc.catalog, 'AcroForm');
    if (form) doc.catalog.delete(N('AcroForm'));
  }
  return count;
}

export { PDFName, PDFArray };
