// Rewrites page content streams: removes glyphs inside regions (text editing
// and redaction), deletes/transforms/replaces images and removes vector paths.
// Shared objects are never mutated: modified streams and resource
// dictionaries are cloned (copy-on-write).
import { PDFStream, PDFDict, PDFRef } from '@cantoo/pdf-lib';
import { PdfName, PdfString, serializeValue, buildContentStream, formatNumber } from './content-stream.js';
import { interpretContent } from './interpreter.js';
import { FontInfoCache } from './font-info.js';
import { multiply, invert, rectContainsPoint, rectContainsRect, rectsIntersect, intersectionRect } from './matrix.js';
import { N, get, getDict, resolve, pageContentBytes, shallowCloneDict } from './pdf-objects.js';

export function analyzePageContent(doc, page, { collectPaths = true } = {}) {
  const context = doc.context;
  const bytes = pageContentBytes(context, page.node);
  const resources = page.node.Resources ? page.node.Resources() : getDict(context, page.node, 'Resources');
  return interpretContent({
    context,
    bytes,
    resources,
    fontCache: new FontInfoCache(context),
    collectPaths,
  });
}

function pointInRegions(regions, x, y) {
  for (const r of regions) if (rectContainsPoint(r, x, y)) return true;
  return false;
}

// Builds the replacement TJ elements for a run with some glyphs removed.
function buildRunElements(run, removeFlags) {
  const fs = run.fontSize;
  const th = run.th;
  if (!fs || (!run.vertical && !th)) return null;
  const out = [];
  let pending = 0;
  const flushNum = () => {
    if (Math.abs(pending) > 1e-6) out.push(Math.round(pending * 1000) / 1000);
    pending = 0;
  };
  let gi = 0;
  for (let ei = 0; ei < run.elements.length; ei++) {
    const el = run.elements[ei];
    if (typeof el === 'number') {
      pending += el;
      continue;
    }
    if (!(el instanceof PdfString)) continue;
    let segStart = -1;
    let segEnd = -1;
    const flushSeg = () => {
      if (segStart >= 0) {
        flushNum();
        out.push(new PdfString(el.bytes.slice(segStart, segEnd), true));
        segStart = -1;
      }
    };
    while (gi < run.glyphs.length && run.glyphs[gi].ei === ei) {
      const g = run.glyphs[gi];
      if (removeFlags[gi]) {
        flushSeg();
        pending += run.vertical ? -(g.adv / fs) * 1000 : -(g.adv / (fs * th)) * 1000;
      } else {
        if (segStart < 0) segStart = g.pos;
        segEnd = g.pos + g.len;
      }
      gi++;
    }
    flushSeg();
  }
  flushNum();
  return out;
}

function runReplacementItems(run, op, elements) {
  const items = [];
  if (op.op === "'") items.push('T*');
  if (op.op === '"') {
    items.push(`${formatNumber(typeof op.args[0] === 'number' ? op.args[0] : 0)} Tw`);
    items.push(`${formatNumber(typeof op.args[1] === 'number' ? op.args[1] : 0)} Tc`);
    items.push('T*');
  }
  items.push(serializeValue(elements) + ' TJ');
  return items;
}

class ModTree {
  constructor() {
    this.map = new Map(); // opIndex -> {replace: items[]} | {form: ModTree} | {wrap: {before, after}}
  }
  at(path) {
    let tree = this;
    for (let i = 0; i < path.length - 1; i++) {
      let entry = tree.map.get(path[i]);
      if (!entry || !entry.form) {
        entry = { form: new ModTree() };
        tree.map.set(path[i], entry);
      }
      tree = entry.form;
    }
    return { tree, index: path[path.length - 1] };
  }
  setReplace(path, items) {
    const { tree, index } = this.at(path);
    tree.map.set(index, { replace: items });
  }
  setWrap(path, before, after, newName) {
    const { tree, index } = this.at(path);
    tree.map.set(index, { wrap: { before, after, newName } });
  }
  has(path) {
    let tree = this;
    for (let i = 0; i < path.length - 1; i++) {
      const entry = tree.map.get(path[i]);
      if (!entry || !entry.form) return false;
      tree = entry.form;
    }
    return tree.map.has(path[path.length - 1]);
  }
  get size() {
    return this.map.size;
  }
}

function uniqueKey(dict, base) {
  let i = 1;
  let name = base;
  while (dict.has(N(name))) name = `${base}${i++}`;
  return name;
}

function cloneResourcesWithXObject(context, resources) {
  const res = resources ? shallowCloneDict(context, resources) : context.obj({});
  const xo = getDict(context, res, 'XObject');
  const newXo = xo ? shallowCloneDict(context, xo) : context.obj({});
  res.set(N('XObject'), newXo);
  return { res, xobj: newXo };
}

function findForm(model, opIndex) {
  return model.forms.find((f) => f.opIndex === opIndex);
}

