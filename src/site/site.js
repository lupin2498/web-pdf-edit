// Behaviour of the public pages: theme, navigation, scroll reveal, file
// drop zones that hand the chosen files to the editor, and ad slots.
import { handoffStore } from '../web/storage.js';
import { configureAds, mountStaticAds } from '../web/ads.js';
import { readConfig } from '../web/config.js';

const config = readConfig();
let strings = {};
try {
  strings = JSON.parse(document.getElementById('site-strings')?.textContent || '{}');
} catch {
  strings = {};
}
const lang = strings.lang || document.documentElement.lang || 'vi';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function readSettings() {
  try {
    return JSON.parse(localStorage.getItem('pdfedit.settings') || '{}') || {};
  } catch {
    return {};
  }
}

function saveSettings(patch) {
  try {
    localStorage.setItem('pdfedit.settings', JSON.stringify({ ...readSettings(), ...patch }));
  } catch {
    /* storage unavailable */
  }
}

// ---------------------------------------------------------------- theme

for (const btn of document.querySelectorAll('[data-theme-toggle]')) {
  btn.addEventListener('click', () => {
    const root = document.documentElement;
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.classList.add('theme-anim');
    root.dataset.theme = next;
    saveSettings({ theme: next });
    setTimeout(() => root.classList.remove('theme-anim'), 400);
  });
}

// The editor opens in the language of the page the visitor came from.
for (const a of document.querySelectorAll('[data-lang-switch]')) {
  a.addEventListener('click', () => saveSettings({ language: a.dataset.langSwitch }));
}

// ---------------------------------------------------------------- header

const header = document.querySelector('[data-header]');
if (header) {
  const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 6);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  const navToggle = header.querySelector('[data-nav-toggle]');
  const setNav = (open) => {
    header.classList.toggle('nav-open', open);
    if (navToggle) navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.body.classList.toggle('no-scroll', open);
  };
  if (navToggle) navToggle.addEventListener('click', () => setNav(!header.classList.contains('nav-open')));
  window.addEventListener('resize', () => {
    if (window.innerWidth > 900 && header.classList.contains('nav-open')) setNav(false);
  });

  for (const item of header.querySelectorAll('[data-menu]')) {
    const toggle = item.querySelector('[data-menu-toggle]');
    const set = (open) => {
      item.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      set(!item.classList.contains('open'));
    });
    document.addEventListener('click', (e) => {
      if (!item.contains(e.target)) set(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && item.classList.contains('open')) {
        set(false);
        toggle.focus();
      }
    });
  }
}

// ---------------------------------------------------------------- reveal on scroll

const revealEls = [...document.querySelectorAll('[data-reveal]')];
if (!reducedMotion && 'IntersectionObserver' in window) {
  // Elements already on screen are shown right away (no flicker); the others
  // fade in when they scroll into view.
  const vh = window.innerHeight;
  const pending = [];
  for (const el of revealEls) {
    const r = el.getBoundingClientRect();
    if (r.top < vh && r.bottom > 0) el.classList.add('in');
    else pending.push(el);
  }
  document.documentElement.classList.add('reveal-ready');
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    },
    { rootMargin: '0px 0px -6% 0px' },
  );
  for (const el of pending) io.observe(el);
} else {
  for (const el of revealEls) el.classList.add('in');
}

// ---------------------------------------------------------------- editor prefetch

let prefetched = false;
function prefetchEditor() {
  if (prefetched) return;
  prefetched = true;
  const { appJs, appCss } = document.body.dataset;
  for (const [href, as] of [
    [appJs, 'script'],
    [appCss, 'style'],
  ]) {
    if (!href) continue;
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.as = as;
    link.href = href;
    document.head.appendChild(link);
  }
}

function appUrl(params) {
  const q = new URLSearchParams(params);
  if (lang === 'en') q.set('lang', 'en');
  const s = q.toString();
  return `${config.base}app/${s ? `?${s}` : ''}`;
}

// ---------------------------------------------------------------- drop zones

const IMAGE_RE = /\.(png|jpe?g|gif|bmp|webp)$/i;
function accepts(file, accept) {
  const pdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const img = /^image\/(png|jpeg|gif|bmp|webp)$/.test(file.type) || IMAGE_RE.test(file.name);
  if (accept === 'img') return img;
  if (accept === 'pdf+img') return pdf || img;
  return pdf;
}

