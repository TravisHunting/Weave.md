// Mermaid diagrams in ```mermaid fenced code. The Markdown source stays the
// article's content; diagrams are drawn in the reader only, never written to a
// workspace, and never by the Rust backend.
//
// - The Mermaid runtime is carried in the page as inert text (build.mjs) and
//   run the first time an article actually shows a diagram.
// - A diagram is drawn when its placeholder scrolls into view, one at a time,
//   with `securityLevel: 'strict'`.
// - Drawings are cached by source hash and theme, and shown as an <img> of the
//   SVG: an image runs no script, takes no events and keeps Mermaid's styles
//   away from the page (and the page's CSP away from Mermaid's styles).
// - The theme is derived from the colour scheme, the skin's diagram tokens
//   (`--diagram-*` in skin-contract.css) and Settings › Visual styling › Diagrams.
import {StateField,StateEffect} from '@codemirror/state';
import {EditorView,Decoration,WidgetType} from '@codemirror/view';
import {syntaxTree} from '@codemirror/language';
import {tableFocusChanged} from './table-preview.mjs';
import {mermaidPalettes} from './mermaid-palettes.mjs';

/** True for a fence info string naming Mermaid (```mermaid, ~~~ Mermaid title). */
export const isMermaidInfo = info => /^mermaid$/i.test(String(info || '').trim().split(/\s+/)[0]);

/** 53-bit string hash (cyrb53); the cache key pairs it with the source length. */
export function sourceHash(text) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {const c = text.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);}
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + '.' + text.length.toString(36);
}

// Colours ------------------------------------------------------------------
export const parseColour = value => {
  const text = String(value || '').trim(), short = text.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i), long = text.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i), rgb = text.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (long) return long.slice(1, 4).map(part => parseInt(part, 16));
  if (short) return short.slice(1, 4).map(part => parseInt(part + part, 16));
  if (rgb) return /^rgba/i.test(text) && /[,/]\s*0\s*\)$/.test(text) ? null : rgb.slice(1, 4).map(Number);
  // Computed colour-mix() values (Chromium serialises them in this form).
  const srgb = text.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+))?\)/i);
  if (srgb) return srgb[4] === '0' ? null : srgb.slice(1, 4).map(part => Number(part) * 255);
  return null;
};
const hex = rgb => '#' + rgb.map(part => Math.round(Math.max(0, Math.min(255, part))).toString(16).padStart(2, '0')).join('');
/** `amount` of `b` mixed into `a`. */
const mix = (a, b, amount) => a.map((part, i) => part + (b[i] - part) * amount);
const luminance = rgb => {const [r, g, b] = rgb.map(part => {part /= 255; return part <= .03928 ? part / 12.92 : ((part + .055) / 1.055) ** 2.4;}); return .2126 * r + .7152 * g + .0722 * b;};
function toHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1)), h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function fromHsl(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map(part => (part + m) * 255);
}

export {mermaidPalettes};
// Hues that sit well together: blue, violet, teal, amber, rose, green, …
const HUES = [212, 266, 168, 34, 338, 120, 190, 296, 12, 52, 236, 146];

/**
 * Mermaid's configuration for one appearance. `colours` holds the scheme's
 * palette (hex), `tokens` the skin's diagram tokens, `settings` the Diagrams
 * preferences. Pure, so the theme key (and cache) follows the appearance.
 */
