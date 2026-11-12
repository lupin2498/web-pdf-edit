// Runtime configuration, read from environment variables (see .env.example).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BANKS, findBank } from './payments/banks.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_PACKS = [
  { id: 'p20', pages: 20, vnd: 10000, usd: 1.49 },
  { id: 'p100', pages: 100, vnd: 39000, usd: 3.99, popular: true },
  { id: 'p500', pages: 500, vnd: 149000, usd: 11.99 },
];

export const AD_PLACEMENTS = ['landing_top', 'landing_mid', 'landing_bottom', 'app_home', 'app_side'];

function bool(v, def = false) {
  if (v === undefined || v === null || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function int(v, def, min = -Infinity, max = Infinity) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// TRUST_PROXY: 0/false = no proxy, true/1..9 = that many reverse proxies in
// front of the server, "cloudflare" = trust the CF-Connecting-IP header.
function parseTrustProxy(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s || /^(0|false|no|off)$/.test(s)) return 0;
  if (s === 'cloudflare') return 'cloudflare';
  if (/^(true|yes|on)$/.test(s)) return 1;
  if (/^[1-9]$/.test(s)) return Number(s);
  throw new Error('TRUST_PROXY must be 0, the number of reverse proxies (1-9) or "cloudflare"');
}

function parseSiteUrl(v) {
  let s = String(v || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let url;
  try {
    url = new URL(s);
  } catch {
    throw new Error(`SITE_URL is not a valid URL: ${v}`);
  }
  // The site is served from the root of its domain.
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('SITE_URL must be just the scheme and host, e.g. https://pdf.example.com');
  return url.origin;
}

function parsePacks(raw) {
  if (!raw) return DEFAULT_PACKS;
  let list;
  try {
    list = JSON.parse(raw);
  } catch (e) {
    throw new Error(`PACKS is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(list) || !list.length) throw new Error('PACKS must be a non-empty JSON array');
  const seen = new Set();
  return list.map((p, i) => {
    const id = String(p.id || `p${p.pages}`);
    const pages = int(p.pages, 0);
    const vnd = int(p.vnd, 0);
    const usd = Number(p.usd) || 0;
    if (!/^[a-z0-9_-]{1,24}$/i.test(id) || seen.has(id)) throw new Error(`PACKS[${i}]: invalid or duplicate id`);
    if (pages <= 0) throw new Error(`PACKS[${i}]: pages must be a positive integer`);
    if (vnd <= 0 && usd <= 0) throw new Error(`PACKS[${i}]: needs a price (vnd and/or usd)`);
    seen.add(id);
    return { id, pages, vnd, usd: Math.round(usd * 100) / 100, popular: !!p.popular };
  });
}

/**
 * Builds the configuration object. `env` defaults to process.env; tests pass
 * their own values.
 */
export function loadConfig(env = process.env) {
  // ":memory:" keeps everything in RAM (used by tests).
  const dataDir = env.DATA_DIR === ':memory:' ? ':memory:' : path.resolve(ROOT, env.DATA_DIR || 'data');
  const siteUrl = parseSiteUrl(env.SITE_URL);

  const freePages = int(env.FREE_PAGES, 5, 0, 100000);
  const packs = parsePacks(env.PACKS);

  // ---- bank transfer (VietQR, confirmed by a SePay webhook or by the admin)
  const bankInput = String(env.BANK_BIN || env.BANK_CODE || '').trim();
  const bank = bankInput ? findBank(bankInput) : null;
  if (bankInput && !bank) throw new Error(`Unknown bank "${bankInput}". Use a 6-digit BIN (BANK_BIN) or one of: ${BANKS.map((b) => b.code).join(', ')}`);
  const bankAccount = String(env.BANK_ACCOUNT || '').replace(/\s+/g, '');
  // NAPAS (VietQR) account numbers have at most 19 characters.
  if (bankAccount && !/^[A-Za-z0-9]{4,19}$/.test(bankAccount)) throw new Error('BANK_ACCOUNT must be 4-19 letters or digits');
  let orderPrefix = String(env.ORDER_PREFIX || 'PE').toUpperCase().replace(/[^A-Z]/g, '');
  if (orderPrefix.length < 2 || orderPrefix.length > 6) orderPrefix = 'PE';
  const bankEnabled = !!(bank && bankAccount);

  // ---- PayPal
  const paypalEnv = /^(sandbox|test)$/i.test(env.PAYPAL_ENV || '') ? 'sandbox' : 'live';
  const paypalEnabled = !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);

  // ---- ads
  const adsenseClient = String(env.ADSENSE_CLIENT || '').trim();
  if (adsenseClient && !/^ca-pub-\d{10,20}$/.test(adsenseClient)) throw new Error('ADSENSE_CLIENT must look like ca-pub-1234567890123456');
  const slots = {};
  const customSlots = {};
  for (const p of AD_PLACEMENTS) {
    const id = String(env[`ADSENSE_SLOT_${p.toUpperCase()}`] || '').trim();
    if (id) {
      if (!/^\d{6,20}$/.test(id)) throw new Error(`ADSENSE_SLOT_${p.toUpperCase()} must be the numeric ad-unit id`);
      slots[p] = id;
    }
    const html = String(env[`ADS_HTML_${p.toUpperCase()}`] || '').trim();
    if (html) customSlots[p] = html;
  }

  const config = {
    port: int(env.PORT, 3000, 0, 65535),
    host: env.HOST || '0.0.0.0',
    siteUrl,
    siteName: String(env.SITE_NAME || 'PDF Edit').trim() || 'PDF Edit',
    contactEmail: String(env.CONTACT_EMAIL || '').trim(),
    dataDir,
    distDir: path.resolve(ROOT, env.DIST_DIR || 'dist'),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    sessionSecret: String(env.SESSION_SECRET || ''),
    adminToken: String(env.ADMIN_TOKEN || ''),
    free: {
      pages: freePages,
      // 0 = the free pages never come back; N = they are restored every N days.
      resetDays: int(env.FREE_RESET_DAYS, 0, 0, 3650),
      // Cap on free pages handed out to one IP address per day (all accounts).
      // Generous by default: mobile networks put many people behind one
      // address, and a newcomer must still see their free pages.
      ipDailyPages: int(env.FREE_IP_DAILY_PAGES, freePages * 20, 0, 1000000),
    },
    packs,
    orderTtlMinutes: int(env.ORDER_TTL_MINUTES, 60, 5, 7 * 24 * 60),
    payments: {
      bank: {
        enabled: bankEnabled,
        bin: bank ? bank.bin : '',
        bankCode: bank ? bank.code : '',
        bankName: bank ? bank.name : '',
        account: bankAccount,
        accountName: String(env.BANK_ACCOUNT_NAME || '').trim().toUpperCase(),
        orderPrefix,
        sepayApiKey: String(env.SEPAY_API_KEY || '').trim(),
        sepayWebhookSecret: String(env.SEPAY_WEBHOOK_SECRET || '').trim(),
      },
      paypal: {
        enabled: paypalEnabled,
        clientId: String(env.PAYPAL_CLIENT_ID || '').trim(),
        secret: String(env.PAYPAL_CLIENT_SECRET || '').trim(),
        env: paypalEnv,
        apiBase: String(env.PAYPAL_API_BASE || (paypalEnv === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com')).replace(/\/+$/, ''),
      },
      // Lets anyone complete an order without paying. For tests and demos only.
      test: { enabled: bool(env.PAYMENTS_TEST_MODE, false) },
    },
    ads: {
      adsenseClient,
      slots,
      customHead: String(env.ADS_CUSTOM_HEAD || '').trim(),
      customSlots,
      house: bool(env.ADS_HOUSE, true),
      hideForPaid: bool(env.ADS_HIDE_FOR_PAID, true),
      adsTxt: String(env.ADS_TXT || '').trim(),
    },
    analytics: { gaId: /^G-[A-Z0-9]{4,20}$/.test(String(env.GA_MEASUREMENT_ID || '').trim()) ? String(env.GA_MEASUREMENT_ID).trim() : '' },
    logRequests: bool(env.LOG_REQUESTS, false),
  };

  // Packs that can actually be bought with the enabled payment methods.
  config.providers = [];
  if (config.payments.bank.enabled && packs.some((p) => p.vnd > 0)) config.providers.push('bank');
  if (config.payments.paypal.enabled && packs.some((p) => p.usd > 0)) config.providers.push('paypal');
  if (config.payments.test.enabled) config.providers.push('test');
  return config;
}

/** Loads KEY=VALUE pairs from a .env file into process.env (existing values win). */
export function loadEnvFile(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    let value = m[2].trim();
    const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
    if (quoted) value = quoted[1] === '"' ? quoted[2].replace(/\\n/g, '\n').replace(/\\"/g, '"') : quoted[2];
    else value = value.replace(/\s+#.*$/, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
  return true;
}

/** The part of the configuration that pages and the editor may see. */
export function publicConfig(config) {
  const bank = config.payments.bank;
  return {
    siteName: config.siteName,
    siteUrl: config.siteUrl,
    contactEmail: config.contactEmail,
    free: { pages: config.free.pages, resetDays: config.free.resetDays },
    packs: config.packs,
    providers: config.providers,
    bank: bank.enabled ? { bankName: bank.bankName, bankCode: bank.bankCode, account: bank.account, accountName: bank.accountName } : null,
    paypal: config.payments.paypal.enabled ? { env: config.payments.paypal.env } : null,
    testMode: config.payments.test.enabled,
    ads: {
      adsenseClient: config.ads.adsenseClient,
      slots: config.ads.slots,
      customSlots: config.ads.customSlots,
      house: config.ads.house,
      hideForPaid: config.ads.hideForPaid,
    },
    analytics: config.analytics,
  };
}
