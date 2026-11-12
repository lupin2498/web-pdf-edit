// Shared text layout used both for the on-screen preview and PDF output so
// that line breaks are identical.

export function normalizeText(text) {
  return (text || '').normalize('NFC').replace(/\t/g, '    ');
}

/**
 * Breaks text into lines.
 * @param {string} text
 * @param {object} o
 * @param {(s: string) => number} o.measure width of a string at font size 1
 * @param {number} o.size font size
 * @param {number|null} o.maxWidth wrap width or null for no wrapping
 * @returns {{text: string, width: number}[]}
 */
export function layoutLines(text, { measure, size, maxWidth }) {
  const paragraphs = normalizeText(text).split(/\r\n|\r|\n/);
  const lines = [];
  const width = (s) => measure(s) * size;
  for (const para of paragraphs) {
    if (!maxWidth || maxWidth <= 0 || width(para) <= maxWidth + 0.01) {
      lines.push({ text: para, width: width(para) });
      continue;
    }
    const tokens = para.match(/\S+\s*|\s+/g) || [''];
    let line = '';
    let lineWidth = 0;
    const pushLine = () => {
      const t = line.replace(/\s+$/, '');
      lines.push({ text: t, width: width(t) });
      line = '';
      lineWidth = 0;
    };
    for (const tok of tokens) {
      const trimmed = tok.replace(/\s+$/, '');
      const tokTrimW = width(trimmed);
      if (line && lineWidth + tokTrimW > maxWidth + 0.01) pushLine();
      if (!line && tokTrimW > maxWidth + 0.01) {
        // Break a long word character by character.
        for (const ch of Array.from(tok)) {
          const w = width(ch);
          if (line && lineWidth + w > maxWidth + 0.01 && ch.trim()) pushLine();
          line += ch;
          lineWidth += w;
        }
        continue;
      }
      line += tok;
      lineWidth = width(line);
    }
    pushLine();
  }
  return lines;
}

/**
 * Full layout of a text box in local coordinates (u to the right, v down,
 * origin at the top-left of the box).
 * Returns { lines: [{text, width, x, baseline}], height, width }.
 */
export function layoutTextBox({ text, measure, size, boxWidth, wrap = true, align = 'left', lineHeight = 1.2, ascent = 0.9, descent = -0.212, padding = 0 }) {
  const maxWidth = wrap ? Math.max(1, boxWidth - padding * 2) : null;
  const lines = layoutLines(text, { measure, size, maxWidth });
  const lh = size * lineHeight;
  const contentH = (ascent - descent) * size;
  const halfLeading = (lh - contentH) / 2;
  let maxW = 0;
  for (const l of lines) maxW = Math.max(maxW, l.width);
  const innerWidth = wrap ? Math.max(1, boxWidth - padding * 2) : maxW;
  const out = lines.map((l, i) => {
    let x = padding;
    if (align === 'center') x = padding + (innerWidth - l.width) / 2;
    else if (align === 'right') x = padding + innerWidth - l.width;
    return { text: l.text, width: l.width, x, baseline: padding + i * lh + halfLeading + ascent * size };
  });
  return { lines: out, height: lines.length * lh + padding * 2, width: (wrap ? boxWidth : maxW + padding * 2) };
}

// Local frame of an axis aligned user-space rectangle viewed with rotation R.
export function frameForRect(rect, R = 0) {
  const [x0, y0, x1, y1] = rect;
  switch (((R % 360) + 360) % 360) {
    case 90:
      return { origin: [x0, y0], right: [0, 1], down: [1, 0], width: y1 - y0, height: x1 - x0 };
    case 180:
      return { origin: [x1, y0], right: [-1, 0], down: [0, 1], width: x1 - x0, height: y1 - y0 };
    case 270:
      return { origin: [x1, y1], right: [0, -1], down: [-1, 0], width: y1 - y0, height: x1 - x0 };
    default:
      return { origin: [x0, y1], right: [1, 0], down: [0, -1], width: x1 - x0, height: y1 - y0 };
  }
}

export function localToUser(frame, u, v) {
  return [frame.origin[0] + u * frame.right[0] + v * frame.down[0], frame.origin[1] + u * frame.right[1] + v * frame.down[1]];
}

// Builds the user-space rect for a box of size (w, h) in local units whose
// local top-left corner is at user point p, for view rotation R.
export function rectFromLocal(p, w, h, R = 0) {
  const f = frameForRect([0, 0, 0, 0], R);
  const a = p;
  const b = [p[0] + w * f.right[0] + h * f.down[0], p[1] + w * f.right[1] + h * f.down[1]];
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}
