// Starts the server in-process for API tests and provides a tiny HTTP client
// with a cookie jar (one client = one browser).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../server/config.mjs';
import { createApp } from '../../server/app.mjs';

export const BANK_ENV = { BANK_CODE: 'MB', BANK_ACCOUNT: '0123456789', BANK_ACCOUNT_NAME: 'Nguyen Van A', SEPAY_API_KEY: 'sepay-key-123' };

/** A minimal built site so that static serving can be tested without a build. */
export function fakeDist() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfedit-dist-'));
  fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head>%%HEAD_EXTRA%%<link rel="canonical" href="%%SITE_URL%%/"><script type="application/json" id="pe-config">%%PUBLIC_CONFIG%%</script></head><body>home</body></html>');
  fs.writeFileSync(path.join(dir, 'app', 'index.html'), '<!doctype html><html><head><script type="application/json" id="pe-config">%%PUBLIC_CONFIG%%</script></head><body>app</body></html>');
  fs.writeFileSync(path.join(dir, '404.html'), '<!doctype html><html><body>missing</body></html>');
  const js = `console.log(${JSON.stringify('x'.repeat(4000))});`;
  fs.writeFileSync(path.join(dir, 'assets', 'app-ABCD2345.js'), js);
  fs.writeFileSync(path.join(dir, 'assets', 'app-ABCD2345.js.gz'), 'gzip-bytes');
  fs.writeFileSync(path.join(dir, 'assets', 'app-ABCD2345.js.br'), 'br-bytes');
  fs.writeFileSync(path.join(dir, 'assets', 'plain.txt'), 'plain');
  fs.writeFileSync(
    path.join(dir, 'build.json'),
    JSON.stringify({ pages: [{ path: '/', priority: '1.0', alternates: [{ lang: 'vi', path: '/' }, { lang: 'en', path: '/en/' }] }, { path: '/app/' }, { path: '/admin/', index: false }], manifest: {} }),
  );
  return dir;
}

export async function startApp(env = {}, { clock, fetchImpl } = {}) {
  const dist = env.DIST_DIR || fakeDist();
  const config = loadConfig({ DATA_DIR: ':memory:', PORT: '0', DIST_DIR: dist, ...env });
  const logs = [];
  const log = { info: (...a) => logs.push(['info', a.join(' ')]), warn: (...a) => logs.push(['warn', a.join(' ')]), error: (...a) => logs.push(['error', a.map((x) => (x && x.stack) || x).join(' ')]) };
  const app = await createApp(config, { clock, fetchImpl, log });
  const server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    app,
    config,
    url,
    logs,
    billing: app.billing,
    client: (headers = {}) => createClient(url, headers),
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      app.close();
      if (!env.DIST_DIR) fs.rmSync(dist, { recursive: true, force: true });
    },
  };
}

export function createClient(base, defaultHeaders = {}) {
  const jar = new Map();
  const request = async (method, pathname, { body, headers = {}, raw = false, redirect = 'manual' } = {}) => {
    const h = { ...defaultHeaders, ...headers };
    if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload;
    if (body !== undefined) {
      if (typeof body === 'string' || body instanceof Uint8Array) payload = body;
      else {
        payload = JSON.stringify(body);
        if (!Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['content-type'] = 'application/json';
      }
    }
    const res = await fetch(base + pathname, { method, headers: h, body: payload, redirect });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    let json = null;
    if (!raw) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: res.status, headers: res.headers, text, json };
  };
  return {
    jar,
    get: (p, o) => request('GET', p, o),
    post: (p, body, o = {}) => request('POST', p, { body: body === undefined ? {} : body, ...o }),
    request,
  };
}

let opCounter = 0;
export const opId = () => `test-op-${Date.now().toString(36)}-${++opCounter}`.padEnd(16, '0');

/** A clock that tests can move forward. */
export function fakeClock(start = Date.UTC(2026, 10, 12, 3, 0, 0)) {
  let now = start;
  const fn = () => now;
  fn.advance = (ms) => {
    now += ms;
    return now;
  };
  fn.set = (ms) => {
    now = ms;
  };
  return fn;
}
