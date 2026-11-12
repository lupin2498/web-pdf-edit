// PDF -> Word conversion with the page layout preserved.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { unzipSync, strFromU8 } from 'fflate';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pdfToDocx, openForConversion } from '../../scripts/pdf2docx.mjs';
import { layoutDocument, buildLayoutDocx } from '../../src/core/convert/index.js';
import { buildPageModel } from '../../src/core/convert/page-model.js';
import { classifyPaths, detectTables } from '../../src/core/convert/lattice.js';
import { lineTokens, alignmentOf } from '../../src/core/convert/layout.js';
import { fitFonts, buildWords } from '../../src/core/convert/text-lines.js';
import { mapFont } from '../../src/core/convert/font-map.js';
import { encodePngRgba, encodePngRgb, encodePngGray1, encodeMaskPng } from '../../src/core/convert/png.js';
import { checkWordXml, parseXml, find, child, textOf } from './ooxml-check.mjs';
import { makeSheet } from '../fixtures/word-sheet.mjs';
import { ensureFixtures, fixture, writeOut, hasPoppler, FIXTURES } from './helpers.mjs';

// Written by LibreOffice when the fixtures are generated; absent where it is not installed.
const hasLibreOfficeFixture = () => fs.existsSync(path.join(FIXTURES, 'libreoffice.pdf'));

const TW = 20; // twips per point

function unzipDocx(bytes) {
  const zip = unzipSync(bytes);
  const part = (name) => strFromU8(zip[name]);
  return { zip, part, document: parseXml(part('word/document.xml')) };
}

function assertValid(bytes) {
  const { zip, part } = unzipDocx(bytes);
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/settings.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml', 'docProps/app.xml']) {
    assert.ok(zip[name], `${name} is missing`);
    parseXml(part(name));
  }
  for (const name of ['word/document.xml', 'word/styles.xml', 'word/settings.xml']) assert.deepEqual(checkWordXml(part(name)), [], name);
  const rels = part('word/_rels/document.xml.rels');
  for (const m of rels.matchAll(/Target="([^"]+)"/g)) assert.ok(zip[`word/${m[1]}`], `relationship target ${m[1]} is missing`);
  for (const m of part('word/document.xml').matchAll(/r:embed="([^"]+)"/g)) assert.ok(rels.includes(`Id="${m[1]}"`), `relationship ${m[1]} is missing`);
}

const num = (el, attr) => parseInt(el.attrs[attr], 10);

