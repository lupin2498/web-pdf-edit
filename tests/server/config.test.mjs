// Configuration from environment variables.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, publicConfig, loadEnvFile, DEFAULT_PACKS } from '../../server/config.mjs';
import { findBank } from '../../server/payments/banks.mjs';
import { BANK_ENV } from './helpers.mjs';

describe('loadConfig', () => {
  test('defaults', () => {
    const c = loadConfig({});
    assert.equal(c.port, 3000);
    assert.equal(c.siteName, 'PDF Edit');
    assert.equal(c.siteUrl, '');
    assert.deepEqual(c.free, { pages: 5, resetDays: 0, ipDailyPages: 100 });
    assert.deepEqual(c.packs, DEFAULT_PACKS);
    assert.deepEqual(c.providers, []);
    assert.equal(c.orderTtlMinutes, 60);
    assert.equal(c.trustProxy, 0);
    assert.equal(c.ads.house, true);
    assert.equal(c.ads.hideForPaid, true);
    assert.equal(c.payments.bank.enabled, false);
    assert.equal(c.payments.bank.orderPrefix, 'PE');
    assert.equal(c.payments.paypal.apiBase, 'https://api-m.paypal.com');
  });

  test('numbers are clamped to sensible ranges', () => {
    const c = loadConfig({ FREE_PAGES: '-3', FREE_RESET_DAYS: '99999', ORDER_TTL_MINUTES: '1', PORT: 'abc' });
    assert.equal(c.free.pages, 0);
    assert.equal(c.free.ipDailyPages, 0);
    assert.equal(c.free.resetDays, 3650);
    assert.equal(c.orderTtlMinutes, 5);
    assert.equal(c.port, 3000);
  });

  test('custom packs', () => {
    const c = loadConfig({ PACKS: JSON.stringify([{ id: 'small', pages: 10, vnd: 5000, usd: 0.999 }, { pages: 50, vnd: '20000', popular: 1 }]) });
    assert.deepEqual(c.packs, [
      { id: 'small', pages: 10, vnd: 5000, usd: 1, popular: false },
      { id: 'p50', pages: 50, vnd: 20000, usd: 0, popular: true },
    ]);
  });

  test('invalid packs are reported', () => {
    for (const [packs, re] of [
      ['{not json', /PACKS is not valid JSON/],
      ['{}', /non-empty JSON array/],
      ['[]', /non-empty JSON array/],
      [JSON.stringify([{ id: 'a', pages: 10, vnd: 1 }, { id: 'a', pages: 20, vnd: 2 }]), /duplicate id/],
      [JSON.stringify([{ id: 'bad id', pages: 10, vnd: 1 }]), /invalid or duplicate id/],
      [JSON.stringify([{ id: 'a', pages: 0, vnd: 1 }]), /pages must be a positive integer/],
      [JSON.stringify([{ id: 'a', pages: 10 }]), /needs a price/],
    ]) {
      assert.throws(() => loadConfig({ PACKS: packs }), re, packs);
    }
  });

  test('ad settings are validated', () => {
    assert.throws(() => loadConfig({ ADSENSE_CLIENT: 'pub-123' }), /ADSENSE_CLIENT/);
    assert.throws(() => loadConfig({ ADSENSE_CLIENT: 'ca-pub-1234567890', ADSENSE_SLOT_APP_HOME: 'abc' }), /ADSENSE_SLOT_APP_HOME/);
    const c = loadConfig({ ADSENSE_CLIENT: 'ca-pub-1234567890', ADSENSE_SLOT_LANDING_TOP: '1234567', ADS_HTML_APP_SIDE: '<b>ad</b>', ADS_HOUSE: 'false', ADS_HIDE_FOR_PAID: '0' });
    assert.deepEqual(c.ads.slots, { landing_top: '1234567' });
    assert.deepEqual(c.ads.customSlots, { app_side: '<b>ad</b>' });
    assert.equal(c.ads.house, false);
    assert.equal(c.ads.hideForPaid, false);
    assert.equal(loadConfig({ GA_MEASUREMENT_ID: 'UA-123' }).analytics.gaId, '');
    assert.equal(loadConfig({ GA_MEASUREMENT_ID: 'G-ABCDEF12' }).analytics.gaId, 'G-ABCDEF12');
  });

  test('bank settings', () => {
    assert.throws(() => loadConfig({ BANK_CODE: 'NOPE', BANK_ACCOUNT: '123456' }), /Unknown bank "NOPE"/);
    assert.throws(() => loadConfig({ BANK_CODE: 'VCB', BANK_ACCOUNT: '12-34' }), /BANK_ACCOUNT/);
    // Longer numbers do not fit in a VietQR code.
    assert.throws(() => loadConfig({ BANK_CODE: 'VCB', BANK_ACCOUNT: '1'.repeat(20) }), /BANK_ACCOUNT/);
    assert.equal(loadConfig({ BANK_CODE: 'VCB', BANK_ACCOUNT: '1'.repeat(19) }).payments.bank.enabled, true);
    const c = loadConfig({ BANK_CODE: 'vietcombank', BANK_ACCOUNT: ' 0071 0001 23456 ', BANK_ACCOUNT_name: 'x', BANK_ACCOUNT_NAME: 'nguyễn văn a', ORDER_PREFIX: 'pdf1' });
    assert.equal(c.payments.bank.enabled, true);
    assert.equal(c.payments.bank.bin, '970436');
    assert.equal(c.payments.bank.bankCode, 'VCB');
    assert.equal(c.payments.bank.account, '0071000123456');
    assert.equal(c.payments.bank.accountName, 'NGUYỄN VĂN A');
    assert.equal(c.payments.bank.orderPrefix, 'PDF');
    assert.equal(loadConfig({ ORDER_PREFIX: 'x' }).payments.bank.orderPrefix, 'PE');
    assert.equal(loadConfig({ ORDER_PREFIX: 'TOOLONGX' }).payments.bank.orderPrefix, 'PE');
    // A bank without an account number is not a payment method.
    assert.equal(loadConfig({ BANK_CODE: 'VCB' }).payments.bank.enabled, false);
    assert.equal(loadConfig({ BANK_BIN: '970422', BANK_ACCOUNT: '123456' }).payments.bank.bankCode, 'MB');
  });

  test('payment methods depend on the configuration', () => {
    assert.deepEqual(loadConfig(BANK_ENV).providers, ['bank']);
    assert.deepEqual(loadConfig({ PAYPAL_CLIENT_ID: 'a' }).providers, []);
    assert.deepEqual(loadConfig({ PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b' }).providers, ['paypal']);
    assert.deepEqual(loadConfig({ ...BANK_ENV, PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b', PAYMENTS_TEST_MODE: 'yes' }).providers, ['bank', 'paypal', 'test']);
    // Packs without a USD price cannot be sold through PayPal.
    assert.deepEqual(loadConfig({ PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b', PACKS: JSON.stringify([{ id: 'a', pages: 5, vnd: 1000 }]) }).providers, []);
    assert.equal(loadConfig({ PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b', PAYPAL_ENV: 'Sandbox' }).payments.paypal.apiBase, 'https://api-m.sandbox.paypal.com');
  });

  test('SITE_URL', () => {
    assert.equal(loadConfig({ SITE_URL: 'pdf.example.com/' }).siteUrl, 'https://pdf.example.com');
    assert.equal(loadConfig({ SITE_URL: 'http://localhost:3000' }).siteUrl, 'http://localhost:3000');
    assert.equal(loadConfig({ SITE_URL: 'HTTPS://PDF.Example.com' }).siteUrl, 'https://pdf.example.com');
    assert.throws(() => loadConfig({ SITE_URL: 'https://example.com/pdf' }), /SITE_URL must be just the scheme and host/);
    assert.throws(() => loadConfig({ SITE_URL: 'https://exa mple.com' }), /SITE_URL is not a valid URL/);
  });

  test('TRUST_PROXY', () => {
    for (const [v, want] of [['', 0], ['0', 0], ['false', 0], ['true', 1], ['1', 1], ['2', 2], ['Cloudflare', 'cloudflare']]) assert.equal(loadConfig({ TRUST_PROXY: v }).trustProxy, want, v);
    assert.throws(() => loadConfig({ TRUST_PROXY: '10.0.0.1' }), /TRUST_PROXY/);
  });

  test('DATA_DIR', () => {
    assert.equal(loadConfig({ DATA_DIR: ':memory:' }).dataDir, ':memory:');
    assert.ok(path.isAbsolute(loadConfig({}).dataDir));
  });
});

describe('publicConfig', () => {
  test('carries what pages need and no secrets', () => {
    const c = loadConfig({ ...BANK_ENV, SEPAY_WEBHOOK_SECRET: 'whsec-123', PAYPAL_CLIENT_ID: 'cid-123', PAYPAL_CLIENT_SECRET: 'secret-123', ADMIN_TOKEN: 'admin-123456789', SESSION_SECRET: 'sess-123', CONTACT_EMAIL: 'help@example.com' });
    const p = publicConfig(c);
    const text = JSON.stringify(p);
    for (const s of ['sepay-key-123', 'whsec-123', 'cid-123', 'secret-123', 'admin-123456789', 'sess-123']) assert.equal(text.includes(s), false, s);
    assert.deepEqual(p.bank, { bankName: 'MB Bank', bankCode: 'MB', account: '0123456789', accountName: 'NGUYEN VAN A' });
    assert.deepEqual(p.paypal, { env: 'live' });
    assert.deepEqual(p.free, { pages: 5, resetDays: 0 });
    assert.equal(p.contactEmail, 'help@example.com');
    assert.equal(p.testMode, false);
    assert.equal(publicConfig(loadConfig({})).bank, null);
    assert.equal(publicConfig(loadConfig({})).paypal, null);
  });
});

describe('findBank', () => {
  test('by code, name or BIN', () => {
    assert.equal(findBank('VCB').bin, '970436');
    assert.equal(findBank('Vietcombank').code, 'VCB');
    assert.equal(findBank('mb').code, 'MB');
    assert.equal(findBank('MB Bank').code, 'MB');
    assert.equal(findBank('techcombank').bin, '970407');
    assert.equal(findBank('970422').code, 'MB');
    assert.deepEqual(findBank('999999'), { code: '999999', bin: '999999', name: 'Ngân hàng 999999' });
    assert.equal(findBank('nope'), null);
    assert.equal(findBank(''), null);
    assert.equal(findBank(null), null);
  });
});

describe('loadEnvFile', () => {
  test('reads KEY=VALUE lines and keeps existing variables', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pdfedit-env-')), '.env');
    fs.writeFileSync(file, ['# comment', 'PE_TEST_A=plain value # trailing comment', 'export PE_TEST_B="quoted # not a comment"', "PE_TEST_C='single'", 'PE_TEST_D="line\\nbreak"', 'PE_TEST_KEEP=from-file', 'not a line', ''].join('\n'));
    process.env.PE_TEST_KEEP = 'from-env';
    try {
      assert.equal(loadEnvFile(file), true);
      assert.equal(process.env.PE_TEST_A, 'plain value');
      assert.equal(process.env.PE_TEST_B, 'quoted # not a comment');
      assert.equal(process.env.PE_TEST_C, 'single');
      assert.equal(process.env.PE_TEST_D, 'line\nbreak');
      assert.equal(process.env.PE_TEST_KEEP, 'from-env');
      assert.equal(loadEnvFile(path.join(path.dirname(file), 'missing')), false);
    } finally {
      for (const k of ['A', 'B', 'C', 'D', 'KEEP']) delete process.env[`PE_TEST_${k}`];
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });
});
