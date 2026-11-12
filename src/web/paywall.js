// Buying pages: pack selection, bank transfer by VietQR, PayPal, and the
// account dialog with the restore code.
import qrcode from 'qrcode-generator';
import { h, clear } from '../renderer/js/ui/dom.js';
import { icon } from '../renderer/js/ui/icons.js';
import { openDialog, toast, promptDialog } from '../renderer/js/ui/dialogs.js';
import { t, getLanguage, formatDate } from '../renderer/js/i18n.js';
import { billing, setPaywall } from './billing.js';
import { formatMoney, packPrice } from './config.js';

const POLL_MS = 2500;
let openPromise = null;

function money(price) {
  return price ? formatMoney(price.amount, price.currency, getLanguage()) : '';
}

function perPage(price, pages) {
  if (!price) return '';
  if (price.currency === 'VND') return formatMoney(Math.round(price.amount / pages), 'VND', getLanguage());
  const cents = price.amount / pages;
  return cents >= 1 ? `$${(cents / 100).toFixed(2)}` : `${cents.toFixed(1)}¢`;
}

export function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {
      /* clipboard unavailable */
    }
    ta.remove();
  }
  if (btn) {
    const label = btn.querySelector('span');
    if (label) {
      const prev = label.textContent;
      label.textContent = t('account.copied');
      btn.classList.add('copied');
      setTimeout(() => {
        label.textContent = prev;
        btn.classList.remove('copied');
      }, 1400);
    }
  } else toast(t('account.copied'), { type: 'success', timeout: 1500 });
}

function copyButton(text) {
  const btn = h('button', { class: 'copy-btn', type: 'button', title: t('account.copy') }, icon('copy'), h('span', null, t('account.copy')));
  btn.addEventListener('click', () => copyText(text, btn));
  return btn;
}

function formatCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export async function restoreDialog() {
  const code = await promptDialog(t('account.enterCodePrompt'), '', {
    title: t('account.enterCodeTitle'),
    placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX',
    okLabel: t('account.restore'),
    validate: (v) => (v.replace(/[^A-Za-z0-9]/g, '').length === 20 ? '' : t('account.restoreInvalid')),
  });
  if (!code) return false;
  try {
    const account = await billing.restore(code);
    toast(t('account.restored', { n: account.available }), { type: 'success', timeout: 5000 });
    billing.announce();
    return true;
  } catch (e) {
    toast(e.status === 429 ? t('account.restoreLimited') : e.status === 0 ? t('pay.offline') : t('account.restoreInvalid'), { type: 'error', timeout: 5000 });
    return false;
  }
}

/**
 * Opens the purchase dialog. `need` describes a blocked export:
 * { pages, missing, name }. Resolves to true once the balance covers
 * `need.pages` (or, without `need`, after any purchase).
 */
export function openPaywall(need = null, { packId = null } = {}) {
  if (openPromise) return openPromise;
  openPromise = runPaywall(need, packId).finally(() => {
    openPromise = null;
  });
  return openPromise;
}

