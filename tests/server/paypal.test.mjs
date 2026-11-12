// PayPal (against a mocked PayPal API) and the test payment mode.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, BANK_ENV, me } from './helpers.mjs';

const API = 'https://api-m.sandbox.paypal.com';
const PAYPAL_ENV = { PAYPAL_CLIENT_ID: 'client-id', PAYPAL_CLIENT_SECRET: 'client-secret', PAYPAL_ENV: 'sandbox', SITE_URL: 'https://pdf.example.com' };

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake PayPal REST API. `mode[paypalOrderId]` decides what a capture does. */
function fakePayPal() {
  const state = { calls: [], created: new Map(), mode: {}, tokenCalls: 0, failCreate: false, rejectToken: 0, seq: 0 };
  const completed = (id) => {
    const o = state.created.get(id);
    const m = state.mode[id] || {};
    return {
      id,
      status: 'COMPLETED',
      purchase_units: [
        {
          reference_id: o.purchase_units[0].reference_id,
          payments: {
            captures: [
              {
                id: `CAP-${id}`,
                status: m.captureStatus || 'COMPLETED',
                amount: { currency_code: m.currency || o.purchase_units[0].amount.currency_code, value: m.value || o.purchase_units[0].amount.value },
                custom_id: m.customId || o.purchase_units[0].custom_id,
              },
            ],
          },
        },
      ],
    };
  };
  state.fetch = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body === 'grant_type=client_credentials' ? '{}' : init.body) : null;
    state.calls.push({ url: u, method: init.method || 'GET', headers: init.headers || {}, body });
    if (u === `${API}/v1/oauth2/token`) {
      state.tokenCalls++;
      return json(200, { access_token: 'access-token', token_type: 'Bearer', expires_in: 32400 });
    }
    if (state.rejectToken > 0 && u.startsWith(`${API}/v2/`)) {
      state.rejectToken--;
      return json(401, { error: 'invalid_token' });
    }
    if (u === `${API}/v2/checkout/orders` && init.method === 'POST') {
      if (state.failCreate) return json(500, { name: 'INTERNAL_SERVER_ERROR' });
      const id = `PPORDER${++state.seq}`;
      state.created.set(id, body);
      return json(200, {
        id,
        status: 'PAYER_ACTION_REQUIRED',
        links: [
          { href: `${API}/v2/checkout/orders/${id}`, rel: 'self', method: 'GET' },
          { href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`, rel: 'payer-action', method: 'GET' },
        ],
      });
    }
    let m = /\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(u);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const mode = (state.mode[id] && state.mode[id].capture) || 'complete';
      if (mode === 'already') return json(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] });
      if (mode === 'declined') return json(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }] });
      if (mode === 'network') throw new TypeError('fetch failed');
      return json(201, completed(id));
    }
    m = /\/v2\/checkout\/orders\/([^/]+)$/.exec(u);
    if (m && (init.method || 'GET') === 'GET') return json(200, completed(decodeURIComponent(m[1])));
    return json(404, { name: 'RESOURCE_NOT_FOUND' });
  };
  return state;
}

describe('PayPal', () => {
  let srv;
  let pp;
  before(async () => {
    pp = fakePayPal();
    srv = await startApp(PAYPAL_ENV, { fetchImpl: pp.fetch });
  });
  after(() => srv.close());
  beforeEach(() => {
    pp.failCreate = false;
  });

  async function paypalOrder(c, packId = 'p100') {
    const r = await c.post('/api/orders', { packId, provider: 'paypal' });
    assert.equal(r.status, 200, r.text);
    const token = new URL(r.json.pay.url).searchParams.get('token');
    return { order: r.json.order, pay: r.json.pay, token };
  }

  test('PayPal is offered when configured', () => {
    assert.deepEqual(srv.config.providers, ['paypal']);
  });

  test('creating an order sends the buyer to PayPal', async () => {
    const c = srv.client();
    const { order, pay, token } = await paypalOrder(c);
    assert.equal(pay.type, 'redirect');
    assert.equal(pay.url, `https://www.sandbox.paypal.com/checkoutnow?token=${token}`);
    assert.equal(order.currency, 'USD');
    assert.equal(order.amount, 399);
    assert.equal(order.status, 'pending');
    const sent = pp.created.get(token);
    assert.equal(sent.intent, 'CAPTURE');
    const unit = sent.purchase_units[0];
    assert.deepEqual(unit.amount, { currency_code: 'USD', value: '3.99' });
    assert.equal(unit.custom_id, order.id);
    assert.equal(unit.reference_id, order.code);
    const ctx = sent.payment_source.paypal.experience_context;
    assert.equal(ctx.return_url, 'https://pdf.example.com/api/pay/paypal/return');
    assert.equal(ctx.cancel_url, 'https://pdf.example.com/api/pay/paypal/cancel');
    assert.equal(ctx.shipping_preference, 'NO_SHIPPING');
    const tokenCall = pp.calls.find((x) => x.url.endsWith('/v1/oauth2/token'));
    assert.equal(tokenCall.headers.Authorization, `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`);
    const createCall = pp.calls.find((x) => x.url === `${API}/v2/checkout/orders`);
    assert.equal(createCall.headers.Authorization, 'Bearer access-token');
    assert.ok(createCall.headers['PayPal-Request-Id']);
  });

  test('coming back from PayPal captures the payment and credits the pages once', async () => {
    const c = srv.client();
    const { order, token } = await paypalOrder(c);
    // PayPal sends the buyer back, possibly in another browser.
    const back = await srv.client().get(`/api/pay/paypal/return?token=${token}&PayerID=PAYER1`);
    assert.equal(back.status, 302);
    assert.equal(back.headers.get('location'), `/pay/done/?status=paid&order=${order.id}`);
    assert.equal((await me(c)).credits, 100);
    assert.equal((await c.get(`/api/orders/${order.id}`)).json.order.status, 'paid');
    const captures = pp.calls.filter((x) => x.url.endsWith(`/${token}/capture`)).length;
    const again = await srv.client().get(`/api/pay/paypal/return?token=${token}&PayerID=PAYER1`);
    assert.equal(again.headers.get('location'), `/pay/done/?status=paid&order=${order.id}`);
    assert.equal(pp.calls.filter((x) => x.url.endsWith(`/${token}/capture`)).length, captures);
    assert.equal((await me(c)).credits, 100);
  });

  test('an order PayPal already captured is credited from its details', async () => {
    const c = srv.client();
    const { order, token } = await paypalOrder(c, 'p20');
    pp.mode[token] = { capture: 'already' };
    const back = await srv.client().get(`/api/pay/paypal/return?token=${token}`);
    assert.equal(back.headers.get('location'), `/pay/done/?status=paid&order=${order.id}`);
    assert.equal((await me(c)).credits, 20);
  });

  test('a declined payment credits nothing', async () => {
    const c = srv.client();
    const { order, token } = await paypalOrder(c, 'p20');
    pp.mode[token] = { capture: 'declined' };
    const back = await srv.client().get(`/api/pay/paypal/return?token=${token}`);
    assert.equal(back.headers.get('location'), `/pay/done/?status=failed&order=${order.id}`);
    assert.equal((await me(c)).credits, 0);
    assert.equal((await c.get(`/api/orders/${order.id}`)).json.order.status, 'pending');
  });

  test('the buyer can retry after a refusal; each capture attempt is a new request', async () => {
    const c = srv.client();
    const { order, token } = await paypalOrder(c, 'p20');
    pp.mode[token] = { capture: 'declined' };
    assert.match((await srv.client().get(`/api/pay/paypal/return?token=${token}`)).headers.get('location'), /status=failed/);
    // The buyer goes back to PayPal, picks another card and returns.
    pp.mode[token] = {};
    assert.equal((await srv.client().get(`/api/pay/paypal/return?token=${token}`)).headers.get('location'), `/pay/done/?status=paid&order=${order.id}`);
    assert.equal((await me(c)).credits, 20);
    const ids = pp.calls.filter((x) => x.url.endsWith(`/${token}/capture`)).map((x) => x.headers['PayPal-Request-Id']);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
  });

  test('a network error during the capture credits nothing', async () => {
    const c = srv.client();
    const { order, token } = await paypalOrder(c, 'p20');
    pp.mode[token] = { capture: 'network' };
    const back = await srv.client().get(`/api/pay/paypal/return?token=${token}`);
    assert.equal(back.headers.get('location'), `/pay/done/?status=failed&order=${order.id}`);
    assert.equal((await me(c)).credits, 0);
  });

  test('a capture that is still pending credits nothing', async () => {
    const c = srv.client();
    const { token } = await paypalOrder(c, 'p20');
    pp.mode[token] = { captureStatus: 'PENDING' };
    const back = await srv.client().get(`/api/pay/paypal/return?token=${token}`);
    assert.match(back.headers.get('location'), /status=failed/);
    assert.equal((await me(c)).credits, 0);
  });

  test('a capture for a smaller amount, another currency or another order credits nothing', async () => {
    for (const mode of [{ value: '0.99' }, { currency: 'EUR' }, { customId: 'f'.repeat(32) }]) {
      const c = srv.client();
      const { token } = await paypalOrder(c, 'p20');
      pp.mode[token] = mode;
      const back = await srv.client().get(`/api/pay/paypal/return?token=${token}`);
      assert.match(back.headers.get('location'), /status=failed/, JSON.stringify(mode));
      assert.equal((await me(c)).credits, 0, JSON.stringify(mode));
    }
  });

  test('unknown or malformed tokens', async () => {
    for (const token of ['UNKNOWN123', 'bad token!', '']) {
      const back = await srv.client().get(`/api/pay/paypal/return?token=${encodeURIComponent(token)}`);
      assert.equal(back.status, 302);
      assert.equal(back.headers.get('location'), '/pay/done/?status=failed');
    }
  });

  test('cancelling on PayPal cancels the order', async () => {
    const c = srv.client();
    const { order, token } = await paypalOrder(c, 'p20');
    const back = await srv.client().get(`/api/pay/paypal/cancel?token=${token}`);
    assert.equal(back.status, 302);
    assert.equal(back.headers.get('location'), '/pay/done/?status=cancelled');
    assert.equal((await c.get(`/api/orders/${order.id}`)).json.order.status, 'cancelled');
  });

  test('PayPal being unavailable is reported and the order is cancelled', async () => {
    pp.failCreate = true;
    const c = srv.client();
    const r = await c.post('/api/orders', { packId: 'p20', provider: 'paypal' });
    assert.equal(r.status, 502);
    assert.equal(r.json.error, 'provider_error');
    const orders = (await c.get('/api/orders')).json.orders;
    assert.equal(orders.length, 1);
    assert.equal(orders[0].status, 'cancelled');
    assert.ok(srv.logs.some(([level, msg]) => level === 'error' && /paypal create failed/.test(msg)));
  });

  test('the access token is reused', () => {
    assert.equal(pp.tokenCalls, 1);
  });

  test('a token PayPal no longer accepts is renewed once', async () => {
    const before = pp.tokenCalls;
    pp.rejectToken = 1;
    const c = srv.client();
    const r = await c.post('/api/orders', { packId: 'p20', provider: 'paypal' });
    assert.equal(r.status, 200);
    assert.equal(pp.tokenCalls, before + 1);
    // Refused again after renewing: the order fails instead of looping.
    pp.rejectToken = 2;
    assert.equal((await c.post('/api/orders', { packId: 'p100', provider: 'paypal' })).status, 502);
    pp.rejectToken = 0;
  });

  test('every PayPal order is new (no reuse of pending ones)', async () => {
    const c = srv.client();
    const a = await paypalOrder(c, 'p20');
    const b = await paypalOrder(c, 'p20');
    assert.notEqual(a.order.id, b.order.id);
    assert.notEqual(a.token, b.token);
  });
});

describe('PayPal not configured', () => {
  test('its endpoints do not exist', async () => {
    const srv = await startApp({});
    try {
      assert.equal((await srv.client().get('/api/pay/paypal/return?token=ABCDEF')).status, 404);
      assert.equal((await srv.client().post('/api/orders', { packId: 'p20', provider: 'paypal' })).status, 400);
    } finally {
      await srv.close();
    }
  });
});

describe('test payments', () => {
  test('are only available in test mode', async () => {
    const srv = await startApp({});
    try {
      const c = srv.client();
      assert.equal((await c.post('/api/orders', { packId: 'p20', provider: 'test' })).status, 400);
      assert.equal((await c.post('/api/pay/test/complete', { orderId: 'a'.repeat(32) })).status, 404);
    } finally {
      await srv.close();
    }
  });

  test('complete only the own test orders, once', async () => {
    const srv = await startApp({ ...BANK_ENV, PAYMENTS_TEST_MODE: '1' });
    try {
      const c = srv.client();
      const order = (await c.post('/api/orders', { packId: 'p100', provider: 'test' })).json.order;
      assert.equal(order.amount, 39000);
      assert.equal((await srv.client().post('/api/pay/test/complete', { orderId: order.id })).status, 404);
      const done = await c.post('/api/pay/test/complete', { orderId: order.id });
      assert.equal(done.status, 200);
      assert.equal(done.json.status, 'paid');
      assert.equal(done.json.account.credits, 100);
      const again = await c.post('/api/pay/test/complete', { orderId: order.id });
      assert.equal(again.json.status, 'duplicate');
      assert.equal(again.json.account.credits, 100);
      // A bank order cannot be completed this way.
      const bank = (await c.post('/api/orders', { packId: 'p20', provider: 'bank' })).json.order;
      assert.equal((await c.post('/api/pay/test/complete', { orderId: bank.id })).status, 404);
      assert.equal((await me(c)).credits, 100);
    } finally {
      await srv.close();
    }
  });
});
