// Builds the output PDF from the editing model: page order/rotation/crop,
// content edits (text removal, image edits, redaction), new content objects,
// annotations, form values, bookmarks, metadata and security.
import {
  PDFDocument,
  PDFPage,
  PDFRef,
  PDFDict,
  PDFArray,
  PDFName,
  PDFNumber,
  PDFString,
  PDFHexString,
  PDFStream,
  PDFPageLeaf,
  degrees,
  PDFAcroText,
  PDFAcroCheckBox,
  PDFAcroRadioButton,
  PDFAcroComboBox,
  PDFAcroListBox,
  PDFTextField,
  PDFCheckBox,
  PDFRadioGroup,
  PDFDropdown,
  PDFOptionList,
} from '@cantoo/pdf-lib';
import { N, get, getDict, getArray, resolve, textOf, nameOf, numberOf, refToString, shallowCloneDict } from './pdf-objects.js';
import { applyContentEdits } from './content-editor.js';
import { createAnnotation, addAnnotationToPage, isAnnotationObject, pdfText, pdfDate } from './annotations.js';
import { privatePageResources, ResourceCollector, textBlockOps, imageOps, boxOps } from './graphics.js';
import { DocFontEmbedder, DEFAULT_FAMILY } from './fonts.js';
import { collectGarbage } from './pdf-gc.js';
import { writeOutline, pruneOutline, readOutline } from './outline.js';
import { MARK_TYPES, markOps } from './page-marks.js';

const SRC_TAG = 'PDFEditSrcId';
export const PRODUCER = 'PDF Edit';

export async function loadPdf(bytes, password) {
  const opts = { updateMetadata: false, throwOnInvalidObject: false, warnOnInvalidObjects: false };
  if (password !== undefined && password !== null) opts.password = password;
  try {
    return await PDFDocument.load(bytes, opts);
  } catch (e) {
    if (opts.password === undefined && /encrypt/i.test(String(e && e.message))) {
      // Owner-password-only documents open with the empty user password.
      return PDFDocument.load(bytes, { ...opts, password: '' });
    }
    throw e;
  }
}

function tagAnnotations(doc, pageIndices) {
  const context = doc.context;
  const pages = doc.getPages();
  for (const i of pageIndices) {
    const page = pages[i];
    if (!page) continue;
    const annots = getArray(context, page.node, 'Annots');
    if (!annots) continue;
    for (let k = 0; k < annots.size(); k++) {
      const ref = annots.get(k);
      if (!(ref instanceof PDFRef)) continue;
      const dict = context.lookup(ref);
      if (!(dict instanceof PDFDict)) continue;
      dict.set(N(SRC_TAG), PDFString.of(refToString(ref)));
      // Avoid copying whole donor pages through the optional /P back-reference.
      dict.delete(N('P'));
    }
  }
}

function annotationEntries(context, page) {
  const annots = getArray(context, page.node, 'Annots');
  const out = [];
  if (!annots) return out;
  for (let k = 0; k < annots.size(); k++) {
    const ref = annots.get(k);
    const dict = resolve(context, ref);
    if (!(dict instanceof PDFDict)) continue;
    const tag = dict.get(N(SRC_TAG));
    out.push({ ref, dict, srcId: tag ? textOf(tag) : null, index: k });
  }
  return out;
}

function stripTags(context, pages) {
  for (const page of pages) {
    for (const { dict } of annotationEntries(context, page)) dict.delete(N(SRC_TAG));
  }
}

function inheritAttributes(page) {
  for (const key of PDFPageLeaf.InheritableEntries) {
    const name = N(key);
    if (!page.node.get(name)) {
      const v = page.node.getInheritableAttribute(name);
      if (v) page.node.set(name, v);
    }
  }
}

function privateAnnots(context, page) {
  const node = page.node;
  const existing = resolve(context, node.get(N('Annots')));
  const arr = context.obj([]);
  if (existing instanceof PDFArray) for (let i = 0; i < existing.size(); i++) arr.push(existing.get(i));
  node.set(N('Annots'), arr);
  page.__pePrivateAnnots = true;
  return arr;
}

