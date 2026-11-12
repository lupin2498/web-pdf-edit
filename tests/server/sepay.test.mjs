// Bank transfers reported by the SePay webhook.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startApp, fakeClock, BANK_ENV, me, MINUTE } from './helpers.mjs';

let txSeq = 1000;
function tx({ id = ++txSeq, content, amount, type = 'in', account = '0123456789', subAccount = null, code = null } = {}) {
  return {
    id,
    gateway: 'MBBank',
    transactionDate: '2026-11-12 10:00:00',
    accountNumber: account,
    subAccount,
    code,
    content,
    transferType: type,
    transferAmount: amount,
    accumulated: 1000000,
    referenceCode: `FT${id}`,
    description: `BankAPINotify ${content || ''}`,
  };
}

const hook = (srv, body, headers = {}) =>
  srv.client().request('POST', '/api/pay/sepay/webhook', {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', authorization: 'Apikey sepay-key-123', ...headers },
  });

async function bankOrder(srv, packId = 'p100') {
  const c = srv.client();
  const r = await c.post('/api/orders', { packId, provider: 'bank' });
  assert.equal(r.status, 200);
  return { c, order: r.json.order };
}

describe('SePay webhook with an API key', () => {
  let srv;
  let clock;
  before(async () => {
    clock = fakeClock();
    srv = await startApp({ ...BANK_ENV, ORDER_TTL_MINUTES: '30' }, { clock });
  });
  after(() => srv.close());

  test('requests without the right key are refused', async () => {
    const body = tx({ content: 'x', amount: 1000 });
    for (const authorization of [undefined, '', 'Apikey wrong', 'sepay-key-1234', 'Basic sepay-key-123']) {
      const headers = authorization === undefined ? { authorization: '' } : { authorization };
      const r = await hook(srv, body, headers);
      assert.equal(r.status, 401, String(authorization));
      assert.deepEqual(r.json, { success: false, error: 'unauthorized' });
    }
  });

  test('the key is accepted with the documented prefixes', async () => {
    for (const authorization of ['Apikey sepay-key-123', 'apikey sepay-key-123', 'Bearer Apikey sepay-key-123', 'Bearer sepay-key-123']) {
      const r = await hook(srv, tx({ content: 'no code', amount: 1000 }), { authorization });
      assert.equal(r.status, 200, authorization);
      assert.equal(r.json.success, true);
    }
  });

  test('a transfer with the order code in a noisy description pays the order', async () => {
    const { c, order } = await bankOrder(srv);
    const code = order.code.toLowerCase();
    const content = `MBVCB.12345678.${code.slice(0, 5)}-${code.slice(5)} thanh toan`;
    const r = await hook(srv, tx({ content, amount: 39000 }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { success: true, status: 'paid' });
    const a = await me(c);
    assert.equal(a.credits, 100);
    const o = (await c.get(`/api/orders/${order.id}`)).json.order;
    assert.equal(o.status, 'paid');
    assert.equal(o.paidAt, clock());
  });

  test('the same notification twice credits once', async () => {
    const { c, order } = await bankOrder(srv, 'p20');
    const body = tx({ content: order.code, amount: 10000 });
    assert.equal((await hook(srv, body)).json.status, 'paid');
    assert.equal((await hook(srv, body)).json.status, 'duplicate');
    assert.equal((await me(c)).credits, 20);
  });

  test('a notification without an id is still recognised when repeated', async () => {
    const { c, order } = await bankOrder(srv, 'p20');
    const body = { ...tx({ content: order.code, amount: 10000 }), id: undefined };
    assert.equal((await hook(srv, body)).json.status, 'paid');
    assert.equal((await hook(srv, body)).json.status, 'duplicate');
    assert.equal((await me(c)).credits, 20);
  });

  test('an underpaid order stays open and is flagged; the rest can follow', async () => {
    const { c, order } = await bankOrder(srv, 'p20');
    const r = await hook(srv, tx({ content: order.code, amount: 9000 }));
    assert.equal(r.json.status, 'underpaid');
    assert.equal((await c.get(`/api/orders/${order.id}`)).json.order.status, 'pending');
    assert.equal((await me(c)).credits, 0);
    const flagged = srv.billing.adminPayments({ attention: true });
    assert.ok(flagged.some((p) => p.orderId === order.id && p.status === 'underpaid'));
    // A full payment later settles it.
    assert.equal((await hook(srv, tx({ content: order.code, amount: 10000 }))).json.status, 'paid');
    assert.equal((await me(c)).credits, 20);
  });

  test('an overpaid order is paid', async () => {
    const { c, order } = await bankOrder(srv, 'p20');
    assert.equal((await hook(srv, tx({ content: order.code, amount: 20000 }))).json.status, 'paid');
    assert.equal((await me(c)).credits, 20);
  });

  test('outgoing transfers are ignored and not recorded', async () => {
    const { c, order } = await bankOrder(srv, 'p20');
    const body = tx({ content: order.code, amount: 10000, type: 'out' });
    const r = await hook(srv, body);
    assert.deepEqual(r.json, { success: true, status: 'ignored' });
    assert.equal((await me(c)).credits, 0);
    assert.equal(srv.billing.db.get('SELECT COUNT(*) AS n FROM payments WHERE id = ?', `bank:sepay-${body.id}`).n, 0);
  });

  test('a transfer to another account is kept as unmatched', async () => {
    const { c, order } = await bankOrder(srv, 'p20');
    const body = tx({ content: order.code, amount: 10000, account: '999999999' });
    assert.equal((await hook(srv, body)).json.status, 'not_found');
    assert.equal((await me(c)).credits, 0);
    assert.equal(srv.billing.db.get('SELECT status FROM payments WHERE id = ?', `bank:sepay-${body.id}`).status, 'unmatched');
  });

  test('a transfer without a known code is kept as unmatched', async () => {
    const body = tx({ content: 'CHUYEN TIEN PEZZZZZZZZ', amount: 10000 });
    assert.equal((await hook(srv, body)).json.status, 'not_found');
    const row = srv.billing.db.get('SELECT * FROM payments WHERE id = ?', `bank:sepay-${body.id}`);
    assert.equal(row.status, 'unmatched');
    assert.equal(row.order_id, null);
    assert.match(row.content, /CHUYEN TIEN/);
  });

  test('a second payment for a paid order is flagged as extra', async () => {
    const { c, order } = await bankOrder(srv, 'p20');
    await hook(srv, tx({ content: order.code, amount: 10000 }));
    const second = tx({ content: order.code, amount: 10000 });
    assert.equal((await hook(srv, second)).json.status, 'already_paid');
    assert.equal((await me(c)).credits, 20);
    assert.equal(srv.billing.db.get('SELECT status FROM payments WHERE id = ?', `bank:sepay-${second.id}`).status, 'extra');
  });

  test('the code may come in the code field alone', async () => {
    const { c, order } = await bankOrder(srv, 'p20');
    assert.equal((await hook(srv, tx({ content: 'IBFT chuyen tien', code: order.code, amount: 10000 }))).json.status, 'paid');
    assert.equal((await me(c)).credits, 20);
  });

  test('the prefix may appear elsewhere in the description', async () => {
    const { c, order } = await bankOrder(srv, 'p20');
    const content = `OPEN PE PEOPLE SPEED PE${order.code.slice(2, 6)} ${order.code} PE`;
    assert.equal((await hook(srv, tx({ content, amount: 10000 }))).json.status, 'paid');
    assert.equal((await me(c)).credits, 20);
  });

  test('a late payment for an expired order is still credited', async () => {
    const { c, order } = await bankOrder(srv, 'p20');
    clock.advance(45 * MINUTE);
    assert.equal((await c.get(`/api/orders/${order.id}`)).json.order.status, 'expired');
    assert.equal((await hook(srv, tx({ content: order.code, amount: 10000 }))).json.status, 'paid');
    assert.equal((await me(c)).credits, 20);
  });

  test('a body that is not JSON is refused', async () => {
    const r = await hook(srv, '{not json');
    assert.equal(r.status, 400);
    assert.equal(r.json.success, false);
  });
});

describe('SePay webhook with a virtual account', () => {
  let srv;
  before(async () => {
    srv = await startApp({ ...BANK_ENV, BANK_ACCOUNT: 'VQRQ123456' });
  });
  after(() => srv.close());

  test('the virtual account number is reported as subAccount', async () => {
    const { c, order } = await bankOrder(srv, 'p20');
    const r = await hook(srv, tx({ content: order.code, amount: 10000, account: '0123456789', subAccount: 'VQRQ123456' }));
    assert.equal(r.json.status, 'paid');
    assert.equal((await me(c)).credits, 20);
  });
});

describe('SePay webhook with an HMAC signature', () => {
  let srv;
  let clock;
  const secret = 'whsec_test_secret';
  before(async () => {
    clock = fakeClock();
    srv = await startApp({ ...BANK_ENV, SEPAY_API_KEY: '', SEPAY_WEBHOOK_SECRET: secret }, { clock });
  });
  after(() => srv.close());

  const sign = (raw, ts) => `sha256=${crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}`;
  const signed = (raw, ts = String(Math.floor(clock() / 1000)), sig = sign(raw, ts)) =>
    srv.client().request('POST', '/api/pay/sepay/webhook', { body: raw, headers: { 'content-type': 'application/json', 'x-sepay-signature': sig, 'x-sepay-timestamp': ts } });

  test('a correctly signed notification is accepted', async () => {
    const { c, order } = await bankOrder(srv, 'p20');
    const raw = JSON.stringify(tx({ content: order.code, amount: 10000 }));
    const r = await signed(raw);
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'paid');
    assert.equal((await me(c)).credits, 20);
  });

  test('timestamps in milliseconds are accepted too', async () => {
    const raw = JSON.stringify(tx({ content: 'nothing', amount: 1000 }));
    assert.equal((await signed(raw, String(clock()))).status, 200);
  });

  test('a changed body, an old timestamp or the API key are refused', async () => {
    const raw = JSON.stringify(tx({ content: 'x', amount: 1000 }));
    const ts = String(Math.floor(clock() / 1000));
    assert.equal((await signed(raw.replace('1000', '9000'), ts, sign(raw, ts))).status, 401);
    const old = String(Math.floor(clock() / 1000) - 6 * 60);
    assert.equal((await signed(raw, old)).status, 401);
    const future = String(Math.floor(clock() / 1000) + 6 * 60);
    assert.equal((await signed(raw, future)).status, 401);
    assert.equal((await signed(raw, 'abc', sign(raw, 'abc'))).status, 401);
    const withKey = await hook(srv, raw, { authorization: 'Apikey sepay-key-123' });
    assert.equal(withKey.status, 401);
  });
});

describe('SePay webhook without configuration', () => {
  test('is not available without a bank account or without a key', async () => {
    for (const env of [{}, { ...BANK_ENV, SEPAY_API_KEY: '' }]) {
      const srv = await startApp(env);
      try {
        const r = await hook(srv, tx({ content: 'x', amount: 1 }));
        assert.equal(r.status, 404);
      } finally {
        await srv.close();
      }
    }
  });

  test('repeated failures are rate limited', async () => {
    const srv = await startApp(BANK_ENV);
    try {
      let last;
      for (let i = 0; i < 61; i++) last = await hook(srv, tx({ content: 'x', amount: 1 }), { authorization: 'Apikey nope' });
      assert.equal(last.status, 429);
      assert.ok(Number(last.headers.get('retry-after')) > 0);
      // The real key still works.
      assert.equal((await hook(srv, tx({ content: 'x', amount: 1 }))).status, 200);
    } finally {
      await srv.close();
    }
  });
});
