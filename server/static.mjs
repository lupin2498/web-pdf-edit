// Serves the built site (dist/). HTML pages are templated once at start-up
// with the runtime configuration; hashed assets are cached for a year and
// sent pre-compressed when the build provided .br / .gz copies.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.icc': 'application/vnd.iccprofile',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.map': 'application/json',
};

const YEAR = 365 * 24 * 60 * 60;

function cacheControl(urlPath) {
  if (urlPath.endsWith('.html')) return 'no-cache';
  // Content-hashed bundles and versioned pdf.js runtime files never change.
  if (/^\/assets\/[^/]+-[A-Z0-9]{8}\.[a-z0-9]+$/.test(urlPath) || /^\/assets\/pdfjs-[\d.]+\//.test(urlPath)) return `public, max-age=${YEAR}, immutable`;
  if (urlPath.startsWith('/assets/')) return 'public, max-age=2592000';
  return 'public, max-age=3600';
}

/** Escapes a JSON document for use inside an inline <script>. */
export function inlineJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** Fills the %%NAME%% placeholders of a built HTML page. */
export function renderHtml(html, vars) {
  return html.replace(/%%([A-Z_]+)%%/g, (m, key) => (Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m));
}

export function createStatic({ distDir, vars = {}, watch = false }) {
  let files = new Map();
  let build = { pages: [], manifest: {} };
  let stamp = 0;

  const scan = () => {
    const next = new Map();
    const walk = (dir, prefix) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        const urlPath = `${prefix}/${e.name}`;
        if (e.isDirectory()) walk(full, urlPath);
        else if (!/\.(br|gz)$/.test(e.name) && e.name !== 'build.json') {
          const st = fs.statSync(full);
          next.set(urlPath, { file: full, size: st.size, mtime: st.mtimeMs, type: TYPES[path.extname(e.name).toLowerCase()] || 'application/octet-stream', html: e.name.endsWith('.html') });
        }
      }
    };
    walk(distDir, '');
    files = next;
    try {
      const file = path.join(distDir, 'build.json');
      build = JSON.parse(fs.readFileSync(file, 'utf8'));
      stamp = fs.statSync(file).mtimeMs;
    } catch {
      build = { pages: [], manifest: {} };
      stamp = 0;
    }
  };
  scan();

  const rescanIfChanged = () => {
    if (!watch) return;
    try {
      const m = fs.statSync(path.join(distDir, 'build.json')).mtimeMs;
      if (m !== stamp) scan();
    } catch {
      /* build in progress */
    }
  };

  const htmlBody = (entry) => {
    if (!entry.body) {
      const text = renderHtml(fs.readFileSync(entry.file, 'utf8'), vars);
      entry.body = Buffer.from(text, 'utf8');
      entry.etag = `"${crypto.createHash('sha1').update(entry.body).digest('base64url').slice(0, 20)}"`;
      entry.gz = zlib.gzipSync(entry.body, { level: 6 });
      entry.br = zlib.brotliCompressSync(entry.body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } });
    }
    return entry;
  };

  const resolve = (pathname) => {
    let p;
    try {
      p = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (p.includes('\0') || p.split('/').includes('..')) return null;
    if (p.endsWith('/')) return files.has(`${p}index.html`) ? { path: `${p}index.html` } : null;
    if (files.has(p)) return { path: p };
    if (files.has(`${p}/index.html`)) return { redirect: `${p}/` };
    return null;
  };

  /**
   * Answers a GET/HEAD request for a static file. Returns false when there
   * is no such file (the caller sends the 404 page).
   */
  const serve = (req, res, pathname, { status = 200 } = {}) => {
    rescanIfChanged();
    const hit = resolve(pathname);
    if (!hit) return false;
    if (hit.redirect) {
      const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      res.writeHead(301, { Location: hit.redirect + query, 'Cache-Control': 'public, max-age=3600' });
      res.end();
      return true;
    }
    const entry = files.get(hit.path);
    const accept = String(req.headers['accept-encoding'] || '');
    const headers = { 'Content-Type': entry.type, 'Cache-Control': cacheControl(hit.path), Vary: 'Accept-Encoding' };
    let body;
    let stream = null;
    if (entry.html) {
      htmlBody(entry);
      headers.ETag = entry.etag;
      if (status === 200 && req.headers['if-none-match'] === entry.etag) {
        res.writeHead(304, headers);
        res.end();
        return true;
      }
      if (/\bbr\b/.test(accept)) {
        body = entry.br;
        headers['Content-Encoding'] = 'br';
      } else if (/\bgzip\b/.test(accept)) {
        body = entry.gz;
        headers['Content-Encoding'] = 'gzip';
      } else body = entry.body;
    } else {
      headers.ETag = `"${entry.size.toString(36)}-${Math.round(entry.mtime).toString(36)}"`;
      headers['Last-Modified'] = new Date(entry.mtime).toUTCString();
      if (req.headers['if-none-match'] === headers.ETag) {
        res.writeHead(304, headers);
        res.end();
        return true;
      }
      let file = entry.file;
      let size = entry.size;
      for (const [enc, ext, re] of [['br', '.br', /\bbr\b/], ['gzip', '.gz', /\bgzip\b/]]) {
        if (!re.test(accept)) continue;
        try {
          const st = fs.statSync(entry.file + ext);
          file = entry.file + ext;
          size = st.size;
          headers['Content-Encoding'] = enc;
          break;
        } catch {
          /* no pre-compressed copy */
        }
      }
      headers['Content-Length'] = size;
      stream = file;
    }
    if (body) headers['Content-Length'] = body.length;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    if (stream) {
      const rs = fs.createReadStream(stream);
      rs.on('error', () => res.destroy());
      rs.pipe(res);
    } else res.end(body);
    return true;
  };

  return {
    serve,
    has: (p) => files.has(p),
    get pages() {
      return build.pages || [];
    },
    get build() {
      return build;
    },
    rescan: scan,
  };
}
