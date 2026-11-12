// Document session: sources, editable page model, undo/redo, previews, save.
import { openPdfjs, destroyPdf } from '../pdf/pdfjs.js';
import { registry } from '../pdf/fonts.js';
import { buildPdf, buildPagePreview, loadPdf } from '../../../core/builder.js';
import { analyzePageContent } from '../../../core/content-editor.js';
import { checkPassword } from '../../../core/security.js';
import { uid, basename } from '../ui/dom.js';
import { settings } from '../settings.js';
import { redactImageRegions } from './image-tools.js';
import { pageKey } from '../../../web/billing.js';

let sourceCounter = 0;

export function newPageEntry(srcId, index) {
  return { uid: uid('p'), src: { doc: srcId, index }, rotate: 0, crop: null, objects: [], removals: [], imageEdits: [], annotEdits: {} };
}

export function blankPageEntry(width = 595.28, height = 841.89) {
  return { uid: uid('p'), src: null, blank: { width, height }, rotate: 0, crop: null, objects: [], removals: [], imageEdits: [], annotEdits: {} };
}

function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function needsPreview(entry) {
  return !!entry.src && ((entry.removals && entry.removals.length) || (entry.imageEdits && entry.imageEdits.length) || (entry.annotEdits && Object.keys(entry.annotEdits).length));
}

function previewKey(entry) {
  return JSON.stringify([entry.src, entry.removals, entry.imageEdits, entry.annotEdits]);
}

function diffStates(a, b) {
  const structure =
    a.pages.length !== b.pages.length ||
    a.pages.some((p, i) => {
      const q = b.pages[i];
      return p.uid !== q.uid || p.rotate !== q.rotate || JSON.stringify(p.crop) !== JSON.stringify(q.crop) || JSON.stringify(p.blank) !== JSON.stringify(q.blank);
    });
  const objects = new Set();
  const content = new Set();
  const byUid = new Map(a.pages.map((p) => [p.uid, p]));
  for (const p of b.pages) {
    const q = byUid.get(p.uid);
    if (!q) continue;
    if (JSON.stringify(q.objects) !== JSON.stringify(p.objects)) objects.add(p.uid);
    if (previewKey(q) !== previewKey(p)) content.add(p.uid);
  }
  return {
    structure,
    objects,
    content,
    meta: JSON.stringify(a.meta) !== JSON.stringify(b.meta),
    outline: JSON.stringify(a.outline) !== JSON.stringify(b.outline),
    security: JSON.stringify(a.security) !== JSON.stringify(b.security),
  };
}

export class DocSession extends EventTarget {
  constructor({ filePath = null, name = 'Untitled.pdf' } = {}) {
    super();
    this.id = uid('doc');
    this.filePath = filePath;
    this.name = name;
    this.sources = new Map();
    this.baseId = null;
    this.state = { pages: [], meta: null, outline: undefined, security: null };
    this.savedState = this.state;
    this.undoStack = [];
    this.redoStack = [];
    this.assets = new Map();
    this.previews = new Map();
    this.libDocs = new Map();
    this.libCaches = new Map();
    this.analysis = new Map();
    this.textContents = new Map();
    this.annotationCache = new Map();
    this.formDirty = false;
    this.restricted = false;
    this.closed = false;
    this.isNew = !filePath;
  }

  get dirty() {
    return !!(this.state !== this.savedState || this.formDirty || this.isNewUnsaved || this.externalDirty);
  }

  get pages() {
    return this.state.pages;
  }

  // ------------------------------------------------------------------ sources

  async addSource(bytes, { name, password, path } = {}) {
    const pdf = await openPdfjs(bytes, password);
    const id = `s${++sourceCounter}`;
    let permissions = null;
    try {
      // pdf.js returns a Set of PermissionFlag values (null when unrestricted).
      const perms = await pdf.getPermissions();
      permissions = perms ? [...perms] : null;
    } catch {
      permissions = null;
    }
    let encrypted = false;
    try {
      const md = await pdf.getMetadata();
      encrypted = !!(md && md.info && md.info.EncryptFilterName);
    } catch {
      /* ignore */
    }
    const src = { id, name: name || basename(path) || 'document.pdf', path: path || null, bytes, password: password || undefined, pdf, numPages: pdf.numPages, permissions, encrypted, pageCache: new Map() };
    pdf.annotationStorage.onSetModified = () => {
      this.formDirty = true;
      this.emit('dirty');
    };
    this.sources.set(id, src);
    return src;
  }

