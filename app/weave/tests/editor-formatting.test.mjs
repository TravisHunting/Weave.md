import test from 'node:test';
import assert from 'node:assert/strict';
import {EditorState,EditorSelection} from '@codemirror/state';
import {markdown,markdownLanguage} from '@codemirror/lang-markdown';
import {indentUnit} from '@codemirror/language';
import {indentLess,insertNewlineKeepIndent} from '@codemirror/commands';
import {syntaxTree} from '@codemirror/language';
import {toggleFormatting,insertMarkdownLink,wrapSelectedMarkdown,indentMarkdown,continueBulletList,selectListTextStart,closeCodeFence,deleteCurrentWord,headingBeforeFormatting,formatCommands,clearFormatting,setBlockFormat,insertHorizontalRule,insertCodeBlock} from '../editor-formatting.mjs';
import {Highlight,Underline} from '../markdown-highlight.mjs';

const editor=(text,anchor=0,head=anchor)=>{
  const view={state:EditorState.create({doc:text,selection:{anchor,head},extensions:[markdown({base:markdownLanguage,extensions:[Highlight,Underline]}),indentUnit.of('    '),EditorState.tabSize.of(4)]})};
  view.dispatch=transaction=>{view.state=transaction.state || view.state.update(transaction).state;};
  return view;
};

test('formatting toggles wrap a selection and preserve selection direction',()=>{
  const view=editor('selected prose',8,0),bold=toggleFormatting('**','StrongEmphasis');
  assert(bold(view));assert.equal(view.state.doc.toString(),'**selected** prose');
  assert.equal(view.state.selection.main.anchor,10);assert.equal(view.state.selection.main.head,2);
  bold(view);assert.equal(view.state.doc.toString(),'selected prose');
  assert.equal(view.state.selection.main.head,0);assert.equal(view.state.selection.main.anchor,8);
});
test('empty formatting leaves the caret inside and repeated formatting exits the completed span',()=>{
  const view=editor(''),bold=toggleFormatting('**','StrongEmphasis');
  bold(view);assert.equal(view.state.doc.toString(),'****');assert.equal(view.state.selection.main.head,2);
  view.dispatch({changes:{from:2,insert:'word'},selection:{anchor:6}});
  bold(view);assert.equal(view.state.doc.toString(),'**word**');assert.equal(view.state.selection.main.head,8);
  bold(view);assert.equal(view.state.doc.toString(),'**word******');assert.equal(view.state.selection.main.head,10);
});
test('italics can be nested inside bold without stripping the bold marks',()=>{
  const view=editor('**word**',2,6),italic=toggleFormatting('*','Emphasis');
  italic(view);assert.equal(view.state.doc.toString(),'***word***');
  italic(view);assert.equal(view.state.doc.toString(),'**word**');
});
test('formatting supports multiple disjoint selections and link insertion selects the destination',()=>{
  const view=editor('one two');
  view.state=EditorState.create({doc:'one two',selection:EditorSelection.create([EditorSelection.range(0,3),EditorSelection.range(4,7)]),extensions:[EditorState.allowMultipleSelections.of(true),markdown()]});
  toggleFormatting('**','StrongEmphasis')(view);assert.equal(view.state.doc.toString(),'**one** **two**');
  const link=editor('label',0,5);insertMarkdownLink(link);assert.equal(link.state.doc.toString(),'[label]()');assert.equal(link.state.selection.main.head,8);
});
test('typed Markdown markers wrap selections while backticks in code stay literal',()=>{
  const view=editor('`literal`',0,9);
  assert(wrapSelectedMarkdown(view,0,9,'`'));assert.equal(view.state.doc.toString(),'`` `literal` ``');
  assert.equal(view.state.doc.sliceString(view.state.selection.main.from,view.state.selection.main.to),'`literal`');
  const empty=editor('ordinary',8);assert.equal(wrapSelectedMarkdown(empty,8,8,'*'),false);
});

test('the third opening backtick adds a matching fence and keeps the language caret',()=>{
  for(const indent of ['','  ','\t']) {
    const text=indent+'``',view=editor(text,text.length);
    assert(closeCodeFence(view,text.length,text.length,'`'));
    assert.equal(view.state.doc.toString(),indent+'```\n'+indent+'```');
    assert.equal(view.state.selection.main.head,text.length+1);
  }
  for(const text of ['Before ``','```js\n``','``\n```']) {
    const head=text==='``\n```' ? 2 : text.length,view=editor(text,head);
    assert.equal(closeCodeFence(view,head,head,'`'),false,'inline/existing fences are not auto-closed: '+text);
  }
});

