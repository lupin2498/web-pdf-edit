// Accounts, the free allowance, purchased pages and orders.
//
// One "page" is the unit of use: exporting a document costs as many pages as
// it has. Every account starts with config.free.pages free pages; after that
// pages are bought in packs. All balance changes happen inside SQLite
// transactions and every one is written to the ledger.
import crypto from 'node:crypto';

const DAY = 24 * 60 * 60 * 1000;
// Vietnam time (UTC+7) decides where a "day" of the per-IP allowance starts.
const DAY_OFFSET = 7 * 60 * 60 * 1000;
// No I, O, 0, 1: codes are read from bank statements and typed by people.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const MAX_PAGES_PER_OPERATION = 100000;

export function randomCode(length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] & 31];
  return out;
}

export function newAccountId() {
  return crypto.randomBytes(16).toString('base64url');
}

function formatRestoreCode(raw) {
  return raw.match(/.{1,4}/g).join('-');
}

export function normalizeRestoreCode(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export class BillingError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message || code);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

export class Billing {
  constructor(db, config, clock = () => Date.now()) {
    this.db = db;
    this.config = config;
    this.clock = clock;
  }

  now() {
    return this.clock();
  }

  day(ts = this.now()) {
    return Math.floor((ts + DAY_OFFSET) / DAY);
  }

  // ------------------------------------------------------------------ accounts

  getAccount(id) {
    return id ? this.db.get('SELECT * FROM accounts WHERE id = ?', id) || null : null;
  }