function getAcroForm(doc, create = false) {
  const context = doc.context;
  let form = getDict(context, doc.catalog, 'AcroForm');
  if (!form && create) {
    form = context.obj({ Fields: [] });
    doc.catalog.set(N('AcroForm'), context.register(form));
  }
  if (form && !getArray(context, form, 'Fields')) form.set(N('Fields'), context.obj([]));
  return form;
}

function rootField(context, dict) {
  let cur = dict;
  let guard = 0;
  while (guard++ < 64) {
    const parent = resolve(context, cur.get(N('Parent')));
    if (!(parent instanceof PDFDict)) break;
    cur = parent;
  }
  return cur;
}

function duplicatePage(doc, page) {
  const context = doc.context;
  inheritAttributes(page);
  const clone = page.node.clone(context);
  const ref = context.register(clone);
  return PDFPage.of(clone, ref, doc);
}

// Pages must not share annotation dictionaries (duplicated pages, repeated
// copies of the same donor page). Shared ones are cloned for later pages.
function ensureUniqueAnnotations(doc, pages) {
  const context = doc.context;
  const seen = new Set();
  let dup = 0;
  for (const page of pages) {
    const annots = getArray(context, page.node, 'Annots');
    if (!annots) continue;
    let changed = false;
    const arr = context.obj([]);
    for (let i = 0; i < annots.size(); i++) {
      const aref = annots.get(i);
      const dict = resolve(context, aref);
      if (!(dict instanceof PDFDict)) continue;
      const tag = aref instanceof PDFRef ? aref.tag : null;
      if (!tag || !seen.has(tag)) {
        if (tag) seen.add(tag);
        arr.push(aref);
        continue;
      }
      changed = true;
      const subtype = nameOf(get(context, dict, 'Subtype'));
      if (subtype === 'Popup') continue;
      const copy = shallowCloneDict(context, dict);
      copy.delete(N('Popup'));
      const copyRef = context.register(copy);
      seen.add(copyRef.tag);
      if (subtype === 'Widget') {
        const parent = resolve(context, dict.get(N('Parent')));
        if (parent instanceof PDFDict) {
          const kids = getArray(context, parent, 'Kids');
          if (kids) kids.push(copyRef);
        } else if (dict.get(N('T'))) {
          const t = textOf(resolve(context, dict.get(N('T')))) || 'field';
          copy.set(N('T'), pdfText(`${t}_${++dup + 1}`));
          const form = getAcroForm(doc, true);
          getArray(context, form, 'Fields').push(copyRef);
        }
      }
      arr.push(copyRef);
    }
    if (changed) {
      page.node.set(N('Annots'), arr);
      page.__pePrivateAnnots = true;
    }
  }
}

function rebuildPageTree(doc, pages) {
  const context = doc.context;
  const pagesRef = doc.catalog.get(N('Pages'));
  const root = context.lookup(pagesRef);
  for (const p of pages) inheritAttributes(p);
  const kids = context.obj(pages.map((p) => p.ref));
  root.set(N('Kids'), kids);
  root.set(N('Count'), PDFNumber.of(pages.length));
  for (const key of PDFPageLeaf.InheritableEntries) root.delete(N(key));
  for (const p of pages) p.node.set(N('Parent'), pagesRef);
  // pdf-lib caches the page list.
  if (doc.pageCache && typeof doc.pageCache.invalidate === 'function') doc.pageCache.invalidate();
  if (doc.pageMap && typeof doc.pageMap.clear === 'function') {
    doc.pageMap.clear();
    for (const p of pages) doc.pageMap.set(p.node, p);
  }
}