  async initFromSource(src) {
    this.baseId = src.id;
    this.state = { pages: Array.from({ length: src.numPages }, (_, i) => newPageEntry(src.id, i)), meta: null, outline: undefined, security: null };
    this.savedState = this.state;
    if (src.encrypted || src.password) {
      this.originalSecurity = await this.detectSecurity(src);
    }
    const perms = src.permissions;
    // pdf.js PermissionFlag.MODIFY_CONTENTS = 0x08
    this.restricted = Array.isArray(perms) && !perms.includes(0x08);
    this.emit('change', { structure: true, objects: new Set(), content: new Set() });
  }

  async detectSecurity(src) {
    let userPassword = '';
    let ownerPassword = null;
    if (src.password) {
      // A password was needed to open the file, so saved copies keep requiring
      // it, also when it was the owner password (the user password cannot be
      // recovered from that one).
      userPassword = src.password;
      const kind = await checkPassword(src.bytes, src.password).catch(() => null);
      if (kind === 'owner') ownerPassword = src.password;
    }
    return { userPassword, ownerPassword, permissions: src.permissions };
  }

  async unlockRestrictions(password) {
    const src = this.sources.get(this.baseId);
    const kind = await checkPassword(src.bytes, password);
    if (kind !== 'owner') return false;
    this.restricted = false;
    if (this.originalSecurity) this.originalSecurity.ownerPassword = password;
    src.password = src.password || password;
    this.emit('restrictions');
    return true;
  }

  async getPdfPage(srcId, index) {
    const src = this.sources.get(srcId);
    if (!src) throw new Error(`Unknown source ${srcId}`);
    let p = src.pageCache.get(index);
    if (!p) {
      p = src.pdf.getPage(index + 1);
      src.pageCache.set(index, p);
    }
    return p;
  }

  async getLibDoc(srcId) {
    if (!this.libDocs.has(srcId)) {
      const src = this.sources.get(srcId);
      this.libDocs.set(
        srcId,
        loadPdf(src.bytes, src.password).catch((e) => {
          this.libDocs.delete(srcId);
          throw e;
        }),
      );
    }
    return this.libDocs.get(srcId);
  }

  async analyze(entry) {
    if (!entry.src) return null;
    const key = `${entry.src.doc}:${entry.src.index}`;
    if (!this.analysis.has(key)) {
      this.analysis.set(
        key,
        (async () => {
          const doc = await this.getLibDoc(entry.src.doc);
          return analyzePageContent(doc, doc.getPage(entry.src.index));
        })(),
      );
    }
    return this.analysis.get(key);
  }

  // Page used for rendering (preview with content edits when needed).
  async getRenderPage(entry) {
    if (!entry.src) return null;
    if (!needsPreview(entry)) return this.getPdfPage(entry.src.doc, entry.src.index);
    const key = previewKey(entry);
    let p = this.previews.get(entry.uid);
    if (!p || p.key !== key) {
      if (p) p.promise.then((r) => r && r.pdf && destroyPdf(r.pdf)).catch(() => {});
      const src = this.sources.get(entry.src.doc);
      let cache = this.libCaches.get(src.id);
      if (!cache) {
        cache = new Map();
        this.libCaches.set(src.id, cache);
      }
      const promise = (async () => {
        const bytes = await buildPagePreview({ sourceBytes: src.bytes, password: src.password, pageIndex: entry.src.index, entry, assets: this.assetStore(), cache });
        const pdf = await openPdfjs(bytes);
        const page = await pdf.getPage(1);
        return { pdf, page };
      })();
      p = { key, promise };
      this.previews.set(entry.uid, p);
    }
    const r = await p.promise;
    return r.page;
  }

  async getTextContent(entry) {
    const page = await this.getRenderPage(entry);
    if (!page) return { items: [], styles: {} };
    const key = needsPreview(entry) ? `pv:${entry.uid}:${previewKey(entry)}` : `src:${entry.src.doc}:${entry.src.index}`;
    if (!this.textContents.has(key)) {
      this.textContents.set(key, page.getTextContent({ includeMarkedContent: false }));
    }
    return this.textContents.get(key);
  }

  async getSourceAnnotations(entry) {
    if (!entry.src) return [];
    const key = `${entry.src.doc}:${entry.src.index}`;
    if (!this.annotationCache.has(key)) {
      this.annotationCache.set(
        key,
        (async () => {
          const page = await this.getPdfPage(entry.src.doc, entry.src.index);
          try {
            return await page.getAnnotations({ intent: 'display' });
          } catch {
            return [];
          }
        })(),
      );
    }
    return this.annotationCache.get(key);
  }