function setupDropzone(zone) {
  const input = zone.querySelector('.dz-input');
  const button = zone.querySelector('.dz-button');
  const { tool, accept } = zone.dataset;
  const multiple = zone.dataset.multiple === '1';
  let error = null;

  const showError = (text) => {
    if (!error) {
      error = document.createElement('p');
      error.className = 'dz-error';
      error.setAttribute('role', 'alert');
      zone.querySelector('.dz-inner').appendChild(error);
    }
    error.textContent = text;
    zone.classList.remove('shake');
    void zone.offsetWidth;
    zone.classList.add('shake');
  };

  const go = async (files) => {
    const ok = files.filter((f) => accepts(f, accept));
    if (!ok.length) return showError((strings.drop && strings.drop.wrongType) || 'Unsupported file');
    if (error) error.textContent = '';
    zone.classList.add('busy');
    prefetchEditor();
    const stored = await handoffStore.put(multiple ? ok : [ok[0]]);
    // Without browser storage the editor asks for the file again and then
    // runs the same task.
    location.href = appUrl({ tool, open: stored ? 'handoff' : 'retry' });
  };

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    input.click();
  });
  zone.addEventListener('click', (e) => {
    if (e.target.closest('a, button, input') || zone.classList.contains('busy')) return;
    input.click();
  });
  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = '';
    if (files.length) go(files);
  });
  zone.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', (e) => {
    if (!zone.contains(e.relatedTarget)) zone.classList.remove('over');
  });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove('over');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) go(files);
  });
  for (const ev of ['pointerenter', 'focusin', 'touchstart']) zone.addEventListener(ev, prefetchEditor, { once: true, passive: true });
  zone.go = go;
}

const zones = [...document.querySelectorAll('[data-dropzone]')];
zones.forEach(setupDropzone);

// Files dropped anywhere on the page go to the main drop zone.
if (zones.length) {
  const main = zones[0];
  document.addEventListener('dragover', (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
      e.preventDefault();
      document.body.classList.add('dragging');
    }
  });
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) document.body.classList.remove('dragging');
  });
  document.addEventListener('drop', (e) => {
    document.body.classList.remove('dragging');
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    main.go([...e.dataTransfer.files]);
  });
}

// Coming back with the browser's back button: the page is restored from the
// cache with the "opening" state still showing.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) for (const z of zones) z.classList.remove('busy', 'over');
  document.body.classList.remove('dragging');
});

// ---------------------------------------------------------------- ads

function cachedCredits() {
  try {
    const a = JSON.parse(localStorage.getItem('pdfedit.account') || 'null');
    return a && Number(a.credits) > 0 ? Number(a.credits) : 0;
  } catch {
    return 0;
  }
}

configureAds({
  label: strings.adLabel || 'Advertisement',
  adFree: () => config.ads.hideForPaid !== false && cachedCredits() > 0,
  // The page-pack promotion is shown once per page (middle slot); the other
  // slots only carry network ads.
  house: (placement) => {
    const h = strings.house;
    if (!h || placement !== 'landing_mid') return null;
    const a = document.createElement('a');
    a.className = 'house-banner';
    a.href = h.href;
    a.innerHTML = `<span class="hb-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3l1.9 5.1L17 10l-5.1 1.9L10 17l-1.9-5.1L3 10l5.1-1.9z"/><path d="M19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9z"/></svg></span><span class="hb-text"><b></b><span></span></span><span class="hb-cta"></span>`;
    a.querySelector('b').textContent = h.title;
    a.querySelector('.hb-text span').textContent = h.text;
    a.querySelector('.hb-cta').textContent = h.cta;
    return a;
  },
});
mountStaticAds();

// ---------------------------------------------------------------- small things

for (const el of document.querySelectorAll('[data-year]')) el.textContent = String(new Date().getFullYear());
if (!config.contactEmail) for (const el of document.querySelectorAll('[data-contact]')) el.remove();

// Buying from the pricing page keeps the language of the page.
for (const a of document.querySelectorAll('a[data-buy]')) {
  a.addEventListener('click', () => saveSettings({ language: lang }));
}