test('converts a ruled sheet into a real table with exact geometry', async () => {
  const { bytes, xs, ys, t } = await makeSheet();
  writeOut('convert-sheet.pdf', bytes);
  const docx = await pdfToDocx(bytes, { title: 'sheet' });
  writeOut('convert-sheet.docx', docx);
  assertValid(docx);
  const { zip, document } = unzipDocx(docx);

  // one section per page, same page sizes
  const sizes = find(document, 'w:pgSz');
  assert.equal(sizes.length, 2);
  assert.deepEqual([num(sizes[0], 'w:w'), num(sizes[0], 'w:h'), sizes[0].attrs['w:orient']], [842 * TW, 595 * TW, 'landscape']);
  assert.deepEqual([num(sizes[1], 'w:w'), num(sizes[1], 'w:h')], [595 * TW, 842 * TW]);

  // the table
  const tables = find(document, 'w:tbl');
  assert.equal(tables.length, 1);
  const tbl = tables[0];
  const grid = child(tbl, 'w:tblGrid').children.map((c) => num(c, 'w:w'));
  assert.deepEqual(grid, [(xs[1] - xs[0]) * TW, (xs[2] - xs[1]) * TW, (xs[3] - xs[2]) * TW]);
  const rows = tbl.children.filter((c) => c.name === 'w:tr');
  assert.equal(rows.length, 4);
  rows.forEach((tr, j) => {
    const h = find(tr, 'w:trHeight')[0];
    assert.equal(h.attrs['w:hRule'], 'exact');
    assert.ok(Math.abs(num(h, 'w:val') - (ys[j + 1] - ys[j]) * TW) <= 1, `row ${j} height`);
  });
  const cells = rows.map((tr) => tr.children.filter((c) => c.name === 'w:tc'));
  assert.deepEqual(cells.map((r) => r.length), [3, 3, 3, 2]);
  assert.deepEqual(cells.map((r) => r.map(textOf)), [
    ['TT', 'Nội dung công việc', 'Yêu cầu kỹ thuật'],
    ['1', 'Kiểm tra hệ thống thủy lực', 'Không rò dầu,không nứt vỡ'],
    ['2', 'Tháo lọc khỏi giảm tốc chính', ''],
    ['Tổng cộng: 2 hạng mục', ''],
  ]);
  // merged cells
  assert.equal(find(cells[3][0], 'w:gridSpan')[0].attrs['w:val'], '2');
  assert.equal(find(cells[1][2], 'w:vMerge')[0].attrs['w:val'], 'restart');
  assert.equal(find(cells[2][2], 'w:vMerge').length, 1);
  assert.equal(find(cells[2][2], 'w:vMerge')[0].attrs['w:val'], undefined);
  // header shading and borders
  for (const tc of cells[0]) assert.match(find(tc, 'w:shd')[0].attrs['w:fill'], /^D[89A]E[5-7]F[1-3]$/);
  const b = find(cells[1][1], 'w:tcBorders')[0];
  assert.deepEqual(b.children.map((c) => c.name), ['w:top', 'w:left', 'w:bottom', 'w:right']);
  assert.equal(b.children[0].attrs['w:sz'], String(Math.round(t * 8)));
  // the merged cell has no rule between its two rows
  assert.equal(child(find(cells[1][2], 'w:tcBorders')[0], 'w:bottom'), null);
  // header cells are centred, body text is not
  for (const tc of cells[0]) assert.equal(find(tc, 'w:jc')[0].attrs['w:val'], 'center');
  assert.equal(find(cells[1][1], 'w:jc').length, 0);

  // one paragraph per text line with an exact line height
  const twoLines = cells[1][2].children.filter((c) => c.name === 'w:p');
  assert.equal(twoLines.length, 2);
  for (const p of twoLines) assert.equal(find(p, 'w:spacing')[0].attrs['w:lineRule'], 'exact');
  // second line: its box starts where the first one ends plus the gap between them
  const sp = twoLines.map((p) => child(child(p, 'w:pPr'), 'w:spacing'));
  const pitch = num(sp[0], 'w:line') + num(sp[1], 'w:before');
  assert.ok(Math.abs(pitch - 15 * TW) <= 1, `line pitch ${pitch}`);

  // condensed text: a single run carrying the character spacing
  const runs = find(cells[2][1], 'w:r');
  assert.equal(runs.length, 1);
  assert.equal(find(runs[0], 'w:spacing')[0].attrs['w:val'], '-8');

  // the picture floats at its place
  assert.ok(zip['word/media/image1.png']);
  const pic = find(document, 'wp:anchor').find((a) => find(a, 'pic:pic').length);
  const off = find(pic, 'wp:posOffset').map((e) => parseInt(e.text, 10) / 12700);
  const ext = find(pic, 'wp:extent')[0];
  assert.ok(Math.abs(off[0] - 500) < 0.6 && Math.abs(off[1] - 360) < 0.6, `picture at ${off}`);
  assert.ok(Math.abs(num(ext, 'cx') / 12700 - 160) < 0.6 && Math.abs(num(ext, 'cy') / 12700 - 120) < 0.6);

  // text turned by 90 degrees becomes vertical text in a text box
  const box = find(document, 'wps:wsp').find((w) => textOf(w) === 'Chữ xoay dọc');
  assert.ok(box, 'rotated text box');
  assert.match(find(box, 'wps:bodyPr')[0].attrs.vert, /^vert(270)?$/);

  // free text keeps its position: left margin + indent, top margin + spacing
  const margins = find(document, 'w:pgMar');
  const body = find(document, 'w:body')[0].children;
  const heading = body.find((p) => p.name === 'w:p' && textOf(p) === 'Phiếu công nghệ số 12');
  const ind = find(heading, 'w:ind')[0];
  assert.ok(Math.abs(num(margins[0], 'w:left') + (ind ? num(ind, 'w:left') || 0 : 0) - 60 * TW) <= 2);
  assert.equal(find(heading, 'w:b').length > 0, true);

  // second page: plain lines, the centred one is centred
  const second = body.slice(body.findIndex((p) => find(p, 'w:sectPr').length) + 1);
  const texts = second.filter((p) => p.name === 'w:p').map(textOf).filter(Boolean);
  assert.deepEqual(texts, ['Second page heading', 'Plain paragraph line one.', 'Plain paragraph line two.', 'Centred line']);
  const centredLine = second.find((p) => textOf(p) === 'Centred line');
  assert.equal(find(centredLine, 'w:jc')[0].attrs['w:val'], 'center');
  const headingRun = find(second.find((p) => textOf(p) === 'Second page heading'), 'w:r')[0];
  assert.equal(find(headingRun, 'w:sz')[0].attrs['w:val'], '32');
  assert.equal(find(headingRun, 'w:rFonts')[0].attrs['w:ascii'], 'Arial');
});