  // Basic geometry of an entry: { view: [x0,y0,x1,y1], rotation, width, height } in points.
  async pageGeometry(entry) {
    if (!entry.src) {
      const w = entry.blank?.width || 595.28;
      const h = entry.blank?.height || 841.89;
      const view = entry.crop || [0, 0, w, h];
      const rotation = ((entry.rotate || 0) % 360 + 360) % 360;
      return geometryFrom(view, rotation);
    }
    const page = await this.getPdfPage(entry.src.doc, entry.src.index);
    const view = entry.crop || page.view;
    const rotation = (((page.rotate || 0) + (entry.rotate || 0)) % 360 + 360) % 360;
    return geometryFrom(view, rotation);
  }

  // ------------------------------------------------------------------ assets

  addAsset(bytes, mime, meta = {}) {
    const id = uid('a');
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    this.assets.set(id, { bytes, mime, url, ...meta });
    return id;
  }

  assetStore() {
    return { get: async (id) => this.assets.get(id) };
  }

  // ------------------------------------------------------------------ editing

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // `merge` folds the change into the previous undo step (e.g. typing into a
  // text box that was just created).
  update(label, fn, { merge = false } = {}) {
    const before = this.state;
    const next = structuredClone(before);
    const result = fn(next);
    if (result === false) return false;
    const diff = diffStates(before, next);
    if (!diff.structure && !diff.objects.size && !diff.content.size && !diff.meta && !diff.outline && !diff.security) return false;
    if (!merge || !this.undoStack.length) {
      this.undoStack.push({ label, state: before });
      if (this.undoStack.length > 200) this.undoStack.shift();
    }
    this.changeSeq = (this.changeSeq || 0) + 1;
    this.redoStack = [];
    this.state = next;
    this.emit('change', { ...diff, label });
    return true;
  }

  updatePage(uid, label, fn) {
    return this.update(label, (s) => {
      const p = s.pages.find((x) => x.uid === uid);
      if (!p) return false;
      return fn(p, s);
    });
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    const item = this.undoStack.pop();
    if (!item) return null;
    this.changeSeq = (this.changeSeq || 0) + 1;
    this.redoStack.push({ label: item.label, state: this.state });
    const before = this.state;
    this.state = item.state;
    this.emit('change', { ...diffStates(before, this.state), label: item.label, undo: true });
    return item.label;
  }

  redo() {
    const item = this.redoStack.pop();
    if (!item) return null;
    this.changeSeq = (this.changeSeq || 0) + 1;
    this.undoStack.push({ label: item.label, state: this.state });
    const before = this.state;
    this.state = item.state;
    this.emit('change', { ...diffStates(before, this.state), label: item.label, redo: true });
    return item.label;
  }

  pageIndex(uid) {
    return this.state.pages.findIndex((p) => p.uid === uid);
  }

  page(uid) {
    return this.state.pages.find((p) => p.uid === uid) || null;
  }

  findObject(id) {
    for (const p of this.state.pages) {
      const o = (p.objects || []).find((x) => x.id === id);
      if (o) return { page: p, object: o };
    }
    return null;
  }

  // ------------------------------------------------------------------ page operations

  insertSourcePages(src, indices, at) {
    return this.update('insertPages', (s) => {
      const entries = indices.map((i) => newPageEntry(src.id, i));
      s.pages.splice(Math.max(0, Math.min(at, s.pages.length)), 0, ...entries);
    });
  }

  insertBlank(at, width, height, count = 1) {
    return this.update('insertBlank', (s) => {
      const entries = Array.from({ length: count }, () => blankPageEntry(width, height));
      s.pages.splice(Math.max(0, Math.min(at, s.pages.length)), 0, ...entries);
    });
  }

  deletePages(uids) {
    const set = new Set(uids);
    return this.update('deletePages', (s) => {
      if (s.pages.every((p) => set.has(p.uid))) return false;
      s.pages = s.pages.filter((p) => !set.has(p.uid));
    });
  }

  rotatePages(uids, delta) {
    const set = new Set(uids);
    return this.update('rotatePages', (s) => {
      for (const p of s.pages) if (set.has(p.uid)) p.rotate = ((((p.rotate || 0) + delta) % 360) + 360) % 360;
    });
  }

  movePages(uids, toIndex) {
    const set = new Set(uids);
    return this.update('movePages', (s) => {
      const moving = s.pages.filter((p) => set.has(p.uid));
      let target = toIndex;
      for (let i = 0; i < toIndex && i < s.pages.length; i++) if (set.has(s.pages[i].uid)) target--;
      const rest = s.pages.filter((p) => !set.has(p.uid));
      rest.splice(Math.max(0, Math.min(target, rest.length)), 0, ...moving);
      s.pages = rest;
    });
  }

