import {EditorState, EditorSelection, Compartment, Prec, StateEffect, Transaction} from '@codemirror/state';
import {EditorView, Decoration, WidgetType, ViewPlugin, keymap, drawSelection} from '@codemirror/view';
import {defaultKeymap, history, historyKeymap, cursorLineBoundaryBackward} from '@codemirror/commands';
import {closeBrackets, closeBracketsKeymap} from '@codemirror/autocomplete';
import {markdown, markdownKeymap, markdownLanguage} from '@codemirror/lang-markdown';
import {syntaxTree, indentUnit, forceParsing} from '@codemirror/language';
import {renderNote,resolveMarkdownLink} from './render.mjs';
import {parseLinks, createResolver, formatLinkTarget, escapeLabel} from './links.mjs';
import {splitFrontmatter} from './okf.mjs';
import {tablePreviewField,tableFocusChanged,commitTableEdit,refreshTablePreferences,insertTableAtSelection,formatTablesForSave} from './table-preview.mjs';
import {formattingKeymap,indentationKeymap,keepIndentKeymap,wrapSelectedMarkdown,closeCodeFence,headingBeforeFormatting} from './editor-formatting.mjs';
import {sourceLineNumbers, lineNumberOffset} from './line-number-gutter.mjs';
import {checkableWords} from './spellcheck.mjs';
import {Highlight, Underline} from './markdown-highlight.mjs';
import {mermaidField, refreshMermaid} from './mermaid.mjs';

// Spelling settings or the ignore list changed; re-check the visible text.
const spellingChanged = StateEffect.define(), SPELL_MARK = Decoration.mark({class: 'spell-error'});
// Markdown syntax whose text is never prose: link destinations and titles, HTML,
// comments and code-fence markers. Code itself is checked only when enabled.
const NOT_PROSE = new Set(['URL', 'LinkTitle', 'LinkMark', 'HTMLTag', 'UnderlineMark', 'HTMLBlock', 'Comment', 'CommentBlock', 'Autolink', 'CodeMark', 'CodeInfo', 'ProcessingInstruction', 'ProcessingInstructionBlock']);
const CODE = new Set(['FencedCode', 'CodeBlock', 'InlineCode']);
// The word containing or ending at a position (letters, marks and apostrophes).
function wordAround(state, position) {
  const line = state.doc.lineAt(position), text = line.text, letter = /[\p{L}\p{M}'’]/u;
  let from = position - line.from, to = from;
  while (from > 0 && letter.test(text[from - 1])) from--;
  while (to < text.length && letter.test(text[to])) to++;
  return from === to ? null : {from: line.from + from, to: line.from + to};
}

const touches = (selection,from,to) => selection.ranges.some(r => r.empty ? r.head > from && r.head < to : r.from < to && r.to > from);
// Inline code also reveals its backticks while the caret sits just outside them.
const touchesInclusive = (selection,from,to) => selection.ranges.some(r => r.empty ? r.head >= from && r.head <= to : r.from < to && r.to > from);
const searchChanged = StateEffect.define();
// The article moved: links are resolved again from its new folder.
const pathChanged = StateEffect.define();
export const literalMatches = (text,term) => {
  if(!term) return [];
  const expression=new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'giu');
  return [...text.matchAll(expression)].map(match=>({from:match.index,to:match.index+match[0].length}));
};

// Handle paragraph movement in the document model. Native contenteditable
// movement cannot account for Markdown that live-preview decorations hide.
function paragraphMove(view, direction, extend) {
  const doc = view.state.doc;
  const ranges = view.state.selection.ranges.map(range => {
    let line = doc.lineAt(range.head).number;
    if (direction > 0) {
      while (line <= doc.lines && doc.line(line).text.trim()) line++;
      while (line <= doc.lines && !doc.line(line).text.trim()) line++;
    } else {
      line = Math.max(1,line-1);
      while (line > 1 && !doc.line(line).text.trim()) line--;
      while (line > 1 && doc.line(line-1).text.trim()) line--;
    }
    const head = line > doc.lines ? doc.length : doc.line(line).from;
    return EditorSelection.range(extend ? range.anchor : head, head);
  });
  view.dispatch({selection:EditorSelection.create(ranges,view.state.selection.mainIndex),scrollIntoView:true,userEvent:'select'});return true;
}

class LinkLabel extends WidgetType {
  constructor(label, target, from, to, external = false, broken = false, editing = true) {super(); Object.assign(this, {label, target, from, to, external, broken,editing});}
  eq(other) {return this.label === other.label && this.target === other.target && this.from === other.from && this.to === other.to && this.broken === other.broken && this.editing===other.editing;}
  toDOM() {
    const span = document.createElement('span'); span.className = 'cm-wiki' + (this.broken ? ' broken' : '');
    span.textContent = this.label; span.title = this.broken ? this.target : this.editing?'Ctrl click to open':'Click to open'; span.dataset.editorLink = this.target; span.dataset.linkFrom = this.from; span.dataset.linkTo = this.to;
    if(!this.broken){span.tabIndex=0;span.setAttribute('role','link');}
    if (this.external) span.dataset.external = 'true'; if (this.broken) span.dataset.broken = 'true';
    return span;
  }
  ignoreEvent() {return false;}
}

class BulletMark extends WidgetType {
  toDOM() {const span = document.createElement('span');span.className='cm-bullet';span.textContent='•';span.setAttribute('aria-hidden','true');return span;}
  ignoreEvent() {return false;}
}

