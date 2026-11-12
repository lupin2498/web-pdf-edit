// Generates every HTML page of the site into dist/.
//
// Pages are plain HTML (fast, indexable); the server fills the %%NAME%%
// placeholders at start-up (site name, URL, free pages, prices, ads).
import fs from 'node:fs';
import path from 'node:path';
import { ICON_PATHS } from '../renderer/js/ui/icons.js';
import { T, TOOLS, TOOL_TEXT, PAGES, LEGAL, LANGS, toolPath, appPath } from './content.mjs';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function icon(name, cls = '') {
  const paths = ICON_PATHS[name] || ICON_PATHS.file;
  const filled = name === 'logo';
  return `<svg class="ico${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${filled ? 1.5 : 1.8}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

// Gradient ids must be unique in a page (the logo appears twice).
let logoSeq = 0;
const logoSvg = () => {
  const n = ++logoSeq;
  return `<svg class="logo" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="lg-a${n}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff6b6b"/><stop offset="1" stop-color="#d9284b"/></linearGradient><linearGradient id="lg-b${n}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#4f8dff"/><stop offset="1" stop-color="#1d4ed8"/></linearGradient></defs><rect x="3" y="3" width="58" height="58" rx="14" fill="url(#lg-a${n})"/><path d="M19 11.5h18.6L48 22v30a3 3 0 0 1-3 3H19a3 3 0 0 1-3-3V14.5a3 3 0 0 1 3-3z" fill="#fff"/><path d="M37.3 11.5V19a3 3 0 0 0 3 3H48z" fill="#ffc9d1"/><rect x="20" y="26.5" width="19" height="2.6" rx="1.3" fill="#f29aa8"/><rect x="20" y="32" width="24" height="2.6" rx="1.3" fill="#f29aa8"/><rect x="20" y="37.5" width="14" height="2.6" rx="1.3" fill="#f29aa8"/><g transform="rotate(45 41 41)"><rect x="38.5" y="25" width="5.5" height="23.5" rx="1.2" fill="url(#lg-b${n})"/><rect x="38.5" y="25" width="5.5" height="4.4" rx="1.2" fill="#9cc2ff"/><path d="M38.5 48.5h5.5l-2.75 6z" fill="#ffe2b8"/></g></svg>`;
};

// ---------------------------------------------------------------------------
// Building blocks

function alternatesOf(paths) {
  return LANGS.filter((l) => paths[l]).map((l) => ({ lang: l, path: paths[l] }));
}

function head({ lang, title, description, pathname, alternates, assets, jsonLd = [], noindex = false, ogType = 'website' }) {
  const s = T[lang];
  const alt = alternates
    .map((a) => `<link rel="alternate" hreflang="${a.lang}" href="%%SITE_URL%%${a.path}" />`)
    .concat(alternates.length ? [`<link rel="alternate" hreflang="x-default" href="%%SITE_URL%%${(alternates.find((a) => a.lang === 'vi') || alternates[0]).path}" />`] : [])
    .join('\n    ');
  return `<!doctype html>
<html lang="${lang}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}" />
    ${noindex ? '<meta name="robots" content="noindex" />' : `<link rel="canonical" href="%%SITE_URL%%${pathname}" />`}
    ${noindex ? '' : alt}
    <meta property="og:type" content="${ogType}" />
    <meta property="og:site_name" content="%%SITE_NAME%%" />
    <meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(description)}" />
    <meta property="og:url" content="%%SITE_URL%%${pathname}" />
    <meta property="og:image" content="%%SITE_URL%%/og-image.png" />
    <meta property="og:locale" content="${s.locale}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="theme-color" content="#3563ff" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#0b1020" media="(prefers-color-scheme: dark)" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="icon" href="/icon-192.png" sizes="192x192" type="image/png" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <script src="/${assets.theme}"></script>
    <link rel="stylesheet" href="/${assets.css}" />
    <script type="application/json" id="pe-config">%%PUBLIC_CONFIG%%</script>
    %%HEAD_EXTRA%%
    ${jsonLd.map((j) => `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, '\\u003c')}</script>`).join('\n    ')}
  </head>`;
}

function header(lang, alternates) {
  const s = T[lang];
  const other = lang === 'vi' ? 'en' : 'vi';
  const otherPath = (alternates.find((a) => a.lang === other) || { path: PAGES.home[other] }).path;
  const toolsMenu = TOOLS.map((tool) => {
    const tt = TOOL_TEXT[tool.id][lang];
    return `<a class="mega-item" href="${toolPath(tool, lang)}" style="--c:${tool.color}"><span class="mi-icon">${icon(tool.icon)}</span><span class="mi-text"><b>${esc(tt.name)}</b><small>${esc(tt.short)}</small></span></a>`;
  }).join('');
  return `<a class="skip-link" href="#main">${esc(s.nav.skip)}</a>
    <header class="site-header" data-header>
      <div class="container header-inner">
        <a class="brand" href="${PAGES.home[lang]}" aria-label="%%SITE_NAME%%">${logoSvg()}<span>%%SITE_NAME%%</span></a>
        <nav class="main-nav" aria-label="${esc(s.nav.menu)}">
          <div class="nav-item" data-menu>
            <button class="nav-link" type="button" aria-expanded="false" aria-haspopup="true" data-menu-toggle>${esc(s.nav.tools)}${icon('chevronDown', 'caret')}</button>
            <div class="mega" data-menu-panel>${toolsMenu}</div>
          </div>
          <a class="nav-link" href="${PAGES.pricing[lang]}">${esc(s.nav.pricing)}</a>
        </nav>
        <div class="header-actions">
          <a class="icon-btn lang-btn" href="${otherPath}" hreflang="${other}" lang="${other}" title="${esc(s.nav.language)}" data-lang-switch="${other}">${icon('globe')}<span>${other.toUpperCase()}</span></a>
          <button class="icon-btn theme-btn" type="button" data-theme-toggle aria-label="${esc(s.nav.theme)}" title="${esc(s.nav.theme)}">${icon('moon', 'i-moon')}${icon('sun', 'i-sun')}</button>
          <a class="btn btn-primary btn-sm header-cta" href="${appPath(lang)}">${icon('edit')}<span class="hide-sm">${esc(s.nav.open)}</span><span class="show-sm">${esc(s.nav.openShort)}</span></a>
          <button class="icon-btn menu-btn" type="button" data-nav-toggle aria-expanded="false" aria-controls="mobile-nav" aria-label="${esc(s.nav.menu)}">${icon('menu')}</button>
        </div>
      </div>
      <div class="mobile-nav" id="mobile-nav" data-mobile-nav>
        <div class="container">
          <div class="mn-title">${esc(s.nav.tools)}</div>
          <div class="mn-tools">${TOOLS.map((tool) => `<a href="${toolPath(tool, lang)}" style="--c:${tool.color}"><span class="mi-icon">${icon(tool.icon)}</span>${esc(TOOL_TEXT[tool.id][lang].name)}</a>`).join('')}</div>
          <div class="mn-links"><a href="${PAGES.pricing[lang]}">${icon('wallet')}${esc(s.nav.pricing)}</a><a href="${otherPath}" hreflang="${other}">${icon('globe')}${esc(s.nav.language)}</a></div>
          <a class="btn btn-primary btn-block" href="${appPath(lang)}">${esc(s.nav.open)}</a>
        </div>
      </div>
    </header>`;
}

function footer(lang, alternates) {
  const s = T[lang];
  const other = lang === 'vi' ? 'en' : 'vi';
  const otherPath = (alternates.find((a) => a.lang === other) || { path: PAGES.home[other] }).path;
  return `<footer class="site-footer">
      <div class="container footer-grid">
        <div class="footer-brand">
          <a class="brand" href="${PAGES.home[lang]}">${logoSvg()}<span>%%SITE_NAME%%</span></a>
          <p>${esc(s.footer.tagline)}</p>
          <a class="footer-lang" href="${otherPath}" hreflang="${other}" lang="${other}">${icon('globe')}${esc(T[other].langName)}</a>
        </div>
        <div class="footer-col">
          <h3>${esc(s.footer.tools)}</h3>
          <ul>${TOOLS.slice(0, 6).map((tool) => `<li><a href="${toolPath(tool, lang)}">${esc(TOOL_TEXT[tool.id][lang].name)}</a></li>`).join('')}</ul>
        </div>
        <div class="footer-col">
          <h3>&nbsp;</h3>
          <ul>${TOOLS.slice(6).map((tool) => `<li><a href="${toolPath(tool, lang)}">${esc(TOOL_TEXT[tool.id][lang].name)}</a></li>`).join('')}</ul>
        </div>
        <div class="footer-col">
          <h3>${esc(s.footer.company)}</h3>
          <ul>
            <li><a href="${PAGES.pricing[lang]}">${esc(s.footer.pricing)}</a></li>
            <li><a href="${PAGES.privacy[lang]}">${esc(s.footer.privacy)}</a></li>
            <li><a href="${PAGES.terms[lang]}">${esc(s.footer.terms)}</a></li>
            <li data-contact><a href="mailto:%%CONTACT_EMAIL%%">${esc(s.footer.contact)}</a></li>
          </ul>
        </div>
      </div>
      <div class="container footer-bottom">
        <span>© <span data-year>2026</span> %%SITE_NAME%%. ${esc(s.footer.rights)}</span>
        <span class="footer-private">${icon('shield')}${esc(s.drop.private)}</span>
      </div>
    </footer>`;
}

function siteStrings(lang) {
  const s = T[lang];
  return {
    lang,
    adLabel: s.adLabel,
    house: { ...s.house, href: PAGES.pricing[lang] },
    drop: s.drop,
    pay: s.pay,
  };
}

function page({ lang, title, description, pathname, alternates, assets, body, jsonLd, noindex, bodyClass = '' }) {
  return `${head({ lang, title, description, pathname, alternates, assets, jsonLd, noindex })}
  <body class="${bodyClass}" data-app-js="/${assets.appJs}" data-app-css="/${assets.appCss}">
    ${header(lang, alternates)}
    <main id="main">