  duplicatePages(uids) {
    const set = new Set(uids);
    return this.update('duplicatePages', (s) => {
      const out = [];
      for (const p of s.pages) {
        out.push(p);
        if (set.has(p.uid)) {
          const copy = structuredClone(p);
          copy.uid = uid('p');
          copy.objects = (copy.objects || []).map((o) => ({ ...o, id: uid('o') }));
          out.push(copy);
        }
      }
      s.pages = out;
    });
  }

  reversePages(uids) {
    const set = new Set(uids);
    return this.update('reversePages', (s) => {
      const idx = s.pages.map((p, i) => (set.has(p.uid) ? i : -1)).filter((i) => i >= 0);
      const sel = idx.map((i) => s.pages[i]).reverse();
      idx.forEach((i, k) => (s.pages[i] = sel[k]));
    });
  }

  replacePages(uids, src, indices) {
    const set = new Set(uids);
    return this.update('replacePages', (s) => {
      const firstIdx = s.pages.findIndex((p) => set.has(p.uid));
      if (firstIdx < 0) return false;
      s.pages = s.pages.filter((p) => !set.has(p.uid));
      s.pages.splice(firstIdx, 0, ...indices.map((i) => newPageEntry(src.id, i)));
    });
  }

  cropPages(uids, box) {
    const set = new Set(uids);
    return this.update('cropPages', (s) => {
      for (const p of s.pages) if (set.has(p.uid)) p.crop = box ? box.slice() : null;
    });
  }

  // ------------------------------------------------------------------ objects

  addObject(pageUid, obj, label = 'addObject') {
    const now = new Date().toISOString();
    const o = { created: now, modified: now, author: settings.author || '', ...obj, id: obj.id || uid('o') };
    this.updatePage(pageUid, label, (p) => {
      p.objects = p.objects || [];
      p.objects.push(o);
    });
    return o.id;
  }

  updateObject(id, patch, label = 'editObject', options = {}) {
    return this.update(label, (s) => {
      for (const p of s.pages) {
        const o = (p.objects || []).find((x) => x.id === id);
        if (o) {
          Object.assign(o, typeof patch === 'function' ? patch(o) || {} : patch, { modified: new Date().toISOString() });
          return;
        }
      }
      return false;
    }, options);
  }

  removeObjects(ids, label = 'deleteObject', options = {}) {
    const set = new Set(ids);
    return this.update(label, (s) => {
      let changed = false;
      for (const p of s.pages) {
        const before = (p.objects || []).length;
        p.objects = (p.objects || []).filter((o) => !set.has(o.id));
        // Deleting a replacement text keeps the original text removed.
        if (p.objects.length !== before) changed = true;
      }
      return changed;
    }, options);
  }

  // ------------------------------------------------------------------ forms

  collectFormValues() {
    const out = {};
    for (const [id, src] of this.sources) {
      const storage = src.pdf.annotationStorage;
      if (!storage || !storage.size) continue;
      const ser = storage.serializable;
      const map = ser && ser.map instanceof Map ? ser.map : null;
      if (!map) continue;
      const values = {};
      for (const [annotId, v] of map) {
        if (!v || typeof v !== 'object') continue;
        if ('value' in v) values[annotId] = { value: v.value };
      }
      if (Object.keys(values).length) out[id] = values;
    }
    return out;
  }

  resetForms() {
    for (const src of this.sources.values()) {
      const storage = src.pdf.annotationStorage;
      if (!storage || !storage.size) continue;
      const ser = storage.serializable;
      const keys = ser && ser.map instanceof Map ? [...ser.map.keys()] : [];
      for (const key of keys) {
        try {
          storage.remove(key);
        } catch {
          /* ignore */
        }
      }
    }
    this.formDirty = false;
    this.emit('forms-reset');
  }

  // ------------------------------------------------------------------ save

