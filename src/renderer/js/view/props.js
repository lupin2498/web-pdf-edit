// Right-hand properties panel: styles of the selected object or active tool.
import { h, clear, keepPlainKeys } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { colorSwatches, numberInput, slider, segmented, selectInput, propRow, PALETTE, HIGHLIGHT_PALETTE, checkbox } from '../ui/controls.js';
import { registry } from '../pdf/fonts.js';
import { settings, saveSettings } from '../settings.js';
import { t } from '../i18n.js';

export const DEFAULT_STYLES = {
  highlight: { color: [1, 0.92, 0.23], opacity: 0.5 },
  underline: { color: [0.1, 0.6, 0.2], opacity: 1 },
  strikeout: { color: [0.9, 0.1, 0.1], opacity: 1 },
  squiggly: { color: [0.1, 0.45, 0.95], opacity: 1 },
  note: { color: [1, 0.82, 0.2] },
  freetext: { font: { family: 'Liberation Sans', bold: false, italic: false }, size: 12, color: [0, 0, 0], border: [0.9, 0.1, 0.1], fill: null, align: 'left' },
  addText: { font: { family: 'Liberation Sans', bold: false, italic: false }, size: 12, color: [0, 0, 0], align: 'left' },
  rect: { stroke: [0.9, 0.1, 0.1], fill: null, width: 2, opacity: 1, dash: false },
  ellipse: { stroke: [0.9, 0.1, 0.1], fill: null, width: 2, opacity: 1, dash: false },
  line: { stroke: [0.9, 0.1, 0.1], width: 2, opacity: 1, dash: false },
  arrow: { stroke: [0.9, 0.1, 0.1], width: 2, opacity: 1, endHead: 'OpenArrow', dash: false },
  polyline: { stroke: [0.9, 0.1, 0.1], width: 2, opacity: 1 },
  polygon: { stroke: [0.9, 0.1, 0.1], fill: null, width: 2, opacity: 1 },
  ink: { stroke: [0.9, 0.1, 0.1], width: 2, opacity: 1 },
};

const ANNOT_WITH_CONTENTS = new Set(['note', 'highlight', 'underline', 'strikeout', 'squiggly', 'rect', 'ellipse', 'line', 'arrow', 'polyline', 'polygon', 'ink', 'stamp', 'signature', 'freetext']);

export function toolStyle(tool) {
  const saved = (settings.toolStyles || {})[tool] || {};
  return { ...(DEFAULT_STYLES[tool] || {}), ...saved };
}

export class PropertiesPanel {
  constructor(docView) {
    this.docView = docView;
    this.title = h('span', null, t('props.title'));
    this.body = h('div', { class: 'props-body' });
    this.el = h('div', { class: 'props-panel' }, h('div', { class: 'panel-header' }, this.title, h('div', { class: 'ph-actions' }, h('button', { class: 'icon-btn', 'data-tip': t('props.hide'), onclick: () => this.docView.toggleProps(false) }, icon('panelRight')))), this.body);
  }

  get session() {
    return this.docView.session;
  }

  update() {
    const overlay = this.docView.overlay;
    const editMode = this.docView.editMode;
    clear(this.body);
    const obj = overlay.selectedObject();
    if (obj) return this.renderObject(obj);
    if (overlay.selection && overlay.selection.kind === 'annot') return this.renderAnnot(overlay.selection);
    if (editMode.active && editMode.selectedImage) return this.renderEditImage();
    const tool = this.docView.tools.tool;
    if (DEFAULT_STYLES[tool]) return this.renderTool(tool);
    this.title.textContent = t('props.title');
    const hint = editMode.active ? t('props.editHint') : t('props.emptyHint');
    this.body.appendChild(h('div', { class: 'props-empty' }, hint));
    if (editMode.active) {
      this.body.appendChild(propRow(t('edit.mode'), segmented({ options: [{ value: false, label: t('edit.paragraph') }, { value: true, label: t('edit.line') }], value: editMode.lineMode, onChange: (v) => editMode.setLineMode(v) })));
    }
  }

  // ------------------------------------------------------------------ tool defaults

