// Request checks: same-origin, content types, body size, cookies, proxies.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, opId, consume, buyTest, me } from './helpers.mjs';

describe('state-changing requests', () => {
  let srv;
  before(async () => {
    srv = await startApp({ PAYMENTS_TEST_MODE: '1' });
  });
  after(() => srv.close());

  test('cross-site requests are refused', async () => {
    const c = srv.client();
    const { order } = (await c.post('/api/orders', { packId: 'p20', provider: 'test' })).json;
    const evil = [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { origin: 'not a url' }, { origin: `http://127.0.0.1:${srv.port + 1}` }];
    for (const headers of evil) {
      for (const [p, body] of [
        ['/api/usage/consume', { pages: 1, opId: opId() }],
        ['/api/orders', { packId: 'p20', provider: 'test' }],
        ['/api/account/restore', { code: 'AAAA-BBBB-CCCC-DDDD-EEEE' }],
        ['/api/pay/test/complete', { orderId: order.id }],
        [`/api/orders/${order.id}/cancel`, {}],
      ]) {
        const r = await c.post(p, body, { headers });
        assert.equal(r.status, 403, `${p} ${JSON.stringify(headers)}`);
        assert.equal(r.json.error, 'forbidden');
      }
    }
    assert.equal((await me(c)).free.remaining, 5);
    assert.equal((await c.get(`/api/orders/${order.id}`)).json.order.status, 'pending');
  });

  test('same-origin requests and requests without an Origin are accepted', async () => {
    const c = srv.client();
    assert.equal((await consume(c, 1, opId(), {})).status, 200);
    assert.equal((await c.post('/api/usage/consume', { pages: 1, opId: opId() }, { headers: { origin: srv.url, 'sec-fetch-site': 'same-origin' } })).status, 200);
    assert.equal((await c.post('/api/usage/consume', { pages: 1, opId: opId() }, { headers: { origin: 'null' } })).status, 200);
  });

  test('JSON bodies only', async () => {
    const c = srv.client();
    const body = JSON.stringify({ pages: 1, opId: opId() });
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '']) {
      const r = await c.request('POST', '/api/usage/consume', { body, headers: { 'content-type': type } });
      assert.equal(r.status, 415, type);
    }
    const ok = await c.request('POST', '/api/usage/consume', { body, headers: { 'content-type': 'application/json; charset=utf-8' } });
    assert.equal(ok.status, 200);
    for (const bad of ['{', '[1,2]', '"text"', 'null']) {
      const r = await c.request('POST', '/api/usage/consume', { body: bad, headers: { 'content-type': 'application/json' } });
      assert.equal(r.status, 400, bad);
      assert.equal(r.json.error, 'bad_json');
    }
  });

  test('large bodies are refused', async () => {
    const c = srv.client();
    const big = JSON.stringify({ pages: 1, opId: opId(), pad: 'x'.repeat(70 * 1024) });
    const r = await c.request('POST', '/api/usage/consume', { body: big, headers: { 'content-type': 'application/json' } });
    assert.equal(r.status, 413);
    assert.equal(r.json.error, 'too_large');
    assert.equal(r.headers.get('connection'), 'close');
    // Without a Content-Length (chunked) the limit applies while reading.
    const chunked = await srv.raw({ method: 'POST', path: '/api/usage/consume', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }, body: big });
    assert.equal(chunked.status, 413);
  });

  test('unknown API routes and methods', async () => {
    const c = srv.client();
    const r = await c.get('/api/nothing');
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 'not_found');
    assert.equal((await c.get('/api/usage/consume')).status, 404);
    assert.equal((await c.request('DELETE', '/api/me')).status, 404);
  });

  test('security headers', async () => {
    const r = await srv.client().get('/api/me');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  });
});

describe('session cookie', () => {
  let srv;
  before(async () => {
    srv = await startApp({ PAYMENTS_TEST_MODE: '1' });
  });
  after(() => srv.close());

  test('flags', async () => {
    const r = await srv.client().get('/api/me');
    const cookie = r.setCookies.find((c) => c.startsWith('pe_sid='));
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; SameSite=Lax/);
    assert.match(cookie, /; Path=\//);
    assert.match(cookie, /; Max-Age=\d{8}/);
    assert.doesNotMatch(cookie, /Secure/);
    // A proxy header means nothing unless TRUST_PROXY is set.
    const r2 = await srv.client().get('/api/me', { headers: { 'x-forwarded-proto': 'https' } });
    assert.doesNotMatch(r2.setCookies[0], /Secure/);
  });

  test('a valid cookie is not re-issued', async () => {
    const c = srv.client();
    await c.get('/api/me');
    const again = await c.get('/api/me');
    assert.equal(again.setCookies.length, 0);
  });

  test('a tampered cookie gives a fresh account', async () => {
    const victim = srv.client();
    await buyTest(victim, 'p20');
    const value = victim.jar.get('pe_sid');
    const [id, sig] = value.split('.');
    const attacker = srv.client();
    for (const forged of [`${id}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`, `${id}.`, id, `${id}x.${sig}`, '', '...']) {
      const r = await attacker.get('/api/me', { headers: { cookie: `pe_sid=${forged}` } });
      assert.equal(r.status, 200);
      assert.equal(r.json.account.credits, 0, forged);
      assert.ok(r.setCookies.length === 1, 'a new cookie is issued');
      assert.notEqual(r.setCookies[0].split(';')[0], `pe_sid=${value}`);
    }
    assert.equal((await me(victim)).credits, 20);
  });
});