  effectiveSecurity() {
    const s = this.state.security;
    if (s && s.remove) return null;
    if (s && (s.userPassword || s.ownerPassword)) return s;
    // Saved copies of an encrypted file stay encrypted with the same
    // passwords and permissions unless security was removed explicitly.
    const o = this.originalSecurity;
    if (o) {
      const perms = Array.isArray(o.permissions) ? o.permissions : null;
      const has = (flag) => !perms || perms.includes(flag);
      // An unknown owner password is replaced by a random one so that the
      // original permission restrictions cannot be lifted with the user
      // password.
      if (!o.ownerPassword) o.ownerPassword = randomPassword();
      return {
        userPassword: o.userPassword || '',
        ownerPassword: o.ownerPassword,
        permissions: { printing: has(0x04), modifying: has(0x08), copying: has(0x10), annotating: has(0x20), fillingForms: has(0x100), documentAssembly: has(0x400) },
      };
    }
    return null;
  }

  async buildBytes({ onProgress, pages, outline, security, standalone = false } = {}) {
    const sources = {};
    const usedIds = new Set((pages || this.state.pages).filter((p) => p.src).map((p) => p.src.doc));
    if (this.baseId && !standalone) usedIds.add(this.baseId);
    for (const id of usedIds) {
      const s = this.sources.get(id);
      if (s) sources[id] = { bytes: s.bytes, password: s.password };
    }
    let loadedDocs = null;
    if (standalone) {
      loadedDocs = new Map();
      for (const id of usedIds) loadedDocs.set(id, this.getLibDoc(id));
    }
    return buildPdf({
      sources,
      loadedDocs,
      baseId: !standalone && this.baseId && sources[this.baseId] ? this.baseId : null,
      pages: pages || this.state.pages,
      assets: this.assetStore(),
      registry,
      formValues: this.collectFormValues(),
      meta: this.state.meta,
      outline: outline !== undefined ? outline : this.state.outline,
      security: security !== undefined ? security : this.effectiveSecurity(),
      author: settings.author || '',
      onProgress,
      imageReplacer: redactImageRegions,
    });
  }

  async replaceWithBytes(bytes, { filePath, name, password } = {}) {
    // Re-open the saved output as the only source.
    const oldSources = [...this.sources.values()];
    // Pages that were already paid for stay paid in the re-opened document
    // (the output has the same pages in the same order).
    const paidBefore = this.paidKeys ? this.state.pages.map((p) => this.paidKeys.has(pageKey(p))) : null;
    const secured = this.effectiveSecurity();
    const pwd = password !== undefined ? password : secured ? secured.userPassword || undefined : undefined;
    const src = await this.addSource(bytes, { name: name || this.name, password: pwd, path: filePath });
    for (const s of oldSources) {
      this.sources.delete(s.id);
      destroyPdf(s.pdf);
    }
    for (const p of this.previews.values()) p.promise.then((r) => r && r.pdf && destroyPdf(r.pdf)).catch(() => {});
    this.previews.clear();
    this.libDocs.clear();
    this.libCaches.clear();
    this.analysis.clear();
    this.textContents.clear();
    this.annotationCache.clear();
    this.undoStack = [];
    this.redoStack = [];
    this.formDirty = false;
    if (filePath) {
      this.filePath = filePath;
      this.name = basename(filePath);
    }
    this.isNew = false;
    this.isNewUnsaved = false;
    this.externalDirty = false;
    const keepSecurity = secured ? { userPassword: secured.userPassword || '', ownerPassword: secured.ownerPassword || null, permissions: src.permissions } : null;
    await this.initFromSource(src);
    if (paidBefore && paidBefore.length === this.state.pages.length) this.paidKeys = new Set(this.state.pages.filter((_, i) => paidBefore[i]).map(pageKey));
    else if (paidBefore) this.paidKeys = new Set();
    this.originalSecurity = keepSecurity;
    this.restricted = false;
    this.emit('saved');
  }

  async save(filePath, { onProgress } = {}) {
    const { bytes, warnings } = await this.buildBytes({ onProgress });
    await this.finishSave(filePath, bytes);
    return { warnings, size: bytes.length };
  }

  // Hands the built document over (a download in the browser) and continues
  // editing on top of it.
  async finishSave(filePath, bytes) {
    await window.api.file.write(filePath, bytes);
    await this.replaceWithBytes(bytes, { filePath });
  }

  destroy() {
    this.closed = true;
    for (const s of this.sources.values()) destroyPdf(s.pdf);
    for (const p of this.previews.values()) p.promise.then((r) => r && r.pdf && destroyPdf(r.pdf)).catch(() => {});
    for (const a of this.assets.values()) if (a.url) URL.revokeObjectURL(a.url);
  }
}

function geometryFrom(view, rotation) {
  const w = view[2] - view[0];
  const h = view[3] - view[1];
  const swap = rotation % 180 !== 0;
  return { view, rotation, width: swap ? h : w, height: swap ? w : h, pageWidth: w, pageHeight: h };
}