async function runPaywall(need, packId = null) {
  // The balance may have changed elsewhere (another tab, a bank transfer).
  await billing.refreshIfStale();
  if (need && need.pages <= billing.available) return true;
  const config = billing.config;
  const providers = config.providers.filter((p) => config.packs.some((pk) => packPrice(pk, p)));
  let provider = providers[0] || null;
  const needed = need ? need.pages : 0;
  const missingNow = () => Math.max(0, needed - billing.available);
  const defaultPack = () => {
    const usable = config.packs.filter((p) => packPrice(p, provider));
    const cover = usable.find((p) => p.pages >= missingNow());
    return (need && missingNow() > 0 ? cover || usable[usable.length - 1] : usable.find((p) => p.popular) || usable[0]) || null;
  };
  let pack = (packId && config.packs.find((p) => p.id === packId && packPrice(p, provider))) || defaultPack();
  let purchased = false;
  let timers = [];
  let currentOrder = null;
  let closed = false;

  const body = h('div', { class: 'pw' });
  const dlg = openDialog({
    title: need ? t('pay.titleNeed') : t('pay.title'),
    content: body,
    width: 720,
    className: 'paywall',
    onClose: () => {
      closed = true;
      stopTimers();
    },
  });

  const stopTimers = () => {
    for (const id of timers) clearInterval(id);
    timers = [];
  };
  const every = (ms, fn) => {
    const id = setInterval(fn, ms);
    timers.push(id);
    return id;
  };
  const finish = () => dlg.close(need ? billing.available >= needed : purchased);

  const banner = () => {
    if (need && missingNow() > 0) {
      const freeUsed = billing.account.free.remaining === 0 && billing.account.credits === 0;
      return h(
        'div',
        { class: 'pw-need' },
        icon('lock'),
        h('div', null, h('b', null, t('pay.needDoc', { pages: needed, left: billing.available, missing: missingNow() })), freeUsed ? h('div', { class: 'hint' }, t('pay.needFreeUsed', { limit: billing.account.free.limit })) : null),
      );
    }
    return h('div', { class: 'pw-intro' }, t('pay.intro'));
  };

  // ---------------------------------------------------------------- step 1: choose

  const renderSelect = (error = '') => {
    stopTimers();
    currentOrder = null;
    clear(body);
    body.dataset.step = 'select';
    body.appendChild(banner());
    if (!providers.length) {
      body.appendChild(
        h(
          'div',
          { class: 'pw-empty' },
          icon('info'),
          h('div', null, h('div', null, t('pay.unavailable')), config.contactEmail ? h('div', { class: 'hint' }, t('pay.unavailableContact', { email: config.contactEmail })) : null),
        ),
      );
      body.appendChild(h('div', { class: 'pw-actions' }, h('button', { class: 'link-btn', type: 'button', onclick: () => restoreDialog().then((ok) => ok && need && missingNow() === 0 && finish()) }, t('pay.haveCode')), h('div', { class: 'pw-spacer' }), h('button', { class: 'btn', onclick: finish }, t('common.close'))));
      return;
    }
    const usable = config.packs.filter((p) => packPrice(p, provider));
    if (!pack || !usable.includes(pack)) pack = defaultPack();
    const cheapest = usable.reduce((best, p) => (!best || packPrice(p, provider).amount / p.pages < packPrice(best, provider).amount / best.pages ? p : best), null);
    const packs = h('div', { class: 'pw-packs', role: 'radiogroup' });
    for (const p of usable) {
      const price = packPrice(p, provider);
      const badge = p.popular ? t('pay.popular') : p === cheapest && usable.length > 1 ? t('pay.best') : '';
      const card = h(
        'button',
        { class: `pw-pack ${p === pack ? 'active' : ''} ${p.popular ? 'popular' : ''}`, type: 'button', role: 'radio', 'aria-checked': p === pack ? 'true' : 'false', dataset: { pack: p.id } },
        badge ? h('span', { class: 'pw-badge' }, badge) : null,
        h('span', { class: 'pw-pages' }, t('pay.pack', { n: p.pages })),
        h('span', { class: 'pw-price' }, money(price)),
        h('span', { class: 'pw-per' }, t('pay.perPage', { price: perPage(price, p.pages) })),
        need && missingNow() > 0 && p.pages >= missingNow() ? h('span', { class: 'pw-covers' }, icon('check'), t('pay.covers')) : null,
      );
      card.addEventListener('click', () => {
        pack = p;
        renderSelect();
      });
      packs.appendChild(card);
    }
    body.appendChild(packs);
    if (providers.length > 1) {
      const methods = h('div', { class: 'pw-methods' });
      for (const pr of providers) {
        const m = h(
          'button',
          { class: `pw-method ${pr === provider ? 'active' : ''}`, type: 'button', dataset: { provider: pr } },
          icon(pr === 'bank' ? 'qr' : pr === 'paypal' ? 'card' : 'flask'),
          h('span', null, h('b', null, t(`pay.${pr}`)), h('small', null, t(`pay.${pr}Desc`))),
        );
        m.addEventListener('click', () => {
          provider = pr;
          renderSelect();
        });
        methods.appendChild(m);
      }
      body.appendChild(h('div', { class: 'pw-label' }, t('pay.method')));
      body.appendChild(methods);
    }
    body.appendChild(h('ul', { class: 'pw-perks' }, [t('pay.perk1'), t('pay.perk2'), t('pay.perk3')].map((x) => h('li', null, icon('check'), x))));
    if (error) body.appendChild(h('div', { class: 'error-text pw-error' }, error));
    const payBtn = h('button', { class: 'btn primary pw-pay', type: 'button', dataset: { id: 'pay' } }, t('pay.continue', { price: money(packPrice(pack, provider)) }));
    payBtn.addEventListener('click', () => startPayment(payBtn));
    body.appendChild(
      h(
        'div',
        { class: 'pw-actions' },
        h('button', { class: 'link-btn', type: 'button', onclick: () => restoreDialog().then((ok) => (ok && need && missingNow() === 0 ? finish() : ok && renderSelect())) }, t('pay.haveCode')),
        h('div', { class: 'pw-spacer' }),
        h('button', { class: 'btn', type: 'button', dataset: { id: 'later' }, onclick: finish }, t('pay.later')),
        payBtn,
      ),
    );
  };

  // ---------------------------------------------------------------- step 2: pay

  const startPayment = async (btn) => {
    if (provider === 'paypal') return renderPayPal();
    btn.disabled = true;
    btn.textContent = t('pay.creating');
    try {
      const data = await billing.createOrder(pack.id, provider);
      if (closed) return;
      currentOrder = data.order;
      if (provider === 'bank') renderBank(data.order, data.pay);
      else renderTest(data.order);
    } catch (e) {
      if (!closed) renderSelect(e.status === 0 ? t('pay.offline') : t('pay.error', { message: e.message }));
    }
  };

  const header = (order) =>
    h(
      'div',
      { class: 'pw-head' },
      h('button', { class: 'link-btn', type: 'button', dataset: { id: 'back' }, onclick: () => renderSelect() }, icon('chevronLeft'), t('pay.back')),
      h('div', { class: 'pw-summary' }, h('b', null, t('pay.pack', { n: order ? order.pages : pack.pages })), ' · ', order ? formatMoney(order.amount, order.currency, getLanguage()) : money(packPrice(pack, provider))),
    );

  const watchOrder = (order, statusEl) => {
    const tick = async () => {
      if (closed) return;
      try {
        const data = await billing.getOrder(order.id);
        if (closed || currentOrder !== order) return;
        if (data.order.status === 'paid') return renderSuccess(data.order.pages);
        if (data.order.status === 'expired' || data.order.status === 'cancelled') {
          stopTimers();
          statusEl.className = 'pw-status expired';
          clear(statusEl).append(icon('info'), h('span', null, t('pay.expired')));
        }
      } catch {
        /* keep waiting; the next poll tries again */
      }
    };
    every(POLL_MS, tick);
  };

  const renderBank = (order, pay) => {
    stopTimers();
    clear(body);
    body.dataset.step = 'bank';
    const qr = h('div', { class: 'pw-qr', html: qrSvg(pay.qr), title: pay.qr, dataset: { payload: pay.qr } });
    const row = (label, value, copy = null, cls = '') => h('div', { class: `pw-row ${cls}` }, h('span', { class: 'pw-row-label' }, label), h('span', { class: 'pw-row-value' }, value), copy !== null ? copyButton(copy) : null);
    const countdown = h('span', { class: 'hint' });
    const status = h('div', { class: 'pw-status' }, h('span', { class: 'spinner' }), h('span', null, h('b', null, t('pay.waiting')), h('div', { class: 'hint' }, pay.auto ? t('pay.waitingAuto') : t('pay.waitingManual'))));
    const updateCountdown = () => {
      const left = order.expiresAt - Date.now();
      countdown.textContent = left > 0 ? t('pay.expiresIn', { time: formatCountdown(left) }) : '';
    };
    updateCountdown();
    every(1000, updateCountdown);
    body.append(
      header(order),
      h(
        'div',
        { class: 'pw-bank' },
        h('div', { class: 'pw-qr-wrap' }, qr, h('div', { class: 'pw-qr-cap' }, icon('scan'), t('pay.scan'))),
        h(
          'div',
          { class: 'pw-details' },
          h('div', { class: 'hint' }, t('pay.scanHint')),
          row(t('pay.bankName'), pay.bankName),
          row(t('pay.accountNumber'), pay.account, pay.account),
          pay.accountName ? row(t('pay.accountName'), pay.accountName) : null,
          row(t('pay.amount'), formatMoney(pay.amount, 'VND', getLanguage()), String(pay.amount), 'strong'),
          row(t('pay.content'), pay.content, pay.content, 'strong code'),
          h('div', { class: 'pw-warn' }, icon('info'), t('pay.contentWarn')),
        ),
      ),
      status,
      h('div', { class: 'pw-actions' }, countdown, h('div', { class: 'pw-spacer' }), h('button', { class: 'btn', type: 'button', onclick: finish }, t('common.close'))),
    );
    watchOrder(order, status);
  };

  const renderTest = (order) => {
    stopTimers();
    clear(body);
    body.dataset.step = 'test';
    const btn = h('button', { class: 'btn primary', type: 'button', dataset: { id: 'test-complete' } }, t('pay.testComplete'));
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const data = await billing.completeTestOrder(order.id);
        if (!closed) renderSuccess(data.order.pages);
      } catch (e) {
        if (!closed) renderSelect(t('pay.error', { message: e.message }));
      }
    });
    body.append(header(order), h('div', { class: 'pw-test' }, icon('flask'), h('div', null, h('b', null, t('pay.orderCode', { code: order.code })), h('div', { class: 'hint' }, t('pay.testNote')))), h('div', { class: 'pw-actions' }, h('div', { class: 'pw-spacer' }), h('button', { class: 'btn', type: 'button', onclick: finish }, t('common.close')), btn));
  };

  const renderPayPal = () => {
    stopTimers();
    clear(body);
    body.dataset.step = 'paypal';
    const before = billing.account.credits;
    const url = `${config.base}pay/checkout/?provider=paypal&pack=${encodeURIComponent(pack.id)}&lang=${getLanguage()}`;
    // Opened directly in the click handler so that it is not blocked.
    const win = window.open(url, '_blank');
    const link = h('a', { class: 'btn primary', href: url, target: '_blank', rel: 'opener' }, icon('card'), t('pay.paypalOpen'));
    body.append(
      header(null),
      h('div', { class: 'pw-status' }, h('span', { class: 'spinner' }), h('span', null, h('b', null, t('pay.waiting')), h('div', { class: 'hint' }, win ? t('pay.paypalWaiting') : t('pay.paypalBlocked')))),
      h('div', { class: 'pw-actions' }, h('div', { class: 'pw-spacer' }), h('button', { class: 'btn', type: 'button', onclick: finish }, t('common.close')), link),
    );
    const marker = {};
    currentOrder = marker;
    const check = async () => {
      if (closed || currentOrder !== marker) return;
      await billing.refresh();
      if (closed || currentOrder !== marker) return;
      if (billing.account.credits > before) renderSuccess(billing.account.credits - before);
    };
    every(3000, check);
    const onChange = () => {
      if (closed || currentOrder !== marker) return billing.removeEventListener('change', onChange);
      if (billing.account.credits > before) {
        billing.removeEventListener('change', onChange);
        renderSuccess(billing.account.credits - before);
      }
    };
    billing.addEventListener('change', onChange);
  };

  // ---------------------------------------------------------------- step 3: done

  const renderSuccess = (pages) => {
    stopTimers();
    currentOrder = null;
    purchased = true;
    billing.announce();
    clear(body);
    body.dataset.step = 'success';
    const still = need ? missingNow() : 0;
    const btn = h('button', { class: 'btn primary', type: 'button', dataset: { id: 'done' } }, still > 0 ? t('quota.buy') : t('pay.done'));
    btn.addEventListener('click', () => (still > 0 ? renderSelect() : finish()));
    body.append(
      h('div', { class: 'pw-success' }, h('div', { class: 'pw-check' }, icon('check')), h('h3', null, t('pay.success')), h('div', null, t('pay.successDetail', { n: pages, total: billing.available })), still > 0 ? h('div', { class: 'error-text' }, t('pay.stillMissing', { missing: still })) : null),
      h('div', { class: 'pw-actions center' }, btn),
    );
    requestAnimationFrame(() => btn.focus());
  };

  renderSelect();
  // A bank transfer that arrives after the dialog was closed is still
  // credited: the order stays open until it expires.
  const result = await dlg.promise;
  return need ? billing.available >= needed : !!result || purchased;
}

