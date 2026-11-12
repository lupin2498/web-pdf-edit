// Removes objects that are no longer reachable from the trailer (e.g. pages
// that were deleted) so saved files do not keep dead data.
import { PDFRef, PDFDict, PDFArray, PDFStream } from '@cantoo/pdf-lib';

export function collectGarbage(doc, extraRoots = []) {
  const ctx = doc.context;
  const seen = new Set();
  const stack = [];
  const t = ctx.trailerInfo;
  for (const r of [t.Root, t.Info, t.Encrypt, ...extraRoots]) if (r) stack.push(r);
  while (stack.length) {
    const o = stack.pop();
    if (o instanceof PDFRef) {
      if (seen.has(o.tag)) continue;
      seen.add(o.tag);
      const v = ctx.lookup(o);
      if (v) stack.push(v);
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) stack.push(v);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) stack.push(o.get(i));
    } else if (o instanceof PDFStream) {
      stack.push(o.dict);
    }
  }
  let removed = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(ref.tag)) {
      ctx.delete(ref);
      removed++;
    }
  }
  return removed;
}