export function mermaidConfig({colours, tokens = {}, settings = {}}) {
  const c = key => parseColour(colours[key]) || [128, 128, 128];
  const paper = c('paper'), ink = c('ink'), line = c('line'), muted = c('muted');
  // What the diagram is drawn on: the frame's surface, or the article.
  const surface = parseColour(tokens.surface) || paper;
  const accent = parseColour(settings.accent) || c('accent');
  const dark = luminance(paper) < .3;
  const palette = Object.hasOwn(mermaidPalettes, settings.palette) ? settings.palette : 'scheme';
  const font = tokens.font || '"Segoe UI", system-ui, sans-serif', fontSize = 15;
  const radius = Math.max(0, Math.min(24, parseFloat(tokens.radius) || 0)), stroke = Math.max(.5, Math.min(4, parseFloat(tokens.stroke) || 1));
  const curve = {smooth: 'basis', straight: 'linear', stepped: 'step', rounded: 'monotoneX'}[settings.curve] || 'basis';
  const look = settings.look === 'handDrawn' ? 'handDrawn' : 'classic';
  const common = {startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, maxTextSize: 100000, maxEdges: 1000, fontFamily: font, look, htmlLabels: true, flowchart: {curve, htmlLabels: true, useMaxWidth: false}, sequence: {useMaxWidth: false}, gantt: {useMaxWidth: false}, journey: {useMaxWidth: false}, class: {useMaxWidth: false}, state: {useMaxWidth: false}, er: {useMaxWidth: false}, pie: {useMaxWidth: false}, mindmap: {useMaxWidth: false}, timeline: {useMaxWidth: false}, gitGraph: {useMaxWidth: false}, requirement: {useMaxWidth: false}, quadrantChart: {useMaxWidth: false}, xyChart: {useMaxWidth: false}, sankey: {useMaxWidth: false}, block: {useMaxWidth: false}, architecture: {useMaxWidth: false}, packet: {useMaxWidth: false}, kanban: {useMaxWidth: false}, radar: {useMaxWidth: false}, treemap: {useMaxWidth: false}};
  const themeCSS = `.node rect.label-container,.node rect.basic,.cluster rect{rx:${radius}px;ry:${radius}px}.node rect,.node circle,.node ellipse,.node polygon,.node path{stroke-width:${stroke}px}.flowchart-link{stroke-width:${Math.max(1, stroke)}px}`;
  if (palette === 'mermaid') return {...common, theme: dark ? 'dark' : 'default', themeVariables: {fontFamily: font, fontSize: fontSize + 'px'}, themeCSS};

  // Series colours (pie slices, mind-map branches, Git branches, journeys):
  // fills mixed toward the article colour, so diagrams stay calm on the page.
  const base = toHsl(accent), sat = {scheme: Math.max(.35, Math.min(.68, base[1])), pastel: .55, vivid: .78, mono: 0}[palette];
  const hues = palette === 'scheme' ? [0, 38, -38, 76, -76, 152, 180, 114, -114, 210, 250, 290].map(offset => base[0] + offset) : HUES;
  const fillAmount = {scheme: dark ? .34 : .22, pastel: dark ? .3 : .24, vivid: dark ? .55 : .45, mono: dark ? .2 : .1}[palette];
  const series = hues.map((hue, i) => palette === 'mono' ? mix(paper, ink, fillAmount + (i % 6) * .07) : mix(paper, fromHsl(hue, sat, dark ? .6 : .5), fillAmount));
  const seriesBorder = hues.map((hue, i) => palette === 'mono' ? mix(paper, ink, .55) : mix(fromHsl(hue, sat, dark ? .68 : .42), ink, .1));
  const primary = palette === 'mono' ? mix(paper, ink, dark ? .12 : .06) : palette === 'scheme' ? mix(paper, accent, dark ? .26 : .13) : series[0];
  const primaryBorder = palette === 'mono' ? mix(paper, ink, .5) : palette === 'scheme' ? mix(accent, ink, dark ? .05 : .15) : seriesBorder[0];
  const secondary = series[1], tertiary = mix(paper, ink, dark ? .07 : .035), lines = mix(muted, ink, .15), note = palette === 'mono' ? mix(paper, ink, .1) : mix(paper, fromHsl(48, .85, .55), dark ? .25 : .3);
  const v = {
    darkMode: dark, background: hex(paper), fontFamily: font, fontSize: fontSize + 'px',
    primaryColor: hex(primary), primaryTextColor: hex(ink), primaryBorderColor: hex(primaryBorder),
    secondaryColor: hex(secondary), secondaryTextColor: hex(ink), secondaryBorderColor: hex(seriesBorder[1]),
    tertiaryColor: hex(tertiary), tertiaryTextColor: hex(ink), tertiaryBorderColor: hex(line),
    mainBkg: hex(primary), nodeBorder: hex(primaryBorder), nodeTextColor: hex(ink), textColor: hex(ink), titleColor: hex(ink),
    lineColor: hex(lines), defaultLinkColor: hex(lines), arrowheadColor: hex(lines),
    clusterBkg: hex(tertiary), clusterBorder: hex(line), edgeLabelBackground: hex(surface),
    noteBkgColor: hex(note), noteTextColor: hex(ink), noteBorderColor: hex(mix(note, ink, .3)),
    actorBkg: hex(primary), actorBorder: hex(primaryBorder), actorTextColor: hex(ink), actorLineColor: hex(lines),
    signalColor: hex(ink), signalTextColor: hex(ink), labelBoxBkgColor: hex(primary), labelBoxBorderColor: hex(primaryBorder), labelTextColor: hex(ink), loopTextColor: hex(ink),
    activationBkgColor: hex(secondary), activationBorderColor: hex(seriesBorder[1]), sequenceNumberColor: hex(paper),
    sectionBkgColor: hex(tertiary), altSectionBkgColor: hex(paper), sectionBkgColor2: hex(secondary), taskBkgColor: hex(primary), taskBorderColor: hex(primaryBorder), taskTextColor: hex(ink), taskTextDarkColor: hex(ink), taskTextOutsideColor: hex(ink), activeTaskBkgColor: hex(secondary), activeTaskBorderColor: hex(seriesBorder[1]), doneTaskBkgColor: hex(tertiary), doneTaskBorderColor: hex(line), critBkgColor: hex(mix(paper, fromHsl(4, .7, .5), .3)), critBorderColor: hex(fromHsl(4, .6, dark ? .65 : .45)), gridColor: hex(line), todayLineColor: hex(accent),
    pieStrokeColor: hex(paper), pieOuterStrokeColor: hex(line), pieTitleTextColor: hex(ink), pieSectionTextColor: hex(ink), pieLegendTextColor: hex(ink),
    labelColor: hex(ink), errorBkgColor: hex(mix(paper, fromHsl(4, .7, .5), .2)), errorTextColor: hex(ink),
    commitLabelColor: hex(ink), commitLabelBackground: hex(tertiary), tagLabelColor: hex(ink), tagLabelBackground: hex(primary), tagLabelBorder: hex(primaryBorder),
    relationColor: hex(lines), relationLabelColor: hex(ink), relationLabelBackground: hex(surface),
    quadrant1Fill: hex(series[0]), quadrant2Fill: hex(series[1]), quadrant3Fill: hex(series[2]), quadrant4Fill: hex(series[3]), quadrant1TextFill: hex(ink), quadrant2TextFill: hex(ink), quadrant3TextFill: hex(ink), quadrant4TextFill: hex(ink), quadrantPointFill: hex(primaryBorder), quadrantPointTextFill: hex(ink), quadrantTitleFill: hex(ink), quadrantXAxisTextFill: hex(ink), quadrantYAxisTextFill: hex(ink), quadrantInternalBorderStrokeFill: hex(line), quadrantExternalBorderStrokeFill: hex(line),
    xyChart: {backgroundColor: hex(paper), titleColor: hex(ink), xAxisLabelColor: hex(ink), xAxisTitleColor: hex(ink), xAxisTickColor: hex(lines), xAxisLineColor: hex(lines), yAxisLabelColor: hex(ink), yAxisTitleColor: hex(ink), yAxisTickColor: hex(lines), yAxisLineColor: hex(lines), plotColorPalette: seriesBorder.map(hex).join(',')}
  };
  series.forEach((colour, i) => {v['pie' + (i + 1)] = hex(palette === 'vivid' ? seriesBorder[i] : mix(colour, seriesBorder[i], .35)); v['cScale' + i] = hex(colour); v['cScaleLabel' + i] = hex(ink); v['cScalePeer' + i] = hex(seriesBorder[i]); v['fillType' + (i % 8)] = hex(colour);});
  seriesBorder.slice(0, 8).forEach((colour, i) => {v['git' + i] = hex(colour); v['gitBranchLabel' + i] = hex(dark ? ink : paper); v['gitInv' + i] = hex(paper);});
  return {...common, theme: 'base', themeVariables: v, themeCSS};
}

