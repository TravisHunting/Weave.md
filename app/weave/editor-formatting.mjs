import {EditorSelection,Transaction} from '@codemirror/state';
import {syntaxTree} from '@codemirror/language';
import {indentMore,indentLess,insertNewlineKeepIndent,isolateHistory} from '@codemirror/commands';
import {UNDERLINE_OPEN,UNDERLINE_CLOSE} from './markdown-highlight.mjs';

const listPrefix = /^([ \t]*)([-+*]|\d+[.)])(?:[ \t]+|$)/;
const listContentPrefix = /^[ \t]*(?:>[ \t]*)*(?:[-+*]|\d+[.)])(?:[ \t]+|$)(?:\[[ xX]\](?:[ \t]+|$))?/;
const indentLines=(view,command)=>command({state:view.state,dispatch:transaction=>view.dispatch({changes:transaction.changes,selection:transaction.selection,scrollIntoView:true,annotations:[isolateHistory.of('full'),Transaction.userEvent.of('input.indent')]})});

// A heading marker typed directly before emphasis needs a separator in the
// Markdown source. Supply it once, keeping the caret with the marker run so
// another # changes the heading level instead of entering the formatted text.
export function headingBeforeFormatting(view,from,to,text) {
  if(view.state.readOnly || view.composing || text!=='#' || from!==to || view.state.selection.ranges.length!==1) return false;
  const {state}=view,line=state.doc.lineAt(from),before=line.text.slice(0,from-line.from),after=line.text.slice(from-line.from);
  if(!/^ {0,3}#{0,5}$/.test(before) || !/^(?:\*{1,2}|_{1,2}|==|<u>)\S/.test(after)) return false;
  for(let node=syntaxTree(state).resolveInner(from,1);node;node=node.parent) if(node.name==='FencedCode') return false;
  view.dispatch({changes:{from,insert:'# '},selection:{anchor:from+1},scrollIntoView:true,userEvent:'input.type'});
  return true;
}

export function closeCodeFence(view,from,to,text) {
  if(view.state.readOnly || view.composing || text !== '`' || from !== to || view.state.selection.ranges.length !== 1) return false;
  const {state}=view,line=state.doc.lineAt(from),prefix=/^([ \t]*)``$/.exec(line.text);
  if(!prefix || from !== line.to) return false;
  for(let node=syntaxTree(state).resolveInner(from,-1);node;node=node.parent) if(node.name==='FencedCode') return false;
  if(line.number<state.doc.lines && /^[ \t]*```(?:[ \t]*)$/.test(state.doc.line(line.number+1).text)) return false;
  // Keep the caret after the opener, ready for an optional language. Enter
  // then creates the editable body between the two fences.
  view.dispatch({changes:{from,insert:'`'+state.lineBreak+prefix[1]+'```'},selection:{anchor:from+1},scrollIntoView:true,userEvent:'input.type'});
  return true;
}

export function deleteCurrentWord(view) {
  if(view.state.readOnly) return false;
  const {state}=view;
  const changes=state.changeByRange(range=>{
    if(!range.empty) return {changes:{from:range.from,to:range.to},range:EditorSelection.cursor(range.from)};
    const line=state.doc.lineAt(range.head),offset=range.head-line.from;
    if(!offset) return range.head ? {changes:{from:range.head-1,to:range.head},range:EditorSelection.cursor(range.head-1)} : {range};
    // An underline tag is one delimiter, like a run of bold asterisks.
    const tag=/<\/?u>$/.exec(line.text.slice(0,offset));
    if(tag) return {changes:{from:range.head-tag[0].length,to:range.head},range:EditorSelection.cursor(range.head-tag[0].length)};
    const categorize=state.charCategorizer(range.head),characters=Array.from(line.text);
    let position=0,index=0;
    while(index<characters.length && position+characters[index].length<=offset) position+=characters[index++].length;
    let start=index,end=index;
    while(start>0 && /\s/u.test(characters[start-1])) start--;
    if(start>0) {
      const category=categorize(characters[start-1]);
      while(start>0 && !/\s/u.test(characters[start-1]) && categorize(characters[start-1])===category) start--;
      // At a caret inside a word, remove its remainder as well. At its end,
      // leave the following separator and the preceding separator untouched.
      if(index>0 && !/\s/u.test(characters[index-1])) while(end<characters.length && !/\s/u.test(characters[end]) && categorize(characters[end])===category) end++;
    }
    const from=line.from+characters.slice(0,start).join('').length,to=line.from+characters.slice(0,end).join('').length;
    return from===to ? {range} : {changes:{from,to},range:EditorSelection.cursor(from)};
  });
  if(changes.changes.empty) return false;
  view.dispatch({...changes,scrollIntoView:true,userEvent:'delete.backward'});
  return true;
}

export function selectListTextStart(view) {
  const {state}=view;
  const ranges=state.selection.ranges.map(range=>{
    const line=state.doc.lineAt(range.head), prefix=listContentPrefix.exec(line.text);
    if(!prefix) return null;
    for(let node=syntaxTree(state).resolveInner(range.head,-1);node;node=node.parent) if(node.name==='FencedCode') return null;
    const start=line.from+prefix[0].length;
    // Repeating Shift+Home must keep the marker excluded. A caret placed within
    // indentation/markup also starts at the item text, without selecting syntax.
    const anchor=range.anchor>=line.from && range.anchor<start ? start : range.anchor;
    return EditorSelection.range(anchor,start);
  });
  if(ranges.some(range=>!range)) return false;
  view.dispatch({selection:EditorSelection.create(ranges,state.selection.mainIndex),scrollIntoView:true,userEvent:'select'});
  return true;
}

export function selectSourceLineStart(view) {
  view.dispatch({selection:EditorSelection.create(view.state.selection.ranges.map(range=>EditorSelection.range(range.anchor,view.state.doc.lineAt(range.head).from)),view.state.selection.mainIndex),scrollIntoView:true,userEvent:'select'});
  return true;
}

// Tab in a list changes the item's nesting, wherever the caret is in the row.
// A selected range also indents whole lines; ordinary prose inserts soft tabs.
export function indentMarkdown(view) {
  if (view.state.readOnly) return false;
  if (view.state.selection.ranges.some(range=>!range.empty || listPrefix.test(view.state.doc.lineAt(range.head).text))) return indentLines(view,indentMore);
  view.dispatch({...view.state.changeByRange(range=>({changes:{from:range.from,insert:'    '},range:EditorSelection.cursor(range.from+4)})),scrollIntoView:true,userEvent:'input.indent'});
  return true;
}

// Markdown's default continuation depends on the parsed list context. Keep the
// same behavior for indented items and for a newly typed marker without a space,
// including while the incremental parser is still catching up with input.
export function continueBulletList(view) {
  if (view.state.readOnly) return false;
  const {state}=view;
  let handled=true;
  const changes=state.changeByRange(range=>{
    const line=state.doc.lineAt(range.head), prefix=/^([ \t]*(?:>[ \t]*)*)([-+*])(?:[ \t]+|$)/.exec(line.text);
    let fenced=false;
    for(let node=syntaxTree(state).resolveInner(range.head,-1);node;node=node.parent) if(node.name==='FencedCode') fenced=true;
    if(!range.empty || !prefix || fenced || range.head<line.from+prefix[0].length) {handled=false;return {range};}
    const [marker,indent,bullet]=prefix, body=line.text.slice(marker.length);
    const task=/^\[[ xX]\](?:[ \t]+|$)/.exec(body);
    if(!(task ? body.slice(task[0].length) : body).trim()) {
      // Enter on an empty nested item exits one nesting level, then the list.
      const quoteEnd=indent.lastIndexOf('>'), quotePrefix=quoteEnd<0 ? '' : indent.slice(0,quoteEnd+1)+(/^[ \t]/.test(indent.slice(quoteEnd+1)) ? indent[quoteEnd+1] : '');
      const nesting=indent.slice(quotePrefix.length), reduced=nesting.replace(/(?: {1,4}|\t)$/,'');
      const insert=nesting ? quotePrefix+reduced+bullet+' ' : quotePrefix;
      return {changes:{from:line.from,to:line.to,insert},range:EditorSelection.cursor(line.from+insert.length)};
    }
    const insert=state.lineBreak+indent+bullet+' '+(task ? '[ ] ' : '');
    let from=range.head;
    while(from>line.from+marker.length && /[ \t]/.test(state.doc.sliceString(from-1,from))) from--;
    return {changes:{from,to:range.head,insert},range:EditorSelection.cursor(from+insert.length)};
  });
  if(!handled) return false;
  view.dispatch({...changes,scrollIntoView:true,userEvent:'input'});
  return true;
}

export const indentationKeymap = [
  {key:'Tab',run:indentMarkdown,shift:view=>indentLines(view,indentLess),preventDefault:true},
  {key:'Enter',run:continueBulletList},
  {key:'Shift-Home',run:view=>selectListTextStart(view) || selectSourceLineStart(view)},
  // Markdown's own Enter binding runs before this fallback and still handles
  // numbered lists/quotes. For prose and code, preserve the authored indentation.
];
export const keepIndentKeymap = [{key:'Enter',run:insertNewlineKeepIndent,shift:insertNewlineKeepIndent}];

// Use transactions for formatting, so selection direction and undo remain part
// of the same document history as normal typing (including in Source mode).
// `marker` opens the span and `close` (the same by default) ends it.
export function toggleFormatting(marker, nodeName, close = marker) {
  return view => {
    if (view.state.readOnly) return false;
    const {state} = view, doc = state.doc, open = marker.length, end = close.length;
    const changes = state.changeByRange(range => {
      const selected = doc.sliceString(range.from, range.to);
      const selection = (from, to) => EditorSelection.range(range.anchor > range.head ? to : from, range.anchor > range.head ? from : to);
      const enclosing = [];
      for (let node = syntaxTree(state).resolveInner(range.from,1); node; node = node.parent) if (node.name === nodeName) enclosing.push(node);
      if (selected.length >= open + end && selected.startsWith(marker) && selected.endsWith(close) && (enclosing.some(node=>node.from === range.from && node.to === range.to) || selected === marker+close)) {
        return {changes:[{from:range.from,to:range.from+open},{from:range.to-end,to:range.to}],range:selection(range.from,range.to-open-end)};
      }
      if (doc.sliceString(Math.max(0,range.from-open),range.from) === marker && doc.sliceString(range.to,range.to+end) === close && (enclosing.some(node=>node.from === range.from-open && node.to === range.to+end) || range.empty && doc.sliceString(Math.max(0,range.from-open-1),range.from-open) !== marker[0] && doc.sliceString(range.to+end,range.to+end+1) !== close.at(-1))) {
        return {changes:[{from:range.from-open,to:range.from},{from:range.to,to:range.to+end}],range:selection(range.from-open,range.to-open)};
      }
      if (nodeName) {
        for (let node = syntaxTree(state).resolveInner(range.head,-1); node; node = node.parent) {
          if (node.name !== nodeName || doc.sliceString(node.from,node.from+open) !== marker || doc.sliceString(node.to-end,node.to) !== close) continue;
          if (range.from < node.from+open || range.to > node.to-end) continue;
          // Repeating the shortcut just before the closing marks finishes the
          // current span and lets the user continue typing ordinary prose.
          if (range.empty && range.head === node.to-end) return {range:EditorSelection.cursor(node.to)};
          return {changes:[{from:node.from,to:node.from+open},{from:node.to-end,to:node.to}],range:selection(range.from-open,range.to-open)};
        }
      }
      return {changes:{from:range.from,to:range.to,insert:marker+selected+close},range:selection(range.from+open,range.to+open)};
    });
    view.dispatch({...changes,scrollIntoView:true,userEvent:'input.format'});
    return true;
  };
}

export function insertMarkdownLink(view) {
  if (view.state.readOnly) return false;
  view.dispatch({...view.state.changeByRange(range => {
    const label = view.state.doc.sliceString(range.from,range.to), insert = '['+label+']()';
    return {changes:{from:range.from,to:range.to,insert},range:EditorSelection.cursor(range.from+(label ? label.length+3 : 1))};
  }),scrollIntoView:true,userEvent:'input.format'});
  return true;
}

export function wrapSelectedMarkdown(view,from,to,text) {
  if (view.state.readOnly || view.composing || !['*','_','`','~','='].includes(text) || view.state.selection.ranges.some(range=>range.empty)) return false;
  view.dispatch({...view.state.changeByRange(range => {
    const selected=view.state.doc.sliceString(range.from,range.to);
    const marker=text === '`' ? '`'.repeat(Math.max(0,...[...selected.matchAll(/`+/g)].map(match=>match[0].length))+1) : text;
    const padding=text === '`' && (selected.startsWith('`') || selected.endsWith('`')) ? ' ' : '';
    const inset=marker.length+padding.length;
    return {changes:{from:range.from,to:range.to,insert:marker+padding+selected+padding+marker},range:EditorSelection.range(range.anchor+inset,range.head+inset)};
  }),scrollIntoView:true,userEvent:'input.format'});
  return true;
}

export const formattingKeymap = [
  {key:'Ctrl-Backspace',run:deleteCurrentWord,preventDefault:true},
  {key:'Mod-b',run:toggleFormatting('**','StrongEmphasis'),preventDefault:true},
  {key:'Mod-i',run:toggleFormatting('*','Emphasis'),preventDefault:true},
  {key:'Mod-u',run:toggleFormatting(UNDERLINE_OPEN,'Underline',UNDERLINE_CLOSE),preventDefault:true},
  {key:'Mod-k',run:insertMarkdownLink,preventDefault:true}
];

// Context-menu formatting: inline toggles share the shortcut implementations.
export const formatCommands = {
  bold: toggleFormatting('**','StrongEmphasis'),
  italic: toggleFormatting('*','Emphasis'),
  underline: toggleFormatting(UNDERLINE_OPEN,'Underline',UNDERLINE_CLOSE),
  strikethrough: toggleFormatting('~~','Strikethrough'),
  highlight: toggleFormatting('==','Highlight'),
  code: toggleFormatting('`','InlineCode'),
};

const inlineFormats = new Set(['StrongEmphasis','Emphasis','Strikethrough','Highlight','Underline','InlineCode']);
const inlineMarks = new Set(['EmphasisMark','StrikethroughMark','HighlightMark','UnderlineMark','CodeMark']);
// Removes the delimiters of every bold, italic, underline, strikethrough, highlight or
// inline-code span that the selection (or the caret) touches.
export function clearFormatting(view) {
  if (view.state.readOnly) return false;
  const {state}=view, tree=syntaxTree(state), marks=new Map();
  for (const range of state.selection.ranges) tree.iterate({from:range.from,to:range.to,enter:node=>{
    if (!inlineFormats.has(node.name) || (range.empty ? node.from>range.head || node.to<range.head : node.from>=range.to || node.to<=range.from)) return;
    for (let child=node.node.firstChild;child;child=child.nextSibling) if (inlineMarks.has(child.name)) marks.set(child.from,{from:child.from,to:child.to});
  }});
  if (!marks.size) return false;
  view.dispatch({changes:[...marks.values()].sort((a,b)=>a.from-b.from),scrollIntoView:true,userEvent:'input.format'});
  return true;
}

// Block formats replace a line's existing heading, quote, list or task prefix
// (keeping list indentation). Applying a line's current format again returns
// the lines to body text, as Obsidian's Paragraph menu does.
function blockFormatOf(text) {
  let rest=text, length=0;
  const take=expression=>{const match=expression.exec(rest); if(match) {rest=rest.slice(match[0].length); length+=match[0].length;} return match;};
  const indent=take(/^[ \t]*/)[0], quote=take(/^(?:>[ \t]?)+/), heading=!quote && take(/^#{1,6}(?:[ \t]+|$)/);
  const list=!quote && !heading && take(/^(?:([-+*])|\d+[.)])(?:[ \t]+|$)/), task=list && take(/^\[([ xX])\](?:[ \t]+|$)/);
  const kind=quote ? 'quote' : heading ? 'h'+heading[0].trim().length : task ? 'task' : list ? (list[1] ? 'bullet' : 'numbered') : 'body';
  return {kind,indent,length,checked:!!task && task[1]!==' '};
}
export function setBlockFormat(kind) {
  return view => {
    if (view.state.readOnly) return false;
    const {state}=view, doc=state.doc, lines=new Set();
    for (const range of state.selection.ranges) for (let n=doc.lineAt(range.from).number;n<=doc.lineAt(range.to).number;n++) lines.add(n);
    // Blank lines inside a multi-line selection stay blank; code is left alone.
    const targets=[...lines].sort((a,b)=>a-b).filter(n=>lines.size===1 || doc.line(n).text.trim()).filter(n=>{
      for (let node=syntaxTree(state).resolveInner(doc.line(n).from,1);node;node=node.parent) if (node.name==='FencedCode' || node.name==='CodeBlock') return false;
      return true;
    });
    if (!targets.length) return false;
    const current=targets.map(n=>blockFormatOf(doc.line(n).text)), apply=current.every(format=>format.kind===kind) ? 'body' : kind;
    const changes=state.changes(targets.map((n,index)=>{
      const line=doc.line(n), format=current[index], indent=/^(?:bullet|numbered|task|body)$/.test(apply) ? format.indent : '';
      const marker=apply==='quote' ? '> ' : apply==='bullet' ? '- ' : apply==='numbered' ? (index+1)+'. ' : apply==='task' ? '- ['+(format.checked ? 'x' : ' ')+'] ' : /^h[1-6]$/.test(apply) ? '#'.repeat(Number(apply[1]))+' ' : '';
      return {from:line.from,to:line.from+format.length,insert:indent+marker};
    }));
    // A caret or selection edge at the old prefix moves after the new one.
    view.dispatch({changes,selection:state.selection.map(changes,1),scrollIntoView:true,userEvent:'input.format'});
    return true;
  };
}

// A thematic break needs blank lines around it: directly under a paragraph,
// `---` would turn that paragraph into a heading.
export function insertHorizontalRule(view) {
  if (view.state.readOnly) return false;
  const {state}=view, doc=state.doc, line=doc.lineAt(state.selection.main.head), br=state.lineBreak;
  const previous=line.number>1 && doc.line(line.number-1).text.trim();
  const change=line.text.trim() ? {from:line.to,insert:br+br+'---'+br+br} : {from:line.from,to:line.to,insert:(previous ? br : '')+'---'+br+br};
  view.dispatch({changes:change,selection:{anchor:change.from+change.insert.length},scrollIntoView:true,userEvent:'input.format'});
  return true;
}

// Wraps the selection in a fenced code block on lines of its own; with no
// selection, the caret starts inside an empty block.
export function insertCodeBlock(view) {
  if (view.state.readOnly) return false;
  const {state}=view, doc=state.doc, {from,to}=state.selection.main, br=state.lineBreak;
  const before=from>doc.lineAt(from).from ? br : '', after=to<doc.lineAt(to).to ? br : '', selected=doc.sliceString(from,to);
  const fence='`'.repeat(Math.max(3,...[...selected.matchAll(/`{3,}/g)].map(match=>match[0].length+1))), opening=before+fence+br;
  view.dispatch({changes:{from,to,insert:opening+selected+br+fence+after},selection:selected ? {anchor:from+opening.length,head:from+opening.length+selected.length} : {anchor:from+opening.length},scrollIntoView:true,userEvent:'input.format'});
  return true;
}
