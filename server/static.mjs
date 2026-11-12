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
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
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

/** Escapes text for HTML element content and attribute values. */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Encodings the client accepts (an encoding with q=0 is refused). */
export function acceptedEncodings(header) {
  const out = new Set();
  for (const part of String(header || '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    const q = params.map((x) => x.trim()).find((x) => x.startsWith('q='));
    if (q && !(parseFloat(q.slice(2)) > 0)) continue;
    out.add(name.trim());
  }
  if (out.has('*')) for (const e of ['br', 'gzip']) out.add(e);
  return out;
}

/** If-None-Match comparison (weak, as RFC 9110 requires for GET/HEAD). */
export function etagMatches(header, etag) {
  if (!header) return false;
  const want = etag.replace(/^W\//, '');
  return String(header)
    .split(',')
    .some((t) => {
      const v = t.trim().replace(/^W\//, '');
      return v === '*' || v === want;
    });
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
          // Pre-compressed copies written by the build (sizes, or null).
          const sizeOf = (f) => {
            try {
              return fs.statSync(f).size;
            } catch {
              return null;
            }
          };
          next.set(urlPath, {
            file: full,
            size: st.size,
            mtime: st.mtimeMs,
            type: TYPES[path.extname(e.name).toLowerCase()] || 'application/octet-stream',
            html: e.name.endsWith('.html'),
            br: sizeOf(`${full}.br`),
            gzip: sizeOf(`${full}.gz`),
          });
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
    if (!entry.rendered) {
      const body = Buffer.from(renderHtml(fs.readFileSync(entry.file, 'utf8'), vars), 'utf8');
      entry.rendered = {
        body,
        etag: crypto.createHash('sha1').update(body).digest('base64url').slice(0, 20),
        gzip: zlib.gzipSync(body, { level: 6 }),
        br: zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }),
      };
    }
    return entry.rendered;
  };

  const resolve = (pathname) => {
    let p;
    try {
      p = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (p.includes('\0') || p.split(/[\\/]/).includes('..')) return null;
    if (p.endsWith('/')) return files.has(`${p}index.html`) ? { path: `${p}index.html` } : null;
    if (files.has(p)) return { path: p };
    // The Location keeps the request's own (percent-encoded) spelling: a
    // decoded non-ASCII path is not a valid header value.
    if (files.has(`${p}/index.html`)) return { redirect: `${pathname}/` };
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
    const accepted = acceptedEncodings(req.headers['accept-encoding']);
    const headers = { 'Content-Type': entry.type, 'Cache-Control': cacheControl(hit.path), Vary: 'Accept-Encoding' };
    let body = null;
    let stream = null;
    let encoding = null;
    let tag;
    if (entry.html) {
      const r = htmlBody(entry);
      encoding = accepted.has('br') ? 'br' : accepted.has('gzip') ? 'gzip' : null;
      body = encoding ? r[encoding] : r.body;
      tag = r.etag;
    } else {
      encoding = accepted.has('br') && entry.br !== null ? 'br' : accepted.has('gzip') && entry.gzip !== null ? 'gzip' : null;
      stream = encoding ? `${entry.file}${encoding === 'br' ? '.br' : '.gz'}` : entry.file;
      headers['Content-Length'] = encoding ? entry[encoding] : entry.size;
      headers['Last-Modified'] = new Date(entry.mtime).toUTCString();
      tag = `${entry.size.toString(36)}-${Math.round(entry.mtime).toString(36)}`;
    }
    // Each encoding is a different representation, so it gets its own ETag.
    headers.ETag = `"${tag}${encoding ? `-${encoding}` : ''}"`;
    if (encoding) headers['Content-Encoding'] = encoding;
    if (status === 200 && etagMatches(req.headers['if-none-match'], headers.ETag)) {
      delete headers['Content-Length'];
      res.writeHead(304, headers);
      res.end();
      return true;
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
