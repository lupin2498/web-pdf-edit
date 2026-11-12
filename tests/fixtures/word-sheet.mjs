// A sheet like the ones Word produces, used by the PDF -> Word tests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb, degrees } from '@cantoo/pdf-lib';
import fontkit from '@cantoo/fontkit';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FONT_DIR = path.join(ROOT, 'src', 'assets', 'fonts');

// Sheet like the ones Word produces: a ruled table drawn with thin filled
// rectangles, merged cells, a shaded header, condensed text, a picture and
// rotated text; second page with plain text.
export async function makeSheet() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const serif = await doc.embedFont(fs.readFileSync(path.join(FONT_DIR, 'LiberationSerif-Regular.ttf')), { subset: true });
  const bold = await doc.embedFont(fs.readFileSync(path.join(FONT_DIR, 'LiberationSerif-Bold.ttf')), { subset: true });
  const W = 842;
  const H = 595;
  const page = doc.addPage([W, H]);
  const Y = (top) => H - top; // top-left coordinates -> PDF
  const size = 11;
  const text = (s, x, baseline, font = serif, opts = {}) => page.drawText(s, { x, y: Y(baseline), size, font, color: rgb(0, 0, 0), ...opts });
  const centred = (s, x0, x1, baseline, font = serif) => text(s, (x0 + x1) / 2 - font.widthOfTextAtSize(s, size) / 2, baseline, font);
  const xs = [60, 110, 420, 700];
  const ys = [120, 150, 190, 230, 270];
  const t = 0.5;
  const hRule = (y, x0, x1) => page.drawRectangle({ x: x0 - t / 2, y: Y(y) - t / 2, width: x1 - x0 + t, height: t, color: rgb(0, 0, 0) });
  const vRule = (x, y0, y1) => page.drawRectangle({ x: x - t / 2, y: Y(y1) - t / 2, width: t, height: y1 - y0 + t, color: rgb(0, 0, 0) });
  // header shading (painted first)
  page.drawRectangle({ x: xs[0], y: Y(ys[1]), width: xs[3] - xs[0], height: ys[1] - ys[0], color: rgb(0.85, 0.9, 0.95) });
  for (const y of ys) hRule(y, xs[0], y === ys[2] ? xs[2] : xs[3]); // row 2/3 of the last column are merged
  vRule(xs[0], ys[0], ys[4]);
  vRule(xs[3], ys[0], ys[4]);
  vRule(xs[1], ys[0], ys[3]); // the last row spans columns 1-2
  vRule(xs[2], ys[0], ys[4]);
  hRule(ys[2], xs[0], xs[2]);
  text('Phiếu công nghệ số 12', 60, 90, bold);
  centred('TT', xs[0], xs[1], 139, bold);
  centred('Nội dung công việc', xs[1], xs[2], 139, bold);
  centred('Yêu cầu kỹ thuật', xs[2], xs[3], 139, bold);
  centred('1', xs[0], xs[1], 174);
  text('Kiểm tra hệ thống thủy lực', xs[1] + 5, 174);
  centred('2', xs[0], xs[1], 214);
  // condensed by 0.4 pt per character
  text('Tháo lọc khỏi giảm tốc chính', xs[1] + 5, 214, serif, { characterSpacing: -0.4 });
  text('Không rò dầu,', xs[2] + 5, 174);
  text('không nứt vỡ', xs[2] + 5, 189);
  text('Tổng cộng: 2 hạng mục', xs[0] + 5, 254);
  const pngBytes = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'sample.png'));
  const png = await doc.embedPng(pngBytes);
  page.drawImage(png, { x: 500, y: Y(480), width: 160, height: 120 });
  page.drawText('Chữ xoay dọc', { x: 780, y: Y(500), size, font: serif, rotate: degrees(90) });
  const p2 = doc.addPage([595, 842]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  p2.drawText('Second page heading', { x: 72, y: 842 - 100, size: 16, font: helv });
  p2.drawText('Plain paragraph line one.', { x: 72, y: 842 - 130, size: 11, font: serif });
  p2.drawText('Plain paragraph line two.', { x: 72, y: 842 - 145, size: 11, font: serif });
  p2.drawText('Centred line', { x: 595 / 2 - serif.widthOfTextAtSize('Centred line', 11) / 2, y: 842 - 200, size: 11, font: serif });
  return { bytes: await doc.save(), xs, ys, t };
}
