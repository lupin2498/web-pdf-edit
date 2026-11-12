// Free pages, the paywall, buying pages (test payment and bank transfer),
// restore codes and ads in the editor.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { PDFDocument } from '@cantoo/pdf-lib';
import {
  launchApp,
  startServer,
  closeBrowser,
  ensureFixtures,
  FIXTURES,
  OUT,
  ACTIVE,
  queueDialog,
  account,
  openDoc,
  downloadCount,
  waitNewDownload,
  quota,
  sepayWebhook,
  pressInDoc,
  touchDoc,
  waitToast,
  clearToasts,
  appErrors,
} from './launch.mjs';

const SEPAY_KEY = 'sepay-test-key-123';
const ENV = {
  FREE_PAGES: '5',
  FREE_IP_DAILY_PAGES: '0',
  PAYMENTS_TEST_MODE: '1',
  BANK_CODE: 'MB',
  BANK_ACCOUNT: '0123456789',
  BANK_ACCOUNT_NAME: 'Nguyen Van A',
  SEPAY_API_KEY: SEPAY_KEY,
};

let server;
let ctx;
before(async () => {
  await ensureFixtures();
  server = await startServer(ENV);
  ctx = await launchApp({ server });
});
after(async () => {
  await ctx?.close();
  await server?.close();
  await closeBrowser();
});

const paywall = '.modal.paywall';
const waitQuota = (page, n) => page.waitForFunction((v) => Number(document.querySelector('.quota-pill')?.dataset.available) === v, n, { timeout: 15000 });
const closePaywall = async (page) => {
  await page.click(`${paywall} [data-id="later"]`);
  await page.waitForSelector(paywall, { state: 'detached' });
};

test('the header shows the free pages', async () => {
  const { page } = ctx;
  await waitQuota(page, 5);
  assert.match(await page.textContent('.quota-pill'), /5 trang miễn phí/);
  const a = await account(page);
  assert.equal(a.free.remaining, 5);
  assert.equal(a.credits, 0);
});

test('a document longer than the free pages opens the paywall and nothing is charged', async () => {
  const { page } = ctx;
  await openDoc(page, path.join(FIXTURES, 'ten-pages.pdf'));
  await touchDoc(page);
  const before = downloadCount(ctx, 'ten-pages.pdf');
  await pressInDoc(page, 'Control+s');
  await page.waitForSelector(`${paywall} .pw-need`, { timeout: 10000 });
  const need = await page.textContent(`${paywall} .pw-need`);
  assert.match(need, /10 trang/);
  assert.match(need, /thiếu 5 trang/);
  // The smallest pack that covers the missing pages is preselected.
  assert.equal(await page.getAttribute(`${paywall} .pw-pack.active`, 'data-pack'), 'p20');
  assert.ok(await page.$(`${paywall} .pw-pack.active .pw-covers`));
  await closePaywall(page);
  await page.waitForTimeout(500);
  assert.equal(downloadCount(ctx, 'ten-pages.pdf'), before);
  assert.equal((await account(page)).free.remaining, 5);
  assert.equal(await page.$('.busy'), null);
});

test('a short changed document downloads with free pages', async () => {
  const { page } = ctx;
  await clearToasts(page);
  await openDoc(page, path.join(FIXTURES, 'standard.pdf'));
  await touchDoc(page);
  const before = downloadCount(ctx, 'standard.pdf');
  await pressInDoc(page, 'Control+s');
  const file = await waitNewDownload(ctx, 'standard.pdf', before);
  assert.equal((await PDFDocument.load(fs.readFileSync(file))).getPageCount(), 3);
  await waitQuota(page, 2);
  assert.equal((await account(page)).free.remaining, 2);
  await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /3 trang miễn phí/.test(t.textContent)));
  assert.equal(await page.evaluate(() => window.__app.activeDoc.session.dirty), false);
});

test('downloading the same pages again costs nothing', async () => {
  const { page } = ctx;
  await touchDoc(page);
  const before = downloadCount(ctx, 'standard.pdf');
  await pressInDoc(page, 'Control+s');
  await waitNewDownload(ctx, 'standard.pdf', before);
  await page.waitForTimeout(300);
  assert.equal((await account(page)).free.remaining, 2);
  // Downloading without any change is free as well.
  await pressInDoc(page, 'Control+s');
  await waitNewDownload(ctx, 'standard.pdf', before + 1);
  assert.equal((await account(page)).free.remaining, 2);
});

