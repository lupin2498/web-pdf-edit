// Storage: persistence across restarts, transactions and housekeeping.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApp, fakeClock, buyTest, consume, me, DAY } from './helpers.mjs';
import { openDatabase } from '../../server/db.mjs';

describe('persistence', () => {
  test('accounts and sessions survive a restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfedit-data-'));
    try {
      let srv = await startApp({ DATA_DIR: dir, PAYMENTS_TEST_MODE: '1' });
      const c = srv.client();
      await buyTest(c, 'p20');
      await consume(c, 3);
      const before = await me(c);
      await srv.close();
      assert.ok(fs.existsSync(path.join(dir, 'pdfedit.sqlite')));

      srv = await startApp({ DATA_DIR: dir, PAYMENTS_TEST_MODE: '1' });
      try {
        // The same browser (cookie) on the restarted server.
        const c2 = srv.client();
        for (const [k, v] of c.jar) c2.jar.set(k, v);
        const after = await me(c2);
        assert.deepEqual(after, before);
        assert.equal(after.credits, 20);
        assert.equal(after.free.remaining, 2);
        assert.equal((await c2.get('/api/orders')).json.orders.length, 1);
      } finally {
        await srv.close();
      }

      // Another SESSION_SECRET invalidates the cookies (but not the data).
      srv = await startApp({ DATA_DIR: dir, SESSION_SECRET: 'a-different-secret' });
      try {
        const c3 = srv.client();
        for (const [k, v] of c.jar) c3.jar.set(k, v);
        assert.equal((await me(c3)).credits, 0);
        assert.equal(srv.billing.findAccount(before.id).credits, 20);
      } finally {
        await srv.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('opening the same database twice keeps the schema', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfedit-data-'));
    try {
      const file = path.join(dir, 'x.sqlite');
      const a = await openDatabase(file);
      a.setMeta('k', 'v');
      a.close();
      const b = await openDatabase(file);
      assert.equal(b.getMeta('k'), 'v');
      assert.equal(b.get('PRAGMA user_version').user_version, 1);
      b.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('transactions', () => {
  test('a failure rolls everything back; nested calls join the outer one', async () => {
    const db = await openDatabase(':memory:');
    try {
      assert.throws(() =>
        db.transaction(() => {
          db.setMeta('a', '1');
          db.transaction(() => db.setMeta('b', '2'));
          throw new Error('boom');
        }),
      );
      assert.equal(db.getMeta('a'), null);
      assert.equal(db.getMeta('b'), null);
      assert.equal(db.inTransaction, false);
      db.transaction(() => {
        db.setMeta('a', '1');
        db.transaction(() => db.setMeta('b', '2'));
      });
      assert.equal(db.getMeta('a'), '1');
      assert.equal(db.getMeta('b'), '2');
    } finally {
      db.close();
    }
  });
});

describe('cleanup', () => {
  test('forgets long-unused free accounts and keeps paying ones', async () => {
    const clock = fakeClock();
    const srv = await startApp({ PAYMENTS_TEST_MODE: '1', ORDER_TTL_MINUTES: '30' }, { clock });
    try {
      const free = srv.client();
      await consume(free, 2);
      const spentAll = srv.client();
      await buyTest(spentAll, 'p20');
      await consume(spentAll, 25);
      const holder = srv.client();
      await buyTest(holder, 'p20');
      const pending = srv.client();
      const order = (await pending.post('/api/orders', { packId: 'p20', provider: 'test' })).json.order;
      const ids = { free: (await me(free)).id, spentAll: (await me(spentAll)).id, holder: (await me(holder)).id };

      clock.advance(399 * DAY);
      srv.billing.cleanup();
      assert.ok(srv.billing.findAccount(ids.free), 'not stale yet');
      assert.equal((await pending.get(`/api/orders/${order.id}`)).json.order.status, 'expired');
      assert.equal(srv.billing.db.get('SELECT status FROM orders WHERE id = ?', order.id).status, 'expired');

      clock.advance(2 * DAY);
      srv.billing.cleanup();
      assert.equal(srv.billing.findAccount(ids.free), null);
      assert.equal(srv.billing.db.get('SELECT COUNT(*) AS n FROM usage WHERE account_id NOT IN (SELECT id FROM accounts)').n, 0);
      assert.ok(srv.billing.findAccount(ids.spentAll), 'bought once');
      assert.ok(srv.billing.findAccount(ids.holder), 'has pages');
      // The forgotten browser simply starts again.
      assert.equal((await me(free)).free.remaining, 5);
    } finally {
      await srv.close();
    }
  });
});
