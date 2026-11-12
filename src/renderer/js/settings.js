// Persistent user settings (kept in the browser's localStorage).
export const settings = {
  author: '',
  // Empty = not chosen yet (the browser's language / system theme is used).
  language: '',
  theme: '',
  defaultZoom: 'auto',
  showFormHighlight: true,
  recentSignatures: [],
  keepRecent: true,
};

export async function loadSettings() {
  try {
    const s = await window.api.settings.get();
    Object.assign(settings, s || {});
  } catch {
    /* defaults */
  }
  return settings;
}

export async function saveSettings(patch) {
  Object.assign(settings, patch);
  try {
    await window.api.settings.set(patch);
  } catch {
    /* ignore */
  }
}