// ---------------------------------------------------------------- account dialog

export async function openAccount() {
  await billing.refreshIfStale();
  const a = billing.account;
  const content = h('div', { class: 'acct' });
  const stat = (label, value, sub = null, cls = '') => h('div', { class: `acct-stat ${cls}` }, h('div', { class: 'acct-value' }, value), h('div', { class: 'acct-label' }, label), sub ? h('div', { class: 'hint' }, sub) : null);
  content.appendChild(
    h(
      'div',
      { class: 'acct-stats' },
      stat(t('account.freeLeft'), t('account.freeOf', { n: a.free.remaining, limit: a.free.limit }), a.free.resetsAt ? t('account.freeResets', { date: formatDate(a.free.resetsAt) }) : null, 'free'),
      stat(t('account.credits'), String(a.credits), a.credits > 0 && billing.config.ads.hideForPaid !== false ? t('account.noAds') : null, 'paid'),
    ),
  );
  content.appendChild(h('div', { class: 'hint acct-how' }, t('account.howItWorks')));
  if (a.restoreCode) {
    content.appendChild(
      h(
        'div',
        { class: 'acct-code' },
        h('div', { class: 'acct-code-head' }, h('b', null, t('account.restoreCode')), a.id ? h('span', { class: 'hint' }, `${t('account.id')}: ${a.id}`) : null),
        h('div', { class: 'acct-code-row' }, h('code', { dataset: { id: 'restore-code' } }, a.restoreCode), copyButton(a.restoreCode)),
        h('div', { class: 'hint' }, t('account.restoreHint')),
      ),
    );
  } else {
    content.appendChild(h('div', { class: 'hint' }, t('account.noAccountYet')));
  }
  const ordersEl = h('div', { class: 'acct-orders' });
  content.appendChild(ordersEl);
  const dlg = openDialog({
    title: t('account.title'),
    content,
    width: 520,
    className: 'account-dialog',
    footerLeft: h('button', { class: 'link-btn', type: 'button', onclick: async () => { if (await restoreDialog()) dlg.close('restored'); } }, t('account.enterCode')),
    buttons: [
      { label: t('common.close'), value: null },
      { label: t('quota.buy'), primary: true, value: 'buy' },
    ],
  });
  billing
    .listOrders()
    .then((orders) => {
      const shown = orders.filter((o) => o.status === 'paid' || o.status === 'pending').slice(0, 5);
      if (!shown.length) return;
      ordersEl.appendChild(h('b', null, t('account.orders')));
      for (const o of shown) {
        ordersEl.appendChild(
          h('div', { class: 'acct-order' }, h('span', null, t('pay.pack', { n: o.pages })), h('span', { class: 'hint' }, `${formatMoney(o.amount, o.currency, getLanguage())} · ${o.code}`), h('span', { class: `acct-order-status ${o.status}` }, t(`order.${o.status}`))),
        );
      }
    })
    .catch(() => {});
  const res = await dlg.promise;
  if (res === 'buy') return openPaywall();
  if (res === 'restored') return openAccount();
  return null;
}

setPaywall((need) => openPaywall(need));
