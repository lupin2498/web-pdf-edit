// Orders: creation, VietQR transfer details, reuse, expiry and cancellation.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, fakeClock, BANK_ENV, MINUTE } from './helpers.mjs';
import { parseTlv, crc16, vietQrPayload } from '../../server/payments/vietqr.mjs';

const CODE = /^PE[A-HJ-NP-Z2-9]{8}$/;

describe('bank transfer orders', () => {
  let srv;
  let clock;
  before(async () => {
    clock = fakeClock();
    srv = await startApp({ ...BANK_ENV, ORDER_TTL_MINUTES: '30' }, { clock });
  });
  after(() => srv.close());

  test('creating an order returns the transfer details and a valid VietQR code', async () => {
    const c = srv.client();
    const r = await c.post('/api/orders', { packId: 'p100', provider: 'bank' });
    assert.equal(r.status, 200);
    const { order, pay } = r.json;
    assert.match(order.code, CODE);
    assert.equal(order.status, 'pending');
    assert.equal(order.amount, 39000);
    assert.equal(order.currency, 'VND');
    assert.equal(order.pages, 100);
    assert.equal(order.provider, 'bank');
    assert.equal(order.expiresAt, clock() + 30 * MINUTE);
    assert.equal(pay.type, 'bank');
    assert.equal(pay.bankName, 'MB Bank');
    assert.equal(pay.bankCode, 'MB');
    assert.equal(pay.account, '0123456789');
    assert.equal(pay.accountName, 'NGUYEN VAN A');
    assert.equal(pay.amount, 39000);
    assert.equal(pay.content, order.code);
    assert.equal(pay.auto, true);

    const qr = pay.qr;
    assert.equal(qr.slice(-4), crc16(qr.slice(0, -4)), 'CRC');
    assert.equal(qr.slice(-8, -4), '6304');
    const t = parseTlv(qr);
    assert.equal(t['00'], '01');
    assert.equal(t['01'], '12');
    assert.equal(t['53'], '704');
    assert.equal(t['54'], '39000');
    assert.equal(t['58'], 'VN');
    const merchant = parseTlv(t['38']);
    assert.equal(merchant['00'], 'A000000727');
    assert.equal(merchant['02'], 'QRIBFTTA');
    const beneficiary = parseTlv(merchant['01']);
    assert.equal(beneficiary['00'], '970422');
    assert.equal(beneficiary['01'], '0123456789');
    assert.equal(parseTlv(t['62'])['08'], order.code);
  });

  test('asking again for the same pack shows the same order', async () => {
    const c = srv.client();
    const a = await c.post('/api/orders', { packId: 'p20', provider: 'bank' });
    const b = await c.post('/api/orders', { packId: 'p20', provider: 'bank' });
    assert.equal(a.json.order.id, b.json.order.id);
    assert.equal(a.json.pay.qr, b.json.pay.qr);
    const other = await c.post('/api/orders', { packId: 'p500', provider: 'bank' });
    assert.notEqual(other.json.order.id, a.json.order.id);
    // Another browser gets its own order.
    const d = await srv.client().post('/api/orders', { packId: 'p20', provider: 'bank' });
    assert.notEqual(d.json.order.id, a.json.order.id);
    assert.notEqual(d.json.order.code, a.json.order.code);
  });

  test('an order with less than five minutes left is not reused', async () => {
    const c = srv.client();
    const a = await c.post('/api/orders', { packId: 'p500', provider: 'bank' });
    clock.advance(26 * MINUTE);
    const b = await c.post('/api/orders', { packId: 'p500', provider: 'bank' });
    assert.notEqual(a.json.order.id, b.json.order.id);
  });

  test('the buyer can poll the order; other browsers cannot see it', async () => {
    const c = srv.client();
    const { order } = (await c.post('/api/orders', { packId: 'p20', provider: 'bank' })).json;
    const r = await c.get(`/api/orders/${order.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.order.status, 'pending');
    assert.equal(r.json.pay.content, order.code);
    assert.equal(r.json.account.credits, 0);
    const stranger = await srv.client().get(`/api/orders/${order.id}`);
    assert.equal(stranger.status, 404);
    assert.equal(stranger.json.error, 'not_found');
    assert.equal((await c.get('/api/orders/0123456789abcdef0123456789abcdef')).status, 404);
    assert.equal((await c.get('/api/orders/not-an-id')).status, 404);
  });

  test('an order expires after ORDER_TTL_MINUTES', async () => {
    const c = srv.client();
    const { order } = (await c.post('/api/orders', { packId: 'p20', provider: 'bank' })).json;
    clock.advance(30 * MINUTE);
    const r = await c.get(`/api/orders/${order.id}`);
    assert.equal(r.json.order.status, 'expired');
    assert.equal(r.json.pay, undefined);
    const list = await c.get('/api/orders');
    assert.equal(list.json.orders.find((o) => o.id === order.id).status, 'expired');
    const next = await c.post('/api/orders', { packId: 'p20', provider: 'bank' });
    assert.notEqual(next.json.order.id, order.id);
    assert.equal(next.json.order.status, 'pending');
  });

  test('cancelling an order', async () => {
    const c = srv.client();
    const { order } = (await c.post('/api/orders', { packId: 'p100', provider: 'bank' })).json;
    assert.equal((await srv.client().post(`/api/orders/${order.id}/cancel`)).status, 404);
    const r = await c.post(`/api/orders/${order.id}/cancel`);
    assert.equal(r.status, 200);
    assert.equal(r.json.order.status, 'cancelled');
    assert.equal((await c.get(`/api/orders/${order.id}/cancel`)).status, 405);
    const again = await c.post('/api/orders', { packId: 'p100', provider: 'bank' });
    assert.notEqual(again.json.order.id, order.id);
    // Cancelling a cancelled order changes nothing.
    assert.equal((await c.post(`/api/orders/${order.id}/cancel`)).json.order.status, 'cancelled');
  });

  test('unknown packs and unavailable payment methods are refused', async () => {
    const c = srv.client();
    const unknown = await c.post('/api/orders', { packId: 'p999', provider: 'bank' });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json.error, 'unknown_pack');
    for (const provider of ['paypal', 'test', 'bitcoin', '', undefined]) {
      const r = await c.post('/api/orders', { packId: 'p20', provider });
      assert.equal(r.status, 400, String(provider));
      assert.equal(r.json.error, 'provider_unavailable');
    }
    assert.equal((await c.post('/api/orders', {})).status, 400);
  });

  test('the order list only shows the own orders, newest first', async () => {
    const c = srv.client();
    const a = (await c.post('/api/orders', { packId: 'p20', provider: 'bank' })).json.order;
    clock.advance(1000);
    const b = (await c.post('/api/orders', { packId: 'p100', provider: 'bank' })).json.order;
    const list = (await c.get('/api/orders')).json.orders;
    assert.deepEqual(
      list.map((o) => o.id),
      [b.id, a.id],
    );
    assert.deepEqual((await srv.client().get('/api/orders')).json.orders, []);
  });
});

describe('packs priced in one currency only', () => {
  let srv;
  before(async () => {
    srv = await startApp({ ...BANK_ENV, PACKS: JSON.stringify([{ id: 'vnd', pages: 10, vnd: 5000 }, { id: 'usd', pages: 20, usd: 2 }]) });
  });
  after(() => srv.close());

  test('a pack without a VND price cannot be paid by bank transfer', async () => {
    const c = srv.client();
    assert.equal((await c.post('/api/orders', { packId: 'vnd', provider: 'bank' })).status, 200);
    const r = await c.post('/api/orders', { packId: 'usd', provider: 'bank' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'provider_unavailable');
  });
});

describe('VietQR payload', () => {
  test('CRC-16/CCITT-FALSE check value', () => {
    assert.equal(crc16('123456789'), '29B1');
  });

  test('without an amount the code is static and has no amount field', () => {
    const qr = vietQrPayload({ bin: '970436', account: '1234567890' });
    const t = parseTlv(qr);
    assert.equal(t['01'], '11');
    assert.equal(t['54'], undefined);
    assert.equal(t['62'], undefined);
    assert.equal(qr.slice(-4), crc16(qr.slice(0, -4)));
  });

  test('the description keeps only characters every bank accepts', () => {
    const qr = vietQrPayload({ bin: '970436', account: '1234567890', amount: 10000.4, content: 'Thanh toán đơn PE123 #1' });
    const t = parseTlv(qr);
    assert.equal(t['54'], '10000');
    assert.equal(parseTlv(t['62'])['08'], 'Thanh ton n PE123 1');
  });

  test('invalid bank ids and accounts are refused', () => {
    assert.throws(() => vietQrPayload({ bin: '97043', account: '1' }));
    assert.throws(() => vietQrPayload({ bin: '970436', account: '12 34' }));
    assert.throws(() => vietQrPayload({ bin: '970436', account: '' }));
  });
});