${body}
    </main>
    ${footer(lang, alternates)}
    <script type="application/json" id="site-strings">${JSON.stringify(siteStrings(lang)).replace(/</g, '\\u003c')}</script>
    <script type="module" src="/${assets.js}"></script>
  </body>
</html>
`;
}

const ad = (placement) => `<div class="container ad-wrap"><div data-ad="${placement}"></div></div>`;

function acceptOf(tool) {
  if (tool.accept === 'img') return 'image/png,image/jpeg,image/gif,image/bmp,image/webp,.png,.jpg,.jpeg,.gif,.bmp,.webp';
  if (tool.accept === 'pdf+img') return 'application/pdf,.pdf,image/png,image/jpeg,image/gif,image/bmp,image/webp,.png,.jpg,.jpeg,.gif,.bmp,.webp';
  return 'application/pdf,.pdf';
}

function dropzone(lang, tool = null, { compact = false } = {}) {
  const s = T[lang].drop;
  const t = tool || { id: 'edit', accept: 'pdf' };
  const label = t.accept === 'img' ? s.chooseImages : t.accept === 'pdf+img' ? s.chooseFiles : s.choose;
  return `<div class="dropzone${compact ? ' compact' : ''}" data-dropzone data-tool="${t.id}" data-accept="${t.accept}" data-multiple="${t.multiple ? '1' : '0'}" data-lang="${lang}" style="--c:${tool ? tool.color : 'var(--primary)'}">
          <div class="dz-inner">
            <div class="dz-icon">${icon('upload')}</div>
            <button class="btn btn-primary btn-lg dz-button" type="button">${icon('filePdf')}<span>${esc(label)}</span></button>
            <p class="dz-hint">${esc(s.hint)}</p>
            <p class="dz-private">${icon('shield')}${esc(s.private)}</p>
          </div>
          <div class="dz-busy" aria-live="polite"><span class="spinner"></span><span>${esc(s.opening)}</span></div>
          <input class="dz-input" type="file" accept="${acceptOf(t)}"${t.multiple ? ' multiple' : ''} tabindex="-1" aria-hidden="true" />
        </div>`;
}

function toolCard(tool, lang, extraClass = '') {
  const tt = TOOL_TEXT[tool.id][lang];
  return `<a class="tool-card${extraClass}" href="${toolPath(tool, lang)}" style="--c:${tool.color}" data-reveal>
            <span class="tc-icon">${icon(tool.icon)}</span>
            <span class="tc-name">${esc(tt.name)}</span>
            <span class="tc-desc">${esc(tt.short)}</span>
            <span class="tc-go">${icon('arrowRight')}</span>
          </a>`;
}

function faqList(items) {
  return `<div class="faq">${items.map((f, i) => `<details class="faq-item" data-reveal${i === 0 ? ' open' : ''}><summary>${esc(f.q)}${icon('plus', 'faq-icon')}</summary><div class="faq-a"><p>${esc(f.a)}</p></div></details>`).join('')}</div>`;
}

function faqJsonLd(items) {
  return { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: items.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) };
}

function appJsonLd(lang, name, description) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name,
    description,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    browserRequirements: 'Requires JavaScript',
    inLanguage: lang,
    url: '%%SITE_URL%%/',
    offers: { '@type': 'Offer', price: '0', priceCurrency: lang === 'vi' ? 'VND' : 'USD' },
  };
}

function heroMockup(lang) {
  const vi = lang === 'vi';
  return `<div class="mock" aria-hidden="true">
          <div class="mock-window">
            <div class="mock-bar"><i></i><i></i><i></i><span class="mock-title">${vi ? 'hop-dong.pdf' : 'contract.pdf'}</span><span class="mock-dl">${icon('download')}${vi ? 'Tải xuống' : 'Download'}</span></div>
            <div class="mock-tools">
              <span class="mt-btn active">${icon('edit')}</span><span class="mt-btn">${icon('highlight')}</span><span class="mt-btn">${icon('signature')}</span><span class="mt-btn">${icon('image')}</span><span class="mt-btn">${icon('note')}</span><span class="mt-sep"></span><span class="mt-btn">${icon('combine')}</span><span class="mt-btn">${icon('lock')}</span>
            </div>
            <div class="mock-body">
              <div class="mock-thumbs"><span class="active"></span><span></span><span></span></div>
              <div class="mock-page">
                <div class="mp-title"></div>
                <div class="mp-line" style="width:92%"></div>
                <div class="mp-line" style="width:84%"></div>
                <div class="mp-line mp-hl" style="width:70%"><span></span></div>
                <div class="mp-edit"><span class="mp-typed">${vi ? 'Thời hạn: 12 tháng kể từ ngày ký' : 'Term: 12 months from signing'}</span><span class="mp-caret"></span></div>
                <div class="mp-row">
                  <div class="mp-img">${icon('image')}</div>
                  <div class="mp-col"><div class="mp-line" style="width:100%"></div><div class="mp-line" style="width:88%"></div><div class="mp-line" style="width:64%"></div></div>
                </div>
                <div class="mp-line" style="width:76%"></div>
                <div class="mp-sign">
                  <svg viewBox="0 0 220 70"><path d="M6 46c10-20 22-34 30-30s-6 34 0 36 18-30 26-34 2 26 10 26 16-24 24-24 0 20 8 20 14-14 22-16 10 10 18 8 20-8 30-12 20-2 30-6"/></svg>
                  <span class="mp-sign-line"></span>
                </div>
              </div>
            </div>
          </div>
          <div class="float-chip fc-1">${icon('toWord')}<span>PDF → Word</span></div>
          <div class="float-chip fc-2">${icon('combine')}<span>${vi ? 'Gộp 3 tệp' : 'Merge 3 files'}</span></div>
          <div class="float-chip fc-3">${icon('lock')}<span>AES-256</span></div>
          <div class="mock-toast">${icon('check')}<span>${vi ? 'Đã tải xuống hop-dong.pdf' : 'Downloaded contract.pdf'}</span></div>
        </div>`;
}

const FREE_CARD = (lang) => {
  const s = T[lang].pricing;
  return `<div class="price-card free" data-reveal>
          <div class="pc-name">${esc(s.freeTitle)}</div>
          <div class="pc-price">${esc(s.freePrice)}</div>
          <div class="pc-per">${esc(s.freeUnit)}</div>
          <ul class="pc-list">${s.freeFeatures.map((f) => `<li>${icon('check')}<span>${esc(f)}</span></li>`).join('')}</ul>
          <a class="btn btn-outline btn-block" href="${appPath(lang)}">${esc(s.freeCta)}</a>
        </div>`;
};

// ---------------------------------------------------------------------------
// Pages

function homePage(lang, assets) {
  const s = T[lang];
  const h = s.home;
  const alternates = alternatesOf(PAGES.home);
  const body = `      <section class="hero">
        <div class="hero-bg" aria-hidden="true"><span class="blob b1"></span><span class="blob b2"></span><span class="blob b3"></span><span class="grid-bg"></span></div>
        <div class="container hero-grid">
          <div class="hero-copy">
            <a class="pill" href="${toolPath(TOOLS.find((t) => t.id === 'word'), lang)}"><span class="pill-dot"></span>${esc(h.badge)}${icon('arrowRight')}</a>
            <h1><span class="h1a">${esc(h.h1a)}</span> <span class="grad">${esc(h.h1b)}</span></h1>
            <p class="lead">${esc(h.lead)}</p>
            ${dropzone(lang)}
            <ul class="trust">${h.trust.map((x) => `<li>${icon('check')}${esc(x)}</li>`).join('')}</ul>
          </div>
          <div class="hero-visual">${heroMockup(lang)}</div>
        </div>
      </section>
      ${ad('landing_top')}
      <section class="section" id="tools">
        <div class="container">
          <div class="section-head" data-reveal><h2>${esc(h.toolsTitle)}</h2><p>${esc(h.toolsLead)}</p></div>
          <div class="tools-grid">
          ${TOOLS.map((tool) => toolCard(tool, lang)).join('\n          ')}
          </div>
        </div>
      </section>
      <section class="section section-alt">
        <div class="container">
          <div class="section-head" data-reveal><h2>${esc(h.featuresTitle)}</h2></div>
          <div class="features-grid">
            ${h.features.map((f, i) => `<div class="feature" data-reveal style="--d:${i * 60}ms"><span class="f-icon">${icon(f.icon)}</span><h3>${esc(f.title)}</h3><p>${esc(f.text)}</p></div>`).join('\n            ')}
          </div>
        </div>
      </section>
      <section class="section">
        <div class="container">
          <div class="section-head" data-reveal><h2>${esc(h.stepsTitle)}</h2></div>
          <ol class="steps">
            ${h.steps.map((st, i) => `<li class="step" data-reveal style="--d:${i * 90}ms"><span class="step-n">${i + 1}</span><h3>${esc(st.title)}</h3><p>${esc(st.text)}</p></li>`).join('\n            ')}
          </ol>
        </div>
      </section>
      ${ad('landing_mid')}
      <section class="section section-alt" id="pricing">
        <div class="container">
          <div class="section-head" data-reveal><h2>${esc(h.pricingTitle)}</h2><p>${esc(h.pricingLead)}</p></div>
          <div class="pricing-grid">
            ${FREE_CARD(lang)}
            %%PRICING_${lang.toUpperCase()}%%
          </div>
        </div>
      </section>
      <section class="section">
        <div class="container narrow">
          <div class="section-head" data-reveal><h2>${esc(h.faqTitle)}</h2></div>
          ${faqList(h.faq)}
        </div>
      </section>
      <section class="cta-band">
        <div class="container cta-inner" data-reveal>
          <div><h2>${esc(h.ctaTitle)}</h2><p>${esc(h.ctaText)}</p></div>
          <a class="btn btn-light btn-lg" href="${appPath(lang)}">${esc(s.nav.open)}${icon('arrowRight')}</a>
        </div>
      </section>
      ${ad('landing_bottom')}`;
  return { path: PAGES.home[lang], html: page({ lang, title: h.title, description: h.description, pathname: PAGES.home[lang], alternates, assets, body, jsonLd: [appJsonLd(lang, '%%SITE_NAME%%', h.description), faqJsonLd(h.faq)], bodyClass: 'home' }), alternates, priority: '1.0' };
}

function toolPage(tool, lang, assets) {
  const s = T[lang];
  const tt = TOOL_TEXT[tool.id][lang];
  const alternates = alternatesOf({ vi: toolPath(tool, 'vi'), en: toolPath(tool, 'en') });
  const pathname = toolPath(tool, lang);
  const related = TOOLS.filter((x) => x.id !== tool.id).slice(0, 8);
  const body = `      <section class="hero hero-tool" style="--c:${tool.color}">
        <div class="hero-bg" aria-hidden="true"><span class="blob b1"></span><span class="blob b2"></span><span class="grid-bg"></span></div>
        <div class="container narrow center">
          <nav class="crumbs" aria-label="breadcrumb"><a href="${PAGES.home[lang]}">%%SITE_NAME%%</a>${icon('chevronRight')}<span>${esc(tt.name)}</span></nav>
          <span class="tool-badge">${icon(tool.icon)}</span>
          <h1>${esc(tt.h1)}</h1>
          <p class="lead">${esc(tt.lead)}</p>
          ${dropzone(lang, tool)}
        </div>
      </section>
      ${ad('landing_top')}
      <section class="section">
        <div class="container">
          <div class="section-head" data-reveal><h2>${esc(s.tool.stepsTitle)}</h2></div>
          <ol class="steps">
            ${tt.steps.map((st, i) => `<li class="step" data-reveal style="--d:${i * 90}ms"><span class="step-n">${i + 1}</span><p>${esc(st)}</p></li>`).join('\n            ')}
          </ol>
        </div>
      </section>
      <section class="section section-alt">
        <div class="container split">
          <div data-reveal>
            <h2>${esc(s.tool.featuresTitle)}</h2>
            <ul class="check-list">${tt.features.map((f) => `<li>${icon('check')}<span>${esc(f)}</span></li>`).join('')}</ul>
          </div>
          <div class="trust-cards" data-reveal>
            <div class="trust-card">${icon('cloudOff')}<div><b>${lang === 'vi' ? 'Không tải lên máy chủ' : 'Nothing uploaded'}</b><span>${esc(s.drop.private)}</span></div></div>
            <div class="trust-card">${icon('gift')}<div><b>${lang === 'vi' ? '%%FREE_PAGES%% trang miễn phí' : '%%FREE_PAGES%% free pages'}</b><span>${lang === 'vi' ? 'Không cần đăng ký tài khoản' : 'No account needed'}</span></div></div>
            <div class="trust-card">${icon('devices')}<div><b>${lang === 'vi' ? 'Mọi thiết bị' : 'Any device'}</b><span>${lang === 'vi' ? 'Máy tính, máy tính bảng, điện thoại' : 'Computer, tablet and phone'}</span></div></div>
          </div>
        </div>
      </section>
      ${ad('landing_mid')}
      <section class="section">
        <div class="container narrow">
          <div class="section-head" data-reveal><h2>${esc(s.tool.faqTitle)}</h2></div>
          ${faqList(tt.faq)}
        </div>
      </section>
      <section class="section section-alt">
        <div class="container">
          <div class="section-head" data-reveal><h2>${esc(s.toolsSection.related)}</h2></div>
          <div class="tools-grid small">
          ${related.map((x) => toolCard(x, lang)).join('\n          ')}
          </div>
        </div>
      </section>
      ${ad('landing_bottom')}`;
  const breadcrumbs = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: '%%SITE_NAME%%', item: `%%SITE_URL%%${PAGES.home[lang]}` }, { '@type': 'ListItem', position: 2, name: tt.name, item: `%%SITE_URL%%${pathname}` }] };
  return { path: pathname, html: page({ lang, title: `${tt.title} | %%SITE_NAME%%`, description: tt.description, pathname, alternates, assets, body, jsonLd: [appJsonLd(lang, `${tt.name} – %%SITE_NAME%%`, tt.description), breadcrumbs, faqJsonLd(tt.faq)], bodyClass: `tool tool-${tool.id}` }), alternates, priority: '0.9' };
}

function pricingPage(lang, assets) {
  const s = T[lang];
  const p = s.pricing;
  const alternates = alternatesOf(PAGES.pricing);
  const body = `      <section class="hero hero-small">
        <div class="hero-bg" aria-hidden="true"><span class="blob b1"></span><span class="blob b2"></span><span class="grid-bg"></span></div>
        <div class="container narrow center">
          <h1>${esc(p.h1)}</h1>
          <p class="lead">${esc(p.lead)}</p>
        </div>
      </section>
      <section class="section pt-0">
        <div class="container">
          <div class="pricing-grid">
            ${FREE_CARD(lang)}
            %%PRICING_${lang.toUpperCase()}%%
          </div>
          <p class="pricing-note center" data-reveal>${icon('shield')}${esc(s.drop.private)}</p>
        </div>
      </section>
      <section class="section section-alt">
        <div class="container">
          <div class="section-head" data-reveal><h2>${esc(p.howTitle)}</h2></div>
          <div class="features-grid three">
            ${p.how.map((f, i) => `<div class="feature" data-reveal style="--d:${i * 60}ms"><span class="f-icon">${icon(f.icon)}</span><h3>${esc(f.title)}</h3><p>${esc(f.text)}</p></div>`).join('\n            ')}
          </div>
        </div>
      </section>
      <section class="section">
        <div class="container">
          <div class="section-head" data-reveal><h2>${esc(p.methodsTitle)}</h2></div>
          <div class="methods">
            ${p.methods.map((m) => `<div class="method" data-reveal><span class="f-icon">${icon(m.icon)}</span><div><h3>${esc(m.title)}</h3><p>${esc(m.text)}</p></div></div>`).join('\n            ')}
          </div>
        </div>
      </section>
      ${ad('landing_mid')}
      <section class="section section-alt">
        <div class="container narrow">
          <div class="section-head" data-reveal><h2>${esc(s.home.faqTitle)}</h2></div>
          ${faqList(p.faq)}
        </div>
      </section>`;
  return { path: PAGES.pricing[lang], html: page({ lang, title: p.title, description: p.description, pathname: PAGES.pricing[lang], alternates, assets, body, jsonLd: [faqJsonLd(p.faq)], bodyClass: 'pricing' }), alternates, priority: '0.8' };
}

function legalPage(kind, lang, assets) {
  const L = LEGAL[kind][lang];
  const alternates = alternatesOf(PAGES[kind]);
  const body = `      <section class="section legal">
        <div class="container narrow">
          <h1>${esc(L.title)}</h1>
          <p class="muted">${esc(L.updated)}</p>
          ${L.sections.map((sec) => `<h2>${esc(sec.h)}</h2>${sec.p.map((x) => `<p>${esc(x)}</p>`).join('')}`).join('\n          ')}
        </div>
      </section>`;
  return { path: PAGES[kind][lang], html: page({ lang, title: `${L.title} | %%SITE_NAME%%`, description: L.description, pathname: PAGES[kind][lang], alternates, assets, body, bodyClass: 'legal-page' }), alternates, priority: '0.3', changefreq: 'yearly' };
}

function notFoundPage(assets) {
  const lang = 'vi';
  const s = T.vi.notFound;
  const body = `      <section class="hero hero-small notfound">
        <div class="hero-bg" aria-hidden="true"><span class="blob b1"></span><span class="blob b2"></span><span class="grid-bg"></span></div>
        <div class="container narrow center">
          <div class="nf-code">404</div>
          <h1>${esc(s.title)}</h1>
          <p class="lead">${esc(s.text)}<br /><span class="muted" lang="en">${esc(T.en.notFound.text)}</span></p>
          <div class="btn-row center"><a class="btn btn-primary" href="/">${esc(s.home)}</a><a class="btn btn-outline" href="/en/" lang="en">${esc(T.en.notFound.home)}</a></div>
        </div>
      </section>
      <section class="section pt-0">
        <div class="container"><div class="tools-grid small">${TOOLS.slice(0, 8).map((x) => toolCard(x, lang)).join('')}</div></div>
      </section>`;
  return { path: '/404.html', html: page({ lang, title: `${s.title} | %%SITE_NAME%%`, description: s.text, pathname: '/404.html', alternates: [], assets, body, noindex: true, bodyClass: 'notfound-page' }), index: false };
}

function appPage(assets) {
  return {
    path: '/app/',
    index: false,
    html: `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
    <title>%%SITE_NAME%% – Trình chỉnh sửa PDF</title>
    <meta name="description" content="Chỉnh sửa, chú thích, sắp xếp, gộp và chuyển đổi PDF ngay trên trình duyệt." />
    <link rel="canonical" href="%%SITE_URL%%/app/" />
    <meta name="theme-color" content="#1f2a44" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <script src="/${assets.theme}"></script>
    <link rel="stylesheet" href="/${assets.appCss}" />
    <link rel="modulepreload" href="/${assets.appJs}" />
    <script type="application/json" id="pe-config">%%PUBLIC_CONFIG%%</script>
    %%HEAD_EXTRA%%
  </head>
  <body class="editor">
    <div id="app">
      <div class="boot" aria-busy="true">
        <div class="boot-card">${logoSvg()}<span class="boot-bar"><span></span></span></div>
      </div>
    </div>
    <noscript><div class="noscript">Trình chỉnh sửa cần JavaScript. / The editor needs JavaScript.</div></noscript>
    <div id="print-container" aria-hidden="true"></div>
    <script type="module" src="/${assets.appJs}"></script>
  </body>
