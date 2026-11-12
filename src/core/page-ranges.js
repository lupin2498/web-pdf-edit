// Page range parsing: "1-3, 5, 8-" -> zero-based indices.

export function parsePageRanges(input, pageCount) {
  const text = String(input ?? '').trim();
  if (!text || /^(all|tất cả|tat ca|\*)$/i.test(text)) return Array.from({ length: pageCount }, (_, i) => i);
  const out = [];
  const seen = new Set();
  for (const raw of text.split(/[,;]+/)) {
    const part = raw.trim().toLowerCase();
    if (!part) continue;
    let m;
    if (part === 'odd' || part === 'lẻ' || part === 'le') {
      for (let i = 0; i < pageCount; i += 2) add(i);
    } else if (part === 'even' || part === 'chẵn' || part === 'chan') {
      for (let i = 1; i < pageCount; i += 2) add(i);
    } else if ((m = /^(\d+)\s*-\s*(\d*)$/.exec(part))) {
      const a = parseInt(m[1], 10);
      const b = m[2] ? parseInt(m[2], 10) : pageCount;
      if (a < 1 || a > pageCount) throw rangeError(a, pageCount);
      const end = Math.min(b, pageCount);
      if (a <= end) for (let i = a; i <= end; i++) add(i - 1);
      else for (let i = a; i >= Math.max(1, end); i--) add(i - 1);
    } else if ((m = /^-\s*(\d+)$/.exec(part))) {
      const b = Math.min(parseInt(m[1], 10), pageCount);
      for (let i = 1; i <= b; i++) add(i - 1);
    } else if ((m = /^(\d+)$/.exec(part))) {
      const a = parseInt(m[1], 10);
      if (a < 1 || a > pageCount) throw rangeError(a, pageCount);
      add(a - 1);
    } else {
      const e = new SyntaxError(`Invalid page range: "${raw.trim()}"`);
      e.code = 'INVALID_RANGE';
      e.params = { text: raw.trim() };
      throw e;
    }
  }
  return out;

  function add(i) {
    if (!seen.has(i)) {
      seen.add(i);
      out.push(i);
    }
  }
}

function rangeError(page, count) {
  const e = new RangeError(`Page ${page} is outside 1-${count}`);
  e.code = 'PAGE_OUT_OF_RANGE';
  e.params = { page, count };
  return e;
}

export function formatPageRanges(indices) {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const parts = [];
  let start = null;
  let prev = null;
  for (const i of sorted) {
    if (start === null) {
      start = prev = i;
    } else if (i === prev + 1) {
      prev = i;
    } else {
      parts.push(start === prev ? `${start + 1}` : `${start + 1}-${prev + 1}`);
      start = prev = i;
    }
  }
  if (start !== null) parts.push(start === prev ? `${start + 1}` : `${start + 1}-${prev + 1}`);
  return parts.join(', ');
}