// Appearance ----------------------------------------------------------------
const COLOUR_KEYS = ['paper', 'ink', 'muted', 'line', 'accent', 'code', 'wash', 'bg'];
const root = () => document.documentElement;
/** Whether diagrams are drawn at all (Settings › Visual styling › Diagrams). */
// Exports made without diagrams carry no runtime: their fences stay code.
export const mermaidEnabled = () => typeof document !== 'undefined' && root().dataset.mermaid !== 'false' && !!(globalThis.weaveMermaid || document.getElementById('weave-mermaid-runtime'));
const previewEnabled = () => root().dataset.mermaidPreview !== 'false';
let theme = null, themeSignature = '';
/** The current theme. `fresh` re-reads the appearance (after it changes);
 * the configuration is rebuilt only when its inputs differ. */
export function currentMermaidTheme({fresh = false} = {}) {
  if (theme && !fresh) return theme;
  const style = getComputedStyle(root()), data = root().dataset, read = name => style.getPropertyValue(name).trim();
  const colours = Object.fromEntries(COLOUR_KEYS.map(key => [key, read('--' + key)]));
  const tokens = {font: read('--diagram-font'), radius: read('--diagram-radius'), stroke: read('--diagram-stroke-width'), surface: getComputedStyle(diagramSandbox()).backgroundColor};
  const settings = {palette: data.mermaidPalette, look: data.mermaidLook, curve: data.mermaidCurve, accent: data.mermaidAccent};
  const signature = JSON.stringify([colours, tokens, settings]);
  if (signature !== themeSignature || !theme) {
    const config = mermaidConfig({colours, tokens, settings});
    themeSignature = signature; theme = {config, key: sourceHash(JSON.stringify(config))};
  }
  return theme;
}