</html>
`,
  };
}

function payPage(kind, assets) {
  const strings = { vi: T.vi.pay, en: T.en.pay };
  return {
    path: `/pay/${kind}/`,
    index: false,
    html: `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>%%SITE_NAME%%</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <script src="/${assets.theme}"></script>
    <link rel="stylesheet" href="/${assets.css}" />
    <script type="application/json" id="pe-config">%%PUBLIC_CONFIG%%</script>
    <script type="application/json" id="pay-strings">${JSON.stringify(strings).replace(/</g, '\\u003c')}</script>
  </head>
  <body class="pay-page" data-pay="${kind}">
    <main class="pay-main">
      <div class="pay-card" data-pay-card>
        <a class="brand" href="/">${logoSvg()}<span>%%SITE_NAME%%</span></a>
        <div class="pay-state"><span class="spinner"></span></div>
      </div>
    </main>
    <script type="module" src="/${assets.pay}"></script>
  </body>
</html>
`,
  };
}

function adminPage(assets) {
  return {
    path: '/admin/',
    index: false,
    html: `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Quản trị – %%SITE_NAME%%</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <script src="/${assets.theme}"></script>
    <link rel="stylesheet" href="/${assets.css}" />
  </head>
  <body class="admin-page">
    <header class="admin-header"><div class="container header-inner"><a class="brand" href="/">${logoSvg()}<span>%%SITE_NAME%%</span></a><span class="admin-tag">Quản trị</span><div class="admin-actions" data-admin-actions></div></div></header>
    <main class="container admin-main" id="admin"><noscript>Cần bật JavaScript.</noscript></main>
    <script type="module" src="/${assets.admin}"></script>
  </body>
