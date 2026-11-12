// Helpers for the browser end-to-end tests: start the server in-process,
// open the site in Chromium (Playwright) and collect downloads.
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { unzipSync } from 'fflate';
import { loadConfig } from '../../server/config.mjs';
import { createApp } from '../../server/app.mjs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright-core');
export { devices };
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'generated');
export const OUT = path.join(ROOT, 'tests', 'output', 'e2e');
fs.mkdirSync(OUT, { recursive: true });

// A pre-installed browser (CI images, cloud sessions) is used when present.
const SYSTEM_CHROMIUM = process.env.PW_CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);

export async function ensureFixtures() {
  if (!fs.existsSync(path.join(FIXTURES, 'ten-pages.pdf'))) {
    const mod = await import('../fixtures/make-fixtures.mjs');
    await mod.makeFixtures();
  }
}

/** Starts the web server on a free port. `env` overrides the configuration. */
export async function startServer(env = {}, options = {}) {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'build.json'))) throw new Error('No build found: run "npm run build" before the e2e tests.');
  const config = loadConfig({ DATA_DIR: ':memory:', PORT: '0', FREE_PAGES: '100000', FREE_IP_DAILY_PAGES: '0', PAYMENTS_TEST_MODE: '1', ...env });
  const logs = [];
  const log = { info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.map((x) => (x && x.stack) || x).join(' ')) };
  const app = await createApp(config, { log, ...options });
  const server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    app,
    config,
    url,
    logs,
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      app.close();
    },
  };
}

// Disk path of a test file -> URL the page can fetch it from.
export function fileUrl(p) {
  const rel = path.relative(ROOT, path.resolve(p));
  if (rel.startsWith('..')) throw new Error(`Test files must live inside the repository: ${p}`);
  return `/__fixtures/${rel.split(path.sep).map(encodeURIComponent).join('/')}`;
}

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) browserPromise = chromium.launch({ executablePath: SYSTEM_CHROMIUM || undefined, args: ['--no-sandbox'] });
  return browserPromise;
}

/**
 * Opens the editor (or another page of the site) in a fresh browser context.
 *
 *   files     documents to open right away (disk paths)
 *   env       server configuration overrides
 *   server    reuse a server started with startServer()
 *   pagePath  page to load (default: the editor)
 *   context   extra Playwright context options (viewport, device...)
 */
export async function launchApp({ files = [], env = {}, server = null, pagePath = '/app/', context = {}, serverOptions = {} } = {}) {
  const srv = server || (await startServer(env, serverOptions));
  const browser = await getBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true, locale: 'vi-VN', ...context });
  const logs = [];
  const downloads = [];
  const attach = (page) => {
    page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
    page.on('download', (d) => {
      const item = { name: d.suggestedFilename(), file: path.join(OUT, d.suggestedFilename()), done: false, error: null };
      downloads.push(item);
      d.saveAs(item.file).then(
        () => (item.done = true),
        (e) => {
          item.error = e;
          item.done = true;
        },
      );
    });
  };
  ctx.on('page', attach);
  // Test documents are served straight from the repository.
  await ctx.route('**/__fixtures/**', (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/__fixtures\//, ''));
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ body: fs.readFileSync(file), contentType: 'application/octet-stream' });
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__PE_TEST__ = true;
    const orig = console.error.bind(console);
    console.error = (...a) => orig(...a.map((x) => (x && x.stack ? x.stack : x)));
    window.addEventListener('unhandledrejection', (e) => orig('[unhandledrejection]', e.reason && (e.reason.stack || e.reason)));
  });
  await page.goto(srv.url + pagePath, { waitUntil: 'load' });
  if (pagePath.startsWith('/app')) {
    await page.waitForFunction(() => window.__app && window.__app.homeTab, null, { timeout: 30000 });
    if (files.length) {
      await page.evaluate((urls) => window.__app.openPaths(urls), files.map(fileUrl));
      await page.waitForSelector('.doc-view:not(.hidden) .page canvas', { timeout: 30000 });
    }
  }
  const result = {
    page,
    context: ctx,
    logs,
    downloads,
    server: srv,
    url: srv.url,
    billing: srv.app.billing,
    async close() {
      await ctx.close().catch(() => {});
      if (!server) await srv.close();
    },
  };
  // Tests written for the desktop app call ctx.app.close().
  result.app = { close: () => result.close() };
  return result;
}

export async function closeBrowser() {
  if (!browserPromise) return;
  const b = await browserPromise;
  browserPromise = null;
  await b.close().catch(() => {});
}

// Answers the next file dialogs with the given results (in order): arrays of
// disk paths for "open", a disk path for "save", null to cancel.
export const queueDialog = (page, ...results) =>
  page.evaluate(
    (r) => window.api.test.queueDialog(r),
    results.map((r) => (Array.isArray(r) ? r.map(fileUrl) : r)),
  );

/** Waits until the browser finished downloading `name` and returns its path. */
export async function waitDownload(ctx, nameOrPath, timeout = 30000) {
  const name = path.basename(nameOrPath);
  const start = Date.now();
  for (;;) {
    const item = [...ctx.downloads].reverse().find((d) => d.name === name);
    if (item && item.done) {
      if (item.error) throw item.error;
      return item.file;
    }
    if (Date.now() - start > timeout) throw new Error(`Download "${name}" did not arrive (got: ${ctx.downloads.map((d) => d.name).join(', ') || 'nothing'})`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Waits for a ZIP download and unpacks it into `dir`; returns the file names. */
export async function unzipDownload(ctx, name, dir) {
  const file = await waitDownload(ctx, name);
  const entries = unzipSync(new Uint8Array(fs.readFileSync(file)));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [n, data] of Object.entries(entries)) fs.writeFileSync(path.join(dir, n), data);
  return Object.keys(entries);
}

export const pageBox = async (page, i = 0) => (await page.$$('.page'))[i].boundingBox();

export const docState = (page) =>
  page.evaluate(() => {
    const d = window.__app.activeDoc;
    if (!d) return null;
    return JSON.parse(JSON.stringify({ name: d.session.name, dirty: d.session.dirty, pages: d.session.state.pages, outline: d.session.state.outline }));
  });

export async function waitToast(page, re = null, timeout = 20000) {
  await page.waitForFunction(
    ([src, flags]) => {
      const rx = src ? new RegExp(src, flags) : null;
      return [...document.querySelectorAll('.toast.success')].some((t) => !rx || rx.test(t.textContent));
    },
    [re ? re.source : null, re ? re.flags : ''],
    { timeout },
  );
}

export async function clearToasts(page) {
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
}

// Console errors that indicate a bug in the app (ignores browser noise).
export function appErrors(logs) {
  return logs.filter((l) => /^\[(pageerror|error)\]/.test(l) && !/Autofill|DevTools|favicon|ERR_BLOCKED_BY_CLIENT|adsbygoogle/.test(l));
}

export const account = (page) => page.evaluate(() => fetch('/api/me', { cache: 'no-store' }).then((r) => r.json()).then((d) => d.account));
