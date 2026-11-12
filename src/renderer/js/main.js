// Editor entry point (browser).
import { installWebApi } from '../../web/api.js';
import { App } from './app.js';
import { loadSettings, saveSettings, settings } from './settings.js';
import { setLanguage } from './i18n.js';
import { installTooltips } from './ui/dialogs.js';
import { loadSystemFonts } from './pdf/fonts.js';

async function main() {
  installWebApi({ version: __APP_VERSION__ });
  await loadSettings();
  // Language: ?lang= (set by the landing pages), then the saved choice, then
  // the browser's language.
  const asked = new URLSearchParams(location.search).get('lang');
  let lang = /^(vi|en)$/.test(asked || '') ? asked : settings.language;
  if (!lang) lang = /^vi/i.test(navigator.language || 'vi') ? 'vi' : 'en';
  if (asked && lang !== settings.language) saveSettings({ language: lang });
  setLanguage(lang);
  // Theme: the saved choice, else the system preference.
  const dark = settings.theme ? settings.theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.body.classList.toggle('hide-form-highlight', settings.showFormHighlight === false);
  installTooltips();
  const app = new App(document.getElementById('app'));
  window.__app = app;
  await app.init();
  // Enumerate installed fonts in the background.
  setTimeout(() => loadSystemFonts(), 1500);
}

main().catch((e) => {
  console.error(e);
  document.body.textContent = `Startup error: ${e && e.message ? e.message : e}`;
});