  ensureAccount(id, { ipHash = null, userAgent = null } = {}) {
    let acc = this.getAccount(id);
    const now = this.now();
    if (!acc) {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          this.db.run(
            'INSERT INTO accounts (id, public_id, restore_code, created_at, last_seen, free_used, free_period_start, credits, ip_hash, user_agent) VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?, ?)',
            id,
            randomCode(10),
            randomCode(20),
            now,
            now,
            now,
            ipHash,
            userAgent ? String(userAgent).slice(0, 200) : null,
          );
          break;
        } catch (e) {
          if (this.getAccount(id)) break;
          // A collision of the random public id / restore code: try again.
          if (attempt === 4 || !/UNIQUE/i.test(String(e.message))) throw e;
        }
      }
      acc = this.getAccount(id);
    }
    return acc;
  }

  touch(id, ipHash) {
    this.db.run('UPDATE accounts SET last_seen = ?, ip_hash = COALESCE(?, ip_hash) WHERE id = ?', this.now(), ipHash, id);
  }

  ipUsedToday(ipHash) {
    if (!ipHash) return 0;
    const row = this.db.get('SELECT pages FROM ip_usage WHERE ip_hash = ? AND day = ?', ipHash, this.day());
    return row ? row.pages : 0;
  }

  /** Free pages an account can still use right now. */
  freeState(account, ipHash) {
    const { pages: limit, resetDays, ipDailyPages } = this.config.free;
    const now = this.now();
    let used = account ? account.free_used : 0;
    let periodStart = account ? account.free_period_start : now;
    let reset = false;
    if (account && resetDays > 0 && now - periodStart >= resetDays * DAY) {
      used = 0;
      periodStart = now;
      reset = true;
    }
    let remaining = Math.max(0, limit - used);
    let ipLimited = false;
    if (ipDailyPages > 0 && ipHash && remaining > 0) {
      const ipRemaining = Math.max(0, ipDailyPages - this.ipUsedToday(ipHash));
      if (ipRemaining < remaining) {
        remaining = ipRemaining;
        ipLimited = true;
      }
    }
    return { limit, used, remaining, periodStart, reset, ipLimited, resetsAt: resetDays > 0 ? periodStart + resetDays * DAY : null };
  }

  /** What the client may know about its account. */
  view(accountId, ipHash) {
    const acc = this.getAccount(accountId);
    const free = this.freeState(acc, ipHash);
    const credits = acc ? acc.credits : 0;
    return {
      id: acc ? acc.public_id : null,
      free: { limit: free.limit, remaining: free.remaining, resetsAt: free.resetsAt },
      credits,
      available: free.remaining + credits,
      adFree: credits > 0,
      restoreCode: acc ? formatRestoreCode(acc.restore_code) : null,
    };
  }

  // ------------------------------------------------------------------ usage

  /**
   * Charges `pages` pages: free pages first, then purchased ones. Repeating a
   * call with the same opId never charges twice.
   */
  consume(accountId, { pages, opId, action = null, ipHash = null, userAgent = null }) {
    const n = Number(pages);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PAGES_PER_OPERATION) throw new BillingError('invalid_pages', 'pages must be a positive whole number');
    if (typeof opId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(opId)) throw new BillingError('invalid_op', 'opId is required');
    return this.db.transaction(() => {
      const prior = this.db.get('SELECT * FROM usage WHERE op_id = ?', opId);
      if (prior) {
        if (prior.account_id !== accountId) throw new BillingError('invalid_op', 'opId already used');
        return { ok: true, repeated: true, charged: { free: prior.free_pages, paid: prior.paid_pages }, account: this.view(accountId, ipHash) };
      }
      const acc = this.ensureAccount(accountId, { ipHash, userAgent });
      const free = this.freeState(acc, ipHash);
      const fromFree = Math.min(n, free.remaining);
      const fromPaid = n - fromFree;
      if (fromPaid > acc.credits) {
        if (free.reset) this.db.run('UPDATE accounts SET free_used = 0, free_period_start = ? WHERE id = ?', free.periodStart, acc.id);
        return { ok: false, error: 'insufficient', needed: n, missing: fromPaid - acc.credits, account: this.view(accountId, ipHash) };
      }
      const now = this.now();
      const credits = acc.credits - fromPaid;
      this.db.run(
        'UPDATE accounts SET free_used = ?, free_period_start = ?, credits = ?, pages_total = pages_total + ?, last_seen = ?, ip_hash = COALESCE(?, ip_hash) WHERE id = ?',
        (free.reset ? 0 : acc.free_used) + fromFree,
        free.periodStart,
        credits,
        n,
        now,
        ipHash,
        acc.id,
      );
      this.db.run('INSERT INTO usage (op_id, account_id, pages, free_pages, paid_pages, action, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', opId, acc.id, n, fromFree, fromPaid, action ? String(action).slice(0, 40) : null, now);
      if (fromFree > 0 && ipHash) {
        this.db.run('INSERT INTO ip_usage (ip_hash, day, pages) VALUES (?, ?, ?) ON CONFLICT(ip_hash, day) DO UPDATE SET pages = pages + excluded.pages', ipHash, this.day(now), fromFree);
      }
      if (fromPaid > 0) this.ledger(acc.id, -fromPaid, credits, 'usage', opId);
      return { ok: true, charged: { free: fromFree, paid: fromPaid }, account: this.view(accountId, ipHash) };
    });
  }

  ledger(accountId, delta, balance, reason, ref = null) {
    this.db.run('INSERT INTO ledger (account_id, delta, balance, reason, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)', accountId, delta, balance, reason, ref, this.now());
  }

  // ------------------------------------------------------------------ orders

  pack(id) {
    return this.config.packs.find((p) => p.id === id) || null;
  }

  /** Price of a pack for a payment method: { amount (minor units), currency }. */
  price(pack, provider) {
    if (provider === 'bank') return pack.vnd > 0 ? { amount: pack.vnd, currency: 'VND' } : null;
    if (provider === 'paypal') return pack.usd > 0 ? { amount: Math.round(pack.usd * 100), currency: 'USD' } : null;
    if (provider === 'test') return pack.vnd > 0 ? { amount: pack.vnd, currency: 'VND' } : { amount: Math.round(pack.usd * 100), currency: 'USD' };
    return null;
  }

  createOrder(accountId, { packId, provider, ipHash = null, userAgent = null }) {
    if (!this.config.providers.includes(provider)) throw new BillingError('provider_unavailable', 'This payment method is not available');
    const pack = this.pack(packId);
    if (!pack) throw new BillingError('unknown_pack', 'Unknown pack');
    const price = this.price(pack, provider);
    if (!price) throw new BillingError('provider_unavailable', 'This pack cannot be bought with this payment method');
    return this.db.transaction(() => {
      const acc = this.ensureAccount(accountId, { ipHash, userAgent });
      const now = this.now();
      this.expireOrders();
      // Asking again for the same pack shows the same transfer details.
      if (provider !== 'paypal') {
        const open = this.db.get(
          "SELECT * FROM orders WHERE account_id = ? AND pack_id = ? AND provider = ? AND status = 'pending' AND amount = ? AND currency = ? AND pages = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
          acc.id,
          pack.id,
          provider,
          price.amount,
          price.currency,
          pack.pages,
          now + 5 * 60 * 1000,
        );
        if (open) return open;
      }
      const prefix = this.config.payments.bank.orderPrefix || 'PE';
      for (let attempt = 0; ; attempt++) {
        const id = crypto.randomBytes(16).toString('hex');
        const code = prefix + randomCode(8);
        try {
          this.db.run(
            "INSERT INTO orders (id, code, account_id, pack_id, pages, amount, currency, provider, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
            id,
            code,
            acc.id,
            pack.id,
            pack.pages,
            price.amount,
            price.currency,
            provider,
            now,
            now + this.config.orderTtlMinutes * 60 * 1000,
          );
          return this.getOrder(id);
        } catch (e) {
          if (attempt >= 4 || !/UNIQUE/i.test(String(e.message))) throw e;
        }
      }
    });
  }

  getOrder(id) {
    return id ? this.db.get('SELECT * FROM orders WHERE id = ?', id) || null : null;
  }

  getOrderByCode(code) {
    return this.db.get('SELECT * FROM orders WHERE code = ?', code) || null;
  }

  getOrderByRef(provider, ref) {
    return this.db.get('SELECT * FROM orders WHERE provider = ? AND provider_ref = ? ORDER BY created_at DESC LIMIT 1', provider, ref) || null;
  }

  setOrderRef(id, ref) {
    this.db.run('UPDATE orders SET provider_ref = ? WHERE id = ?', ref, id);
  }

  expireOrders() {
    this.db.run("UPDATE orders SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?", this.now());
  }

  cancelOrder(id, accountId) {
    const res = this.db.run("UPDATE orders SET status = 'cancelled' WHERE id = ? AND account_id = ? AND status = 'pending'", id, accountId);
    return res.changes > 0;
  }

  listOrders(accountId, limit = 10) {
    this.expireOrders();
    return this.db.all('SELECT * FROM orders WHERE account_id = ? ORDER BY created_at DESC LIMIT ?', accountId, limit);
  }

  orderView(order) {
    if (!order) return null;
    const status = order.status === 'pending' && order.expires_at <= this.now() ? 'expired' : order.status;
    return {
      id: order.id,
      code: order.code,
      packId: order.pack_id,
      pages: order.pages,
      amount: order.amount,
      currency: order.currency,
      provider: order.provider,
      status,
      createdAt: order.created_at,
      expiresAt: order.expires_at,
      paidAt: order.paid_at || null,
    };
  }

  /**
   * Records a payment for an order and adds the pages to the account. The
   * payment id (unique per provider) makes the call safe to repeat: webhooks
   * are delivered more than once.
   *
   * Returns { status } with one of: paid, duplicate (same payment seen
   * before), already_paid (a second payment for a paid order), underpaid,
   * not_found.
   */
  recordPayment({ provider, paymentId, orderId, amount, currency, content = null, raw = null }) {
    const pid = `${provider}:${paymentId}`;
    return this.db.transaction(() => {
      const seen = this.db.get('SELECT * FROM payments WHERE id = ?', pid);
      if (seen) return { status: 'duplicate', order: this.getOrder(seen.order_id) };
      const now = this.now();
      const insert = (status, oid) =>
        this.db.run(
          'INSERT INTO payments (id, provider, order_id, amount, currency, status, content, raw, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          pid,
          provider,
          oid,
          Math.round(Number(amount) || 0),
          String(currency || ''),
          status,
          content ? String(content).slice(0, 500) : null,
          raw ? String(raw).slice(0, 4000) : null,
          now,
        );
      const order = this.getOrder(orderId);
      if (!order) {
        insert('unmatched', null);
        return { status: 'not_found', order: null };
      }
      if (order.status === 'paid') {
        insert('extra', order.id);
        return { status: 'already_paid', order };
      }
      if (String(currency) !== order.currency || Math.round(Number(amount) || 0) < order.amount) {
        insert('underpaid', order.id);
        return { status: 'underpaid', order };
      }
      insert('matched', order.id);
      const acc = this.ensureAccount(order.account_id);
      const credits = acc.credits + order.pages;
      this.db.run("UPDATE orders SET status = 'paid', paid_at = ?, provider_ref = COALESCE(provider_ref, ?) WHERE id = ?", now, String(paymentId), order.id);
      this.db.run('UPDATE accounts SET credits = ? WHERE id = ?', credits, acc.id);
      this.ledger(acc.id, order.pages, credits, 'purchase', order.id);
      return { status: 'paid', order: this.getOrder(order.id) };
    });
  }

  /** A transfer that could not be tied to an order; kept for the admin. */
  recordUnmatched({ provider, paymentId, amount, currency, content = null, raw = null }) {
    return this.recordPayment({ provider, paymentId, orderId: null, amount, currency, content, raw });
  }

  /**
   * Handles an incoming bank transfer: looks for an order code in the
   * transfer description and settles that order.
   */
  settleBankTransfer({ paymentId, amount, content, raw = null }) {
    const prefix = this.config.payments.bank.orderPrefix || 'PE';
    // Banks reformat the description freely: compare letters and digits only.
    const text = String(content || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const size = prefix.length + 8;
    let order = null;
    for (let i = text.indexOf(prefix); i >= 0 && !order; i = text.indexOf(prefix, i + 1)) {
      const candidate = text.slice(i, i + size);
      if (candidate.length === size) order = this.getOrderByCode(candidate);
    }
    if (!order) return this.recordUnmatched({ provider: 'bank', paymentId, amount, currency: 'VND', content, raw });
    return this.recordPayment({ provider: 'bank', paymentId, orderId: order.id, amount, currency: 'VND', content, raw });
  }

  // ------------------------------------------------------------------ restore

  restore(code) {
    const norm = normalizeRestoreCode(code);
    if (norm.length !== 20) return null;
    return this.db.get('SELECT * FROM accounts WHERE restore_code = ?', norm) || null;
  }

  // ------------------------------------------------------------------ admin

  /** Adds (or with a negative number removes) purchased pages by hand. */
  grant(accountRef, pages, note = '') {
    const n = Number(pages);
    if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 1000000) throw new BillingError('invalid_pages', 'pages must be a non-zero whole number');
    return this.db.transaction(() => {
      const acc = this.findAccount(accountRef);
      if (!acc) throw new BillingError('not_found', 'Account not found', 404);
      const credits = Math.max(0, acc.credits + n);
      this.db.run('UPDATE accounts SET credits = ? WHERE id = ?', credits, acc.id);
      this.ledger(acc.id, credits - acc.credits, credits, 'admin', String(note || '').slice(0, 200) || null);
      return this.getAccount(acc.id);
    });
  }

  /** Finds an account by public id, restore code or internal id. */
  findAccount(ref) {
    const raw = String(ref || '').trim();
    if (!raw) return null;
    const norm = normalizeRestoreCode(raw);
    return (
      this.db.get('SELECT * FROM accounts WHERE public_id = ?', norm) ||
      (norm.length === 20 ? this.db.get('SELECT * FROM accounts WHERE restore_code = ?', norm) : null) ||
      this.getAccount(raw) ||
      null
    );
  }

  /** Marks an order paid by hand (the admin saw the money arrive). */
  confirmOrder(orderRef, note = '') {
    const order = this.getOrder(orderRef) || this.getOrderByCode(String(orderRef || '').toUpperCase().trim());
    if (!order) throw new BillingError('not_found', 'Order not found', 404);
    if (order.status === 'paid') return { status: 'already_paid', order };
    return this.recordPayment({ provider: 'manual', paymentId: order.id, orderId: order.id, amount: order.amount, currency: order.currency, content: String(note || '').slice(0, 200) });
  }

  stats() {
    const now = this.now();
    const since = (ms) => now - ms;
    const revenue = (from) => {
      const rows = this.db.all("SELECT currency, COUNT(*) AS orders, SUM(amount) AS amount, SUM(pages) AS pages FROM orders WHERE status = 'paid' AND paid_at >= ? GROUP BY currency", from);
      const out = {};
      for (const r of rows) out[r.currency] = { orders: r.orders, amount: r.amount, pages: r.pages };
      return out;
    };
    const usage = (from) => this.db.get('SELECT COUNT(*) AS operations, COALESCE(SUM(pages), 0) AS pages, COALESCE(SUM(free_pages), 0) AS free, COALESCE(SUM(paid_pages), 0) AS paid FROM usage WHERE created_at >= ?', from);
    return {
      at: now,
      accounts: {
        total: this.db.get('SELECT COUNT(*) AS n FROM accounts').n,
        withCredits: this.db.get('SELECT COUNT(*) AS n FROM accounts WHERE credits > 0').n,
        active24h: this.db.get('SELECT COUNT(*) AS n FROM accounts WHERE last_seen >= ?', since(DAY)).n,
        creditsOutstanding: this.db.get('SELECT COALESCE(SUM(credits), 0) AS n FROM accounts').n,
      },
      orders: {
        pending: this.db.get("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending' AND expires_at > ?", now).n,
        paid: this.db.get("SELECT COUNT(*) AS n FROM orders WHERE status = 'paid'").n,
      },
      revenue: { day: revenue(since(DAY)), week: revenue(since(7 * DAY)), month: revenue(since(30 * DAY)), all: revenue(0) },
      usage: { day: usage(since(DAY)), week: usage(since(7 * DAY)), month: usage(since(30 * DAY)), all: usage(0) },
      payments: { needAttention: this.db.get("SELECT COUNT(*) AS n FROM payments WHERE status IN ('unmatched', 'underpaid', 'extra')").n },
    };
  }

  adminOrders({ status = null, limit = 100 } = {}) {
    this.expireOrders();
    const rows = status
      ? this.db.all('SELECT o.*, a.public_id FROM orders o LEFT JOIN accounts a ON a.id = o.account_id WHERE o.status = ? ORDER BY o.created_at DESC LIMIT ?', status, limit)
      : this.db.all('SELECT o.*, a.public_id FROM orders o LEFT JOIN accounts a ON a.id = o.account_id ORDER BY o.created_at DESC LIMIT ?', limit);
    return rows.map((o) => ({ ...this.orderView(o), account: o.public_id, note: o.note || null, providerRef: o.provider_ref || null }));
  }

  adminPayments({ attention = false, limit = 100 } = {}) {
    const rows = attention
      ? this.db.all("SELECT * FROM payments WHERE status IN ('unmatched', 'underpaid', 'extra') ORDER BY created_at DESC LIMIT ?", limit)
      : this.db.all('SELECT * FROM payments ORDER BY created_at DESC LIMIT ?', limit);
    return rows.map((p) => ({ id: p.id, provider: p.provider, orderId: p.order_id, amount: p.amount, currency: p.currency, status: p.status, content: p.content, createdAt: p.created_at }));
  }

  adminAccount(ref) {
    const acc = this.findAccount(ref);
    if (!acc) return null;
    return {
      id: acc.public_id,
      restoreCode: formatRestoreCode(acc.restore_code),
      createdAt: acc.created_at,
      lastSeen: acc.last_seen,
      freeUsed: acc.free_used,
      credits: acc.credits,
      pagesTotal: acc.pages_total,
      orders: this.db.all('SELECT * FROM orders WHERE account_id = ? ORDER BY created_at DESC LIMIT 50', acc.id).map((o) => this.orderView(o)),
      ledger: this.db.all('SELECT delta, balance, reason, ref, created_at AS createdAt FROM ledger WHERE account_id = ? ORDER BY id DESC LIMIT 50', acc.id),
    };
  }

  /** Housekeeping, run periodically by the server. */
  cleanup() {
    const now = this.now();
    this.expireOrders();
    this.db.run('DELETE FROM ip_usage WHERE day < ?', this.day(now) - 7);
    // Accounts that never bought anything and have not been seen for a long
    // time; their usage records go with them.
    const stale = now - 400 * DAY;
    this.db.run("DELETE FROM usage WHERE account_id IN (SELECT id FROM accounts WHERE credits = 0 AND last_seen < ? AND id NOT IN (SELECT account_id FROM orders WHERE status = 'paid'))", stale);
    this.db.run("DELETE FROM accounts WHERE credits = 0 AND last_seen < ? AND id NOT IN (SELECT account_id FROM orders WHERE status = 'paid')", stale);
  }
}
