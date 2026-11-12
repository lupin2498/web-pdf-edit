import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { launchApp, closeBrowser, OUT, queueDialog, waitToast, waitDownload, appErrors } from './launch.mjs';
import { hasPoppler } from '../unit/helpers.mjs';

const ACTIVE = '.doc-view:not(.hidden)';

async function protectedPdf(file, permissions) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText('Protected document', { x: 60, y: 780, size: 18, font });
  await doc.encrypt({ userPassword: '', ownerPassword: 'owner-pw', permissions: { printing: true, modifying: true, copying: true, annotating: true, fillingForms: true, contentAccessibility: true, documentAssembly: true, ...permissions } });
  fs.writeFileSync(file, await doc.save());
  return file;
}

let ctx;
let noPrint;
let noModify;
before(async () => {
  noPrint = await protectedPdf(path.join(OUT, '08-no-print.pdf'), { printing: false });
  noModify = await protectedPdf(path.join(OUT, '08-no-modify.pdf'), { modifying: false });
  ctx = await launchApp({ files: [noPrint] });
  await ctx.page.waitForSelector(`${ACTIVE} .page canvas`, { timeout: 20000 });
});
after(async () => {
  await ctx?.app.close();
  await closeBrowser();
});

test('saving keeps the permission restrictions of the original', { skip: !hasPoppler() && 'poppler not installed' }, async () => {
  const { page } = ctx;
  await page.evaluate(() => {
    const d = window.__app.activeDoc;
    d.session.rotatePages([d.session.state.pages[0].uid], 90);
  });
  const out = path.join(OUT, '08-no-print-saved.pdf');
  fs.rmSync(out, { force: true });
  await queueDialog(page, out);
  await page.keyboard.press('Control+Shift+S');
  await waitToast(page, /08-no-print-saved/);
  await waitDownload(ctx, out);
  const info = execFileSync('pdfinfo', [out], { encoding: 'utf8' });
  assert.match(info, /Encrypted:\s+yes \(print:no/);
});

test('a document that forbids changes opens read-only until unlocked', async () => {
  const { page } = ctx;
  await queueDialog(page, [noModify]);
  await page.keyboard.press('Control+o');
  await page.waitForFunction(() => window.__app.activeDoc?.session.name === '08-no-modify.pdf', null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => window.__app.activeDoc.isReadOnly()), true);
  await page.click(`${ACTIVE} .banner .btn, ${ACTIVE} .doc-banner .btn`);
  await page.waitForSelector('.modal input[type=password]');
  await page.fill('.modal input[type=password]', 'owner-pw');
  await page.click('.modal .btn.primary');
  await page.waitForFunction(() => !window.__app.activeDoc.isReadOnly(), null, { timeout: 5000 });
});

test('no errors were logged', () => {
  assert.deepEqual(appErrors(ctx.logs), []);
});