function rewriteModel(context, model, tree, state) {
  let resources = model.resources;
  let xobj = null;
  const ensureXObjectDict = () => {
    if (!xobj) {
      const cloned = cloneResourcesWithXObject(context, resources);
      resources = cloned.res;
      xobj = cloned.xobj;
    }
    return xobj;
  };
  const items = [];
  for (let i = 0; i < model.ops.length; i++) {
    const entry = tree.map.get(i);
    const op = model.ops[i];
    if (!entry) {
      items.push(op);
      continue;
    }
    if (entry.replace) {
      for (const it of entry.replace) items.push(it);
      continue;
    }
    if (entry.wrap) {
      if (entry.wrap.before) items.push(entry.wrap.before);
      if (entry.wrap.newName) {
        const dict = ensureXObjectDict();
        const key = uniqueKey(dict, entry.wrap.newName.base);
        dict.set(N(key), entry.wrap.newName.ref);
        items.push(serializeValue(new PdfName(key)) + ' Do');
      } else {
        items.push(op);
      }
      if (entry.wrap.after) items.push(entry.wrap.after);
      continue;
    }
    if (entry.form) {
      const form = findForm(model, i);
      if (!form || !form.model) {
        items.push(op);
        continue;
      }
      const sub = rewriteModel(context, form.model, entry.form, state);
      const dictObj = {};
      for (const [k, v] of form.stream.dict.entries()) {
        const key = k.decodeText();
        if (key === 'Length' || key === 'Filter' || key === 'DecodeParms') continue;
        dictObj[key] = v;
      }
      const newStream = context.flateStream(sub.bytes, {});
      for (const [k, v] of Object.entries(dictObj)) newStream.dict.set(N(k), v);
      if (sub.resources) newStream.dict.set(N('Resources'), sub.resources);
      const newRef = context.register(newStream);
      const dict = ensureXObjectDict();
      const key = uniqueKey(dict, `${form.name}e`);
      dict.set(N(key), newRef);
      items.push(serializeValue(new PdfName(key)) + ' Do');
      state.formsRewritten++;
      continue;
    }
    items.push(op);
  }
  return { bytes: buildContentStream(items, model.bytes), resources };
}

/**
 * Computes glyph removal for a set of regions.
 * Returns number of removed glyphs. Adds modifications into `tree`.
 */
function planTextRemoval(model, regions, tree, prefix = [], stats, filter) {
  for (const run of model.textRuns) {
    if (!run.glyphs.length || !run.bbox) continue;
    let any = false;
    const flags = new Array(run.glyphs.length);
    for (let gi = 0; gi < run.glyphs.length; gi++) {
      const g = run.glyphs[gi];
      const inside = pointInRegions(regions, g.cx, g.cy) && (!filter || filter(run, g));
      flags[gi] = inside;
      if (inside) any = true;
    }
    if (!any) continue;
    const elements = buildRunElements(run, flags);
    if (!elements) continue;
    const op = model.ops[run.opIndex];
    tree.setReplace([...prefix, run.opIndex], runReplacementItems(run, op, elements));
    stats.glyphsRemoved += flags.filter(Boolean).length;
  }
  for (const f of model.forms) {
    if (f.model) planTextRemoval(f.model, regions, tree, [...prefix, f.opIndex], stats, filter);
  }
}

function planImageRedaction(model, regions, tree, prefix, stats) {
  for (const img of model.images) {
    let covered = false;
    let partial = false;
    for (const r of regions) {
      if (rectContainsRect(r, img.bbox, 0.5)) covered = true;
      else if (rectsIntersect(r, img.bbox)) partial = true;
    }
    if (covered) {
      tree.setReplace([...prefix, img.opIndex], []);
      stats.imagesRemoved++;
    } else if (partial) {
      stats.partialImages.push({ image: img, path: [...prefix, img.opIndex] });
    }
  }
  for (const f of model.forms) {
    if (f.model) planImageRedaction(f.model, regions, tree, [...prefix, f.opIndex], stats);
  }
}

// Removes marked-content sequences such as /Artifact <</Subtype /Watermark>>.
function planArtifactRemoval(model, subtypes, tree, prefix, stats) {
  const wanted = new Set(subtypes);
  const ranges = model.marked
    .filter((m) => m.tag === 'Artifact' && m.props && wanted.has(m.props.Subtype))
    .sort((a, b) => a.startOp - b.startOp);
  let lastEnd = -1;
  for (const r of ranges) {
    if (r.startOp <= lastEnd) continue;
    for (let k = r.startOp; k <= r.endOp; k++) tree.setReplace([...prefix, k], []);
    lastEnd = r.endOp;
    stats.artifactsRemoved++;
  }
  for (const f of model.forms) {
    if (f.model && !tree.has([...prefix, f.opIndex])) planArtifactRemoval(f.model, subtypes, tree, [...prefix, f.opIndex], stats);
  }
}

const PATH_OPS = new Set(['m', 'l', 'c', 'v', 'y', 're', 'h', 'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n']);

