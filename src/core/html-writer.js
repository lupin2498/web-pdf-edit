// HTML export of the text and pictures of a PDF (reading order, one section
// per page).

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function hex(c) {
  return (c || [0, 0, 0]).map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/**
 * pages: [{ width, height, items: [ {kind:'paragraph', text, size, bold, italic, color, align, font, spaceBefore} | {kind:'image', bytes, ext:'png'|'jpeg', width, height (pt)} ] }]
 */
export function buildHtml(pages, { title = '' } = {}) {
  const toB64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const parts = [];
  pages.forEach((page, i) => {
    parts.push(`<section class="page" id="page-${i + 1}">`);
    for (const it of page.items) {
      if (it.kind === 'image') {
        parts.push(`<p><img src="data:image/${it.ext};base64,${toB64(it.bytes)}" width="${Math.round(it.width * 1.333)}" alt=""></p>`);
      } else {
        const style = [`font-size:${(it.size || 11).toFixed(1)}pt`, it.bold ? 'font-weight:bold' : '', it.italic ? 'font-style:italic' : '', it.align && it.align !== 'left' ? `text-align:${it.align}` : '', it.color ? `color:#${hex(it.color)}` : ''].filter(Boolean).join(';');
        parts.push(`<p style="${style}">${esc(it.text).replace(/\n/g, '<br>')}</p>`);
      }
    }
    parts.push('</section>');
  });
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font-family:Arial,'Liberation Sans',sans-serif;max-width:900px;margin:24px auto;padding:0 16px;color:#111}.page{border-bottom:1px dashed #bbb;padding:12px 0 24px;margin-bottom:24px}img{max-width:100%;height:auto}</style></head><body>${parts.join('\n')}</body></html>`;
}
