// Document properties dialog.
import { h, formatBytes } from '../ui/dom.js';
import { openDialog } from '../ui/dialogs.js';
import { parsePdfDate } from '../view/panels.js';
import { t, formatDate } from '../i18n.js';

export async function open(doc) {
  const s = doc.session;
  const src = s.sources.get(s.baseId);
  let info = {};
  let meta = null;
  try {
    meta = src ? await src.pdf.getMetadata() : null;
    info = (meta && meta.info) || {};
  } catch {
    info = {};
  }
  const cur = s.state.meta || {};
  const field = (key, value) => {
    const input = h('input', { class: 'input', value: cur[key] !== undefined ? cur[key] : value || '' });
    input.addEventListener('keydown', (e) => e.stopPropagation());
    return input;
  };
  const title = field('title', info.Title);
  const author = field('author', info.Author);
  const subject = field('subject', info.Subject);
  const keywords = field('keywords', info.Keywords);
  const g = doc.viewer.pageViewAt(doc.viewer.currentIndex)?.geometry;
  const sizeText = g ? `${(g.width / 72 * 25.4).toFixed(0)} × ${(g.height / 72 * 25.4).toFixed(0)} mm (${g.width.toFixed(0)} × ${g.height.toFixed(0)} pt)` : '';
  const ro = (label, value) => h('div', { class: 'form-inline' }, h('span', { class: 'hint', style: { minWidth: '140px' } }, label), h('span', null, value || '—'));
  const res = await openDialog({
    title: t('file.properties'),
    width: 600,
    content: [
      h('div', { class: 'form-row' }, h('label', null, t('props.docTitle')), title),
      h('div', { class: 'form-grid' }, h('div', { class: 'form-row' }, h('label', null, t('props.author')), author), h('div', { class: 'form-row' }, h('label', null, t('props.subject')), subject)),
      h('div', { class: 'form-row' }, h('label', null, t('props.keywords')), keywords),
      ro(t('props.file'), s.filePath || s.name),
      ro(t('props.fileSize'), src ? formatBytes(src.bytes.length) : ''),
      ro(t('props.pages'), String(s.state.pages.length)),
      ro(t('props.pageSize'), sizeText),
      ro(t('props.pdfVersion'), info.PDFFormatVersion ? `PDF ${info.PDFFormatVersion}` : ''),
      ro(t('props.creator'), info.Creator),
      ro(t('props.producer'), info.Producer),
      ro(t('props.created'), formatDate(parsePdfDate(info.CreationDate))),
      ro(t('props.modified'), formatDate(parsePdfDate(info.ModDate))),
      ro(t('props.security'), s.effectiveSecurity() ? t('props.encrypted') : t('props.none')),
    ],
    buttons: [
      { label: t('common.cancel'), value: null },
      { label: t('common.save'), primary: true, onClick: () => ({ title: title.value, author: author.value, subject: subject.value, keywords: keywords.value }) },
    ],
  }).promise;
  if (!res) return;
  const changed = ['title', 'author', 'subject', 'keywords'].some((k) => res[k] !== (cur[k] !== undefined ? cur[k] : ({ title: info.Title, author: info.Author, subject: info.Subject, keywords: info.Keywords }[k] || '')));
  if (changed) s.update('editMeta', (st) => (st.meta = res));
}
