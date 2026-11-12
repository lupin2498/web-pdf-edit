import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { launchApp, closeBrowser, ensureFixtures, FIXTURES, OUT, queueDialog, docState, waitToast, waitDownload, unzipDownload, clearToasts, appErrors } from './launch.mjs';
import { pdfText, hasPoppler } from '../unit/helpers.mjs';

const ACTIVE = '.doc-view:not(.hidden)';
const ITEM = `${ACTIVE} .org-item`;
let ctx;
before(async () => {
  await ensureFixtures();
  ctx = await launchApp({ files: [path.join(FIXTURES, 'ten-pages.pdf')] });
  await ctx.page.waitForSelector(`${ACTIVE} .page canvas`, { timeout: 20000 });
});
after(async () => {
  await ctx?.app.close();
  await closeBrowser();
});

// Page labels: original page number, "r<deg>" when rotated, "B" for blank pages.
const order = async (page) => (await docState(page)).pages.map((p) => (p.src ? `${p.src.index + 1}${p.rotate ? `r${p.rotate}` : ''}` : 'B'));

test('organizer shows all pages', async () => {
  const { page } = ctx;
  await page.click('.ribbon-tab[data-rtab="page"]');
  await page.waitForSelector(`${ITEM} canvas`, { timeout: 10000 });
  assert.equal(await page.$$eval(ITEM, (els) => els.length), 10);
});

test('rotates the selected page', async () => {
  const { page } = ctx;
  await page.click(`${ITEM} >> nth=1`);
  await page.click('.rb-btn[data-cmd="rotR"]');
  assert.deepEqual((await order(page)).slice(0, 3), ['1', '2r90', '3']);
});

test('deletes the selected page', async () => {
  const { page } = ctx;
  await page.click(`${ITEM} >> nth=2`);
  await page.click('.rb-btn[data-cmd="delete"]');
  await page.waitForTimeout(300);
  assert.deepEqual(await order(page), ['1', '2r90', '4', '5', '6', '7', '8', '9', '10']);
  assert.equal(await page.$$eval(ITEM, (els) => els.length), 9);
});

test('moves a page by drag and drop', async () => {
  const { page } = ctx;
  const items = page.locator(ITEM);
  const box = await items.nth(3).boundingBox();
  await items.nth(0).dragTo(items.nth(3), { targetPosition: { x: box.width - 10, y: box.height / 2 } });
  await page.waitForTimeout(400);
  const o = await order(page);
  assert.equal(o.length, 9);
  assert.notEqual(o[0], '1');
  assert.ok(Math.abs(o.indexOf('1') - o.indexOf('5')) === 1, o.join(','));
});

test('duplicates multiple selected pages', async () => {
  const { page } = ctx;
  const before = await order(page);
  await page.click(`${ITEM} >> nth=0`);
  await page.click(`${ITEM} >> nth=1`, { modifiers: ['Control'] });
  await page.click('.rb-btn[data-cmd="dup"]');
  await page.waitForTimeout(300);
  const o = await order(page);
  assert.equal(o.length, before.length + 2);
  for (const label of before.slice(0, 2)) assert.equal(o.filter((x) => x === label).length, 2, o.join(','));
});

test('inserts a blank page after the selection', async () => {
  const { page } = ctx;
  await page.click(`${ITEM} >> nth=0`);
  await page.click('.rb-btn[data-cmd="insert"]');
  await page.click('.menu-item >> nth=0');
  await page.waitForSelector('.modal');
  await page.click('.modal .btn.primary');
  await page.waitForTimeout(400);
  const o = await order(page);
  assert.equal(o[1], 'B', o.join(','));
});

test('reverses all pages and undo restores the order', async () => {
  const { page } = ctx;
  const before = await order(page);
  await page.click(`${ITEM} >> nth=0`);
  await page.click('.rb-btn[data-cmd="reverse"]');
  await page.waitForTimeout(300);
  assert.deepEqual(await order(page), [...before].reverse());
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  assert.deepEqual(await order(page), before);
});

test('saves pages in the new order with rotation', async () => {
  const { page } = ctx;
  const expected = await order(page);
  const out = path.join(OUT, '04-pages.pdf');
  fs.rmSync(out, { force: true });
  await queueDialog(page, out);
  await page.keyboard.press('Control+Shift+S');
  await waitToast(page, /04-pages/);
  await waitDownload(ctx, out);
  const bytes = fs.readFileSync(out);
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), expected.length);
  expected.forEach((label, i) => {
    const rot = doc.getPage(i).getRotation().angle;
    assert.equal(rot, label.endsWith('r90') ? 90 : 0, `page ${i + 1} (${label})`);
  });
  if (hasPoppler()) {
    expected.forEach((label, i) => {
      const text = pdfText(bytes, { page: i + 1 }).trim();
      const want = label === 'B' ? '' : `PAGE-${parseInt(label, 10)}`;
      assert.equal(text, want, `page ${i + 1}`);
    });
  }
});

test('extracts a page range to a new file', async () => {
  const { page } = ctx;
  await clearToasts(page);
  const out = path.join(OUT, '04-extract.pdf');
  fs.rmSync(out, { force: true });
  await queueDialog(page, out);
  await page.click('.rb-btn[data-cmd="extract"]');
  await page.waitForSelector('.modal');
  await page.fill('.modal input.input', '2-4');
  await page.click('.modal .btn.primary');
  await waitToast(page);
  await waitDownload(ctx, out);
  const doc = await PDFDocument.load(fs.readFileSync(out));
  assert.equal(doc.getPageCount(), 3);
});

test('splits the document every 4 pages', async () => {
  const { page } = ctx;
  await clearToasts(page);
  const dir = path.join(OUT, '04-split');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const n = (await order(page)).length;
  await queueDialog(page, dir);
  await page.click('.rb-btn[data-cmd="split"]');
  await page.waitForSelector('.modal');
  await page.fill('.modal input[type=number]', '4');
  await page.click('.modal .btn.primary');
  await waitToast(page);
  // In the browser the parts arrive as one ZIP download.
  await unzipDownload(ctx, '04-pages_tach.zip', dir);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.pdf')).sort();
  assert.equal(files.length, Math.ceil(n / 4));
  let total = 0;
  for (const f of files) total += (await PDFDocument.load(fs.readFileSync(path.join(dir, f)))).getPageCount();
  assert.equal(total, n);
});

test('no errors were logged', () => {
  assert.deepEqual(appErrors(ctx.logs), []);
});