describe('secure cookies', () => {
  test('when SITE_URL is https', async () => {
    const srv = await startApp({ SITE_URL: 'https://pdf.example.com' });
    try {
      const r = await srv.client().get('/api/me');
      assert.match(r.setCookies[0], /; Secure/);
    } finally {
      await srv.close();
    }
  });

  test('behind a trusted proxy that terminates TLS', async () => {
    const srv = await startApp({ TRUST_PROXY: '1' });
    try {
      assert.match((await srv.client().get('/api/me', { headers: { 'x-forwarded-proto': 'https' } })).setCookies[0], /; Secure/);
      assert.doesNotMatch((await srv.client().get('/api/me', { headers: { 'x-forwarded-proto': 'http' } })).setCookies[0], /Secure/);
    } finally {
      await srv.close();
    }
  });
});

describe('client address for the per-IP cap', () => {
  test('X-Forwarded-For is ignored without TRUST_PROXY', async () => {
    const srv = await startApp({ FREE_IP_DAILY_PAGES: '5' });
    try {
      const a = srv.client({ 'x-forwarded-for': '1.1.1.1' });
      const b = srv.client({ 'x-forwarded-for': '2.2.2.2' });
      assert.equal((await consume(a, 5)).status, 200);
      assert.equal((await me(b)).free.remaining, 0);
    } finally {
      await srv.close();
    }
  });

  test('with one trusted proxy the address it appended counts', async () => {
    const srv = await startApp({ FREE_IP_DAILY_PAGES: '5', TRUST_PROXY: '1' });
    try {
      const a = srv.client({ 'x-forwarded-for': '1.1.1.1' });
      const b = srv.client({ 'x-forwarded-for': '2.2.2.2' });
      // A client that sends its own X-Forwarded-For; the proxy appends the
      // real address at the end.
      const spoof = srv.client({ 'x-forwarded-for': '9.9.9.9, 1.1.1.1' });
      assert.equal((await consume(a, 5)).status, 200);
      assert.equal((await me(b)).free.remaining, 5);
      assert.equal((await me(spoof)).free.remaining, 0);
      // X-Real-IP when the proxy does not set X-Forwarded-For.
      const real = srv.client({ 'x-real-ip': '1.1.1.1' });
      assert.equal((await me(real)).free.remaining, 0);
    } finally {
      await srv.close();
    }
  });

  test('IPv6 addresses of one /64 network count as one client', async () => {
    const srv = await startApp({ FREE_IP_DAILY_PAGES: '5', TRUST_PROXY: '1' });
    try {
      assert.equal((await consume(srv.client({ 'x-forwarded-for': '2001:db8:1:2::1' }), 5)).status, 200);
      assert.equal((await me(srv.client({ 'x-forwarded-for': '2001:0db8:0001:0002:ffff:0:0:9' }))).free.remaining, 0);
      assert.equal((await me(srv.client({ 'x-forwarded-for': '2001:db8:1:3::1' }))).free.remaining, 5);
      // An IPv4 address written as IPv6 is the same address.
      assert.equal((await consume(srv.client({ 'x-forwarded-for': '1.2.3.4' }), 5)).status, 200);
      assert.equal((await me(srv.client({ 'x-forwarded-for': '::ffff:1.2.3.4' }))).free.remaining, 0);
    } finally {
      await srv.close();
    }
  });

  test('with two trusted proxies the second address from the end counts', async () => {
    const srv = await startApp({ FREE_IP_DAILY_PAGES: '5', TRUST_PROXY: '2' });
    try {
      assert.equal((await consume(srv.client({ 'x-forwarded-for': '3.3.3.3, 10.0.0.1' }), 5)).status, 200);
      assert.equal((await me(srv.client({ 'x-forwarded-for': '7.7.7.7, 3.3.3.3, 10.0.0.2' }))).free.remaining, 0);
      assert.equal((await me(srv.client({ 'x-forwarded-for': '4.4.4.4, 10.0.0.1' }))).free.remaining, 5);
    } finally {
      await srv.close();
    }
  });

  test('behind Cloudflare', async () => {
    const srv = await startApp({ FREE_IP_DAILY_PAGES: '5', TRUST_PROXY: 'cloudflare' });
    try {
      assert.equal((await consume(srv.client({ 'cf-connecting-ip': '5.5.5.5', 'x-forwarded-for': '6.6.6.6' }), 5)).status, 200);
      assert.equal((await me(srv.client({ 'cf-connecting-ip': '5.5.5.5', 'x-forwarded-for': '8.8.8.8' }))).free.remaining, 0);
      assert.equal((await me(srv.client({ 'cf-connecting-ip': '6.6.6.6' }))).free.remaining, 5);
    } finally {
      await srv.close();
    }
  });
});
