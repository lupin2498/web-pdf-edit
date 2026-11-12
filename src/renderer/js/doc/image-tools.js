// Image helpers: decoding PDF image XObjects, preparing image files for
// insertion, pixel-level redaction and export.
import { PDFName, PDFArray, PDFNumber, PDFDict, PDFRawStream, decodePDFRawStream } from '@cantoo/pdf-lib';
import { invert, applyPoint } from '../../../core/matrix.js';

const N = (s) => PDFName.of(s);

function lookup(ctx, v) {
  return v && v.objectNumber !== undefined ? ctx.lookup(v) : v;
}

function filterNames(ctx, dict) {
  const f = lookup(ctx, dict.get(N('Filter')));
  if (!f) return [];
  if (f instanceof PDFName) return [f.decodeText()];
  if (f instanceof PDFArray) {
    const out = [];
    for (let i = 0; i < f.size(); i++) {
      const v = lookup(ctx, f.get(i));
      if (v instanceof PDFName) out.push(v.decodeText());
    }
    return out;
  }
  return [];
}

function colorSpaceInfo(ctx, cs) {
  cs = lookup(ctx, cs);
  if (cs instanceof PDFName) {
    const n = cs.decodeText();
    if (n === 'DeviceRGB' || n === 'CalRGB') return { kind: 'rgb', n: 3 };
    if (n === 'DeviceGray' || n === 'CalGray') return { kind: 'gray', n: 1 };
    if (n === 'DeviceCMYK') return { kind: 'cmyk', n: 4 };
    return null;
  }
  if (cs instanceof PDFArray) {
    const kind = lookup(ctx, cs.get(0));
    const name = kind instanceof PDFName ? kind.decodeText() : '';
    if (name === 'ICCBased') {
      const s = lookup(ctx, cs.get(1));
      const n = s && s.dict ? lookup(ctx, s.dict.get(N('N'))) : null;
      const comps = n instanceof PDFNumber ? n.asNumber() : 3;
      return { kind: comps === 1 ? 'gray' : comps === 4 ? 'cmyk' : 'rgb', n: comps };
    }
    if (name === 'CalRGB') return { kind: 'rgb', n: 3 };
    if (name === 'CalGray') return { kind: 'gray', n: 1 };
    if (name === 'Indexed') {
      const base = colorSpaceInfo(ctx, cs.get(1));
      const hival = lookup(ctx, cs.get(2));
      let table = lookup(ctx, cs.get(3));
      let bytes = null;
      if (table && table.asBytes) bytes = table.asBytes();
      else if (table && table.dict) bytes = table instanceof PDFRawStream ? decodePDFRawStream(table).decode() : table.getContents();
      if (!base || !bytes) return null;
      return { kind: 'indexed', n: 1, base, hival: hival instanceof PDFNumber ? hival.asNumber() : 255, table: bytes };
    }
  }
  return null;
}

async function blobToImageData(bytes, mime) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  bmp.close && bmp.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Decodes an image XObject into RGBA ImageData. Supports DCT (JPEG) and
 * Flate/uncompressed images in Gray/RGB/CMYK/Indexed with 1/8 bits.
 */
export async function decodeImageXObject(ctx, stream) {
  const dict = stream.dict;
  const filters = filterNames(ctx, dict);
  const width = lookup(ctx, dict.get(N('Width')))?.asNumber?.() || 0;
  const height = lookup(ctx, dict.get(N('Height')))?.asNumber?.() || 0;
  if (!width || !height) throw new Error('Invalid image size');
  if (filters.length === 1 && filters[0] === 'DCTDecode') {
    return { imageData: await blobToImageData(stream.contents, 'image/jpeg'), jpeg: true };
  }
  if (filters.some((f) => !['FlateDecode', 'LZWDecode', 'ASCII85Decode', 'ASCIIHexDecode', 'RunLengthDecode'].includes(f))) {
    throw new Error(`Unsupported image filter ${filters.join(',')}`);
  }
  const parms = lookup(ctx, dict.get(N('DecodeParms')));
  const pdict = parms instanceof PDFArray ? lookup(ctx, parms.get(0)) : parms;
  if (pdict instanceof PDFDict) {
    const pred = lookup(ctx, pdict.get(N('Predictor')));
    if (pred instanceof PDFNumber && pred.asNumber() > 1) throw new Error('Predictors not supported');
  }
  const isMask = lookup(ctx, dict.get(N('ImageMask')))?.asBoolean?.() || false;
  const bpc = isMask ? 1 : lookup(ctx, dict.get(N('BitsPerComponent')))?.asNumber?.() || 8;
  const cs = isMask ? { kind: 'gray', n: 1 } : colorSpaceInfo(ctx, dict.get(N('ColorSpace')));
  if (!cs) throw new Error('Unsupported color space');
  if (bpc !== 8 && bpc !== 1) throw new Error('Unsupported bits per component');
  const raw = stream instanceof PDFRawStream ? (filters.length ? decodePDFRawStream(stream).decode() : stream.contents) : stream.getContents();
  const out = new ImageData(width, height);
  const px = out.data;
  const rowBytes = Math.ceil((width * cs.n * bpc) / 8);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let comps;
      if (bpc === 8) {
        const o = y * rowBytes + x * cs.n;
        comps = [];
        for (let k = 0; k < cs.n; k++) comps.push(raw[o + k] ?? 0);
      } else {
        const bit = x;
        const byte = raw[y * rowBytes + (bit >> 3)] ?? 0;
        const v = (byte >> (7 - (bit & 7))) & 1;
        comps = [isMask ? (v ? 255 : 0) : v * 255];
      }
      let r;
      let g;
      let b;
      if (cs.kind === 'indexed') {
        const i = Math.min(comps[0], cs.hival) * cs.base.n;
        const t = cs.table;
        if (cs.base.kind === 'rgb') [r, g, b] = [t[i], t[i + 1], t[i + 2]];
        else if (cs.base.kind === 'gray') r = g = b = t[i];
        else {
          const k = t[i + 3] / 255;
          r = 255 * (1 - t[i] / 255) * (1 - k);
          g = 255 * (1 - t[i + 1] / 255) * (1 - k);
          b = 255 * (1 - t[i + 2] / 255) * (1 - k);
        }
      } else if (cs.kind === 'rgb') [r, g, b] = comps;
      else if (cs.kind === 'gray') r = g = b = comps[0];
      else {
        const k = comps[3] / 255;
        r = 255 * (1 - comps[0] / 255) * (1 - k);
        g = 255 * (1 - comps[1] / 255) * (1 - k);
        b = 255 * (1 - comps[2] / 255) * (1 - k);
      }
      const o = (y * width + x) * 4;
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
      px[o + 3] = 255;
    }
  }
  return { imageData: out, jpeg: false };
}

