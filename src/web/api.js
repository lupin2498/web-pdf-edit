// Browser implementation of the platform bridge (`window.api`) that the
// editor was written against. Files are addressed by virtual paths:
//
//   /local/<n>/<name>      a file picked or dropped by the user
//   /downloads/<name>      a file handed to the browser as a download
//   /zip/<n>/<name>        a file collected for a ZIP download
//   /recent/<id>/<name>    a file kept in this browser (IndexedDB)
//   /__fixtures/<name>     test fixtures served by the test server
//
// Nothing leaves the browser: documents are read and written locally.
import { zipSync } from 'fflate';
import { recentStore, handoffStore } from './storage.js';

const SETTINGS_KEY = 'pdfedit.settings';
const MAX_KEPT_OUTPUTS = 6;

const vfs = new Map();
const outputs = [];
const zipFolders = new Map();
const dialogQueue = [];
const downloadLog = [];
let seq = 0;
let openFilesCallback = null;

export function basename(p) {
  return String(p || '').split(/[\\/]/).pop();
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') return new TextEncoder().encode(data);
  throw new Error('Unsupported data');
}

const MIME = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  txt: 'text/plain',
  html: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  zip: 'application/zip',
};

export function mimeFor(name) {
  const ext = /\.([a-z0-9]+)$/i.exec(name || '');
  return (ext && MIME[ext[1].toLowerCase()]) || 'application/octet-stream';
}

// Characters that are not allowed in file names on common systems.
export function safeFileName(name, fallback = 'document.pdf') {
  let s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^\.+/, '').slice(0, 180);
  return s || fallback;
}

export function registerFile(file) {
  const path = `/local/${++seq}/${safeFileName(file.name, 'file')}`;
  vfs.set(path, { name: file.name, blob: file, size: file.size, mtime: file.lastModified || Date.now() });
  return path;
}

export function registerBytes(name, bytes, prefix = 'local') {
  const path = `/${prefix}/${++seq}/${safeFileName(name, 'file')}`;
  vfs.set(path, { name, blob: new Blob([bytes], { type: mimeFor(name) }), size: bytes.length, mtime: Date.now() });
  return path;
}

function keepOutput(path, name, bytes) {
  vfs.set(path, { name, blob: new Blob([bytes], { type: mimeFor(name) }), size: bytes.length, mtime: Date.now() });
  const i = outputs.indexOf(path);
  if (i >= 0) outputs.splice(i, 1);
  outputs.push(path);
  while (outputs.length > MAX_KEPT_OUTPUTS) vfs.delete(outputs.shift());
}

