// A small XML parser and a validator for the WordprocessingML this app
// writes: well-formedness plus the child order ECMA-376 requires (Word
// refuses or "repairs" documents whose elements are out of order).

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    if (!(e in ENTITIES)) throw new Error(`unknown entity ${m}`);
    return ENTITIES[e];
  });
}

/** Parses XML into { name, attrs, children, text }; throws when malformed. */
export function parseXml(xml) {
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>|([^<]+)/g;
  let pos = 0;
  let m;
  while ((m = re.exec(xml))) {
    if (m.index !== pos) throw new Error(`unexpected content at ${pos}: ${xml.slice(pos, pos + 40)}`);
    pos = re.lastIndex;
    const top = stack[stack.length - 1];
    if (m[1]) {
      if (top.name !== m[1]) throw new Error(`</${m[1]}> closes <${top.name}> at ${m.index}`);
      stack.pop();
    } else if (m[2]) {
      const attrs = {};
      const ar = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = ar.exec(m[3]))) {
        if (a[1] in attrs) throw new Error(`duplicate attribute ${a[1]} on <${m[2]}>`);
        attrs[a[1]] = decodeXml(a[2] ?? a[3]);
      }
      const el = { name: m[2], attrs, children: [], text: '' };
      top.children.push(el);
      if (!m[4]) stack.push(el);
    } else if (m[5] !== undefined) {
      if (/[&]/.test(m[5].replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, ''))) throw new Error(`bare ampersand at ${m.index}`);
      top.text += decodeXml(m[5]);
    }
  }
  if (pos !== xml.length) throw new Error(`unparsed content at ${pos}`);
  if (stack.length !== 1) throw new Error(`<${stack[stack.length - 1].name}> is not closed`);
  if (root.children.length !== 1) throw new Error('a document needs exactly one root element');
  return root.children[0];
}

export function* walk(el) {
  yield el;
  for (const c of el.children) yield* walk(c);
}

export const find = (el, name) => [...walk(el)].filter((e) => e.name === name);
export const child = (el, name) => el.children.find((c) => c.name === name) || null;
/** Text of all w:t descendants. */
export const textOf = (el) => find(el, 'w:t').map((t) => t.text).join('');