// Registers widgets of copied pages in the AcroForm and removes fields whose
// widgets are no longer on any output page.
function mergeFormFields(doc, pages) {
  const context = doc.context;
  const widgetTags = new Set();
  const roots = new Map();
  for (const page of pages) {
    for (const { ref, dict } of annotationEntries(context, page)) {
      if (nameOf(get(context, dict, 'Subtype')) !== 'Widget') continue;
      if (ref instanceof PDFRef) widgetTags.add(ref.tag);
      const root = rootField(context, dict);
      const rootRef = root === dict ? ref : context.getObjectRef(root);
      if (rootRef instanceof PDFRef) roots.set(rootRef.tag, rootRef);
    }
  }
  let form = getAcroForm(doc, false);
  if (!form && !roots.size) return;
  if (!form) form = getAcroForm(doc, true);
  const fields = getArray(context, form, 'Fields');
  const isWidget = (d) => nameOf(get(context, d, 'Subtype')) === 'Widget';
  // Returns true when the node still has widgets on output pages.
  const prune = (ref, depth = 0) => {
    const d = resolve(context, ref);
    if (!(d instanceof PDFDict) || depth > 32) return false;
    const kids = getArray(context, d, 'Kids');
    if (!kids) {
      if (isWidget(d)) return ref instanceof PDFRef && widgetTags.has(ref.tag);
      return true;
    }
    const keep = context.obj([]);
    for (let i = 0; i < kids.size(); i++) {
      const kr = kids.get(i);
      if (prune(kr, depth + 1)) keep.push(kr);
    }
    d.set(N('Kids'), keep);
    return keep.size() > 0 || (isWidget(d) && ref instanceof PDFRef && widgetTags.has(ref.tag));
  };
  const out = context.obj([]);
  const names = new Map();
  const added = new Set();
  const consider = (r) => {
    if (!(r instanceof PDFRef) || added.has(r.tag)) return;
    if (!prune(r)) return;
    const d = resolve(context, r);
    let t = textOf(resolve(context, d.get(N('T'))));
    if (t && names.has(t)) {
      let n = 2;
      while (names.has(`${t}_${n}`)) n++;
      t = `${t}_${n}`;
      d.set(N('T'), pdfText(t));
    }
    if (t) names.set(t, r.tag);
    added.add(r.tag);
    out.push(r);
  };
  for (let i = 0; i < fields.size(); i++) consider(fields.get(i));
  for (const r of roots.values()) consider(r);
  form.set(N('Fields'), out);
  if (out.size()) {
    if (!getDict(context, form, 'DR')) {
      const helv = context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' });
      form.set(N('DR'), context.obj({ Font: context.obj({ Helv: context.register(helv) }) }));
    }
    if (!form.get(N('DA'))) form.set(N('DA'), PDFString.of('/Helv 0 Tf 0 g'));
  }
}

const GEOMETRY_KEYS = ['QuadPoints', 'Vertices', 'L', 'CL'];

function moveAnnotation(context, dict, dx, dy) {
  const rect = getArray(context, dict, 'Rect');
  if (rect) {
    const r = [0, 1, 2, 3].map((i) => numberOf(context, rect.get(i), 0));
    dict.set(N('Rect'), context.obj([r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]));
  }
  for (const key of GEOMETRY_KEYS) {
    const arr = getArray(context, dict, key);
    if (!arr) continue;
    const vals = [];
    for (let i = 0; i < arr.size(); i++) vals.push(numberOf(context, arr.get(i), 0) + (i % 2 === 0 ? dx : dy));
    dict.set(N(key), context.obj(vals));
  }
  const ink = getArray(context, dict, 'InkList');
  if (ink) {
    const paths = [];
    for (let i = 0; i < ink.size(); i++) {
      const p = resolve(context, ink.get(i));
      if (!(p instanceof PDFArray)) continue;
      const vals = [];
      for (let k = 0; k < p.size(); k++) vals.push(numberOf(context, p.get(k), 0) + (k % 2 === 0 ? dx : dy));
      paths.push(vals);
    }
    dict.set(N('InkList'), context.obj(paths));
  }
  const popup = resolve(context, dict.get(N('Popup')));
  if (popup instanceof PDFDict) {
    const pr = getArray(context, popup, 'Rect');
    if (pr) {
      const r = [0, 1, 2, 3].map((i) => numberOf(context, pr.get(i), 0));
      popup.set(N('Rect'), context.obj([r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]));
    }
  }
}