  renderTool(tool) {
    this.title.textContent = t('props.toolDefaults');
    const style = toolStyle(tool);
    const save = (patch) => {
      const all = { ...(settings.toolStyles || {}) };
      all[tool] = { ...(all[tool] || {}), ...patch };
      saveSettings({ toolStyles: all });
    };
    this.buildControls(tool, style, (patch) => save(patch), { isTool: true });
  }

  // ------------------------------------------------------------------ objects

  renderObject(obj) {
    this.title.textContent = t(`obj.${obj.type}`) || t('props.title');
    const apply = (patch, live) => {
      if (live) return;
      const current = this.docView.overlay.selectedObject();
      if (!current) return;
      this.session.updateObject(current.id, patch, 'style');
      const updated = this.docView.overlay.selectedObject();
      if (updated) this.docView.overlay.applyEditorStyle(updated);
    };
    this.buildControls(obj.type, obj, apply, { obj });
    if (ANNOT_WITH_CONTENTS.has(obj.type) && obj.type !== 'freetext') {
      const ta = h('textarea', { class: 'input', rows: 4, placeholder: t('props.commentPlaceholder') }, obj.contents || '');
      ta.addEventListener('keydown', keepPlainKeys);
      ta.addEventListener('change', () => apply({ contents: ta.value }));
      this.body.appendChild(propRow(t('props.comment'), ta));
    }
    if (obj.type === 'link') this.renderLinkProps(obj, apply);
    if (obj.type === 'redact') {
      this.body.appendChild(propRow(t('redact.overlayText'), this.textInput(obj.overlayText || '', (v) => apply({ overlayText: v }))));
      this.body.appendChild(h('button', { class: 'btn primary', onclick: () => this.docView.applyRedactions() }, icon('redactApply'), t('redact.apply')));
    }
    if (obj.type === 'image' || obj.type === 'signature' || obj.type === 'stamp') {
      this.body.appendChild(
        propRow(
          t('props.rotate'),
          h(
            'div',
            { class: 'prop-inline' },
            h('button', { class: 'btn small', onclick: () => this.docView.rotateObject(obj.id, -90) }, icon('rotateLeft')),
            h('button', { class: 'btn small', onclick: () => this.docView.rotateObject(obj.id, 90) }, icon('rotateRight')),
          ),
        ),
      );
      if (obj.type === 'image') this.body.appendChild(h('button', { class: 'btn', onclick: () => this.docView.replaceObjectImage(obj.id) }, icon('replace'), t('edit.replaceImage')));
    }
    this.body.appendChild(
      h(
        'div',
        { class: 'prop-inline', style: { marginTop: '4px' } },
        h('button', { class: 'btn small', onclick: () => this.docView.duplicateSelection() }, icon('copy'), t('common.duplicate')),
        h('button', { class: 'btn small danger', onclick: () => this.docView.deleteSelection() }, icon('trash'), t('common.delete')),
      ),
    );
  }

  textInput(value, onCommit) {
    const input = h('input', { class: 'input', value });
    input.addEventListener('keydown', keepPlainKeys);
    input.addEventListener('change', () => onCommit(input.value));
    return input;
  }

  renderLinkProps(obj, apply) {
    const kind = obj.action?.type || 'url';
    const urlInput = this.textInput(obj.action?.url || '', (v) => apply({ action: { type: 'url', url: v } }));
    const pages = this.session.state.pages;
    const pageIdx = obj.action?.pageUid ? pages.findIndex((p) => p.uid === obj.action.pageUid) : 0;
    const pageInput = numberInput({ value: Math.max(1, pageIdx + 1), min: 1, max: pages.length, onChange: (v) => apply({ action: { type: 'page', pageUid: pages[v - 1]?.uid } }) });
    this.body.appendChild(propRow(t('link.type'), segmented({ options: [{ value: 'url', label: t('link.url') }, { value: 'page', label: t('link.page') }], value: kind, onChange: (v) => apply({ action: v === 'url' ? { type: 'url', url: obj.action?.url || 'https://' } : { type: 'page', pageUid: pages[0].uid } }) })));
    this.body.appendChild(propRow(kind === 'url' ? t('link.url') : t('link.page'), kind === 'url' ? urlInput : pageInput));
  }