// Rendering -----------------------------------------------------------------
const cache = new Map(), sizes = new Map(), CACHE_LIMIT = 160;
let runtime = null, configured = '', queue = Promise.resolve(), counter = 0, sandbox = null;
/** Counters for tests and diagnostics. */
export const mermaidStats = {loaded: false, renders: 0, cacheHits: 0};
if (typeof window !== 'undefined') window.weaveMermaidStats = mermaidStats;

function loadMermaid() {
  // The page carries Mermaid as inert text (build.mjs); running it as an inline
  // script with the same text matches its script-src hash.
  return runtime ??= Promise.resolve().then(() => {
    const source = document.getElementById('weave-mermaid-runtime');
    if (!globalThis.weaveMermaid && source) {
      const script = document.createElement('script'); script.textContent = source.textContent;
      document.head.append(script); script.remove(); source.remove();
    }
    if (!globalThis.weaveMermaid) throw new Error('Mermaid diagrams are not available in this page.');
    mermaidStats.loaded = true; return globalThis.weaveMermaid;
  });
}

// The packaged desktop and server pages hash their style-src, so the <style>
// element and style attributes Mermaid adds while measuring would not apply,
// and labels would be measured without their fonts. For the duration of one
// render, style attributes of Mermaid's elements go through the CSSOM and the
// diagram's <style> becomes a constructed stylesheet; the page's own elements
// (and CodeMirror's refused <style>) are left alone. The SVG Mermaid returns is unaffected:
// both stay in its markup, which the <img> applies in its own document.
async function withInlineStyles(task) {
  const {setAttribute} = Element.prototype, {insertBefore, appendChild} = Node.prototype, sheets = [];
  const adopt = node => {
    if (node?.localName !== 'style' || !node.textContent || !sandbox?.contains(node) || typeof CSSStyleSheet !== 'function' || !('adoptedStyleSheets' in document)) return;
    try {const sheet = new CSSStyleSheet(); sheet.replaceSync(node.textContent); sheets.push(sheet); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];} catch {}
  };
  Element.prototype.setAttribute = function(name, value) {
    // Only Mermaid's elements: those in the sandbox, or not yet placed anywhere.
    if (String(name).toLowerCase() === 'style' && this.style && (!this.isConnected || sandbox?.contains(this))) {this.style.cssText = String(value); return;}
    return setAttribute.call(this, name, value);
  };
  Node.prototype.insertBefore = function(node, child) {const result = insertBefore.call(this, node, child); adopt(node); return result;};
  Node.prototype.appendChild = function(node) {const result = appendChild.call(this, node); adopt(node); return result;};
  try {return await task();}
  finally {
    Element.prototype.setAttribute = setAttribute; Node.prototype.insertBefore = insertBefore; Node.prototype.appendChild = appendChild;
    if (sheets.length) document.adoptedStyleSheets = document.adoptedStyleSheets.filter(sheet => !sheets.includes(sheet));
  }
}

