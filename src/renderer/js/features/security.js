// Password protection, removing security and search & redact.
import { h } from '../ui/dom.js';
import { openDialog, alertDialog, toast, confirmDialog, promptDialog } from '../ui/dialogs.js';
import { t } from '../i18n.js';

export async function setPassword(doc) {
  if (doc.isReadOnly()) return doc.warnReadOnly();
  const useOpen = h('input', { type: 'checkbox', checked: true });
  const openPw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const openPw2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const usePerm = h('input', { type: 'checkbox' });
  const permPw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', disabled: true });
  const allowPrint = h('input', { type: 'checkbox', checked: true, disabled: true });
  const allowCopy = h('input', { type: 'checkbox', checked: true, disabled: true });
  const allowEdit = h('input', { type: 'checkbox', disabled: true });
  const allowAnnot = h('input', { type: 'checkbox', checked: true, disabled: true });
  const allowForms = h('input', { type: 'checkbox', checked: true, disabled: true });
  const err = h('div', { class: 'error-text' });
  useOpen.addEventListener('change', () => {
    openPw.disabled = !useOpen.checked;
    openPw2.disabled = !useOpen.checked;
  });
  usePerm.addEventListener('change', () => {
    for (const el of [permPw, allowPrint, allowCopy, allowEdit, allowAnnot, allowForms]) el.disabled = !usePerm.checked;
  });
  for (const el of [openPw, openPw2, permPw]) el.addEventListener('keydown', (e) => e.stopPropagation());
  const res = await openDialog({
    title: t('protect.setPassword'),
    width: 520,
    content: [
      h('label', { class: 'check' }, useOpen, h('b', null, t('protect.requireOpen'))),
      h('div', { class: 'form-grid' }, h('div', { class: 'form-row' }, h('label', null, t('protect.password')), openPw), h('div', { class: 'form-row' }, h('label', null, t('protect.confirm')), openPw2)),
      h('label', { class: 'check' }, usePerm, h('b', null, t('protect.restrict'))),
      h('div', { class: 'form-row' }, h('label', null, t('protect.permPassword')), permPw),
      h('div', { class: 'form-grid' }, h('label', { class: 'check' }, allowPrint, t('protect.allowPrint')), h('label', { class: 'check' }, allowCopy, t('protect.allowCopy')), h('label', { class: 'check' }, allowEdit, t('protect.allowEdit')), h('label', { class: 'check' }, allowAnnot, t('protect.allowAnnot')), h('label', { class: 'check' }, allowForms, t('protect.allowForms'))),
      h('div', { class: 'hint' }, t('protect.aesNote')),
      err,
    ],
    buttons: [
      { label: t('common.cancel'), value: null },
      {
        label: t('common.apply'),
        primary: true,
        onClick: () => {
          err.textContent = '';
          if (!useOpen.checked && !usePerm.checked) {
            err.textContent = t('protect.chooseOne');
            return false;
          }
          if (useOpen.checked) {
            if (!openPw.value) {
              err.textContent = t('protect.emptyPassword');
              return false;
            }
            if (openPw.value !== openPw2.value) {
              err.textContent = t('protect.mismatch');
              return false;
            }
          }
          if (usePerm.checked && !permPw.value) {
            err.textContent = t('protect.emptyPassword');
            return false;
          }
          if (useOpen.checked && usePerm.checked && openPw.value === permPw.value) {
            err.textContent = t('protect.samePasswords');
            return false;
          }
          return {
            userPassword: useOpen.checked ? openPw.value : '',
            ownerPassword: usePerm.checked ? permPw.value : '',
            permissions: usePerm.checked
              ? { printing: allowPrint.checked, copying: allowCopy.checked, modifying: allowEdit.checked, annotating: allowAnnot.checked, fillingForms: allowForms.checked, documentAssembly: allowEdit.checked }
              : {},
          };
        },
      },
    ],
  }).promise;
  if (!res) return;
  doc.session.update('setPassword', (s) => {
    s.security = res;
  });
  toast(t('protect.passwordSet'), { type: 'success' });
}

export async function removeSecurity(doc) {
  const s = doc.session;
  const has = s.effectiveSecurity();
  if (!has) return toast(t('protect.noSecurity'));
  if (s.restricted) {
    const pw = await promptDialog(t('protect.permPassword'), '', { type: 'password', title: t('protect.removeSecurity') });
    if (pw === null) return;
    if (!(await s.unlockRestrictions(pw))) return alertDialog(t('password.wrongOwner'));
  }
  const ok = await confirmDialog(t('protect.removeConfirm'));
  if (!ok) return;
  s.update('removeSecurity', (st) => {
    st.security = { remove: true };
  });
  toast(t('protect.removed'), { type: 'success' });
}

export async function searchRedact(doc) {
  const q = await promptDialog(t('protect.searchRedactPrompt'), '', { title: t('protect.searchRedact') });
  if (!q) return;
  await doc.searchAndRedact(q, { matchCase: false, wholeWord: false });
}