test('baselines of flow text land where they are in the PDF', async () => {
  const { bytes } = await makeSheet();
  const docx = await pdfToDocx(bytes, { pages: [1] });
  const { document } = unzipDocx(docx);
  const mar = find(document, 'w:pgMar')[0];
  let y = num(mar, 'w:top');
  const baselines = {};
  for (const p of find(document, 'w:body')[0].children) {
    if (p.name !== 'w:p') continue;
    const sp = child(child(p, 'w:pPr'), 'w:spacing');
    y += num(sp, 'w:before');
    const line = num(sp, 'w:line');
    // the baseline sits at 80% of an exact line box
    if (textOf(p)) baselines[textOf(p)] = (y + 0.8 * line) / TW;
    y += line + num(sp, 'w:after');
  }
  assert.ok(Math.abs(baselines['Second page heading'] - 100) < 0.2, JSON.stringify(baselines));
  assert.ok(Math.abs(baselines['Plain paragraph line one.'] - 130) < 0.2);
  assert.ok(Math.abs(baselines['Plain paragraph line two.'] - 145) < 0.2);
  assert.ok(Math.abs(baselines['Centred line'] - 200) < 0.2);
  // the content fits on the page
  assert.ok(y + num(mar, 'w:bottom') <= 842 * TW);
});

test('page ranges, passwords and fixtures', async () => {
  await ensureFixtures();
  const ten = await pdfToDocx(fixture('ten-pages.pdf'), { pages: [0, 4, 9] });
  assertValid(ten);
  assert.equal(find(unzipDocx(ten).document, 'w:pgSz').length, 3);

  await assert.rejects(() => pdfToDocx(fixture('encrypted.pdf')));
  const enc = await pdfToDocx(fixture('encrypted.pdf'), { password: 'secret' });
  assertValid(enc);

  for (const name of ['standard.pdf', 'unicode.pdf', 'forms.pdf', 'images.pdf', 'operators.pdf', 'libreoffice.pdf']) {
    if (name === 'libreoffice.pdf' && !hasLibreOfficeFixture()) continue;
    const out = await pdfToDocx(fixture(name));
    assertValid(out);
    writeOut(`convert-${name.replace('.pdf', '.docx')}`, out);
  }
});

