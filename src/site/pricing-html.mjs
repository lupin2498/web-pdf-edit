// Price cards of the page packs. Rendered by the server (the packs come from
// the PACKS setting), so the pages always show the configured prices.
import { T, appPath } from './content.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CHECK = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 12.5l5 5L19.5 7"/></svg>';

export function money(amount, currency, lang) {
  if (currency === 'VND') return `${new Intl.NumberFormat(lang === 'vi' ? 'vi-VN' : 'en-US').format(amount)} ₫`;
  return `$${(amount / 100).toFixed(2)}`;
}

/** Price of a pack in the currency that suits the language and the payment methods. */
export function displayPrice(pack, pub, lang) {
  const providers = pub.providers || [];
  const vnd = pack.vnd > 0 ? { amount: pack.vnd, currency: 'VND' } : null;
  const usd = pack.usd > 0 ? { amount: Math.round(pack.usd * 100), currency: 'USD' } : null;
  const paypal = providers.includes('paypal');
  const bank = providers.includes('bank');
  if (lang === 'en') return (paypal || !bank ? usd : null) || vnd || usd;
  return (bank || !paypal ? vnd : null) || usd || vnd;
}

function perPage(price, pages, lang) {
  if (price.currency === 'VND') return money(Math.round(price.amount / pages), 'VND', lang);
  const cents = price.amount / pages;
  return cents >= 1 ? `$${(cents / 100).toFixed(2)}` : `${cents.toFixed(1)}¢`;
}

export function packsHtml(pub, lang) {
  const s = T[lang].pricing;
  const packs = pub.packs || [];
  const priced = packs.map((p) => ({ pack: p, price: displayPrice(p, pub, lang) })).filter((x) => x.price);
  const cheapest = priced.reduce((best, x) => (!best || x.price.amount / x.pack.pages < best.price.amount / best.pack.pages ? x : best), null);
  return priced
    .map(({ pack, price }) => {
      const badge = pack.popular ? (lang === 'vi' ? 'Phổ biến nhất' : 'Most popular') : cheapest && cheapest.pack === pack && priced.length > 1 ? (lang === 'vi' ? 'Tiết kiệm nhất' : 'Best value') : '';
      const unit = lang === 'vi' ? `${pack.pages} trang` : `${pack.pages} pages`;
      const per = lang === 'vi' ? `${perPage(price, pack.pages, lang)} / trang` : `${perPage(price, pack.pages, lang)} / page`;
      return `<div class="price-card${pack.popular ? ' popular' : ''}" data-reveal>
          ${badge ? `<span class="pc-badge">${esc(badge)}</span>` : ''}
          <div class="pc-name">${esc(unit)}</div>
          <div class="pc-price">${esc(money(price.amount, price.currency, lang))}</div>
          <div class="pc-per">${esc(per)}</div>
          <ul class="pc-list">${s.packFeatures.map((f) => `<li>${CHECK}<span>${esc(f)}</span></li>`).join('')}</ul>
          <a class="btn ${pack.popular ? 'btn-primary' : 'btn-outline'} btn-block" href="${esc(appPath(lang, `buy=${encodeURIComponent(pack.id)}`))}" data-buy="${esc(pack.id)}">${esc(s.buy)}</a>
        </div>`;
    })
    .join('\n');
}
