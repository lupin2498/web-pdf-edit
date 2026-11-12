import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, PDFName, PDFDict } from '@cantoo/pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildPdf, buildPagePreview, readOutline } from '../../src/core/builder.js';
import { ensureFixtures, fixture, pdfText, wordBoxes, findWord, approx, writeOut, ROOT } from './helpers.mjs';
import { nodeFontRegistry, assetStore } from './node-env.mjs';

const registry = nodeFontRegistry();
let uid = 0;
const entry = (doc, index, extra = {}) => ({ uid: `p${++uid}`, src: { doc, index }, rotate: 0, objects: [], removals: [], imageEdits: [], annotEdits: {}, ...extra });
const pagesOf = (doc, n) => Array.from({ length: n }, (_, i) => entry(doc, i));

async function build(opts) {
  return buildPdf({ registry, assets: assetStore(opts.assetMap || {}), ...opts });
}

async function pdfjsDoc(bytes, password) {
  return pdfjs.getDocument({
    data: new Uint8Array(bytes),
    password,
    standardFontDataUrl: path.join(ROOT, 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/',
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
}

function pageTexts(bytes, n) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push(pdfText(bytes, { page: i }).trim());
  return out;
}

test('reorder, delete, duplicate and rotate pages', async () => {
  await ensureFixtures();
  const src = fixture('ten-pages.pdf');
  const pages = [entry('a', 2), entry('a', 0, { rotate: 90 }), entry('a', 0), entry('a', 9, { rotate: 270 })];
  const { bytes, warnings } = await build({ sources: { a: { bytes: src } }, baseId: 'a', pages });
  assert.deepEqual(warnings, []);
  writeOut('reordered.pdf', bytes);
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 4);
  assert.deepEqual(pageTexts(bytes, 4), ['PAGE-3', 'PAGE-1', 'PAGE-1', 'PAGE-10']);
  assert.deepEqual(doc.getPages().map((p) => p.getRotation().angle), [0, 90, 0, 270]);
  assert.ok(bytes.length < src.length, `deleted pages should shrink file (${bytes.length} vs ${src.length})`);
});

test('combine documents with page ranges and per-file bookmarks', async () => {
  await ensureFixtures();
  const sources = {
    s1: { bytes: fixture('standard.pdf') },
    s2: { bytes: fixture('unicode.pdf') },
    s3: { bytes: fixture('images.pdf') },
  };
  const pages = [entry('s1', 0), entry('s1', 2), entry('s2', 0), entry('s3', 1), entry('s3', 2)];
  const outline = [
    { title: 'standard.pdf', pageUid: pages[0].uid, children: [] },
    { title: 'unicode – tiếng Việt.pdf', pageUid: pages[2].uid, children: [{ title: 'Con', pageUid: pages[2].uid }] },
    { title: 'images.pdf', pageUid: pages[3].uid, children: [] },
  ];
  const { bytes, warnings } = await build({ sources, baseId: null, pages, outline });
  assert.deepEqual(warnings, []);
  writeOut('combined.pdf', bytes);
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 5);
  const texts = pageTexts(bytes, 5);
  assert.ok(texts[0].includes('Page 1 heading'));
  assert.ok(texts[1].includes('Page 3 heading'));
  assert.ok(texts[2].includes('Tiêu đề tài liệu'));
  assert.ok(texts[3].includes('Landscape'));
  assert.ok(texts[4].includes('Rotated page text'));
  assert.equal(doc.getPage(4).getRotation().angle, 90);
  const ol = readOutline(doc);
  assert.deepEqual(
    ol.map((o) => [o.title, o.pageIndex]),
    [
      ['standard.pdf', 0],
      ['unicode – tiếng Việt.pdf', 2],
      ['images.pdf', 3],
    ],
  );
  assert.equal(ol[1].children[0].title, 'Con');
});

test('blank pages, crop box and metadata', async () => {
  await ensureFixtures();
  const pages = [entry('a', 0, { crop: [50, 50, 300, 400] }), { uid: 'blank1', src: null, blank: { width: 300, height: 200 }, rotate: 0, objects: [] }];
  const { bytes } = await build({
    sources: { a: { bytes: fixture('standard.pdf') } },
    baseId: 'a',
    pages,
    meta: { title: 'Tiêu đề mới', author: 'Tác giả', subject: 'S', keywords: 'a, b' },
  });
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  assert.equal(doc.getPageCount(), 2);
  const cb = doc.getPage(0).getCropBox();
  assert.deepEqual([cb.x, cb.y, cb.width, cb.height], [50, 50, 250, 350]);
  const size = doc.getPage(1).getSize();
  assert.deepEqual([size.width, size.height], [300, 200]);
  assert.equal(doc.getTitle(), 'Tiêu đề mới');
  assert.equal(doc.getAuthor(), 'Tác giả');
  assert.equal(doc.getProducer(), 'PDF Edit');
});