test('page model: character code 32 of a subset font is a letter, sizes follow the em', () => {
  const OPS = pdfjs.OPS;
  // 2048 units per em, as pdf.js reports TrueType outlines.
  const font = { name: 'ABCDEF+Inter-Bold', fontMatrix: [1 / 2048, 0, 0, 1 / 2048, 0, 0], ascent: 0.97, descent: -0.24, bold: true };
  const glyph = (unicode, width, isSpace = false) => ({ unicode, width, isSpace });
  // pdf.js flags the glyph at code 32 as "space" (the code word spacing
  // applies to) even when the subset font draws a letter there.
  const opList = {
    fnArray: [OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.setWordSpacing, OPS.showText, OPS.endText],
    argsArray: [null, ['f1', 24], [[1, 0, 0, 1, 72, 700]], [3], [[glyph('a', 1024), glyph('d', 1024, true), glyph(' ', 512), glyph('b', 1024)]], null],
  };
  const model = buildPageModel(opList, { OPS, getFont: () => font, transform: [1, 0, 0, -1, 0, 800], width: 600, height: 800 });
  assert.deepEqual(model.glyphs.map((g) => [g.s, g.space]), [['a', false], ['d', false], [' ', true], ['b', false]]);
  assert.deepEqual(model.glyphs.map((g) => g.size), [24, 24, 24, 24]);
  // advances of 12 pt; the word spacing follows the glyph at code 32
  assert.deepEqual(model.glyphs.map((g) => Math.round(g.x * 100) / 100), [72, 84, 99, 105]);
  assert.equal(Math.round(model.glyphs[0].y), 100);
  assert.equal(model.fonts[0].bold, true);
});

test('subset fonts: letters at character code 32 are not spaces, sizes follow the em', { skip: !hasLibreOfficeFixture() && 'LibreOffice (soffice) is not installed' }, async () => {
  await ensureFixtures();
  const { document } = unzipDocx(await pdfToDocx(fixture('libreoffice.pdf')));
  const paras = find(document, 'w:body')[0].children.filter((p) => p.name === 'w:p');
  const all = paras.map(textOf).join('\n');
  assert.match(all, /Second paragraph in English with some bold words and italic words for testing\./);
  assert.match(all, /Nội dung này dùng để kiểm tra/);
  // the heading is set in a font with 2048 units per em: 24 pt, not 11.7
  const heading = paras.find((p) => textOf(p) === 'Báo cáo kết quả kinh doanh');
  assert.ok(heading);
  assert.equal(find(heading, 'w:sz')[0].attrs['w:val'], '48');
  const boldRun = find(document, 'w:r').find((r) => textOf(r).includes('bold words'));
  assert.equal(find(boldRun, 'w:b').length, 1);
});

test('pages turned with /Rotate keep their text direction', async () => {
  await ensureFixtures();
  const { document } = unzipDocx(await pdfToDocx(fixture('images.pdf'), { pages: [2] }));
  const size = find(document, 'w:pgSz')[0];
  assert.ok(num(size, 'w:w') > num(size, 'w:h'), 'the rotated page is landscape');
  const box = find(document, 'wps:wsp').find((w) => textOf(w) === 'Rotated page text');
  assert.ok(box);
  assert.equal(find(box, 'wps:bodyPr')[0].attrs.vert, 'vert');
});

test('a page that cannot be analysed becomes a picture, the rest converts', async () => {
  await ensureFixtures();
  const pdf = await openForConversion(fixture('standard.pdf'));
  try {
    // The first page fails while its operators are read.
    let failures = 1;
    const OPS = new Proxy(pdfjs.OPS, {
      get(target, key) {
        if (key === 'showText' && failures-- > 0) throw new Error('boom');
        return target[key];
      },
    });
    await assert.rejects(() => layoutDocument(pdf, { OPS: new Proxy(pdfjs.OPS, { get: (t, k) => (k === 'showText' ? (() => { throw new Error('boom'); })() : t[k]) }), pages: [0] }), /boom/);
    const picture = new Uint8Array(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'fixtures', 'sample.png')));
    const pages = await layoutDocument(pdf, { OPS, renderPage: async () => ({ bytes: picture, ext: 'png' }) });
    assert.equal(pages.length, 3);
    assert.match(pages[0].stats.failed, /boom/);
    assert.deepEqual([pages[0].blocks.length, pages[0].floats.length, pages[0].floats[0].w], [0, 1, pages[0].width]);
    assert.ok(pages[1].blocks.length > 0 && !pages[1].stats.failed);
    const docx = buildLayoutDocx(pages, {});
    assertValid(docx);
    const { zip, document } = unzipDocx(docx);
    assert.ok(zip['word/media/image1.png']);
    assert.equal(find(document, 'w:pgSz').length, 3);
  } finally {
    await pdf.loadingTask.destroy().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// building blocks

const rectPath = (x0, y0, x1, y1, seq = 0) => ({ d: [['M', x0, y0], ['L', x1, y0], ['L', x1, y1], ['L', x0, y1], ['Z']], fill: '#000000', stroke: null, lw: 0, dash: null, alpha: 1, bbox: [x0, y0, x1, y1], clip: null, seq });
const linePath = (x0, y0, x1, y1, lw = 0.75, dash = null) => ({ d: [['M', x0, y0], ['L', x1, y1]], fill: null, stroke: '#000000', lw, dash, alpha: 1, bbox: [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)], clip: null, seq: 0 });

