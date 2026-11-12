import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, PDFName, PDFDict } from '@cantoo/pdf-lib';
import { launchApp, closeBrowser, ensureFixtures, FIXTURES, OUT, ROOT, queueDialog, docState, waitToast, waitDownload, clearToasts, pageBox, appErrors } from './launch.mjs';

const ACTIVE = '.doc-view:not(.hidden)';
let ctx;
before(async () => {
  await ensureFixtures();
  ctx = await launchApp({ files: [path.join(FIXTURES, 'forms.pdf')] });
  await ctx.page.waitForSelector(`${ACTIVE} .page canvas`, { timeout: 20000 });
});
after(async () => {
  await ctx?.app.close();
  await closeBrowser();
});

const objects = async (page) => (await docState(page)).pages[0].objects;
const textInput = `${ACTIVE} .annotationLayer .textWidgetAnnotation input`;
const checkbox = `${ACTIVE} .annotationLayer .buttonWidgetAnnotation.checkBox input`;

test('fills a text field and a checkbox', async () => {
  const { page } = ctx;
  await page.waitForSelector(textInput, { timeout: 10000 });
  await page.fill(textInput, 'Lê Thị Hồng Nhung');
  await page.check(checkbox);
  await page.keyboard.press('Tab');
  assert.ok((await docState(page)).dirty);
});

