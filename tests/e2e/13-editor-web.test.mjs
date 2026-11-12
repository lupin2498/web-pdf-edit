// Browser-specific parts of the editor: the real file picker, dropping
// files, recent files, switching the language, working offline and a site
// without payment methods.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { launchApp, startServer, closeBrowser, ensureFixtures, FIXTURES, OUT, ACTIVE, account, unzipDownload, openDoc, touchDoc, pressInDoc, downloadCount, waitNewDownload, quota, appErrors } from './launch.mjs';

let server;
let ctx;
before(async () => {
  await ensureFixtures();
  server = await startServer({ FREE_PAGES: '8', CONTACT_EMAIL: 'hotro@example.com', PAYMENTS_TEST_MODE: '0' });
  ctx = await launchApp({ server });
});
after(async () => {
  await ctx?.close();
  await server?.close();
  await closeBrowser();
});

test('opens a file with the browser file picker', async () => {
  const { page } = ctx;
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.home-card[data-action="open"]')]);
  assert.equal(chooser.isMultiple(), true);
  await chooser.setFiles(path.join(FIXTURES, 'standard.pdf'));
  await page.waitForFunction(() => window.__app.activeDoc?.session.name === 'standard.pdf', null, { timeout: 20000 });
  await page.waitForSelector(`${ACTIVE} .page canvas`);
});

test('opens a file dropped on the window', async () => {
  const { page } = ctx;
  const bytes = [...fs.readFileSync(path.join(FIXTURES, 'images.pdf'))];
  await page.evaluate((data) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(data)], 'dropped.pdf', { type: 'application/pdf' }));
    document.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, bytes);
  await page.waitForFunction(() => window.__app.activeDoc?.session.name === 'dropped.pdf', null, { timeout: 20000 });
  assert.equal(await page.evaluate(() => window.__app.activeDoc.session.state.pages.length), 3);
  assert.equal(await page.$eval('.drop-overlay', (e) => e.classList.contains('show')), false);
});

test('several pages converted to images arrive as one ZIP file', async () => {
  const { page } = ctx;
  assert.equal((await account(page)).free.remaining, 8);
  await page.click('.ribbon-tab[data-rtab="convert"]');
  await page.click('.rb-btn[data-cmd="toImage"]');
  await page.waitForSelector('.modal');
  await page.click('.modal .btn.primary');
  const names = await unzipDownload(ctx, 'dropped_png.zip', path.join(OUT, '13-images'));
  assert.deepEqual(names.sort(), ['dropped_001.png', 'dropped_002.png', 'dropped_003.png']);
  assert.equal((await account(page)).free.remaining, 5);
  await page.click('.ribbon-tab[data-rtab="home"]');
});

test('recently opened files can be opened again after a reload', async () => {
  const { page } = ctx;
  await page.reload();
  await page.waitForFunction(() => window.__app && window.__app.homeTab);
  await page.waitForSelector('.recent-item');
  const names = await page.$$eval('.recent-item .ri-name', (els) => els.map((e) => e.textContent));
  assert.ok(names.includes('standard.pdf') && names.includes('dropped.pdf'), names.join(','));
  await page.click('.recent-item:has-text("dropped.pdf")');
  await page.waitForFunction(() => window.__app.activeDoc?.session.name === 'dropped.pdf', null, { timeout: 20000 });
  // Clearing the list.
  await page.click('.tab-home');
  await page.click('.home-section-title .btn');
  await page.waitForFunction(() => !document.querySelector('.recent-item'));
  assert.equal(await page.$eval('.home-recent', (e) => e.classList.contains('hidden')), true);
});

test('working offline: downloads use the remembered balance and are reported later', async () => {
  const { page, context } = ctx;
  await openDoc(page, path.join(FIXTURES, 'standard.pdf'));
  await page.waitForFunction(() => Number(document.querySelector('.quota-pill')?.dataset.available) === 5);
  await context.route('**/api/**', (route) => route.abort());
  await touchDoc(page);
  const before = downloadCount(ctx, 'standard.pdf');
  await pressInDoc(page, 'Control+s');
  await waitNewDownload(ctx, 'standard.pdf', before);
  await page.waitForFunction(() => Number(document.querySelector('.quota-pill').dataset.available) === 2);
  await context.unroute('**/api/**');
  assert.equal((await account(page)).free.remaining, 5);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => fetch('/api/me').then((r) => r.json()).then((d) => d.account.free.remaining === 2), null, { timeout: 10000, polling: 300 });
  await page.waitForFunction(() => Number(document.querySelector('.quota-pill').dataset.available) === 2);
  // Reported once only, also when the page reloads.
  await page.reload();
  await page.waitForFunction(() => window.__app && window.__app.homeTab);
  await page.waitForTimeout(800);
  assert.equal((await account(page)).free.remaining, 2);
  assert.equal(await quota(page), 2);
});

test('without payment methods the paywall says how to get in touch', async () => {
  const { page } = ctx;
  await page.click('.buy-btn');
  await page.waitForSelector('.modal.paywall .pw-empty');
  assert.match(await page.textContent('.modal.paywall .pw-empty'), /hotro@example\.com/);
  assert.equal(await page.$('.modal.paywall [data-id="pay"]'), null);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal.paywall', { state: 'detached' });
});

test('switching the language in the settings reloads the editor in that language', async () => {
  const { page } = ctx;
  await page.click('.ribbon-tabs .icon-btn[data-tip="Cài đặt"]');
  await page.waitForSelector('.modal select');
  await page.selectOption('.modal select >> nth=0', 'en');
  await Promise.all([page.waitForEvent('load'), page.click('.modal .btn.primary')]);
  await page.waitForFunction(() => window.__app && window.__app.homeTab);
  assert.equal(await page.textContent('.ribbon-tab[data-rtab="comment"]'), 'Comment');
  assert.equal(await page.getAttribute('html', 'lang'), 'en');
});

test('no errors were logged', () => {
  // Requests refused while offline are expected.
  assert.deepEqual(appErrors(ctx.logs).filter((l) => !/ERR_FAILED/.test(l)), []);
});