test('Ctrl+Backspace deletes the current word without consuming its leading separator',()=>{
  for(const [text,head,expected] of [['one two',7,'one '],['one two',5,'one '],['one two ',8,'one '],['one  two',8,'one  '],['one\ttwo',7,'one\t'],['one naïve end',6,'one  end'],['one 文本',6,'one '],['one two, three',7,'one , three']]) {
    const view=editor(text,head);assert(deleteCurrentWord(view));assert.equal(view.state.doc.toString(),expected);
  }
  const selection=editor('one two',4,7);deleteCurrentWord(selection);assert.equal(selection.state.doc.toString(),'one ');
  const empty=editor('');assert.equal(deleteCurrentWord(empty),false);
});

test('typing heading markers before bold or italic inserts the required Markdown space',()=>{
  for(const marker of ['*','**','_','__']) {
    const view=editor(marker+'Heading'+marker);
    assert(headingBeforeFormatting(view,0,0,'#'));
    assert.equal(view.state.doc.toString(),'# '+marker+'Heading'+marker);
    assert.equal(view.state.selection.main.head,1);
    const second=view.state.selection.main.head;assert.equal(headingBeforeFormatting(view,second,second,'#'),false,'later # uses ordinary input before the existing space');
    view.dispatch({changes:{from:second,insert:'#'},selection:{anchor:second+1}});
    assert.equal(view.state.doc.toString(),'## '+marker+'Heading'+marker);
  }
  const code=editor('```\n**literal**\n```',4);assert.equal(headingBeforeFormatting(code,4,4,'#'),false);
});

test('Tab indents bullet and numbered rows before their marker and preserves caret position in their text',()=>{
  for(const text of ['- first','1. first','- [ ] first']) {
    const view=editor(text,text.length);
    indentMarkdown(view);assert.equal(view.state.doc.toString(),'    '+text);
    assert.equal(view.state.selection.main.head,text.length+4);
    indentLess(view);assert.equal(view.state.doc.toString(),text);assert.equal(view.state.selection.main.head,text.length);
  }
});
test('soft tabs in prose insert four spaces and selected lines indent together',()=>{
  const prose=editor('leftright',4);indentMarkdown(prose);
  assert.equal(prose.state.doc.toString(),'left    right');assert.equal(prose.state.selection.main.head,8);
  const block=editor('first\nsecond',0,12);indentMarkdown(block);
  assert.equal(block.state.doc.toString(),'    first\n    second');
  indentLess(block);assert.equal(block.state.doc.toString(),'first\nsecond');
});
test('Enter continues bullets with a following space and the same four-space nesting',()=>{
  for(const marker of ['-','+','*']) {
    const text='    '+marker+' first',view=editor(text,text.length);
    assert(continueBulletList(view));assert.equal(view.state.doc.toString(),text+'\n    '+marker+' ');
    assert.equal(view.state.selection.main.head,view.state.doc.length);
    continueBulletList(view);assert.equal(view.state.doc.toString(),text+'\n'+marker+' ');
    continueBulletList(view);assert.equal(view.state.doc.toString(),text+'\n');
  }
  const task=editor('- [x] finished',14);continueBulletList(task);
  assert.equal(task.state.doc.toString(),'- [x] finished\n- [ ] ');
  continueBulletList(task);assert.equal(task.state.doc.toString(),'- [x] finished\n');
  const quoted=editor('> - quoted',10);continueBulletList(quoted);
  assert.equal(quoted.state.doc.toString(),'> - quoted\n> - ');
  continueBulletList(quoted);assert.equal(quoted.state.doc.toString(),'> - quoted\n> ');
  const quotedNested=editor('>     - ',8);continueBulletList(quotedNested);assert.equal(quotedNested.state.doc.toString(),'> - ');
});
test('newlines preserve ordinary indentation and fenced-code bullet text stays code',()=>{
  const view=editor('    prose',9);insertNewlineKeepIndent(view);assert.equal(view.state.doc.toString(),'    prose\n    ');
  const code=editor('```md\n- example\n```',15);assert.equal(continueBulletList(code),false);
  const single=editor('-',1);assert(continueBulletList(single));assert.equal(single.state.doc.toString(),'');
});
test('Shift+Home selects list text while retaining indentation, markers and task syntax',()=>{
  for(const prefix of ['- ','    - ','\t- ','    - [ ] ','    12. [x] ','> - ']) {
    const text=prefix+'Selected text',view=editor(text,text.length);
    assert(selectListTextStart(view));assert.equal(view.state.doc.sliceString(view.state.selection.main.from,view.state.selection.main.to),'Selected text');
    assert.equal(view.state.selection.main.head,prefix.length);assert.equal(view.state.selection.main.anchor,text.length);
    selectListTextStart(view);assert.equal(view.state.selection.main.head,prefix.length,'repeating Shift+Home does not select the marker');
  }
  const prefix=editor('    - body',4);selectListTextStart(prefix);assert.equal(prefix.state.selection.main.head,6);assert(prefix.state.selection.main.empty);
  const ordinary=editor('Plain text',10);assert.equal(selectListTextStart(ordinary),false);
  const code=editor('```\n- example\n```',13);assert.equal(selectListTextStart(code),false);
});