export async function imageDataToBytes(imageData, type = 'image/png', quality = 0.9) {
  const canvas = new OffscreenCanvas(imageData.width, imageData.height);
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  const blob = await canvas.convertToBlob({ type, quality });
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Paints redaction regions (user space) black inside an image and returns a
 * new embedded image ref, used by the builder for partially covered images.
 */
export async function redactImageRegions(doc, image, regions) {
  if (!image.stream) return null;
  const ctx = doc.context;
  const { imageData, jpeg } = await decodeImageXObject(ctx, image.stream);
  const inv = invert(image.ctm);
  if (!inv) return null;
  const w = imageData.width;
  const hgt = imageData.height;
  const px = imageData.data;
  for (const r of regions) {
    // Map region corners to image unit space, then to pixels.
    const pts = [applyPoint(inv, r[0], r[1]), applyPoint(inv, r[2], r[1]), applyPoint(inv, r[2], r[3]), applyPoint(inv, r[0], r[3])];
    const us = pts.map((p) => p[0]);
    const vs = pts.map((p) => p[1]);
    const x0 = Math.max(0, Math.floor(Math.min(...us) * w));
    const x1 = Math.min(w, Math.ceil(Math.max(...us) * w));
    const y0 = Math.max(0, Math.floor((1 - Math.max(...vs)) * hgt));
    const y1 = Math.min(hgt, Math.ceil((1 - Math.min(...vs)) * hgt));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * w + x) * 4;
        px[o] = 0;
        px[o + 1] = 0;
        px[o + 2] = 0;
        px[o + 3] = 255;
      }
    }
  }
  const bytes = await imageDataToBytes(imageData, jpeg ? 'image/jpeg' : 'image/png', 0.92);
  const embedded = jpeg ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
  return embedded.ref;
}

// Reads an image file for insertion; returns { bytes, mime, width, height }.
export async function prepareImageFile(bytes, fileName = '') {
  const lower = fileName.toLowerCase();
  let mime = 'image/png';
  if (/\.jpe?g$/.test(lower) || (bytes[0] === 0xff && bytes[1] === 0xd8)) mime = 'image/jpeg';
  else if (/\.gif$/.test(lower)) mime = 'image/gif';
  else if (/\.webp$/.test(lower)) mime = 'image/webp';
  else if (/\.bmp$/.test(lower)) mime = 'image/bmp';
  else if (/\.tiff?$/.test(lower)) mime = 'image/tiff';
  const blob = new Blob([bytes], { type: mime });
  const bmp = await createImageBitmap(blob);
  const width = bmp.width;
  const height = bmp.height;
  let outBytes = bytes;
  let outMime = mime;
  const isProgressiveOrCmyk = mime === 'image/jpeg' && !isSimpleJpeg(bytes);
  if ((mime !== 'image/png' && mime !== 'image/jpeg') || isProgressiveOrCmyk) {
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    const out = await canvas.convertToBlob({ type: mime === 'image/jpeg' ? 'image/jpeg' : 'image/png', quality: 0.92 });
    outBytes = new Uint8Array(await out.arrayBuffer());
    outMime = out.type;
  }
  bmp.close && bmp.close();
  return { bytes: outBytes, mime: outMime, width, height };
}

// JPEGs that pdf-lib embeds directly (baseline/progressive with 1 or 3 components).
function isSimpleJpeg(bytes) {
  let i = 2;
  while (i < bytes.length - 9) {
    if (bytes[i] !== 0xff) return false;
    const marker = bytes[i + 1];
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const comps = bytes[i + 9];
      return comps === 1 || comps === 3;
    }
    i += 2 + len;
  }
  return false;
}

export async function canvasToBytes(canvas, type = 'image/png', quality = 0.92) {
  const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type, quality }) : await new Promise((r) => canvas.toBlob(r, type, quality));
  return new Uint8Array(await blob.arrayBuffer());
}