test('lattice: rules become a grid, missing rules merge cells', () => {
  const page = { width: 600, height: 800 };
  const paths = [];
  // 3 x 2 grid; the rule between the two cells of the first column is missing
  for (const y of [100, 200]) paths.push(rectPath(50, y - 0.25, 350, y + 0.25));
  paths.push(rectPath(150, 150 - 0.25, 350, 150 + 0.25));
  for (const x of [50, 150, 250, 350]) paths.push(rectPath(x - 0.25, 100, x + 0.25, 200));
  // a filled area that is not a rule, and a long thin rule elsewhere
  paths.push({ ...rectPath(400, 300, 500, 360), fill: '#ffcc00' });
  paths.push(rectPath(60, 500, 300, 500.6));
  const { rules, fills } = classifyPaths(paths, page);
  assert.equal(fills.length, 1);
  const { tables, lines } = detectTables(rules, page);
  assert.equal(tables.length, 1);
  const t = tables[0];
  assert.deepEqual(t.xs.map(Math.round), [50, 150, 250, 350]);
  assert.deepEqual(t.ys.map(Math.round), [100, 150, 200]);
  assert.equal(t.cells.length, 5);
  const merged = t.cells.find((c) => c.c0 === 0);
  assert.deepEqual([merged.r0, merged.r1], [0, 1]);
  assert.ok(merged.borders.top && merged.borders.bottom && merged.borders.left && merged.borders.right);
  assert.ok(Math.abs(merged.borders.top.t - 0.5) < 0.01);
  // the lone rule stays a line
  assert.equal(lines.length, 1);
  assert.ok(Math.abs(lines[0].pos - 500.3) < 0.01);
});

test('lattice: stroked and dashed lines, page frames are not tables', () => {
  const page = { width: 600, height: 800 };
  const paths = [];
  for (const y of [100, 130, 160]) paths.push(linePath(50, y, 250, y, 0.75, [3, 2]));
  for (const x of [50, 150, 250]) paths.push(linePath(x, 100, x, 160, 0.75, [3, 2]));
  const { tables } = detectTables(classifyPaths(paths, page).rules, page);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].cells.length, 4);
  assert.deepEqual(tables[0].cells[0].borders.top.dash, [3, 2]);
  // a frame around the whole page
  const frame = [linePath(20, 20, 580, 20), linePath(20, 780, 580, 780), linePath(20, 20, 20, 780), linePath(580, 20, 580, 780)];
  const framed = detectTables(classifyPaths(frame, page).rules, page);
  assert.equal(framed.tables.length, 0);
  assert.equal(framed.lines.length, 4);
});

// A line of words for lineTokens: [text, x0, naturalWidth, charSpacing]
function makeLine(words, { size = 10, space = 0.25 } = {}) {
  const font = { family: 'Times New Roman', space, spaceKnown: true };
  const style = { key: 's', family: 'Times New Roman', bold: false, italic: false, size, color: '#000000', scale: 100, font };
  const list = words.map(([text, x0, natural, cs = 0, spacesBefore = 1], i) => {
    const chars = Array.from(text).length;
    return { text, x0, x1: x0 + natural + cs * (chars - 1), chars, natural, spacesBefore: i ? spacesBefore : 0, rise: 0, runs: [{ text, style, natural, chars, pdfSize: size, pdfScale: 1 }] };
  });
  return { words: list, x0: list[0].x0, x1: list[list.length - 1].x1, y: 100, size, style };
}

