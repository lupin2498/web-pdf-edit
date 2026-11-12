// Text search over pdf.js text content.

function itemGeometry(item, styles) {
  const [a, b, c, d, e, f] = item.transform;
  const angle = Math.atan2(b, a);
  const size = Math.hypot(c, d) || Math.hypot(a, b) || 10;
  const st = styles[item.fontName] || {};
  const asc = typeof st.ascent === 'number' && st.ascent > 0 ? st.ascent : 0.8;
  const desc = typeof st.descent === 'number' && st.descent < 0 ? st.descent : -0.2;
  return { angle, size, asc, desc, x: e, y: f, width: item.width || 0 };
}

export function partialRect(item, styles, from, to) {
  const g = itemGeometry(item, styles);
  const len = Math.max(1, item.str.length);
  const u0 = (g.width * from) / len;
  const u1 = (g.width * to) / len;
  const cos = Math.cos(g.angle);
  const sin = Math.sin(g.angle);
  const pts = [
    [u0, g.desc * g.size],
    [u1, g.desc * g.size],
    [u1, g.asc * g.size],
    [u0, g.asc * g.size],
  ].map(([u, v]) => [g.x + u * cos - v * sin, g.y + u * sin + v * cos]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function buildPageText(textContent) {
  let text = '';
  const map = []; // per item: {start, end, item}
  for (const item of textContent.items || []) {
    if (typeof item.str !== 'string') continue;
    const start = text.length;
    text += item.str;
    map.push({ start, end: text.length, item });
    if (item.hasEOL) text += ' ';
  }
  return { text, map };
}

function normalizeForSearch(s, matchCase) {
  const n = s.normalize('NFC');
  return matchCase ? n : n.toLocaleLowerCase('vi');
}

export function findInPage(textContent, query, { matchCase = false, wholeWord = false } = {}) {
  if (!query) return [];
  const { text, map } = buildPageText(textContent);
  const hay = normalizeForSearch(text, matchCase);
  const needle = normalizeForSearch(query, matchCase);
  const results = [];
  let from = 0;
  while (from <= hay.length - needle.length) {
    const idx = hay.indexOf(needle, from);
    if (idx < 0) break;
    const end = idx + needle.length;
    const isWordChar = (ch) => !!ch && /[\p{L}\p{N}_]/u.test(ch);
    if (!wholeWord || (!isWordChar(hay[idx - 1]) && !isWordChar(hay[end]))) {
      const rects = [];
      for (const m of map) {
        if (m.end <= idx || m.start >= end) continue;
        const a = Math.max(idx, m.start) - m.start;
        const b = Math.min(end, m.end) - m.start;
        if (b > a) rects.push(partialRect(m.item, textContent.styles || {}, a, b));
      }
      results.push({
        start: idx,
        end,
        rects,
        before: text.slice(Math.max(0, idx - 30), idx),
        match: text.slice(idx, end),
        after: text.slice(end, end + 30),
      });
    }
    from = idx + Math.max(1, needle.length);
  }
  return results;
}

export async function searchDocument(session, query, opts = {}, onProgress = null, isCancelled = () => false) {
  const out = [];
  const pages = session.state.pages;
  for (let i = 0; i < pages.length; i++) {
    if (isCancelled()) break;
    const entry = pages[i];
    if (!entry.src) continue;
    let tc;
    try {
      tc = await session.getTextContent(entry);
    } catch {
      continue;
    }
    for (const m of findInPage(tc, query, opts)) out.push({ pageUid: entry.uid, pageIndex: i, ...m });
    if (onProgress && i % 5 === 0) onProgress(i + 1, pages.length, out.length);
  }
  return out;
}