/** Mermaid's SVG as an image: sized from its viewBox, well-formed XML. */
export function svgImage(svg) {
  const element = new DOMParser().parseFromString(svg, 'text/html').querySelector('svg');
  if (!element) throw new Error('Mermaid produced no diagram.');
  const box = (element.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const width = Math.ceil(box.length === 4 && box[2] > 0 ? box[2] : parseFloat(element.getAttribute('width')) || 300);
  const height = Math.ceil(box.length === 4 && box[3] > 0 ? box[3] : parseFloat(element.getAttribute('height')) || 150);
  element.setAttribute('width', String(width)); element.setAttribute('height', String(height));
  element.style?.removeProperty('max-width');
  const xml = new XMLSerializer().serializeToString(element);
  return {src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml), width, height};
}

// Where Mermaid lays diagrams out (off-screen); painted with the frame surface,
// so the theme can read that colour for edge labels.
function diagramSandbox() {
  if (!sandbox?.isConnected) {sandbox = document.createElement('div'); sandbox.className = 'mermaid-sandbox'; sandbox.setAttribute('aria-hidden', 'true'); document.body.append(sandbox);}
  return sandbox;
}
const errorText = error => String(error?.message || error || 'Mermaid could not draw this diagram.').replace(/\s+$/, '');
async function draw(source, current) {
  const mermaid = await loadMermaid();
  if (configured !== current.key) {mermaid.initialize(structuredClone(current.config)); configured = current.key;}
  const id = 'weave-mermaid-' + (++counter), host = document.createElement('div');
  diagramSandbox().append(host);
  try {
    mermaidStats.renders++;
    const {svg} = await withInlineStyles(() => mermaid.render(id, source, host));
    return svgImage(svg);
  } finally {host.remove(); document.getElementById(id)?.remove(); document.getElementById('d' + id)?.remove();}
}

/** Draws `source` (cached by source hash and theme). Resolves to {src,width,height} or {error}. */
export function renderMermaid(source, current = currentMermaidTheme()) {
  const key = current.key + ':' + sourceHash(source);
  const hit = cache.get(key);
  if (hit) {cache.delete(key); cache.set(key, hit); mermaidStats.cacheHits++; return hit.promise;}
  const entry = {result: null};
  const run = queue.then(() => draw(source, current)).then(result => result, error => ({error: errorText(error)}));
  queue = run.then(() => {}, () => {});
  entry.promise = run.then(result => {entry.result = result; if (result.height) sizes.set(sourceHash(source), result.height); return result;});
  cache.set(key, entry);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return entry.promise;
}
/** A finished drawing, without waiting or drawing. */
export function cachedMermaid(source, current = currentMermaidTheme()) {
  const result = cache.get(current.key + ':' + sourceHash(source))?.result || null;
  if (result) mermaidStats.cacheHits++;
  return result;
}

