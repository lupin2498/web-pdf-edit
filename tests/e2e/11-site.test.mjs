// Public pages: landing, tool pages, pricing, hand-over of files to the
// editor, theme and language, phones, ads, admin and payment pages.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { launchApp, startServer, closeBrowser, ensureFixtures, FIXTURES, ROOT, devices, queueDialog, account, appErrors } from './launch.mjs';

const PACKS = JSON.stringify([
  { id: 's10', pages: 10, vnd: 5000, usd: 0.99 },
  { id: 's50', pages: 50, vnd: 20000, usd: 2.99, popular: true },
]);
const ADMIN = 'admin-token-123456';
const ENV = { FREE_PAGES: '7', PACKS, ADMIN_TOKEN: ADMIN, CONTACT_EMAIL: 'hotro@example.com', BANK_CODE: 'MB', BANK_ACCOUNT: '0123456789', SEPAY_API_KEY: 'k-123456' };
const PDF = path.join(FIXTURES, 'standard.pdf');
const PDF2 = path.join(FIXTURES, 'ten-pages.pdf');
const PNG = path.join(ROOT, 'tests', 'fixtures', 'sample.png');

let server;
const contexts = [];
async function open(pagePath, options = {}) {
  const ctx = await launchApp({ server: options.server || server, pagePath, context: options.context || {} });
  contexts.push(ctx);
  return ctx;
}
const errorsOf = (ctx) => appErrors(ctx.logs);

before(async () => {
  await ensureFixtures();
  server = await startServer(ENV);
});
after(async () => {
  for (const c of contexts) await c.close();
  await server?.close();
  await closeBrowser();
});

async function waitEditor(page) {
  await page.waitForURL(/\/app\//, { timeout: 20000 });
  await page.waitForFunction(() => window.__app && window.__app.homeTab, null, { timeout: 30000 });
}

test('the home page lists every tool', async () => {
  const ctx = await open('/');
  const { page } = ctx;
  assert.equal(await page.$$eval('.tools-grid .tool-card', (els) => els.length), 11);
  assert.match(await page.textContent('h1'), /Chỉnh sửa PDF/);
  assert.match(await page.textContent('.trust'), /7 trang miễn phí/);
  assert.equal(await page.title(), 'PDF Edit – Chỉnh sửa PDF trực tuyến miễn phí, nhanh và riêng tư');
  assert.deepEqual(errorsOf(ctx), []);
});

test('the pricing page shows the configured packs', async () => {
  const { page } = await open('/bang-gia/');
  const cards = await page.$$eval('.pricing-grid .price-card', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ')));
  assert.equal(cards.length, 3);
  assert.match(cards[0], /Miễn phí.*7 trang/);
  assert.match(cards[1], /10 trang.*5\.000\s₫.*500\s₫ \/ trang/);
  assert.match(cards[2], /Phổ biến nhất.*50 trang.*20\.000\s₫/);
  assert.deepEqual(await page.$$eval('[data-buy]', (els) => els.map((e) => e.dataset.buy)), ['s10', 's50']);
  const en = await fetch(`${server.url}/en/pricing/`).then((r) => r.text());
  assert.match(en, /10 pages/);
  assert.match(en, /Most popular/);
});

test('no page has a placeholder left', async () => {
  const build = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'build.json'), 'utf8'));
  assert.ok(build.pages.length >= 30, `${build.pages.length} pages`);
  for (const p of build.pages) {
    const res = await fetch(server.url + p.path);
    const text = await res.text();
    assert.equal(res.status, 200, p.path);
    assert.ok(!text.includes('%%'), `placeholder left in ${p.path}: ${text.slice(text.indexOf('%%') - 40, text.indexOf('%%') + 40)}`);
  }
});

test('files chosen on the merge page open in the combine dialog', async () => {
  const ctx = await open('/gop-pdf/');
  const { page } = ctx;
  await page.setInputFiles('.dz-input', [PDF, PDF2]);
  await waitEditor(page);
  await page.waitForFunction(() => document.querySelectorAll('.modal .file-row').length === 2, null, { timeout: 20000 });
  const names = await page.$$eval('.modal .file-row .fr-name', (els) => els.map((e) => e.textContent));
  assert.match(names[0], /standard\.pdf/);
  assert.match(names[1], /ten-pages\.pdf/);
  assert.equal(new URL(page.url()).search, '');
  assert.deepEqual(errorsOf(ctx), []);
});

