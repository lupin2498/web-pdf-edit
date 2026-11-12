// Restore codes and the admin API.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, BANK_ENV, ADMIN_TOKEN, buyTest, consume, me } from './helpers.mjs';

const auth = { authorization: `Bearer ${ADMIN_TOKEN}` };

describe('restore codes', () => {
  let srv;
  before(async () => {
    srv = await startApp({ PAYMENTS_TEST_MODE: '1' });
  });
  after(() => srv.close());

  test('a restore code moves the purchased pages to another browser', async () => {
    const a = srv.client();
    await buyTest(a, 'p20');
    const acc = await me(a);
    const b = srv.client();
    await consume(b, 1);
    const r = await b.post('/api/account/restore', { code: acc.restoreCode.toLowerCase().replace(/-/g, ' ') });
    assert.equal(r.status, 200);
    assert.equal(r.json.account.id, acc.id);
    assert.equal(r.json.account.credits, 20);
    assert.ok(r.setCookies.some((c) => c.startsWith('pe_sid=')));
    const after = await me(b);
    assert.equal(after.id, acc.id);
    assert.equal(after.credits, 20);
    // Both browsers now share the account.
    await consume(b, 10);
    assert.equal((await me(a)).available, 15);
  });

  test('wrong and malformed codes are refused', async () => {
    const c = srv.client();
    for (const code of ['AAAA-BBBB-CCCC-DDDD-EEEE', 'short', '', null, 12345]) {
      const r = await c.post('/api/account/restore', { code });
      assert.equal(r.status, 404, String(code));
      assert.equal(r.json.error, 'not_found');
    }
  });
});

describe('restore rate limit', () => {
  test('after 12 attempts an hour further attempts are refused', async () => {
    const srv = await startApp({});
    try {
      const c = srv.client();
      for (let i = 0; i < 12; i++) assert.equal((await c.post('/api/account/restore', { code: 'AAAA-BBBB-CCCC-DDDD-EEEE' })).status, 404);
      const r = await c.post('/api/account/restore', { code: 'AAAA-BBBB-CCCC-DDDD-EEEE' });
      assert.equal(r.status, 429);
      assert.equal(r.json.error, 'rate_limited');
      assert.ok(Number(r.headers.get('retry-after')) > 3000);
    } finally {
      await srv.close();
    }
  });
});