function planPathRedaction(model, regions, tree, prefix, stats) {
  for (const p of model.paths) {
    if (p.startOp < 0) continue;
    let covered = false;
    for (const r of regions) if (rectContainsRect(r, p.bbox, 0.5)) covered = true;
    if (!covered) continue;
    let clean = true;
    for (let k = p.startOp; k <= p.endOp; k++) {
      if (!PATH_OPS.has(model.ops[k].op) || tree.has([...prefix, k])) {
        clean = false;
        break;
      }
    }
    if (!clean) continue;
    for (let k = p.startOp; k <= p.endOp; k++) tree.setReplace([...prefix, k], []);
    stats.pathsRemoved++;
  }
  for (const f of model.forms) {
    if (f.model) planPathRedaction(f.model, regions, tree, [...prefix, f.opIndex], stats);
  }
}

function getOpAtPath(model, path) {
  let m = model;
  for (let i = 0; i < path.length - 1; i++) {
    const f = findForm(m, path[i]);
    if (!f || !f.model) return null;
    m = f.model;
  }
  return { model: m, op: m.ops[path[path.length - 1]] };
}

function findImageByPath(model, path) {
  const found = getOpAtPath(model, path);
  if (!found) return null;
  return found.model.images.find((im) => im.opIndex === path[path.length - 1]) || null;
}

function matrixToCm(m) {
  return m.map((v) => formatNumber(Math.round(v * 100000) / 100000)).join(' ') + ' cm';
}

/**
 * Applies content edits to a page (PDFPage from pdf-lib).
 * edits = {
 *   removeTextRegions: [[x0,y0,x1,y1], ...],
 *   redactRegions: [[x0,y0,x1,y1], ...],   // text + images + covered paths
 *   imageEdits: [{ path, action: 'delete'|'transform'|'replace', matrix?, replacementRef? }],
 *   imageReplacer: optional async (image, regionsInUserSpace) => PDFRef|null for partial redaction
 * }
 * Returns stats.
 */
export async function applyContentEdits(doc, page, edits, model = null) {
  const context = doc.context;
  const stats = { glyphsRemoved: 0, imagesRemoved: 0, pathsRemoved: 0, partialImages: [], formsRewritten: 0, imagesEdited: 0, artifactsRemoved: 0 };
  const removeRegions = (edits.removeTextRegions || []).filter(Boolean);
  const redactRegions = (edits.redactRegions || []).filter(Boolean);
  const imageEdits = edits.imageEdits || [];
  const artifacts = edits.removeArtifacts || [];
  if (!removeRegions.length && !redactRegions.length && !imageEdits.length && !artifacts.length) return stats;

  model = model || analyzePageContent(doc, page);
  const tree = new ModTree();

  // Image edits first (their op indices are stable within the model).
  for (const ie of imageEdits) {
    const img = findImageByPath(model, ie.path);
    if (!img) continue;
    if (ie.action === 'delete') {
      tree.setReplace(ie.path, []);
      stats.imagesEdited++;
    } else if (ie.action === 'transform' || ie.action === 'replace') {
      const T = ie.matrix || [1, 0, 0, 1, 0, 0];
      const inv = invert(img.ctm);
      let before = null;
      let after = null;
      if (inv) {
        // cm M with M = CTM * T * CTM^-1 applies T in the coordinate space of the parent content.
        const M = multiply(multiply(img.ctm, T), inv);
        before = 'q ' + matrixToCm(M);
        after = 'Q';
      }
      const newName = ie.action === 'replace' && ie.replacementRef && !img.inline ? { base: 'ImR', ref: ie.replacementRef } : null;
      tree.setWrap(ie.path, before, after, newName);
      stats.imagesEdited++;
    }
  }

  if (artifacts.length) planArtifactRemoval(model, artifacts, tree, [], stats);
  if (removeRegions.length) planTextRemoval(model, removeRegions, tree, [], stats);
  if (redactRegions.length) {
    planTextRemoval(model, redactRegions, tree, [], stats);
    planImageRedaction(model, redactRegions, tree, [], stats);
    planPathRedaction(model, redactRegions, tree, [], stats);
    if (stats.partialImages.length && edits.imageReplacer) {
      for (const pi of stats.partialImages) {
        try {
          const ref = await edits.imageReplacer(pi.image, redactRegions);
          if (ref) {
            tree.setWrap(pi.path, null, null, { base: 'ImR', ref });
            pi.handled = true;
          }
        } catch (e) {
          pi.error = String(e && e.message ? e.message : e);
        }
      }
    }
  }

  if (!tree.size) return stats;
  const state = { formsRewritten: 0 };
  const result = rewriteModel(context, model, tree, state);
  stats.formsRewritten = state.formsRewritten;
  const newStream = context.flateStream(result.bytes, {});
  const newRef = context.register(newStream);
  page.node.set(N('Contents'), context.obj([newRef]));
  if (result.resources && result.resources !== model.resources) {
    page.node.set(N('Resources'), result.resources);
  }
  // pdf-lib caches "normalized" state; reset so later drawing wraps the new content.
  if ('normalized' in page.node) page.node.normalized = false;
  if ('contentStream' in page) {
    page.contentStream = undefined;
    page.contentStreamRef = undefined;
  }
  return stats;
}

export { getOpAtPath, findImageByPath, intersectionRect };
