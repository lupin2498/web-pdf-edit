// The page allowance: free pages, purchased pages, idempotency, resets and
// the per-IP cap.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, fakeClock, opId, consume, buyTest, me, DAY, HOUR } from './helpers.mjs';

describe('free pages and purchased pages', () => {
  let srv;
  before(async () => {
    srv = await startApp({ PAYMENTS_TEST_MODE: '1' });
  });
  after(() => srv.close());

  test('a new visitor gets the free allowance and a session cookie', async () => {
    const c = srv.client();
    const r = await c.get('/api/me');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.account, { id: null, free: { limit: 5, remaining: 5, resetsAt: null }, credits: 0, available: 5, adFree: false, restoreCode: null });
    assert.ok(c.jar.get('pe_sid'), 'session cookie set');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    // No account row is written just for looking.
    assert.equal(srv.billing.db.get('SELECT COUNT(*) AS n FROM accounts').n, 0);
  });

  test('free pages are used first and the account gets ids', async () => {
    const c = srv.client();
    const r = await consume(c, 3);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.charged, { free: 3, paid: 0 });
    assert.equal(r.json.account.free.remaining, 2);
    assert.equal(r.json.account.available, 2);
    assert.match(r.json.account.id, /^[A-HJ-NP-Z2-9]{10}$/);
    assert.match(r.json.account.restoreCode, /^([A-HJ-NP-Z2-9]{4}-){4}[A-HJ-NP-Z2-9]{4}$/);
  });

  test('a charge that is not covered fails with the missing count and charges nothing', async () => {
    const c = srv.client();
    await consume(c, 3);
    const r = await consume(c, 3);
    assert.equal(r.status, 402);
    assert.equal(r.json.error, 'insufficient');
    assert.equal(r.json.needed, 3);
    assert.equal(r.json.missing, 1);
    assert.equal(r.json.account.free.remaining, 2);
    const ok = await consume(c, 2);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.account.available, 0);
    const none = await consume(c, 1);
    assert.equal(none.status, 402);
    assert.equal(none.json.missing, 1);
  });

  test('purchased pages are used after the free ones, in one charge if needed', async () => {
    const c = srv.client();
    await consume(c, 2);
    const bought = await buyTest(c, 'p20');
    assert.equal(bought.account.credits, 20);
    assert.equal(bought.account.available, 23);
    assert.equal(bought.account.adFree, true);
    const r = await consume(c, 10);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.charged, { free: 3, paid: 7 });
    assert.equal(r.json.account.credits, 13);
    assert.equal(r.json.account.free.remaining, 0);
    const r2 = await consume(c, 13);
    assert.deepEqual(r2.json.charged, { free: 0, paid: 13 });
    assert.equal(r2.json.account.credits, 0);
    assert.equal(r2.json.account.adFree, false);
    // Ledger: +20 purchase, -7, -13 usage.
    const acc = srv.billing.adminAccount(r2.json.account.id);
    assert.deepEqual(
      acc.ledger.map((l) => [l.reason, l.delta, l.balance]).reverse(),
      [
        ['purchase', 20, 20],
        ['usage', -7, 13],
        ['usage', -13, 0],
      ],
    );
    assert.equal(acc.pagesTotal, 25);
  });

  test('repeating an operation id never charges twice', async () => {
    const c = srv.client();
    const id = opId();
    const a = await consume(c, 2, id);
    const b = await consume(c, 2, id);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(b.json.charged, a.json.charged);
    assert.equal(b.json.account.free.remaining, 3);
    // Even with a different page count the first charge stands.
    const c3 = await consume(c, 5, id);
    assert.equal(c3.json.account.free.remaining, 3);
  });

  test('an operation id of another account is refused', async () => {
    const id = opId();
    assert.equal((await consume(srv.client(), 1, id)).status, 200);
    const other = srv.client();
    const r = await consume(other, 1, id);
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'invalid_op');
    assert.equal((await me(other)).free.remaining, 5);
  });

  test('invalid page counts and operation ids are rejected', async () => {
    const c = srv.client();
    for (const pages of [0, -1, 1.5, 'abc', 100001, null, true]) {
      const r = await c.post('/api/usage/consume', { pages, opId: opId() });
      assert.equal(r.status, 400, `pages=${JSON.stringify(pages)}`);
      assert.equal(r.json.error, 'invalid_pages');
    }
    for (const id of [undefined, 'short', 'has space!', 'x'.repeat(65), 12345678]) {
      const r = await c.post('/api/usage/consume', { pages: 1, opId: id });
      assert.equal(r.status, 400, `opId=${JSON.stringify(id)}`);
      assert.equal(r.json.error, 'invalid_op');
    }
    // A numeric string is a valid page count.
    assert.equal((await c.post('/api/usage/consume', { pages: '2', opId: opId() })).status, 200);
    assert.equal((await me(c)).free.remaining, 3);
  });

  test('a long action name is stored truncated', async () => {
    const c = srv.client();
    const id = opId();
    await consume(c, 1, id, { action: 'a'.repeat(500) });
    assert.equal(srv.billing.db.get('SELECT action FROM usage WHERE op_id = ?', id).action.length, 40);
  });
});

