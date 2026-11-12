import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from '@cantoo/pdf-lib';
import { parseContentStream, PdfName, PdfString, PdfDictValue, buildContentStream } from '../../src/core/content-stream.js';
import { analyzePageContent, applyContentEdits } from '../../src/core/content-editor.js';
import { allImages, allTextRuns } from '../../src/core/interpreter.js';
import fs from 'node:fs';
import path from 'node:path';
import { ensureFixtures, fixture, pdfText, wordBoxes, findWord, approx, writeOut, FIXTURES } from './helpers.mjs';

const enc = new TextEncoder();

test('parser handles operands, strings, names and inline images', () => {
  const src = enc.encode(
    '% comment\nq 1 0 0 1 -.5 +3. cm /F#231 12 Tf (a\\(b\\)\\\\c\\101\\\nd) Tj <48 65 6c6C 6F> Tj [(A) -120 (B)] TJ ' +
      '/Span <</MCID 3 /Alt (x)>> BDC EMC BI /W 2 /H 2 /CS /G /BPC 8 ID \x00\x01\x02\x03 EI Q',
  );
  const ops = parseContentStream(src);
  const names = ops.map((o) => o.op);
  assert.deepEqual(names, ['q', 'cm', 'Tf', 'Tj', 'Tj', 'TJ', 'BDC', 'EMC', 'BI', 'Q']);
  assert.deepEqual(ops[1].args, [1, 0, 0, 1, -0.5, 3]);
  assert.ok(ops[2].args[0] instanceof PdfName);
  assert.equal(ops[2].args[0].name, 'F#1');
  assert.equal(new TextDecoder('latin1').decode(ops[3].args[0].bytes), 'a(b)\\cAd');
  assert.equal(new TextDecoder().decode(ops[4].args[0].bytes), 'Hello');
  assert.ok(ops[4].args[0] instanceof PdfString && ops[4].args[0].hex);
  assert.equal(ops[5].args[0].length, 3);
  assert.ok(ops[6].args[1] instanceof PdfDictValue);
  assert.equal(ops[6].args[1].get('MCID'), 3);
  assert.equal(ops[8].args[1].length, 4);
  // Untouched ops are copied verbatim.
  const rebuilt = buildContentStream(ops, src);
  const again = parseContentStream(rebuilt);
  assert.deepEqual(again.map((o) => o.op), names);
});

test('inline image with binary data containing EI-like bytes', () => {
  const data = new Uint8Array([0x45, 0x49, 0x20, 0x41, 0x42, 0x43]);
  const head = enc.encode('BI /W 6 /H 1 /CS /G /BPC 8 ID ');
  const tail = enc.encode(' EI 0 g');
  const src = new Uint8Array(head.length + data.length + tail.length);
  src.set(head);
  src.set(data, head.length);
  src.set(tail, head.length + data.length);
  const ops = parseContentStream(src);
  assert.deepEqual(ops.map((o) => o.op), ['BI', 'g']);
  assert.equal(ops[0].args[1].length, 6);
});

async function load(name, opts) {
  await ensureFixtures();
  return PDFDocument.load(fixture(name), opts);
}

async function removeWords(name, words, pageIndex = 0, pad = 0.5) {
  const bytes = fixture(name);
  const before = wordBoxes(bytes, pageIndex + 1);
  const regions = words.map((w) => {
    const found = findWord(before, w);
    assert.ok(found, `word ${w} not found in ${name}`);
    const r = found.rect;
    return [r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad];
  });
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(pageIndex);
  const stats = await applyContentEdits(doc, page, { removeTextRegions: regions });
  const out = await doc.save();
  return { before, after: wordBoxes(out, pageIndex + 1), out, stats };
}

test('removes a word drawn with a standard font and keeps neighbours in place', async () => {
  await ensureFixtures();
  const { before, after, out, stats } = await removeWords('standard.pdf', ['REMOVEME']);
  writeOut('standard-removed.pdf', out);
  assert.ok(stats.glyphsRemoved >= 8, `removed ${stats.glyphsRemoved}`);
  const text = pdfText(out, { page: 1 });
  assert.ok(!text.includes('REMOVEME'));
  assert.ok(text.includes('KEEPME'));
  assert.ok(text.includes('words.'));
  for (const w of ['KEEPME', 'words.', 'quick', 'Third']) {
    const a = findWord(before, w);
    const b = findWord(after, w);
    assert.ok(b, `${w} missing after edit`);
    assert.ok(approx(a.rect[0], b.rect[0]) && approx(a.rect[1], b.rect[1]), `${w} moved`);
  }
  // Other pages are untouched.
  assert.ok(pdfText(out, { page: 2 }).includes('REMOVEME'));
});

test('removes glyphs from an Identity-H (two byte) Unicode font', async () => {
  const { before, after, out, stats } = await removeWords('unicode.pdf', ['CẦNXÓA']);
  writeOut('unicode-removed.pdf', out);
  assert.ok(stats.glyphsRemoved >= 6);
  const text = pdfText(out);
  assert.ok(!text.includes('CẦNXÓA'));
  assert.ok(text.includes('giữa câu.'));
  const a = findWord(before, 'giữa');
  const b = findWord(after, 'giữa');
  assert.ok(approx(a.rect[0], b.rect[0]), 'following word must not move');
});