test('extracting pages that were paid for costs nothing, new pages do', async () => {
  const { page } = ctx;
  await clearToasts(page);
  const out = path.join(OUT, '10-extract.pdf');
  const before = downloadCount(ctx, '10-extract.pdf');
  await queueDialog(page, out);
  await page.click('.ribbon-tab[data-rtab="page"]');
  await page.click('.rb-btn[data-cmd="extract"]');
  await page.waitForSelector('.modal');
  await page.fill('.modal input.input', '1-2');
  await page.click('.modal .btn.primary');
  await waitNewDownload(ctx, '10-extract.pdf', before);
  assert.equal((await account(page)).free.remaining, 2);
  // A blank page is new: converting the document to text charges only it.
  await page.evaluate(() => window.__app.activeDoc.session.insertBlank(3, 595, 842, 1));
  await page.click('.ribbon-tab[data-rtab="convert"]');
  const txt = path.join(OUT, '10-standard.txt');
  const beforeTxt = downloadCount(ctx, '10-standard.txt');
  await queueDialog(page, txt);
  await page.click('.rb-btn[data-cmd="toText"]');
  await waitNewDownload(ctx, '10-standard.txt', beforeTxt);
  await waitQuota(page, 1);
  assert.equal((await account(page)).free.remaining, 1);
  await page.click('.ribbon-tab[data-rtab="home"]');
});

test('buying a pack lets the long download finish', async () => {
  const { page } = ctx;
  await clearToasts(page);
  // Back to the 10-page document.
  await page.click('.tab:has-text("ten-pages.pdf")');
  const free = (await account(page)).free.remaining;
  const before = downloadCount(ctx, 'ten-pages.pdf');
  await pressInDoc(page, 'Control+s');
  await page.waitForSelector(`${paywall} .pw-pack.active`);
  assert.equal(await page.getAttribute(`${paywall} .pw-pack.active`, 'data-pack'), 'p20');
  await page.click(`${paywall} .pw-method[data-provider="test"]`);
  await page.click(`${paywall} [data-id="pay"]`);
  await page.click(`${paywall} [data-id="test-complete"]`);
  await page.waitForSelector(`${paywall} .pw-success`);
  await page.click(`${paywall} [data-id="done"]`);
  const file = await waitNewDownload(ctx, 'ten-pages.pdf', before);
  assert.equal((await PDFDocument.load(fs.readFileSync(file))).getPageCount(), 10);
  const a = await account(page);
  assert.equal(a.free.remaining, 0);
  assert.equal(a.credits, 20 - (10 - free));
  await waitQuota(page, a.credits);
  assert.match(await page.getAttribute('.quota-pill', 'class'), /\bpaid\b/);
});

test('ads are hidden while purchased pages are left', async () => {
  const { page } = ctx;
  const hidden = (sel) => page.$eval(sel, (el) => el.classList.contains('hidden') || getComputedStyle(el).display === 'none');
  assert.equal(await hidden(`${ACTIVE} .props-panel .ad-slot`), true);
  assert.equal(await hidden('.home .ad-slot[data-ad="app_home"]'), true);
});

test('two quick downloads charge the pages once', async () => {
  const { page } = ctx;
  await openDoc(page, path.join(FIXTURES, 'images.pdf'));
  await touchDoc(page);
  const credits = (await account(page)).credits;
  const before = downloadCount(ctx, 'images.pdf');
  await page.click(`${ACTIVE} .viewer`, { position: { x: 4, y: 4 } });
  await page.keyboard.press('Control+s');
  await page.keyboard.press('Control+s');
  await page.click('.download-btn').catch(() => {});
  await waitNewDownload(ctx, 'images.pdf', before);
  await page.waitForTimeout(1500);
  assert.equal(downloadCount(ctx, 'images.pdf'), before + 1);
  assert.equal((await account(page)).credits, credits - 3);
});