test('the edit page opens the document in edit mode', async () => {
  const { page } = await open('/chinh-sua-pdf/');
  await page.setInputFiles('.dz-input', PDF);
  await waitEditor(page);
  await page.waitForFunction(() => window.__app.activeDoc && window.__app.activeDoc.session.name === 'standard.pdf', null, { timeout: 20000 });
  await page.waitForFunction(() => window.__app.activeDoc.tools.tool === 'edit');
  assert.equal(await page.getAttribute('.ribbon-tab.active', 'data-rtab'), 'edit');
});

test('the split page opens the split dialog', async () => {
  const { page } = await open('/tach-pdf/');
  await page.setInputFiles('.dz-input', PDF2);
  await waitEditor(page);
  await page.waitForSelector('.modal .modal-header', { timeout: 20000 });
  assert.match(await page.textContent('.modal .modal-header'), /Tách/);
  await page.keyboard.press('Escape');
});

test('a file the tool cannot use is refused on the page', async () => {
  const { page } = await open('/nen-pdf/');
  await page.setInputFiles('.dz-input', PNG);
  await page.waitForSelector('.dz-error');
  assert.match(await page.textContent('.dz-error'), /không được hỗ trợ/);
  assert.match(page.url(), /\/nen-pdf\/$/);
});

test('without browser storage the editor asks for the file and then runs the task', async () => {
  const ctx = await launchApp({ server, pagePath: '/', context: {} });
  contexts.push(ctx);
  const { page, context } = ctx;
  await context.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { get: () => undefined, configurable: true });
  });
  await page.goto(`${server.url}/tach-pdf/`);
  await page.setInputFiles('.dz-input', PDF2);
  await waitEditor(page);
  await page.waitForFunction(() => [...document.querySelectorAll('.toast.error')].some((t) => /chọn lại tệp/i.test(t.textContent)), null, { timeout: 10000 });
  await queueDialog(page, [PDF2]);
  await page.click('.home-card[data-action="open"]');
  await page.waitForSelector('.modal .modal-header', { timeout: 20000 });
  assert.match(await page.textContent('.modal .modal-header'), /Tách/);
  await page.keyboard.press('Escape');
  assert.deepEqual(errorsOf(ctx), []);
});

test('the theme chosen on the site is used by the editor', async () => {
  const { page } = await open('/');
  assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
  await page.click('[data-theme-toggle]');
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
  await page.click('.header-cta');
  await waitEditor(page);
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
  // And back from the editor's own switch.
  await page.click('.tb-btn[aria-label]:not(.tb-lang)');
  assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
  await page.goto(`${server.url}/`);
  assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
});

test('English pages open the editor in English', async () => {
  const { page } = await open('/en/');
  assert.equal(await page.getAttribute('html', 'lang'), 'en');
  await page.click('.header-cta');
  await waitEditor(page);
  assert.equal(await page.textContent('.ribbon-tab[data-rtab="comment"]'), 'Comment');
  assert.match(await page.textContent('.quota-pill'), /7 free pages/);
  assert.equal(new URL(page.url()).search, '');
  // Coming from a Vietnamese page, the editor is Vietnamese again.
  await page.goto(`${server.url}/`);
  await page.click('.header-cta');
  await waitEditor(page);
  assert.equal(await page.textContent('.ribbon-tab[data-rtab="comment"]'), 'Bình luận');
});

test('buying from the pricing page opens the paywall with that pack', async () => {
  const { page } = await open('/bang-gia/');
  await page.click('a[data-buy="s10"]');
  await waitEditor(page);
  await page.waitForSelector('.modal.paywall .pw-pack.active', { timeout: 15000 });
  assert.equal(await page.getAttribute('.modal.paywall .pw-pack.active', 'data-pack'), 's10');
  assert.match(await page.textContent('.modal.paywall [data-id="pay"]'), /5\.000/);
});

test('phones: pages fit the screen and the menu opens', async () => {
  const ctx = await open('/', { context: { ...devices['iPhone 13'] } });
  const { page } = ctx;
  for (const p of ['/', '/gop-pdf/', '/bang-gia/', '/en/pdf-to-word/', '/app/']) {
    await page.goto(server.url + p, { waitUntil: 'load' });
    await page.waitForTimeout(400);
    const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    assert.ok(sw <= cw, `${p}: page is ${sw}px wide on a ${cw}px screen`);
  }
  await page.goto(`${server.url}/`);
  assert.equal(await page.isVisible('.main-nav'), false);
  await page.click('.menu-btn');
  await page.waitForSelector('.site-header.nav-open .mobile-nav a[href="/gop-pdf/"]', { state: 'visible' });
  await page.click('.mobile-nav a[href="/gop-pdf/"]');
  await page.waitForURL(/\/gop-pdf\/$/);
  assert.deepEqual(errorsOf(ctx), []);
});