  buildControls(type, style, apply, { obj = null, isTool = false } = {}) {
    const B = this.body;
    const isText = type === 'text' || type === 'addText' || type === 'freetext';
    if (isText) {
      const families = registry.listFamilies();
      const fam = style.font?.family || 'Liberation Sans';
      if (!families.find((f) => f.family === fam)) families.unshift({ family: fam });
      B.appendChild(propRow(t('props.font'), selectInput({ options: families.map((f) => ({ value: f.family, label: f.family })), value: fam, onChange: (v) => apply({ font: { ...(style.font || {}), family: v } }) })));
      const sizeRow = h(
        'div',
        { class: 'prop-inline' },
        numberInput({ value: style.size || 12, min: 2, max: 400, step: 0.5, onChange: (v) => apply({ size: v }) }),
        segmented({
          multi: true,
          options: [
            { value: 'bold', icon: 'bold', title: t('props.bold') },
            { value: 'italic', icon: 'italic', title: t('props.italic') },
            { value: 'underline', icon: 'underline', title: t('props.underline') },
            { value: 'strike', icon: 'strike', title: t('props.strike') },
          ],
          value: { bold: !!style.font?.bold, italic: !!style.font?.italic, underline: !!style.underline, strike: !!style.strike },
          onChange: (v) => apply({ font: { ...(style.font || {}), bold: !!v.bold, italic: !!v.italic }, underline: !!v.underline, strike: !!v.strike }),
        }),
      );
      B.appendChild(propRow(t('props.size'), sizeRow));
      B.appendChild(propRow(t('props.textColor'), colorSwatches({ value: style.color || [0, 0, 0], onChange: (c, live) => apply({ color: c }, live) })));
      B.appendChild(
        propRow(
          t('props.align'),
          segmented({
            options: [
              { value: 'left', icon: 'alignLeft', title: t('props.alignLeft') },
              { value: 'center', icon: 'alignCenter', title: t('props.alignCenter') },
              { value: 'right', icon: 'alignRight', title: t('props.alignRight') },
            ],
            value: style.align || 'left',
            onChange: (v) => apply({ align: v }),
          }),
        ),
      );
      if (type !== 'freetext' || obj) {
        B.appendChild(propRow(t('props.lineHeight'), selectInput({ options: ['1', '1.15', '1.2', '1.4', '1.5', '2'].map((v) => ({ value: v, label: v })), value: String(style.lineHeight || 1.2), onChange: (v) => apply({ lineHeight: parseFloat(v) }) })));
      }
      if (type === 'freetext') {
        B.appendChild(propRow(t('props.borderColor'), colorSwatches({ value: style.border, allowNone: true, onChange: (c, live) => apply({ border: c }, live) })));
        B.appendChild(propRow(t('props.fillColor'), colorSwatches({ value: style.fill, allowNone: true, onChange: (c, live) => apply({ fill: c }, live) })));
      }
      if (obj) B.appendChild(propRow(t('props.opacity'), slider({ value: style.opacity ?? 1, min: 0.1, max: 1, onChange: (v, live) => apply({ opacity: v }, live) })));
      return;
    }
    if (['highlight', 'underline', 'strikeout', 'squiggly'].includes(type)) {
      B.appendChild(propRow(t('props.color'), colorSwatches({ value: style.color, palette: type === 'highlight' ? [...HIGHLIGHT_PALETTE, ...PALETTE.slice(4, 8)] : PALETTE, onChange: (c, live) => apply({ color: c }, live) })));
      B.appendChild(propRow(t('props.opacity'), slider({ value: style.opacity ?? 1, min: 0.1, max: 1, onChange: (v, live) => apply({ opacity: v }, live) })));
      return;
    }
    if (type === 'note') {
      B.appendChild(propRow(t('props.color'), colorSwatches({ value: style.color, palette: [...HIGHLIGHT_PALETTE, ...PALETTE.slice(4, 10)], onChange: (c, live) => apply({ color: c }, live) })));
      return;
    }
    if (['rect', 'ellipse', 'line', 'arrow', 'polyline', 'polygon', 'ink'].includes(type)) {
      B.appendChild(propRow(t('props.strokeColor'), colorSwatches({ value: style.stroke, allowNone: type === 'rect' || type === 'ellipse' || type === 'polygon', onChange: (c, live) => apply({ stroke: c }, live) })));
      if (type === 'rect' || type === 'ellipse' || type === 'polygon') {
        B.appendChild(propRow(t('props.fillColor'), colorSwatches({ value: style.fill, allowNone: true, onChange: (c, live) => apply({ fill: c }, live) })));
      }
      B.appendChild(propRow(t('props.width'), slider({ value: style.width ?? 2, min: 0.5, max: 20, step: 0.5, format: (v) => `${v} pt`, onChange: (v, live) => apply({ width: v }, live) })));
      B.appendChild(propRow(t('props.opacity'), slider({ value: style.opacity ?? 1, min: 0.1, max: 1, onChange: (v, live) => apply({ opacity: v }, live) })));
      if (type !== 'ink' && type !== 'polyline' && type !== 'polygon') B.appendChild(checkbox(t('props.dashed'), !!style.dash, (v) => apply({ dash: v })));
      if (type === 'line' || type === 'arrow') {
        const heads = ['None', 'OpenArrow', 'ClosedArrow'].map((v) => ({ value: v, label: t(`props.head.${v}`) }));
        B.appendChild(propRow(t('props.startHead'), selectInput({ options: heads, value: style.startHead || 'None', onChange: (v) => apply({ startHead: v }) })));
        B.appendChild(propRow(t('props.endHead'), selectInput({ options: heads, value: style.endHead || (type === 'arrow' ? 'OpenArrow' : 'None'), onChange: (v) => apply({ endHead: v }) })));
      }
      return;
    }
    if (type === 'stamp' && obj && !obj.asset) {
      B.appendChild(propRow(t('stamp.label'), this.textInput(obj.label || '', (v) => apply({ label: v }))));
      B.appendChild(propRow(t('stamp.subLabel'), this.textInput(obj.subLabel || '', (v) => apply({ subLabel: v }))));
      B.appendChild(propRow(t('props.color'), colorSwatches({ value: obj.color, onChange: (c, live) => apply({ color: c }, live) })));
    }
    if ((type === 'image' || type === 'signature' || type === 'stamp' || type === 'whiteout') && obj) {
      B.appendChild(propRow(t('props.opacity'), slider({ value: obj.opacity ?? 1, min: 0.1, max: 1, onChange: (v, live) => apply({ opacity: v }, live) })));
    }
    if (type === 'whiteout' && obj) {
      B.appendChild(propRow(t('props.fillColor'), colorSwatches({ value: obj.fill || [1, 1, 1], onChange: (c, live) => apply({ fill: c }, live) })));
    }
  }