let bankCredits;
test('a bank transfer reported by SePay completes the order in the open dialog', async () => {
  const { page } = ctx;
  bankCredits = (await account(page)).credits;
  await page.click('.buy-btn');
  await page.waitForSelector(`${paywall} .pw-pack.active`);
  assert.equal(await page.getAttribute(`${paywall} .pw-pack.active`, 'data-pack'), 'p100');
  await page.click(`${paywall} .pw-method[data-provider="bank"]`);
  await page.click(`${paywall} [data-id="pay"]`);
  await page.waitForSelector(`${paywall} .pw-qr svg`);
  const code = (await page.textContent(`${paywall} .pw-row.code .pw-row-value`)).trim();
  assert.match(code, /^PE[A-Z0-9]{8}$/);
  const payload = await page.getAttribute(`${paywall} .pw-qr`, 'data-payload');
  assert.ok(payload.includes(code) && payload.includes('0123456789') && payload.includes('970422'), payload);
  const res = await sepayWebhook(
    server,
    { id: 92704, gateway: 'MBBank', transactionDate: '2026-11-12 10:00:00', accountNumber: '0123456789', code: null, content: `MBVCB.3278907687 ${code.slice(0, 5).toLowerCase()}-${code.slice(5)} chuyen tien`, transferType: 'in', transferAmount: 39000, accumulated: 1000000, subAccount: null, referenceCode: 'FT123', description: '' },
    SEPAY_KEY,
  );
  assert.equal(res.status, 200);
  await page.waitForSelector(`${paywall} .pw-success`, { timeout: 15000 });
  await page.click(`${paywall} [data-id="done"]`);
  await page.waitForSelector(paywall, { state: 'detached' });
  assert.equal((await account(page)).credits, bankCredits + 100);
  await waitQuota(page, bankCredits + 100);
});

test('the restore code brings the purchased pages to another browser', async () => {
  const { page } = ctx;
  await page.click('.quota-pill');
  await page.waitForSelector('.modal.account-dialog [data-id="restore-code"]');
  const code = (await page.textContent('.modal.account-dialog [data-id="restore-code"]')).trim();
  assert.match(code, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){4}$/);
  await page.keyboard.press('Escape');
  const credits = (await account(page)).credits;
  const other = await launchApp({ server });
  try {
    const p2 = other.page;
    await waitQuota(p2, 5);
    await p2.click('.quota-pill');
    await p2.waitForSelector('.modal.account-dialog');
    await p2.click('.modal.account-dialog .modal-footer .link-btn');
    await p2.waitForSelector('.modal input.input');
    await p2.fill('.modal input.input', code.toLowerCase().replace(/-/g, ' '));
    await p2.click('.modal .btn.primary');
    await p2.waitForFunction(() => [...document.querySelectorAll('.toast.success')].some((t) => /khôi phục/i.test(t.textContent)), null, { timeout: 10000 });
    const a = await account(p2);
    assert.equal(a.credits, credits);
    await waitQuota(p2, credits);
    // A wrong code is refused.
    await p2.waitForSelector('.modal.account-dialog');
    await p2.click('.modal.account-dialog .modal-footer .link-btn');
    await p2.fill('.modal input.input', 'AAAA-BBBB-CCCC-DDDD-EEEE');
    await p2.click('.modal .btn.primary');
    await p2.waitForFunction(() => [...document.querySelectorAll('.toast.error')].some((t) => /không đúng/i.test(t.textContent)), null, { timeout: 10000 });
    assert.deepEqual(appErrors(other.logs).filter((l) => !/404/.test(l)), []);
  } finally {
    await other.close();
  }
});

test('when the server refuses the charge the paywall opens again', async () => {
  const { page } = ctx;
  const a = await account(page);
  // The pages were spent elsewhere: only 2 are left on the server.
  server.app.billing.grant(a.id, -(a.credits - 2), 'test');
  await page.click('.tab:has-text("images.pdf")');
  await page.evaluate(() => window.__app.activeDoc.session.insertBlank(0, 595, 842, 3));
  const before = downloadCount(ctx, 'images.pdf');
  await pressInDoc(page, 'Control+s');
  await page.waitForSelector(`${paywall} .pw-need`, { timeout: 15000 });
  assert.match(await page.textContent(`${paywall} .pw-need`), /thiếu 1 trang/);
  await closePaywall(page);
  await page.waitForTimeout(500);
  assert.equal(downloadCount(ctx, 'images.pdf'), before);
  assert.equal((await account(page)).credits, 2);
  await waitQuota(page, 2);
  assert.equal(await page.evaluate(() => window.__app.activeDoc.session.dirty), true);
});

test('no errors were logged', () => {
  // The refused charge is an expected 402 answer.
  assert.deepEqual(appErrors(ctx.logs).filter((l) => !/status of 402/.test(l)), []);
});