function applyAnnotationEdits(doc, page, edits) {
  if (!edits || !Object.keys(edits).length) return;
  const context = doc.context;
  const entries = annotationEntries(context, page);
  const removeRefs = new Set();
  for (const e of entries) {
    if (!e.srcId || !edits[e.srcId]) continue;
    const edit = edits[e.srcId];
    if (edit.deleted) {
      removeRefs.add(e.ref);
      const popup = e.dict.get(N('Popup'));
      if (popup) removeRefs.add(popup);
      continue;
    }
    if (edit.dx || edit.dy) moveAnnotation(context, e.dict, edit.dx || 0, edit.dy || 0);
    if (edit.contents !== undefined) {
      e.dict.set(N('Contents'), pdfText(edit.contents));
      e.dict.delete(N('RC'));
      e.dict.set(N('M'), PDFString.of(pdfDate()));
    }
  }
  if (removeRefs.size) {
    const arr = privateAnnots(context, page);
    const keep = context.obj([]);
    for (let i = 0; i < arr.size(); i++) {
      const r = arr.get(i);
      let removed = false;
      for (const rr of removeRefs) if (rr === r || (rr instanceof PDFRef && r instanceof PDFRef && rr.tag === r.tag)) removed = true;
      if (!removed) keep.push(r);
    }
    page.node.set(N('Annots'), keep);
  }
}

async function applyFormValues(doc, pages, entriesBySource, formValues, registry, warnings) {
  if (!formValues) return;
  const context = doc.context;
  let font = null;
  const getFont = async () => {
    if (!font) {
      const embedder = new DocFontEmbedder(doc, registry);
      font = await embedder.embed(registry.resolveFace(DEFAULT_FAMILY, false, false).descriptor);
    }
    return font;
  };
  const handledFields = new Set();
  for (let i = 0; i < pages.length; i++) {
    const srcId = entriesBySource[i];
    const values = srcId ? formValues[srcId] : null;
    if (!values) continue;
    for (const e of annotationEntries(context, pages[i])) {
      if (!e.srcId || !(e.srcId in values)) continue;
      const raw = values[e.srcId];
      const value = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
      if (nameOf(get(context, e.dict, 'Subtype')) !== 'Widget') continue;
      // Terminal field: the widget itself when merged, else its parent.
      let fieldDict = e.dict.get(N('T')) || e.dict.get(N('FT')) ? e.dict : resolve(context, e.dict.get(N('Parent')));
      if (!(fieldDict instanceof PDFDict)) continue;
      let ft = nameOf(get(context, fieldDict, 'FT'));
      let cur = fieldDict;
      let guard = 0;
      while (!ft && guard++ < 32) {
        cur = resolve(context, cur.get(N('Parent')));
        if (!(cur instanceof PDFDict)) break;
        ft = nameOf(get(context, cur, 'FT'));
      }
      const fieldRef = context.getObjectRef(fieldDict) || (e.ref instanceof PDFRef ? e.ref : null);
      if (!fieldRef) continue;
      const flags = numberOf(context, fieldDict.get(N('Ff')), 0);
      try {
        if (ft === 'Tx') {
          if (handledFields.has(fieldRef.tag)) continue;
          handledFields.add(fieldRef.tag);
          const field = PDFTextField.of(PDFAcroText.fromDict(fieldDict, fieldRef), fieldRef, doc);
          const text = value == null ? '' : String(value);
          const max = field.getMaxLength();
          field.setText(max !== undefined && text.length > max ? text.slice(0, max) : text);
          field.updateAppearances(await getFont());
        } else if (ft === 'Btn') {
          const isRadio = (flags & (1 << 15)) !== 0;
          const isPush = (flags & (1 << 16)) !== 0;
          if (isPush) continue;
          const ap = getDict(context, e.dict, 'AP');
          const normal = ap ? getDict(context, ap, 'N') : null;
          let onName = null;
          if (normal) for (const [k] of normal.entries()) if (k.decodeText() !== 'Off') onName = k.decodeText();
          if (isRadio) {
            if (value === true || (onName && value === onName)) {
              const group = getArray(context, fieldDict, 'Kids') ? fieldDict : e.dict;
              group.set(N('V'), PDFName.of(onName || 'Off'));
              const kids = getArray(context, group, 'Kids');
              if (kids) {
                for (let k = 0; k < kids.size(); k++) {
                  const kd = resolve(context, kids.get(k));
                  if (kd instanceof PDFDict) kd.set(N('AS'), PDFName.of(kd === e.dict ? onName || 'Off' : 'Off'));
                }
              } else {
                e.dict.set(N('AS'), PDFName.of(onName || 'Off'));
              }
            }
          } else {
            const checked = value === true || value === 'Yes' || (onName && value === onName);
            const v = checked ? onName || 'Yes' : 'Off';
            fieldDict.set(N('V'), PDFName.of(v));
            e.dict.set(N('AS'), PDFName.of(v));
          }
        } else if (ft === 'Ch') {
          if (handledFields.has(fieldRef.tag)) continue;
          handledFields.add(fieldRef.tag);
          const isCombo = (flags & (1 << 17)) !== 0;
          const vals = Array.isArray(value) ? value.map(String) : value == null ? [] : [String(value)];
          if (isCombo) {
            const field = PDFDropdown.of(PDFAcroComboBox.fromDict(fieldDict, fieldRef), fieldRef, doc);
            if (vals.length) field.select(vals[0], true);
            else field.clear();
            field.updateAppearances(await getFont());
          } else {
            const field = PDFOptionList.of(PDFAcroListBox.fromDict(fieldDict, fieldRef), fieldRef, doc);
            if (vals.length) field.select(vals, false);
            else field.clear();
            field.updateAppearances(await getFont());
          }
        }
      } catch (err) {
        warnings.push(`form:${e.srcId}:${err && err.message ? err.message : err}`);
      }
    }
  }
}

