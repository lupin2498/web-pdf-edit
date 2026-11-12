// Watermark, background, header & footer and Bates numbering dialogs.
import { h, uid, basename, rgbToHex, hexToRgb } from '../ui/dom.js';
import { openDialog, alertDialog, toast, confirmDialog } from '../ui/dialogs.js';
import { registry } from '../pdf/fonts.js';
import { prepareImageFile } from '../doc/image-tools.js';
import { parsePageRanges } from '../../../core/page-ranges.js';
import { IMAGE_EXTENSIONS } from './insert.js';
import { t, errorMessage } from '../i18n.js';

const SUBTYPES = { watermark: ['Watermark'], background: ['Background'], headerFooter: ['Header', 'Footer'], bates: ['BatesN'] };

export function menu(doc, kind) {
  return [
    { label: t(`marks.add.${kind}`), icon: 'plus', onClick: () => openMarkDialog(doc, kind) },
    { label: t(`marks.remove.${kind}`), icon: 'trash', onClick: () => removeMarks(doc, kind) },
  ];
}

function pagesControl(doc) {
  const scope = h('select', { class: 'input' }, h('option', { value: 'all' }, t('crop.all')), h('option', { value: 'current' }, t('crop.current')), h('option', { value: 'range' }, t('crop.range')));
  const range = h('input', { class: 'input', placeholder: '1-3, 5', disabled: true });
  scope.addEventListener('change', () => (range.disabled = scope.value !== 'range'));
  const el = h('div', { class: 'form-grid' }, h('div', { class: 'form-row' }, h('label', null, t('marks.pages')), scope), h('div', { class: 'form-row' }, h('label', null, t('page.range')), range));
  const resolve = () => {
    const pages = doc.session.state.pages;
    if (scope.value === 'all') return pages.map((p) => p.uid);
    if (scope.value === 'current') return [pages[doc.viewer.currentIndex].uid];
    return parsePageRanges(range.value, pages.length).map((i) => pages[i].uid);
  };
  return { el, resolve };
}

function fontSelect(value = 'Liberation Sans') {
  const families = registry.listFamilies();
  return h('select', { class: 'input' }, families.map((f) => h('option', { value: f.family, selected: f.family === value }, f.family)));
}

function colorInput(rgb) {
  return h('input', { type: 'color', class: 'input', value: rgbToHex(rgb), style: { padding: '2px', width: '60px' } });
}

function row(label, control) {
  return h('div', { class: 'form-row' }, h('label', null, label), control);
}

