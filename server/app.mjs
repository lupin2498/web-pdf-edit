// The web application: JSON API (accounts, usage, orders, payments, admin)
// in front of the static site.
import crypto from 'node:crypto';
import path from 'node:path';
import { openDatabase } from './db.mjs';
import { Billing, BillingError, newAccountId } from './billing.mjs';
import { publicConfig } from './config.mjs';
import { createStatic, inlineJson, escapeHtml } from './static.mjs';
import { packsHtml } from '../src/site/pricing-html.mjs';
import { vietQrPayload } from './payments/vietqr.mjs';
import { PayPal } from './payments/paypal.mjs';
import { HttpError, readBody, parseJson, sendJson, sendText, redirect, parseCookies, signValue, safeEqual, clientIp, ipKey, isSecure, createLimiter } from './http.mjs';

const COOKIE = 'pe_sid';
const COOKIE_MAX_AGE = 2 * 365 * 24 * 60 * 60;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function headExtra(config) {
  const parts = [];
  const { adsenseClient, customHead } = config.ads;
  if (adsenseClient) parts.push(`<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${adsenseClient}" crossorigin="anonymous"></script>`);
  if (customHead) parts.push(customHead);
  if (config.analytics.gaId) {
    parts.push(`<script async src="https://www.googletagmanager.com/gtag/js?id=${config.analytics.gaId}"></script>`);
    parts.push(`<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${config.analytics.gaId}');</script>`);
  }
  return parts.join('\n    ');
}

/** True when third-party scripts (ads, analytics) are part of the pages. */
function hasThirdParty(config) {
  return !!(config.ads.adsenseClient || config.ads.customHead || Object.keys(config.ads.customSlots).length || config.analytics.gaId);
}

const STRICT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

