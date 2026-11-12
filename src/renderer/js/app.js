// Application shell: tabs, ribbon, home screen, commands and shortcuts.
import { h, clear, basename, stripExt, formatBytes } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { showMenu, toast, confirmDialog, choiceDialog, alertDialog, passwordDialog, promptDialog, withBusy, isDialogOpen, closeMenu } from './ui/dialogs.js';
import { DocSession } from './doc/session.js';
import { DocView } from './view/doc-view.js';
import { features } from './features/index.js';
import { settings, saveSettings } from './settings.js';
import { t, errorMessage, formatDate, getLanguage, LANGUAGES } from './i18n.js';
import { pdfjsLib } from './pdf/pdfjs.js';
import { billing, authorize } from '../../web/billing.js';
import { openPaywall, openAccount } from '../../web/paywall.js';
import { adSlot, configureAds, refreshAds } from '../../web/ads.js';
import { safeFileName } from '../../web/api.js';

export class App {
  constructor(root) {
    this.root = root;
    this.tabs = [];
    this.active = null;
    this.features = features;
    this.ribbonTab = 'home';
  }

  get activeDoc() {
    return this.active && this.active.kind === 'doc' ? this.active.view : null;
  }

  async init() {
    this.info = await window.api.info();
    this.initAds();
    this.buildShell();
    this.homeTab = { id: 'home', kind: 'home', el: this.buildHome() };
    this.tabs.push(this.homeTab);
    this.workspace.appendChild(this.homeTab.el);
    this.activate(this.homeTab);
    this.bindGlobal();
    this.bindBilling();
    // "Download as...": ask for the file name.
    window.api.dialog.askName = (name) =>
      promptDialog(t('web.fileName'), stripExt(name), { title: t('web.downloadAsTitle'), okLabel: t('web.download'), validate: (v) => (safeFileName(v, '') ? '' : t('web.fileName')) });
    window.api.onOpenFiles((files) => this.openPaths(files));
    window.api.onRequestClose(() => this.requestQuit());
    const params = new URLSearchParams(location.search);
    const tool = params.get('tool');
    const handoff = params.get('open') === 'handoff';
    const initial = await window.api.initialFiles();
    if (handoff && !(initial && initial.length)) toast(t('web.handoffFailed'), { type: 'error', timeout: 6000 });
    await this.startWith(tool, initial || []);
    this.refreshRecent();
  }

  // Starts the task a landing page asked for (?tool=...), with the files
  // that were chosen there.
  async startWith(tool, paths) {
    const F = this.features;
    if (tool && /[?&]tool=/.test(location.search)) history.replaceState(null, '', location.pathname + location.hash);
    if (tool === 'merge') return F.combine.open(this, { paths });
    if (tool === 'blank' && !paths.length) return F.create.blank(this);
    if (!paths.length) return;
    const opts = tool === 'edit' ? { thenTool: 'edit' } : tool === 'organize' ? { thenRibbon: 'page' } : {};
    await this.openPaths(paths, opts);
    const doc = this.activeDoc;
    if (!doc) return;
    const run = {
      split: () => F.pages.split(doc),
      compress: () => F.compress.open(doc),
      word: () => F.convert.toWord(doc),
      image: () => F.convert.toImages(doc),
      text: () => F.convert.toText(doc),
      protect: () => F.security.setPassword(doc),
      sign: () => this.selectRibbonTab('comment'),
      convert: () => this.selectRibbonTab('convert'),
    }[tool];
    if (run) {
      try {
        await run();
      } catch (e) {
        console.error(e);
        alertDialog(errorMessage(e));
      }
    }
  }

  // ------------------------------------------------------------------ pages, purchases, ads

  initAds() {
    configureAds({
      label: t('ads.label'),
      adFree: () => billing.adFree,
      house: (placement) => {
        const second = placement === 'app_home';
        const card = h(
          'div',
          { class: 'house-ad' },
          h('div', { class: 'house-ad-icon' }, icon(second ? 'shield' : 'sparkles')),
          h('div', { class: 'house-ad-text' }, h('b', null, t(second ? 'ads.houseTitle2' : 'ads.houseTitle')), h('span', null, t(second ? 'ads.houseText2' : 'ads.houseText'))),
          h('button', { class: 'btn small primary', onclick: () => openPaywall() }, t('ads.houseCta')),
        );
        return card;
      },
    });
  }

  bindBilling() {
    billing.addEventListener('change', () => {
      this.renderQuota();
      refreshAds();
    });
    billing.addEventListener('charged', (e) => {
      const { pages, charged, account } = e.detail;
      const onlyFree = charged && charged.paid === 0;
      toast(t(onlyFree ? 'quota.chargedFree' : 'quota.charged', { n: pages, left: account.free.remaining + account.credits }), { timeout: 4500 });
      this.quotaEl.classList.remove('bump');
      void this.quotaEl.offsetWidth;
      this.quotaEl.classList.add('bump');
      if (!billing.online) toast(t('quota.offline'), { type: 'error', timeout: 5000 });
    });
    this.renderQuota();
    billing.init();
  }