test("handles TJ arrays, ' and \" operators, Tz and Tc", async () => {
  const { before, after, out } = await removeWords('operators.pdf', ['AAA', 'BBB', 'CCC']);
  writeOut('operators-removed.pdf', out);
  const text = pdfText(out);
  for (const w of ['AAA', 'BBB', 'CCC']) assert.ok(!text.includes(w), `${w} still present`);
  for (const w of ['Kerned', 'Quote', 'Double', 'endS']) {
    const a = findWord(before, w);
    const b = findWord(after, w);
    assert.ok(b, `${w} missing`);
    assert.ok(approx(a.rect[0], b.rect[0]) && approx(a.rect[1], b.rect[1]), `${w} moved`);
  }
});

test('handles horizontal scaling and character spacing (Tz/Tc)', async () => {
  const bytes = fixture('operators.pdf');
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);
  const model = analyzePageContent(doc, page);
  const runs = allTextRuns(model).map((r) => r.run);
  const scaled = runs[runs.length - 1];
  assert.equal(scaled.th, 1.5);
  assert.equal(scaled.tc, 1);
  // Remove the glyphs "DDD" (indices 7..9 of "Scaled DDD text").
  const g = scaled.glyphs.slice(7, 10);
  const region = [Math.min(...g.map((x) => x.bbox[0])) + 0.5, g[0].bbox[1], Math.max(...g.map((x) => x.bbox[2])) - 0.5, g[0].bbox[3]];
  const beforeText = scaled.glyphs[11];
  await applyContentEdits(doc, page, { removeTextRegions: [region] }, model);
  const out = await doc.save();
  const doc2 = await PDFDocument.load(out);
  const model2 = analyzePageContent(doc2, doc2.getPage(0));
  const runs2 = allTextRuns(model2).map((r) => r.run);
  const scaled2 = runs2[runs2.length - 1];
  assert.equal(scaled2.glyphs.length, scaled.glyphs.length - 3);
  const t2 = scaled2.glyphs.find((x) => x.code === 't'.charCodeAt(0));
  assert.ok(approx(t2.cx, beforeText.cx, 0.01), 'glyph after removed text must keep its position');
});

test('rewrites text inside form XObjects without touching outside text', async () => {
  const { out, stats } = await removeWords('forms.pdf', ['inside']);
  writeOut('forms-removed.pdf', out);
  assert.equal(stats.formsRewritten, 1);
  const text = pdfText(out);
  assert.ok(!text.includes('inside'));
  assert.ok(text.includes('Text outside form'));
  assert.ok(text.includes('a form XObject'));
});

test('edits text in a LibreOffice generated document', async (t) => {
  await ensureFixtures();
  if (!fs.existsSync(path.join(FIXTURES, 'libreoffice.pdf'))) return t.skip('LibreOffice (soffice) is not installed');
  const { before, after, out } = await removeWords('libreoffice.pdf', ['words']);
  writeOut('libreoffice-removed.pdf', out);
  const text = pdfText(out);
  assert.ok(text.includes('bold'));
  assert.ok(!/bold words/.test(text));
  const a = findWord(before, 'testing.');
  const b = findWord(after, 'testing.');
  assert.ok(b && approx(a.rect[0], b.rect[0]) && approx(a.rect[1], b.rect[1]));
});

test('image delete, move and redaction', async () => {
  const doc = await load('images.pdf');
  const page = doc.getPage(0);
  const model = analyzePageContent(doc, page);
  const imgs = allImages(model);
  assert.equal(imgs.length, 2);
  const [first, second] = imgs;
  assert.ok(approx(first.image.bbox[0], 100) && approx(first.image.bbox[2], 300));
  await applyContentEdits(
    doc,
    page,
    {
      imageEdits: [
        { path: first.path, action: 'delete' },
        { path: second.path, action: 'transform', matrix: [1, 0, 0, 1, 50, 60] },
      ],
    },
    model,
  );
  const out = await doc.save();
  writeOut('images-edited.pdf', out);
  const doc2 = await PDFDocument.load(out);
  const imgs2 = allImages(analyzePageContent(doc2, doc2.getPage(0)));
  assert.equal(imgs2.length, 1);
  assert.ok(approx(imgs2[0].image.bbox[0], 400) && approx(imgs2[0].image.bbox[1], 160), JSON.stringify(imgs2[0].image.bbox));

  // Redaction covering the remaining image removes it, and also text under it.
  const page2 = doc2.getPage(0);
  const stats = await applyContentEdits(doc2, page2, { redactRegions: [[390, 150, 520, 280], [60, 700, 400, 760]] });
  assert.equal(stats.imagesRemoved, 1);
  const out2 = await doc2.save();
  const doc3 = await PDFDocument.load(out2);
  assert.equal(allImages(analyzePageContent(doc3, doc3.getPage(0))).length, 0);
  assert.ok(!pdfText(out2, { page: 1 }).includes('Image page'));
});

test('redaction removes covered vector paths only', async () => {
  const doc = await load('standard.pdf');
  const page = doc.getPage(0);
  const model = analyzePageContent(doc, page);
  const rectPath = model.paths.find((p) => approx(p.bbox[0], 72) && approx(p.bbox[1], 500));
  assert.ok(rectPath, 'rectangle path found');
  const stats = await applyContentEdits(doc, page, { redactRegions: [[60, 490, 290, 610]] });
  assert.equal(stats.pathsRemoved, 1);
  const out = await doc.save();
  const doc2 = await PDFDocument.load(out);
  const model2 = analyzePageContent(doc2, doc2.getPage(0));
  assert.ok(!model2.paths.find((p) => approx(p.bbox[0], 72) && approx(p.bbox[1], 500)));
  assert.ok(pdfText(out, { page: 1 }).includes('quick brown fox'));
});
