// Client side of the usage model: the account (free pages + purchased
// pages), talking to the server API and metering of exports.
//
// One page of an exported document costs one page of the allowance. A page
// that was already paid for in this editing session is not charged again, so
// downloading a document a second time or in another format is free.
import { readConfig } from './config.js';

const CACHE_KEY = 'pdfedit.account';
const PENDING_KEY = 'pdfedit.pendingUsage';
const STALE_MS = 30 * 1000;

function loadJson(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

export function newOpId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class ApiError extends Error {
  constructor(status, code, message, data = null) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

class BillingClient extends EventTarget {
  constructor() {
    super();
    this.config = readConfig();
    const limit = this.config.free.pages;
    this.account = { id: null, free: { limit, remaining: limit, resetsAt: null }, credits: 0, available: limit, adFree: false, restoreCode: null };
    const cached = loadJson(CACHE_KEY, null);
    if (cached && cached.free && typeof cached.credits === 'number') this.account = this.normalize(cached);
    // true once the server answered; false while working from the cache.
    this.online = false;
    this.loadedAt = 0;
    this.ready = null;
  }

  normalize(a) {
    const limit = Number.isFinite(a.free?.limit) ? a.free.limit : this.config.free.pages;
    const remaining = Math.max(0, Math.min(limit, Number(a.free?.remaining) || 0));
    const credits = Math.max(0, Math.round(Number(a.credits) || 0));
    return { id: a.id || null, free: { limit, remaining, resetsAt: a.free?.resetsAt || null }, credits, available: remaining + credits, adFree: credits > 0, restoreCode: a.restoreCode || null };
  }

  get available() {
    return this.account.free.remaining + this.account.credits;
  }

  /** Ads are hidden while the user holds purchased pages. */
  get adFree() {
    return this.config.ads.hideForPaid !== false && this.account.credits > 0;
  }

  setAccount(account, { silent = false } = {}) {
    const before = this.account;
    this.account = this.normalize(account);
    saveJson(CACHE_KEY, this.account);
    if (!silent) this.dispatchEvent(new CustomEvent('change', { detail: { account: this.account, before } }));
  }

  async request(path, { method = 'GET', body = null, timeout = 15000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetch(`${this.config.base}api/${path}`, {
        method,
        credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new ApiError(0, 'network', 'Network error');
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    // No JSON answer means there is no API here (static hosting) or it is down.
    if (!data && (res.status === 404 || res.status >= 500 || res.ok)) throw new ApiError(0, 'network', 'Service unavailable');
    if (!res.ok) throw new ApiError(res.status, (data && data.error) || 'error', (data && data.message) || `HTTP ${res.status}`, data);
    return data;
  }

  init() {
    if (!this.ready) {
      this.ready = this.refresh().then(() => this.flushPending());
      try {
        this.channel = new BroadcastChannel('pdfedit-billing');
        this.channel.onmessage = () => this.refresh();
      } catch {
        this.channel = null;
      }
      // Purchases may complete in another tab (PayPal) or by bank transfer.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.refreshIfStale();
      });
      window.addEventListener('online', () => this.refresh().then(() => this.flushPending()));
    }
    return this.ready;
  }

  async refresh() {
    try {
      const data = await this.request('me');
      this.online = true;
      this.loadedAt = Date.now();
      this.setAccount(data.account);
    } catch (e) {
      if (e.status === 0) this.online = false;
      this.dispatchEvent(new CustomEvent('change', { detail: { account: this.account, before: this.account } }));
    }
    return this.account;
  }

  refreshIfStale() {
    return Date.now() - this.loadedAt > STALE_MS ? this.refresh() : Promise.resolve(this.account);
  }

  // ------------------------------------------------------------------ usage

  /**
   * Charges pages. Resolves to { ok: true, charged } or
   * { ok: false, missing }. When the server cannot be reached the charge is
   * taken from the cached balance and reported later.
   */
  async consume(pages, action, opId = newOpId()) {
    try {
      const data = await this.request('usage/consume', { method: 'POST', body: { pages, action, opId } });
      this.online = true;
      this.loadedAt = Date.now();
      this.setAccount(data.account);
      return { ok: true, charged: data.charged };
    } catch (e) {
      if (e.status === 402 && e.data) {
        if (e.data.account) this.setAccount(e.data.account);
        return { ok: false, missing: e.data.missing || Math.max(1, pages - this.available) };
      }
      if (e.status !== 0) throw e;
      this.online = false;
      if (this.available < pages) return { ok: false, missing: pages - this.available, offline: true };
      const fromFree = Math.min(pages, this.account.free.remaining);
      const fromPaid = pages - fromFree;
      this.setAccount({ ...this.account, free: { ...this.account.free, remaining: this.account.free.remaining - fromFree }, credits: this.account.credits - fromPaid });
      const pending = loadJson(PENDING_KEY, []);
      pending.push({ opId, pages, action, at: Date.now() });
      saveJson(PENDING_KEY, pending.slice(-50));
      return { ok: true, charged: { free: fromFree, paid: fromPaid }, offline: true };
    }
  }

  /** Reports charges that were made while the server was unreachable. */
  async flushPending() {
    const pending = loadJson(PENDING_KEY, []);
    if (!pending.length || !this.online) return;
    const left = [];
    for (const op of pending) {
      try {
        const data = await this.request('usage/consume', { method: 'POST', body: { pages: op.pages, action: op.action, opId: op.opId } });
        this.setAccount(data.account);
      } catch (e) {
        if (e.status === 0) left.push(op);
        else if (e.data && e.data.account) this.setAccount(e.data.account);
      }
    }
    saveJson(PENDING_KEY, left);
  }

  // ------------------------------------------------------------------ orders

  async createOrder(packId, provider) {
    const data = await this.request('orders', { method: 'POST', body: { packId, provider } });
    if (data.account) this.setAccount(data.account);
    return data;
  }

  async getOrder(id) {
    const data = await this.request(`orders/${id}`);
    if (data.account) this.setAccount(data.account);
    return data;
  }

  async cancelOrder(id) {
    try {
      await this.request(`orders/${id}/cancel`, { method: 'POST', body: {} });
    } catch {
      /* the order simply expires */
    }
  }

  async listOrders() {
    const data = await this.request('orders');
    return data.orders || [];
  }

  async completeTestOrder(orderId) {
    const data = await this.request('pay/test/complete', { method: 'POST', body: { orderId } });
    if (data.account) this.setAccount(data.account);
    return data;
  }

  async restore(code) {
    const data = await this.request('account/restore', { method: 'POST', body: { code } });
    this.setAccount(data.account);
    return data.account;
  }

  /** Tells other tabs of this site that the balance changed. */
  announce() {
    try {
      if (this.channel) this.channel.postMessage({ type: 'changed' });
    } catch {
      /* ignore */
    }
  }
}

export const billing = new BillingClient();

// ------------------------------------------------------------------ metering

/** Identity of a page for charging: the same source page is paid once. */
export function pageKey(entry) {
  return entry.src ? `${entry.src.doc}:${entry.src.index}` : `new:${entry.uid}`;
}

export function paidKeys(session) {
  if (!session.paidKeys) session.paidKeys = new Set();
  return session.paidKeys;
}

/** Number of pages of `entries` that have not been paid for yet. */
export function billablePages(session, entries) {
  const paid = paidKeys(session);
  const keys = new Set();
  for (const e of entries) {
    const k = pageKey(e);
    if (!paid.has(k)) keys.add(k);
  }
  return keys.size;
}

let paywallOpener = null;
/** The paywall dialog is provided by the UI layer (see paywall.js). */
export function setPaywall(fn) {
  paywallOpener = fn;
}

/**
 * Checks that the user can afford to export `entries` and returns a ticket;
 * `await ticket.commit()` charges right before the file is handed over.
 * Resolves to null when the user closes the paywall without buying.
 */
export async function authorize(session, entries, action) {
  const keys = [...new Set(entries.map(pageKey))];
  const paid = paidKeys(session);
  const pages = keys.filter((k) => !paid.has(k)).length;
  const opId = newOpId();
  const info = { pages, total: keys.length, action, name: session.name };
  const ticket = {
    pages,
    committed: false,
    async commit() {
      if (ticket.committed) return true;
      if (pages > 0) {
        for (;;) {
          const r = await billing.consume(pages, action, opId);
          if (r.ok) {
            ticket.charged = r.charged;
            break;
          }
          if (!paywallOpener || !(await paywallOpener({ ...info, missing: r.missing }))) return false;
        }
      }
      for (const k of keys) paid.add(k);
      ticket.committed = true;
      if (pages > 0) billing.dispatchEvent(new CustomEvent('charged', { detail: { pages, charged: ticket.charged, action, account: billing.account } }));
      return true;
    },
  };
  if (pages === 0) return ticket;
  await billing.refreshIfStale();
  if (billing.available < pages) {
    if (!paywallOpener || !(await paywallOpener({ ...info, missing: pages - billing.available }))) return null;
  }
  return ticket;
}
