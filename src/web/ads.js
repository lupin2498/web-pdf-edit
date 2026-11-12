// Ad slots. A slot shows, in this order of preference: a Google AdSense
// unit (when the placement has an ad-unit id), a snippet of another ad
// network (ADS_HTML_<PLACEMENT>), or a "house ad" that promotes page packs.
// Slots disappear while the visitor holds purchased pages.
//
// This module has no dependency on the editor so that the landing pages can
// use it too.
import { readConfig } from './config.js';

const SIZES = {
  // placement: [format, width, height] ('auto' = responsive)
  landing_top: ['auto', 0, 0],
  landing_mid: ['auto', 0, 0],
  landing_bottom: ['auto', 0, 0],
  app_home: ['auto', 0, 0],
  // The properties panel is narrower than 300 px: a responsive unit fits.
  app_side: ['auto', 0, 0],
};

const slots = new Set();
let options = { label: 'Advertisement', adFree: () => false, house: null };

/**
 * @param {object} o
 * @param {string} o.label     text shown above every ad
 * @param {() => boolean} o.adFree  true while ads must be hidden
 * @param {(placement: string) => HTMLElement|null} o.house  builds a house ad
 */
export function configureAds(o) {
  options = { ...options, ...o };
  refreshAds();
}

export function adKind(placement) {
  const { ads } = readConfig();
  if (ads.adsenseClient && ads.slots && ads.slots[placement]) return 'adsense';
  if (ads.customSlots && ads.customSlots[placement]) return 'custom';
  if (ads.house !== false) return 'house';
  return 'none';
}

/** Inserts HTML and runs the <script> elements it contains. */
function injectHtml(container, html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  for (const old of tpl.content.querySelectorAll('script')) {
    const s = document.createElement('script');
    for (const a of old.attributes) s.setAttribute(a.name, a.value);
    s.textContent = old.textContent;
    old.replaceWith(s);
  }
  container.appendChild(tpl.content);
}

function fill(slot) {
  const { placement, el } = slot;
  const { ads } = readConfig();
  const kind = adKind(placement);
  const hidden = kind === 'none' || options.adFree();
  el.classList.toggle('hidden', hidden);
  el.hidden = hidden;
  if (hidden) {
    // Remove the creative so that nothing keeps loading while hidden.
    if (slot.filled) {
      el.replaceChildren();
      slot.filled = null;
    }
    return;
  }
  el.dataset.adKind = kind;
  // Network ads are requested when the slot scrolls into view: the network
  // needs the real width of the slot, and unseen ads are never loaded.
  if (kind !== 'house' && !slot.seen) return;
  if (slot.filled === kind) return;
  el.replaceChildren();
  slot.filled = kind;
  const label = document.createElement('div');
  label.className = 'ad-label';
  label.textContent = options.label;
  const body = document.createElement('div');
  body.className = 'ad-body';
  el.append(label, body);
  const [format, width, height] = SIZES[placement] || SIZES.app_home;
  if (kind === 'adsense') {
    const ins = document.createElement('ins');
    ins.className = 'adsbygoogle';
    ins.dataset.adClient = ads.adsenseClient;
    ins.dataset.adSlot = ads.slots[placement];
    if (format === 'auto') {
      ins.style.display = 'block';
      ins.dataset.adFormat = 'auto';
      ins.dataset.fullWidthResponsive = 'true';
    } else {
      ins.style.cssText = `display:inline-block;width:${width}px;height:${height}px`;
    }
    body.appendChild(ins);
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch {
      /* blocked by an ad blocker */
    }
  } else if (kind === 'custom') {
    injectHtml(body, ads.customSlots[placement]);
  } else {
    const house = options.house ? options.house(placement) : null;
    if (house) body.appendChild(house);
    else {
      el.classList.add('hidden');
      el.hidden = true;
      slot.filled = null;
    }
  }
}

let observer = null;
function observe(slot) {
  if (typeof IntersectionObserver === 'undefined') {
    slot.seen = true;
    return;
  }
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const slot = [...slots].find((s) => s.el === e.target);
          observer.unobserve(e.target);
          if (slot) {
            slot.seen = true;
            fill(slot);
          }
        }
      },
      { rootMargin: '200px' },
    );
  }
  observer.observe(slot.el);
}

/** Creates (or adopts) the element of an ad slot. */
export function adSlot(placement, el = null) {
  const node = el || document.createElement('div');
  node.classList.add('ad-slot', `ad-${placement.replace(/_/g, '-')}`);
  node.dataset.ad = placement;
  const slot = { placement, el: node, filled: null, seen: false, attached: node.isConnected };
  slots.add(slot);
  observe(slot);
  fill(slot);
  return node;
}

/** Re-evaluates every slot (after the balance or the settings changed). */
export function refreshAds() {
  for (const slot of [...slots]) {
    if (slot.el.isConnected) slot.attached = true;
    else if (slot.attached) {
      // The view that held this slot was closed.
      if (observer) observer.unobserve(slot.el);
      slots.delete(slot);
      continue;
    }
    fill(slot);
  }
}

/** Adopts every <div data-ad="placement"> of a static page. */
export function mountStaticAds(root = document) {
  for (const el of root.querySelectorAll('[data-ad]')) {
    if (![...slots].some((s) => s.el === el)) adSlot(el.dataset.ad, el);
  }
}
