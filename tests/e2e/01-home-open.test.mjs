import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { launchApp, closeBrowser, ensureFixtures, FIXTURES, queueDialog, docState, appErrors } from './launch.mjs';

let ctx;
before(async () => {
  await ensureFixtures();
  ctx = await launchApp();
});
after(async () => {
  await ctx?.app.close();
  await closeBrowser();
});

test('home screen shows the main actions', async () => {
  const { page } = ctx;
  await page.waitForSelector('.home-card');
  const actions = await page.$$eval('.home-card', (els) => els.map((e) => e.dataset.action));
  assert.deepEqual(actions, ['open', 'edit', 'combine', 'organize', 'images', 'blank']);
});

test('opens a PDF from the open card', async () => {
  const { page } = ctx;
  await queueDialog(page, [path.join(FIXTURES, 'standard.pdf')]);
  await page.click('.home-card[data-action="open"]');
  await page.waitForSelector('.doc-view:not(.hidden) .page canvas', { timeout: 20000 });
  const s = await docState(page);
  assert.equal(s.name, 'standard.pdf');
  assert.equal(s.pages.length, 3);
  assert.equal(s.dirty, false);
});

test('zoom shortcuts change the scale', async () => {
  const { page } = ctx;
  const scale = () => page.evaluate(() => window.__app.activeDoc.viewer.scale);
  const s0 = await scale();
  await page.click('.doc-view:not(.hidden) .viewer');
  await page.keyboard.press('Control+=');
  await page.waitForTimeout(200);
  const s1 = await scale();
  assert.ok(s1 > s0, `zoom in ${s0} -> ${s1}`);
  await page.keyboard.press('Control+-');
  await page.keyboard.press('Control+-');
  await page.waitForTimeout(200);
  assert.ok((await scale()) < s1);
});

test('opens a second document in a new tab and switches tabs', async () => {
  const { page } = ctx;
  await queueDialog(page, [path.join(FIXTURES, 'ten-pages.pdf')]);
  await page.keyboard.press('Control+o');
  await page.waitForFunction(() => window.__app.activeDoc && window.__app.activeDoc.session.name === 'ten-pages.pdf', null, { timeout: 20000 });
  assert.equal((await docState(page)).pages.length, 10);
  await page.keyboard.press('Control+Tab');
  const names = await page.evaluate(() => window.__app.tabs.map((t) => (t.kind === 'doc' ? t.view.session.name : t.kind)));
  assert.ok(names.includes('standard.pdf') && names.includes('ten-pages.pdf'));
});

test('asks for the password of an encrypted file and retries on a wrong one', async () => {
  const { page } = ctx;
  await queueDialog(page, [path.join(FIXTURES, 'encrypted.pdf')]);
  await page.keyboard.press('Control+o');
  await page.waitForSelector('.modal input[type=password]', { timeout: 15000 });
  await page.fill('.modal input[type=password]', 'wrong');
  await page.click('.modal .btn.primary');
  await page.waitForTimeout(500);
  await page.waitForSelector('.modal input[type=password]', { timeout: 15000 });
  await page.fill('.modal input[type=password]', 'secret');
  await page.click('.modal .btn.primary');
  await page.waitForFunction(() => window.__app.activeDoc && window.__app.activeDoc.session.name === 'encrypted.pdf', null, { timeout: 20000 });
  await page.waitForSelector('.doc-view:not(.hidden) .page canvas');
});

test('closing an unmodified tab does not ask anything', async () => {
  const { page } = ctx;
  const before = await page.evaluate(() => window.__app.tabs.length);
  await page.click('.doc-view:not(.hidden) .viewer');
  await page.keyboard.press('Control+w');
  await page.waitForFunction((n) => window.__app.tabs.length === n - 1, before, { timeout: 5000 });
  assert.equal(await page.$('.modal'), null);
});

test('creates a blank document', async () => {
  const { page } = ctx;
  await page.evaluate(() => window.__app.activate(window.__app.homeTab));
  await page.click('.home-card[data-action="blank"]');
  await page.waitForSelector('.modal');
  await page.click('.modal .btn.primary');
  await page.waitForFunction(() => window.__app.activeDoc && window.__app.activeDoc.session.state.pages.length >= 1 && window.__app.activeDoc.session.isNewUnsaved, null, { timeout: 15000 });
});

test('closing a modified tab asks to save', async () => {
  const { page } = ctx;
  await page.evaluate(() => {
    const d = window.__app.activeDoc;
    d.session.rotatePages([d.session.state.pages[0].uid], 90);
  });
  await page.click('.doc-view:not(.hidden) .viewer');
  await page.keyboard.press('Control+w');
  await page.waitForSelector('.modal');
  const labels = await page.$$eval('.modal .btn', (els) => els.map((e) => e.textContent));
  assert.equal(labels.length, 3);
  // Discard changes.
  await page.click('.modal .btn.danger');
  await page.waitForFunction(() => !window.__app.activeDoc || !window.__app.activeDoc.session.isNewUnsaved, null, { timeout: 5000 });
});

test('no errors were logged', () => {
  assert.deepEqual(appErrors(ctx.logs), []);
});