  renderQuota() {
    const a = billing.account;
    const paid = a.credits > 0;
    const total = a.free.remaining + a.credits;
    clear(this.quotaEl);
    this.quotaEl.className = `quota-pill ${paid ? 'paid' : total > 0 ? 'free' : 'empty'}`;
    this.quotaEl.dataset.available = String(total);
    this.quotaEl.append(icon(paid ? 'gem' : 'gift'), h('span', { class: 'quota-text' }, paid ? t('quota.credits', { n: total }) : t('quota.free', { n: a.free.remaining })));
    this.buyBtn.classList.toggle('attention', total === 0);
  }

  toggleTheme() {
    const dark = document.documentElement.dataset.theme !== 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    saveSettings({ theme: dark ? 'dark' : 'light' });
    clear(this.themeBtn).appendChild(icon(dark ? 'sun' : 'moon'));
  }

  languageMenu(anchor) {
    showMenu(
      anchor,
      LANGUAGES.map((l) => ({ label: l.label, checked: l.id === getLanguage(), onClick: () => this.features.settings.changeLanguage(this, l.id) })),
      { align: 'right' },
    );
  }

  // ------------------------------------------------------------------ shell

  buildShell() {
    this.tabsEl = h('div', { class: 'tabs' });
    this.quotaEl = h('button', { class: 'quota-pill', 'data-tip': t('quota.tip'), onclick: () => openAccount() });
    this.buyBtn = h('button', { class: 'buy-btn', 'data-cmd': 'buy', onclick: () => openPaywall() }, icon('sparkles'), h('span', null, t('quota.buyShort')));
    this.themeBtn = h('button', { class: 'tb-btn', 'data-tip': t('web.toggleTheme'), 'aria-label': t('web.toggleTheme'), onclick: () => this.toggleTheme() }, icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon'));
    const langBtn = h('button', { class: 'tb-btn tb-lang', 'data-tip': t('web.language'), 'aria-label': t('web.language'), onclick: (e) => this.languageMenu(e.currentTarget) }, icon('globe'), h('span', null, getLanguage().toUpperCase()));
    const siteHome = `${billing.config.base}${getLanguage() === 'en' ? 'en/' : ''}`;
    const titlebar = h(
      'header',
      { class: 'titlebar' },
      h('a', { class: 'app-logo', href: siteHome, title: t('web.backToSite') }, icon('logo'), h('span', null, t('app.name'))),
      this.tabsEl,
      h('button', { class: 'tab-new', 'data-tip': t('file.open'), 'aria-label': t('file.open'), onclick: () => this.openDialog() }, icon('plus')),
      h('div', { class: 'titlebar-spacer' }),
      h('div', { class: 'titlebar-actions' }, this.quotaEl, this.buyBtn, langBtn, this.themeBtn),
    );
    this.ribbonTabsEl = h('div', { class: 'ribbon-tabs' });
    this.ribbonBody = h('div', { class: 'ribbon-body' });
    this.ribbon = h('div', { class: 'ribbon' }, this.ribbonTabsEl, this.ribbonBody);
    this.workspace = h('div', { class: 'workspace' });
    clear(this.root);
    this.root.append(titlebar, this.ribbon, this.workspace);
    this.renderRibbonTabs();
  }

  renderTabs() {
    clear(this.tabsEl);
    for (const tab of this.tabs) {
      const isHome = tab.kind === 'home';
      const dirty = !isHome && tab.view.session.dirty;
      const el = h(
        'div',
        { class: `tab ${tab === this.active ? 'active' : ''} ${isHome ? 'tab-home' : ''}`, title: isHome ? t('home.title') : tab.view.session.filePath || tab.view.session.name, dataset: { tab: tab.id } },
        isHome ? icon('home') : icon('filePdf'),
        h('span', { class: 'tab-title' }, isHome ? t('home.title') : tab.view.session.name),
        dirty ? h('span', { class: 'tab-dirty' }, '●') : null,
        isHome
          ? null
          : h(
              'button',
              {
                class: 'tab-close',
                title: t('common.close'),
                onclick: (e) => {
                  e.stopPropagation();
                  this.closeTab(tab);
                },
              },
              icon('close'),
            ),
      );
      el.addEventListener('mousedown', (e) => {
        if (e.button === 1 && !isHome) {
          e.preventDefault();
          this.closeTab(tab);
        }
      });
      el.addEventListener('click', () => this.activate(tab));
      this.tabsEl.appendChild(el);
    }
    const doc = this.activeDoc;
    window.api.window.setTitle(doc ? `${doc.session.name}${doc.session.dirty ? ' *' : ''} - ${t('app.name')}` : t('app.name'));
  }

  updateTabs() {
    this.renderTabs();
  }

  activate(tab) {
    if (this.active && this.active.kind === 'doc' && this.active !== tab) this.active.view.overlay.commitEditing();
    this.active = tab;
    for (const tb of this.tabs) tb.el.classList.toggle('hidden', tb !== tab);
    if (tab.kind === 'home') this.refreshRecent();
    this.renderTabs();
    this.renderRibbon();
    if (tab.kind === 'doc') requestAnimationFrame(() => tab.view.viewer.updateVisible());
  }

  // ------------------------------------------------------------------ ribbon

  ribbonConfig() {
    const doc = this.activeDoc;
    const tool = doc ? doc.tools.tool : null;
    const F = this.features;
    const toolBtn = (id, ic, label, toolId = id) => ({ id, icon: ic, label, active: tool === toolId, needsDoc: true, edit: true, run: () => this.toggleTool(toolId) });
    const cmd = (id, ic, label, run, opts = {}) => ({ id, icon: ic, label, run, needsDoc: true, ...opts });
    return {
      home: [
        [toolBtn('hand', 'hand', t('tool.hand')), toolBtn('select', 'cursor', t('tool.select'))],
        [cmd('zoomIn', 'zoomIn', t('zoom.in'), () => doc.viewer.zoomIn()), cmd('zoomOut', 'zoomOut', t('zoom.out'), () => doc.viewer.zoomOut()), cmd('fitWidth', 'fitWidth', t('zoom.fitWidth'), () => doc.viewer.setZoomMode('page-width')), cmd('fitPage', 'fitPage', t('zoom.fitPage'), () => doc.viewer.setZoomMode('page-fit'))],
        [cmd('rotL', 'rotateLeft', t('page.rotateLeft'), () => doc.session.rotatePages(doc.selectedPageUids(), -90), { edit: true }), cmd('rotR', 'rotateRight', t('page.rotateRight'), () => doc.session.rotatePages(doc.selectedPageUids(), 90), { edit: true })],
        [toolBtn('highlight', 'highlight', t('tool.highlight')), toolBtn('addText', 'addText', t('tool.addText')), cmd('addImage', 'image', t('tool.addImage'), () => F.insert.pickImage(doc), { edit: true }), toolBtn('editAll', 'edit', t('tool.edit'), 'edit')],
        [cmd('combine', 'combine', t('tools.combine'), () => F.combine.open(this), { needsDoc: false }), cmd('print', 'print', t('file.print'), () => F.print.open(doc)), cmd('undo', 'undo', t('common.undo'), () => this.undo(), { disabled: !doc || !doc.session.canUndo() }), cmd('redo', 'redo', t('common.redo'), () => this.redo(), { disabled: !doc || !doc.session.canRedo() })],
      ],
      comment: [
        [toolBtn('highlight', 'highlight', t('tool.highlight')), toolBtn('underline', 'underline', t('tool.underline')), toolBtn('strikeout', 'strike', t('tool.strikeout')), toolBtn('squiggly', 'squiggly', t('tool.squiggly'))],
        [toolBtn('note', 'note', t('tool.note')), toolBtn('freetext', 'textbox', t('tool.textbox'))],
        [toolBtn('ink', 'pencil', t('tool.pencil')), toolBtn('eraser', 'eraser', t('tool.eraser'))],
        [toolBtn('rect', 'square', t('tool.rect')), toolBtn('ellipse', 'circle', t('tool.ellipse')), toolBtn('line', 'line', t('tool.line')), toolBtn('arrow', 'arrow', t('tool.arrow')), toolBtn('polyline', 'polyline', t('tool.polyline')), toolBtn('polygon', 'polygon', t('tool.polygon'))],
        [
          { id: 'stamp', icon: 'stamp', label: t('tool.stamp'), needsDoc: true, edit: true, active: tool === 'stamp', menu: () => F.signature.stampMenu(doc) },
          { id: 'signature', icon: 'signature', label: t('tool.signature'), needsDoc: true, edit: true, active: tool === 'signature', menu: () => F.signature.signatureMenu(doc) },
        ],
        [cmd('commentsPanel', 'comments', t('panel.comments'), () => doc.togglePanel('comments', true))],
      ],
      edit: [
        [toolBtn('edit', 'edit', t('tool.edit')), toolBtn('addText', 'addText', t('tool.addText')), cmd('addImage', 'image', t('tool.addImage'), () => F.insert.pickImage(doc), { edit: true }), toolBtn('link', 'link', t('tool.link')), toolBtn('whiteout', 'whiteout', t('tool.whiteout'))],
        [
          { id: 'watermark', icon: 'watermark', label: t('ribbon.watermark'), needsDoc: true, edit: true, menu: () => F.marks.menu(doc, 'watermark') },
          { id: 'background', icon: 'background', label: t('ribbon.background'), needsDoc: true, edit: true, menu: () => F.marks.menu(doc, 'background') },
          { id: 'headerFooter', icon: 'headerFooter', label: t('ribbon.headerFooter'), needsDoc: true, edit: true, menu: () => F.marks.menu(doc, 'headerFooter') },
          { id: 'bates', icon: 'bates', label: t('ribbon.bates'), needsDoc: true, edit: true, menu: () => F.marks.menu(doc, 'bates') },
        ],
        [toolBtn('crop', 'crop', t('tool.crop'))],
      ],
      page: [
        [
          { id: 'insert', icon: 'insert', label: t('page.insert'), needsDoc: true, edit: true, menu: () => F.pages.insertMenu(doc) },
          cmd('delete', 'trash', t('page.delete'), () => doc.deletePages(doc.selectedPageUids()), { edit: true }),
          cmd('extract', 'extract', t('page.extract'), () => F.pages.extract(doc, doc.selectedPageUids())),
          cmd('split', 'split', t('page.split'), () => F.pages.split(doc)),
          cmd('replace', 'replace', t('page.replace'), () => F.pages.replace(doc, doc.selectedPageUids()), { edit: true }),
        ],
        [
          cmd('rotL', 'rotateLeft', t('page.rotateLeft'), () => doc.session.rotatePages(doc.selectedPageUids(), -90), { edit: true }),
          cmd('rotR', 'rotateRight', t('page.rotateRight'), () => doc.session.rotatePages(doc.selectedPageUids(), 90), { edit: true }),
          cmd('dup', 'copy', t('page.duplicate'), () => doc.session.duplicatePages(doc.selectedPageUids()), { edit: true }),
          cmd('reverse', 'reverse', t('page.reverse'), () => {
            const sel = doc.selectedPageUids();
            doc.session.reversePages(sel.length > 1 ? sel : doc.session.state.pages.map((p) => p.uid));
          }, { edit: true }),
          cmd('cropPage', 'crop', t('tool.crop'), () => {
            doc.setMode('view');
            doc.setTool('crop');
          }, { edit: true }),
        ],
        [
          {
            id: 'selectPages',
            icon: 'check',
            label: t('page.select'),
            needsDoc: true,
            menu: () => [
              { label: t('page.selectAll'), onClick: () => doc.organizer.selectAll() },
              { label: t('page.selectOdd'), onClick: () => doc.organizer.selectWhere((i) => i % 2 === 0) },
              { label: t('page.selectEven'), onClick: () => doc.organizer.selectWhere((i) => i % 2 === 1) },
              { label: t('page.selectLandscape'), onClick: () => doc.organizer.selectWhere((i, p) => { const g = doc.viewer.pageViews.get(p.uid)?.geometry; return g && g.width > g.height; }) },
              { label: t('page.selectPortrait'), onClick: () => doc.organizer.selectWhere((i, p) => { const g = doc.viewer.pageViews.get(p.uid)?.geometry; return g && g.width <= g.height; }) },
            ],
          },
          cmd('thumbSmaller', 'zoomOut', t('page.thumbSmaller'), () => doc.organizer.setThumbWidth(Math.max(90, doc.organizer.thumbWidth - 30))),
          cmd('thumbLarger', 'zoomIn', t('page.thumbLarger'), () => doc.organizer.setThumbWidth(Math.min(400, doc.organizer.thumbWidth + 30))),
        ],
      ],
      convert: [
        [cmd('toWord', 'toWord', t('convert.toWord'), () => F.convert.toWord(doc)), cmd('toImage', 'toImage', t('convert.toImage'), () => F.convert.toImages(doc)), cmd('toText', 'toText', t('convert.toText'), () => F.convert.toText(doc)), cmd('toHtml', 'toHtml', t('convert.toHtml'), () => F.convert.toHtml(doc))],
        [cmd('fromImages', 'image', t('create.fromImages'), () => F.create.fromImages(this), { needsDoc: false }), cmd('blank', 'newFile', t('create.blank'), () => F.create.blank(this), { needsDoc: false })],
      ],
      protect: [
        [cmd('password', 'lock', t('protect.setPassword'), () => F.security.setPassword(doc)), cmd('removeSecurity', 'unlock', t('protect.removeSecurity'), () => F.security.removeSecurity(doc))],
        [toolBtn('redact', 'redact', t('tool.redact')), toolBtn('redactText', 'textCursor', t('tool.redactText')), cmd('searchRedact', 'search', t('protect.searchRedact'), () => F.security.searchRedact(doc), { edit: true }), cmd('applyRedact', 'redactApply', t('redact.apply'), () => doc.applyRedactions(), { edit: true })],
        [{ id: 'signature', icon: 'signature', label: t('tool.signature'), needsDoc: true, edit: true, active: tool === 'signature', menu: () => F.signature.signatureMenu(doc) }],
      ],
      form: [
        [
          cmd('highlightFields', 'formField', t('form.highlight'), () => this.toggleFormHighlight(), { active: settings.showFormHighlight !== false }),
          cmd('resetForm', 'undo', t('form.reset'), () => F.forms.reset(doc)),
          cmd('flattenForm', 'flatten', t('form.flatten'), () => F.forms.flatten(doc, { forms: true, annotations: false }), { edit: true }),
        ],
      ],
      tools: [
        [cmd('combine', 'combine', t('tools.combine'), () => F.combine.open(this), { needsDoc: false }), cmd('compress', 'compress', t('tools.compress'), () => F.compress.open(doc)), cmd('flatten', 'flatten', t('tools.flatten'), () => F.forms.flatten(doc, { forms: true, annotations: true }), { edit: true })],
        [cmd('split', 'split', t('page.split'), () => F.pages.split(doc)), cmd('extract', 'extract', t('page.extract'), () => F.pages.extract(doc, doc.selectedPageUids())), cmd('docProps', 'info', t('file.properties'), () => F.docProps.open(doc))],
      ],
    };
  }

  renderRibbonTabs() {
    clear(this.ribbonTabsEl);
    this.ribbonTabsEl.appendChild(h('button', { class: 'ribbon-file', onclick: (e) => this.fileMenu(e.currentTarget) }, t('ribbon.file')));
    const tabs = [
      ['home', t('ribbon.home')],
      ['comment', t('ribbon.comment')],
      ['edit', t('ribbon.edit')],
      ['page', t('ribbon.page')],
      ['convert', t('ribbon.convert')],
      ['protect', t('ribbon.protect')],
      ['form', t('ribbon.form')],
      ['tools', t('ribbon.tools')],
    ];
    for (const [id, label] of tabs) {
      this.ribbonTabsEl.appendChild(h('button', { class: `ribbon-tab ${this.ribbonTab === id ? 'active' : ''}`, dataset: { rtab: id }, onclick: () => this.selectRibbonTab(id) }, label));
    }
    this.ribbonTabsEl.appendChild(h('div', { class: 'ribbon-tabs-spacer', style: { flex: '1' } }));
    this.downloadBtn = h('button', { class: 'download-btn', 'data-cmd': 'download', disabled: true, 'data-tip': `${t('web.download')} (Ctrl+S)`, onclick: () => this.save(this.activeDoc) }, icon('download'), h('span', null, t('web.download')));
    this.ribbonTabsEl.appendChild(this.downloadBtn);
    this.ribbonTabsEl.appendChild(h('button', { class: 'icon-btn', 'data-tip': t('panel.search'), onclick: () => this.activeDoc && this.activeDoc.togglePanel('search', true) }, icon('search')));
    this.ribbonTabsEl.appendChild(h('button', { class: 'icon-btn', 'data-tip': t('props.title'), onclick: () => this.activeDoc && this.activeDoc.toggleProps() }, icon('panelRight')));
    this.ribbonTabsEl.appendChild(h('button', { class: 'icon-btn', 'data-tip': t('settings.title'), onclick: () => this.features.settings.open(this) }, icon('settings')));
  }

  selectRibbonTab(id) {
    this.ribbonTab = id;
    for (const b of this.ribbonTabsEl.querySelectorAll('.ribbon-tab')) b.classList.toggle('active', b.dataset.rtab === id);
    const doc = this.activeDoc;
    if (doc) {
      if (id === 'page') doc.setMode('organize');
      else if (doc.mode === 'organize') doc.setMode('view');
      if (id === 'edit' && doc.tools.tool === 'select' && !doc.isReadOnly()) doc.setTool('edit');
      else if (id !== 'edit' && doc.tools.tool === 'edit') doc.setTool('select');
      if (id === 'form' && doc.tools.tool !== 'select') doc.setTool('select');
    }
    this.renderRibbon();
  }

  renderRibbon() {
    const config = this.ribbonConfig()[this.ribbonTab] || [];
    const doc = this.activeDoc;
    if (this.downloadBtn) this.downloadBtn.disabled = !doc;
    clear(this.ribbonBody);
    for (const group of config) {
      const g = h('div', { class: 'rb-group' });
      for (const b of group) {
        const disabled = b.disabled || (b.needsDoc && !doc) || (b.edit && doc && doc.isReadOnly());
        const btn = h(
          'button',
          { class: `rb-btn ${b.active ? 'active' : ''}`, disabled, 'data-cmd': b.id, title: b.label },
          icon(b.icon),
          h('span', null, b.label),
          b.menu ? icon('chevronDown', 'rb-caret') : null,
        );
        btn.addEventListener('click', async () => {
          if (b.menu) {
            const items = await b.menu();
            if (items && items.length) showMenu(btn, items);
          } else if (b.run) {
            try {
              await b.run();
            } catch (e) {
              console.error(e);
              alertDialog(errorMessage(e));
            }
          }
          this.updateRibbonState();
        });
        g.appendChild(btn);
      }
      this.ribbonBody.appendChild(g);
    }
  }

  updateRibbonState() {
    clearTimeout(this.ribbonTimer);
    this.ribbonTimer = setTimeout(() => this.renderRibbon(), 0);
  }

  toggleTool(toolId) {
    const doc = this.activeDoc;
    if (!doc) return;
    if (doc.mode === 'organize') {
      doc.setMode('view');
      if (this.ribbonTab === 'page') this.selectRibbonTab('home');
    }
    doc.setTool(doc.tools.tool === toolId && toolId !== 'select' ? 'select' : toolId);
    this.renderRibbon();
  }

  toggleFormHighlight() {
    settings.showFormHighlight = settings.showFormHighlight === false;
    window.api.settings.set({ showFormHighlight: settings.showFormHighlight });
    document.body.classList.toggle('hide-form-highlight', settings.showFormHighlight === false);
    this.renderRibbon();
  }

  fileMenu(anchor) {
    const doc = this.activeDoc;
    showMenu(anchor, [
      { label: t('create.blank'), icon: 'newFile', onClick: () => this.features.create.blank(this) },
      { label: t('file.open'), icon: 'open', shortcut: 'Ctrl+O', onClick: () => this.openDialog() },
      { label: t('file.recent'), icon: 'calendar', submenu: this.recentMenuItems() },
      { separator: true },
      { label: t('file.save'), icon: 'download', shortcut: 'Ctrl+S', disabled: !doc, onClick: () => this.save(doc) },
      { label: t('file.saveAs'), icon: 'saveAs', shortcut: 'Ctrl+Shift+S', disabled: !doc, onClick: () => this.save(doc, true) },
      { separator: true },
      { label: t('tools.combine'), icon: 'combine', onClick: () => this.features.combine.open(this) },
      { label: t('create.fromImages'), icon: 'image', onClick: () => this.features.create.fromImages(this) },
      { label: t('file.print'), icon: 'print', shortcut: 'Ctrl+P', disabled: !doc, onClick: () => this.features.print.open(doc) },
      { label: t('file.properties'), icon: 'info', disabled: !doc, onClick: () => this.features.docProps.open(doc) },
      { separator: true },
      { label: t('file.close'), icon: 'close', disabled: !doc, onClick: () => this.closeTab(this.active) },
      { separator: true },
      { label: t('account.title'), icon: 'user', onClick: () => openAccount() },
      { label: t('quota.buy'), icon: 'sparkles', onClick: () => openPaywall() },
      { separator: true },
      { label: t('settings.title'), icon: 'settings', onClick: () => this.features.settings.open(this) },
      { label: t('about.title'), icon: 'help', onClick: () => this.features.settings.about(this) },
    ]);
  }

  recentMenuItems() {
    const list = (this.recent || []).slice(0, 10);
    if (!list.length) return [{ label: t('home.noRecent'), disabled: true }];
    return [
      ...list.map((r) => ({ label: r.name, icon: 'filePdf', onClick: () => this.openPaths([r.path]) })),
      { separator: true },
      { label: t('home.clearRecent'), onClick: async () => { await window.api.recent.clear(); this.refreshRecent(); } },
    ];
  }

  // ------------------------------------------------------------------ home

  buildHome() {
    const card = (ic, color, title, desc, run, id) =>
      h(
        'button',
        { class: 'home-card', onclick: run, dataset: { action: id } },
        h('div', { class: 'hc-icon', style: { background: color } }, icon(ic)),
        h('div', { class: 'hc-title' }, title),
        h('div', { class: 'hc-desc' }, desc),
      );
    this.recentEl = h('div', { class: 'recent-list' });
    this.drop = h('button', { class: 'home-drop', type: 'button', onclick: () => this.openDialog() }, h('span', { class: 'home-drop-icon' }, icon('upload')), h('div', null, t('home.drop')), h('small', null, icon('shield'), t('web.private')));
    this.recentSection = h('div', { class: 'home-recent' });
    const el = h(
      'div',
      { class: 'view home' },
      h(
        'div',
        { class: 'home-inner' },
        h('h1', null, t('home.welcome')),
        h('div', { class: 'home-sub' }, t('home.subtitle')),
        h(
          'div',
          { class: 'home-actions' },
          card('open', '#2f6bff', t('home.openTitle'), t('home.openDesc'), () => this.openDialog(), 'open'),
          card('edit', '#7c4dff', t('home.editTitle'), t('home.editDesc'), () => this.openDialog({ thenTool: 'edit' }), 'edit'),
          card('combine', '#00a389', t('home.combineTitle'), t('home.combineDesc'), () => this.features.combine.open(this), 'combine'),
          card('pages', '#ff8f00', t('home.organizeTitle'), t('home.organizeDesc'), () => this.openDialog({ thenRibbon: 'page' }), 'organize'),
          card('image', '#e5484d', t('home.imagesTitle'), t('home.imagesDesc'), () => this.features.create.fromImages(this), 'images'),
          card('newFile', '#5c6b8a', t('home.blankTitle'), t('home.blankDesc'), () => this.features.create.blank(this), 'blank'),
        ),
        this.drop,
        adSlot('app_home'),
        this.recentSection,
      ),
    );
    this.recentSection.append(
      h('div', { class: 'home-section-title' }, h('span', null, t('home.recent'), h('small', null, t('home.recentNote'))), h('button', { class: 'btn small', onclick: async () => { await window.api.recent.clear(); this.refreshRecent(); } }, t('home.clearRecent'))),
      this.recentEl,
    );
    return el;
  }

  async refreshRecent() {
    try {
      this.recent = await window.api.recent.get();
    } catch {
      this.recent = [];
    }
    if (!this.recentEl) return;
    clear(this.recentEl);
    // Nothing to show: the whole section stays out of the way.
    this.recentSection.classList.toggle('hidden', !this.recent.length);
    if (!this.recent.length) {
      this.recentEl.appendChild(h('div', { class: 'empty-note' }, t('home.noRecent')));
      return;
    }
    for (const r of this.recent) {
      const row = h(
        'div',
        { class: 'recent-item', title: r.name },
        h('span', { class: 'ri-icon' }, icon('filePdf')),
        h('div', { class: 'ri-main' }, h('div', { class: 'ri-name' }, r.name), h('div', { class: 'ri-path' }, `${formatBytes(r.size)} · ${formatDate(r.mtime)}`)),
        h(
          'button',
          {
            class: 'icon-btn',
            title: t('home.removeRecent'),
            onclick: async (e) => {
              e.stopPropagation();
              await window.api.recent.remove(r.path);
              this.refreshRecent();
            },
          },
          icon('close'),
        ),
      );
      row.addEventListener('click', () => this.openPaths([r.path]));
      this.recentEl.appendChild(row);
    }
  }

  // ------------------------------------------------------------------ documents

  async openDialog(opts = {}) {
    const paths = await window.api.dialog.open({ multiple: true, filters: [{ name: t('filter.pdf'), extensions: ['pdf'] }, { name: t('filter.images'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] }] });
    if (paths.length) await this.openPaths(paths, opts);
  }

  async openPaths(paths, opts = {}) {
    const images = paths.filter((p) => /\.(png|jpe?g|gif|bmp|webp|tiff?)$/i.test(p));
    for (const p of paths) {
      if (images.includes(p)) continue;
      const existing = this.tabs.find((tb) => tb.kind === 'doc' && tb.view.session.filePath === p);
      if (existing) {
        this.activate(existing);
        continue;
      }
      try {
        const bytes = await window.api.file.read(p);
        const view = await this.openBytes(bytes, { filePath: p, name: basename(p) });
        if (view) {
          window.api.recent.add(p);
          if (opts.thenTool) view.setTool(opts.thenTool);
          if (opts.thenTool === 'edit') this.selectRibbonTab('edit');
          if (opts.thenRibbon) this.selectRibbonTab(opts.thenRibbon);
        }
      } catch (e) {
        console.error(e);
        alertDialog(t('error.openFailed', { name: basename(p), message: errorMessage(e) }));
      }
    }
    if (images.length) await this.features.create.fromImagePaths(this, images);
  }

  async openBytes(bytes, { filePath = null, name = 'document.pdf', isNew = false } = {}) {
    const session = new DocSession({ filePath, name });
    let password;
    let src = null;
    let retry = false;
    for (;;) {
      try {
        src = await session.addSource(bytes, { name, password, path: filePath });
        break;
      } catch (e) {
        if (e && e.name === 'PasswordException') {
          password = await passwordDialog(name, { retry });
          if (password === null) return null;
          retry = true;
          continue;
        }
        throw e;
      }
    }
    await session.initFromSource(src);
    session.isNewUnsaved = isNew;
    const view = new DocView(this, session);
    const tab = { id: session.id, kind: 'doc', view, el: view.el };
    this.tabs.push(tab);
    this.workspace.appendChild(view.el);
    this.activate(tab);
    await view.init();
    if (this.ribbonTab === 'page') view.setMode('organize');
    this.renderTabs();
    return view;
  }

  async closeTab(tab) {
    if (!tab || tab.kind !== 'doc') return true;
    const view = tab.view;
    view.overlay.commitEditing();
    if (view.session.dirty) {
      this.activate(tab);
      const choice = await choiceDialog(t('close.unsaved', { name: view.session.name }), [
        { label: t('close.cancel'), value: 'cancel' },
        { label: t('close.discard'), value: 'discard', danger: true },
        { label: t('close.save'), value: 'save', primary: true },
      ]);
      if (choice === 'cancel' || choice === undefined) return false;
      if (choice === 'save') {
        const ok = await this.save(view);
        if (!ok) return false;
      }
    }
    const i = this.tabs.indexOf(tab);
    this.tabs.splice(i, 1);
    view.destroy();
    if (this.active === tab) this.activate(this.tabs[Math.max(0, i - 1)] || this.homeTab);
    else this.renderTabs();
    return true;
  }

  async requestQuit() {
    for (const tab of [...this.tabs]) {
      if (tab.kind !== 'doc') continue;
      const ok = await this.closeTab(tab);
      if (!ok) return;
    }
    window.api.confirmClose();
  }

  // "Save" on the web: the document is built and handed to the browser as a
  // download. Pages that were not paid for yet are charged first.
  async save(view, saveAs = false) {
    if (!view) return false;
    view.overlay.commitEditing();
    view.closeNotePopup();
    const s = view.session;
    let path = s.filePath;
    if (saveAs || !path || s.isNewUnsaved) {
      path = await window.api.dialog.save({ defaultPath: path || `${stripExt(s.name)}.pdf`, filters: [{ name: t('filter.pdf'), extensions: ['pdf'] }], ask: saveAs });
      if (!path) return false;
    }
    if (!/\.pdf$/i.test(path)) path += '.pdf';
    // Downloading a document that was not changed costs nothing.
    const ticket = s.dirty ? await authorize(s, s.state.pages, 'download') : null;
    if (s.dirty && !ticket) return false;
    try {
      const built = await withBusy(t('file.saving'), (busy) => s.buildBytes({ onProgress: (f) => busy.set(f * 0.9, t('file.saving')) }));
      if (ticket && !(await ticket.commit())) return false;
      const res = await withBusy(t('file.saving'), async () => {
        await s.finishSave(path, built.bytes);
        return { warnings: built.warnings, size: built.bytes.length };
      });
      window.api.recent.add(path);
      view.thumbs.clear();
      await view.viewer.rebuild();
      view.thumbGrid.render();
      if (view.mode === 'organize') view.organizer.render();
      view.updateBanner();
      this.renderTabs();
      this.renderRibbon();
      toast(t('file.saved', { name: basename(path), size: formatBytes(res.size) }), { type: 'success' });
      if (res.warnings && res.warnings.length) {
        console.warn('save warnings', res.warnings);
        if (res.warnings.some((w) => w.startsWith('redact-partial-image'))) toast(t('redact.partialImageWarning'), { type: 'error', timeout: 7000 });
      }
      return true;
    } catch (e) {
      console.error(e);
      alertDialog(t('error.saveFailed', { message: errorMessage(e) }));
      return false;
    }
  }

  undo() {
    const doc = this.activeDoc;
    if (!doc) return;
    doc.overlay.commitEditing();
    doc.session.undo();
  }

  redo() {
    const doc = this.activeDoc;
    if (!doc) return;
    doc.session.redo();
  }

  // ------------------------------------------------------------------ global events

  bindGlobal() {
    this.dropOverlay = h('div', { class: 'drop-overlay' }, h('div', { class: 'drop-overlay-card' }, icon('upload'), h('div', null, t('web.dropHere'))));
    document.body.appendChild(this.dropOverlay);
    document.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('dragover', (e) => {
      if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
        e.preventDefault();
        if (this.active.kind === 'home') this.drop.classList.add('over');
      }
    });
    document.addEventListener('dragover', (e) => {
      if (e.dataTransfer && e.dataTransfer.types.includes('Files') && this.active.kind !== 'home' && !isDialogOpen()) this.dropOverlay.classList.add('show');
    });
    document.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget) {
        this.drop.classList.remove('over');
        this.dropOverlay.classList.remove('show');
      }
    });
    document.addEventListener('drop', async (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;
      if (e.defaultPrevented) return;
      e.preventDefault();
      this.drop.classList.remove('over');
      this.dropOverlay.classList.remove('show');
      const files = [...e.dataTransfer.files];
      const paths = files.map((f) => window.api.pathForFile(f)).filter(Boolean);
      if (paths.length) await this.openPaths(paths);
      else {
        for (const f of files) {
          if (/\.pdf$/i.test(f.name)) await this.openBytes(new Uint8Array(await f.arrayBuffer()), { name: f.name, isNew: true });
        }
      }
    });
    document.addEventListener('drop', () => this.dropOverlay.classList.remove('show'), true);
    // Leaving the page with changes that were not downloaded asks first.
    window.addEventListener('beforeunload', (e) => {
      if (this.skipLeaveGuard || !this.tabs.some((tb) => tb.kind === 'doc' && tb.view.session.dirty)) return undefined;
      e.preventDefault();
      e.returnValue = t('web.leaveUnsaved');
      return e.returnValue;
    });
  }

  onKey(e) {
    if (isDialogOpen()) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const target = e.target;
    const inInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
    const doc = this.activeDoc;
    if (ctrl && k === 'o') {
      e.preventDefault();
      this.openDialog();
      return;
    }
    if (ctrl && (k === 's' || k === 'p') && inInput && target !== document.body) {
      // Commit a value being typed into a field (fires its change event).
      target.blur();
    }
    if (ctrl && k === 's') {
      e.preventDefault();
      if (doc) this.save(doc, e.shiftKey);
      return;
    }
    if (ctrl && k === 'p') {
      e.preventDefault();
      if (doc) this.features.print.open(doc);
      return;
    }
    if (ctrl && k === 'w') {
      e.preventDefault();
      if (doc) this.closeTab(this.active);
      return;
    }
    if (ctrl && e.key === 'Tab') {
      e.preventDefault();
      const i = this.tabs.indexOf(this.active);
      const n = this.tabs.length;
      this.activate(this.tabs[(i + (e.shiftKey ? n - 1 : 1)) % n]);
      return;
    }
    if (!doc) return;
    // Zoom keys always act on the document (never on the browser's own
    // zoom), also while a form field has the focus.
    if (ctrl && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      doc.viewer.zoomIn();
      return;
    }
    if (ctrl && e.key === '-') {
      e.preventDefault();
      doc.viewer.zoomOut();
      return;
    }
    if (ctrl && e.key === '0') {
      e.preventDefault();
      doc.viewer.setZoomMode('page-fit');
      return;
    }
    if (inInput && !(ctrl && (k === 'f'))) return;
    if (ctrl && k === 'z' && !e.shiftKey) {
      e.preventDefault();
      this.undo();
      return;
    }
    if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) {
      e.preventDefault();
      this.redo();
      return;
    }
    if (ctrl && k === 'f') {
      e.preventDefault();
      const sel = window.getSelection().toString();
      doc.togglePanel('search', true);
      doc.search.focus(sel && sel.length < 100 ? sel : undefined);
      return;
    }
    if (doc.handleKey(e)) {
      e.preventDefault();
      closeMenu();
    }
  }
}

export { pdfjsLib };