// Child order of the elements this app writes (subset of the schema, in
// schema order). Any child not listed is reported.
const ORDER = {
  'w:pPr': ['w:pStyle', 'w:keepNext', 'w:keepLines', 'w:pageBreakBefore', 'w:framePr', 'w:widowControl', 'w:numPr', 'w:suppressLineNumbers', 'w:pBdr', 'w:shd', 'w:tabs', 'w:suppressAutoHyphens', 'w:kinsoku', 'w:wordWrap', 'w:overflowPunct', 'w:topLinePunct', 'w:autoSpaceDE', 'w:autoSpaceDN', 'w:bidi', 'w:adjustRightInd', 'w:snapToGrid', 'w:spacing', 'w:ind', 'w:contextualSpacing', 'w:mirrorIndents', 'w:suppressOverlap', 'w:jc', 'w:textDirection', 'w:textAlignment', 'w:textboxTightWrap', 'w:outlineLvl', 'w:divId', 'w:cnfStyle', 'w:rPr', 'w:sectPr', 'w:pPrChange'],
  'w:rPr': ['w:rStyle', 'w:rFonts', 'w:b', 'w:bCs', 'w:i', 'w:iCs', 'w:caps', 'w:smallCaps', 'w:strike', 'w:dstrike', 'w:outline', 'w:shadow', 'w:emboss', 'w:imprint', 'w:noProof', 'w:snapToGrid', 'w:vanish', 'w:webHidden', 'w:color', 'w:spacing', 'w:w', 'w:kern', 'w:position', 'w:sz', 'w:szCs', 'w:highlight', 'w:u', 'w:effect', 'w:bdr', 'w:shd', 'w:fitText', 'w:vertAlign', 'w:rtl', 'w:cs', 'w:em', 'w:lang', 'w:eastAsianLayout', 'w:specVanish', 'w:oMath'],
  'w:tblPr': ['w:tblStyle', 'w:tblpPr', 'w:tblOverlap', 'w:bidiVisual', 'w:tblStyleRowBandSize', 'w:tblStyleColBandSize', 'w:tblW', 'w:jc', 'w:tblCellSpacing', 'w:tblInd', 'w:tblBorders', 'w:shd', 'w:tblLayout', 'w:tblCellMar', 'w:tblLook', 'w:tblCaption', 'w:tblDescription'],
  'w:tblCellMar': ['w:top', 'w:start', 'w:left', 'w:bottom', 'w:end', 'w:right'],
  'w:tcMar': ['w:top', 'w:start', 'w:left', 'w:bottom', 'w:end', 'w:right'],
  'w:tcBorders': ['w:top', 'w:start', 'w:left', 'w:bottom', 'w:end', 'w:right', 'w:insideH', 'w:insideV', 'w:tl2br', 'w:tr2bl'],
  'w:tcPr': ['w:cnfStyle', 'w:tcW', 'w:gridSpan', 'w:hMerge', 'w:vMerge', 'w:tcBorders', 'w:shd', 'w:noWrap', 'w:tcMar', 'w:textDirection', 'w:tcFitText', 'w:vAlign', 'w:hideMark'],
  'w:tbl': ['w:tblPr', 'w:tblGrid', 'w:tr'],
  'w:tr': ['w:tblPrEx', 'w:trPr', 'w:tc'],
  'w:tc': ['w:tcPr', 'w:p', 'w:tbl'],
  'w:sectPr': ['w:headerReference', 'w:footerReference', 'w:footnotePr', 'w:endnotePr', 'w:type', 'w:pgSz', 'w:pgMar', 'w:paperSrc', 'w:pgBorders', 'w:lnNumType', 'w:pgNumType', 'w:cols', 'w:formProt', 'w:vAlign', 'w:noEndnote', 'w:titlePg', 'w:textDirection', 'w:bidi', 'w:rtlGutter', 'w:docGrid', 'w:printerSettings'],
  'w:p': ['w:pPr', 'w:r'],
  'wp:anchor': ['wp:simplePos', 'wp:positionH', 'wp:positionV', 'wp:extent', 'wp:effectExtent', 'wp:wrapNone', 'wp:wrapSquare', 'wp:wrapTight', 'wp:wrapThrough', 'wp:wrapTopAndBottom', 'wp:docPr', 'wp:cNvGraphicFramePr', 'a:graphic'],
  'wps:wsp': ['wps:cNvPr', 'wps:cNvSpPr', 'wps:cNvCnPr', 'wps:spPr', 'wps:style', 'wps:extLst', 'wps:txbx', 'wps:linkedTxbx', 'wps:bodyPr'],
  'wps:spPr': ['a:xfrm', 'a:custGeom', 'a:prstGeom', 'a:noFill', 'a:solidFill', 'a:gradFill', 'a:blipFill', 'a:pattFill', 'a:grpFill', 'a:ln', 'a:effectLst'],
  'pic:spPr': ['a:xfrm', 'a:custGeom', 'a:prstGeom', 'a:noFill', 'a:solidFill', 'a:ln'],
  'pic:pic': ['pic:nvPicPr', 'pic:blipFill', 'pic:spPr'],
  'pic:blipFill': ['a:blip', 'a:srcRect', 'a:stretch', 'a:tile'],
  'a:ln': ['a:noFill', 'a:solidFill', 'a:gradFill', 'a:pattFill', 'a:prstDash', 'a:custDash', 'a:round', 'a:bevel', 'a:miter', 'a:headEnd', 'a:tailEnd'],
  'a:custGeom': ['a:avLst', 'a:gdLst', 'a:ahLst', 'a:cxnLst', 'a:rect', 'a:pathLst'],
  'a:gradFill': ['a:gsLst', 'a:lin', 'a:path', 'a:tileRect'],
  'a:xfrm': ['a:off', 'a:ext'],
  'mc:AlternateContent': ['mc:Choice', 'mc:Fallback'],
  'w:docDefaults': ['w:rPrDefault', 'w:pPrDefault'],
};