describe('admin API', () => {
  let srv;
  before(async () => {
    srv = await startApp({ ...BANK_ENV, PAYMENTS_TEST_MODE: '1', ADMIN_TOKEN });
  });
  after(() => srv.close());

  test('needs the admin token', async () => {
    const c = srv.client();
    assert.equal((await c.get('/api/admin/stats')).status, 401);
    assert.equal((await c.get('/api/admin/stats', { headers: { authorization: 'Bearer wrong-token-000' } })).status, 401);
    assert.equal((await c.get('/api/admin/stats', { headers: { authorization: ADMIN_TOKEN } })).status, 200);
    assert.equal((await c.get('/api/admin/nothing', { headers: auth })).status, 404);
  });

  test('statistics', async () => {
    const buyer = srv.client();
    await consume(buyer, 3);
    await buyTest(buyer, 'p100');
    await consume(buyer, 10);
    const r = await srv.client().get('/api/admin/stats', { headers: auth });
    assert.equal(r.status, 200);
    const { stats, config } = r.json;
    assert.ok(stats.accounts.total >= 1);
    assert.ok(stats.accounts.withCredits >= 1);
    assert.ok(stats.revenue.all.VND.orders >= 1);
    assert.ok(stats.revenue.day.VND.amount >= 39000);
    assert.ok(stats.usage.all.pages >= 13);
    assert.ok(stats.usage.all.free >= 5);
    assert.deepEqual(config.providers, ['bank', 'test']);
    assert.equal(config.sepay, true);
    assert.equal(JSON.stringify(r.json).includes('sepay-key-123'), false);
  });

  test('orders can be listed and filtered', async () => {
    const c = srv.client();
    await c.post('/api/orders', { packId: 'p20', provider: 'bank' });
    const all = (await srv.client().get('/api/admin/orders', { headers: auth })).json.orders;
    assert.ok(all.length >= 2);
    assert.ok(all.every((o) => typeof o.account === 'string'));
    const paid = (await srv.client().get('/api/admin/orders?status=paid', { headers: auth })).json.orders;
    assert.ok(paid.length >= 1 && paid.every((o) => o.status === 'paid'));
    const pending = (await srv.client().get('/api/admin/orders?status=pending', { headers: auth })).json.orders;
    assert.ok(pending.every((o) => o.status === 'pending'));
    // An unknown filter lists everything.
    assert.equal((await srv.client().get('/api/admin/orders?status=bogus', { headers: auth })).json.orders.length, all.length);
  });

  test('confirming a bank transfer by hand credits the pages once', async () => {
    const c = srv.client();
    const { order } = (await c.post('/api/orders', { packId: 'p100', provider: 'bank' })).json;
    const r = await srv.client().post('/api/admin/orders/confirm', { order: order.code.toLowerCase(), note: 'seen on statement' }, { headers: auth });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'paid');
    assert.equal(r.json.order.status, 'paid');
    assert.equal((await me(c)).credits, 100);
    const listed = (await srv.client().get('/api/admin/orders?status=paid', { headers: auth })).json.orders.find((o) => o.id === order.id);
    assert.equal(listed.note, 'confirmed by admin: seen on statement');
    const again = await srv.client().post('/api/admin/orders/confirm', { order: order.id }, { headers: auth });
    assert.equal(again.json.status, 'already_paid');
    assert.equal((await me(c)).credits, 100);
    assert.equal((await srv.client().post('/api/admin/orders/confirm', { order: 'PEXXXXXXXX' }, { headers: auth })).status, 404);
  });

  test('granting and removing pages', async () => {
    const c = srv.client();
    await consume(c, 1);
    const id = (await me(c)).id;
    const g = await srv.client().post('/api/admin/grant', { account: id.toLowerCase(), pages: 50, note: 'gift' }, { headers: auth });
    assert.equal(g.status, 200);
    assert.equal(g.json.account.credits, 50);
    assert.equal((await me(c)).credits, 50);
    const minus = await srv.client().post('/api/admin/grant', { account: id, pages: -1000 }, { headers: auth });
    assert.equal(minus.json.account.credits, 0);
    assert.deepEqual(
      minus.json.account.ledger.slice(0, 2).map((l) => [l.reason, l.delta, l.balance, l.ref]),
      [
        ['admin', -50, 0, null],
        ['admin', 50, 50, 'gift'],
      ],
    );
    for (const pages of [0, 1.5, 'x', 2000000]) assert.equal((await srv.client().post('/api/admin/grant', { account: id, pages }, { headers: auth })).status, 400, String(pages));
    assert.equal((await srv.client().post('/api/admin/grant', { account: 'NOSUCHACCT', pages: 5 }, { headers: auth })).status, 404);
  });

  test('accounts can be looked up by id or restore code', async () => {
    const c = srv.client();
    await buyTest(c, 'p20');
    const acc = await me(c);
    const byId = await srv.client().get(`/api/admin/account?ref=${acc.id}`, { headers: auth });
    assert.equal(byId.status, 200);
    assert.equal(byId.json.account.credits, 20);
    assert.equal(byId.json.account.orders.length, 1);
    const byCode = await srv.client().get(`/api/admin/account?ref=${encodeURIComponent(acc.restoreCode)}`, { headers: auth });
    assert.equal(byCode.json.account.id, acc.id);
    assert.equal((await srv.client().get('/api/admin/account?ref=nobody', { headers: auth })).status, 404);
    assert.equal((await srv.client().get('/api/admin/account', { headers: auth })).status, 404);
  });

  test('payments that need attention', async () => {
    const r = await srv.client().request('POST', '/api/pay/sepay/webhook', {
      body: JSON.stringify({ id: 777, transferType: 'in', transferAmount: 5000, content: 'no code here', accountNumber: '0123456789' }),
      headers: { 'content-type': 'application/json', authorization: 'Apikey sepay-key-123' },
    });
    assert.equal(r.json.status, 'not_found');
    const list = (await srv.client().get('/api/admin/payments?attention=1', { headers: auth })).json.payments;
    assert.ok(list.some((p) => p.id === 'bank:sepay-777' && p.status === 'unmatched' && p.amount === 5000));
    const all = (await srv.client().get('/api/admin/payments', { headers: auth })).json.payments;
    assert.ok(all.some((p) => p.status === 'matched'));
    assert.ok(all.length > list.length);
  });
});

describe('admin API availability', () => {
  test('does not exist without ADMIN_TOKEN', async () => {
    const srv = await startApp({});
    try {
      assert.equal((await srv.client().get('/api/admin/stats', { headers: { authorization: 'Bearer ' } })).status, 404);
      assert.equal((await srv.client().get('/api/admin/stats')).status, 404);
    } finally {
      await srv.close();
    }
  });

  test('repeated wrong tokens are rate limited', async () => {
    const srv = await startApp({ ADMIN_TOKEN });
    try {
      for (let i = 0; i < 20; i++) assert.equal((await srv.client().get('/api/admin/stats', { headers: { authorization: 'Bearer nope-nope-nope' } })).status, 401);
      assert.equal((await srv.client().get('/api/admin/stats', { headers: { authorization: 'Bearer nope-nope-nope' } })).status, 429);
      assert.equal((await srv.client().get('/api/admin/stats', { headers: auth })).status, 200);
    } finally {
      await srv.close();
    }
  });
});
