// One grammar for rendering, indexing and rename. Offsets are UTF-16
// string offsets (including CRLF); callers can replace targets without reformatting.
// An article link is a standard (OKF) Markdown link to a `.md` path. Weave
// writes paths relative to the linking article, which every Markdown reader
// follows, and also reads OKF bundle-relative paths that start with `/`.
// An optional relationship is kept in the link title, which other readers
// treat as an ordinary tooltip:
//   [Snowflake](../infrastructure/snowflake.md "depends-on")
export const logicalPath = value => String(value).replaceAll('\\', '/').replace(/^\.\//, '');
export function normalizeRelationship(value = 'links-to') {
  return value.trim().normalize('NFC').toLowerCase().replace(/[\s_]+/gu, '-').replace(/-+/g, '-');
}
export const relationshipName = /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u;
// Inline Markdown in a label or heading, reduced to the text a reader sees.
export const plainText = value => String(value).replace(/\\([\\_*~`\[\]<>#()!|])|`+([^`]+)`+|\*\*([^*]+)\*\*|\[([^\]]+)\]\([^)]+\)/g, (_match, escaped, code, strong, link) => escaped ?? code ?? strong ?? link);
export const escapeLabel = value => String(value).replace(/([\\`*\[\]<>|])/g, '\\$1');
const dirname = file => logicalPath(file).split('/').slice(0, -1).join('/');
// A target relative to the source article, always starting with ./ or ../ so
// it cannot be mistaken for a workspace-root path.
export function relativeTarget(source, file) {
  const from = dirname(source) ? dirname(source).split('/') : [], to = logicalPath(file).replace(/^\/+/, '').split('/');
  let shared = 0; while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared++;
  return (from.length > shared ? '../'.repeat(from.length - shared) : './') + to.slice(shared).join('/');
}
// With a source article the target is relative to it; without one it uses the
// OKF bundle-relative form. Angle brackets keep paths with spaces or
// parentheses valid CommonMark destinations.
export const formatLinkTarget = (file, source = null) => {
  const target = source === null ? '/' + logicalPath(file).replace(/^\/+/, '') : relativeTarget(source, file);
  return /[\s()<>]/.test(target) ? '<' + target + '>' : target;
};
export const formatLink = (label, file, relationship = null, source = null) => '[' + escapeLabel(label) + '](' + formatLinkTarget(file, source) + (relationship && relationship !== 'links-to' ? ' "' + relationship + '"' : '') + ')';

const escaped = (text, index) => {let i = index; while (i > 0 && text[i - 1] === '\\') i--; return (index - i) % 2 === 1;};
const external = target => /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//') || target.startsWith('#');
function articlePath(destination) {
  const path = destination.split(/[?#]/, 1)[0];
  let decoded; try {decoded = decodeURIComponent(path);} catch {decoded = path;}
  return !external(destination) && /\.md$/i.test(decoded) ? decoded : null;
}
// Returns the closing `]` of a label opened at `start`, on the same line.
function labelEnd(text, start) {
  let depth = 0;
  for (let i = start; i < text.length && text[i] !== '\n'; i++) {
    if (escaped(text, i)) continue;
    if (text[i] === '`') {let n = 1; while (text[i + n] === '`') n++; const close = text.indexOf('`'.repeat(n), i + n); if (close < 0 || text.slice(i, close).includes('\n')) return -1; i = close + n - 1; continue;}
    if (text[i] === '[') depth++;
    if (text[i] === ']' && !--depth) return i;
  }
  return -1;
}
// Destination and optional title after `](`. Returns raw source offsets.
function destination(text, open) {
  let i = open + 1, from, to, title = null;
  while (text[i] === ' ' || text[i] === '\t') i++;
  if (text[i] === '<') {
    from = i + 1; to = from;
    while (to < text.length && text[to] !== '>' && text[to] !== '\n' && text[to] !== '<') to++;
    if (text[to] !== '>') return null;
    i = to + 1;
  } else {
    from = i; let depth = 0;
    for (to = i; to < text.length; to++) {
      const c = text[to];
      if (c === '\\' && to + 1 < text.length) {to++; continue;}
      if (/[\s]/.test(c) || c === ')' && !depth) break;
      if (c === '(') depth++; if (c === ')') depth--;
    }
    // Weave tolerates spaces in a bare path when the rest of the link is plain.
    if (text[to] === ' ') {const close = text.indexOf(')', to), line = text.indexOf('\n', to); if (close > 0 && (line < 0 || close < line) && /\.md$/i.test(text.slice(from, close).trimEnd()) && !/["'(]/.test(text.slice(to, close))) to = from + text.slice(from, close).trimEnd().length;}
    i = to;
  }
  while (text[i] === ' ' || text[i] === '\t') i++;
  const quote = {'"': '"', "'": "'", '(': ')'}[text[i]];
  if (quote && i > (text[from - 1] === '<' ? to + 1 : to)) {
    const close = text.indexOf(quote, i + 1), line = text.indexOf('\n', i + 1);
    if (close < 0 || line >= 0 && line < close) return null;
    title = {from: i + 1, to: close, text: text.slice(i + 1, close)};
    i = close + 1; while (text[i] === ' ' || text[i] === '\t') i++;
  }
  return text[i] === ')' ? {from, to, end: i + 1, angle: text[from - 1] === '<', title} : null;
}

export function parseLinks(text, source = '') {
  const links = [], diagnostics = [];
  let i = 0, line = 1, fence = null, inline = 0, comment = false, frontmatter = /^\uFEFF?---[ \t]*\r?\n/.test(text);
  while (i < text.length) {
    const lineStart = i === 0 || text[i - 1] === '\n';
    if (lineStart) {
      const end = text.indexOf('\n', i), row = text.slice(i, end < 0 ? text.length : end).replace(/\r$/, '');
      if (frontmatter) { if (i > 0 && /^(---|\.\.\.)\s*$/.test(row)) frontmatter = false; i += row.length; if (text[i] === '\r') i++; if (text[i] === '\n') { i++; line++; } continue; }
      const f = row.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (!comment && f && (!fence || f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim())) {
        fence = fence ? null : f[1]; inline = 0;
        i += row.length; if (text[i] === '\r') i++; if (text[i] === '\n') { i++; line++; } continue;
      }
      if (fence || /^(?: {4}|\t)/.test(row)) { i += row.length; if (text[i] === '\r') i++; if (text[i] === '\n') { i++; line++; } continue; }
    }
    if (text[i] === '\n') { line++; i++; continue; }
    if (text.startsWith('<!--', i) && !inline) { comment = true; i += 4; continue; }
    if (comment) { if (text.startsWith('-->', i)) { comment = false; i += 3; } else i++; continue; }
    if (text[i] === '\\' && !inline) { i += 2; continue; }
    if (text[i] === '`') { let n = 1; while (text[i + n] === '`') n++; if (!inline) inline = n; else if (inline === n) inline = 0; i += n; continue; }
    if (inline || text[i] !== '[') { i++; continue; }
    if (text.startsWith('[[', i)) {
      const close = text.indexOf(']]', i + 2), newline = text.indexOf('\n', i + 2);
      if (close > 0 && (newline < 0 || close < newline)) {diagnostics.push({source, line, start: i, message: 'Wiki links are not supported; use [Label](/path/article.md "relationship")'}); i = close + 2; continue;}
    }
    const start = i, close = labelEnd(text, i);
    if (close < 0 || text[close + 1] !== '(' || text[i - 1] === '!' && !escaped(text, i - 1)) { i++; continue; }
    const dest = destination(text, close + 1);
    const target = dest && articlePath(text.slice(dest.from, dest.to));
    if (!target) { i = close + 1; continue; }
    // A title that is a single relationship name types the link. A `)@@type`
    // suffix is read too, but reported so it can be moved into the title.
    const titled = dest.title && relationshipName.test(dest.title.text.trim()) ? dest.title.text.trim() : null;
    const legacy = text.slice(dest.end).match(/^@@([\p{L}\p{N}][\p{L}\p{N}_-]*)/u);
    if (legacy) diagnostics.push({source, line, start, message: 'Unsupported @@relationship suffix; use [Label](/path/article.md "relationship")'});
    const authored = titled || legacy?.[1] || null;
    const end = dest.end + (legacy?.[0].length || 0), label = text.slice(start + 1, close);
    links.push({source, target, relationship: normalizeRelationship(authored || 'links-to'), authoredRelationship: authored,
      label: plainText(label).trim() || null, typed: !!authored, start, end, labelStart: start + 1, labelEnd: close,
      targetStart: dest.from, targetEnd: dest.to, angle: dest.angle, titleStart: dest.title?.from ?? null, titleEnd: dest.title?.to ?? null,
      legacySuffix: !!legacy, line, raw: text.slice(start, end)});
    i = end;
  }
  return {links, diagnostics};
}

const join = (base, file) => {
  const parts = base ? base.split('/') : [];
  for (const part of file.split('/')) {if (part === '..') {if (!parts.length) return null; parts.pop();} else if (part !== '.' && part) parts.push(part);}
  return parts.join('/');
};
// Candidate workspace paths for an authored target, most specific first.
// OKF: `/path` is bundle-relative and other paths are relative to the source
// article. Bare paths also fall back to the workspace root; `bare: 'workspace'`
// tries that first.
function candidates(authored, source, bare) {
  const raw = String(authored).trim().replace(/^<|>$/g, '').replaceAll('\\', '/'), target = logicalPath(raw);
  if (raw.startsWith('/')) return [{path: raw.replace(/^\/+/, ''), fallback: false}];
  if (/^\.\.?\//.test(raw)) return [{path: join(dirname(source), raw), fallback: false}];
  const local = {path: join(dirname(source), target), fallback: false}, root = {path: target, fallback: !!dirname(source)};
  return dirname(source) ? (bare === 'workspace' ? [root, local] : [local, root]) : [{path: target, fallback: false}];
}
const listed = (map, key, value) => {const list = map.get(key); if (!list) map.set(key, [value]); else if (!list.includes(value)) list.push(value);};
const unlisted = (map, key, value) => {const list = map.get(key), i = list ? list.indexOf(value) : -1; if (i < 0) return; list.splice(i, 1); if (!list.length) map.delete(key);};
/** Exact-path and filename maps of a workspace's articles. Paths are added and
 * removed in place as the catalog changes, so resolving a link never indexes
 * the whole workspace again. */
export class PathResolver {
  constructor(paths = [], {caseSensitive = true} = {}) {
    this.caseSensitive = caseSensitive; this.exact = new Map(); this.basenames = new Map();
    for (const file of paths) this.add(file);
  }
  key(value) {return this.caseSensitive ? value : value.toLowerCase();}
  add(file) {const normalized = logicalPath(file); listed(this.exact, this.key(normalized), normalized); listed(this.basenames, this.key(normalized.split('/').at(-1)), normalized);}
  remove(file) {const normalized = logicalPath(file); unlisted(this.exact, this.key(normalized), normalized); unlisted(this.basenames, this.key(normalized.split('/').at(-1)), normalized);}
  resolve(authored, source = '', bare = 'source') {
    const options = candidates(authored, source, bare).filter(option => option.path).map(option => ({...option, path: /\.md$/i.test(option.path) ? option.path : option.path + '.md'}));
    let target = options[0]?.path || logicalPath(authored).trim(), fallback = false;
    if (!options.length || options.some(t => /[:\x00-\x1f]/.test(t.path) || t.path.split('/').some(p => !p || p === '.' || p === '..')))
      return {resolved: false, resolvedPath: null, targetPath: target, reason: 'invalid-path', candidates: [], fallback};
    let matches = [];
    for (const option of options) {matches = this.exact.get(this.key(option.path)) || []; if (matches.length) {target = option.path; fallback = option.fallback; break;}}
    const raw = String(authored).trim();
    if (!matches.length && !raw.includes('/') && !raw.includes('\\')) {matches = this.basenames.get(this.key(target.split('/').at(-1))) || []; fallback = true;}
    return {resolved: matches.length === 1, resolvedPath: matches.length === 1 ? matches[0] : null,
      targetPath: target, reason: matches.length === 1 ? null : matches.length ? 'ambiguous' : 'missing', candidates: matches.slice(), fallback: matches.length === 1 && fallback};
  }
}
// Resolvers of path lists, by list: editors, previews and search results all
// resolve against the same catalog list, which is indexed once, not per call.
const resolvers = new WeakMap();
/** `paths` is a list of article paths, a `PathResolver`, or an object with a
 * `resolver` (a catalog index), which stays current as the catalog changes. */
export function createResolver(paths, {caseSensitive = true, bare = 'source'} = {}) {
  let resolver = paths instanceof PathResolver ? paths : paths?.resolver instanceof PathResolver ? paths.resolver : null;
  if (!resolver) {
    const list = paths && typeof paths === 'object' ? paths : [], cached = resolvers.get(list) || {};
    resolver = cached[caseSensitive] ||= new PathResolver(list, {caseSensitive});
    if (list === paths) resolvers.set(list, cached);
  }
  return (authored, source = '') => resolver.resolve(authored, source, bare);
}

// Rename support: rewrite only link destinations, keeping each link's form.
// Bundle-relative links change when their target moves; relative links also
// change when the source article itself moves. Labels and titles stay as-is.
export function rewriteTargets(text, links, changes, {source = '', nextSource = source} = {}) {
  let result = text;
  for (const link of [...links].sort((a, b) => b.targetStart - a.targetStart)) {
    if (!link.resolvedPath) continue;
    const target = changes.get(link.resolvedPath) || link.resolvedPath, absolute = String(link.target).startsWith('/');
    if (target === link.resolvedPath && (absolute || nextSource === source)) continue;
    const formatted = formatLinkTarget(target, absolute ? null : nextSource), bare = formatted.replace(/^<|>$/g, '');
    result = link.angle ? result.slice(0, link.targetStart) + bare + result.slice(link.targetEnd) : result.slice(0, link.targetStart) + formatted + result.slice(link.targetEnd);
  }
  return result;
}