  renderAnnot(sel) {
    const a = sel.annot;
    this.title.textContent = t('props.existingAnnot');
    const page = this.session.page(sel.pageUid);
    const edit = (page && page.annotEdits && page.annotEdits[a.id]) || {};
    this.body.appendChild(propRow(t('props.type'), h('div', null, a.subtype)));
    if (a.titleObj && a.titleObj.str) this.body.appendChild(propRow(t('props.author'), h('div', null, a.titleObj.str)));
    const ta = h('textarea', { class: 'input', rows: 5 }, edit.contents ?? a.contentsObj?.str ?? '');
    ta.addEventListener('keydown', keepPlainKeys);
    ta.addEventListener('change', () => this.docView.setAnnotEdit(sel.pageUid, a.id, { contents: ta.value }));
    this.body.appendChild(propRow(t('props.comment'), ta));
    this.body.appendChild(h('button', { class: 'btn small danger', onclick: () => this.docView.deleteSelection() }, icon('trash'), t('common.delete')));
  }

  renderEditImage() {
    this.title.textContent = t('edit.image');
    const dv = this.docView;
    this.body.appendChild(h('div', { class: 'props-empty' }, t('edit.imageHint')));
    this.body.appendChild(h('button', { class: 'btn', onclick: () => dv.replaceSelectedContentImage() }, icon('replace'), t('edit.replaceImage')));
    this.body.appendChild(h('button', { class: 'btn', onclick: () => dv.extractSelectedContentImage() }, icon('download'), t('edit.extractImage')));
    this.body.appendChild(h('button', { class: 'btn danger', onclick: () => dv.editMode.deleteSelectedImage() }, icon('trash'), t('common.delete')));
  }
}
