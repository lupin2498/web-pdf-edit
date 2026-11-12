// Command line PDF -> DOCX conversion (same engine as the app); used for
// testing:  node scripts/pdf2docx.mjs input.pdf output.docx [pages e.g. 1-3,5]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { convertPdfToDocx, PDFJS_CONVERT_OPTIONS } from '../src/core/convert/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'node_modules', 'pdfjs-dist');

export async function openForConversion(bytes, password) {
  return pdfjs.getDocument({
    data: bytes.slice(),
    password,
    verbosity: 0,
    standardFontDataUrl: `${dist}/standard_fonts/`,
    cMapUrl: `${dist}/cmaps/`,
    cMapPacked: true,
    wasmUrl: `${dist}/wasm/`,
    iccUrl: `${dist}/iccs/`,
    ...PDFJS_CONVERT_OPTIONS,
  }).promise;
}

export async function pdfToDocx(bytes, options = {}) {
  const pdf = await openForConversion(bytes, options.password);
  try {
    return await convertPdfToDocx(pdf, { OPS: pdfjs.OPS, ...options });
  } finally {
    await pdf.loadingTask.destroy().catch(() => {});
  }
}

function parsePages(spec, n) {
  if (!spec) return null;
  const out = [];
  for (const part of spec.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) continue;
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    for (let i = a; i <= Math.min(b, n); i++) out.push(i - 1);
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [input, output, pagesSpec] = process.argv.slice(2);
  if (!input || !output) {
    console.error('usage: node scripts/pdf2docx.mjs input.pdf output.docx [pages]');
    process.exit(2);
  }
  const bytes = new Uint8Array(fs.readFileSync(input));
  const t0 = Date.now();
  const pdf = await openForConversion(bytes);
  const pages = parsePages(pagesSpec, pdf.numPages);
  const docx = await convertPdfToDocx(pdf, { OPS: pdfjs.OPS, pages, title: path.basename(input, '.pdf') });
  fs.writeFileSync(output, docx);
  console.log(`${path.basename(output)}: ${docx.length} bytes, ${(pages || { length: pdf.numPages }).length} page(s), ${Date.now() - t0} ms`);
  await pdf.loadingTask.destroy().catch(() => {});
}
