// Serving the built site and the generated files (robots, sitemap, ads.txt).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp, fakeDist, BANK_ENV, ADMIN_TOKEN } from './helpers.mjs';

const SECRETS = {
  ...BANK_ENV,
  SEPAY_WEBHOOK_SECRET: 'whsec-very-secret',
  PAYPAL_CLIENT_ID: 'paypal-client-id',
  PAYPAL_CLIENT_SECRET: 'paypal-client-secret-xyz',
  ADMIN_TOKEN,
  SESSION_SECRET: 'session-secret-abcdef',
};

function configOf(html) {
  const m = /<script type="application\/json" id="pe-config">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'config block present');
  return JSON.parse(m[1]);
}

describe('pages', () => {
  let srv;
  before(async () => {
    srv = await startApp({ ...SECRETS, SITE_URL: 'https://pdf.example.com', SITE_NAME: 'PDF </script><script>alert(1)</script> & Co' });
  });
  after(() => srv.close());

  test('the public configuration is filled in without secrets', async () => {
    const r = await srv.raw({ path: '/' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(r.headers['cache-control'], 'no-cache');
    const html = r.body.toString('utf8');
    const config = configOf(html);
    assert.equal(config.siteName, 'PDF </script><script>alert(1)</script> & Co');
    assert.equal(config.free.pages, 5);
    assert.deepEqual(config.providers, ['bank', 'paypal']);
    assert.equal(config.bank.account, '0123456789');
    for (const secret of Object.values(SECRETS).filter((v) => v.length > 8 && v !== '0123456789' && v !== 'Nguyen Van A')) {
      assert.equal(html.includes(secret), false, `secret ${secret} leaked`);
    }
    // The site name cannot close the script element or inject markup.
    assert.equal((html.match(/<script/g) || []).length, 1);
    assert.match(html, /<title>PDF &lt;\/script&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; Co<\/title>/);
    assert.match(html, /<link rel="canonical" href="https:\/\/pdf\.example\.com\/">/);
    // Unknown placeholders are left alone.
    assert.match(html, /%%UNKNOWN_VAR%%/);
    // No ad script without AdSense.
    assert.doesNotMatch(html, /adsbygoogle/);
  });

  test('HTML is compressed for clients that accept it and revalidated with ETags', async () => {
    const br = await srv.raw({ path: '/', headers: { 'accept-encoding': 'gzip, deflate, br' } });
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(br.headers.vary, 'Accept-Encoding');
    const gz = await srv.raw({ path: '/', headers: { 'accept-encoding': 'gzip' } });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    const noBr = await srv.raw({ path: '/', headers: { 'accept-encoding': 'br;q=0, gzip' } });
    assert.equal(noBr.headers['content-encoding'], 'gzip');
    const plain = await srv.raw({ path: '/' });
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(Number(plain.headers['content-length']), plain.body.length);
    assert.notEqual(br.headers.etag, plain.headers.etag);
    for (const inm of [plain.headers.etag, `W/${plain.headers.etag}`, `"other", ${plain.headers.etag}`, '*']) {
      const r = await srv.raw({ path: '/', headers: { 'if-none-match': inm } });
      assert.equal(r.status, 304, inm);
      assert.equal(r.body.length, 0);
    }
    assert.equal((await srv.raw({ path: '/', headers: { 'if-none-match': '"other"' } })).status, 200);
  });

  test('HEAD answers without a body', async () => {
    const r = await srv.raw({ method: 'HEAD', path: '/' });
    assert.equal(r.status, 200);
    assert.ok(Number(r.headers['content-length']) > 0);
    assert.equal(r.body.length, 0);
  });

  test('a folder without the trailing slash redirects, keeping the query', async () => {
    let r = await srv.raw({ path: '/app' });
    assert.equal(r.status, 301);
    assert.equal(r.headers.location, '/app/');
    r = await srv.raw({ path: '/app?tool=merge&lang=en' });
    assert.equal(r.headers.location, '/app/?tool=merge&lang=en');
    r = await srv.raw({ path: '/app/' });
    assert.equal(r.status, 200);
    assert.match(r.body.toString(), /app/);
    // A non-ASCII folder name stays percent-encoded in the Location header.
    r = await srv.raw({ path: '/t%C3%A0i-li%E1%BB%87u' });
    assert.equal(r.status, 301);
    assert.equal(r.headers.location, '/t%C3%A0i-li%E1%BB%87u/');
    r = await srv.raw({ path: '/t%C3%A0i-li%E1%BB%87u/' });
    assert.equal(r.status, 200);
  });

  test('missing pages get the 404 page with status 404', async () => {
    for (const p of ['/nope', '/nope/', '/app/missing.js', '/%E1%BB%87', '/%', '/build.json', '/assets/app-ABCD2345.js.br', '/assets/app-ABCD2345.js.gz']) {
      const r = await srv.raw({ path: p });
      assert.equal(r.status, 404, p);
      assert.match(r.body.toString(), /missing page/, p);
    }
  });

  test('paths outside the site are never served', async () => {
    for (const p of ['/../server/app.mjs', '/%2e%2e/server/app.mjs', '/assets/%2e%2e/%2e%2e/package.json', '/assets%2f..%2f..%2fpackage.json', '/assets/..%5c..%5cpackage.json', '/..%2f..%2fetc/passwd', '//etc/passwd']) {
      const r = await srv.raw({ path: p });
      assert.ok(r.status === 404 || r.status === 400, `${p} -> ${r.status}`);
      assert.doesNotMatch(r.body.toString(), /"name": "web-pdf-edit"|createApp|root:/, p);
    }
  });

  test('only GET and HEAD for pages', async () => {
    assert.equal((await srv.raw({ method: 'POST', path: '/' })).status, 405);
    assert.equal((await srv.raw({ method: 'PUT', path: '/app/' })).status, 405);
  });

  test('strict content security policy without third-party ads', async () => {
    const r = await srv.raw({ path: '/' });
    const csp = r.headers['content-security-policy'];
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
    assert.match(csp, /frame-ancestors 'self'/);
  });

  test('health check', async () => {
    const r = await srv.client().get('/healthz');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
  });
});

describe('assets', () => {
  let srv;
  before(async () => {
    srv = await startApp({});
  });
  after(() => srv.close());

  test('hashed bundles are cached for a year and sent pre-compressed', async () => {
    const br = await srv.raw({ path: '/assets/app-ABCD2345.js', headers: { 'accept-encoding': 'gzip, br' } });
    assert.equal(br.status, 200);
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(br.body.toString(), 'br-bytes');
    assert.equal(br.headers['content-length'], String('br-bytes'.length));
    assert.equal(br.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(br.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(br.headers.vary, 'Accept-Encoding');
    const gz = await srv.raw({ path: '/assets/app-ABCD2345.js', headers: { 'accept-encoding': 'gzip' } });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(gz.body.toString(), 'gzip-bytes');
    const plain = await srv.raw({ path: '/assets/app-ABCD2345.js' });
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.match(plain.body.toString(), /^console\.log/);
    assert.equal(Number(plain.headers['content-length']), plain.body.length);
    // Each encoding has its own validator.
    assert.notEqual(br.headers.etag, plain.headers.etag);
    assert.notEqual(br.headers.etag, gz.headers.etag);
    const cached = await srv.raw({ path: '/assets/app-ABCD2345.js', headers: { 'accept-encoding': 'gzip, br', 'if-none-match': br.headers.etag } });
    assert.equal(cached.status, 304);
    // A validator of another encoding does not match.
    assert.equal((await srv.raw({ path: '/assets/app-ABCD2345.js', headers: { 'if-none-match': br.headers.etag } })).status, 200);
  });

  test('other assets are cached for a month', async () => {
    const r = await srv.raw({ path: '/assets/plain.txt', headers: { 'accept-encoding': 'br' } });
    assert.equal(r.headers['cache-control'], 'public, max-age=2592000');
    assert.equal(r.headers['content-encoding'], undefined);
    assert.equal(r.body.toString(), 'plain');
    assert.ok(r.headers['last-modified']);
  });
});

describe('a site without a 404 page', () => {
  test('answers 404 in plain text', async () => {
    const dist = fakeDist({ with404: false });
    const srv = await startApp({ DIST_DIR: dist });
    try {
      const r = await srv.raw({ path: '/nope' });
      assert.equal(r.status, 404);
      assert.equal(r.body.toString(), 'Not found');
    } finally {
      await srv.close();
      fs.rmSync(dist, { recursive: true, force: true });
    }
  });
});

describe('generated files', () => {
  test('robots.txt and the sitemap use SITE_URL and skip hidden pages', async () => {
    const srv = await startApp({ SITE_URL: 'https://pdf.example.com' });
    try {
      const robots = await srv.raw({ path: '/robots.txt' });
      assert.equal(robots.status, 200);
      assert.match(robots.body.toString(), /Disallow: \/api\//);
      assert.match(robots.body.toString(), /Sitemap: https:\/\/pdf\.example\.com\/sitemap\.xml/);
      const sm = await srv.raw({ path: '/sitemap.xml' });
      assert.equal(sm.headers['content-type'], 'application/xml; charset=utf-8');
      const xml = sm.body.toString();
      assert.match(xml, /<loc>https:\/\/pdf\.example\.com\/<\/loc>/);
      assert.match(xml, /<loc>https:\/\/pdf\.example\.com\/app\/<\/loc>/);
      assert.match(xml, /hreflang="en" href="https:\/\/pdf\.example\.com\/en\/"/);
      assert.doesNotMatch(xml, /admin/);
    } finally {
      await srv.close();
    }
  });

  test('sitemap URLs are escaped', async () => {
    const dist = fakeDist();
    fs.writeFileSync(path.join(dist, 'build.json'), JSON.stringify({ pages: [{ path: '/a&b/?x=<1>' }] }));
    const srv = await startApp({ DIST_DIR: dist, SITE_URL: 'https://pdf.example.com' });
    try {
      const xml = (await srv.raw({ path: '/sitemap.xml' })).body.toString();
      assert.match(xml, /<loc>https:\/\/pdf\.example\.com\/a&amp;b\/\?x=&lt;1&gt;<\/loc>/);
    } finally {
      await srv.close();
      fs.rmSync(dist, { recursive: true, force: true });
    }
  });

  test('without SITE_URL the request host is used', async () => {
    const srv = await startApp({});
    try {
      const robots = await srv.raw({ path: '/robots.txt' });
      assert.match(robots.body.toString(), new RegExp(`Sitemap: http://127\\.0\\.0\\.1:${srv.port}/sitemap\\.xml`));
    } finally {
      await srv.close();
    }
  });

  test('ads.txt only exists with an ad network', async () => {
    let srv = await startApp({});
    try {
      assert.equal((await srv.raw({ path: '/ads.txt' })).status, 404);
    } finally {
      await srv.close();
    }
    srv = await startApp({ ADSENSE_CLIENT: 'ca-pub-1234567890123456', ADS_TXT: 'example.com, 123, RESELLER\\nother.com, 9, DIRECT' });
    try {
      const r = await srv.raw({ path: '/ads.txt' });
      assert.equal(r.status, 200);
      assert.equal(r.body.toString(), 'google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0\nexample.com, 123, RESELLER\nother.com, 9, DIRECT\n');
      // AdSense needs its script on every page and a relaxed policy.
      const page = await srv.raw({ path: '/' });
      assert.match(page.body.toString(), /<script async src="https:\/\/pagead2\.googlesyndication\.com\/pagead\/js\/adsbygoogle\.js\?client=ca-pub-1234567890123456" crossorigin="anonymous"><\/script>/);
      assert.equal(page.headers['content-security-policy'], "frame-ancestors 'self'");
    } finally {
      await srv.close();
    }
  });

  test('a custom ad network or analytics also relaxes the policy', async () => {
    for (const env of [{ ADS_CUSTOM_HEAD: '<script src="https://ads.example/x.js"></script>' }, { ADS_HTML_LANDING_TOP: '<div>ad</div>' }, { GA_MEASUREMENT_ID: 'G-ABC1234' }]) {
      const srv = await startApp(env);
      try {
        const page = await srv.raw({ path: '/' });
        assert.equal(page.headers['content-security-policy'], "frame-ancestors 'self'", JSON.stringify(env));
        if (env.GA_MEASUREMENT_ID) assert.match(page.body.toString(), /googletagmanager\.com\/gtag\/js\?id=G-ABC1234/);
        if (env.ADS_CUSTOM_HEAD) assert.match(page.body.toString(), /ads\.example\/x\.js/);
      } finally {
        await srv.close();
      }
    }
  });
});

describe('a rebuilt site', () => {
  test('is picked up without a restart outside production', async () => {
    const dist = fakeDist();
    const srv = await startApp({ DIST_DIR: dist });
    try {
      assert.equal((await srv.raw({ path: '/new.html' })).status, 404);
      fs.writeFileSync(path.join(dist, 'new.html'), '<!doctype html><p>new</p>');
      const build = path.join(dist, 'build.json');
      const t = new Date(Date.now() + 5000);
      fs.utimesSync(build, t, t);
      const r = await srv.raw({ path: '/new.html' });
      assert.equal(r.status, 200);
      assert.match(r.body.toString(), /new/);
    } finally {
      await srv.close();
      fs.rmSync(dist, { recursive: true, force: true });
    }
  });
});