// Home must not stop after emphasis or code marks hidden at the start of a
// line (CodeMirror's visual line start is the first visible character).
function lineStart(view) {
  const handled = cursorLineBoundaryBackward(view), {state} = view;
  const markup = /^((?:[ \t]*(?:>[ \t]*)*)(?:(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?(?:#{1,6}[ \t]+)?)(?:[*_~`=]|<u>)+$/;
  const ranges = state.selection.ranges.map(range => {
    const line = state.doc.lineAt(range.head), match = markup.exec(line.text.slice(0, range.head - line.from));
    return match ? EditorSelection.cursor(line.from + match[1].length) : range;
  });
  if (ranges.some((range,i) => range !== state.selection.ranges[i])) view.dispatch({selection:EditorSelection.create(ranges,state.selection.mainIndex),scrollIntoView:true,userEvent:'select'});
  return handled;
}

// From the start of a line, Up/Down go to the start of the neighbouring line.
// CodeMirror keeps a horizontal goal instead, which hidden markup (backticks,
// emphasis, link syntax) can shift into the middle of that line.
function lineStartVertical(view, direction) {
  const {state} = view, ranges = state.selection.ranges;
  if (ranges.some(range => !range.empty || state.doc.lineAt(range.head).from !== range.head)) return false;
  const next = ranges.map(range => {const line = state.doc.lineAt(range.head).number + direction; return line < 1 || line > state.doc.lines ? null : EditorSelection.cursor(state.doc.line(line).from);});
  if (next.some(range => !range)) return false;
  view.dispatch({selection:EditorSelection.create(next,state.selection.mainIndex),scrollIntoView:true,userEvent:'select'});
  return true;
}

// Obsidian-style pairing for backticks and quotes, including inside a link's
// destination where a relationship title is typed. Typing the mark again steps
// over the closing one (so three backticks still open a fenced code block);
// a quote or backtick touching a word, such as an apostrophe, stays single.
function pairQuote(view,from,to,text) {
  if (view.state.readOnly || view.composing || !['`','"',"'"].includes(text) || from !== to || view.state.selection.ranges.length !== 1) return false;
  const {state} = view, next = state.sliceDoc(from,from+1), previous = state.sliceDoc(Math.max(0,from-1),from), word = /[\p{L}\p{N}_]/u;
  if (next === text) {view.dispatch({selection:{anchor:from+1},userEvent:'input.type'});return true;}
  if (word.test(next) || word.test(previous)) return false;
  view.dispatch({changes:{from,insert:text+text},selection:{anchor:from+1},userEvent:'input.type'});
  return true;
}

// A single CodeMirror document owns the caret, selection, history and composition.
// Presentation decorations never replace the editor or split editing into sections.
// Outside Source mode, OKF frontmatter is held beside the document: readers and
// editors see only the article body, while `text` always returns the whole file.
export class LiveEditor {
  constructor(element, {changed, paths, caseSensitive, sourcePath, titles = () => new Map(), workspace = () => '', raw = false, spelling = () => null, underline = () => true}) {
    Object.assign(this, {element, changed, paths, caseSensitive, sourcePath, titles, workspace, raw, spelling, underline});
    this.spellSet = null;
    this.documentPath = sourcePath();
    this.tablePreview = tablePreviewField(this);
    this.mermaid = mermaidField();
    this._text = ''; this.frontmatter = ''; this.enabled = false; this.view = null; this.mode = new Compartment(); this.lineOffset = new Compartment(); this.syntax = new Compartment(); this.suggestionIndex = 0;
    this.element.addEventListener('mousedown', event => {
      if (!this.view || event.button !== 0 || event.target.closest('.cm-content,.cm-tooltip')) return;
      // Map document margins to the nearest text position as well. Clicking
      // alongside a paragraph must not jump to the end of the article.
      if (this.enabled && !event.target.closest('.cm-wiki')) {
        const position = this.view.posAtCoords({x:event.clientX,y:event.clientY}, false);
        event.preventDefault();
        const anchor = event.shiftKey ? this.view.state.selection.main.anchor : position;
        this.view.dispatch({selection:{anchor:anchor ?? this.view.state.doc.length,head:position ?? this.view.state.doc.length},userEvent:'select.pointer'});
        this.view.focus();
      }
    });
    this.draw();
  }
  get body() {return this.view ? this.view.state.doc.toString() : this._text;}
  get text() {return this.frontmatter + this.body;}
  // Replace only the hidden frontmatter; the editable body is untouched.
  setFrontmatter(frontmatter) {
    if (this.raw || frontmatter === this.frontmatter) return;
    this.frontmatter = frontmatter;
    this.view?.dispatch({effects:this.lineOffset.reconfigure(lineNumberOffset.of(this.hiddenLines()))});
    this.changed(this.text);
  }
  /** Replaces the frontmatter without reporting an edit or adding an undo step
   * (Weave's own timestamps). In Source mode it is the start of the document. */
  setFrontmatterQuietly(frontmatter) {
    if (this.raw) {
      if (!this.view) {this._text = frontmatter + splitFrontmatter(this._text).body; return;}
      const current = splitFrontmatter(this.view.state.doc.toString()).frontmatter;
      if (current === frontmatter) return;
      this.quiet = true;
      try {this.view.dispatch({changes: {from: 0, to: current.length, insert: frontmatter}, annotations: Transaction.addToHistory.of(false)});}
      finally {this.quiet = false;}
      return;
    }
    if (frontmatter === this.frontmatter) return;
    this.frontmatter = frontmatter;
    this.view?.dispatch({effects:this.lineOffset.reconfigure(lineNumberOffset.of(this.hiddenLines()))});
  }
  hiddenLines() {return this.frontmatter ? this.frontmatter.split('\n').length - 1 : 0;}
  set text(value) {this.setText(value);}
  setSearchTerm(query) {
    const term=String(query || '').trim();
    if(term===this.searchTerm) return;
    this.searchTerm=term;
    if(this.view) this.view.dispatch({effects:searchChanged.of(term)});
    else {this.element.innerHTML=this.render();this.highlightReading();}
  }
  highlightReading() {
    if(!this.searchTerm) return;
    const walker=document.createTreeWalker(this.element,NodeFilter.SHOW_TEXT),nodes=[];
    while(walker.nextNode()) nodes.push(walker.currentNode);
    for(const node of nodes) {
      const matches=literalMatches(node.nodeValue,this.searchTerm);
      if(!matches.length) continue;
      const fragment=document.createDocumentFragment();let from=0;
      for(const match of matches) {
        fragment.append(document.createTextNode(node.nodeValue.slice(from,match.from)));
        const mark=document.createElement('mark');mark.className='search-match';mark.textContent=node.nodeValue.slice(match.from,match.to);fragment.append(mark);from=match.to;
      }
      fragment.append(document.createTextNode(node.nodeValue.slice(from)));node.replaceWith(fragment);
    }
  }
  setText(value) {
    value = value.replace(/\r\n?/g, '\n');
    const path = this.sourcePath(), sameDocument = path === this.documentPath;
    const {frontmatter, body} = this.raw ? {frontmatter: '', body: value} : splitFrontmatter(value);
    if (!sameDocument) this.savedState = null;
    this.documentPath = path;
    const sameFrontmatter = frontmatter === this.frontmatter;
    this.frontmatter = frontmatter; this._text = body; value = body;
    if (this.view) {
      if (sameDocument && sameFrontmatter && this.view.state.doc.toString() === value) return;
      this.view.setState(this.state(value));
    } else this.draw();
  }
  /** Shows `value` without reporting an edit or adding an undo step. Only the
   * span that differs is replaced, so the reading position and selection stay
   * (the other side of a split view, an article moved or changed on disk). */
  mirrorText(value) {
    value = value.replace(/\r\n?/g, '\n');
    const {frontmatter, body} = this.raw ? {frontmatter: '', body: value} : splitFrontmatter(value);
    const moved = this.documentPath !== this.sourcePath(); this.documentPath = this.sourcePath();
    if (!this.raw) this.setFrontmatterQuietly(frontmatter);
    if (!this.view) {this._text = body; this.draw(); return;}
    const current = this.view.state.doc.toString();
    if (current === body) {if (moved) this.view.dispatch({effects: pathChanged.of(null)}); return;}
    const max = Math.min(current.length, body.length); let from = 0, end = 0;
    while (from < max && current.charCodeAt(from) === body.charCodeAt(from)) from++;
    while (end < max - from && current.charCodeAt(current.length - 1 - end) === body.charCodeAt(body.length - 1 - end)) end++;
    this.quiet = true;
    try {this.view.dispatch({changes: {from, to: current.length - end, insert: body.slice(from, body.length - end)}, effects: moved ? pathChanged.of(null) : [], annotations: Transaction.addToHistory.of(false)});}
    finally {this.quiet = false;}
  }
  /** `<u>` underlines are optional (Settings › Editing); off, the tags are plain HTML text and Ctrl+U does nothing. */
  refreshSyntax() {this.view?.dispatch({effects: this.syntax.reconfigure(this.syntaxExtensions())});}
  syntaxExtensions() {return markdown({base:markdownLanguage,addKeymap:false,extensions:this.underline() ? [Highlight,Underline] : [Highlight]});}
  setEnabled(value) {
    if (this.enabled === value) return;
    this._text = this.body; this.enabled = value;
    this.element.classList.toggle('live-editing',this.enabled && !this.raw);
    this.element.dataset.editorMode=this.enabled?'edit':'read';
    if(this.view) this.view.dispatch({effects:this.mode.reconfigure(this.editability())});
    else this.draw();
  }
  editability() {return [EditorState.readOnly.of(!this.enabled), EditorView.editable.of(this.enabled)];}
  render() {return renderNote(this._text, this.paths(), this.caseSensitive(), new Map(), this.sourcePath(), {titles: this.titles(), underline: this.underline()});}
  decorations(view) {
    if (this.raw) return Decoration.none;
    const result = [], hidden = [];
    for (let n = 1; n <= view.state.doc.lines; n++) {
      const line = view.state.doc.line(n);
      if (!line.text.trim()) result.push(Decoration.line({class:'md-blank'}).range(line.from));
    }
    const activeRanges = this.enabled && view.hasFocus ? view.state.selection.ranges.map(r => ({from:view.state.doc.lineAt(r.from).from,to:view.state.doc.lineAt(r.to).to})) : [];
    const activeLine = (from, to) => activeRanges.some(r => from <= r.to && to >= r.from);
    const activeContent = (from,to) => this.enabled && view.hasFocus && touches(view.state.selection,from,to);
    // Links also open when the caret reaches either edge, so arrow keys (which
    // step over a collapsed link) can enter one for editing.
    const nearContent = (from,to) => this.enabled && view.hasFocus && touchesInclusive(view.state.selection,from,to);
    const tables = view.state.field(this.tablePreview,false)?.tables || [];
    const hide = (from, to, widget) => {
      if (from >= to) return;
      // Hidden ranges stay disjoint and ordered. Syntax is usually appended in
      // document order; wiki widgets are inserted afterward. Check only the
      // insertion point's neighbors instead of rescanning all earlier ranges.
      let low = 0, high = hidden.length;
      while (low < high) {const mid = (low + high) >>> 1; if (hidden[mid].from < from) low = mid + 1; else high = mid;}
      if (low && hidden[low - 1].to > from || low < hidden.length && hidden[low].from < to) return;
      if (low === hidden.length) hidden.push({from,to}); else hidden.splice(low,0,{from,to});
      result.push(Decoration.replace(widget ? {widget} : {}).range(from, to));
    };
    const mark = (from, to, name) => {if (from < to) result.push(Decoration.mark({class: name}).range(from, to));};
    if (this.linkDocument !== view.state.doc) {
      this.linkDocument = view.state.doc;
      this.documentLinks = parseLinks(view.state.doc.toString()).links;
    }
    const links = this.documentLinks, tree = syntaxTree(view.state);
    this.inlineRanges = links.map(link=>({from:link.start,to:link.end}));
    let linkIndex = 0;
    tree.iterate({enter: node => {
      const name = node.name, line = view.state.doc.lineAt(node.from), selected = activeLine(node.from, node.to);
      if (name === 'Table') {
        if (tables.some(table=>table.from === node.from)) return false;
        for (let n=line.number;n<=view.state.doc.lineAt(node.to).number;n++) result.push(Decoration.line({class:'md-table-line'}).range(view.state.doc.line(n).from));
      }
      // Syntax nodes and parsed links are ordered. A moving cursor keeps this
      // pass linear even in articles with hundreds of wiki links.
      while (linkIndex < links.length && links[linkIndex].end <= node.from) linkIndex++;
      const link = links[linkIndex];
      if (link && node.from >= link.start && node.to <= link.end) return false;
      const heading = name.match(/^(?:ATX|Setext)Heading([1-6])$/);
      if (heading) result.push(Decoration.line({class: 'md-heading md-h' + heading[1],attributes:{role:'heading','aria-level':heading[1]}}).range(line.from));
      const inlineClass = {StrongEmphasis:'md-strong',Emphasis:'md-em',Strikethrough:'md-strike',Highlight:'md-highlight',Underline:'md-underline',InlineCode:'md-code'}[name];
      if (inlineClass) {mark(node.from,node.to,inlineClass);this.inlineRanges.push({from:node.from,to:node.to});}
      if (name === 'Blockquote') {
        for (let n = line.number; n <= view.state.doc.lineAt(node.to).number; n++) result.push(Decoration.line({class: 'md-quote'}).range(view.state.doc.line(n).from));
      }
      if (name === 'FencedCode') {
        this.inlineRanges.push({from:node.from,to:node.to});
        const last=view.state.doc.lineAt(node.to).number;
        for (let n = line.number; n <= last; n++) result.push(Decoration.line({class: 'md-code-line'+(n===line.number?' md-code-start':'')+(n===last?' md-code-end':'')}).range(view.state.doc.line(n).from));
      }
      if (name === 'Escape') {
        this.inlineRanges.push({from:node.from,to:node.to});
        if (activeContent(node.from,node.to)) mark(node.from,node.from+1,'md-syntax');
        else hide(node.from,node.from+1);
      }
      if (name === 'ListMark' && /^[-+*]$/.test(view.state.doc.sliceString(node.from,node.to))) {
        this.inlineRanges.push({from:node.from,to:node.to+1});
        if (activeContent(node.from,node.to+1)) mark(node.from,node.to,'md-syntax');
        else hide(node.from,node.to,new BulletMark());
      }
      if (['HeaderMark','EmphasisMark','CodeMark','CodeInfo','StrikethroughMark','HighlightMark','UnderlineMark','QuoteMark'].includes(name)) {
        const parent = node.node.parent;
        if(name==='CodeMark' && parent?.name==='FencedCode') result.push(Decoration.line({class:'md-code-fence'}).range(line.from));
        const reveal = ['EmphasisMark','CodeMark','CodeInfo','StrikethroughMark','HighlightMark','UnderlineMark'].includes(name) && parent ? (parent.name==='FencedCode' ? activeLine(parent.from,parent.to) : parent.name==='InlineCode' ? this.enabled && view.hasFocus && touchesInclusive(view.state.selection,parent.from,parent.to) : activeContent(parent.from,parent.to)) : selected;
        if (!reveal) {
          const to = name === 'HeaderMark' && view.state.doc.sliceString(node.to,node.to+1) === ' ' ? node.to+1 : node.to;
          // Hidden inline-code backticks take no width, so the code sits one
          // ordinary space from its neighbours; revealing them shifts the row
          // (and re-wraps it when the row has no room left). Row heights hold.
          hide(node.from,to);
        } else mark(node.from,node.to,'md-syntax');
      }
      if (name === 'Link') {
        const raw = view.state.doc.sliceString(node.from,node.to), match = raw.match(/^\[([^\]]+)\]\(([^ )]+)\)$/);
        if(match) {
          let external=false,target=resolveMarkdownLink(match[2],this.paths(),this.caseSensitive(),this.sourcePath());
          if(/^https?:\/\//i.test(match[2])) try {const url=new URL(match[2]);if(!url.username&&!url.password){target=url.href;external=true;}}catch{}
          if(target){this.inlineRanges.push({from:node.from,to:node.to});if(!nearContent(node.from,node.to)){hide(node.from,node.to,new LinkLabel(match[1],target,node.from,node.to,external,false,this.enabled));return false;}}
        }
      }
    }});
    const resolve = createResolver(this.paths(), {caseSensitive: this.caseSensitive()}), titles = this.titles();
    for (const link of links) {
      if (tables.some(table=>link.start >= table.from && link.end <= table.to)) continue;
      if (nearContent(link.start,link.end)) {mark(link.start,link.end,'md-link-source'); continue;}
      const found = resolve(link.target, this.sourcePath()), label = link.label || titles.get(found.resolvedPath) || link.target.split('/').at(-1).replace(/\.md$/i,'');
      hide(link.start,link.end,new LinkLabel(label,found.resolvedPath || link.target,link.start,link.end,false,!found.resolved,this.enabled));
    }
    return Decoration.set(result,true);
  }
  state(text) {
    const owner = this;
    const activeLines = view => view.state.selection.ranges.map(r => view.state.doc.lineAt(r.from).number + ':' + view.state.doc.lineAt(r.to).number).join(',');
    const presentation = view => activeLines(view) + '|' + (owner.inlineRanges || []).filter(r=>touchesInclusive(view.state.selection,r.from,r.to)).map(r=>r.from).join(',');
    const preview = ViewPlugin.fromClass(class {
      constructor(view) {this.decorations = owner.decorations(view); this.signature = presentation(view);}
      update(update) {
        const signature = presentation(update.view);
        if (update.docChanged || signature !== this.signature || update.focusChanged || update.transactions.some(t => t.effects.some(e => e.is(pathChanged))) || update.viewportChanged || update.state.readOnly!==update.startState.readOnly || update.state.field(owner.tablePreview,false) !== update.startState.field(owner.tablePreview,false) || syntaxTree(update.state) !== syntaxTree(update.startState)) this.decorations = owner.decorations(update.view);
        this.signature = presentation(update.view);
      }
    }, {decorations: plugin => plugin.decorations});
    const spellcheck = ViewPlugin.fromClass(class {
      constructor(view) {this.full(view);}
      full(view) {const marks = owner.spellDecorations(view); this.decorations = owner.spellSet = marks ? Decoration.set(marks, true) : Decoration.none;}
      update(update) {
        const typed = owner.pendingWord, settings = update.state.readOnly !== update.startState.readOnly || update.transactions.some(t => t.effects.some(e => e.is(spellingChanged)));
        owner.pendingWord = owner.typingWord(update, typed);
        if (settings || update.viewportChanged) {this.full(update.view); return;}
        if (!update.docChanged && syntaxTree(update.state) !== syntaxTree(update.startState)) {this.full(update.view); return;}
        // Typing: keep marks elsewhere and re-check only the edited lines, and
        // the line of a word that has just been finished.
        const {doc} = update.state, lines = [], line = position => ({from: doc.lineAt(position).from, to: doc.lineAt(position).to});
        update.changes.iterChangedRanges((fromA, toA, fromB, toB) => lines.push({from: doc.lineAt(fromB).from, to: doc.lineAt(Math.min(toB, doc.length)).to}));
        if (typed && owner.pendingWord?.from !== update.changes.mapPos(typed.from, -1)) lines.push(line(update.changes.mapPos(typed.from, -1)));
        if (!lines.length) return;
        const marks = owner.spellDecorations(update.view, lines);
        if (!marks) {this.full(update.view); return;}
        this.decorations = owner.spellSet = this.decorations.map(update.changes).update({filter: (from, to) => !lines.some(line => from <= line.to && to >= line.from), add: marks, sort: true});
      }
    }, {decorations: plugin => plugin.decorations});
    const searchPreview = ViewPlugin.fromClass(class {
      constructor(view) {this.build(view);}
      build(view) {this.decorations=Decoration.set(literalMatches(view.state.doc.toString(),owner.searchTerm).map(match=>Decoration.mark({class:'search-match'}).range(match.from,match.to)));}
      update(update) {if(update.docChanged || update.transactions.some(transaction=>transaction.effects.some(effect=>effect.is(searchChanged)))) this.build(update.view);}
    },{decorations:plugin=>plugin.decorations});
    return EditorState.create({doc:text, extensions:[
      // We install Markdown commands below, after the application's list
      // commands. The language's automatic high-priority map would bypass them.
      this.mode.of(this.editability()), this.lineOffset.of(lineNumberOffset.of(this.hiddenLines())), this.syntax.of(this.syntaxExtensions()), history(), EditorView.lineWrapping,
      indentUnit.of('    '), EditorState.tabSize.of(4),
      drawSelection({cursorBlinkRate:1100}),sourceLineNumbers,
      // The sticky tab strip covers the top of the shared graph/article page; keep
      // the caret (which overhangs its line slightly) clear of it.
      EditorView.scrollMargins.of(()=>{if (!this.element.closest('.graph-with-article')) return null; const bar=this.element.closest('.editor-group')?.querySelector('.tab-bar'); return {top:bar ? bar.getBoundingClientRect().height + 6 : 0};}),
      EditorView.inputHandler.of(wrapSelectedMarkdown),
      EditorView.inputHandler.of(headingBeforeFormatting),
      EditorView.inputHandler.of(closeCodeFence),EditorView.inputHandler.of(pairQuote),searchPreview,spellcheck,
      // Obsidian pairs brackets and quotes; quotes after a word stay single.
      closeBrackets(),EditorState.languageData.of(()=>[{closeBrackets:{brackets:['[','{','`','"',"'"],before:')]}:;>.,!?'}}]),
      keymap.of([...closeBracketsKeymap,...formattingKeymap.map(binding=>binding.key==='Mod-u' ? {...binding,run:view=>this.underline() && binding.run(view)} : binding),...indentationKeymap,{key:'Home',run:lineStart},{key:'ArrowUp',run:view=>lineStartVertical(view,-1)},{key:'ArrowDown',run:view=>lineStartVertical(view,1)},...markdownKeymap,...keepIndentKeymap, ...[-1,1].map(direction=>({win:'Ctrl-Arrow'+(direction>0?'Down':'Up'),linux:'Ctrl-Arrow'+(direction>0?'Down':'Up'),run:view=>paragraphMove(view,direction,false),shift:view=>paragraphMove(view,direction,true)})), ...defaultKeymap, ...historyKeymap]),
      EditorView.contentAttributes.of({'aria-label':this.raw ? 'Article Markdown source' : 'Edit article Markdown', spellcheck:'false'}),
      EditorView.theme({'&':{fontSize:'inherit',color:'inherit'},'&.cm-focused':{outline:'none'},'.cm-scroller':{fontFamily:'inherit',lineHeight:'inherit',overflow:'visible'},'.cm-content':{padding:'0',caretColor:'var(--ink)'},'.cm-line':{padding:'0'},'.cm-cursor':{borderLeftWidth:'2.5px',borderLeftColor:'var(--ink)',minHeight:'18px'},'.cm-selectionBackground':{background:'var(--selection)'},'&.cm-focused .cm-selectionBackground':{background:'var(--selection)'}}),
      Prec.highest(EditorView.domEventHandlers({
        focus(event,view) {view.dispatch({effects:tableFocusChanged.of(true)});},
        blur(event,view) {view.dispatch({effects:tableFocusChanged.of(false)});},
        mousedown(event,view) {
          const fence=event.target.closest('.md-code-fence');
          if(owner.enabled && fence && !event.shiftKey && !fence.textContent.trim()) {
            // Hidden delimiters have no hit-test width; place the first click
            // after the fence and reveal its source before the next hit test.
            const line=view.state.doc.lineAt(view.posAtDOM(fence));
            event.preventDefault();view.dispatch({selection:{anchor:line.to},userEvent:'select.pointer'});view.focus();return true;
          }
          // Only the primary button follows or edits a link; right-click opens its menu.
          const link = event.target.closest('[data-editor-link]'); if (!link || event.button !== 0) return false;
          event.preventDefault();
          if (!owner.enabled || event.ctrlKey || event.metaKey) {
            if (!link.dataset.broken) owner.element.dispatchEvent(new CustomEvent('weave-follow-link',{bubbles:true,detail:{path:link.dataset.editorLink,external:!!link.dataset.external}}));
          } else if (owner.enabled) {view.dispatch({selection:{anchor:Math.min(view.state.doc.length,Number(link.dataset.linkFrom)+1)}});view.focus();}
          return true;
        },
        keydown(event) {if(event.target.closest('.table-cell-input'))return false;const link=event.target.closest('[data-editor-link]');if(link && !owner.enabled && ['Enter',' '].includes(event.key)){event.preventDefault();if(!link.dataset.broken)owner.element.dispatchEvent(new CustomEvent('weave-follow-link',{bubbles:true,detail:{path:link.dataset.editorLink,external:!!link.dataset.external}}));return true;}return owner.suggestionKey(event);}
      })),
      EditorView.updateListener.of(update => {if (update.docChanged) {owner._text = update.state.doc.toString(); if (!owner.quiet) owner.changed(owner.text);} if (update.docChanged || update.selectionSet || update.focusChanged) {cancelAnimationFrame(owner.suggestFrame);owner.suggestFrame=requestAnimationFrame(()=>{owner.suggestFrame=null;owner.suggest();});}}),
      ...(this.raw ? [] : [this.tablePreview,this.mermaid,preview])
    ]});
  }
  draw() {
    this._text = this.body;
    if (this.view) this.savedState = this.view.state;
    this.view?.destroy(); this.view = null;
    this.element.innerHTML = ''; this.element.classList.toggle('live-editing',this.enabled && !this.raw);
    this.element.dataset.editorMode=this.enabled?'edit':'read';
    const state = this.savedState?.doc.toString() === this._text ? this.savedState : this.state(this._text);
    this.view = new EditorView({state,parent:this.element});
    this.view.dispatch({effects:this.mode.reconfigure(this.editability())});
  }
  // Positions are offsets in the whole file, including hidden frontmatter.
  focusPosition(position) {if (!this.view) return; this.view.focus(); this.view.dispatch({selection:{anchor:Math.max(0,Math.min(position-this.frontmatter.length,this.view.state.doc.length))},scrollIntoView:true});}
  commitTableEdit() {if(this.view) commitTableEdit(this.view);}
  formatTablesForSave() {if(this.enabled && this.view) formatTablesForSave(this.view);}
  insertTable(options) {if(this.enabled && this.view) insertTableAtSelection(this.view,options);}
  /** Parses Markdown through `pos` now (bounded by `timeout` ms), so headings,
   * hidden markup, links and tables in an area about to be shown are styled
   * before it paints instead of appearing a frame later. */
  parseThrough(pos, timeout = 60) {if (this.view) forceParsing(this.view, Math.min(this.view.state.doc.length, Math.max(0, pos)), timeout);}
  /** Document position of the line at a vertical offset from the top of the content. */
  positionAtOffset(offset) {return this.view ? this.view.lineBlockAtHeight(Math.max(0, offset)).to : 0;}
  /** Misspellings in the visible text while editing: a red wavy underline under
   * each word the dictionary does not know. Only visible lines are checked, and
   * known words are cached by the checker, so typing stays fast. */
  spellDecorations(view, ranges = view.visibleRanges) {
    const config = this.enabled ? this.spelling() : null;
    if (!config?.checker || !config.prose && !config.code) return null;
    const tree = syntaxTree(view.state), marks = [];
    // Source mode shows frontmatter; its YAML is not prose.
    const frontmatterEnd = this.raw && /^---\r?\n/.test(view.state.sliceDoc(0, 5)) ? (view.state.doc.toString().search(/\n---\s*(\n|$)/) + 4 || 0) : 0;
    for (const {from, to} of ranges) {
      const skip = [], code = [];
      tree.iterate({from, to, enter: node => {
        if (CODE.has(node.name)) code.push([node.from, node.to]);
        if (NOT_PROSE.has(node.name)) {skip.push([node.from, node.to]); return false;}
      }});
      for (const word of checkableWords(view.state.sliceDoc(from, to), from)) {
        if (word.from < frontmatterEnd || skip.some(([a, b]) => word.from < b && word.to > a)) continue;
        const inCode = code.some(([a, b]) => word.from >= a && word.to <= b);
        if (inCode ? !config.code : !config.prose) continue;
        if (this.pendingWord && word.from < this.pendingWord.to && word.to > this.pendingWord.from) continue;
        if (config.ignored.has(word.word.toLowerCase().replace(/’/g, "'")) || config.checker.correct(word.word)) continue;
        marks.push(SPELL_MARK.range(word.from, word.to));
      }
    }
    return marks;
  }
  /** With "wait until a word is finished", the word being typed: the word at
   * the caret after typing or deleting, kept while the caret stays in it. A
   * space, punctuation, moving away or leaving the editor finishes it. */
  typingWord(update, previous) {
    const {state} = update, main = state.selection.main;
    if (!this.spelling()?.waitForWord || !update.view.hasFocus || !main.empty || state.selection.ranges.length > 1) return null;
    if (update.docChanged && update.transactions.some(tr => tr.isUserEvent('input.type') || tr.isUserEvent('delete'))) return wordAround(state, main.head);
    if (!previous) return null;
    const word = wordAround(state, main.head);
    return word && word.from === update.changes.mapPos(previous.from, -1) ? word : null;
  }
  /** The article or web link at a document position: {path, external} for a
   * link that resolves, or null. Used when a link's source is shown for editing. */
  linkAt(position) {
    if (position == null || !this.view) return null;
    const article = (this.documentLinks || parseLinks(this.view.state.doc.toString()).links).find(link => position >= link.start && position <= link.end);
    if (article) {const found = createResolver(this.paths(), {caseSensitive: this.caseSensitive()})(article.target, this.sourcePath()); return found.resolved ? {path: found.resolvedPath, external: false} : null;}
    for (let node = syntaxTree(this.view.state).resolveInner(position, 1); node; node = node.parent) {
      if (node.name !== 'Link') continue;
      const url = node.getChild('URL'), target = url && this.view.state.sliceDoc(url.from, url.to);
      if (!target) return null;
      if (/^https?:\/\//i.test(target)) try {const parsed = new URL(target); return parsed.username || parsed.password ? null : {path: parsed.href, external: true};} catch {return null;}
      const path = resolveMarkdownLink(target, this.paths(), this.caseSensitive(), this.sourcePath());
      return path ? {path, external: false} : null;
    }
    return null;
  }
  /** Names of the syntax nodes enclosing a document position. */
  syntaxAt(position) {
    const names = new Set();
    if (position == null || !this.view) return names;
    for (const side of [-1, 1]) for (let node = syntaxTree(this.view.state).resolveInner(position, side); node; node = node.parent) names.add(node.name);
    return names;
  }
  /** Runs an editor command (from the context menu) and returns focus. */
  runCommand(command) {
    if (!this.enabled || !this.view) return false;
    this.view.focus(); return command(this.view);
  }
  /** The misspelled word at a document position, if any. */
  spellingAt(position) {
    if (position == null || !this.view) return null;
    let found = null;
    this.spellSet?.between(Math.max(0, position - 1), position + 1, (from, to) => {if (position >= from && position <= to) {found = {from, to, word: this.view.state.sliceDoc(from, to)}; return false;}});
    return found;
  }
  /** Replaces a misspelled word with a suggestion. */
  replaceSpelling(word, replacement) {
    if (!this.view || this.view.state.sliceDoc(word.from, word.to) !== word.word) return false;
    this.view.dispatch({changes: {from: word.from, to: word.to, insert: replacement}, selection: {anchor: word.from + replacement.length}, userEvent: 'input.spell'});
    this.view.focus(); return true;
  }
  refreshSpelling() {this.view?.dispatch({effects: spellingChanged.of(null)});}
  /** Draws links again after the workspace's articles changed (a target appeared or left). */
  refreshLinks() {this.view?.dispatch({effects: pathChanged.of(null)});}
  requestMeasure() {if(this.view) {refreshTablePreferences(this.view);if(!this.raw)refreshMermaid(this.view);this.view.requestMeasure();}}
  suggestionKey(event) {
    const popup=document.getElementById('suggestions'), mine=popup.dataset.owner===this.element.id && !popup.hidden;
    // Shift+Tab always outdents the current item/selection. It must not accept a
    // link completion merely because the caret is inside an unfinished link.
    if (event.key==='Tab' && event.shiftKey) {if(mine)popup.hidden=true;return false;}
    // Right arrow closes the article list and still moves the caret.
    if (event.key==='ArrowRight' && mine) {this.dismiss();return false;}
    if (this.suggestFrame && ['ArrowDown','ArrowUp','Enter','Tab','Escape'].includes(event.key)) {cancelAnimationFrame(this.suggestFrame);this.suggestFrame=null;this.suggest();}
    if (popup.hidden || popup.dataset.owner !== this.element.id || !['ArrowDown','ArrowUp','Enter','Tab','Escape'].includes(event.key)) return false;
    event.preventDefault(); const buttons=[...popup.querySelectorAll('button')];
    if (event.key==='Escape') {this.dismiss();return true;}
    if (event.key==='Enter'||event.key==='Tab') {buttons[this.suggestionIndex || 0]?.click();return true;}
    this.suggestionIndex=((this.suggestionIndex || 0)+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;this.markSuggestion();return true;
  }
  dismiss() {const popup=document.getElementById('suggestions');if(popup.dataset.owner===this.element.id)popup.hidden=true;const query=this.view&&this.linkQuery(this.view);this.dismissed=query?query.start+':'+query.query:null;}
  markSuggestion() {document.querySelectorAll('#suggestions button').forEach((b,i)=>{b.classList.toggle('selected',i===this.suggestionIndex);if(i===this.suggestionIndex)b.scrollIntoView({block:'nearest'});});}
  // As in Obsidian, typing `[` (which closes itself) opens the article list,
  // filtered by the text typed between the brackets. Choosing an article
  // replaces `[query]` with a relative OKF link whose title names the
  // relationship to edit: [Title](../folder/article.md "links-to").
  linkQuery(view) {
    const selection=view.state.selection.main; if (!selection.empty) return null;
    const line=view.state.doc.lineAt(selection.from), offset=selection.from-line.from;
    const before=line.text.slice(0,offset), after=line.text.slice(offset);
    const open=before.match(/(^|[^!\\\[\]])\[([^\[\]]*)$/), close=after.match(/^([^\[\]]*)\]/);
    if (!open || !close) return null;
    const start=selection.from-open[2].length-1, end=selection.from+close[0].length, query=open[2]+close[1];
    if (line.text[end-line.from]==='(' || line.text[end-line.from]==='[') return null;
    const prefix=before.slice(0,start-line.from);
    // Task-list checkboxes, code and escaped brackets are not links.
    if (/^[ xX]?$/.test(query) && /^\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+$/.test(prefix)) return null;
    if ((prefix.match(/`/g)||[]).length%2) return null;
    for (let node=syntaxTree(view.state).resolveInner(selection.from,-1);node;node=node.parent) if (['FencedCode','CodeBlock','InlineCode','HTMLBlock','Comment'].includes(node.name)) return null;
    return {start,end,query};
  }
  suggest() {
    const view=this.view, popup=document.getElementById('suggestions'); if (!view || !this.enabled || !view.hasFocus) {if(popup.dataset.owner===this.element.id)popup.hidden=true;return;}
    const query=this.linkQuery(view);
    if (!query || this.dismissed===query.start+':'+query.query) {if(popup.dataset.owner===this.element.id)popup.hidden=true;return;}
    this.dismissed=null;
    // Every typed word must appear in the path or title, in any order.
    const words=query.query.toLowerCase().split(/\s+/).filter(Boolean), titles=this.titles(), available=this.paths(),paths=available.match?available.match(words,30):available.filter(p=>{const text=(p+' '+(titles.get(p)||'')).toLowerCase();return words.every(word=>text.includes(word));}).sort((a,b)=>a.length-b.length||a.localeCompare(b)).slice(0,30);
    popup.replaceChildren();
    for (const path of paths) {const button=document.createElement('button');button.type='button';button.role='option';button.dataset.suggest=path;const title=document.createElement('span');title.textContent=titles.get(path)||path.split('/').at(-1).replace(/\.md$/i,'');const name=document.createElement('small');name.textContent=path;button.append(title,name);popup.append(button);}
    if (!paths.length) {const empty=document.createElement('p');empty.className='suggestions-empty';empty.textContent='No matching articles';popup.append(empty);}
    popup.dataset.owner=this.element.id;popup.hidden=false;this.suggestionIndex=0;this.markSuggestion();
    const rect=view.coordsAtPos(query.start)||view.dom.getBoundingClientRect();popup.style.left=Math.max(0,Math.min(rect.left,innerWidth-330))+'px';
    popup.style.top=(rect.bottom+264>innerHeight ? Math.max(0,rect.top-popup.offsetHeight-4) : rect.bottom+4)+'px';
    popup.onmousedown=e=>e.preventDefault();
    popup.onclick=e=>{const button=e.target.closest('[data-suggest]');if(!button)return;
      const current=this.linkQuery(view);
      if(!current){popup.hidden=true;return;}
      const path=button.dataset.suggest, insert='['+escapeLabel(titles.get(path)||path.split('/').at(-1).replace(/\.md$/i,''))+']('+formatLinkTarget(path,this.sourcePath())+' "links-to")';
      view.dispatch({changes:{from:current.start,to:current.end,insert},selection:{anchor:current.start+insert.length},userEvent:'input.complete'});view.focus();popup.hidden=true;
    };
  }
}