const INT_ATTRS = [
  ['w:spacing', ['w:before', 'w:after', 'w:line', 'w:val']],
  ['w:ind', ['w:left', 'w:right']],
  ['w:sz', ['w:val']],
  ['w:szCs', ['w:val']],
  ['w:position', ['w:val']],
  ['w:w', ['w:val']],
  ['w:gridCol', ['w:w']],
  ['w:tcW', ['w:w']],
  ['w:tblW', ['w:w']],
  ['w:tblInd', ['w:w']],
  ['w:trHeight', ['w:val']],
  ['w:gridSpan', ['w:val']],
  ['w:tab', ['w:pos']],
  ['w:pgSz', ['w:w', 'w:h']],
  ['w:pgMar', ['w:top', 'w:right', 'w:bottom', 'w:left']],
  ['wp:extent', ['cx', 'cy']],
  ['a:ext', ['cx', 'cy']],
  ['a:off', ['x', 'y']],
  ['a:pt', ['x', 'y']],
  ['a:gs', ['pos']],
];

/** Returns a list of problems (empty when the part is fine). */
export function checkWordXml(xml) {
  const problems = [];
  let root;
  try {
    root = parseXml(xml);
  } catch (e) {
    return [`not well-formed: ${e.message}`];
  }
  const intAttrs = new Map(INT_ATTRS);
  const ids = new Set();
  for (const el of walk(root)) {
    const order = ORDER[el.name];
    if (order) {
      let last = -1;
      for (const c of el.children) {
        const k = order.indexOf(c.name);
        if (k < 0) problems.push(`<${c.name}> is not expected in <${el.name}>`);
        else if (k < last) problems.push(`<${c.name}> is out of order in <${el.name}>`);
        else last = k;
      }
    }
    const ints = intAttrs.get(el.name);
    if (ints) {
      for (const a of ints) {
        if (a in el.attrs && !/^-?\d+$/.test(el.attrs[a])) problems.push(`${el.name}@${a}="${el.attrs[a]}" is not an integer`);
      }
    }
    if (el.name === 'w:tbl') {
      const cols = child(el, 'w:tblGrid') ? child(el, 'w:tblGrid').children.length : 0;
      for (const tr of el.children.filter((c) => c.name === 'w:tr')) {
        let n = 0;
        for (const tc of tr.children.filter((c) => c.name === 'w:tc')) {
          const pr = child(tc, 'w:tcPr');
          const span = pr && child(pr, 'w:gridSpan');
          n += span ? parseInt(span.attrs['w:val'], 10) : 1;
          // A cell must end with a paragraph.
          const lastChild = tc.children[tc.children.length - 1];
          if (!lastChild || lastChild.name !== 'w:p') problems.push('a table cell does not end with a paragraph');
        }
        if (n !== cols) problems.push(`a table row spans ${n} of ${cols} grid columns`);
      }
    }
    if (el.name === 'w:trHeight' && !(parseInt(el.attrs['w:val'], 10) > 0)) problems.push('row height is not positive');
    if (el.name === 'w:spacing' && 'w:line' in el.attrs && !(parseInt(el.attrs['w:line'], 10) > 0)) problems.push('line height is not positive');
    if (el.name === 'wp:docPr') {
      if (ids.has(el.attrs.id)) problems.push(`duplicate drawing id ${el.attrs.id}`);
      ids.add(el.attrs.id);
    }
    if (el.name === 'wp:extent' && (parseInt(el.attrs.cx, 10) < 0 || parseInt(el.attrs.cy, 10) < 0)) problems.push('negative drawing extent');
    if (el.name === 'w:t' && /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(el.text)) problems.push('control character in text');
  }
  // The body must not end with a table (Word needs a paragraph after it).
  const body = find(root, 'w:body')[0];
  if (body) {
    const kids = body.children;
    if (!kids.length || kids[kids.length - 1].name !== 'w:sectPr') problems.push('the body does not end with section properties');
    for (let i = 0; i + 1 < kids.length; i++) {
      if (kids[i].name === 'w:tbl' && kids[i + 1].name !== 'w:p') problems.push('a table is not followed by a paragraph');
    }
  }
  for (const box of find(root, 'w:txbxContent')) {
    const lastChild = box.children[box.children.length - 1];
    if (!lastChild || lastChild.name !== 'w:p') problems.push('a text box does not end with a paragraph');
  }
  return [...new Set(problems)];
}
