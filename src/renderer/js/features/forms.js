// Form tools: reset and flatten.
import { confirmDialog, withBusy, alertDialog, toast } from '../ui/dialogs.js';
import { loadPdf } from '../../../core/builder.js';
import { flattenAnnotations } from '../../../core/flatten.js';
import { collectGarbage } from '../../../core/pdf-gc.js';
import { t, errorMessage } from '../i18n.js';

export async function reset(doc) {
  if (!(await confirmDialog(t('form.resetConfirm')))) return;
  doc.session.resetForms();
  doc.viewer.invalidatePages(doc.session.state.pages.map((p) => p.uid));
  doc.viewer.rerenderVisible();
  toast(t('form.resetDone'));
}

export async function flatten(doc, { forms = true, annotations = true } = {}) {
  if (doc.isReadOnly()) return doc.warnReadOnly();
  const ok = await confirmDialog(annotations ? t('flatten.confirmAll') : t('flatten.confirmForms'), { okLabel: t('tools.flatten') });
  if (!ok) return;
  try {
    const count = await withBusy(t('flatten.running'), async () => {
      doc.overlay.commitEditing();
      const { bytes } = await doc.session.buildBytes({ security: null });
      const lib = await loadPdf(bytes);
      let n = 0;
      if (annotations) n += flattenAnnotations(lib, { includeForms: forms });
      else if (forms) n += flattenAnnotations(lib, { includeForms: true, onlyForms: true });
      collectGarbage(lib);
      const out = await lib.save({ useObjectStreams: true, updateFieldAppearances: false });
      await doc.session.replaceWithBytes(out);
      doc.session.externalDirty = true;
      return n;
    });
    await refreshDoc(doc);
    toast(t('flatten.done', { n: count }), { type: 'success' });
  } catch (e) {
    console.error(e);
    alertDialog(errorMessage(e));
  }
}

export async function refreshDoc(doc) {
  doc.thumbs.clear();
  await doc.viewer.rebuild();
  doc.thumbGrid.render();
  if (doc.mode === 'organize') doc.organizer.render();
  doc.app.updateTabs();
  doc.app.updateRibbonState();
}
