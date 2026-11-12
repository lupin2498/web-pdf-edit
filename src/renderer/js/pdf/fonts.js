// Font registry for the renderer: bundled fonts + system fonts, plus CSS
// FontFace registration so on-screen text uses exactly the embedded faces.
import { FontRegistry, BUNDLED_FAMILIES } from '../../../core/fonts.js';

const FONT_BASE = new URL(__FONT_BASE__, document.baseURI).href;

export const registry = new FontRegistry(async (d) => {
  if (d.source === 'bundled') {
    const res = await fetch(FONT_BASE + d.file);
    if (!res.ok) throw new Error(`Font ${d.file} not found`);
    return new Uint8Array(await res.arrayBuffer());
  }
  return window.api.fonts.read(d.file);
});

const cssNames = new Map();
const cssPending = new Map();
let counter = 0;

export function cssNameFor(descriptor) {
  if (!cssNames.has(descriptor.id)) cssNames.set(descriptor.id, `pe-font-${++counter}`);
  return cssNames.get(descriptor.id);
}

export async function ensureCssFace(descriptor) {
  const name = cssNameFor(descriptor);
  if (cssPending.has(descriptor.id)) return cssPending.get(descriptor.id);
  const p = (async () => {
    const bytes = await registry.getBytes(descriptor);
    const face = new FontFace(name, bytes);
    await face.load();
    document.fonts.add(face);
    return name;
  })();
  cssPending.set(descriptor.id, p);
  return p;
}

let systemLoaded = null;
export function loadSystemFonts() {
  if (!systemLoaded) {
    systemLoaded = (async () => {
      try {
        const list = await window.api.fonts.list();
        registry.addSystemFonts(list);
      } catch (e) {
        console.warn('system fonts unavailable', e);
      }
    })();
  }
  return systemLoaded;
}

// Shaper cache: shapers are keyed by face and text content.
const shaperCache = new Map();
export async function getShaper(font = {}, text = '') {
  const key = `${font.family || ''}|${!!font.bold}|${!!font.italic}|${text}`;
  if (shaperCache.has(key)) return shaperCache.get(key);
  const shaper = await registry.getShaper(font.family, !!font.bold, !!font.italic, text);
  await Promise.all(shaper.faces.map((f) => ensureCssFace(f.descriptor)));
  if (shaperCache.size > 400) shaperCache.clear();
  shaperCache.set(key, shaper);
  return shaper;
}

export function getShaperSync(font = {}, text = '') {
  return shaperCache.get(`${font.family || ''}|${!!font.bold}|${!!font.italic}|${text}`) || null;
}

export function bundledFamilies() {
  return BUNDLED_FAMILIES.map((f) => f.family);
}
