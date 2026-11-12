import vi from './locales/vi.js';
import en from './locales/en.js';
import { vi as webVi, en as webEn } from '../../web/locales.js';

// The web edition overrides some wording (download instead of save) and adds
// its own strings.
const dicts = { vi: { ...vi, ...webVi }, en: { ...en, ...webEn } };
let lang = 'vi';

export function setLanguage(l) {
  lang = dicts[l] ? l : 'vi';
  document.documentElement.lang = lang;
}

export function getLanguage() {
  return lang;
}

export function t(key, params) {
  let s = dicts[lang][key];
  if (s === undefined) s = dicts.en[key];
  if (s === undefined) s = key;
  if (params) s = s.replace(/\{(\w+)\}/g, (_, k) => (params[k] !== undefined ? params[k] : ''));
  return s;
}

export function hasKey(key) {
  return dicts[lang][key] !== undefined || dicts.en[key] !== undefined;
}

export function errorMessage(err) {
  if (!err) return t('error.unknown');
  if (err.code && dicts[lang][`error.${err.code}`]) return t(`error.${err.code}`, err.params || {});
  if (err.name === 'PasswordException') return t('error.password');
  if (err.name === 'InvalidPDFException') return t('error.invalidPdf');
  return err.message || String(err);
}

export function formatDate(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-US', { dateStyle: 'short', timeStyle: 'short' });
}

export const LANGUAGES = [
  { id: 'vi', label: 'Tiếng Việt' },
  { id: 'en', label: 'English' },
];