async function drawContentObjects(ctx, page, objects, pageCtx = null) {
  const list = objects.filter((o) => !isAnnotationObject(o) && !o.hidden);
  if (!list.length) return;
  const { doc } = ctx;
  const context = doc.context;
  const resources = privatePageResources(context, page);
  const collector = new ResourceCollector(context, resources);
  const over = [];
  const under = [];
  for (const obj of list) {
    if (MARK_TYPES.has(obj.type)) {
      if (!pageCtx) continue;
      const ops = await markOps(obj, pageCtx, {
        getShaper: (font, text) => ctx.registry.getShaper(font?.family, font?.bold, font?.italic, text),
        embedFace: ctx.embedFace,
        embedImage: ctx.embedImage,
        collector,
      });
      if (obj.type === 'background' || obj.layer === 'under') under.push(ops);
      else over.push(ops);
      continue;
    }
    if (obj.type === 'text') {
      const shaper = await ctx.registry.getShaper(obj.font?.family, obj.font?.bold, obj.font?.italic, obj.text || '');
      if (obj.fill) over.push(boxOps(obj.rect, { fill: obj.fill, opacity: obj.opacity ?? 1 }, collector));
      const { ops } = await textBlockOps(obj, shaper, ctx.embedFace, collector);
      over.push(ops);
    } else if (obj.type === 'image') {
      const image = await ctx.embedImage(obj.asset);
      over.push(imageOps(image.ref, obj.rect, obj.rot || 0, collector, obj.opacity ?? 1));
    } else if (obj.type === 'box' || obj.type === 'whiteout') {
      over.push(boxOps(obj.rect, { fill: obj.fill || [1, 1, 1], stroke: obj.stroke || null, width: obj.width || 1, opacity: obj.opacity ?? 1 }, collector));
    }
  }
  if (!over.length && !under.length) return;
  page.node.normalize();
  if (over.length) {
    const stream = context.flateStream(over.join('\n'), {});
    page.node.addContentStream(context.register(stream));
  }
  if (under.length) {
    const stream = context.flateStream(`q\n${under.join('\n')}\nQ`, {});
    const ref = context.register(stream);
    const contents = page.node.Contents();
    if (contents instanceof PDFArray) contents.insert(0, ref);
    else page.node.set(N('Contents'), context.obj([ref]));
  }
}

