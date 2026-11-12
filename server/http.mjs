// Small HTTP helpers: JSON bodies, cookies, client address, rate limiting.
import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** Reads the request body (raw Buffer), refusing anything above `limit`. */
export function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const length = Number(req.headers['content-length'] || 0);
    if (length > limit) {
      reject(new HttpError(413, 'too_large', 'Request body too large'));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'too_large', 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function parseJson(buffer) {
  if (!buffer || !buffer.length) return {};
  try {
    const v = JSON.parse(buffer.toString('utf8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw new HttpError(400, 'bad_json', 'Request body must be a JSON object');
  }
}

export function sendJson(res, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8', headers = {}) {
  const data = Buffer.from(String(text), 'utf8');
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': data.length, ...headers });
  res.end(data);
}

export function redirect(res, location, status = 302) {
  res.writeHead(status, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* malformed cookie */
    }
  }
  return out;
}

export function signValue(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url').slice(0, 27);
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Address of the client; proxy headers are only believed when configured. */
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf).trim();
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
    const real = req.headers['x-real-ip'];
    if (real) return String(real).trim();
  }
  return (req.socket && req.socket.remoteAddress) || '';
}

export function isSecure(req, trustProxy) {
  if (req.socket && req.socket.encrypted) return true;
  return !!(trustProxy && /^https/i.test(String(req.headers['x-forwarded-proto'] || '')));
}

/** Fixed-window counters kept in memory: limiter.hit(key, max, windowMs). */
export function createLimiter(clock = () => Date.now()) {
  const buckets = new Map();
  let lastSweep = clock();
  return {
    hit(key, max, windowMs) {
      const now = clock();
      if (now - lastSweep > 60000) {
        for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
        lastSweep = now;
      }
      let b = buckets.get(key);
      if (!b || b.reset <= now) {
        b = { count: 0, reset: now + windowMs };
        buckets.set(key, b);
      }
      b.count++;
      return { ok: b.count <= max, retryAfter: Math.max(1, Math.ceil((b.reset - now) / 1000)) };
    },
    clear() {
      buckets.clear();
    },
  };
}