// Diagram boxes ------------------------------------------------------------
// A box shows one diagram. It draws only once it is (nearly) visible.
let observer = null;
const visibility = () => observer ??= typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) {observer.unobserve(entry.target); entry.target.__mermaid?.visible();}
}, {rootMargin: '400px 0px'}) : null;

const altText = source => {const title = source.match(/^\s*accTitle\s*:\s*(.+)$/m)?.[1]?.trim(), type = source.trim().split(/\s/)[0] || ''; return title ? 'Diagram: ' + title : 'Mermaid ' + type + ' diagram';};

class DiagramBox {
  constructor({preview = false, measured = () => {}} = {}) {
    this.root = document.createElement('div'); this.root.className = 'mermaid-diagram' + (preview ? ' mermaid-preview' : '');
    this.root.__mermaid = this; this.measured = measured; this.preview = preview;
    this.figure = document.createElement('div'); this.figure.className = 'mermaid-figure';
    this.message = document.createElement('pre'); this.message.className = 'mermaid-error'; this.message.hidden = true;
    this.root.append(this.figure, this.message);
  }
  set(source, current) {
    if (source === this.source && current.key === this.theme?.key) return;
    this.source = source; this.theme = current; this.generation = (this.generation || 0) + 1;
    clearTimeout(this.timer);
    const done = cachedMermaid(source, current);
    if (done) {this.show(done); return;}
    const height = sizes.get(sourceHash(source));
    if (height && !this.image) this.root.style.setProperty('--mermaid-height', height + 'px');
    this.root.dataset.state = this.image ? 'updating' : 'pending';
    // A preview being typed into redraws after a pause, keeping its last drawing meanwhile.
    if (this.preview && this.image) this.timer = setTimeout(() => this.visible(), 350);
    else if (visibility()) visibility().observe(this.root); else this.visible();
  }
  visible() {
    const generation = this.generation, {source, theme} = this;
    renderMermaid(source, theme).then(result => {if (generation === this.generation) this.show(result);});
  }
  show(result) {
    if (result.error) {
      this.root.dataset.state = 'error';
      this.message.hidden = false; this.message.textContent = 'Mermaid: ' + result.error;
    } else {
      this.root.dataset.state = 'ready'; this.message.hidden = true;
      if (!this.image) {this.image = document.createElement('img'); this.image.decoding = 'sync'; this.image.draggable = false; this.figure.append(this.image);}
      this.image.alt = altText(this.source); this.image.width = result.width; this.image.height = result.height;
      this.image.style.setProperty('--diagram-width', result.width + 'px');
      if (this.image.getAttribute('src') !== result.src) this.image.src = result.src;
      this.root.style.removeProperty('--mermaid-height');
    }
    this.measured();
  }
  destroy() {clearTimeout(this.timer); observer?.unobserve(this.root); this.generation++;}
}

/** Replaces ```mermaid code in rendered HTML (card previews) with diagrams. */
export function hydrateMermaid(container) {
  if (!mermaidEnabled()) return;
  for (const code of container.querySelectorAll('pre > code[data-language]')) {
    if (!isMermaidInfo(code.dataset.language)) continue;
    const box = new DiagramBox(); code.parentElement.replaceWith(box.root); box.set(code.textContent, currentMermaidTheme());
  }
}

