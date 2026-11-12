// Helpers for working with pdf-lib low-level objects.
import {
  PDFName,
  PDFDict,
  PDFArray,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFRawStream,
  PDFString,
  PDFHexString,
  PDFBool,
  decodePDFRawStream,
} from '@cantoo/pdf-lib';

const nameCache = new Map();
export function N(name) {
  let n = nameCache.get(name);
  if (!n) {
    n = PDFName.of(name);
    nameCache.set(name, n);
  }
  return n;
}

export function resolve(context, obj) {
  let guard = 0;
  while (obj instanceof PDFRef && guard++ < 32) obj = context.lookup(obj);
  return obj;
}

export function get(context, dict, key) {
  if (!dict || typeof dict.get !== 'function') return undefined;
  return resolve(context, dict.get(N(key)));
}

export function getDict(context, dict, key) {
  const v = get(context, dict, key);
  if (v instanceof PDFDict) return v;
  if (v instanceof PDFStream) return v.dict;
  return undefined;
}

export function getArray(context, dict, key) {
  const v = get(context, dict, key);
  return v instanceof PDFArray ? v : undefined;
}

export function numberOf(context, obj, fallback = 0) {
  const v = resolve(context, obj);
  if (v instanceof PDFNumber) return v.asNumber();
  return fallback;
}

export function getNumber(context, dict, key, fallback = undefined) {
  const v = get(context, dict, key);
  return v instanceof PDFNumber ? v.asNumber() : fallback;
}

export function nameOf(obj) {
  return obj instanceof PDFName ? obj.decodeText() : undefined;
}

export function getName(context, dict, key) {
  return nameOf(get(context, dict, key));
}

export function getBool(context, dict, key, fallback = false) {
  const v = get(context, dict, key);
  return v instanceof PDFBool ? v.asBoolean() : fallback;
}

export function textOf(obj) {
  if (obj instanceof PDFString || obj instanceof PDFHexString) {
    try {
      return obj.decodeText();
    } catch {
      return '';
    }
  }
  return undefined;
}

export function arrayToNumbers(context, arr) {
  const out = [];
  if (!(arr instanceof PDFArray)) return out;
  for (let i = 0; i < arr.size(); i++) out.push(numberOf(context, arr.get(i), 0));
  return out;
}

export function getRect(context, dict, key) {
  const arr = getArray(context, dict, key);
  if (!arr || arr.size() < 4) return undefined;
  const n = arrayToNumbers(context, arr);
  return [Math.min(n[0], n[2]), Math.min(n[1], n[3]), Math.max(n[0], n[2]), Math.max(n[1], n[3])];
}

export function streamContents(stream) {
  if (!stream) return new Uint8Array(0);
  if (stream instanceof PDFRawStream) {
    const filter = stream.dict.get(N('Filter'));
    if (!filter && !stream.transform) return stream.contents;
    return decodePDFRawStream(stream).decode();
  }
  if (typeof stream.getUnencodedContents === 'function') return stream.getUnencodedContents();
  if (typeof stream.getContents === 'function') return stream.getContents();
  return new Uint8Array(0);
}

export function concatBytes(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// Returns the decoded concatenated content of a page leaf (PDFPageLeaf).
export function pageContentBytes(context, pageNode) {
  const contents = resolve(context, pageNode.get(N('Contents')));
  const parts = [];
  if (contents instanceof PDFStream) {
    parts.push(streamContents(contents));
  } else if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const s = resolve(context, contents.get(i));
      if (s instanceof PDFStream) {
        parts.push(streamContents(s));
        parts.push(new Uint8Array([10]));
      }
    }
  }
  return concatBytes(parts);
}

export function shallowCloneDict(context, dict) {
  const clone = context.obj({});
  for (const [k, v] of dict.entries()) clone.set(k, v);
  return clone;
}

export function refOf(context, obj) {
  if (obj instanceof PDFRef) return obj;
  try {
    return context.getObjectRef(obj);
  } catch {
    return undefined;
  }
}

export function parseRefString(str) {
  // pdf.js annotation ids look like "12R" or "12R5" (gen suffix) or "12R" with gen 0.
  const m = /^(\d+)R(\d*)$/.exec(str || '');
  if (!m) return null;
  return PDFRef.of(parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0);
}

export function refToString(ref) {
  if (!ref) return null;
  return ref.generationNumber ? `${ref.objectNumber}R${ref.generationNumber}` : `${ref.objectNumber}R`;
}

export { PDFName, PDFDict, PDFArray, PDFNumber, PDFRef, PDFStream, PDFRawStream, PDFString, PDFHexString, PDFBool };
