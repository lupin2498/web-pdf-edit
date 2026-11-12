// PayPal Orders v2 (redirect flow): create an order, send the buyer to
// PayPal to approve it, capture the money when PayPal sends them back.
import crypto from 'node:crypto';

export class PayPalError extends Error {
  constructor(message, { status = 0, body = null } = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class PayPal {
  constructor({ clientId, secret, apiBase }, fetchImpl = fetch) {
    this.clientId = clientId;
    this.secret = secret;
    this.apiBase = apiBase;
    this.fetch = fetchImpl;
    this.cached = null;
  }

  async token() {
    if (this.cached && this.cached.expires > Date.now() + 60000) return this.cached.value;
    const res = await this.fetch(`${this.apiBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || !body.access_token) throw new PayPalError('PayPal authentication failed', { status: res.status, body });
    this.cached = { value: body.access_token, expires: Date.now() + (Number(body.expires_in) || 300) * 1000 };
    return this.cached.value;
  }

  async call(method, pathname, { body = null, requestId = null, prefer = null } = {}) {
    const headers = { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json', Accept: 'application/json' };
    if (requestId) headers['PayPal-Request-Id'] = requestId;
    if (prefer) headers.Prefer = prefer;
    const res = await this.fetch(`${this.apiBase}${pathname}`, { method, headers, body: body ? JSON.stringify(body) : method === 'POST' ? '{}' : undefined, signal: AbortSignal.timeout(30000) });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  }

  /**
   * @returns {{ id: string, approveUrl: string }}
   */
  async createOrder({ orderId, code, cents, currency = 'USD', description, returnUrl, cancelUrl, brandName }) {
    const r = await this.call('POST', '/v2/checkout/orders', {
      requestId: `create-${orderId}-${crypto.randomBytes(4).toString('hex')}`,
      body: {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: code,
            custom_id: orderId,
            description: String(description || '').slice(0, 127),
            amount: { currency_code: currency, value: (cents / 100).toFixed(2) },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: String(brandName || '').slice(0, 127) || undefined,
              shipping_preference: 'NO_SHIPPING',
              user_action: 'PAY_NOW',
              return_url: returnUrl,
              cancel_url: cancelUrl,
            },
          },
        },
      },
    });
    const links = (r.data && r.data.links) || [];
    const approve = links.find((l) => l.rel === 'payer-action') || links.find((l) => l.rel === 'approve');
    if (!r.ok || !r.data || !r.data.id || !approve) throw new PayPalError('PayPal did not create the order', { status: r.status, body: r.data });
    return { id: r.data.id, approveUrl: approve.href };
  }

  /**
   * Captures an approved order. Resolves to { completed, captureId, cents,
   * currency, customId } and never throws for "not approved yet".
   */
  async capture(paypalOrderId) {
    const id = encodeURIComponent(paypalOrderId);
    let r = await this.call('POST', `/v2/checkout/orders/${id}/capture`, { requestId: `capture-${paypalOrderId}`, prefer: 'return=representation' });
    const issue = r.data && r.data.details && r.data.details[0] && r.data.details[0].issue;
    // Captured by an earlier call (for example the buyer reloaded the page).
    if (!r.ok && issue === 'ORDER_ALREADY_CAPTURED') r = await this.call('GET', `/v2/checkout/orders/${id}`);
    if (!r.ok || !r.data) return { completed: false, issue: issue || `http_${r.status}`, raw: r.data };
    const unit = (r.data.purchase_units || [])[0] || {};
    const cap = ((unit.payments && unit.payments.captures) || []).find((c) => c.status === 'COMPLETED');
    if (r.data.status !== 'COMPLETED' || !cap) return { completed: false, issue: r.data.status || 'NOT_COMPLETED', raw: r.data };
    return {
      completed: true,
      captureId: cap.id,
      cents: Math.round(parseFloat(cap.amount && cap.amount.value) * 100),
      currency: (cap.amount && cap.amount.currency_code) || '',
      customId: cap.custom_id || unit.custom_id || null,
      raw: r.data,
    };
  }
}