test('line tokens: plain, condensed, justified and tabbed lines', () => {
  // plain: words and natural spaces -> all spacing zero
  const sw = 2.5;
  let x = 50;
  const plain = [];
  for (const w of [['Alpha', 22], ['beta', 18], ['gamma', 27]]) {
    plain.push([w[0], x, w[1]]);
    x += w[1] + sw;
  }
  let { tokens, hasTab } = lineTokens(makeLine(plain));
  assert.equal(hasTab, false);
  assert.deepEqual(tokens.map((t) => (t.t === 'text' ? t.spacing : t.extra)), [0, 0, 0, 0, 0]);

  // condensed by 0.4 pt: every character (the spaces too) carries -0.4
  x = 50;
  const cond = [];
  for (const w of [['Alpha', 22], ['beta', 18], ['gamma', 27]]) {
    cond.push([w[0], x, w[1], -0.4]);
    x += w[1] - 0.4 * w[0].length + sw - 0.4;
  }
  ({ tokens } = lineTokens(makeLine(cond)));
  assert.deepEqual(tokens.map((t) => (t.t === 'text' ? t.spacing : t.extra)), [-0.4, -0.4, -0.4, -0.4, -0.4]);

  // justified: the spaces are 3 pt wider, the words untouched
  x = 50;
  const just = [];
  for (const w of [['Alpha', 22], ['beta', 18], ['gamma', 27]]) {
    just.push([w[0], x, w[1]]);
    x += w[1] + sw + 3;
  }
  ({ tokens } = lineTokens(makeLine(just)));
  assert.deepEqual(tokens.map((t) => (t.t === 'text' ? t.spacing : t.extra)), [0, 3, 0, 3, 0]);

  // a wide gap is a tab to the exact position
  ({ tokens, hasTab } = lineTokens(makeLine([['Left', 50, 20], ['Right', 300, 24]])));
  assert.equal(hasTab, true);
  assert.deepEqual(tokens.map((t) => t.t), ['text', 'tab', 'text']);
  assert.equal(tokens[1].pos, 300);

  // positions never drift: the modelled end of the line is the real one
  x = 50;
  const drift = [];
  for (let i = 0; i < 40; i++) {
    drift.push([`w${i}`, x, 12]);
    x += 12 + sw + 0.12; // every gap a little too wide
  }
  const res = lineTokens(makeLine(drift));
  const last = drift[drift.length - 1];
  assert.ok(Math.abs(res.end - (last[1] + last[2])) < 0.5, `end ${res.end}`);
});

test('a replacement font is scaled to the widths of the original', () => {
  // PDF font "Foobar": every glyph 0.6 em wide; its replacement only 0.5 em.
  const rec = { name: 'Foobar', spaceWidth: 0.3 };
  const glyph = (ch, i) => ({ s: ch, x: 100 + i * 7.2, y: 200, w: 7.2, size: 12, hs: 1, ax: 1, ay: 0, font: rec, color: '#000000', space: false, seq: i });
  const glyphs = Array.from('Replacement', glyph);
  const resolveFont = () => ({ family: 'Arial', replaced: true });
  const measure = (text, style) => (style.font.replaced ? Array.from(text).length * 0.5 * style.size * (style.scale / 100) : 0);
  const fits = new Map();
  fitFonts(glyphs, { resolveFont, measure, fits });
  assert.equal(rec.word.fit, 1.2);
  assert.equal(fits.get('Foobar'), 1.2);
  const [word] = buildWords(glyphs, { resolveFont });
  assert.equal(word.runs[0].style.scale, 120);
  assert.equal(word.runs[0].style.family, 'Arial');
  // scaled, the word has its original width: no letter spacing is needed
  const line = { words: [word], x0: word.x0, x1: word.x1, y: 200, size: 12, style: word.runs[0].style };
  const { tokens } = lineTokens(line, { measure });
  assert.deepEqual(tokens.map((t) => t.spacing), [0]);
  // the same font on a later page keeps the factor, whatever its text there
  const rec2 = { name: 'Foobar', spaceWidth: 0.3 };
  fitFonts([{ ...glyph('i', 0), font: rec2, w: 3 }], { resolveFont, measure, fits });
  assert.equal(rec2.word.fit, 1.2);
  // fonts that are not replaced are left alone
  const rec3 = { name: 'TimesNewRomanPSMT', spaceWidth: 0.25 };
  fitFonts(Array.from('abcdef', (ch, i) => ({ ...glyph(ch, i), font: rec3 })), { resolveFont: null, measure, fits });
  assert.equal(rec3.word.fit, undefined);
});

