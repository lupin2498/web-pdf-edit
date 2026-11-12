// Small HTTP helpers: JSON bodies, cookies, client address, rate limiting.
import crypto from 'node:crypto';
import net from 'node:net';

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/**
 * Reads the request body (raw Buffer), refusing anything above `limit`. A
 * refused body is not read any further; the 413 answer closes the connection
 * (see app.mjs) so that the client gets the response instead of a reset.
 */
export function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => new HttpError(413, 'too_large', 'Request body too large', { close: true });
    const length = Number(req.headers['content-length'] || 0);
    if (length > limit) {
      reject(tooLarge());
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        chunks.length = 0;
        reject(tooLarge());
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
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
  const out = Object.create(null);
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || Object.hasOwn(out, k)) continue;
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

/**
 * Address of the client. Proxy headers are only believed when configured:
 * `trustProxy` is the number of reverse proxies in front of the server (each
 * one appends the address it saw to X-Forwarded-For, so the client is the
 * entry that many places from the end; entries further left were written by
 * the client itself and prove nothing), or 'cloudflare' to use the
 * CF-Connecting-IP header that Cloudflare sets.
 */
export function clientIp(req, trustProxy) {
  const socketIp = (req.socket && req.socket.remoteAddress) || '';
  if (trustProxy === 'cloudflare') {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    return cf || socketIp;
  }
  const hops = Number(trustProxy) || 0;
  if (hops > 0) {
    const list = String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    if (list.length) return list[Math.max(0, list.length - hops)];
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (real) return real;
  }
  return socketIp;
}

function ipv6Groups(s) {
  // An IPv4 address written at the end (::ffff:1.2.3.4, 64:ff9b::1.2.3.4).
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const b = v4.slice(1).map(Number);
    s = `${s.slice(0, v4.index)}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = s.includes('::') ? Array(Math.max(0, 8 - h.length - t.length)).fill('0') : [];
  return [...h, ...fill, ...t].map((x) => parseInt(x, 16) || 0);
}

/**
 * The unit that per-address limits count: an IPv4 address, or the /64
 * network of an IPv6 address (one subscriber gets a whole /64 and can pick
 * any address in it).
 */
export function ipKey(ip) {
  const s = String(ip || '').trim().replace(/%.*$/, '');
  if (!s) return '';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (mapped) return mapped[1];
  if (net.isIPv4(s)) return s;
  if (!net.isIPv6(s)) return s.slice(0, 64);
  return `${ipv6Groups(s)
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
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