const nodes=(view,name)=>{const found=[];syntaxTree(view.state).iterate({enter:node=>{if(node.name===name)found.push(view.state.sliceDoc(node.from,node.to));}});return found;};

test('==highlight== parses like strikethrough and toggles like bold',()=>{
  assert.deepEqual(nodes(editor('a ==marked **bold**== b, a == spaced == c and x==y'),'Highlight'),['==marked **bold**=='],'only flanked == pairs highlight');
  assert.deepEqual(nodes(editor('`==code==` and ==unclosed'),'Highlight'),[],'code and unclosed marks are not highlights');
  const view=editor('selected prose',0,8);
  formatCommands.highlight(view);assert.equal(view.state.doc.toString(),'==selected== prose');assert.deepEqual([view.state.selection.main.from,view.state.selection.main.to],[2,10]);
  formatCommands.highlight(view);assert.equal(view.state.doc.toString(),'selected prose','repeating the command removes its delimiters');
  const caret=editor('==word== after',4);formatCommands.highlight(caret);assert.equal(caret.state.doc.toString(),'word after','a caret inside a highlight removes it');
  const typed=editor('');formatCommands.highlight(typed);assert.equal(typed.state.doc.toString(),'====');assert.equal(typed.state.selection.main.head,2);
  const wrap=editor('marked',0,6);assert(wrapSelectedMarkdown(wrap,0,6,'='));wrapSelectedMarkdown(wrap,1,7,'=');assert.equal(wrap.state.doc.toString(),'==marked==','typing = twice around a selection highlights it');
  const heading=editor('==Heading==');assert(headingBeforeFormatting(heading,0,0,'#'));assert.equal(heading.state.doc.toString(),'# ==Heading==');
  for(const [name,expected] of [['bold','**x**'],['italic','*x*'],['strikethrough','~~x~~'],['code','`x`']]) {const v=editor('x',0,1);formatCommands[name](v);assert.equal(v.state.doc.toString(),expected,name);}
});