/**
 * Builds a PDF.
 * opts = {
 *   sources: { [id]: { bytes: Uint8Array, password?: string } },
 *   baseId: string|null,           // keep catalog-level data of this source
 *   pages: [PageEntry],
 *   assets: { get(id) -> {bytes, mime} },
 *   registry: FontRegistry,
 *   formValues: { [sourceId]: { [annotId]: value } },
 *   meta: { title, author, subject, keywords } | null,
 *   outline: undefined | [{title, pageUid, children, open}] (replaces outline),
 *   security: null | { userPassword, ownerPassword, permissions },
 *   author: string,
 *   onProgress(fraction),
 *   loadedDocs: Map (optional cache of loaded documents — they will be mutated!)
 * }
 * Returns { bytes, warnings }
 */
export async function buildPdf(opts) {
  const { sources, pages: entries, assets, registry } = opts;
  const warnings = [];
  const loaded = new Map();
  const loadSource = async (id) => {
    if (!loaded.has(id) && opts.loadedDocs && opts.loadedDocs.has(id) && id !== opts.baseId) {
      loaded.set(id, opts.loadedDocs.get(id));
    }
    if (!loaded.has(id)) {
      const src = sources[id];
      if (!src) throw new Error(`Missing source ${id}`);
      loaded.set(id, loadPdf(src.bytes, src.password));
    }
    return loaded.get(id);
  };

  let base;
  let baseId = opts.baseId;
  if (baseId && sources[baseId]) {
    base = await loadSource(baseId);
  } else {
    baseId = null;
    base = await PDFDocument.create({ updateMetadata: false });
  }

  // Tag annotations of used pages so edits/form values can be mapped after copying.
  const usedBySource = new Map();
  for (const e of entries) {
    if (!e.src) continue;
    if (!usedBySource.has(e.src.doc)) usedBySource.set(e.src.doc, new Set());
    usedBySource.get(e.src.doc).add(e.src.index);
  }
  for (const [id, set] of usedBySource) {
    const d = await loadSource(id);
    tagAnnotations(d, [...set]);
  }

  const basePages = base.getPages();
  const finalPages = new Array(entries.length);
  const usedBase = new Set();
  const copyRequests = new Map();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.src && e.src.doc === baseId) {
      const p = basePages[e.src.index];
      if (!p) throw new Error(`Page ${e.src.index + 1} not found`);
      if (!usedBase.has(e.src.index)) {
        usedBase.add(e.src.index);
        finalPages[i] = p;
      } else {
        finalPages[i] = duplicatePage(base, p);
      }
    } else if (e.src) {
      if (!copyRequests.has(e.src.doc)) copyRequests.set(e.src.doc, []);
      copyRequests.get(e.src.doc).push({ i, index: e.src.index });
    } else {
      const size = e.blank || { width: 595.28, height: 841.89 };
      const p = PDFPage.create(base);
      p.setSize(size.width, size.height);
      p.node.set(N('Resources'), base.context.obj({}));
      finalPages[i] = p;
    }
  }
  for (const [srcId, reqs] of copyRequests) {
    const srcDoc = await loadSource(srcId);
    const count = srcDoc.getPageCount();
    for (const r of reqs) if (r.index >= count) throw new Error(`Page ${r.index + 1} not found`);
    const copied = await base.copyPages(srcDoc, reqs.map((r) => r.index));
    reqs.forEach((r, k) => {
      finalPages[r.i] = copied[k];
    });
  }

  ensureUniqueAnnotations(base, finalPages);
  // Fix annotation /P back-references.
  for (const p of finalPages) {
    for (const { dict } of annotationEntries(base.context, p)) dict.set(N('P'), p.ref);
  }

  const embedder = new DocFontEmbedder(base, registry);
  const imageCache = new Map();
  const embedImage = async (assetId) => {
    if (!imageCache.has(assetId)) {
      imageCache.set(
        assetId,
        (async () => {
          const asset = await assets.get(assetId);
          if (!asset) throw new Error(`Missing image asset ${assetId}`);
          const bytes = asset.bytes instanceof Uint8Array ? asset.bytes : new Uint8Array(asset.bytes);
          return /jpe?g/i.test(asset.mime || '') ? base.embedJpg(bytes) : base.embedPng(bytes);
        })(),
      );
    }
    return imageCache.get(assetId);
  };
  const pageRefByUid = new Map();
  entries.forEach((e, i) => pageRefByUid.set(e.uid, finalPages[i].ref));
  const ctx = {
    doc: base,
    registry,
    embedFace: (d) => embedder.embed(d),
    embedImage,
    author: opts.author || '',
    pageRefFor: (uid) => pageRefByUid.get(uid) || null,
  };

  const entrySource = entries.map((e) => (e.src ? e.src.doc : null));
  const total = entries.length || 1;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const page = finalPages[i];
    // 1. Content edits on the original content.
    const removals = e.removals || [];
    const textRegions = removals.filter((r) => r.kind !== 'redact' && r.kind !== 'artifact' && r.region).map((r) => r.region);
    const redactRegions = removals.filter((r) => r.kind === 'redact').map((r) => r.region);
    const removeArtifacts = [...new Set(removals.filter((r) => r.kind === 'artifact').flatMap((r) => r.subtypes || []))];
    const imageEdits = [];
    for (const ie of e.imageEdits || []) {
      const edit = { path: ie.path, action: ie.action, matrix: ie.matrix };
      if (ie.action === 'replace' && ie.asset) edit.replacementRef = (await embedImage(ie.asset)).ref;
      imageEdits.push(edit);
    }
    if (textRegions.length || redactRegions.length || imageEdits.length || removeArtifacts.length) {
      try {
        const stats = await applyContentEdits(base, page, {
          removeTextRegions: textRegions,
          redactRegions,
          imageEdits,
          removeArtifacts,
          imageReplacer: opts.imageReplacer ? (img, regions) => opts.imageReplacer(base, img, regions) : null,
        });
        for (const pi of stats.partialImages) if (!pi.handled) warnings.push(`redact-partial-image:${i + 1}`);
      } catch (err) {
        warnings.push(`content-edit:${i + 1}:${err && err.message ? err.message : err}`);
      }
    }
    // 2. Rotation and crop.
    if (e.rotate) page.setRotation(degrees((((page.getRotation().angle + e.rotate) % 360) + 360) % 360));
    if (e.crop) {
      const mb = page.getMediaBox();
      const x0 = Math.max(mb.x, Math.min(e.crop[0], e.crop[2]));
      const y0 = Math.max(mb.y, Math.min(e.crop[1], e.crop[3]));
      const x1 = Math.min(mb.x + mb.width, Math.max(e.crop[0], e.crop[2]));
      const y1 = Math.min(mb.y + mb.height, Math.max(e.crop[1], e.crop[3]));
      if (x1 - x0 > 1 && y1 - y0 > 1) {
        page.setCropBox(x0, y0, x1 - x0, y1 - y0);
        page.node.delete(N('TrimBox'));
        page.node.delete(N('ArtBox'));
        page.node.delete(N('BleedBox'));
      }
    }
    // 3. Existing annotation edits.
    try {
      applyAnnotationEdits(base, page, e.annotEdits);
    } catch (err) {
      warnings.push(`annot-edit:${i + 1}:${err && err.message ? err.message : err}`);
    }
    // 4. New content objects (sorted so redaction boxes are on top).
    const objects = (e.objects || []).slice();
    const cb = page.getCropBox();
    const pageCtx = {
      view: [cb.x, cb.y, cb.x + cb.width, cb.y + cb.height],
      rotation: page.getRotation().angle,
      pageNumber: i + 1,
      pageCount: entries.length,
      fileName: opts.fileName || '',
      date: new Date(),
    };
    await drawContentObjects(ctx, page, objects, pageCtx);
    // 5. Annotations.
    for (const obj of objects) {
      if (!isAnnotationObject(obj) || obj.hidden) continue;
      if (obj.type === 'redact' && obj.applied) continue;
      try {
        const ref = await createAnnotation(ctx, page, obj);
        if (ref) addAnnotationToPage(base, page, ref);
      } catch (err) {
        warnings.push(`annotation:${obj.type}:${err && err.message ? err.message : err}`);
      }
    }
    if (opts.onProgress) opts.onProgress((i + 1) / total);
  }

  await applyFormValues(base, finalPages, entrySource, opts.formValues, registry, warnings);
  stripTags(base.context, finalPages);
  rebuildPageTree(base, finalPages);
  mergeFormFields(base, finalPages);

  // Bookmarks.
  if (opts.outline !== undefined) {
    const toItems = (list) =>
      (list || []).map((it) => ({
        title: it.title,
        pageRef: it.pageUid ? pageRefByUid.get(it.pageUid) || null : null,
        children: toItems(it.children),
        open: !!it.open,
      }));
    writeOutline(base, toItems(opts.outline));
  } else if (baseId) {
    try {
      pruneOutline(base, new Set(finalPages.map((p) => p.ref.tag)));
    } catch (err) {
      warnings.push(`outline:${err && err.message ? err.message : err}`);
    }
  }

  // Metadata.
  const meta = opts.meta || {};
  if (meta.title !== undefined) base.setTitle(meta.title || '');
  if (meta.author !== undefined) base.setAuthor(meta.author || '');
  if (meta.subject !== undefined) base.setSubject(meta.subject || '');
  if (meta.keywords !== undefined) base.setKeywords((meta.keywords || '').split(/[,;]\s*/).filter(Boolean));
  base.setProducer(PRODUCER);
  base.setModificationDate(new Date());
  if (!baseId) {
    base.setCreator(PRODUCER);
    base.setCreationDate(new Date());
  }

  collectGarbage(base);

  const sec = opts.security;
  if (sec && (sec.userPassword || sec.ownerPassword)) {
    const perms = sec.permissions || {};
    base.encrypt({
      userPassword: sec.userPassword || '',
      ownerPassword: sec.ownerPassword || sec.userPassword || randomPassword(),
      permissions: {
        printing: perms.printing === false ? undefined : 'highResolution',
        modifying: perms.modifying !== false,
        copying: perms.copying !== false,
        annotating: perms.annotating !== false,
        fillingForms: perms.fillingForms !== false,
        contentAccessibility: true,
        documentAssembly: perms.documentAssembly !== false,
      },
    });
  }
  const bytes = await base.save({ useObjectStreams: true, updateFieldAppearances: false, addDefaultPage: false });
  return { bytes, warnings };
}

