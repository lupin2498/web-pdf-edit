// Public configuration handed to the page by the server (or baked in by the
// static export) inside <script type="application/json" id="pe-config">.

const DEFAULTS = {
  siteName: 'PDF Edit',
  siteUrl: '',
  contactEmail: '',
  free: { pages: 5, resetDays: 0 },
  packs: [
    { id: 'p20', pages: 20, vnd: 10000, usd: 1.49 },
    { id: 'p100', pages: 100, vnd: 39000, usd: 3.99, popular: true },
    { id: 'p500', pages: 500, vnd: 149000, usd: 11.99 },
  ],
  providers: [],
  bank: null,
  paypal: null,
  testMode: false,
  ads: { adsenseClient: '', slots: {}, customSlots: {}, house: true, hideForPaid: true },
  analytics: { gaId: '' },
};

let cached = null;

export function readConfig() {
  if (cached) return cached;
  let raw = null;
  try {
    const el = document.getElementById('pe-config');
    if (el) raw = JSON.parse(el.textContent);
  } catch {
    raw = null;
  }
  const c = raw && typeof raw === 'object' ? raw : {};
  cached = {
    ...DEFAULTS,
    ...c,
    free: { ...DEFAULTS.free, ...(c.free || {}) },
    ads: { ...DEFAULTS.ads, ...(c.ads || {}) },
    analytics: { ...DEFAULTS.analytics, ...(c.analytics || {}) },
    packs: Array.isArray(c.packs) && c.packs.length ? c.packs : DEFAULTS.packs,
    providers: Array.isArray(c.providers) ? c.providers : DEFAULTS.providers,
    // URL prefix of the site (set by the build).
    base: typeof __BASE__ === 'string' ? __BASE__ : '/',
  };
  return cached;
}

export function formatMoney(amount, currency, lang = 'vi') {
  if (currency === 'VND') return `${new Intl.NumberFormat(lang === 'vi' ? 'vi-VN' : 'en-US').format(amount)} ₫`;
  if (currency === 'USD') return `$${(amount / 100).toFixed(2)}`;
  return `${amount} ${currency}`;
}

/** Price of a pack for a payment method: { amount, currency } or null. */
export function packPrice(pack, provider) {
  if (provider === 'paypal') return pack.usd > 0 ? { amount: Math.round(pack.usd * 100), currency: 'USD' } : null;
  if (provider === 'bank') return pack.vnd > 0 ? { amount: pack.vnd, currency: 'VND' } : null;
  if (pack.vnd > 0) return { amount: pack.vnd, currency: 'VND' };
  return pack.usd > 0 ? { amount: Math.round(pack.usd * 100), currency: 'USD' } : null;
}
