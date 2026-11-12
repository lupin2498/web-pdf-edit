// Generates PDF fixtures used by unit and E2E tests.
// Usage: node tests/fixtures/make-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb, degrees, PDFName, PDFString } from '@cantoo/pdf-lib';
import fontkit from '@cantoo/fontkit';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'generated');
fs.mkdirSync(out, { recursive: true });
const FONT_DIR = path.join(here, '..', '..', 'src', 'assets', 'fonts');
const fontPath = (f) => {
  const local = path.join(FONT_DIR, f);
  if (fs.existsSync(local)) return local;
  return path.join('/usr/share/fonts/truetype/liberation', f);
};

function tinyPng(color = [220, 40, 40]) {
  // 2x2 RGB PNG generated without dependencies.
  const w = 2;
  const h = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = color[0];
      raw[o + 1] = (color[1] + x * 100) % 256;
      raw[o + 2] = (color[2] + y * 100) % 256;
    }
  }
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export async function makeFixtures() {
  // 1. Standard font text (no /Widths), several lines and pages.
  {
    const doc = await PDFDocument.create();
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const times = await doc.embedFont(StandardFonts.TimesRomanBold);
    for (let p = 0; p < 3; p++) {
      const page = doc.addPage([595, 842]);
      page.drawText(`Page ${p + 1} heading`, { x: 72, y: 760, size: 24, font: times });
      page.drawText('The quick brown fox jumps over the lazy dog.', { x: 72, y: 700, size: 12, font: helv });
      page.drawText('Second line with KEEPME and REMOVEME words.', { x: 72, y: 680, size: 12, font: helv });
      page.drawText('Third line is here.', { x: 72, y: 660, size: 12, font: helv, color: rgb(0.8, 0, 0) });
      page.drawRectangle({ x: 72, y: 500, width: 200, height: 100, color: rgb(0.2, 0.4, 0.8) });
    }
    doc.setTitle('Standard fonts sample');
    fs.writeFileSync(path.join(out, 'standard.pdf'), await doc.save());
  }

  // 2. Embedded Unicode font (Identity-H) with Vietnamese text.
  {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(fs.readFileSync(fontPath('LiberationSans-Regular.ttf')), { subset: true });
    const bold = await doc.embedFont(fs.readFileSync(fontPath('LiberationSerif-Bold.ttf')), { subset: true });
    const page = doc.addPage([595, 842]);
    page.drawText('Tiêu đề tài liệu', { x: 72, y: 760, size: 22, font: bold });
    page.drawText('Xin chào thế giới. Đây là đoạn văn bản tiếng Việt.', { x: 72, y: 720, size: 12, font });
    page.drawText('Dòng thứ hai có từ CẦNXÓA ở giữa câu.', { x: 72, y: 700, size: 12, font });
    page.drawText('Dòng thứ ba giữ nguyên.', { x: 72, y: 680, size: 12, font });
    fs.writeFileSync(path.join(out, 'unicode.pdf'), await doc.save());
  }

  // 3. Images, rotated page, mixed page sizes.
  {
    const doc = await PDFDocument.create();
    const png = await doc.embedPng(tinyPng());
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const p1 = doc.addPage([612, 792]);
    p1.drawText('Image page', { x: 72, y: 720, size: 18, font: helv });
    p1.drawImage(png, { x: 100, y: 400, width: 200, height: 150 });
    p1.drawImage(png, { x: 350, y: 100, width: 100, height: 100 });
    const p2 = doc.addPage([842, 595]);
    p2.drawText('Landscape page', { x: 72, y: 500, size: 18, font: helv });
    const p3 = doc.addPage([595, 842]);
    p3.setRotation(degrees(90));
    p3.drawText('Rotated page text', { x: 72, y: 760, size: 18, font: helv });
    fs.writeFileSync(path.join(out, 'images.pdf'), await doc.save());
  }

  // 4. Form XObject containing text + annotations + form fields.
  {
    const doc = await PDFDocument.create();
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([595, 842]);
    const content = `BT /F1 14 Tf 72 600 Td (Text inside a form XObject) Tj ET`;
    const fontRef = helv.ref;
    const formStream = doc.context.stream(content, {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 595, 842],
      Resources: { Font: { F1: fontRef } },
    });
    const formRef = doc.context.register(formStream);
    page.node.normalize();
    const res = page.node.Resources();
    res.lookup(PDFName.of('XObject')).set(PDFName.of('Fm0'), formRef);
    const cs = doc.context.stream('q /Fm0 Do Q');
    page.node.addContentStream(doc.context.register(cs));
    page.drawText('Text outside form', { x: 72, y: 700, size: 14, font: helv });
    const form = doc.getForm();
    const tf = form.createTextField('name');
    tf.setText('Nguyen');
    tf.addToPage(page, { x: 72, y: 400, width: 200, height: 24 });
    const cb = form.createCheckBox('agree');
    cb.addToPage(page, { x: 72, y: 360, width: 18, height: 18 });
    // A simple square annotation.
    const annot = doc.context.obj({
      Type: 'Annot',
      Subtype: 'Square',
      Rect: [300, 300, 400, 380],
      C: [1, 0, 0],
      Border: [0, 0, 2],
      Contents: PDFString.of('Existing square'),
      T: PDFString.of('Tester'),
    });
    const annotRef = doc.context.register(annot);
    page.node.addAnnot(annotRef);
    fs.writeFileSync(path.join(out, 'forms.pdf'), await doc.save());
  }

  // 5. Encrypted PDF (user password "secret").
  {
    const doc = await PDFDocument.create();
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([595, 842]);
    page.drawText('Secret document content', { x: 72, y: 760, size: 18, font: helv });
    doc.encrypt({ userPassword: 'secret', ownerPassword: 'owner', permissions: { printing: 'highResolution', modifying: true, copying: true, annotating: true } });
    fs.writeFileSync(path.join(out, 'encrypted.pdf'), await doc.save());
  }

  // 6. Hand-written content with TJ kerning, ' and " operators, Tz, Tc, Tw.
  {
    const doc = await PDFDocument.create();
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([595, 842]);
    page.node.normalize();
    page.node.setFontDictionary(PDFName.of('F1'), helv.ref);
    const content = [
      'BT /F1 12 Tf 14 TL 72 760 Td',
      '[(Kerned) -250 (TJ) 120 ( text AAA)] TJ',
      "(Quote op line BBB) '",
      '2 0.5 (Double quote CCC end) "',
      '150 Tz 1 Tc (Scaled DDD text) Tj',
      'ET',
    ].join('\n');
    page.node.addContentStream(doc.context.register(doc.context.stream(content)));
    fs.writeFileSync(path.join(out, 'operators.pdf'), await doc.save());
  }

  // 7. Ten numbered pages for page operations.
  {
    const doc = await PDFDocument.create();
    const helv = await doc.embedFont(StandardFonts.HelveticaBold);
    for (let i = 1; i <= 10; i++) {
      const page = doc.addPage([595, 842]);
      page.drawText(`PAGE-${i}`, { x: 200, y: 420, size: 48, font: helv });
    }
    fs.writeFileSync(path.join(out, 'ten-pages.pdf'), await doc.save());
  }

  // 8. LibreOffice generated document (TrueType subset fonts, kerning).
  try {
    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<h1>Báo cáo kết quả kinh doanh</h1>
<p>Đoạn văn đầu tiên của tài liệu được tạo bởi LibreOffice. Nội dung này dùng để kiểm tra chức năng chỉnh sửa văn bản trong PDF.</p>
<p>Second paragraph in English with some <b>bold words</b> and <i>italic words</i> for testing.</p>
<ul><li>Mục thứ nhất</li><li>Mục thứ hai</li></ul>
</body></html>`;
    const tmp = path.join(out, 'lo-src');
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'libreoffice.html'), html);
    execFileSync('soffice', ['--headless', '--convert-to', 'pdf:writer_web_pdf_Export', '--outdir', out, path.join(tmp, 'libreoffice.html')], {
      stdio: 'ignore',
      timeout: 120000,
    });
  } catch (e) {
    console.warn('LibreOffice fixture skipped:', e.message);
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  makeFixtures().then((dir) => console.log('Fixtures written to', dir));
}