</html>
`,
  };
}

// ---------------------------------------------------------------------------

export async function buildSite({ root, outdir, manifest: bundles }) {
  const need = (name, kind) => {
    const v = bundles[name] && bundles[name][kind];
    if (!v) throw new Error(`Missing bundle ${name}.${kind}`);
    return v;
  };
  const assets = {
    js: need('site', 'js'),
    css: need('site-styles', 'css'),
    theme: need('theme', 'js'),
    appJs: need('app', 'js'),
    appCss: need('app-styles', 'css'),
    pay: need('pay', 'js'),
    admin: need('admin', 'js'),
  };
  const pages = [];
  for (const lang of LANGS) {
    pages.push(homePage(lang, assets));
    for (const tool of TOOLS) pages.push(toolPage(tool, lang, assets));
    pages.push(pricingPage(lang, assets));
    pages.push(legalPage('privacy', lang, assets));
    pages.push(legalPage('terms', lang, assets));
  }
  pages.push(notFoundPage(assets), appPage(assets), payPage('checkout', assets), payPage('done', assets), adminPage(assets));

  for (const p of pages) {
    const file = p.path.endsWith('/') ? path.join(outdir, p.path, 'index.html') : path.join(outdir, p.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, p.html);
  }

  // Placeholders that must have been filled by the server; anything else
  // left over in a page is a typo.
  const known = new Set(['PUBLIC_CONFIG', 'HEAD_EXTRA', 'SITE_URL', 'SITE_NAME', 'FREE_PAGES', 'CONTACT_EMAIL', 'PRICING_VI', 'PRICING_EN']);
  for (const p of pages) {
    for (const m of p.html.matchAll(/%%([A-Z_]+)%%/g)) if (!known.has(m[1])) throw new Error(`Unknown placeholder %%${m[1]}%% in ${p.path}`);
  }
  void root;
  return pages.map((p) => ({ path: p.path, index: p.index !== false, alternates: p.alternates || [], priority: p.priority, changefreq: p.changefreq }));
}