test('alignment of a line inside its text area', () => {
  const p = (x, x1, hasTab = false) => ({ x, x1, hasTab });
  assert.equal(alignmentOf(p(100, 500), 100, 500), 'left'); // full line
  assert.equal(alignmentOf(p(250, 350), 100, 500), 'center');
  assert.equal(alignmentOf(p(380, 500), 100, 500), 'right');
  assert.equal(alignmentOf(p(130, 400), 100, 500), 'left');
  assert.equal(alignmentOf(p(250, 350, true), 100, 500), 'left');
});

test('font names map to Word families', () => {
  const m = (name, rec = {}) => mapFont(name, rec);
  assert.deepEqual([m('ABCDEF+TimesNewRomanPS-BoldMT').family, m('ABCDEF+TimesNewRomanPS-BoldMT').bold], ['Times New Roman', true]);
  assert.equal(m('Times New Roman,BoldItalic').italic, true);
  assert.equal(m('ArialMT').family, 'Arial');
  assert.equal(m('Helvetica-Oblique').family, 'Arial');
  assert.equal(m('Calibri-Light').family, 'Calibri Light');
  assert.equal(m('LiberationSerif').family, 'Times New Roman');
  assert.equal(m('Carlito').family, 'Calibri');
  assert.equal(m('OpenSymbol').family, 'Symbol');
  assert.equal(m('DejaVuSans-Bold').family, 'DejaVu Sans');
  // not a Windows font: the app replaces it when it is not installed
  assert.equal(m('DejaVuSans-Bold').known, false);
  assert.equal(m('Roboto-Regular').known, false);
  assert.equal(m('Calibri').known, true);
  assert.equal(m('OpenSans-SemiboldItalic').family, 'Open Sans Semibold');
  assert.equal(m('CMR10').family, 'Times New Roman');
  assert.equal(m('F1', { mono: true }).family, 'Courier New');
  assert.equal(m('', {}).family, 'Arial');
  const tnr = m('TimesNewRomanPSMT');
  assert.ok(tnr.ascent > 0.85 && tnr.descent > 0.2 && tnr.known);
});

function decodePng(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let pos = 8;
  let ihdr = null;
  const idat = [];
  while (pos < bytes.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    assert.equal(dv.getUint32(pos + 8 + len), zlib.crc32(bytes.subarray(pos + 4, pos + 8 + len)), `crc of ${type}`);
    if (type === 'IHDR') ihdr = { width: dv.getUint32(pos + 8), height: dv.getUint32(pos + 12), depth: data[8], color: data[9] };
    if (type === 'IDAT') idat.push(Buffer.from(data));
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = { 0: 1, 2: 3, 6: 4 }[ihdr.color];
  const stride = ihdr.depth === 1 ? (ihdr.width + 7) >> 3 : ihdr.width * channels;
  const bpp = ihdr.depth === 1 ? 1 : channels;
  const out = Buffer.alloc(stride * ihdr.height);
  for (let y = 0; y < ihdr.height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const left = x >= bpp ? out[y * stride + x - bpp] : 0;
      out[y * stride + x] = filter === 1 ? (v + left) & 0xff : v;
      assert.ok(filter === 0 || filter === 1);
    }
  }
  return { ...ihdr, pixels: out };
}

