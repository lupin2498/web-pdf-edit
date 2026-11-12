// Starts the web server: `node server/index.mjs` (after `npm run build`).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadEnvFile } from './config.mjs';
import { createApp } from './app.mjs';

loadEnvFile();

let config;
try {
  config = loadConfig();
} catch (e) {
  console.error(`Configuration error: ${e.message}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(config.distDir, 'build.json'))) {
  console.error(`No build found in ${config.distDir}. Run "npm run build" first.`);
  process.exit(1);
}
if (config.adminToken && config.adminToken.length < 12) {
  console.error('ADMIN_TOKEN must be at least 12 characters long.');
  process.exit(1);
}

const app = await createApp(config);
const server = http.createServer((req, res) => {
  app.handle(req, res).catch((e) => {
    console.error('unhandled', e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
server.requestTimeout = 60000;

server.listen(config.port, config.host, () => {
  const { port } = server.address();
  const bank = config.payments.bank;
  console.log(`${config.siteName} is running on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${port}`);
  console.log(`  free pages: ${config.free.pages}${config.free.resetDays ? ` every ${config.free.resetDays} day(s)` : ''} · packs: ${config.packs.map((p) => `${p.pages}p`).join(', ')}`);
  console.log(`  payments: ${config.providers.length ? config.providers.join(', ') : 'none configured (set BANK_* and/or PAYPAL_* in .env)'}`);
  if (bank.enabled && !(bank.sepayApiKey || bank.sepayWebhookSecret)) console.log('  bank transfers are confirmed by hand in /admin (set SEPAY_API_KEY for automatic confirmation)');
  console.log(`  ads: ${config.ads.adsenseClient ? `AdSense ${config.ads.adsenseClient}` : Object.keys(config.ads.customSlots).length ? 'custom network' : config.ads.house ? 'house ads only' : 'off'}`);
  if (!config.adminToken) console.log('  admin page is off (set ADMIN_TOKEN to enable /admin)');
  if (!config.siteUrl) console.log('  SITE_URL is not set: canonical links, sitemap and PayPal return URLs use the request host');
  if (config.payments.test.enabled) console.warn('  WARNING: PAYMENTS_TEST_MODE is on - orders can be completed without paying. Never use this in production.');
});

function shutdown() {
  server.closeIdleConnections();
  server.close(() => {
    app.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