test('<u>underline</u> parses as hidden-mark formatting and toggles like bold',()=>{
  assert.deepEqual(nodes(editor('a <u>under **bold**</u> b, <u>unclosed and `<u>code</u>`'),'Underline'),['<u>under **bold**</u>'],'only closed tags outside code underline');
  assert.deepEqual(nodes(editor('a <u>x</u>'),'UnderlineMark'),['<u>','</u>']);
  const view=editor('selected prose',8,0);
  formatCommands.underline(view);assert.equal(view.state.doc.toString(),'<u>selected</u> prose');assert.deepEqual([view.state.selection.main.anchor,view.state.selection.main.head],[11,3],'selection direction is kept');
  formatCommands.underline(view);assert.equal(view.state.doc.toString(),'selected prose','repeating the command removes both tags');
  const caret=editor('<u>word</u> after',5);formatCommands.underline(caret);assert.equal(caret.state.doc.toString(),'word after','a caret inside an underline removes it');
  const whole=editor('<u>word</u>',0,11);formatCommands.underline(whole);assert.equal(whole.state.doc.toString(),'word','selecting the whole span with its tags removes them');
  const typed=editor('');formatCommands.underline(typed);assert.equal(typed.state.doc.toString(),'<u></u>');assert.equal(typed.state.selection.main.head,3);
  typed.dispatch({changes:{from:3,insert:'word'},selection:{anchor:7}});
  formatCommands.underline(typed);assert.equal(typed.state.doc.toString(),'<u>word</u>');assert.equal(typed.state.selection.main.head,11,'repeating the shortcut at the closing tag exits the span');
  const heading=editor('<u>Heading</u>');assert(headingBeforeFormatting(heading,0,0,'#'));assert.equal(heading.state.doc.toString(),'# <u>Heading</u>');
  // Ctrl+Backspace removes a whole tag, as it removes a run of bold asterisks.
  for(const [open,close] of [['**','**'],['<u>','</u>']]) {
    const text='Keep '+open+'two words'+close,view=editor(text,text.length);
    deleteCurrentWord(view);assert.equal(view.state.doc.toString(),'Keep '+open+'two words',open+' closing marks');
    deleteCurrentWord(view);assert.equal(view.state.doc.toString(),'Keep '+open+'two ',open+' last word');
  }
  const leading=editor('<u>word',3);deleteCurrentWord(leading);assert.equal(leading.state.doc.toString(),'word','an opening tag is removed whole');
  const cleared=editor('<u>under</u> ==hi== keep',0,18);clearFormatting(cleared);assert.equal(cleared.state.doc.toString(),'under hi keep','Clear formatting removes underline tags');
});

test('Clear formatting removes the delimiters the selection or caret touches',()=>{
  const view=editor('**bold** ==hi== *em* ~~old~~ `code` keep **other**',0,36);
  assert(clearFormatting(view));assert.equal(view.state.doc.toString(),'bold hi em old code keep **other**');
  const nested=editor('**bold ==both==**',9);clearFormatting(nested);assert.equal(nested.state.doc.toString(),'bold both');
  assert.equal(clearFormatting(editor('plain',2)),false);
});

test('Paragraph formats replace a line prefix, and repeating one restores body text',()=>{
  const view=editor('one\n\ntwo',0,8);
  setBlockFormat('bullet')(view);assert.equal(view.state.doc.toString(),'- one\n\n- two','blank lines inside a selection stay blank');
  setBlockFormat('numbered')(view);assert.equal(view.state.doc.toString(),'1. one\n\n2. two');
  setBlockFormat('task')(view);assert.equal(view.state.doc.toString(),'- [ ] one\n\n- [ ] two');
  setBlockFormat('task')(view);assert.equal(view.state.doc.toString(),'one\n\ntwo','repeating the format returns to body text');
  const heading=editor('## Title',8);setBlockFormat('h3')(heading);assert.equal(heading.state.doc.toString(),'### Title');assert.equal(heading.state.selection.main.head,9);
  setBlockFormat('body')(heading);assert.equal(heading.state.doc.toString(),'Title');
  setBlockFormat('quote')(heading);assert.equal(heading.state.doc.toString(),'> Title');
  const nested=editor('    - [x] done',14);setBlockFormat('bullet')(nested);assert.equal(nested.state.doc.toString(),'    - done','list indentation is kept');
  const empty=editor('',0);setBlockFormat('bullet')(empty);assert.equal(empty.state.doc.toString(),'- ');assert.equal(empty.state.selection.main.head,2,'the caret follows a new prefix');
  const code=editor('```\n# not\n```',5);assert.equal(setBlockFormat('h1')(code),false,'code blocks are left alone');
});

test('Insert horizontal rule and code block keep Markdown structure',()=>{
  const rule=editor('Paragraph',4);insertHorizontalRule(rule);assert.equal(rule.state.doc.toString(),'Paragraph\n\n---\n\n','a rule never turns the paragraph above into a heading');
  const blank=editor('Text\n',5);insertHorizontalRule(blank);assert.equal(blank.state.doc.toString(),'Text\n\n---\n\n');
  const block=editor('Before code after',7,11);insertCodeBlock(block);assert.equal(block.state.doc.toString(),'Before \n```\ncode\n```\n after');
  assert.equal(block.state.sliceDoc(block.state.selection.main.from,block.state.selection.main.to),'code');
  const empty=editor('',0);insertCodeBlock(empty);assert.equal(empty.state.doc.toString(),'```\n\n```');assert.equal(empty.state.selection.main.head,4);
});
