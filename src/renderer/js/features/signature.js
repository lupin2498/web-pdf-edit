// Signatures (draw / type / image) and stamps.
import { h, clear, uid, hexToRgb, rgbToHex } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { openDialog, alertDialog, toast, promptDialog } from '../ui/dialogs.js';
import { prepareImageFile, canvasToBytes } from '../doc/image-tools.js';
import { placeAsset, IMAGE_EXTENSIONS } from './insert.js';
import { settings, saveSettings } from '../settings.js';
import { formatDateToken } from '../../../core/page-marks.js';
import { t, errorMessage } from '../i18n.js';

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function signatureMenu(doc) {
  const saved = settings.signatures || [];
  const items = saved.map((sig) => ({
    label: sig.name || t('signature.saved'),
    icon: 'signature',
    onClick: () => useSignature(doc, sig),
  }));
  if (items.length) items.push({ separator: true });
  items.push({ label: t('signature.create'), icon: 'plus', onClick: () => createSignature(doc) });
  if (saved.length) items.push({ label: t('signature.manage'), icon: 'trash', onClick: () => manageSignatures() });
  return items;
}

function useSignature(doc, sig) {
  if (doc.isReadOnly()) return doc.warnReadOnly();
  const bytes = b64ToBytes(sig.png);
  const asset = doc.session.addAsset(bytes, 'image/png', { width: sig.width, height: sig.height });
  placeAsset(doc, asset, sig.width, sig.height, 'signature', 150);
}

async function manageSignatures() {
  const list = h('div', { class: 'file-list' });
  const render = () => {
    clear(list);
    const sigs = settings.signatures || [];
    if (!sigs.length) list.appendChild(h('div', { class: 'empty-note' }, t('signature.none')));
    sigs.forEach((sig, i) => {
      list.appendChild(
        h(
          'div',
          { class: 'file-row' },
          h('img', { src: `data:image/png;base64,${sig.png}`, style: { height: '36px', maxWidth: '200px', background: '#fff' } }),
          h('span', { class: 'fr-name' }, sig.name || ''),
          h('button', { class: 'icon-btn', onclick: async () => { const next = sigs.slice(); next.splice(i, 1); await saveSettings({ signatures: next }); render(); } }, icon('trash')),
        ),
      );
    });
  };
  render();
  await openDialog({ title: t('signature.manage'), content: [list], buttons: [{ label: t('common.close'), primary: true }] }).promise;
}

function trimCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const pad = 6;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad);
  y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

async function createSignature(doc) {
  const W = 520;
  const H = 180;
  const pad = h('canvas', { class: 'sig-pad', width: W * 2, height: H * 2, style: { width: `${W}px`, height: `${H}px` } });
  const ctx = pad.getContext('2d');
  ctx.scale(2, 2);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  let color = '#1a2a6c';
  let width = 2.4;
  let drawing = false;
  let last = null;
  let hasInk = false;
  pad.addEventListener('pointerdown', (e) => {
    drawing = true;
    pad.setPointerCapture(e.pointerId);
    const r = pad.getBoundingClientRect();
    last = [e.clientX - r.left, e.clientY - r.top];
  });
  pad.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const r = pad.getBoundingClientRect();
    const p = [e.clientX - r.left, e.clientY - r.top];
    ctx.strokeStyle = color;
    ctx.lineWidth = width * (e.pressure && e.pointerType === 'pen' ? 0.5 + e.pressure : 1);
    ctx.beginPath();
    ctx.moveTo(last[0], last[1]);
    ctx.lineTo(p[0], p[1]);
    ctx.stroke();
    last = p;
    hasInk = true;
  });
  pad.addEventListener('pointerup', () => (drawing = false));
  const colorInput = h('input', { type: 'color', value: color });
  colorInput.addEventListener('input', () => (color = colorInput.value));
  const widthInput = h('input', { type: 'range', min: 1, max: 6, step: 0.2, value: width });
  widthInput.addEventListener('input', () => (width = parseFloat(widthInput.value)));
  const clearBtn = h('button', { class: 'btn small', onclick: () => { ctx.clearRect(0, 0, W, H); hasInk = false; } }, t('signature.clear'));
  // Typed signature
  const typed = h('input', { class: 'input', placeholder: t('signature.typePlaceholder'), value: settings.author || '' });
  typed.addEventListener('keydown', (e) => e.stopPropagation());
  // Image signature
  let imageSig = null;
  const imgLabel = h('span', { class: 'hint' }, '');
  const pickImg = h('button', { class: 'btn small', onclick: async () => {
    const p = await window.api.dialog.open({ filters: [{ name: t('filter.images'), extensions: IMAGE_EXTENSIONS }] });
    if (!p.length) return;
    imageSig = await prepareImageFile(await window.api.file.read(p[0]), p[0]);
    imgLabel.textContent = p[0];
  } }, t('marks.chooseImage'));
  const panes = {
    draw: h('div', null, pad, h('div', { class: 'form-inline' }, h('span', null, t('props.color')), colorInput, h('span', null, t('props.width')), widthInput, clearBtn)),
    type: h('div', { class: 'hidden' }, typed, h('div', { class: 'hint' }, t('signature.typeHint'))),
    image: h('div', { class: 'hidden' }, h('div', { class: 'form-inline' }, pickImg, imgLabel)),
  };
  let mode = 'draw';
  const tabs = h('div', { class: 'seg' });
  const renderTabs = () => {
    clear(tabs);
    for (const m of ['draw', 'type', 'image']) {
      tabs.appendChild(h('button', { class: mode === m ? 'active' : '', onclick: () => { mode = m; for (const [k, el] of Object.entries(panes)) el.classList.toggle('hidden', k !== m); renderTabs(); } }, t(`signature.${m}`)));
    }
  };
  renderTabs();
  const save = h('input', { type: 'checkbox', checked: true });
  const res = await openDialog({
    title: t('signature.create'),
    width: 600,
    content: [tabs, panes.draw, panes.type, panes.image, h('label', { class: 'check' }, save, t('signature.remember'))],
    buttons: [
      { label: t('common.cancel'), value: null },
      {
        label: t('common.ok'),
        primary: true,
        onClick: async () => {
          if (mode === 'draw') {
            if (!hasInk) return false;
            const trimmed = trimCanvas(pad);
            if (!trimmed) return false;
            return { bytes: await canvasToBytes(trimmed), width: trimmed.width / 2, height: trimmed.height / 2 };
          }
          if (mode === 'type') {
            const text = typed.value.trim();
            if (!text) return false;
            const c = document.createElement('canvas');
            c.width = 1400;
            c.height = 300;
            const x = c.getContext('2d');
            x.fillStyle = color;
            x.font = 'italic 150px "Liberation Serif", "Times New Roman", serif';
            x.textBaseline = 'middle';
            x.fillText(text, 20, 150);
            const trimmed = trimCanvas(c);
            if (!trimmed) return false;
            return { bytes: await canvasToBytes(trimmed), width: trimmed.width / 3, height: trimmed.height / 3 };
          }
          if (!imageSig) return false;
          return { bytes: imageSig.bytes, mime: imageSig.mime, width: imageSig.width, height: imageSig.height };
        },
      },
    ],
  }).promise;
  if (!res) return;
  const mime = res.mime || 'image/png';
  if (save.checked && mime === 'image/png') {
    const sigs = (settings.signatures || []).slice();
    sigs.unshift({ id: uid('sig'), name: `${t('signature.saved')} ${sigs.length + 1}`, png: bytesToB64(res.bytes), width: res.width, height: res.height });
    await saveSettings({ signatures: sigs.slice(0, 12) });
  }
  const asset = doc.session.addAsset(res.bytes, mime, { width: res.width, height: res.height });
  placeAsset(doc, asset, res.width, res.height, 'signature', 150);
}