test('PNG encoder round-trips pixels', () => {
  const w = 70;
  const h = 5;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([(i * 7) & 255, (i * 13) & 255, (i * 29) & 255, i % 3 ? 255 : 128], i * 4);
  let png = decodePng(encodePngRgba(w, h, rgba));
  assert.deepEqual([png.width, png.height, png.color], [w, h, 6]);
  assert.deepEqual([...png.pixels], [...rgba]);
  // opaque colour -> RGB, opaque grey -> greyscale
  const opaque = rgba.slice();
  for (let i = 3; i < opaque.length; i += 4) opaque[i] = 255;
  png = decodePng(encodePngRgba(w, h, opaque));
  assert.equal(png.color, 2);
  assert.deepEqual([...png.pixels.subarray(0, 6)], [opaque[0], opaque[1], opaque[2], opaque[4], opaque[5], opaque[6]]);
  const rgb3 = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) rgb3.fill((i * 5) & 255, i * 3, i * 3 + 3);
  png = decodePng(encodePngRgb(w, h, rgb3));
  assert.equal(png.color, 0);
  assert.equal(png.pixels[9], rgb3[27]);
  // 1 bit per pixel
  const bits = new Uint8Array([0b10110000, 0b01000000]);
  png = decodePng(encodePngGray1(4, 2, bits));
  assert.deepEqual([png.depth, png.color, [...png.pixels]], [1, 0, [...bits]]);
  // stencil mask painted red: 0 bits are painted
  png = decodePng(encodeMaskPng(4, 1, new Uint8Array([0b01010000]), '#ff0000').bytes);
  assert.deepEqual([...png.pixels], [255, 0, 0, 255, 255, 0, 0, 0, 255, 0, 0, 255, 255, 0, 0, 0]);
});

// ---------------------------------------------------------------------------
// rendering check with LibreOffice (skipped where it is not installed)

function hasSoffice() {
  try {
    execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}

function wordsOf(pdfPath, page) {
  const html = execFileSync('pdftotext', ['-bbox', '-f', String(page), '-l', String(page), pdfPath, '-'], { encoding: 'utf8' });
  const out = [];
  for (const m of html.matchAll(/<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([^<]*)<\/word>/g)) out.push({ x0: +m[1], y1: +m[4], x1: +m[3], text: m[5] });
  return out;
}

test('LibreOffice renders the converted sheet like the PDF', { skip: !(hasPoppler() && hasSoffice()) && 'needs LibreOffice and poppler' }, async () => {
  const { bytes } = await makeSheet();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfedit-word-'));
  try {
    const src = path.join(dir, 'in.pdf');
    fs.writeFileSync(src, bytes);
    fs.writeFileSync(path.join(dir, 'out.docx'), await pdfToDocx(bytes));
    execFileSync('soffice', ['--headless', `-env:UserInstallation=file://${dir}/profile`, '--convert-to', 'pdf', '--outdir', dir, path.join(dir, 'out.docx')], { stdio: 'ignore', timeout: 120000 });
    const conv = path.join(dir, 'out.pdf');
    assert.ok(fs.existsSync(conv), 'LibreOffice produced a PDF');
    const pages = (p) => parseInt(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [p], { encoding: 'utf8' }))[1], 10);
    assert.equal(pages(conv), pages(src));
    for (const page of [1, 2]) {
      const a = wordsOf(src, page);
      const b = wordsOf(conv, page);
      assert.equal(b.length, a.length, `words on page ${page}`);
      for (const w of a) {
        // nearest word with the same text
        let best = Infinity;
        for (const v of b) if (v.text === w.text) best = Math.min(best, Math.hypot(v.x0 - w.x0, v.y1 - w.y1));
        assert.ok(best < 1.6, `"${w.text}" on page ${page} moved by ${best.toFixed(2)} pt`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
