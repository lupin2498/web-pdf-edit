import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { launchApp, closeBrowser, ensureFixtures, FIXTURES, OUT, ROOT, queueDialog, docState, waitToast, waitDownload, appErrors } from './launch.mjs';
import { pdfText, hasPoppler } from '../unit/helpers.mjs';

const ACTIVE = '.doc-view:not(.hidden)';
let ctx;
before(async () => {
  await ensureFixtures();
  ctx = await launchApp();
  await ctx.page.waitForSelector('.home-card');
});
after(async () => {
  await ctx?.app.close();
  await closeBrowser();
});

test('combines PDFs and an image with page ranges', async () => {
  const { page } = ctx;
  await page.click('.home-card[data-action="combine"]');
  await page.waitForSelector('.modal');
  await queueDialog(page, [path.join(FIXTURES, 'standard.pdf'), path.join(FIXTURES, 'unicode.pdf'), path.join(ROOT, 'tests', 'fixtures', 'sample.jpg')]);
  await page.click('.modal .form-inline .btn >> nth=0');
  await page.waitForFunction(() => document.querySelectorAll('.modal .file-row').length === 3, null, { timeout: 15000 });
  await page.fill('.modal .file-row >> nth=0 >> input', '1-2');
  // Move the image to the top.
  await page.click('.modal .file-row >> nth=2 >> button >> nth=0');
  const names = await page.$$eval('.modal .file-row .fr-name', (els) => els.map((e) => e.textContent));
  assert.match(names[1], /sample\.jpg/);
  await page.click('.modal .btn.primary');
  await page.waitForFunction(() => window.__app.activeDoc && window.__app.activeDoc.session.state.pages.length === 4, null, { timeout: 20000 });
  const s = await docState(page);
  assert.ok(s.dirty);
  // One bookmark per combined file.
  const bookmarks = await page.evaluate(async () => {
    const d = window.__app.activeDoc;
    await d.outline.load();
    return d.outline.items.map((it) => it.title);
  });
  assert.deepEqual(bookmarks, ['standard', 'sample.jpg', 'unicode']);
});

test('adds a watermark, header/footer and Bates numbers', async () => {
  const { page } = ctx;
  await page.click('.ribbon-tab[data-rtab="edit"]');
  for (const cmd of ['watermark', 'headerFooter', 'bates']) {
    await page.click(`.rb-btn[data-cmd="${cmd}"]`);
    await page.click('.menu-item >> nth=0');
    await page.waitForSelector('.modal');
    await page.click('.modal .btn.primary');
    await page.waitForSelector('.modal', { state: 'detached' });
  }
  const s = await docState(page);
  for (const p of s.pages) {
    const kinds = (p.objects || []).map((o) => o.type).sort();
    assert.deepEqual(kinds, ['bates', 'headerFooter', 'watermark']);
  }
});

test('search finds matches across pages', async () => {
  const { page } = ctx;
  await page.click(`${ACTIVE} .viewer`);
  await page.keyboard.press('Control+f');
  await page.fill(`${ACTIVE} .search-box input[type=search]`, 'quick');
  await page.waitForFunction((sel) => /\b2\b/.test(document.querySelector(sel)?.textContent || ''), `${ACTIVE} .search-status`, { timeout: 10000 });
});

test('marks search results for redaction and applies them', async () => {
  const { page } = ctx;
  await page.click(`${ACTIVE} .search-box .btn.redact-results`);
  await page.waitForTimeout(300);
  let s = await docState(page);
  assert.equal(s.pages.flatMap((p) => p.objects || []).filter((o) => o.type === 'redact').length, 2);
  await page.click('.ribbon-tab[data-rtab="protect"]');
  await page.click('.rb-btn[data-cmd="applyRedact"]');
  await page.click('.modal .btn.danger');
  await page.waitForTimeout(800);
  s = await docState(page);
  assert.equal(s.pages.flatMap((p) => p.objects || []).filter((o) => o.type === 'redact').length, 0);
});

test('sets an open password and saves an encrypted file', async () => {
  const { page } = ctx;
  await page.click('.rb-btn[data-cmd="password"]');
  await page.waitForSelector('.modal');
  const inputs = await page.$$('.modal input[type=password]');
  await inputs[0].fill('abc123');
  await inputs[1].fill('abc123');
  await page.click('.modal .btn.primary');
  const out = path.join(OUT, '05-combined.pdf');
  fs.rmSync(out, { force: true });
  await queueDialog(page, out);
  await page.keyboard.press('Control+s');
  await waitToast(page, /05-combined/);
  await waitDownload(ctx, out);
  const bytes = fs.readFileSync(out);
  await assert.rejects(PDFDocument.load(bytes), /encrypted/i);
  if (hasPoppler()) {
    const text = pdfText(bytes, { password: 'abc123' });
    assert.doesNotMatch(text, /quick/);
    assert.match(text, /brown fox/);
    assert.match(text, /Xin chào thế giới/);
    assert.match(text.replace(/\s+/g, ''), /BẢNNHÁP|DRAFT/);
  }
});

test('reopens the encrypted file with its password', async () => {
  const { page } = ctx;
  await page.click(`${ACTIVE} .viewer`);
  await page.keyboard.press('Control+w');
  await page.waitForFunction(() => !window.__app.activeDoc, null, { timeout: 5000 });
  await queueDialog(page, [path.join(OUT, '05-combined.pdf')]);
  await page.keyboard.press('Control+o');
  await page.waitForSelector('.modal input[type=password]', { timeout: 10000 });
  await page.fill('.modal input[type=password]', 'abc123');
  await page.click('.modal .btn.primary');
  await page.waitForFunction(() => window.__app.activeDoc?.session.name === '05-combined.pdf', null, { timeout: 10000 });
  await page.waitForSelector(`${ACTIVE} .page canvas`, { timeout: 10000 });
  assert.equal((await docState(page)).pages.length, 4);
});

test('saving the reopened file keeps its open password', async () => {
  const { page } = ctx;
  await page.evaluate(() => {
    const d = window.__app.activeDoc;
    d.session.rotatePages([d.session.state.pages[0].uid], 90);
  });
  const out = path.join(OUT, '05-resaved.pdf');
  fs.rmSync(out, { force: true });
  await queueDialog(page, out);
  await page.keyboard.press('Control+Shift+S');
  await waitToast(page, /05-resaved/);
  await waitDownload(ctx, out);
  const bytes = fs.readFileSync(out);
  await assert.rejects(PDFDocument.load(bytes), /encrypted/i);
  if (hasPoppler()) {
    assert.throws(() => pdfText(bytes));
    assert.match(pdfText(bytes, { password: 'abc123' }), /brown fox/);
  }
});

test('no errors were logged', () => {
  assert.deepEqual(appErrors(ctx.logs), []);
});
