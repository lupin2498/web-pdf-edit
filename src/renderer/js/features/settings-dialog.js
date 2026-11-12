// Settings and About dialogs.
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { openDialog, confirmDialog } from '../ui/dialogs.js';
import { settings, saveSettings } from '../settings.js';
import { t, getLanguage, LANGUAGES } from '../i18n.js';

export async function open(app) {
  const lang = h('select', { class: 'input' }, LANGUAGES.map((l) => h('option', { value: l.id, selected: l.id === getLanguage() }, l.label)));
  const isDark = document.documentElement.dataset.theme === 'dark';
  const theme = h('select', { class: 'input' }, h('option', { value: 'light', selected: !isDark }, t('settings.light')), h('option', { value: 'dark', selected: isDark }, t('settings.dark')));
  const author = h('input', { class: 'input', value: settings.author || '' });
  author.addEventListener('keydown', (e) => e.stopPropagation());
  const keepRecent = h('input', { type: 'checkbox', checked: settings.keepRecent !== false });
  const res = await openDialog({
    title: t('settings.title'),
    content: [
      h('div', { class: 'form-row' }, h('label', null, t('settings.language')), lang),
      h('div', { class: 'form-row' }, h('label', null, t('settings.theme')), theme),
      h('div', { class: 'form-row' }, h('label', null, t('settings.author')), author, h('div', { class: 'hint' }, t('settings.authorHint'))),
      h('label', { class: 'check' }, keepRecent, t('settings.keepRecent')),
      h('div', { class: 'hint' }, t('settings.keepRecentHint')),
    ],
    buttons: [
      { label: t('common.cancel'), value: null },
      { label: t('common.ok'), primary: true, onClick: () => ({ language: lang.value, theme: theme.value, author: author.value.trim(), keepRecent: keepRecent.checked }) },
    ],
  }).promise;
  if (!res) return;
  const { language, ...rest } = res;
  await saveSettings(rest);
  document.documentElement.dataset.theme = res.theme === 'dark' ? 'dark' : 'light';
  if (app.themeBtn) {
    app.themeBtn.replaceChildren(icon(res.theme === 'dark' ? 'sun' : 'moon'));
  }
  if (!res.keepRecent) {
    await window.api.recent.clear();
    app.refreshRecent();
  }
  await changeLanguage(app, language);
}

// Switching the language rebuilds the interface, which needs a reload; open
// documents are closed first (asking about changes that were not downloaded).
export async function changeLanguage(app, language) {
  if (language === getLanguage()) return;
  const hasDocs = app.tabs.some((tb) => tb.kind === 'doc');
  if (hasDocs && !(await confirmDialog(t('settings.reloadConfirm')))) return;
  for (const tb of [...app.tabs]) if (tb.kind === 'doc' && !(await app.closeTab(tb))) return;
  await saveSettings({ language });
  app.skipLeaveGuard = true;
  location.reload();
}

export async function about(app) {
  const info = app.info || {};
  await openDialog({
    title: t('about.title'),
    content: [
      h('div', { class: 'form-inline' }, icon('logo'), h('b', { style: { fontSize: '18px' } }, t('app.name')), h('span', { class: 'hint' }, `v${info.version || ''}`)),
      h('div', null, t('about.description')),
      h('div', { class: 'hint' }, t('about.licenses')),
      h('div', { class: 'hint' }, 'pdf.js (Apache-2.0) · pdf-lib / @cantoo/pdf-lib (MIT) · fontkit (MIT) · fflate (MIT) · qrcode-generator (MIT) · Liberation Fonts (SIL OFL 1.1) · Be Vietnam Pro (SIL OFL 1.1)'),
    ],
    buttons: [{ label: t('common.close'), primary: true }],
  }).promise;
}