export async function createApp(config, { clock = () => Date.now(), fetchImpl = fetch, log = console } = {}) {
  const db = await openDatabase(config.dataDir === ':memory:' ? ':memory:' : path.join(config.dataDir, 'pdfedit.sqlite'));
  let secret = config.sessionSecret;
  if (!secret) {
    secret = db.getMeta('session_secret');
    if (!secret) {
      secret = crypto.randomBytes(32).toString('base64url');
      db.setMeta('session_secret', secret);
    }
  }
  const billing = new Billing(db, config, clock);
  const paypal = config.payments.paypal.enabled ? new PayPal(config.payments.paypal, fetchImpl) : null;
  const limiter = createLimiter(clock);
  const pub = publicConfig(config);
  const statics = createStatic({
    distDir: config.distDir,
    watch: process.env.NODE_ENV !== 'production',
    // HEAD_EXTRA is HTML written by the operator (ad and analytics tags).
    vars: {
      PUBLIC_CONFIG: inlineJson(pub),
      HEAD_EXTRA: headExtra(config),
      SITE_URL: escapeHtml(config.siteUrl),
      SITE_NAME: escapeHtml(config.siteName),
      FREE_PAGES: String(config.free.pages),
      CONTACT_EMAIL: escapeHtml(config.contactEmail || '—'),
      // Price cards follow the PACKS setting (see src/site/pricing-html.mjs).
      PRICING_VI: packsHtml(pub, 'vi'),
      PRICING_EN: packsHtml(pub, 'en'),
    },
  });
  const csp = hasThirdParty(config) ? "frame-ancestors 'self'" : STRICT_CSP;

  const hashIp = (ip) => (ip ? crypto.createHmac('sha256', secret).update(`ip:${ip}`).digest('base64url').slice(0, 22) : null);

  // ------------------------------------------------------------------ context

  function context(req, res) {
    const url = new URL(req.url, 'http://localhost');
    // Per-address limits count IPv4 addresses and IPv6 /64 networks.
    const ip = ipKey(clientIp(req, config.trustProxy));
    const ctx = { req, res, url, path: url.pathname, ip, ipHash: hashIp(ip), secure: isSecure(req, config.trustProxy) || /^https:/i.test(config.siteUrl), cookies: parseCookies(req.headers.cookie), sessionId: null };
    ctx.origin = () => {
      if (config.siteUrl) return config.siteUrl;
      const host = (config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host || `localhost:${config.port}`;
      return `${ctx.secure ? 'https' : 'http'}://${String(host).split(',')[0].trim()}`;
    };
    return ctx;
  }

  function setSessionCookie(ctx, id) {
    const value = `${id}.${signValue(id, secret)}`;
    const cookie = `${COOKIE}=${value}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax${ctx.secure ? '; Secure' : ''}`;
    const prev = ctx.res.getHeader('Set-Cookie');
    ctx.res.setHeader('Set-Cookie', prev ? [].concat(prev, cookie) : cookie);
    ctx.sessionId = id;
  }

  /** The account id of this browser (a signed cookie; issued on first use). */
  function session(ctx) {
    if (ctx.sessionId) return ctx.sessionId;
    const raw = ctx.cookies[COOKIE] || '';
    const dot = raw.lastIndexOf('.');
    if (dot > 0) {
      const id = raw.slice(0, dot);
      if (/^[A-Za-z0-9_-]{16,40}$/.test(id) && safeEqual(raw.slice(dot + 1), signValue(id, secret))) {
        ctx.sessionId = id;
        return id;
      }
    }
    const id = newAccountId();
    setSessionCookie(ctx, id);
    return id;
  }

  function limit(ctx, name, max, windowMs, key = ctx.ip) {
    const r = limiter.hit(`${name}:${key}`, max, windowMs);
    if (!r.ok) throw new HttpError(429, 'rate_limited', 'Too many requests, please try again later', { retryAfter: r.retryAfter });
  }

  /** Requests that change state must come from our own pages. */
  function sameOrigin(ctx) {
    const { req } = ctx;
    if (String(req.headers['sec-fetch-site'] || '') === 'cross-site') throw new HttpError(403, 'forbidden', 'Cross-site request refused');
    const origin = req.headers.origin;
    if (!origin || origin === 'null') return;
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      throw new HttpError(403, 'forbidden', 'Cross-site request refused');
    }
    const allowed = [req.headers.host, config.trustProxy ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim() : '', config.siteUrl ? new URL(config.siteUrl).host : ''];
    if (!allowed.includes(host)) throw new HttpError(403, 'forbidden', 'Cross-site request refused');
  }

  async function jsonBody(ctx, limitBytes) {
    const type = String(ctx.req.headers['content-type'] || '');
    if (!/^application\/json\b/i.test(type)) throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
    return parseJson(await readBody(ctx.req, limitBytes));
  }

  function admin(ctx) {
    if (!config.adminToken) throw new HttpError(404, 'not_found', 'Not found');
    const header = String(ctx.req.headers.authorization || '');
    const token = header.replace(/^Bearer\s+/i, '');
    if (!token || !safeEqual(token, config.adminToken)) {
      limit(ctx, 'admin-fail', 20, HOUR);
      throw new HttpError(401, 'unauthorized', 'Invalid admin token');
    }
  }

  // ------------------------------------------------------------------ payment helpers

  function bankInstructions(order) {
    const b = config.payments.bank;
    return {
      type: 'bank',
      qr: vietQrPayload({ bin: b.bin, account: b.account, amount: order.amount, content: order.code }),
      bankName: b.bankName,
      bankCode: b.bankCode,
      account: b.account,
      accountName: b.accountName,
      amount: order.amount,
      content: order.code,
      auto: !!(b.sepayApiKey || b.sepayWebhookSecret),
    };
  }

  function sepayAuthorized(ctx, raw) {
    const b = config.payments.bank;
    const auth = String(ctx.req.headers.authorization || '').trim();
    if (b.sepayApiKey && auth) {
      const key = auth.replace(/^(?:Bearer\s+)?Apikey\s+/i, '').replace(/^Bearer\s+/i, '');
      if (safeEqual(key, b.sepayApiKey)) return true;
    }
    if (b.sepayWebhookSecret) {
      const sig = String(ctx.req.headers['x-sepay-signature'] || '').trim().replace(/^sha256[=:]\s*/i, '').toLowerCase();
      const ts = String(ctx.req.headers['x-sepay-timestamp'] || '').trim();
      if (sig && /^\d{9,13}$/.test(ts)) {
        const seconds = ts.length > 10 ? Math.floor(Number(ts) / 1000) : Number(ts);
        // Old signatures are refused so a captured request cannot be replayed.
        if (Math.abs(clock() / 1000 - seconds) <= 300) {
          const expected = crypto.createHmac('sha256', b.sepayWebhookSecret).update(`${ts}.`).update(raw).digest('hex');
          if (safeEqual(sig, expected)) return true;
        }
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ API

  async function api(ctx) {
    const { req, res, path: p } = ctx;
    const method = req.method;

    if (p === '/api/me' && method === 'GET') {
      const id = session(ctx);
      return sendJson(res, 200, { account: billing.view(id, ctx.ipHash), serverTime: clock() });
    }

    if (p === '/api/usage/consume' && method === 'POST') {
      sameOrigin(ctx);
      limit(ctx, 'consume', 120, MINUTE);
      const body = await jsonBody(ctx);
      const id = session(ctx);
      const r = billing.consume(id, { pages: body.pages, opId: body.opId, action: body.action, ipHash: ctx.ipHash, userAgent: req.headers['user-agent'] });
      if (!r.ok) return sendJson(res, 402, { error: 'insufficient', needed: r.needed, missing: r.missing, account: r.account });
      return sendJson(res, 200, { ok: true, charged: r.charged, account: r.account });
    }

    if (p === '/api/orders' && method === 'GET') {
      const id = session(ctx);
      return sendJson(res, 200, { orders: billing.listOrders(id).map((o) => billing.orderView(o)) });
    }

    if (p === '/api/orders' && method === 'POST') {
      sameOrigin(ctx);
      limit(ctx, 'orders', 40, HOUR);
      const body = await jsonBody(ctx);
      const id = session(ctx);
      const provider = String(body.provider || '');
      const order = billing.createOrder(id, { packId: String(body.packId || ''), provider, ipHash: ctx.ipHash, userAgent: req.headers['user-agent'] });
      let pay;
      if (provider === 'bank') pay = bankInstructions(order);
      else if (provider === 'test') pay = { type: 'test' };
      else if (provider === 'paypal') {
        const pack = billing.pack(order.pack_id);
        let created;
        try {
          created = await paypal.createOrder({
            orderId: order.id,
            code: order.code,
            cents: order.amount,
            currency: order.currency,
            description: `${config.siteName} - ${pack ? pack.pages : order.pages} pages`,
            returnUrl: `${ctx.origin()}/api/pay/paypal/return`,
            cancelUrl: `${ctx.origin()}/api/pay/paypal/cancel`,
            brandName: config.siteName,
          });
        } catch (e) {
          log.error('paypal create failed', e.status || '', e.message, e.body ? JSON.stringify(e.body).slice(0, 500) : '');
          billing.cancelOrder(order.id, id);
          throw new HttpError(502, 'provider_error', 'PayPal is not available right now');
        }
        billing.setOrderRef(order.id, created.id);
        pay = { type: 'redirect', url: created.approveUrl };
      }
      return sendJson(res, 200, { order: billing.orderView(billing.getOrder(order.id)), pay, account: billing.view(id, ctx.ipHash) });
    }

    let m = /^\/api\/orders\/([a-f0-9]{32})(\/cancel)?$/.exec(p);
    if (m) {
      const id = session(ctx);
      const order = billing.getOrder(m[1]);
      if (!order || order.account_id !== id) throw new HttpError(404, 'not_found', 'Order not found');
      if (m[2]) {
        if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
        sameOrigin(ctx);
        billing.cancelOrder(order.id, id);
        return sendJson(res, 200, { order: billing.orderView(billing.getOrder(order.id)) });
      }
      if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
      limit(ctx, 'order-poll', 240, MINUTE);
      const view = billing.orderView(order);
      const body = { order: view, account: billing.view(id, ctx.ipHash) };
      if (view.status === 'pending' && order.provider === 'bank') body.pay = bankInstructions(order);
      return sendJson(res, 200, body);
    }

    if (p === '/api/account/restore' && method === 'POST') {
      sameOrigin(ctx);
      limit(ctx, 'restore', 12, HOUR);
      const body = await jsonBody(ctx);
      const acc = billing.restore(body.code);
      if (!acc) throw new HttpError(404, 'not_found', 'No account matches this code');
      setSessionCookie(ctx, acc.id);
      billing.touch(acc.id, ctx.ipHash);
      return sendJson(res, 200, { account: billing.view(acc.id, ctx.ipHash) });
    }

    // ---- bank transfers reported by SePay
    if (p === '/api/pay/sepay/webhook' && method === 'POST') {
      const b = config.payments.bank;
      if (!b.enabled || !(b.sepayApiKey || b.sepayWebhookSecret)) throw new HttpError(404, 'not_found', 'Not found');
      const raw = await readBody(req, 256 * 1024);
      if (!sepayAuthorized(ctx, raw)) {
        limit(ctx, 'sepay-fail', 60, HOUR);
        return sendJson(res, 401, { success: false, error: 'unauthorized' });
      }
      let body;
      try {
        body = parseJson(raw);
      } catch {
        return sendJson(res, 400, { success: false, error: 'bad_json' });
      }
      const amount = Math.round(Number(body.transferAmount) || 0);
      const content = [body.content, body.description, body.code].filter((x) => typeof x === 'string' && x).join(' ');
      const paymentId = body.id !== undefined && body.id !== null && body.id !== '' ? `sepay-${body.id}` : `sepay-ref-${crypto.createHash('sha1').update(`${body.referenceCode}|${body.transactionDate}|${amount}|${content}`).digest('hex').slice(0, 24)}`;
      const incoming = String(body.transferType || 'in').toLowerCase() === 'in' && amount > 0;
      // With a virtual account (VA) the QR carries the VA number, which SePay
      // reports as subAccount next to the main account number.
      const reported = [body.accountNumber, body.subAccount].map((x) => String(x || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()).filter(Boolean);
      const ours = !reported.length || reported.includes(b.account.toUpperCase());
      let result = { status: 'ignored' };
      if (incoming && ours) result = billing.settleBankTransfer({ paymentId, amount, content, raw: raw.toString('utf8') });
      else if (incoming) result = billing.recordUnmatched({ provider: 'bank', paymentId, amount, currency: 'VND', content, raw: raw.toString('utf8') });
      if (config.logRequests || result.status !== 'ignored') log.info(`sepay ${paymentId} ${amount} VND -> ${result.status}${result.order ? ` (${result.order.code})` : ''}`);
      return sendJson(res, 200, { success: true, status: result.status });
    }

    // ---- PayPal sends the buyer back here
    if (p === '/api/pay/paypal/return' && method === 'GET') {
      if (!paypal) throw new HttpError(404, 'not_found', 'Not found');
      limit(ctx, 'paypal-return', 60, HOUR);
      const token = String(ctx.url.searchParams.get('token') || '');
      const order = /^[A-Za-z0-9-]{6,64}$/.test(token) ? billing.getOrderByRef('paypal', token) : null;
      if (!order) return redirect(res, '/pay/done/?status=failed');
      if (order.status !== 'paid') {
        let cap;
        try {
          cap = await paypal.capture(token);
        } catch (e) {
          log.error('paypal capture failed', e.message);
          return redirect(res, `/pay/done/?status=failed&order=${order.id}`);
        }
        if (!cap.completed) {
          log.warn(`paypal capture not completed for ${order.code}: ${cap.issue}`);
          return redirect(res, `/pay/done/?status=failed&order=${order.id}`);
        }
        // The capture must belong to this order (custom_id is our order id).
        if (cap.customId && cap.customId !== order.id) {
          log.error(`paypal capture ${cap.captureId} belongs to ${cap.customId}, not ${order.id}`);
          return redirect(res, `/pay/done/?status=failed&order=${order.id}`);
        }
        const r = billing.recordPayment({ provider: 'paypal', paymentId: cap.captureId, orderId: order.id, amount: cap.cents, currency: cap.currency, content: token, raw: JSON.stringify(cap.raw) });
        log.info(`paypal ${cap.captureId} ${cap.cents} ${cap.currency} -> ${r.status} (${order.code})`);
        if (r.status !== 'paid' && r.status !== 'duplicate' && r.status !== 'already_paid') return redirect(res, `/pay/done/?status=failed&order=${order.id}`);
      }
      return redirect(res, `/pay/done/?status=paid&order=${order.id}`);
    }
    if (p === '/api/pay/paypal/cancel' && method === 'GET') {
      const token = String(ctx.url.searchParams.get('token') || '');
      const order = /^[A-Za-z0-9-]{6,64}$/.test(token) ? billing.getOrderByRef('paypal', token) : null;
      if (order) billing.cancelOrder(order.id, order.account_id);
      return redirect(res, '/pay/done/?status=cancelled');
    }

    // ---- test mode: complete an order without paying
    if (p === '/api/pay/test/complete' && method === 'POST') {
      if (!config.payments.test.enabled) throw new HttpError(404, 'not_found', 'Not found');
      sameOrigin(ctx);
      const body = await jsonBody(ctx);
      const id = session(ctx);
      const order = billing.getOrder(String(body.orderId || ''));
      if (!order || order.account_id !== id || order.provider !== 'test') throw new HttpError(404, 'not_found', 'Order not found');
      const r = billing.recordPayment({ provider: 'test', paymentId: order.id, orderId: order.id, amount: order.amount, currency: order.currency });
      return sendJson(res, 200, { status: r.status, order: billing.orderView(billing.getOrder(order.id)), account: billing.view(id, ctx.ipHash) });
    }

    // ---- admin
    if (p.startsWith('/api/admin/')) {
      admin(ctx);
      if (p === '/api/admin/stats' && method === 'GET') return sendJson(res, 200, { stats: billing.stats(), config: { free: config.free, packs: config.packs, providers: config.providers, siteUrl: config.siteUrl, sepay: !!(config.payments.bank.sepayApiKey || config.payments.bank.sepayWebhookSecret), adsense: !!config.ads.adsenseClient } });
      if (p === '/api/admin/orders' && method === 'GET') {
        const status = ctx.url.searchParams.get('status');
        return sendJson(res, 200, { orders: billing.adminOrders({ status: /^(pending|paid|expired|cancelled)$/.test(status || '') ? status : null, limit: 200 }) });
      }
      if (p === '/api/admin/payments' && method === 'GET') return sendJson(res, 200, { payments: billing.adminPayments({ attention: ctx.url.searchParams.get('attention') === '1', limit: 200 }) });
      if (p === '/api/admin/account' && method === 'GET') {
        const acc = billing.adminAccount(ctx.url.searchParams.get('ref'));
        if (!acc) throw new HttpError(404, 'not_found', 'Account not found');
        return sendJson(res, 200, { account: acc });
      }
      if (p === '/api/admin/orders/confirm' && method === 'POST') {
        const body = await jsonBody(ctx);
        const r = billing.confirmOrder(String(body.order || ''), body.note);
        log.info(`admin confirmed order ${r.order ? r.order.code : body.order} -> ${r.status}`);
        return sendJson(res, 200, { status: r.status, order: billing.orderView(r.order) });
      }
      if (p === '/api/admin/grant' && method === 'POST') {
        const body = await jsonBody(ctx);
        const acc = billing.grant(String(body.account || ''), Number(body.pages), body.note);
        log.info(`admin granted ${body.pages} pages to ${acc.public_id}`);
        return sendJson(res, 200, { account: billing.adminAccount(acc.id) });
      }
    }

    throw new HttpError(404, 'not_found', 'Not found');
  }

  // ------------------------------------------------------------------ generated files

  function adsTxt() {
    const lines = [];
    const m = /^ca-(pub-\d+)$/.exec(config.ads.adsenseClient);
    if (m) lines.push(`google.com, ${m[1]}, DIRECT, f08c47fec0942fa0`);
    for (const l of config.ads.adsTxt.split(/\r?\n|\\n|;/)) if (l.trim()) lines.push(l.trim());
    return lines.join('\n') + (lines.length ? '\n' : '');
  }

  // The installable app (PWA) carries the configured site name.
  function webManifest() {
    return {
      name: config.siteName,
      short_name: config.siteName.slice(0, 12),
      description: 'PDF editor',
      start_url: '/app/',
      scope: '/',
      display: 'standalone',
      background_color: '#f3f4f8',
      theme_color: '#151d33',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
      ],
      file_handlers: [{ action: '/app/', accept: { 'application/pdf': ['.pdf'] } }],
    };
  }

  function robotsTxt(ctx) {
    return `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin/\nDisallow: /pay/\n\nSitemap: ${ctx.origin()}/sitemap.xml\n`;
  }

  function sitemapXml(ctx) {
    const origin = ctx.origin();
    const urls = statics.pages
      .filter((pg) => pg.index !== false)
      .map((pg) => {
        const alt = (pg.alternates || []).map((a) => `\n    <xhtml:link rel="alternate" hreflang="${escapeHtml(a.lang)}" href="${escapeHtml(origin + a.path)}"/>`).join('');
        return `  <url>\n    <loc>${escapeHtml(origin + pg.path)}</loc>${alt}\n    <changefreq>${escapeHtml(pg.changefreq || 'weekly')}</changefreq>\n    <priority>${escapeHtml(pg.priority || '0.7')}</priority>\n  </url>`;
      });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`;
  }

  // ------------------------------------------------------------------ entry point

  async function handle(req, res) {
    const started = clock();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    let ctx;
    try {
      ctx = context(req, res);
    } catch {
      return sendText(res, 400, 'Bad request');
    }
    try {
      const p = ctx.path;
      if (p.startsWith('/api/')) {
        await api(ctx);
      } else if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
      } else if (p === '/healthz') {
        sendJson(res, 200, { ok: true });
      } else if (p === '/manifest.webmanifest') {
        sendText(res, 200, JSON.stringify(webManifest()), 'application/manifest+json; charset=utf-8', { 'Cache-Control': 'public, max-age=3600' });
      } else if (p === '/ads.txt') {
        const body = adsTxt();
        if (!body) throw new HttpError(404, 'not_found', 'Not found');
        sendText(res, 200, body, 'text/plain; charset=utf-8', { 'Cache-Control': 'public, max-age=3600' });
      } else if (p === '/robots.txt') {
        sendText(res, 200, robotsTxt(ctx), 'text/plain; charset=utf-8', { 'Cache-Control': 'public, max-age=3600' });
      } else if (p === '/sitemap.xml') {
        sendText(res, 200, sitemapXml(ctx), 'application/xml; charset=utf-8', { 'Cache-Control': 'public, max-age=3600' });
      } else {
        res.setHeader('Content-Security-Policy', csp);
        if (!statics.serve(req, res, p)) {
          if (!statics.serve(req, res, '/404.html', { status: 404 })) sendText(res, 404, 'Not found');
        }
      }
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
      } else if (e instanceof HttpError || e instanceof BillingError) {
        const headers = e.extra && e.extra.retryAfter ? { 'Retry-After': String(e.extra.retryAfter) } : {};
        // The rest of a refused body is not read: close the connection.
        if (e.extra && e.extra.close) headers.Connection = 'close';
        if (ctx.path.startsWith('/api/')) sendJson(res, e.status, { error: e.code, message: e.message }, headers);
        else sendText(res, e.status, e.message, 'text/plain; charset=utf-8', headers);
      } else {
        log.error('request failed', req.method, req.url, e);
        if (ctx.path.startsWith('/api/')) sendJson(res, 500, { error: 'server_error', message: 'Internal error' });
        else sendText(res, 500, 'Internal error');
      }
    }
    if (config.logRequests) log.info(`${req.method} ${req.url} ${res.statusCode} ${clock() - started}ms`);
  }

  const timer = setInterval(() => {
    try {
      billing.cleanup();
    } catch (e) {
      log.error('cleanup failed', e);
    }
  }, 6 * HOUR);
  timer.unref();

  return {
    handle,
    billing,
    db,
    config,
    statics,
    limiter,
    close() {
      clearInterval(timer);
      db.close();
    },
  };
}