describe('free pages come back after FREE_RESET_DAYS', () => {
  let srv;
  let clock;
  before(async () => {
    clock = fakeClock();
    srv = await startApp({ FREE_RESET_DAYS: '30' }, { clock });
  });
  after(() => srv.close());

  test('the allowance is restored once the period is over', async () => {
    const c = srv.client();
    const start = clock();
    const first = await consume(c, 5);
    assert.equal(first.json.account.free.remaining, 0);
    assert.equal(first.json.account.free.resetsAt, start + 30 * DAY);
    clock.advance(30 * DAY - 1);
    assert.equal((await me(c)).free.remaining, 0);
    assert.equal((await consume(c, 1)).status, 402);
    clock.advance(1);
    const a = await me(c);
    assert.equal(a.free.remaining, 5);
    const r = await consume(c, 2);
    assert.equal(r.status, 200);
    assert.equal(r.json.account.free.remaining, 3);
    assert.equal(r.json.account.free.resetsAt, clock() + 30 * DAY);
  });

  test('a refused charge at the start of a new period still starts it', async () => {
    const c = srv.client();
    await consume(c, 5);
    clock.advance(31 * DAY);
    const r = await consume(c, 6);
    assert.equal(r.status, 402);
    assert.equal(r.json.missing, 1);
    assert.equal(r.json.account.free.remaining, 5);
    assert.equal((await consume(c, 5)).status, 200);
  });
});

describe('free pages per IP address and day', () => {
  let srv;
  let clock;
  before(async () => {
    // 2026-11-12 10:00 in Vietnam (UTC+7).
    clock = fakeClock(Date.UTC(2026, 10, 12, 3, 0, 0));
    srv = await startApp({ FREE_IP_DAILY_PAGES: '7', PAYMENTS_TEST_MODE: '1' }, { clock });
  });
  after(() => srv.close());

  test('accounts from one address share the daily cap', async () => {
    const a = srv.client();
    const b = srv.client();
    const c = srv.client();
    assert.equal((await consume(a, 5)).status, 200);
    const vb = await me(b);
    assert.equal(vb.free.remaining, 2);
    assert.equal(vb.free.limit, 5);
    const r = await consume(b, 3);
    assert.equal(r.status, 402);
    assert.equal(r.json.missing, 1);
    assert.equal((await consume(b, 2)).status, 200);
    assert.equal((await me(c)).free.remaining, 0);
    assert.equal((await consume(c, 1)).status, 402);
  });

  test('purchased pages are not limited by the cap', async () => {
    const c = srv.client();
    assert.equal((await me(c)).free.remaining, 0);
    await buyTest(c, 'p20');
    const r = await consume(c, 4);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.charged, { free: 0, paid: 4 });
  });

  test('the cap starts again at midnight Vietnam time', async () => {
    const c = srv.client();
    // 23:59:59 on the 12th in Vietnam = 16:59:59 UTC.
    clock.set(Date.UTC(2026, 10, 12, 16, 59, 59));
    assert.equal((await me(c)).free.remaining, 0);
    clock.set(Date.UTC(2026, 10, 12, 17, 0, 0));
    assert.equal((await me(c)).free.remaining, 5);
    assert.equal((await consume(c, 5)).status, 200);
    assert.equal((await me(srv.client())).free.remaining, 2);
  });

  test('old per-IP records are removed by the cleanup', async () => {
    const before = srv.billing.db.get('SELECT COUNT(*) AS n FROM ip_usage').n;
    assert.ok(before >= 2);
    clock.advance(9 * DAY + HOUR);
    srv.billing.cleanup();
    assert.equal(srv.billing.db.get('SELECT COUNT(*) AS n FROM ip_usage').n, 0);
  });
});
