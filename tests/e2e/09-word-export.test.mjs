// "To Word" keeps the page layout: tables, text positions, pictures.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { launchApp, closeBrowser, ensureFixtures, fileUrl, FIXTURES, OUT, queueDialog, waitToast, waitDownload, clearToasts, appErrors } from './launch.mjs';
import { makeSheet } from '../fixtures/word-sheet.mjs';
import { checkWordXml, parseXml, find, child, textOf } from '../unit/ooxml-check.mjs';

const ACTIVE = '.doc-view:not(.hidden)';
const sheetPath = path.join(OUT, '09-sheet.pdf');
let ctx;
before(async () => {
  await ensureFixtures();
  fs.writeFileSync(sheetPath, (await makeSheet()).bytes);
  ctx = await launchApp({ files: [sheetPath] });
  await ctx.page.waitForSelector(`${ACTIVE} .page canvas`, { timeout: 20000 });
});
after(async () => {
  await ctx?.app.close();
  await closeBrowser();
});

async function exportWord(page, out) {
  fs.rmSync(out, { force: true });
  await clearToasts(page);
  await page.click('.ribbon-tab[data-rtab="convert"]');
  await queueDialog(page, out);
  await page.click('.rb-btn[data-cmd="toWord"]');
  await waitToast(page, /\.docx/, 60000);
  await waitDownload(ctx, out);
  const zip = unzipSync(new Uint8Array(fs.readFileSync(out)));
  const xml = strFromU8(zip['word/document.xml']);
  assert.deepEqual(checkWordXml(xml), []);
  assert.deepEqual(checkWordXml(strFromU8(zip['word/styles.xml'])), []);
  return { zip, document: parseXml(xml) };
}

test('exports a ruled sheet as a real table', async () => {
  const { page } = ctx;
  const { zip, document } = await exportWord(page, path.join(OUT, '09-sheet.docx'));
  assert.equal(find(document, 'w:pgSz').length, 2);
  assert.equal(find(document, 'w:pgSz')[0].attrs['w:orient'], 'landscape');
  const tables = find(document, 'w:tbl');
  assert.equal(tables.length, 1);
  const rows = tables[0].children.filter((c) => c.name === 'w:tr');
  assert.deepEqual(
    rows.map((tr) => tr.children.filter((c) => c.name === 'w:tc').map(textOf)),
    [
      ['TT', 'Nội dung công việc', 'Yêu cầu kỹ thuật'],
      ['1', 'Kiểm tra hệ thống thủy lực', 'Không rò dầu,không nứt vỡ'],
      ['2', 'Tháo lọc khỏi giảm tốc chính', ''],
      ['Tổng cộng: 2 hạng mục', ''],
    ],
  );
  assert.deepEqual(child(tables[0], 'w:tblGrid').children.map((c) => c.attrs['w:w']), ['1000', '6200', '5600']);
  assert.equal(find(tables[0], 'w:gridSpan')[0].attrs['w:val'], '2');
  assert.equal(find(tables[0], 'w:vMerge').length, 2);
  // the embedded fonts are named after the Word families
  assert.ok(find(document, 'w:rFonts').every((f) => ['Times New Roman', 'Arial'].includes(f.attrs['w:ascii'])) || strFromU8(zip['word/styles.xml']).includes('Times New Roman'));
  assert.ok(zip['word/media/image1.png'] || zip['word/media/image1.jpeg'], 'the picture is embedded');
  assert.deepEqual(appErrors(ctx.logs), []);
});

test('unsaved edits are part of the export', async () => {
  const { page } = ctx;
  // Rotate the second page; the export must follow the document as edited.
  await page.evaluate(() => {
    const doc = window.__app.activeDoc;
    doc.session.rotatePages([doc.session.state.pages[1].uid], 90);
  });
  await page.waitForTimeout(300);
  const { document } = await exportWord(page, path.join(OUT, '09-sheet-rotated.docx'));
  const sizes = find(document, 'w:pgSz').map((s) => [parseInt(s.attrs['w:w'], 10), parseInt(s.attrs['w:h'], 10)]);
  assert.equal(sizes.length, 2);
  assert.ok(sizes[1][0] > sizes[1][1], `second page is landscape after rotation: ${sizes[1]}`);
  const boxes = find(document, 'wps:wsp').filter((w) => /Second page heading|Plain paragraph/.test(textOf(w)));
  assert.ok(boxes.length >= 3, 'the lines of the turned page are vertical text boxes');
  for (const b of boxes) assert.match(find(b, 'wps:bodyPr')[0].attrs.vert, /^vert(270)?$/);
  assert.deepEqual(appErrors(ctx.logs), []);
});

test('other documents convert without errors', async () => {
  const { page } = ctx;
  for (const name of ['libreoffice.pdf', 'images.pdf', 'unicode.pdf']) {
    // (written by LibreOffice when the fixtures are generated)
    if (!fs.existsSync(path.join(FIXTURES, name))) continue;
    await page.evaluate((p) => window.__app.openPaths([p]), fileUrl(path.join(FIXTURES, name)));
    await page.waitForFunction((n) => window.__app.activeDoc && window.__app.activeDoc.session.name === n, name, { timeout: 20000 });
    await page.waitForSelector(`${ACTIVE} .page canvas`, { timeout: 20000 });
    const { document } = await exportWord(page, path.join(OUT, `09-${name.replace('.pdf', '.docx')}`));
    assert.ok(find(document, 'w:p').length > 2, name);
    if (name === 'libreoffice.pdf') assert.match(find(document, 'w:p').map(textOf).join('\n'), /Second paragraph in English/);
  }
  assert.deepEqual(appErrors(ctx.logs), []);
});
