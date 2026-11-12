// Browser storage (IndexedDB): recently used documents and the hand-over of
// files chosen on a landing page to the editor. Everything stays on the
// user's device; every call degrades gracefully when storage is unavailable.

const DB_NAME = 'pdfedit';
const DB_VERSION = 1;
const MAX_RECENT = 8;
const MAX_RECENT_FILE = 60 * 1024 * 1024;
const MAX_RECENT_TOTAL = 200 * 1024 * 1024;
const HANDOFF_TTL = 10 * 60 * 1000;

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('recent')) db.createObjectStore('recent', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('handoff')) db.createObjectStore('handoff', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB error'));
      req.onblocked = () => reject(new Error('IndexedDB blocked'));
    }).catch((e) => {
      dbPromise = null;
      throw e;
    });
  }
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        let result;
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error || new Error('IndexedDB transaction failed'));
        t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted'));
        const r = fn(t.objectStore(store));
        if (r && 'onsuccess' in r) r.onsuccess = () => (result = r.result);
        else result = r;
      }),
  );
}

function recentEnabled() {
  try {
    const s = JSON.parse(localStorage.getItem('pdfedit.settings') || '{}') || {};
    return s.keepRecent !== false;
  } catch {
    return true;
  }
}

const idOf = (path) => String(path || '').split('/')[2] || '';

export const recentStore = {
  async list() {
    try {
      const all = (await tx('recent', 'readonly', (s) => s.getAll())) || [];
      return all.sort((a, b) => b.mtime - a.mtime).map((r) => ({ path: r.path, name: r.name, size: r.size, mtime: r.mtime }));
    } catch {
      return [];
    }
  },
  async add(name, blob) {
    if (!recentEnabled() || !blob || blob.size > MAX_RECENT_FILE) return false;
    try {
      const all = ((await tx('recent', 'readonly', (s) => s.getAll())) || []).sort((a, b) => b.mtime - a.mtime);
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const rec = { id, path: `/recent/${id}/${name}`, name, size: blob.size, mtime: Date.now(), blob };
      // The same name replaces its older entry; the list stays small.
      const keep = [];
      const drop = [];
      let total = blob.size;
      for (const r of all) {
        if (r.name === name || keep.length >= MAX_RECENT - 1 || total + r.size > MAX_RECENT_TOTAL) drop.push(r.id);
        else {
          keep.push(r);
          total += r.size;
        }
      }
      await tx('recent', 'readwrite', (s) => {
        for (const d of drop) s.delete(d);
        s.put(rec);
      });
      return true;
    } catch {
      return false;
    }
  },
  async read(path) {
    try {
      return (await tx('recent', 'readonly', (s) => s.get(idOf(path)))) || null;
    } catch {
      return null;
    }
  },
  async remove(path) {
    try {
      await tx('recent', 'readwrite', (s) => s.delete(idOf(path)));
    } catch {
      /* ignore */
    }
    return true;
  },
  async clear() {
    try {
      await tx('recent', 'readwrite', (s) => s.clear());
    } catch {
      /* ignore */
    }
    return true;
  },
};

export const handoffStore = {
  // Stores the chosen files for the editor page. Resolves to false when the
  // browser cannot keep them (the editor then asks for the file again).
  async put(files, extra = {}) {
    try {
      await tx('handoff', 'readwrite', (s) => s.put({ id: 'pending', files: [...files], at: Date.now(), ...extra }));
      return true;
    } catch {
      return false;
    }
  },
  async take() {
    let rec = null;
    try {
      rec = await tx('handoff', 'readonly', (s) => s.get('pending'));
      if (rec) await tx('handoff', 'readwrite', (s) => s.delete('pending'));
    } catch {
      return [];
    }
    if (!rec || Date.now() - rec.at > HANDOFF_TTL) return [];
    return (rec.files || []).filter((f) => f && typeof f.arrayBuffer === 'function');
  },
};
