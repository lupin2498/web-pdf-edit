import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'generated');
export const OUT = path.join(ROOT, 'tests', 'output');
fs.mkdirSync(OUT, { recursive: true });

let fixturesReady = null;
export async function ensureFixtures() {
  if (!fixturesReady) {
    fixturesReady = (async () => {
      if (!fs.existsSync(path.join(FIXTURES, 'ten-pages.pdf'))) {
        const mod = await import('../fixtures/make-fixtures.mjs');
        await mod.makeFixtures();
      }
    })();
  }
  return fixturesReady;
}

export function fixture(name) {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
}

export function writeOut(name, bytes) {
  const p = path.join(OUT, name);
  fs.writeFileSync(p, bytes);
  return p;
}

export function hasPoppler() {
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function pdfText(bytes, { page, password } = {}) {
  const tmp = path.join(os.tmpdir(), `pdfedit-${process.pid}-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(tmp, bytes);
  try {
    const args = [];
    if (password) args.push('-upw', password);
    if (page) args.push('-f', String(page), '-l', String(page));
    args.push(tmp, '-');
    return execFileSync('pdftotext', args, { encoding: 'utf8' });
  } finally {
    fs.unlinkSync(tmp);
  }
}

// Word boxes in PDF user space (origin bottom-left) for the given page (1-based).
export function wordBoxes(bytes, page = 1) {
  const tmp = path.join(os.tmpdir(), `pdfedit-${process.pid}-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(tmp, bytes);
  try {
    const html = execFileSync('pdftotext', ['-bbox', '-f', String(page), '-l', String(page), tmp, '-'], { encoding: 'utf8' });
    const pm = /<page width="([\d.]+)" height="([\d.]+)">/.exec(html);
    const height = pm ? parseFloat(pm[2]) : 842;
    const words = [];
    const re = /<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([^<]*)<\/word>/g;
    let m;
    while ((m = re.exec(html))) {
      const decoded = m[5].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      words.push({
        text: decoded,
        rect: [parseFloat(m[1]), height - parseFloat(m[4]), parseFloat(m[3]), height - parseFloat(m[2])],
      });
    }
    return words;
  } finally {
    fs.unlinkSync(tmp);
  }
}

export function findWord(words, text) {
  return words.find((w) => w.text === text);
}

export function approx(a, b, eps = 0.6) {
  return Math.abs(a - b) <= eps;
}
