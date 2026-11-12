// SQLite storage (node:sqlite, built into Node.js 22.13+). One file in
// DATA_DIR; ":memory:" is used by tests.
import fs from 'node:fs';
import path from 'node:path';

let DatabaseSync = null;

async function loadSqlite() {
  if (DatabaseSync) return DatabaseSync;
  // node:sqlite prints an ExperimentalWarning on first use; keep logs clean.
  const emit = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    if (/SQLite is an experimental feature/i.test(String(warning && warning.message ? warning.message : warning))) return;
    return emit.call(process, warning, ...rest);
  };
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch (e) {
    throw new Error(`This server needs Node.js 22.13 or newer (node:sqlite is unavailable): ${e.message}`);
  } finally {
    process.emitWarning = emit;
  }
  return DatabaseSync;
}

const MIGRATIONS = [
  `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    public_id TEXT NOT NULL UNIQUE,
    restore_code TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    free_used INTEGER NOT NULL DEFAULT 0,
    free_period_start INTEGER NOT NULL,
    credits INTEGER NOT NULL DEFAULT 0,
    pages_total INTEGER NOT NULL DEFAULT 0,
    ip_hash TEXT,
    user_agent TEXT
  );
  CREATE TABLE usage (
    op_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    pages INTEGER NOT NULL,
    free_pages INTEGER NOT NULL,
    paid_pages INTEGER NOT NULL,
    action TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX usage_account ON usage(account_id, created_at);
  CREATE INDEX usage_created ON usage(created_at);
  CREATE TABLE ip_usage (
    ip_hash TEXT NOT NULL,
    day INTEGER NOT NULL,
    pages INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (ip_hash, day)
  );
  CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    account_id TEXT NOT NULL,
    pack_id TEXT NOT NULL,
    pages INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL,
    provider TEXT NOT NULL,
    status TEXT NOT NULL,
    provider_ref TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    paid_at INTEGER,
    note TEXT
  );
  CREATE INDEX orders_account ON orders(account_id, created_at);
  CREATE INDEX orders_status ON orders(status, created_at);
  CREATE INDEX orders_ref ON orders(provider, provider_ref);
  CREATE TABLE payments (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    order_id TEXT,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL,
    content TEXT,
    raw TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX payments_order ON payments(order_id);
  CREATE INDEX payments_status ON payments(status, created_at);
  CREATE TABLE ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    delta INTEGER NOT NULL,
    balance INTEGER NOT NULL,
    reason TEXT NOT NULL,
    ref TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX ledger_account ON ledger(account_id, created_at);
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
];

export async function openDatabase(file) {
  const Database = await loadSqlite();
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  const version = db.prepare('PRAGMA user_version').get().user_version || 0;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  const cache = new Map();
  const api = {
    raw: db,
    prepare(sql) {
      let st = cache.get(sql);
      if (!st) {
        st = db.prepare(sql);
        cache.set(sql, st);
      }
      return st;
    },
    get: (sql, ...params) => api.prepare(sql).get(...params),
    all: (sql, ...params) => api.prepare(sql).all(...params),
    run: (sql, ...params) => api.prepare(sql).run(...params),
    /** Runs fn inside one write transaction; nested calls join the outer one. */
    transaction(fn) {
      if (api.inTransaction) return fn();
      db.exec('BEGIN IMMEDIATE');
      api.inTransaction = true;
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (e) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        throw e;
      } finally {
        api.inTransaction = false;
      }
    },
    getMeta(key) {
      const row = api.get('SELECT value FROM meta WHERE key = ?', key);
      return row ? row.value : null;
    },
    setMeta(key, value) {
      api.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
    },
    close() {
      cache.clear();
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
    inTransaction: false,
  };
  return api;
}