async function readPath(path) {
  const entry = vfs.get(path);
  if (entry) return new Uint8Array(await entry.blob.arrayBuffer());
  if (path.startsWith('/recent/')) {
    const rec = await recentStore.read(path);
    if (rec) return new Uint8Array(await rec.blob.arrayBuffer());
  }
  if (path.startsWith('/__fixtures/')) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`Cannot read ${path}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  const err = new Error(`File not available: ${basename(path)}`);
  err.code = 'fileGone';
  throw err;
}

// ------------------------------------------------------------------ downloads

export function downloadBytes(name, data) {
  const bytes = toBytes(data);
  const fileName = safeFileName(name);
  const blob = new Blob([bytes], { type: mimeFor(fileName) });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking too early cancels the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  downloadLog.push({ name: fileName, size: bytes.length, at: Date.now() });
  if (downloadLog.length > 50) downloadLog.shift();
  return fileName;
}

// ------------------------------------------------------------------ file picker

function acceptFor(filters) {
  const exts = [];
  for (const f of filters || []) for (const e of f.extensions || []) if (e && e !== '*') exts.push(`.${e}`);
  return [...new Set(exts)].join(',');
}

function pickFiles({ multiple = false, filters = null } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = !!multiple;
    const accept = acceptFor(filters);
    if (accept) input.accept = accept;
    input.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    input.dataset.pePicker = '1';
    let done = false;
    const finish = (files) => {
      if (done) return;
      done = true;
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish([...input.files]));
    input.addEventListener('cancel', () => finish([]));
    // Browsers without the `cancel` event: the window regains focus when
    // the picker closes; no selection shortly after means it was cancelled.
    const onFocus = () => setTimeout(() => { if (!input.files.length) finish([]); }, 1500);
    window.addEventListener('focus', onFocus);
    document.body.appendChild(input);
    input.click();
  });
}

// ------------------------------------------------------------------ settings

function readSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...readSettings(), ...patch }));
  } catch {
    /* storage unavailable (private mode) */
  }
}

// ------------------------------------------------------------------ bridge

export function installWebApi({ version = '' } = {}) {
  const isTest = /[?&]e2e=1\b/.test(location.search) || !!window.__PE_TEST__;
  const api = {
    info: async () => ({ version, platform: 'web', locale: navigator.language || 'vi', isTest }),
    initialFiles: async () => {
      // Files chosen on a landing page are handed over through IndexedDB.
      if (!/[?&]open=handoff\b/.test(location.search)) return [];
      try {
        const files = await handoffStore.take();
        history.replaceState(null, '', location.pathname + location.search.replace(/([?&])open=handoff&?/, '$1').replace(/[?&]$/, '') + location.hash);
        return files.map((f) => registerFile(f));
      } catch {
        return [];
      }
    },
    confirmClose: async () => true,
    onOpenFiles: (cb) => {
      openFilesCallback = cb;
    },
    onRequestClose: () => {},
    settings: {
      get: async () => readSettings(),
      set: async (patch) => {
        writeSettings(patch || {});
        return true;
      },
    },
    recent: {
      get: () => recentStore.list(),
      add: async (path) => {
        const entry = vfs.get(path);
        if (!entry || !/\.pdf$/i.test(entry.name)) return false;
        return recentStore.add(entry.name, entry.blob);
      },
      remove: (path) => recentStore.remove(path),
      clear: () => recentStore.clear(),
    },
    dialog: {
      open: async (opts = {}) => {
        if (dialogQueue.length) {
          const v = dialogQueue.shift();
          return v === null ? [] : Array.isArray(v) ? v : [v];
        }
        const files = await pickFiles(opts);
        return files.map((f) => registerFile(f));
      },
      // Downloads go to the browser's download folder; `ask` lets the user
      // choose the file name first (see askName below).
      save: async (opts = {}) => {
        if (dialogQueue.length) return dialogQueue.shift();
        let name = safeFileName(basename(opts.defaultPath));
        if (opts.ask && api.dialog.askName) {
          const chosen = await api.dialog.askName(name);
          if (chosen === null || chosen === undefined) return null;
          const ext = /\.[A-Za-z0-9]+$/.exec(name);
          name = safeFileName(chosen, name);
          if (ext && !name.toLowerCase().endsWith(ext[0].toLowerCase())) name += ext[0];
        }
        return `/downloads/${name}`;
      },
      // Set by the editor: async (defaultName) => chosen name or null.
      askName: null,
      folder: async () => {
        if (dialogQueue.length) {
          const v = dialogQueue.shift();
          if (v === null) return null;
        }
        const path = `/zip/${++seq}`;
        zipFolders.set(path, []);
        return path;
      },
    },
    file: {
      read: (path) => readPath(path),
      write: async (path, data) => {
        const bytes = toBytes(data);
        const name = basename(path);
        const folder = path.slice(0, path.lastIndexOf('/'));
        if (zipFolders.has(folder)) {
          zipFolders.get(folder).push({ name, bytes });
          return true;
        }
        downloadBytes(name, bytes);
        keepOutput(path, name, bytes);
        return true;
      },
      exists: async (path) => vfs.has(path),
      stat: async (path) => {
        const e = vfs.get(path);
        return e ? { size: e.size, mtime: e.mtime, isFile: true } : null;
      },
    },
    // Finishes a folder export: one file is downloaded as is, several are
    // packed into a single ZIP.
    folder: {
      commit: async (path, zipName = 'files.zip') => {
        const files = zipFolders.get(path) || [];
        zipFolders.delete(path);
        if (!files.length) return null;
        if (files.length === 1) return downloadBytes(files[0].name, files[0].bytes);
        const entries = {};
        for (const f of files) {
          let name = safeFileName(f.name, 'file');
          let n = 1;
          while (entries[name]) name = name.replace(/(\.[^.]+)?$/, `_${++n}$1`);
          // PDF and image data is already compressed: store it.
          entries[name] = [f.bytes, { level: 0 }];
        }
        return downloadBytes(zipName, zipSync(entries));
      },
      discard: (path) => zipFolders.delete(path),
    },
    shell: {
      show: async () => false,
      openPath: async () => '',
      openExternal: async (url) => {
        if (!/^(https?|mailto):/i.test(url)) return false;
        window.open(url, '_blank', 'noopener,noreferrer');
        return true;
      },
    },
    fonts: {
      list: async () => [],
      read: async () => {
        throw new Error('System fonts are not available in the browser');
      },
    },
    // Desktop browsers block inside window.print() until the dialog closes;
    // mobile browsers return at once and fire `afterprint` later.
    print: () =>
      new Promise((resolve) => {
        let finished = false;
        const done = (result = { success: true }) => {
          if (finished) return;
          finished = true;
          window.removeEventListener('afterprint', onAfter);
          resolve(result);
        };
        const onAfter = () => done();
        window.addEventListener('afterprint', onAfter);
        const started = Date.now();
        try {
          window.print();
        } catch (e) {
          return done({ success: false, reason: String(e && e.message ? e.message : e) });
        }
        // The call blocked (or printing is unavailable): nothing to wait for.
        if (isTest || Date.now() - started > 400) return setTimeout(done, 0);
        // Non-blocking print: keep the pages until the dialog is closed.
        setTimeout(done, 5 * 60 * 1000);
        window.addEventListener('focus', () => setTimeout(done, 1000), { once: true });
      }),
    pathForFile: (file) => {
      try {
        return registerFile(file);
      } catch {
        return '';
      }
    },
    test: {
      queueDialog: async (items) => {
        dialogQueue.push(...items);
        return true;
      },
      downloads: () => downloadLog.slice(),
    },
    window: {
      setTitle: async (title) => {
        document.title = title;
        return true;
      },
      setOverlay: async () => true,
    },
  };
  window.api = api;

  // Installed PWA: files opened with the app from the operating system.
  if ('launchQueue' in window && window.launchQueue.setConsumer) {
    window.launchQueue.setConsumer(async (params) => {
      if (!params.files || !params.files.length) return;
      const paths = [];
      for (const handle of params.files) {
        try {
          paths.push(registerFile(await handle.getFile()));
        } catch {
          /* ignore unreadable files */
        }
      }
      if (paths.length && openFilesCallback) openFilesCallback(paths);
    });
  }
  return api;
}
