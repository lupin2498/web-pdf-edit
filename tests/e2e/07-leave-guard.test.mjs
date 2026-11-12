// Leaving the editor with changes that were not downloaded asks first.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { launchApp, closeBrowser, ensureFixtures, FIXTURES, ACTIVE, touchDoc, pressInDoc, downloadCount, waitNewDownload, appErrors } from './launch.mjs';

let ctx;
const dialogs = [];
before(async () => {
  await ensureFixtures();
  ctx = await launchApp({ files: [path.join(FIXTURES, 'standard.pdf')] });
  ctx.page.on('dialog', (d) => {
    dialogs.push(d.type());
    d.dismiss().catch(() => {});
  });
});
after(async () => {
  await ctx?.close();
  await closeBrowser();
});

test('closing the page with changes asks and can be cancelled', async () => {
  const { page } = ctx;
  // Browsers only ask on pages the user interacted with.
  await page.click(`${ACTIVE} .viewer`, { position: { x: 4, y: 4 } });
  await touchDoc(page);
  await page.close({ runBeforeUnload: true });
  await page.waitForTimeout(800);
  assert.deepEqual(dialogs, ['beforeunload']);
  assert.equal(page.isClosed(), false);
  assert.equal(await page.evaluate(() => window.__app.activeDoc.session.dirty), true);
});

test('"Download as" asks for the file name', async () => {
  const { page } = ctx;
  const before = downloadCount(ctx, 'Hợp đồng mới.pdf');
  await pressInDoc(page, 'Control+Shift+s');
  await page.waitForSelector('.modal input.input');
  assert.equal(await page.inputValue('.modal input.input'), 'standard');
  await page.fill('.modal input.input', 'Hợp đồng: mới');
  await page.click('.modal .btn.primary');
  // Characters that file systems refuse are replaced.
  await waitNewDownload(ctx, 'Hợp đồng mới.pdf', before);
  await page.waitForFunction(() => window.__app.activeDoc.session.name === 'Hợp đồng mới.pdf');
  // Cancelling the name dialog downloads nothing.
  await touchDoc(page);
  const count = ctx.downloads.length;
  await pressInDoc(page, 'Control+Shift+s');
  await page.waitForSelector('.modal input.input');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  assert.equal(ctx.downloads.length, count);
});

test('after downloading, the page closes without asking', async () => {
  const { page } = ctx;
  const before = downloadCount(ctx, 'Hợp đồng mới.pdf');
  await pressInDoc(page, 'Control+s');
  await waitNewDownload(ctx, 'Hợp đồng mới.pdf', before);
  await page.waitForFunction(() => window.__app.activeDoc.session.dirty === false);
  assert.deepEqual(appErrors(ctx.logs), []);
  const closed = new Promise((r) => page.once('close', r));
  await page.close({ runBeforeUnload: true });
  await closed;
  assert.deepEqual(dialogs, ['beforeunload']);
});