test('adds Vietnamese text boxes, images and edits existing text', async () => {
  await ensureFixtures();
  const src = fixture('standard.pdf');
  const before = wordBoxes(src, 1);
  const target = findWord(before, 'REMOVEME');
  const assetMap = {
    jpg: { bytes: new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests/fixtures/sample.jpg'))), mime: 'image/jpeg' },
    png: { bytes: new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests/fixtures/sample.png'))), mime: 'image/png' },
  };
  const page = entry('a', 0, {
    removals: [{ id: 'r1', region: [target.rect[0] - 1, target.rect[1] - 1, target.rect[2] + 1, target.rect[3] + 1] }],
    objects: [
      { id: 't1', type: 'text', rect: [target.rect[0], target.rect[1] - 3, target.rect[0] + 120, target.rect[3] + 3], rot: 0, text: 'ĐÃSỬA', size: 12, color: [0, 0, 0.8], font: { family: 'Liberation Sans' } },
      { id: 't2', type: 'text', rect: [72, 300, 400, 380], rot: 0, text: 'Văn bản tiếng Việt có dấu: ắ ằ ẳ ẵ ặ ơ ư đ. Dòng này đủ dài để tự xuống dòng trong khung.', size: 14, font: { family: 'Liberation Serif', bold: true, italic: true }, color: [0.6, 0, 0] },
      { id: 't3', type: 'text', rect: [72, 200, 300, 240], rot: 90, text: 'Xoay 90', size: 12, font: { family: 'Liberation Mono' } },
      { id: 'i1', type: 'image', rect: [400, 600, 528, 696], rot: 0, asset: 'jpg' },
      { id: 'i2', type: 'image', rect: [400, 450, 480, 530], rot: 0, asset: 'png', opacity: 0.5 },
      { id: 'w1', type: 'whiteout', rect: [72, 655, 140, 672] },
    ],
  });
  const { bytes, warnings } = await build({ sources: { a: { bytes: src } }, baseId: 'a', pages: [page], assetMap });
  assert.deepEqual(warnings, []);
  writeOut('text-objects.pdf', bytes);
  const text = pdfText(bytes, { page: 1 });
  assert.ok(!text.includes('REMOVEME'), 'original word removed');
  assert.ok(text.includes('ĐÃSỬA'), 'replacement text present');
  assert.ok(text.includes('tiếng Việt có dấu'), 'Vietnamese text extracted');
  assert.ok(text.replace(/\s+/g, ' ').includes('Xoay 90'));
  const after = wordBoxes(bytes, 1);
  const repl = findWord(after, 'ĐÃSỬA');
  assert.ok(repl && approx(repl.rect[0], target.rect[0], 2), 'replacement at original position');
  const wrapped = after.filter((w) => w.rect[1] > 290 && w.rect[3] < 390);
  const lines = new Set(wrapped.map((w) => Math.round(w.rect[1])));
  assert.ok(lines.size >= 2, 'long text wraps into several lines');
  assert.ok(wrapped.every((w) => w.rect[2] <= 401), 'wrapped text stays inside the box');
});

test('creates annotations of every type readable by pdf.js', async () => {
  await ensureFixtures();
  const objects = [
    { id: 'h', type: 'highlight', rects: [[72, 695, 300, 712]], color: [1, 1, 0], opacity: 0.5, contents: 'Ghi chú highlight' },
    { id: 'u', type: 'underline', rects: [[72, 675, 200, 692]], color: [0, 0.6, 0] },
    { id: 's', type: 'strikeout', rects: [[72, 655, 200, 672]], color: [1, 0, 0] },
    { id: 'q', type: 'squiggly', rects: [[210, 655, 300, 672]], color: [0, 0, 1] },
    { id: 'n', type: 'note', rect: [500, 750, 520, 770], color: [1, 0.8, 0.2], contents: 'Nhận xét: cần sửa' },
    { id: 'f', type: 'freetext', rect: [300, 500, 500, 560], text: 'Hộp văn bản bình luận', size: 12, color: [0, 0, 0], border: [1, 0, 0], fill: [1, 1, 0.8] },
    { id: 'r', type: 'rect', rect: [100, 100, 200, 160], stroke: [1, 0, 0], width: 2 },
    { id: 'e', type: 'ellipse', rect: [220, 100, 320, 160], stroke: [0, 0, 1], fill: [0.8, 0.9, 1], width: 1.5, dash: true },
    { id: 'l', type: 'line', p1: [100, 200], p2: [300, 220], stroke: [0, 0, 0], width: 1 },
    { id: 'a', type: 'arrow', p1: [100, 240], p2: [300, 260], stroke: [1, 0, 0], width: 2, endHead: 'ClosedArrow' },
    { id: 'pl', type: 'polyline', points: [[350, 100], [400, 150], [450, 100]], stroke: [0, 0.5, 0], width: 2 },
    { id: 'pg', type: 'polygon', points: [[350, 200], [400, 250], [450, 200]], stroke: [0.5, 0, 0.5], fill: [1, 0.9, 1], width: 1 },
    { id: 'i', type: 'ink', paths: [[[100, 300], [120, 320], [140, 310], [160, 330]], [[100, 340], [160, 340]]], stroke: [0, 0, 0], width: 2 },
    { id: 'st', type: 'stamp', rect: [350, 300, 500, 350], label: 'ĐÃ DUYỆT', subLabel: '26/10/2026', color: [0, 0.5, 0] },
    { id: 'lk', type: 'link', rect: [72, 750, 200, 770], action: { type: 'url', url: 'https://example.com' } },
    { id: 'rd', type: 'redact', rect: [400, 400, 500, 420] },
  ];
  const pages = [entry('a', 0, { objects }), entry('a', 1)];
  pages[0].objects.push({ id: 'lk2', type: 'link', rect: [72, 720, 200, 740], action: { type: 'page', pageUid: pages[1].uid } });
  const { bytes, warnings } = await build({ sources: { a: { bytes: fixture('standard.pdf') } }, baseId: 'a', pages, author: 'Người kiểm thử' });
  assert.deepEqual(warnings, []);
  writeOut('annotations.pdf', bytes);
  const doc = await pdfjsDoc(bytes);
  const annots = await (await doc.getPage(1)).getAnnotations();
  const subtypes = annots.map((a) => a.subtype).sort();
  assert.deepEqual(
    subtypes,
    ['Circle', 'FreeText', 'Highlight', 'Ink', 'Line', 'Line', 'Link', 'Link', 'PolyLine', 'Polygon', 'Redact', 'Square', 'Squiggly', 'Stamp', 'StrikeOut', 'Text', 'Underline'].sort(),
  );
  const note = annots.find((a) => a.subtype === 'Text');
  assert.equal(note.contentsObj.str, 'Nhận xét: cần sửa');
  assert.equal(note.titleObj.str, 'Người kiểm thử');
  const link = annots.find((a) => a.subtype === 'Link' && a.url);
  assert.equal(link.url, 'https://example.com/');
  const pageLink = annots.find((a) => a.subtype === 'Link' && !a.url);
  assert.ok(pageLink.dest, 'internal link has destination');
  const idx = await doc.getPageIndex(pageLink.dest[0]);
  assert.equal(idx, 1);
  // Appearance streams exist for all but links.
  const lib = await PDFDocument.load(bytes);
  const arr = lib.getPage(0).node.Annots();
  let withAp = 0;
  for (let i = 0; i < arr.size(); i++) if (lib.context.lookup(arr.get(i)).get(PDFName.of('AP'))) withAp++;
  assert.equal(withAp, objects.filter((o) => o.type !== 'link').length);
});

test('edits and deletes existing annotations, fills forms', async () => {
  await ensureFixtures();
  const src = fixture('forms.pdf');
  const jsDoc = await pdfjsDoc(src);
  const annots = await (await jsDoc.getPage(1)).getAnnotations();
  const square = annots.find((a) => a.subtype === 'Square');
  const textWidget = annots.find((a) => a.fieldType === 'Tx');
  const checkWidget = annots.find((a) => a.fieldType === 'Btn' && a.checkBox);
  assert.ok(square && textWidget && checkWidget);
  const pages = [entry('a', 0, { annotEdits: { [square.id]: { dx: 10, dy: -20, contents: 'Đã sửa nội dung' } } }), entry('a', 0, { annotEdits: { [square.id]: { deleted: true } } })];
  const formValues = { a: { [textWidget.id]: { value: 'Trần Văn Ơn' }, [checkWidget.id]: { value: true } } };
  const { bytes, warnings } = await build({ sources: { a: { bytes: src } }, baseId: 'a', pages, formValues });
  assert.deepEqual(warnings, []);
  writeOut('forms-edited.pdf', bytes);
  const out = await pdfjsDoc(bytes);
  const a1 = await (await out.getPage(1)).getAnnotations();
  const a2 = await (await out.getPage(2)).getAnnotations();
  const sq1 = a1.find((a) => a.subtype === 'Square');
  assert.ok(sq1, 'square kept on first page');
  assert.ok(approx(sq1.rect[0], square.rect[0] + 10) && approx(sq1.rect[1], square.rect[1] - 20));
  assert.equal(sq1.contentsObj.str, 'Đã sửa nội dung');
  assert.ok(!a2.find((a) => a.subtype === 'Square'), 'square deleted on duplicate page');
  const tx = a1.find((a) => a.fieldType === 'Tx');
  assert.equal(tx.fieldValue, 'Trần Văn Ơn');
  const cb = a1.find((a) => a.fieldType === 'Btn' && a.checkBox);
  assert.notEqual(cb.fieldValue, 'Off');
  // Both pages carry widgets; the form has a consistent field list.
  const lib = await PDFDocument.load(bytes);
  const form = lib.getForm();
  const names = form.getFields().map((f) => f.getName());
  assert.ok(names.includes('name'));
  assert.equal(form.getTextField('name').getText(), 'Trần Văn Ơn');
  assert.ok(pdfText(bytes, { page: 1 }).includes('Trần Văn Ơn'));
});

test('encrypts output and opens encrypted sources', async () => {
  await ensureFixtures();
  const { bytes } = await build({
    sources: { a: { bytes: fixture('standard.pdf') } },
    baseId: 'a',
    pages: [entry('a', 0)],
    security: { userPassword: 'mở123', ownerPassword: 'chủ456', permissions: { printing: true, copying: false } },
  });
  writeOut('encrypted-out.pdf', bytes);
  await assert.rejects(() => pdfjsDoc(bytes));
  const opened = await pdfjsDoc(bytes, 'mở123');
  assert.equal(opened.numPages, 1);
  // Encrypted input -> decrypted output.
  const { bytes: dec } = await build({ sources: { e: { bytes: fixture('encrypted.pdf'), password: 'secret' } }, baseId: 'e', pages: [entry('e', 0)] });
  const d = await pdfjsDoc(dec);
  assert.equal(d.numPages, 1);
  assert.ok(pdfText(dec).includes('Secret document content'));
});

test('page preview applies content edits only', async () => {
  await ensureFixtures();
  const src = fixture('standard.pdf');
  const target = findWord(wordBoxes(src, 1), 'REMOVEME');
  const bytes = await buildPagePreview({
    sourceBytes: src,
    pageIndex: 0,
    entry: { removals: [{ region: target.rect }], objects: [{ type: 'text', rect: [0, 0, 10, 10], text: 'X' }] },
    assets: assetStore(),
    cache: new Map(),
  });
  const text = pdfText(bytes);
  assert.ok(!text.includes('REMOVEME'));
  assert.ok(text.includes('KEEPME'));
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 1);
});

test('copying a page with form fields twice keeps fields consistent', async () => {
  await ensureFixtures();
  const pages = [entry('f', 0), entry('f', 0), entry('s', 0)];
  const { bytes, warnings } = await build({ sources: { f: { bytes: fixture('forms.pdf') }, s: { bytes: fixture('standard.pdf') } }, baseId: 's', pages });
  assert.deepEqual(warnings, []);
  const lib = await PDFDocument.load(bytes);
  assert.equal(lib.getPageCount(), 3);
  const fields = lib.getForm().getFields();
  assert.ok(fields.length >= 2);
  const js = await pdfjsDoc(bytes);
  for (let p = 1; p <= 2; p++) {
    const annots = await (await js.getPage(p)).getAnnotations();
    assert.ok(annots.some((a) => a.fieldType === 'Tx'), `page ${p} has the text field widget`);
  }
});