test('filled values survive re-rendering the page', async () => {
  const { page } = ctx;
  await page.click(`${ACTIVE} .viewer`, { position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+=');
  await page.waitForTimeout(1200);
  await page.waitForSelector(textInput);
  assert.equal(await page.inputValue(textInput), 'Lê Thị Hồng Nhung');
  assert.equal(await page.isChecked(checkbox), true);
  // The check box shows its checked appearance.
  const shown = await page.$eval(`${ACTIVE} .annotationLayer .buttonWidgetAnnotation.checkBox canvas[data-canvas-name="checked"]`, (c) => getComputedStyle(c).display);
  assert.equal(shown, 'block');
  // Focus and blur must not bring back the original value.
  await page.focus(textInput);
  await page.keyboard.press('Tab');
  assert.equal(await page.inputValue(textInput), 'Lê Thị Hồng Nhung');
  await page.keyboard.press('Control+0');
  await page.waitForTimeout(800);
});

test('the field highlight can be switched off and on', async () => {
  const { page } = ctx;
  const tint = () => page.$eval(textInput, (e) => getComputedStyle(e).backgroundImage !== 'none');
  assert.equal(await tint(), true);
  await page.click('.ribbon-tab[data-rtab="form"]');
  await page.click('.rb-btn[data-cmd="highlightFields"]');
  assert.equal(await tint(), false);
  await page.click('.rb-btn[data-cmd="highlightFields"]');
  assert.equal(await tint(), true);
  await page.click('.ribbon-tab[data-rtab="home"]');
});

test('moves an existing annotation', async () => {
  const { page } = ctx;
  const el = page.locator(`${ACTIVE} .obj.existing-annot`).first();
  await el.waitFor({ timeout: 5000 });
  const b = await el.boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + 3);
  await page.waitForSelector(`${ACTIVE} .sel-box .move-area`);
  const mb = await page.locator(`${ACTIVE} .sel-box .move-area`).boundingBox();
  await page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2);
  await page.mouse.down();
  await page.mouse.move(mb.x + mb.width / 2 + 60, mb.y + mb.height / 2 + 40, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const edits = Object.values((await docState(page)).pages[0].annotEdits || {});
  assert.equal(edits.length, 1);
  assert.ok(edits[0].dx > 30 && edits[0].dy < -20, JSON.stringify(edits[0]));
});

test('adds an image', async () => {
  const { page } = ctx;
  await queueDialog(page, [path.join(ROOT, 'tests', 'fixtures', 'sample.png')]);
  await page.click('.rb-btn[data-cmd="addImage"]');
  await page.waitForTimeout(500);
  const pb = await pageBox(page);
  await page.mouse.click(pb.x + 400, pb.y + 150);
  await page.waitForTimeout(400);
  assert.equal((await objects(page)).filter((o) => o.type === 'image').length, 1);
});

test('creates and places a typed signature', async () => {
  const { page } = ctx;
  await page.click('.ribbon-tab[data-rtab="comment"]');
  await page.click('.rb-btn[data-cmd="signature"]');
  await page.click('.menu-item >> nth=-1');
  await page.waitForSelector('.modal');
  await page.click('.modal .seg button >> nth=1');
  await page.fill('.modal input.input', 'Nguyễn Văn A');
  await page.click('.modal .btn.primary');
  await page.waitForTimeout(300);
  const pb = await pageBox(page);
  // An empty spot inside the visible part of the page.
  await page.mouse.click(pb.x + 150, pb.y + 230);
  await page.waitForTimeout(400);
  assert.equal((await objects(page)).filter((o) => o.type === 'signature').length, 1);
});

test('creates a web link', async () => {
  const { page } = ctx;
  await page.click('.ribbon-tab[data-rtab="edit"]');
  await page.click('.rb-btn[data-cmd="link"]');
  const pb = await pageBox(page);
  await page.mouse.move(pb.x + 90, pb.y + 140);
  await page.mouse.down();
  await page.mouse.move(pb.x + 250, pb.y + 170, { steps: 4 });
  await page.mouse.up();
  await page.waitForSelector('.modal');
  await page.fill('.modal input.input >> nth=0', 'example.com');
  await page.click('.modal .btn.primary');
  await page.waitForTimeout(300);
  const link = (await objects(page)).find((o) => o.type === 'link');
  assert.equal(link?.action?.url, 'https://example.com');
});

let saved;
test('saves form values, moved annotation, image, signature and link', async () => {
  const { page } = ctx;
  saved = path.join(OUT, '06-forms.pdf');
  fs.rmSync(saved, { force: true });
  await queueDialog(page, saved);
  await page.keyboard.press('Control+Shift+S');
  await waitToast(page, /06-forms/);
  await waitDownload(ctx, saved);
  const doc = await PDFDocument.load(fs.readFileSync(saved));
  const form = doc.getForm();
  assert.equal(form.getTextField('name').getText(), 'Lê Thị Hồng Nhung');
  assert.equal(form.getCheckBox('agree').isChecked(), true);
  const annots = doc.getPage(0).node.Annots().asArray().map((r) => doc.context.lookup(r, PDFDict));
  const square = annots.find((a) => a.get(PDFName.of('Subtype')).toString() === '/Square');
  const rect = square.get(PDFName.of('Rect')).asArray().map((n) => n.asNumber());
  assert.ok(rect[0] > 320 && rect[1] < 290, `moved square rect ${rect}`);
  const link = annots.find((a) => a.get(PDFName.of('Subtype')).toString() === '/Link');
  assert.match(link.lookup(PDFName.of('A'), PDFDict).get(PDFName.of('URI')).toString(), /example\.com/);
});

test('converts to Word, text and images', async () => {
  const { page } = ctx;
  await clearToasts(page);
  await page.click('.ribbon-tab[data-rtab="convert"]');
  const docx = path.join(OUT, '06-forms.docx');
  const txt = path.join(OUT, '06-forms.txt');
  const imgDir = path.join(OUT, '06-images');
  const png = path.join(OUT, '06-forms_001.png');
  for (const f of [docx, txt, png]) fs.rmSync(f, { force: true });
  await queueDialog(page, docx);
  await page.click('.rb-btn[data-cmd="toWord"]');
  await waitToast(page, /\.docx/);
  await queueDialog(page, txt);
  await page.click('.rb-btn[data-cmd="toText"]');
  await waitToast(page, /\.txt/);
  await queueDialog(page, imgDir);
  await page.click('.rb-btn[data-cmd="toImage"]');
  await page.waitForSelector('.modal');
  await page.click('.modal .btn.primary');
  await page.waitForFunction(() => document.querySelectorAll('.toast.success').length >= 3, null, { timeout: 30000 });
  await waitDownload(ctx, docx);
  await waitDownload(ctx, txt);
  assert.equal(fs.readFileSync(docx).subarray(0, 2).toString(), 'PK');
  assert.match(fs.readFileSync(txt, 'utf8'), /Text outside form/);
  // A single page is downloaded as the image itself (several pages as a ZIP).
  await waitDownload(ctx, png);
  assert.deepEqual([...fs.readFileSync(png).subarray(1, 4)].map((c) => String.fromCharCode(c)).join(''), 'PNG');
});

test('prints through the system dialog', async () => {
  const { page } = ctx;
  await page.click(`${ACTIVE} .viewer`, { position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+p');
  await page.waitForSelector('.modal');
  await page.click('.modal .btn.primary');
  await page.waitForFunction(() => !document.querySelector('.busy-overlay, .modal'), null, { timeout: 30000 });
});

test('flattens form fields', async () => {
  const { page } = ctx;
  await page.click('.ribbon-tab[data-rtab="form"]');
  await page.click('.rb-btn[data-cmd="flattenForm"]');
  await page.waitForTimeout(300);
  if (await page.$('.modal')) await page.click('.modal .btn.primary');
  await page.waitForTimeout(1500);
  const out = path.join(OUT, '06-flattened.pdf');
  fs.rmSync(out, { force: true });
  await queueDialog(page, out);
  await page.keyboard.press('Control+Shift+S');
  await waitToast(page, /06-flattened/);
  await waitDownload(ctx, out);
  const doc = await PDFDocument.load(fs.readFileSync(out));
  assert.equal(doc.getForm().getFields().length, 0);
});

test('no errors were logged', () => {
  assert.deepEqual(appErrors(ctx.logs), []);
});
