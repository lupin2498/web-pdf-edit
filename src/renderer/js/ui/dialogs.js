// Modal dialogs, menus, toasts and busy indicators.
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { t } from '../i18n.js';

const openStack = [];

export function openDialog({ title, content, buttons = [], width, onClose, className = '', closable = true, initialFocus = null, footerLeft = null }) {
  let resolveFn;
  const promise = new Promise((r) => (resolveFn = r));
  const prevFocus = document.activeElement;
  const body = h('div', { class: 'modal-body' }, content);
  const footer = buttons.length || footerLeft ? h('div', { class: 'modal-footer' }, footerLeft ? h('div', { class: 'mf-left' }, footerLeft) : null) : null;
  const modal = h(
    'div',
    { class: `modal ${className}`, role: 'dialog', 'aria-modal': 'true', style: width ? { width: `min(${width}px, calc(100vw - 40px))` } : null },
    h('div', { class: 'modal-header' }, h('span', null, title || ''), closable ? h('button', { class: 'icon-btn', title: t('common.close'), onclick: () => close(undefined) }, icon('close')) : null),
    body,
    footer,
  );
  const backdrop = h('div', { class: 'modal-backdrop' }, modal);
  let closed = false;
  const close = (value) => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    const i = openStack.indexOf(api);
    if (i >= 0) openStack.splice(i, 1);
    document.removeEventListener('keydown', onKey, true);
    if (onClose) onClose(value);
    if (prevFocus && prevFocus.focus) prevFocus.focus();
    resolveFn(value);
  };
  const btnEls = buttons.map((b) => {
    const el = h(
      'button',
      {
        class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`,
        disabled: b.disabled,
        onclick: async () => {
          if (b.onClick) {
            const r = await b.onClick(api);
            if (r === false) return;
            if (r !== undefined) return close(r);
          }
          close(b.value);
        },
      },
      b.label,
    );
    if (b.id) el.dataset.id = b.id;
    return el;
  });
  if (footer) btnEls.forEach((b) => footer.appendChild(b));
  const onKey = (e) => {
    if (openStack[openStack.length - 1] !== api) return;
    if (e.key === 'Escape' && closable) {
      e.preventDefault();
      e.stopPropagation();
      close(undefined);
    } else if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
      const primary = buttons.findIndex((b) => b.primary);
      if (primary >= 0 && !btnEls[primary].disabled) {
        e.preventDefault();
        e.stopPropagation();
        btnEls[primary].click();
      }
    }
  };
  document.addEventListener('keydown', onKey, true);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop && closable && !buttons.some((b) => b.primary)) close(undefined);
  });
  document.body.appendChild(backdrop);
  const api = {
    el: modal,
    body,
    close,
    promise,
    buttons: btnEls,
    setButtonDisabled(i, d) {
      if (btnEls[i]) btnEls[i].disabled = d;
    },
  };
  openStack.push(api);
  requestAnimationFrame(() => {
    const target = initialFocus || modal.querySelector('input:not([type=hidden]):not([disabled]), select, textarea') || btnEls.find((b) => b.classList.contains('primary'));
    if (target && target.focus) {
      target.focus();
      if (target.select && target.tagName === 'INPUT') target.select();
    }
  });
  return api;
}

export function isDialogOpen() {
  return openStack.length > 0;
}

export function alertDialog(message, title = t('app.name')) {
  return openDialog({ title, content: h('div', { style: { whiteSpace: 'pre-wrap' } }, message), buttons: [{ label: t('common.ok'), primary: true, value: true }] }).promise;
}

export function confirmDialog(message, { title = t('app.name'), okLabel = t('common.ok'), cancelLabel = t('common.cancel'), danger = false } = {}) {
  return openDialog({
    title,
    content: h('div', { style: { whiteSpace: 'pre-wrap' } }, message),
    buttons: [
      { label: cancelLabel, value: false },
      { label: okLabel, primary: true, danger, value: true },
    ],
  }).promise.then((v) => v === true);
}

export function choiceDialog(message, choices, { title = t('app.name') } = {}) {
  return openDialog({
    title,
    content: h('div', { style: { whiteSpace: 'pre-wrap' } }, message),
    buttons: choices.map((c) => ({ label: c.label, value: c.value, primary: c.primary, danger: c.danger })),
  }).promise;
}

export function promptDialog(label, value = '', { title = t('app.name'), type = 'text', placeholder = '', okLabel = t('common.ok'), validate = null } = {}) {
  const input = h('input', { class: 'input', type, value, placeholder, style: { width: '100%' } });
  const err = h('div', { class: 'error-text' });
  const dlg = openDialog({
    title,
    content: [h('div', { class: 'form-row' }, label ? h('label', null, label) : null, input), err],
    buttons: [
      { label: t('common.cancel'), value: null },
      {
        label: okLabel,
        primary: true,
        onClick: () => {
          if (validate) {
            const msg = validate(input.value);
            if (msg) {
              err.textContent = msg;
              return false;
            }
          }
          return input.value;
        },
      },
    ],
  });
  return dlg.promise.then((v) => (v === undefined ? null : v));
}

export function passwordDialog(fileName, { retry = false } = {}) {
  const input = h('input', { class: 'input', type: 'password', style: { width: '100%' }, autocomplete: 'off' });
  return openDialog({
    title: t('password.title'),
    content: [
      h('div', null, t('password.prompt', { name: fileName })),
      retry ? h('div', { class: 'error-text' }, t('password.wrong')) : null,
      h('div', { class: 'form-row' }, input),
    ],
    buttons: [
      { label: t('common.cancel'), value: null },
      { label: t('common.open'), primary: true, onClick: () => input.value },
    ],
  }).promise.then((v) => (v === undefined ? null : v));
}

// --------------------------------------------------------------------------- busy

let busyEl = null;
let busyDepth = 0;
export function showBusy(label = t('common.working')) {
  busyDepth++;
  if (!busyEl) {
    const bar = h('div', { class: 'progress indeterminate' }, h('div'));
    const lbl = h('div', null, label);
    busyEl = h('div', { class: 'busy' }, h('div', { class: 'busy-card' }, lbl, bar));
    busyEl._label = lbl;
    busyEl._bar = bar;
    document.body.appendChild(busyEl);
  } else {
    busyEl._label.textContent = label;
  }
  const api = {
    set(fraction, text) {
      if (!busyEl) return;
      if (text) busyEl._label.textContent = text;
      if (fraction === null || fraction === undefined) {
        busyEl._bar.classList.add('indeterminate');
        busyEl._bar.firstChild.style.width = '';
      } else {
        busyEl._bar.classList.remove('indeterminate');
        busyEl._bar.firstChild.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
      }
    },
    close() {
      busyDepth = Math.max(0, busyDepth - 1);
      if (busyDepth === 0 && busyEl) {
        busyEl.remove();
        busyEl = null;
      }
    },
  };
  return api;
}

export async function withBusy(label, fn) {
  const b = showBusy(label);
  // Let the overlay paint before heavy synchronous work.
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  try {
    return await fn(b);
  } finally {
    b.close();
  }
}

// --------------------------------------------------------------------------- toasts

let toastsEl = null;
export function toast(message, { type = 'info', timeout = 3200, action = null } = {}) {
  if (!toastsEl) {
    toastsEl = h('div', { class: 'toasts' });
    document.body.appendChild(toastsEl);
  }
  // The same message again replaces the previous toast instead of stacking.
  for (const old of toastsEl.querySelectorAll(`.toast.${type}`)) {
    if (old.firstChild && old.firstChild.textContent === message) old.remove();
  }
  const el = h('div', { class: `toast ${type}` }, h('span', null, message));
  if (action) el.appendChild(h('button', { onclick: () => { action.onClick(); el.remove(); } }, action.label));
  toastsEl.appendChild(el);
  setTimeout(() => el.remove(), timeout);
  return el;
}

// --------------------------------------------------------------------------- menus

let openMenu = null;
export function closeMenu() {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
  }
}

/**
 * items: [{label, icon, shortcut, disabled, checked, onClick, separator, title, submenu}]
 * anchor: Element (menu below it) or {x, y}
 */
export function showMenu(anchor, items, { align = 'left' } = {}) {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu' });
  const build = (container, list) => {
    for (const it of list) {
      if (!it) continue;
      if (it.separator) {
        container.appendChild(h('div', { class: 'menu-sep' }));
        continue;
      }
      if (it.title) {
        container.appendChild(h('div', { class: 'menu-title' }, it.title));
        continue;
      }
      const el = h(
        'div',
        { class: `menu-item ${it.disabled ? 'disabled' : ''}`, role: 'menuitem' },
        it.checked !== undefined ? (it.checked ? icon('check') : h('span', { style: { width: '16px' } })) : it.icon ? icon(it.icon) : null,
        h('span', { class: 'mi-label' }, it.label),
        it.shortcut ? h('span', { class: 'mi-shortcut' }, it.shortcut) : null,
        it.submenu ? icon('chevronRight') : null,
      );
      if (it.id) el.dataset.id = it.id;
      if (!it.disabled) {
        if (it.submenu) {
          el.addEventListener('mouseenter', () => {
            const rect = el.getBoundingClientRect();
            showSubmenu(rect, it.submenu);
          });
        } else {
          el.addEventListener('mouseenter', () => closeSub());
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            closeMenu();
            closeSub();
            it.onClick && it.onClick();
          });
        }
      }
      container.appendChild(el);
    }
  };
  let sub = null;
  const closeSub = () => {
    if (sub) {
      sub.remove();
      sub = null;
    }
  };
  const showSubmenu = (rect, list) => {
    closeSub();
    sub = h('div', { class: 'menu' });
    build(sub, list);
    document.body.appendChild(sub);
    place(sub, { x: rect.right - 2, y: rect.top - 4 });
  };
  build(menu, items);
  document.body.appendChild(menu);
  let pos;
  if (anchor instanceof Element) {
    const r = anchor.getBoundingClientRect();
    pos = { x: align === 'right' ? r.right - menu.offsetWidth : r.left, y: r.bottom + 4 };
  } else {
    pos = anchor;
  }
  place(menu, pos);
  openMenu = menu;
  const origRemove = menu.remove.bind(menu);
  menu.remove = () => {
    closeSub();
    origRemove();
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', esc, true);
  };
  const outside = (e) => {
    if (!menu.contains(e.target) && !(sub && sub.contains(e.target))) closeMenu();
  };
  const esc = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeMenu();
    }
  };
  setTimeout(() => {
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', esc, true);
  }, 0);
  return menu;
}

function place(el, { x, y }) {
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  const maxX = window.innerWidth - w - 6;
  const maxY = window.innerHeight - hgt - 6;
  el.style.left = `${Math.max(6, Math.min(x, maxX))}px`;
  el.style.top = `${Math.max(6, Math.min(y, maxY))}px`;
}

// --------------------------------------------------------------------------- tooltips

let tipEl = null;
let tipTimer = null;
export function installTooltips(root = document) {
  root.addEventListener('mouseover', (e) => {
    const target = e.target.closest && e.target.closest('[data-tip]');
    clearTimeout(tipTimer);
    if (tipEl) {
      tipEl.remove();
      tipEl = null;
    }
    if (!target) return;
    tipTimer = setTimeout(() => {
      if (!document.body.contains(target)) return;
      tipEl = h('div', { class: 'tooltip' }, target.dataset.tip);
      document.body.appendChild(tipEl);
      const r = target.getBoundingClientRect();
      let x = r.left + r.width / 2 - tipEl.offsetWidth / 2;
      x = Math.max(4, Math.min(x, window.innerWidth - tipEl.offsetWidth - 4));
      let y = r.bottom + 6;
      if (y + tipEl.offsetHeight > window.innerHeight) y = r.top - tipEl.offsetHeight - 6;
      tipEl.style.left = `${x}px`;
      tipEl.style.top = `${y}px`;
    }, 450);
  });
  root.addEventListener('mousedown', () => {
    clearTimeout(tipTimer);
    if (tipEl) {
      tipEl.remove();
      tipEl = null;
    }
  });
}

export { clear };