// ------------------------------------------------------------------ stamps

const STAMPS = [
  { key: 'approved', color: [0.1, 0.55, 0.2] },
  { key: 'rejected', color: [0.85, 0.12, 0.12] },
  { key: 'draft', color: [0.2, 0.35, 0.8] },
  { key: 'confidential', color: [0.85, 0.12, 0.12] },
  { key: 'final', color: [0.1, 0.55, 0.2] },
  { key: 'reviewed', color: [0.2, 0.35, 0.8] },
  { key: 'signed', color: [0.45, 0.2, 0.7] },
  { key: 'received', color: [0.2, 0.35, 0.8] },
];

let currentStamp = null;

export function getCurrentStamp() {
  return currentStamp;
}

export function stampMenu(doc) {
  const today = formatDateToken(new Date());
  const items = STAMPS.map((st) => ({
    label: t(`stamp.${st.key}`),
    icon: 'stamp',
    onClick: () => chooseStamp(doc, { label: t(`stamp.${st.key}`).toUpperCase(), subLabel: `${settings.author ? settings.author + ' · ' : ''}${today}`, color: st.color, name: st.key }),
  }));
  items.push({ separator: true });
  items.push({ label: t('stamp.custom'), icon: 'edit', onClick: () => customStamp(doc) });
  items.push({ label: t('stamp.fromImage'), icon: 'image', onClick: () => imageStamp(doc) });
  return items;
}

function chooseStamp(doc, stamp) {
  if (doc.isReadOnly()) return doc.warnReadOnly();
  currentStamp = { width: 170, height: stamp.subLabel ? 54 : 44, ...stamp };
  if (doc.mode !== 'view') doc.setMode('view');
  doc.setTool('stamp', { stamp: currentStamp });
  toast(t('stamp.clickToPlace'));
}

async function customStamp(doc) {
  const label = h('input', { class: 'input', value: t('stamp.approved').toUpperCase() });
  const sub = h('input', { class: 'input', value: formatDateToken(new Date()) });
  const color = h('input', { type: 'color', value: rgbToHex([0.85, 0.12, 0.12]) });
  for (const el of [label, sub]) el.addEventListener('keydown', (e) => e.stopPropagation());
  const res = await openDialog({
    title: t('stamp.custom'),
    content: [h('div', { class: 'form-row' }, h('label', null, t('stamp.label')), label), h('div', { class: 'form-row' }, h('label', null, t('stamp.subLabel')), sub), h('div', { class: 'form-inline' }, h('span', null, t('props.color')), color)],
    buttons: [
      { label: t('common.cancel'), value: null },
      { label: t('common.ok'), primary: true, onClick: () => (label.value.trim() ? { label: label.value.trim(), subLabel: sub.value.trim(), color: hexToRgb(color.value) } : false) },
    ],
  }).promise;
  if (res) chooseStamp(doc, { ...res, name: 'Custom' });
}

async function imageStamp(doc) {
  const p = await window.api.dialog.open({ filters: [{ name: t('filter.images'), extensions: IMAGE_EXTENSIONS }] });
  if (!p.length) return;
  try {
    const img = await prepareImageFile(await window.api.file.read(p[0]), p[0]);
    const asset = doc.session.addAsset(img.bytes, img.mime, { width: img.width, height: img.height });
    const w = 150;
    chooseStamp(doc, { asset, width: w, height: (w * img.height) / img.width, name: 'Image' });
  } catch (e) {
    alertDialog(errorMessage(e));
  }
}

export { promptDialog };