test('unknown addresses answer 404 with the 404 page', async () => {
  const { page } = await open('/');
  const res = await page.goto(`${server.url}/khong-co-trang-nay/`);
  assert.equal(res.status(), 404);
  assert.match(await page.textContent('h1'), /Không tìm thấy trang/);
});

test('sitemap and robots', async () => {
  const sitemap = await fetch(`${server.url}/sitemap.xml`).then((r) => r.text());
  for (const p of ['/', '/en/', '/gop-pdf/', '/en/merge-pdf/', '/bang-gia/']) assert.ok(sitemap.includes(`${server.url}${p}<`), p);
  for (const p of ['/app/', '/admin/', '/pay/', '404']) assert.ok(!sitemap.includes(p), p);
  assert.match(sitemap, /hreflang="en"/);
  const robots = await fetch(`${server.url}/robots.txt`).then((r) => r.text());
  assert.match(robots, /Sitemap: .*\/sitemap\.xml/);
  assert.match(robots, /Disallow: \/api\//);
});

test('the page-pack promotion shows once, and no ads at all for buyers', async () => {
  const ctx = await open('/');
  const { page } = ctx;
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500);
  const state = () => page.$$eval('[data-ad]', (els) => els.map((e) => ({ ad: e.dataset.ad, hidden: e.hidden || getComputedStyle(e).display === 'none', house: !!e.querySelector('.house-banner') })));
  assert.deepEqual(await state(), [
    { ad: 'landing_top', hidden: true, house: false },
    { ad: 'landing_mid', hidden: false, house: true },
    { ad: 'landing_bottom', hidden: true, house: false },
  ]);
  await page.evaluate(() => localStorage.setItem('pdfedit.account', JSON.stringify({ credits: 5, free: { limit: 7, remaining: 0 } })));
  await page.reload();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(400);
  assert.ok((await state()).every((s) => s.hidden));
});

test('AdSense units are requested when their slot comes into view', async () => {
  const adServer = await startServer({ ...ENV, ADSENSE_CLIENT: 'ca-pub-1234567890123456', ADSENSE_SLOT_LANDING_TOP: '1111111111', ADSENSE_SLOT_LANDING_MID: '2222222222', ADSENSE_SLOT_LANDING_BOTTOM: '3333333333' });
  try {
    // Start on a page without ads so that the ad network is blocked before
    // the first request to it.
    const ctx = await launchApp({ server: adServer, pagePath: '/pay/done/?status=cancelled', context: {} });
    contexts.push(ctx);
    const { page, context } = ctx;
    await context.route(/googlesyndication\.com/, (route) => route.abort());
    await page.goto(`${adServer.url}/`, { waitUntil: 'load' });
    // The loader script and ads.txt are set up.
    assert.ok(await page.$('script[src*="adsbygoogle.js?client=ca-pub-1234567890123456"]'));
    const adsTxt = await fetch(`${adServer.url}/ads.txt`).then((r) => r.text());
    assert.match(adsTxt, /google\.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0/);
    const units = () => page.$$eval('[data-ad] ins.adsbygoogle', (els) => els.map((e) => e.dataset.adSlot));
    await page.waitForTimeout(400);
    const first = await units();
    assert.ok(!first.includes('3333333333'), `bottom unit loaded too early: ${first}`);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForFunction(() => document.querySelectorAll('[data-ad] ins.adsbygoogle').length === 3, null, { timeout: 5000 });
    assert.deepEqual((await units()).sort(), ['1111111111', '2222222222', '3333333333']);
    assert.equal(await page.$eval('ins.adsbygoogle', (e) => e.dataset.adClient), 'ca-pub-1234567890123456');
    assert.deepEqual(appErrors(ctx.logs).filter((l) => !/googlesyndication|net::ERR_FAILED/.test(l)), []);
  } finally {
    await adServer.close();
  }
});

test('ad code of another network runs in its slot', async () => {
  const html = '<div class="net-ad">Network ad</div><script>window.__netAd = (window.__netAd || 0) + 1;</script>';
  const adServer = await startServer({ ...ENV, ADS_HTML_LANDING_BOTTOM: html, ADS_HTML_APP_HOME: html });
  try {
    const ctx = await launchApp({ server: adServer, pagePath: '/', context: {} });
    contexts.push(ctx);
    const { page } = ctx;
    assert.equal(await page.$('[data-ad="landing_bottom"] .net-ad'), null);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForSelector('[data-ad="landing_bottom"] .net-ad');
    assert.equal(await page.evaluate(() => window.__netAd), 1);
    await page.goto(`${adServer.url}/app/`);
    await page.waitForSelector('.home [data-ad="app_home"] .net-ad');
    assert.equal(await page.evaluate(() => window.__netAd), 1);
    assert.deepEqual(appErrors(ctx.logs), []);
  } finally {
    await adServer.close();
  }
});

