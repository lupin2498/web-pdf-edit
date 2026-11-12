// Reusable form controls for the properties panel and dialogs.
import { h, rgbToHex, hexToRgb } from './dom.js';
import { icon } from './icons.js';
import { t } from '../i18n.js';

export const PALETTE = [
  [0, 0, 0],
  [0.4, 0.4, 0.4],
  [0.75, 0.75, 0.75],
  [1, 1, 1],
  [0.9, 0.1, 0.1],
  [1, 0.5, 0],
  [1, 0.85, 0],
  [0.3, 0.75, 0.2],
  [0, 0.6, 0.55],
  [0.1, 0.45, 0.95],
  [0.2, 0.2, 0.7],
  [0.55, 0.25, 0.85],
  [0.95, 0.4, 0.7],
  [0.55, 0.35, 0.2],
];

export const HIGHLIGHT_PALETTE = [
  [1, 0.92, 0.23],
  [0.6, 0.95, 0.4],
  [0.45, 0.85, 1],
  [1, 0.6, 0.8],
  [1, 0.7, 0.35],
  [0.8, 0.7, 1],
];

function sameColor(a, b) {
  if (!a || !b) return !a && !b;
  return a.every((v, i) => Math.abs(v - b[i]) < 0.01);
}

export function colorSwatches({ value, onChange, allowNone = false, palette = PALETTE }) {
  const wrap = h('div', { class: 'swatches' });
  let current = value;
  const render = () => {
    wrap.innerHTML = '';
    if (allowNone) {
      wrap.appendChild(
        h('button', {
          class: `swatch none ${!current ? 'active' : ''}`,
          title: t('props.noColor'),
          onclick: () => set(null),
        }),
      );
    }
    for (const c of palette) {
      wrap.appendChild(
        h('button', {
          class: `swatch ${sameColor(current, c) ? 'active' : ''}`,
          style: { background: rgbToHex(c) },
          title: rgbToHex(c),
          onclick: () => set(c),
        }),
      );
    }
    const custom = h('input', { type: 'color', class: 'swatch-custom', value: rgbToHex(current || [0, 0, 0]), title: t('props.customColor') });
    custom.addEventListener('input', () => set(hexToRgb(custom.value), true));
    custom.addEventListener('change', () => set(hexToRgb(custom.value)));
    wrap.appendChild(custom);
  };
  const set = (c, live = false) => {
    current = c;
    if (!live) render();
    onChange(c, live);
  };
  render();
  wrap.setValue = (c) => {
    current = c;
    render();
  };
  return wrap;
}

export function numberInput({ value, min = -Infinity, max = Infinity, step = 1, onChange, width = 70, suffix = '' }) {
  const input = h('input', { class: 'input small', type: 'number', value, min: Number.isFinite(min) ? min : undefined, max: Number.isFinite(max) ? max : undefined, step, style: { width: `${width}px` } });
  const commit = () => {
    let v = parseFloat(input.value);
    if (!Number.isFinite(v)) return;
    v = Math.min(max, Math.max(min, v));
    input.value = v;
    onChange(v);
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      commit();
      input.blur();
    }
    e.stopPropagation();
  });
  return suffix ? h('span', { class: 'prop-inline' }, input, h('span', { class: 'hint' }, suffix)) : input;
}

export function slider({ value, min = 0, max = 1, step = 0.05, onChange, format = (v) => `${Math.round(v * 100)}%` }) {
  const label = h('span', { class: 'hint', style: { minWidth: '38px', textAlign: 'right' } }, format(value));
  const input = h('input', { type: 'range', min, max, step, value, style: { flex: 1 } });
  input.addEventListener('input', () => {
    label.textContent = format(parseFloat(input.value));
    onChange(parseFloat(input.value), true);
  });
  input.addEventListener('change', () => onChange(parseFloat(input.value), false));
  return h('div', { class: 'prop-inline' }, input, label);
}

export function segmented({ options, value, onChange, multi = false }) {
  const wrap = h('div', { class: 'seg' });
  let current = value;
  const render = () => {
    wrap.innerHTML = '';
    for (const o of options) {
      const active = multi ? !!(current && current[o.value]) : current === o.value;
      wrap.appendChild(
        h(
          'button',
          {
            class: active ? 'active' : '',
            title: o.title || '',
            'data-tip': o.title || undefined,
            onclick: () => {
              if (multi) {
                current = { ...(current || {}), [o.value]: !active };
              } else {
                current = o.value;
              }
              render();
              onChange(multi ? current : o.value);
            },
          },
          o.icon ? icon(o.icon) : o.label,
        ),
      );
    }
  };
  render();
  return wrap;
}

export function selectInput({ options, value, onChange, width }) {
  const sel = h(
    'select',
    { class: 'input', style: width ? { width: `${width}px` } : { width: '100%' } },
    options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)),
  );
  sel.addEventListener('change', () => onChange(sel.value));
  sel.addEventListener('keydown', (e) => e.stopPropagation());
  return sel;
}

export function propRow(label, control) {
  return h('div', { class: 'prop-row' }, h('label', null, label), control);
}

export function checkbox(label, checked, onChange) {
  const input = h('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'check' }, input, h('span', null, label));
}
