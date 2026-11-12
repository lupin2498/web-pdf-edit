import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, PDFName, PDFDict } from '@cantoo/pdf-lib';
import { launchApp, closeBrowser, ensureFixtures, FIXTURES, OUT, queueDialog, docState, waitToast, waitDownload, pageBox, appErrors } from './launch.mjs';

const ACTIVE = '.doc-view:not(.hidden)';
let ctx;
before(async () => {
  await ensureFixtures();
  ctx = await launchApp({ files: [path.join(FIXTURES, 'standard.pdf')] });
  await ctx.page.waitForSelector(`${ACTIVE} .page canvas`, { timeout: 20000 });
  await ctx.page.waitForTimeout(500);
  await ctx.page.click('.ribbon-tab[data-rtab="comment"]');
});
after(async () => {
  await ctx?.app.close();
  await closeBrowser();
});

const objects = async (page) => (await docState(page)).pages[0].objects;
const countType = async (page, type) => (await objects(page)).filter((o) => o.type === type).length;

async function useTool(page, cmd) {
  await page.click(`.rb-btn[data-cmd="${cmd}"]`);
  await page.waitForFunction((c) => window.__app.activeDoc.tools.tool === c, cmd === 'freetext' ? 'freetext' : cmd);
}

async function dragOnPage(page, from, to, steps = 6) {
  const pb = await pageBox(page);
  await page.mouse.move(pb.x + from[0], pb.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(pb.x + to[0], pb.y + to[1], { steps });
  await page.mouse.up();
  await page.waitForTimeout(250);
}

async function selectText(page, text, fraction = 0.6) {
  const span = page.locator(`${ACTIVE} .page`).first().locator('.textLayer span', { hasText: text }).first();
  const b = await span.boundingBox();
  await page.mouse.move(b.x + 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * fraction, b.y + b.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}

async function annotSubtypes(file) {
  const doc = await PDFDocument.load(fs.readFileSync(file));
  return doc.getPages().map((p) => {
    const annots = p.node.Annots();
    if (!annots) return [];
    return annots.asArray().map((ref) => doc.context.lookup(ref, PDFDict).get(PDFName.of('Subtype')).toString().slice(1));
  });
}

test('highlight, underline and strikeout selected text', async () => {
  const { page } = ctx;
  await useTool(page, 'highlight');
  await selectText(page, 'quick brown');
  assert.equal(await countType(page, 'highlight'), 1);
  await useTool(page, 'underline');
  await selectText(page, 'Second line');
  assert.equal(await countType(page, 'underline'), 1);
  await useTool(page, 'strikeout');
  await selectText(page, 'Third line');
  assert.equal(await countType(page, 'strikeout'), 1);
});

test('draws shapes, lines and freehand ink', async () => {
  const { page } = ctx;
  await useTool(page, 'rect');
  await dragOnPage(page, [100, 330], [240, 400]);
  await useTool(page, 'ellipse');
  await dragOnPage(page, [260, 330], [400, 400]);
  await useTool(page, 'line');
  await dragOnPage(page, [100, 430], [250, 430]);
  await useTool(page, 'arrow');
  await dragOnPage(page, [280, 430], [420, 470]);
  await useTool(page, 'ink');
  const pb = await pageBox(page);
  await page.mouse.move(pb.x + 100, pb.y + 520);
  await page.mouse.down();
  for (let i = 0; i < 20; i++) await page.mouse.move(pb.x + 100 + i * 8, pb.y + 520 + Math.sin(i / 2) * 20);
  await page.mouse.up();
  await page.waitForTimeout(300);
  const types = (await objects(page)).map((o) => o.type);
  for (const t of ['rect', 'ellipse', 'line', 'arrow', 'ink']) assert.ok(types.includes(t), `${t} missing: ${types}`);
});

test('draws a polygon with clicks and Enter', async () => {
  const { page } = ctx;
  await useTool(page, 'polygon');
  const pb = await pageBox(page);
  for (const [x, y] of [[450, 520], [520, 520], [490, 580]]) await page.mouse.click(pb.x + x, pb.y + y);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const poly = (await objects(page)).find((o) => o.type === 'polygon');
  assert.ok(poly);
  assert.equal(poly.points.length, 3);
});

test('adds a sticky note with a comment', async () => {
  const { page } = ctx;
  await useTool(page, 'note');
  const pb = await pageBox(page);
  await page.mouse.click(pb.x + 500, pb.y + 100);
  await page.waitForSelector('.note-popup textarea');
  await page.keyboard.type('Ghi chú kiểm thử');
  await page.click('.note-popup .icon-btn');
  await page.waitForTimeout(300);
  const note = (await objects(page)).find((o) => o.type === 'note');
  assert.equal(note?.contents, 'Ghi chú kiểm thử');
});

test('adds a text box comment', async () => {
  const { page } = ctx;
  await useTool(page, 'freetext');
  await dragOnPage(page, [300, 620], [520, 680], 4);
  await page.waitForSelector('.text-editor');
  await page.keyboard.type('Hộp văn bản có dấu tiếng Việt');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const ft = (await objects(page)).find((o) => o.type === 'freetext');
  assert.equal(ft?.text, 'Hộp văn bản có dấu tiếng Việt');
});

test('places a stamp', async () => {
  const { page } = ctx;
  await page.click('.rb-btn[data-cmd="stamp"]');
  await page.click('.menu-item >> nth=0');
  const pb = await pageBox(page);
  await page.mouse.click(pb.x + 450, pb.y + 250);
  await page.waitForTimeout(300);
  assert.equal(await countType(page, 'stamp'), 1);
});

test('comments panel lists the annotations', async () => {
  const { page } = ctx;
  await page.click('.rb-btn[data-cmd="commentsPanel"]');
  await page.waitForSelector(`${ACTIVE} .comment-item`, { timeout: 5000 });
  const n = await page.$$eval(`${ACTIVE} .comment-item`, (els) => els.length);
  assert.ok(n >= 10, `only ${n} comments listed`);
});

test('selects and deletes an object with the Delete key', async () => {
  const { page } = ctx;
  await page.click('.ribbon-tab[data-rtab="home"]');
  await useTool(page, 'select');
  const before = (await objects(page)).length;
  const pb = await pageBox(page);
  // The rectangle border at its left edge.
  await page.mouse.click(pb.x + 101, pb.y + 365);
  await page.waitForSelector(`${ACTIVE} .sel-box`, { timeout: 3000 });
  await page.keyboard.press('Delete');
  await page.waitForTimeout(300);
  const after = await objects(page);
  assert.equal(after.length, before - 1);
  assert.equal(after.filter((o) => o.type === 'rect').length, 0);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  assert.equal((await objects(page)).length, before);
});

let saved;
test('saves annotations as standard PDF annotations', async () => {
  const { page } = ctx;
  saved = path.join(OUT, '03-annotations.pdf');
  fs.rmSync(saved, { force: true });
  await queueDialog(page, saved);
  await page.keyboard.press('Control+Shift+S');
  await waitToast(page, /03-annotations/);
  await waitDownload(ctx, saved);
  const [p1] = await annotSubtypes(saved);
  for (const st of ['Highlight', 'Underline', 'StrikeOut', 'Square', 'Circle', 'Line', 'Ink', 'Polygon', 'Text', 'FreeText', 'Stamp']) {
    assert.ok(p1.includes(st), `${st} missing in ${p1}`);
  }
  assert.equal(p1.filter((s) => s === 'Line').length, 2);
});

test('reopened annotations are listed and editable', async () => {
  const { page } = ctx;
  await page.click('.doc-view:not(.hidden) .viewer');
  await page.keyboard.press('Control+w');
  await page.waitForFunction(() => !window.__app.activeDoc, null, { timeout: 5000 });
  await queueDialog(page, [saved]);
  await page.keyboard.press('Control+o');
  await page.waitForSelector(`${ACTIVE} .page canvas`, { timeout: 20000 });
  await page.waitForSelector(`${ACTIVE} .obj.existing-annot`, { timeout: 10000 });
  const n = await page.$$eval(`${ACTIVE} .obj.existing-annot`, (els) => els.length);
  assert.ok(n >= 11, `${n} existing annotations`);
});

test('no errors were logged', () => {
  assert.deepEqual(appErrors(ctx.logs), []);
});