async function openMarkDialog(doc, kind) {
  if (doc.isReadOnly()) return doc.warnReadOnly();
  const pages = pagesControl(doc);
  let content;
  let collect;
  if (kind === 'watermark') {
    const type = h('select', { class: 'input' }, h('option', { value: 'text' }, t('marks.text')), h('option', { value: 'image' }, t('marks.image')));
    const text = h('textarea', { class: 'input', rows: 2 }, t('marks.defaultWatermark'));
    const font = fontSelect();
    const bold = h('input', { type: 'checkbox', checked: true });
    const size = h('input', { class: 'input', type: 'number', min: 6, max: 300, value: 60 });
    const color = colorInput([0.85, 0.15, 0.15]);
    const opacity = h('input', { type: 'range', min: 5, max: 100, value: 30 });
    const angle = h('input', { class: 'input', type: 'number', min: -180, max: 180, value: 45 });
    const position = h('select', { class: 'input' }, ['center', 'top', 'bottom', 'tl', 'tr', 'bl', 'br'].map((p) => h('option', { value: p }, t(`marks.pos.${p}`))));
    const layer = h('select', { class: 'input' }, h('option', { value: 'over' }, t('marks.layerOver')), h('option', { value: 'under' }, t('marks.layerUnder')));
    const scale = h('input', { class: 'input', type: 'number', min: 5, max: 500, value: 100 });
    let image = null;
    const imgName = h('span', { class: 'hint' }, t('marks.noImage'));
    const pick = h('button', { class: 'btn small', onclick: async () => {
      const p = await window.api.dialog.open({ filters: [{ name: t('filter.images'), extensions: IMAGE_EXTENSIONS }] });
      if (!p.length) return;
      image = await prepareImageFile(await window.api.file.read(p[0]), p[0]);
      imgName.textContent = basename(p[0]);
    } }, t('marks.chooseImage'));
    const textBox = h('div', null, row(t('marks.text'), text), h('div', { class: 'form-grid three' }, row(t('props.font'), font), row(t('props.size'), size), row(t('props.color'), color)), h('label', { class: 'check' }, bold, t('props.bold')));
    const imageBox = h('div', { class: 'hidden' }, h('div', { class: 'form-inline' }, pick, imgName), row(t('marks.scale'), scale));
    type.addEventListener('change', () => {
      textBox.classList.toggle('hidden', type.value !== 'text');
      imageBox.classList.toggle('hidden', type.value !== 'image');
    });
    content = [row(t('marks.type'), type), textBox, imageBox, h('div', { class: 'form-grid three' }, row(t('marks.opacity'), opacity), row(t('marks.angle'), angle), row(t('marks.position'), position)), row(t('marks.layer'), layer), pages.el];
    collect = () => {
      const base = { type: 'watermark', opacity: parseInt(opacity.value, 10) / 100, angle: parseFloat(angle.value) || 0, position: position.value, layer: layer.value };
      if (type.value === 'image') {
        if (!image) throw new Error(t('marks.noImage'));
        const asset = doc.session.addAsset(image.bytes, image.mime, { width: image.width, height: image.height });
        const s = (parseFloat(scale.value) || 100) / 100;
        return { ...base, asset, imageWidth: (image.width * 72) / 96, imageHeight: (image.height * 72) / 96, scale: s };
      }
      if (!text.value.trim()) throw new Error(t('marks.emptyText'));
      return { ...base, text: text.value, font: { family: font.value, bold: bold.checked }, size: parseFloat(size.value) || 60, color: hexToRgb(color.value) };
    };
  } else if (kind === 'background') {
    const color = colorInput([0.95, 0.95, 0.85]);
    const opacity = h('input', { type: 'range', min: 5, max: 100, value: 100 });
    let image = null;
    const imgName = h('span', { class: 'hint' }, t('marks.noImage'));
    const pick = h('button', { class: 'btn small', onclick: async () => {
      const p = await window.api.dialog.open({ filters: [{ name: t('filter.images'), extensions: IMAGE_EXTENSIONS }] });
      if (!p.length) return;
      image = await prepareImageFile(await window.api.file.read(p[0]), p[0]);
      imgName.textContent = basename(p[0]);
    } }, t('marks.chooseImage'));
    content = [h('div', { class: 'form-grid' }, row(t('marks.color'), color), row(t('marks.opacity'), opacity)), h('div', { class: 'form-inline' }, pick, imgName), pages.el];
    collect = () => {
      const base = { type: 'background', opacity: parseInt(opacity.value, 10) / 100, color: hexToRgb(color.value) };
      if (image) base.asset = doc.session.addAsset(image.bytes, image.mime, { width: image.width, height: image.height });
      return base;
    };
  } else if (kind === 'headerFooter') {
    const slot = (name, value = '') => {
      const input = h('input', { class: 'input', value, placeholder: t(`marks.slot.${name}`) });
      input.addEventListener('keydown', (e) => e.stopPropagation());
      return input;
    };
    const slots = { tl: slot('tl'), tc: slot('tc'), tr: slot('tr'), bl: slot('bl'), bc: slot('bc', t('marks.defaultFooter')), br: slot('br') };
    const font = fontSelect();
    const size = h('input', { class: 'input', type: 'number', min: 5, max: 72, value: 10 });
    const color = colorInput([0, 0, 0]);
    const marginTB = h('input', { class: 'input', type: 'number', min: 0, max: 200, value: 10 });
    const marginLR = h('input', { class: 'input', type: 'number', min: 0, max: 200, value: 15 });
    const start = h('input', { class: 'input', type: 'number', min: 0, max: 100000, value: 1 });
    content = [
      h('div', { class: 'hint' }, t('marks.tokensHint')),
      h('div', { class: 'form-grid three' }, row(t('marks.slot.tl'), slots.tl), row(t('marks.slot.tc'), slots.tc), row(t('marks.slot.tr'), slots.tr)),
      h('div', { class: 'form-grid three' }, row(t('marks.slot.bl'), slots.bl), row(t('marks.slot.bc'), slots.bc), row(t('marks.slot.br'), slots.br)),
      h('div', { class: 'form-grid three' }, row(t('props.font'), font), row(t('props.size'), size), row(t('props.color'), color)),
      h('div', { class: 'form-grid three' }, row(t('marks.marginTB'), marginTB), row(t('marks.marginLR'), marginLR), row(t('marks.startNumber'), start)),
      pages.el,
    ];
    collect = () => {
      const mm = 72 / 25.4;
      const tb = (parseFloat(marginTB.value) || 0) * mm;
      const lr = (parseFloat(marginLR.value) || 0) * mm;
      const s = {};
      for (const [k, el] of Object.entries(slots)) if (el.value.trim()) s[k] = el.value;
      if (!Object.keys(s).length) throw new Error(t('marks.emptyText'));
      return { type: 'headerFooter', slots: s, font: { family: font.value }, size: parseFloat(size.value) || 10, color: hexToRgb(color.value), margins: { top: tb, bottom: tb, left: lr, right: lr }, startNumber: parseInt(start.value, 10) || 1 };
    };
  } else {
    const prefix = h('input', { class: 'input', value: 'PE' });
    const suffix = h('input', { class: 'input', value: '' });
    const digits = h('input', { class: 'input', type: 'number', min: 3, max: 12, value: 6 });
    const start = h('input', { class: 'input', type: 'number', min: 1, value: 1 });
    const slot = h('select', { class: 'input' }, ['br', 'bc', 'bl', 'tr', 'tc', 'tl'].map((s) => h('option', { value: s }, t(`marks.slot.${s}`))));
    const size = h('input', { class: 'input', type: 'number', min: 5, max: 72, value: 10 });
    const color = colorInput([0, 0, 0]);
    for (const el of [prefix, suffix]) el.addEventListener('keydown', (e) => e.stopPropagation());
    content = [
      h('div', { class: 'form-grid' }, row(t('marks.prefix'), prefix), row(t('marks.suffix'), suffix)),
      h('div', { class: 'form-grid three' }, row(t('marks.digits'), digits), row(t('marks.startNumber'), start), row(t('marks.position'), slot)),
      h('div', { class: 'form-grid' }, row(t('props.size'), size), row(t('props.color'), color)),
      pages.el,
    ];
    collect = () => ({ type: 'bates', prefix: prefix.value, suffix: suffix.value, digits: parseInt(digits.value, 10) || 6, start: parseInt(start.value, 10) || 1, slot: slot.value, font: { family: 'Liberation Sans' }, size: parseFloat(size.value) || 10, color: hexToRgb(color.value), margins: { top: 20, bottom: 20, left: 30, right: 30 } });
  }
  const res = await openDialog({
    title: t(`marks.add.${kind}`),
    width: 640,
    content,
    buttons: [
      { label: t('common.cancel'), value: null },
      {
        label: t('common.apply'),
        primary: true,
        onClick: () => {
          try {
            return { obj: collect(), uids: pages.resolve() };
          } catch (e) {
            alertDialog(errorMessage(e));
            return false;
          }
        },
      },
    ],
  }).promise;
  if (!res || !res.uids.length) return;
  const groupId = uid('g');
  const set = new Set(res.uids);
  // Bates numbers continue across the selected pages in order.
  let counter = 0;
  doc.session.update(`add_${kind}`, (s) => {
    s.pages.forEach((p, i) => {
      if (!set.has(p.uid)) return;
      p.objects = p.objects || [];
      const obj = { ...structuredClone(res.obj), id: uid('o'), groupId };
      if (kind === 'bates') {
        obj.start = res.obj.start + counter - i;
        counter++;
      }
      p.objects.push(obj);
    });
  });
  toast(t('marks.added', { n: res.uids.length }), { type: 'success' });
}

async function removeMarks(doc, kind) {
  if (doc.isReadOnly()) return doc.warnReadOnly();
  const ok = await confirmDialog(t('marks.removeConfirm', { what: t(`marks.${kind}`) }));
  if (!ok) return;
  const type = kind;
  doc.session.update(`remove_${kind}`, (s) => {
    for (const p of s.pages) {
      p.objects = (p.objects || []).filter((o) => o.type !== type);
      if (p.src) {
        p.removals = p.removals || [];
        if (!p.removals.some((r) => r.kind === 'artifact' && JSON.stringify(r.subtypes) === JSON.stringify(SUBTYPES[kind]))) {
          p.removals.push({ id: uid('r'), kind: 'artifact', subtypes: SUBTYPES[kind] });
        }
      }
    }
  });
  toast(t('marks.removed'), { type: 'success' });
}