function randomPassword() {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const rnd = globalThis.crypto && globalThis.crypto.getRandomValues ? globalThis.crypto.getRandomValues(new Uint32Array(24)) : null;
  for (let i = 0; i < 24; i++) s += chars[(rnd ? rnd[i] : Math.floor(Math.random() * 1e9)) % chars.length];
  return s;
}

/**
 * Builds a single-page preview document with content edits (text removal,
 * image edits, applied redactions) and existing-annotation edits applied.
 */
export async function buildPagePreview({ sourceBytes, password, pageIndex, entry, assets, cache }) {
  let src = cache && cache.get('doc');
  if (!src) {
    src = await loadPdf(sourceBytes, password);
    if (cache) cache.set('doc', src);
  }
  const out = await PDFDocument.create({ updateMetadata: false });
  tagAnnotations(src, [pageIndex]);
  const [page] = await out.copyPages(src, [pageIndex]);
  out.addPage(page);
  const removals = entry.removals || [];
  const imageEdits = [];
  for (const ie of entry.imageEdits || []) {
    const edit = { path: ie.path, action: ie.action, matrix: ie.matrix };
    if (ie.action === 'replace' && ie.asset) {
      const asset = await assets.get(ie.asset);
      const img = /jpe?g/i.test(asset.mime || '') ? await out.embedJpg(asset.bytes) : await out.embedPng(asset.bytes);
      edit.replacementRef = img.ref;
    }
    imageEdits.push(edit);
  }
  await applyContentEdits(out, page, {
    removeTextRegions: removals.filter((r) => r.kind !== 'redact' && r.kind !== 'artifact' && r.region).map((r) => r.region),
    redactRegions: removals.filter((r) => r.kind === 'redact').map((r) => r.region),
    removeArtifacts: [...new Set(removals.filter((r) => r.kind === 'artifact').flatMap((r) => r.subtypes || []))],
    imageEdits,
  });
  applyAnnotationEdits(out, page, entry.annotEdits);
  // Keep tags so the viewer can map annotations back to source ids.
  return out.save({ useObjectStreams: false, updateFieldAppearances: false });
}

export { readOutline };
