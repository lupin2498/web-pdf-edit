// Reading and writing document outlines (bookmarks).
import { PDFDict, PDFArray, PDFRef, PDFName, PDFString, PDFHexString, PDFNumber } from '@cantoo/pdf-lib';
import { N, get, getDict, getArray, resolve, textOf, nameOf } from './pdf-objects.js';
import { pdfText } from './annotations.js';

function nameTreeLookup(context, node, key, depth = 0) {
  if (!(node instanceof PDFDict) || depth > 32) return undefined;
  const names = getArray(context, node, 'Names');
  if (names) {
    for (let i = 0; i + 1 < names.size(); i += 2) {
      const k = resolve(context, names.get(i));
      if (textOf(k) === key) return resolve(context, names.get(i + 1));
    }
  }
  const kids = getArray(context, node, 'Kids');
  if (kids) {
    for (let i = 0; i < kids.size(); i++) {
      const kid = resolve(context, kids.get(i));
      const limits = getArray(context, kid, 'Limits');
      if (limits && limits.size() === 2) {
        const lo = textOf(resolve(context, limits.get(0)));
        const hi = textOf(resolve(context, limits.get(1)));
        if (lo !== undefined && hi !== undefined && (key < lo || key > hi)) continue;
      }
      const found = nameTreeLookup(context, kid, key, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export function resolveDestination(doc, dest) {
  const context = doc.context;
  let d = resolve(context, dest);
  const catalog = doc.catalog;
  if (d instanceof PDFName || d instanceof PDFString || d instanceof PDFHexString) {
    const key = d instanceof PDFName ? nameOf(d) : textOf(d);
    const dests = getDict(context, catalog, 'Dests');
    let found = dests ? get(context, dests, key) : undefined;
    if (!found) {
      const names = getDict(context, catalog, 'Names');
      const tree = names ? getDict(context, names, 'Dests') : undefined;
      found = tree ? nameTreeLookup(context, tree, key) : undefined;
    }
    d = resolve(context, found);
    if (d instanceof PDFDict) d = get(context, d, 'D');
  }
  if (d instanceof PDFArray && d.size() > 0) {
    const target = d.get(0);
    return target instanceof PDFRef ? target : null;
  }
  return null;
}

export function readOutline(doc) {
  const context = doc.context;
  const outlines = getDict(context, doc.catalog, 'Outlines');
  if (!outlines) return [];
  const pageIndexByRef = new Map();
  doc.getPages().forEach((p, i) => pageIndexByRef.set(p.ref.tag, i));
  const seen = new Set();
  const readLevel = (first, depth) => {
    const items = [];
    let node = first;
    let guard = 0;
    while (node && guard++ < 10000) {
      const ref = node instanceof PDFRef ? node : null;
      if (ref) {
        if (seen.has(ref.tag)) break;
        seen.add(ref.tag);
      }
      const dict = resolve(context, node);
      if (!(dict instanceof PDFDict)) break;
      const title = textOf(resolve(context, dict.get(N('Title')))) || '';
      let destObj = dict.get(N('Dest'));
      if (!destObj) {
        const action = getDict(context, dict, 'A');
        if (action && nameOf(get(context, action, 'S')) === 'GoTo') destObj = action.get(N('D'));
      }
      let pageIndex = -1;
      if (destObj) {
        try {
          const pageRef = resolveDestination(doc, destObj);
          if (pageRef && pageIndexByRef.has(pageRef.tag)) pageIndex = pageIndexByRef.get(pageRef.tag);
        } catch {
          pageIndex = -1;
        }
      }
      const count = get(context, dict, 'Count');
      const children = depth < 30 ? readLevel(dict.get(N('First')), depth + 1) : [];
      items.push({ title, pageIndex, children, open: count instanceof PDFNumber ? count.asNumber() > 0 : false });
      node = dict.get(N('Next'));
    }
    return items;
  };
  return readLevel(outlines.get(N('First')), 0);
}

/**
 * items: [{title, pageRef: PDFRef|null, children, open}]
 */
export function writeOutline(doc, items) {
  const context = doc.context;
  const catalog = doc.catalog;
  if (!items || !items.length) {
    catalog.delete(N('Outlines'));
    return;
  }
  const rootRef = context.nextRef();
  const build = (list, parentRef) => {
    const refs = list.map(() => context.nextRef());
    let total = 0;
    list.forEach((item, i) => {
      const dict = context.obj({});
      dict.set(N('Title'), pdfText(item.title || ''));
      dict.set(N('Parent'), parentRef);
      if (i > 0) dict.set(N('Prev'), refs[i - 1]);
      if (i < list.length - 1) dict.set(N('Next'), refs[i + 1]);
      if (item.pageRef) dict.set(N('Dest'), context.obj([item.pageRef, PDFName.of('XYZ'), null, null, null]));
      let count = 0;
      if (item.children && item.children.length) {
        const sub = build(item.children, refs[i]);
        dict.set(N('First'), sub.refs[0]);
        dict.set(N('Last'), sub.refs[sub.refs.length - 1]);
        count = sub.total;
        dict.set(N('Count'), PDFNumber.of(item.open ? count : -count));
      }
      context.assign(refs[i], dict);
      total += 1 + (item.open ? count : 0);
    });
    return { refs, total };
  };
  const top = build(items, rootRef);
  const root = context.obj({ Type: 'Outlines', First: top.refs[0], Last: top.refs[top.refs.length - 1], Count: PDFNumber.of(top.total) });
  context.assign(rootRef, root);
  catalog.set(N('Outlines'), rootRef);
}

// Removes outline entries pointing at pages that are no longer in the document.
export function pruneOutline(doc, validPageTags) {
  const items = readOutlineWithRefs(doc);
  if (!items) return;
  const hasInvalid = (list) => list.some((it) => (it.pageRef && !validPageTags.has(it.pageRef.tag)) || hasInvalid(it.children));
  if (!hasInvalid(items)) return;
  const filter = (list) =>
    list.flatMap((it) => {
      const children = filter(it.children);
      if (it.pageRef && !validPageTags.has(it.pageRef.tag)) return children;
      return [{ ...it, children }];
    });
  writeOutline(doc, filter(items));
}

function readOutlineWithRefs(doc) {
  const context = doc.context;
  const outlines = getDict(context, doc.catalog, 'Outlines');
  if (!outlines) return null;
  const seen = new Set();
  const readLevel = (first, depth) => {
    const items = [];
    let node = first;
    let guard = 0;
    while (node && guard++ < 10000) {
      if (node instanceof PDFRef) {
        if (seen.has(node.tag)) break;
        seen.add(node.tag);
      }
      const dict = resolve(context, node);
      if (!(dict instanceof PDFDict)) break;
      const title = textOf(resolve(context, dict.get(N('Title')))) || '';
      let destObj = dict.get(N('Dest'));
      if (!destObj) {
        const action = getDict(context, dict, 'A');
        if (action && nameOf(get(context, action, 'S')) === 'GoTo') destObj = action.get(N('D'));
      }
      let pageRef = null;
      try {
        pageRef = destObj ? resolveDestination(doc, destObj) : null;
      } catch {
        pageRef = null;
      }
      const count = get(context, dict, 'Count');
      items.push({
        title,
        pageRef,
        children: depth < 30 ? readLevel(dict.get(N('First')), depth + 1) : [],
        open: count instanceof PDFNumber ? count.asNumber() > 0 : false,
      });
      node = dict.get(N('Next'));
    }
    return items;
  };
  return readLevel(outlines.get(N('First')), 0);
}

export { readOutlineWithRefs };
