// /pay/checkout/ starts a PayPal payment (opened in a new tab by the
// editor); /pay/done/ is where the buyer lands afterwards.
import { readConfig } from '../web/config.js';

const config = readConfig();
const params = new URLSearchParams(location.search);
let all = {};
try {
  all = JSON.parse(document.getElementById('pay-strings').textContent);
} catch {
  all = {};
}
function savedLanguage() {
  try {
    return (JSON.parse(localStorage.getItem('pdfedit.settings') || '{}') || {}).language || '';
  } catch {
    return '';
  }
}
const lang = params.get('lang') === 'en' || (!params.get('lang') && savedLanguage() === 'en') ? 'en' : 'vi';
document.documentElement.lang = lang;
const s = all[lang] || all.vi || {};
const state = document.querySelector('.pay-state');

const ICONS = {
  check: '<path d="M4.5 12.5l5 5L19.5 7"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  minus: '<path d="M6 12h12"/>',
};
const svg = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function editorUrl() {
  return `${config.base}app/?lang=${lang}`;
}

function backButtons() {
  const row = el('div', 'btn-row center');
  row.style.marginTop = '14px';
  const back = el('a', 'btn btn-primary', s.back);
  back.href = editorUrl();
  // Opened from the editor: go back to that tab instead of opening another.
  if (window.opener && !window.opener.closed) {
    back.addEventListener('click', (e) => {
      e.preventDefault();
      try {
        window.opener.focus();
      } catch {
        /* cross-origin opener */
      }
      window.close();
      setTimeout(() => (location.href = back.href), 300);
    });
  }
  row.appendChild(back);
  return row;
}

function show({ icon = null, kind = '', title, text, code = null, buttons = true }) {
  state.replaceChildren();
  if (icon) {
    const i = el('div', `pay-icon ${kind}`);
    i.innerHTML = svg(icon);
    state.appendChild(i);
  } else state.appendChild(el('span', 'spinner'));
  state.appendChild(el('h1', '', title));
  if (text) state.appendChild(el('p', '', text));
  if (code) state.appendChild(el('div', 'pay-code', `${s.order}: ${code}`));
  if (buttons) state.appendChild(backButtons());
}

async function api(path, options = {}) {
  const res = await fetch(`${config.base}api/${path}`, { credentials: 'same-origin', cache: 'no-store', headers: options.body ? { 'Content-Type': 'application/json' } : undefined, ...options });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw Object.assign(new Error((data && data.message) || `HTTP ${res.status}`), { status: res.status });
  return data;
}

async function checkout() {
  show({ title: s.checkoutTitle, text: s.checkoutText, buttons: false });
  const provider = params.get('provider') || 'paypal';
  const packId = params.get('pack') || '';
  try {
    const data = await api('orders', { method: 'POST', body: JSON.stringify({ packId, provider }) });
    if (data.pay && data.pay.type === 'redirect' && /^https:\/\//.test(data.pay.url)) {
      location.replace(data.pay.url);
      return;
    }
    throw new Error('Unexpected answer');
  } catch (e) {
    show({ icon: 'x', kind: 'failed', title: s.checkoutError, text: e.message });
  }
}

async function done() {
  const status = params.get('status');
  const orderId = params.get('order');
  let code = null;
  if (orderId && /^[a-f0-9]{32}$/.test(orderId)) {
    try {
      const data = await api(`orders/${orderId}`);
      code = data.order && data.order.code;
      if (data.account) localStorage.setItem('pdfedit.account', JSON.stringify(data.account));
    } catch {
      /* the order belongs to another browser */
    }
  }
  if (status === 'paid') {
    try {
      const me = await api('me');
      localStorage.setItem('pdfedit.account', JSON.stringify(me.account));
    } catch {
      /* offline */
    }
    // The editor tab refreshes its balance right away.
    try {
      new BroadcastChannel('pdfedit-billing').postMessage({ type: 'changed' });
    } catch {
      /* not supported */
    }
    show({ icon: 'check', title: s.paidTitle, text: s.paidText, code });
  } else if (status === 'cancelled') {
    show({ icon: 'minus', kind: 'cancelled', title: s.cancelledTitle, text: s.cancelledText, code });
  } else {
    show({ icon: 'x', kind: 'failed', title: s.failedTitle, text: s.failedText, code });
  }
}

if (document.body.dataset.pay === 'checkout') checkout();
else done();