test('the admin page confirms a bank transfer by hand', async () => {
  const billing = server.app.billing;
  const acc = billing.ensureAccount('admin-test-account-0001');
  const order = billing.createOrder(acc.id, { packId: 's50', provider: 'bank' });
  const ctx = await open('/admin/');
  const { page } = ctx;
  page.on('dialog', (d) => d.accept());
  await page.fill('.admin-login input', 'wrong-token-000000');
  await page.click('.admin-login button[type=submit]');
  await page.waitForSelector('.admin-login .error-text');
  await page.fill('.admin-login input', ADMIN);
  await page.click('.admin-login button[type=submit]');
  await page.waitForSelector('.stat-grid .stat');
  assert.ok((await page.$$('.stat-grid .stat')).length >= 8);
  const row = page.locator('table.data tr', { hasText: order.code });
  await row.waitFor();
  await row.locator('button').click();
  await page.waitForSelector('.notice.ok');
  assert.match(await page.textContent('.notice.ok'), new RegExp(order.code));
  assert.equal(billing.getOrder(order.id).status, 'paid');
  assert.equal(billing.getAccount(acc.id).credits, 50);
  // Stays logged in for this tab.
  await page.reload();
  await page.waitForSelector('.stat-grid .stat');
  assert.deepEqual(errorsOf(ctx).filter((l) => !/401/.test(l)), []);
});

test('the payment result pages', async () => {
  const { page } = await open('/pay/done/?status=paid');
  await page.waitForSelector('.pay-icon');
  assert.match(await page.textContent('.pay-state h1'), /Thanh toán thành công/);
  await page.goto(`${server.url}/pay/done/?status=cancelled&lang=en`);
  await page.waitForSelector('.pay-icon.cancelled');
  assert.match(await page.textContent('.pay-state h1'), /Payment cancelled/);
  await page.goto(`${server.url}/pay/done/?status=failed`);
  await page.waitForSelector('.pay-icon.failed');
  assert.ok(await page.$('.pay-state a.btn[href="/app/?lang=vi"]'));
});

test('PayPal: checkout goes to PayPal and the return adds the pages', async () => {
  const created = new Map();
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/v1/oauth2/token') return json(200, { access_token: 'tok', expires_in: 3600 });
    if (u.pathname === '/v2/checkout/orders' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      // Real PayPal order ids are 17 characters long.
      const id = `5O190127TN36471${String(created.size + 1).padStart(2, '0')}`;
      created.set(id, body.purchase_units[0]);
      return json(201, { id, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] });
    }
    const m = /^\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(u.pathname);
    if (m) {
      const unit = created.get(m[1]);
      return json(201, { id: m[1], status: 'COMPLETED', purchase_units: [{ reference_id: unit.reference_id, payments: { captures: [{ id: `CAP-${m[1]}`, status: 'COMPLETED', amount: unit.amount, custom_id: unit.custom_id }] } }] });
    }
    return json(404, {});
  };
  const ppServer = await startServer({ ...ENV, PAYPAL_CLIENT_ID: 'cid', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_ENV: 'sandbox' }, { fetchImpl });
  try {
    const ctx = await launchApp({ server: ppServer, pagePath: '/pay/done/?status=paid', context: {} });
    contexts.push(ctx);
    const { page, context } = ctx;
    await context.route('https://www.sandbox.paypal.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>PayPal sandbox</h1>' }));
    await page.goto(`${ppServer.url}/pay/checkout/?provider=paypal&pack=s10&lang=en`);
    await page.waitForURL(/sandbox\.paypal\.com\/checkoutnow\?token=5O190127TN3647101/, { timeout: 15000 });
    const unit = created.get('5O190127TN3647101');
    assert.equal(unit.amount.value, '0.99');
    assert.equal(unit.amount.currency_code, 'USD');
    // PayPal sends the buyer back.
    await page.goto(`${ppServer.url}/api/pay/paypal/return?token=5O190127TN3647101&PayerID=X`);
    await page.waitForURL(/\/pay\/done\/\?status=paid/);
    await page.waitForSelector('.pay-icon:not(.failed)');
    const a = await account(page);
    assert.equal(a.credits, 10);
    // Reloading the return address does not add the pages twice.
    await page.goto(`${ppServer.url}/api/pay/paypal/return?token=5O190127TN3647101&PayerID=X`);
    await page.waitForURL(/status=paid/);
    assert.equal((await account(page)).credits, 10);
  } finally {
    await ppServer.close();
  }
});
