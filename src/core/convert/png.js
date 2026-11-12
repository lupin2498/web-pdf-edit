// Minimal PNG encoder (8-bit gray / RGB / RGBA and 1-bit gray) used to store
// images decoded by pdf.js in a DOCX file.
import { zlibSync } from 'fflate';

let crcTable = null;
function crc32(buf, crc = 0xffffffff) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, (crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0);
  return out;
}

function assemble(width, height, bitDepth, colorType, raw) {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  const idat = zlibSync(raw, { level: 6 });
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

// Adds the PNG filter byte to every row, using the "up" filter when it
// makes the row more uniform (helps scans and flat graphics).
function filterRows(src, height, stride, bpp) {
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const out = y * (stride + 1);
    let useSub = false;
    if (bpp >= 1 && stride > 64) {
      // Cheap heuristic on a sample of the row.
      let plain = 0;
      let sub = 0;
      const step = Math.max(1, Math.floor(stride / 64));
      for (let x = bpp; x < stride; x += step) {
        plain += src[row + x] > 127 ? 255 - src[row + x] : src[row + x];
        const d = (src[row + x] - src[row + x - bpp]) & 0xff;
        sub += d > 127 ? 256 - d : d;
      }
      useSub = sub < plain;
    }
    if (useSub) {
      raw[out] = 1;
      for (let x = 0; x < stride; x++) raw[out + 1 + x] = x < bpp ? src[row + x] : (src[row + x] - src[row + x - bpp]) & 0xff;
    } else {
      raw[out] = 0;
      raw.set(src.subarray(row, row + stride), out + 1);
    }
  }
  return raw;
}

/** Encodes RGBA pixels; picks grayscale / RGB when the image allows it. */
export function encodePngRgba(width, height, rgba) {
  const n = width * height;
  let opaque = true;
  let gray = true;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    if (rgba[p + 3] !== 255) opaque = false;
    if (rgba[p] !== rgba[p + 1] || rgba[p] !== rgba[p + 2]) gray = false;
    if (!opaque && !gray) break;
  }
  if (opaque && gray) {
    const data = new Uint8Array(n);
    for (let i = 0; i < n; i++) data[i] = rgba[i * 4];
    return assemble(width, height, 8, 0, filterRows(data, height, width, 1));
  }
  if (opaque) {
    const data = new Uint8Array(n * 3);
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      data[j] = rgba[i * 4];
      data[j + 1] = rgba[i * 4 + 1];
      data[j + 2] = rgba[i * 4 + 2];
    }
    return assemble(width, height, 8, 2, filterRows(data, height, width * 3, 3));
  }
  const src = rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  return assemble(width, height, 8, 6, filterRows(src, height, width * 4, 4));
}

export function encodePngRgb(width, height, rgb) {
  const n = width * height;
  let gray = true;
  for (let i = 0; i < n && gray; i++) if (rgb[i * 3] !== rgb[i * 3 + 1] || rgb[i * 3] !== rgb[i * 3 + 2]) gray = false;
  if (gray) {
    const data = new Uint8Array(n);
    for (let i = 0; i < n; i++) data[i] = rgb[i * 3];
    return assemble(width, height, 8, 0, filterRows(data, height, width, 1));
  }
  const src = rgb instanceof Uint8Array ? rgb : new Uint8Array(rgb.buffer, rgb.byteOffset, rgb.byteLength);
  return assemble(width, height, 8, 2, filterRows(src, height, width * 3, 3));
}

/** 1 bit per pixel, rows padded to bytes, 1 = white. */
export function encodePngGray1(width, height, bits) {
  const stride = (width + 7) >> 3;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) raw.set(bits.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return assemble(width, height, 1, 0, raw);
}

/**
 * Encodes an image object as delivered by pdf.js without OffscreenCanvas:
 * { width, height, kind, data } with kind 1 (1 bpp gray), 2 (RGB), 3 (RGBA).
 */
export function encodePdfjsImage(img) {
  if (!img || !img.data || !img.width || !img.height) return null;
  const { width, height, data } = img;
  if (img.kind === 1) return { bytes: encodePngGray1(width, height, data), ext: 'png', width, height, opaque: true };
  if (img.kind === 2) return { bytes: encodePngRgb(width, height, data), ext: 'png', width, height, opaque: true };
  if (img.kind === 3 || data.length === width * height * 4) return { bytes: encodePngRgba(width, height, data), ext: 'png', width, height };
  return null;
}

/**
 * Stencil mask painted with a colour: `bits` is 1 bpp (rows padded to bytes)
 * where a 0 bit is painted, as pdf.js delivers image masks.
 */
export function encodeMaskPng(width, height, bits, hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const stride = (width + 7) >> 3;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bit = (bits[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1;
      const p = (y * width + x) * 4;
      rgba[p] = r;
      rgba[p + 1] = g;
      rgba[p + 2] = b;
      rgba[p + 3] = bit ? 0 : 255;
    }
  }
  return { bytes: encodePngRgba(width, height, rgba), ext: 'png', width, height };
}
