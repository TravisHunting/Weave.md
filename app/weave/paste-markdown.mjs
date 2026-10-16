// Paste converts formatted clipboard HTML (from web pages, documents or Weave's
// own reader) into Markdown: headings, emphasis, links, lists, quotes, code,
// tables and images. Clipboard HTML without such formatting (code editors
// colour text with spans) pastes as its plain text, keeping its layout, and
// "Paste as plain text" always does. Nothing in the HTML is run or loaded: it
// is parsed into an inert document and only read.

const SEMANTIC = 'a[href],b,strong,em,i,s,del,strike,mark,h1,h2,h3,h4,h5,h6,ul,ol,blockquote,pre,code,table,img[src],hr';
const BLOCKS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'UL']);
const DROPPED = 'script,style,template,head,meta,link,noscript,iframe,object,embed,svg,canvas,button,input,select,textarea';
const LINKS = /^(?:https?:|mailto:)/i;

const escapeText = text => text.replace(/([\\`*_[\]<>])/g, '\\$1').replace(/==/g, '=\\=');
const fenceFor = (text, minimum) => '`'.repeat(Math.max(minimum, ...[...text.matchAll(/`+/g)].map(run => run[0].length + 1)));
const destination = url => /[\s()<>]/.test(url) ? '<' + url.replace(/[<>]/g, encodeURIComponent) + '>' : url;
const weight = element => element.style?.fontWeight;
const bold = element => ['bold', 'bolder', '600', '700', '800', '900'].includes(weight(element));

/** Whether `html` carries formatting worth converting rather than pasting as plain text. */
export function hasFormatting(html) {
  if (!html || typeof DOMParser === 'undefined') return false;
  const body = parse(html);
  // Google Docs wraps every copy in <b style="font-weight:normal">.
  for (const node of body.querySelectorAll('b,strong')) if (['normal', '400'].includes(weight(node))) node.replaceWith(...node.childNodes);
  return !!body.querySelector(SEMANTIC) || [...body.querySelectorAll('span[style]')].some(node => bold(node) || node.style.fontStyle === 'italic');
}
function parse(html) {
  const body = new DOMParser().parseFromString(String(html), 'text/html').body;
  for (const node of body.querySelectorAll(DROPPED)) node.remove();
  return body;
}

/** Markdown for clipboard HTML. `underline` keeps <u> as Weave's underline tags. */
export function htmlToMarkdown(html, {underline = false} = {}) {
  const body = parse(html);
  const wrap = (inner, mark) => {
    const text = inner.trim();
    if (!text) return inner;
    const lead = inner.match(/^\s*/)[0] ? ' ' : '', tail = inner.match(/\s*$/)[0] ? ' ' : '';
    return lead + mark + text + (mark === '<u>' ? '</u>' : mark) + tail;
  };
  function inline(node, pre = false) {
    if (node.nodeType === 3) return pre ? node.data : escapeText(node.data.replace(/\s+/g, ' '));
    if (node.nodeType !== 1) return '';
    const tag = node.tagName, inner = () => [...node.childNodes].map(child => inline(child, pre)).join('');
    if (pre) return tag === 'BR' ? '\n' : inner();
    switch (tag) {
      case 'BR': return '\n';
      case 'B': case 'STRONG': return ['normal', '400'].includes(weight(node)) ? inner() : wrap(inner(), '**');
      case 'I': case 'EM': case 'CITE': return node.style.fontStyle === 'normal' ? inner() : wrap(inner(), '*');
      case 'S': case 'DEL': case 'STRIKE': return wrap(inner(), '~~');
      case 'MARK': return wrap(inner(), '==');
      case 'U': case 'INS': return underline ? wrap(inner(), '<u>') : inner();
      case 'CODE': case 'KBD': case 'SAMP': {
        const text = node.textContent.replace(/\s+/g, ' ');
        if (!text.trim()) return text;
        const fence = fenceFor(text, 1), pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
        return fence + pad + text + pad + fence;
      }
      case 'A': {
        const href = node.getAttribute('href')?.trim() || '', label = inner();
        if (!LINKS.test(href)) return label;
        return label.trim() ? `[${label.trim()}](${destination(href)})` : `<${href}>`;
      }
      case 'IMG': {
        const src = node.getAttribute('src')?.trim() || '', alt = escapeText((node.getAttribute('alt') || '').replace(/\s+/g, ' ').trim());
        return /^https?:/i.test(src) ? `![${alt}](${destination(src)})` : alt;
      }
      case 'SPAN': {
        let text = inner();
        if (node.style.fontStyle === 'italic') text = wrap(text, '*');
        if (bold(node)) text = wrap(text, '**');
        return text;
      }
      default: return BLOCKS.has(tag) ? blocks(node).join(' ') : inner();
    }
  }
  /** The Markdown blocks of a container, in order. */
  function blocks(node) {
    const out = [];
    let run = '';
    const flush = () => {
      const text = run.split('\n').map(line => line.trim()).join('\n').replace(/^\n+|\n+$/g, '');
      if (text) out.push(text);
      run = '';
    };
    for (const child of node.childNodes) {
      if (child.nodeType === 1 && BLOCKS.has(child.tagName)) {flush(); out.push(...block(child));}
      else run += inline(child);
    }
    flush();
    return out;
  }
  function block(node) {
    const tag = node.tagName;
    if (/^H[1-6]$/.test(tag)) {const text = inline(node).replace(/\s+/g, ' ').trim(); return text ? ['#'.repeat(Number(tag[1])) + ' ' + text] : [];}
    if (tag === 'HR') return ['---'];
    if (tag === 'PRE') {
      const text = [...node.childNodes].map(child => inline(child, true)).join('').replace(/\n$/, '');
      const language = (node.querySelector('code')?.className || node.className).match(/(?:^|\s)(?:language|lang)-([\w+#.-]+)/)?.[1] || '';
      const fence = fenceFor(text, 3);
      return [fence + language + '\n' + text + '\n' + fence];
    }
    if (tag === 'BLOCKQUOTE') {
      const text = blocks(node).join('\n\n');
      return text ? [text.split('\n').map(line => line ? '> ' + line : '>').join('\n')] : [];
    }
    if (tag === 'UL' || tag === 'OL') {
      const start = Number(node.getAttribute('start')) || 1, items = [...node.children].filter(item => item.tagName === 'LI');
      const lines = items.map((item, index) => {
        const task = item.querySelector(':scope > input[type=checkbox], :scope > p > input[type=checkbox]');
        const marker = (tag === 'OL' ? (start + index) + '.' : '-') + ' ' + (task ? (task.checked ? '[x] ' : '[ ] ') : '');
        const text = blocks(item).join('\n') || '';
        const indent = ' '.repeat(tag === 'OL' ? String(start + index).length + 2 : 2);
        return marker + text.split('\n').map((line, i) => i && line ? indent + line : line).join('\n');
      });
      return lines.length ? [lines.join('\n')] : [];
    }
    if (tag === 'TABLE') {
      const rows = [...node.querySelectorAll('tr')].filter(row => row.closest('table') === node).map(row => [...row.children].filter(cell => /^T[HD]$/.test(cell.tagName)).map(cell => inline(cell).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')));
      const width = Math.max(0, ...rows.map(row => row.length));
      if (!width) return [];
      const line = row => '| ' + Array.from({length: width}, (_, i) => row[i] || '').join(' | ') + ' |';
      return [[line(rows[0]), '| ' + Array(width).fill('---').join(' | ') + ' |', ...rows.slice(1).map(line)].join('\n')];
    }
    return blocks(node);
  }
  return blocks(body).join('\n\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** The text a paste inserts: Markdown from formatted HTML, otherwise the plain text. */
export function pasteText({html = '', text = ''} = {}, {plain = false, underline = false} = {}) {
  const converted = !plain && hasFormatting(html) ? htmlToMarkdown(html, {underline}) : '';
  return (converted || text || '').replace(/\r\n?/g, '\n');
}