// CodeMirror ------------------------------------------------------------
class MermaidWidget extends WidgetType {
  constructor(source, theme, preview) {super(); Object.assign(this, {source, theme, preview});}
  eq(other) {return other.source === this.source && other.theme.key === this.theme.key && other.preview === this.preview;}
  get estimatedHeight() {const height = sizes.get(sourceHash(this.source)); return height ? height + 30 : -1;}
  toDOM(view) {
    const box = new DiagramBox({preview: this.preview, measured: () => view.requestMeasure()});
    box.root.setAttribute('role', 'figure');
    // While editing, clicking a diagram opens its source (the caret enters the
    // fence's first body row); a preview's click places the caret in the code.
    box.root.addEventListener('mousedown', event => {
      if (event.button !== 0 || view.state.readOnly) return;
      event.preventDefault();
      const at = view.posAtDOM(box.root), line = view.state.doc.lineAt(Math.min(at, view.state.doc.length));
      const target = this.preview ? line.from : Math.min(view.state.doc.length, line.to + 1);
      view.dispatch({selection: {anchor: target}, effects: tableFocusChanged.of(true), scrollIntoView: true, userEvent: 'select.pointer'}); view.focus();
    });
    box.set(this.source, this.theme);
    return box.root;
  }
  updateDOM(dom) {if (!dom.__mermaid || dom.__mermaid.preview !== this.preview) return false; dom.__mermaid.set(this.source, this.theme); return true;}
  destroy(dom) {dom.__mermaid?.destroy();}
  ignoreEvent() {return true;}
}

const mermaidPreferencesChanged = StateEffect.define();
const CONTAINERS = new Set(['Document', 'BulletList', 'OrderedList', 'ListItem']);
const FENCE_END = /^\s*(?:`{3,}|~{3,})\s*$/;
/** Changes in appearance (theme, palette, on/off) redraw an editor's diagrams. */
export function refreshMermaid(view) {
  if (!view || typeof document === 'undefined') return;
  const signature = mermaidEnabled() + '|' + previewEnabled() + '|' + (mermaidEnabled() ? currentMermaidTheme({fresh: true}).key : '');
  if (view.__weaveMermaid === signature) return;
  view.__weaveMermaid = signature;
  view.dispatch({effects: mermaidPreferencesChanged.of(null)});
}

/** Mermaid fences shown as diagrams. Reading shows the diagram; editing shows it
 * until the caret enters the fence, then the source with a live preview below. */
export function mermaidField() {
  const build = (state, focused) => {
    if (!mermaidEnabled()) return {decorations: Decoration.none, has: false, focused};
    const decorations = [], doc = state.doc; let has = false, current = null;
    syntaxTree(state).iterate({enter: node => {
      if (node.name !== 'FencedCode') return CONTAINERS.has(node.name);
      const info = node.node.getChild('CodeInfo');
      if (!info || !isMermaidInfo(doc.sliceString(info.from, info.to))) return false;
      const first = doc.lineAt(node.from), last = doc.lineAt(node.to);
      // Only fences that start their row (optionally indented, as in lists).
      if (doc.sliceString(first.from, node.from).trim()) return false;
      has = true; current ??= currentMermaidTheme();
      const closed = last.number > first.number && FENCE_END.test(last.text);
      const source = doc.sliceString(Math.min(first.to + 1, doc.length), closed ? Math.max(first.to + 1, last.from - 1) : last.to);
      const editing = !state.readOnly && focused && state.selection.ranges.some(range => range.from <= last.to && range.to >= first.from);
      if (editing) {
        if (previewEnabled() && source.trim()) decorations.push(Decoration.widget({widget: new MermaidWidget(source, current, true), block: true, side: 1}).range(last.to));
      } else decorations.push(Decoration.replace({widget: new MermaidWidget(source, current, false), block: true}).range(first.from, last.to));
      return false;
    }});
    return {decorations: Decoration.set(decorations, true), has, focused};
  };
  return StateField.define({
    create: state => build(state, false),
    update(value, tr) {
      const focused = tr.effects.find(effect => effect.is(tableFocusChanged))?.value ?? value.focused;
      const rebuild = tr.docChanged || focused !== value.focused || tr.effects.some(effect => effect.is(mermaidPreferencesChanged)) || tr.state.readOnly !== tr.startState.readOnly || (tr.selection && value.has) || syntaxTree(tr.state) !== syntaxTree(tr.startState);
      return rebuild ? build(tr.state, focused) : value;
    },
    provide: field => EditorView.decorations.from(field, value => value.decorations)
  });
}
