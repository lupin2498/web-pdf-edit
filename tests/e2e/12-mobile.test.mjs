// The editor on a phone (iPhone 13 emulation, touch input).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { launchApp, closeBrowser, ensureFixtures, FIXTURES, ACTIVE, devices, openDoc, touchDoc, downloadCount, waitNewDownload, appErrors } from './launch.mjs';

let ctx;
let cdp;
before(async () => {
  await ensureFixtures();
  ctx = await launchApp({ context: { ...devices['iPhone 13'] } });
  cdp = await ctx.context.newCDPSession(ctx.page);
  await openDoc(ctx.page, path.join(FIXTURES, 'ten-pages.pdf'));
});
after(async () => {
  await ctx?.close();
  await closeBrowser();
});

const scale = (page) => page.evaluate(() => window.__app.activeDoc.viewer.scale);
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });

test('the side panels start closed and nothing overflows the screen', async () => {
  const { page } = ctx;
  assert.equal(await page.$eval(`${ACTIVE} .side-panel`, (e) => e.classList.contains('hidden')), true);
  assert.equal(await page.$eval(`${ACTIVE} .props-panel`, (e) => e.classList.contains('hidden')), true);
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  assert.ok(sw <= cw, `${sw} > ${cw}`);
  // The page uses most of the width.
  const box = await page.locator(`${ACTIVE} .page`).first().boundingBox();
  assert.ok(box.width > cw * 0.8, `page is ${box.width}px wide`);
});

test('the download button stays visible and downloads the edited file', async () => {
  const { page } = ctx;
  await touchDoc(page);
  const btn = page.locator('.download-btn');
  await btn.waitFor({ state: 'visible' });
  const b = await btn.boundingBox();
  const cw = await page.evaluate(() => document.documentElement.clientWidth);
  assert.ok(b.x >= 0 && b.x + b.width <= cw + 1, `download button at ${b.x}..${b.x + b.width}`);
  const before = downloadCount(ctx, 'ten-pages.pdf');
  await btn.tap();
  await waitNewDownload(ctx, 'ten-pages.pdf', before);
});

test('the thumbnails open over the document and close when a page is picked', async () => {
  const { page } = ctx;
  await page.tap(`${ACTIVE} .rail-btn[data-panel="thumbnails"]`);
  await page.waitForSelector(`${ACTIVE} .side-panel:not(.hidden) .thumb canvas, ${ACTIVE} .side-panel:not(.hidden) .thumb img`, { timeout: 15000 });
  assert.equal(await page.$eval(`${ACTIVE} .side-panel`, (e) => getComputedStyle(e).position), 'absolute');
  await page.locator(`${ACTIVE} .side-panel .thumb`).nth(2).tap();
  await page.waitForFunction((sel) => document.querySelector(sel).classList.contains('hidden'), `${ACTIVE} .side-panel`, { timeout: 5000 });
  await page.waitForFunction(() => window.__app.activeDoc.viewer.currentIndex === 2, null, { timeout: 5000 });
});

test('pinching with two fingers zooms the document', async () => {
  const { page } = ctx;
  const s0 = await scale(page);
  const y = 420;
  await touch('touchStart', [
    [150, y],
    [240, y],
  ]);
  for (let i = 1; i <= 6; i++) {
    await touch('touchMove', [
      [150 - i * 12, y],
      [240 + i * 12, y],
    ]);
    await page.waitForTimeout(30);
  }
  await touch('touchEnd', []);
  await page.waitForTimeout(300);
  const s1 = await scale(page);
  assert.ok(s1 > s0 * 1.4, `scale ${s0} -> ${s1}`);
  // The page itself did not zoom.
  assert.equal(await page.evaluate(() => window.visualViewport.scale), 1);
  // Pinching in again.
  await touch('touchStart', [
    [80, y],
    [310, y],
  ]);
  for (let i = 1; i <= 6; i++) {
    await touch('touchMove', [
      [80 + i * 15, y],
      [310 - i * 15, y],
    ]);
    await page.waitForTimeout(30);
  }
  await touch('touchEnd', []);
  await page.waitForTimeout(300);
  assert.ok((await scale(page)) < s1, 'zoomed out');
});

test('with the hand tool, a tap does not block scrolling', async () => {
  const { page } = ctx;
  await page.tap('.rb-btn[data-cmd="hand"]');
  await page.waitForFunction(() => window.__app.activeDoc.tools.tool === 'hand');
  const viewer = `${ACTIVE} .viewer`;
  const box = await page.locator(viewer).boundingBox();
  await page.tap(viewer, { position: { x: box.width / 2, y: box.height / 2 } });
  assert.equal(await page.$eval(viewer, (e) => e.classList.contains('panning')), false);
  // A one-finger drag scrolls the document natively.
  const top0 = await page.$eval(viewer, (e) => e.scrollTop);
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height * 0.7);
  await touch('touchStart', [[x, y]]);
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', [[x, y - i * 30]]);
    await page.waitForTimeout(16);
  }
  await touch('touchEnd', []);
  await page.waitForTimeout(500);
  const top1 = await page.$eval(viewer, (e) => e.scrollTop);
  assert.ok(top1 > top0 + 100, `scrollTop ${top0} -> ${top1}`);
  assert.equal(await page.$eval(viewer, (e) => e.classList.contains('panning')), false);
});

test('the paywall fits the phone screen', async () => {
  const { page } = ctx;
  await page.tap('.buy-btn');
  await page.waitForSelector('.modal.paywall .pw-pack');
  const cw = await page.evaluate(() => document.documentElement.clientWidth);
  const box = await page.locator('.modal.paywall').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= cw, `paywall ${box.x}..${box.x + box.width} on ${cw}`);
  const pay = page.locator('.modal.paywall [data-id="pay"]');
  await pay.scrollIntoViewIfNeeded();
  assert.equal(await pay.isVisible(), true);
  await page.tap('.modal.paywall [data-id="later"]');
  await page.waitForSelector('.modal.paywall', { state: 'detached' });
});

test('no errors were logged', () => {
  assert.deepEqual(appErrors(ctx.logs), []);
});
