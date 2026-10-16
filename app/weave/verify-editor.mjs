import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const root = path.resolve(import.meta.dirname, '../..'), output = path.join(root, 'test-results');
await fs.mkdir(output, {recursive: true});
import {launchBrowser} from './test-browser.mjs';
const fixture = String.raw`
  import {LiveEditor} from './live-editor.mjs';
  import {htmlToMarkdown, hasFormatting, pasteText} from './paste-markdown.mjs';
  window.pasteMarkdown = {htmlToMarkdown, hasFormatting, pasteText};
  import {articleScrollbar} from './article-scrollbar.mjs';
  articleScrollbar(document.getElementById('editor-fixture'),document.getElementById('article'));
  import {EditorView} from '@codemirror/view';
  import {StateEffect} from '@codemirror/state';
  import {undoDepth, redoDepth} from '@codemirror/commands';
  import {ensureSyntaxTree} from '@codemirror/language';
  const documents = {live:'First.md',raw:'First.md'}, editors = {};
  let visible = 'live', category = null, pending = null;
  const samples = [];
  const followed = []; document.addEventListener('weave-follow-link',event=>followed.push(event.detail));
  for (const kind of ['live','raw']) {
    editors[kind] = new LiveEditor(document.getElementById(kind === 'live' ? 'article' : 'source-editor'), {
      raw:kind === 'raw', paths:()=>['Linked.md'], titles:()=>new Map([['Linked.md','Linked article']]),
      caseSensitive:()=>true, sourcePath:()=>documents[kind], changed:()=>{}
    });
    editors[kind].setEnabled(true);
  }
  document.addEventListener('keydown', event => {
    if (category && event.target.closest('.cm-content')) pending = {category,start:performance.now()};
  },true);
  const inspect = kind => {
    const editor = editors[kind], selection = editor.view.state.selection.main;
    return {text:editor.text,head:selection.head,anchor:selection.anchor,undo:undoDepth(editor.view.state),redo:redoDepth(editor.view.state)};
  };
  window.harness = {
    open(kind,file,text) {
      visible=kind; documents[kind]=file; editors[kind].setText(text); editors[kind].setEnabled(true);
      document.getElementById('article').hidden=kind!=='live'; document.getElementById('source-editor').hidden=kind!=='raw';
      editors[kind].view.focus(); editors[kind].requestMeasure();
    },
    inspect,
    followed,
    toggle(kind,enabled,focus=true) {editors[kind].setEnabled(enabled); if(enabled&&focus) editors[kind].view.focus();},
    search(kind,term) {editors[kind].setSearchTerm(term);},
    focus(kind,position) {editors[kind].focusPosition(position);},
    select(kind,anchor,head) {editors[kind].view.dispatch({selection:{anchor,head}});editors[kind].view.focus();},
    caret() {const view=editors[visible].view;return view.coordsAtPos(view.state.selection.main.head);},
    position(kind,position) {return editors[kind].view.coordsAtPos(position);},
    settle() {return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));},
    prepareMetrics() {
      const view=editors[visible].view;
      ensureSyntaxTree(view.state,view.state.doc.length,5000);
      view.dispatch({effects:StateEffect.appendConfig.of(EditorView.updateListener.of(update=>{
        if (!pending || !(update.docChanged || update.selectionSet)) return;
        const measured=pending; pending=null;
        requestAnimationFrame(()=>samples.push({category:measured.category,ms:performance.now()-measured.start}));
      }))});
    },
    measure(name) {category=name;pending=null;},
    samples,
    stopMetrics() {category=null;pending=null;return samples;},
    clickCoordinates(lineNumber) {
      const view=editors[visible].view, line=view.state.doc.line(lineNumber);
      view.dispatch({selection:{anchor:line.from},scrollIntoView:true});
      return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{
        const box=view.coordsAtPos(line.from); resolve({x:box.left+200,y:(box.top+box.bottom)/2,position:line.from});
      })));
    }
  };
`;
const bundled = await build({stdin:{contents:fixture,resolveDir:import.meta.dirname,sourcefile:'editor-browser-fixture.mjs'},bundle:true,write:false,format:'iife',platform:'browser',target:'es2022'});
const css = (await Promise.all(['skin-contract.css','styles.css','workspace.css','appearance.css','table-editor.css'].map(file=>fs.readFile(path.join(import.meta.dirname,file),'utf8')))).join('\n');
const file = path.join(output,'weave-editor-fixture.html');
await fs.writeFile(file, `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:"><title>Weave editor verification</title><style>${css}\nbody{height:100vh;overflow:hidden}#editor-fixture{height:100vh;overflow:auto;background:var(--paper)}#article,#source-editor{min-height:100%;padding:26px 30px 26px 40px}#outside-editor{position:fixed;right:0;top:0}</style></head><body><button id="outside-editor">Toolbar</button><div id="editor-fixture"><article id="article"></article><div id="source-editor" hidden></div></div><div id="suggestions" hidden></div><script>${bundled.outputFiles[0].text.replace(/<\/script/gi,'<\\/script')}</script></body></html>`);
const browser = await launchBrowser();
const page = await browser.newPage({locale:'en-GB',viewport:{width:1280,height:900}}), errors = [], remoteRequests = [];
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
page.on('request',request=>{if(/^https?:/i.test(request.url()))remoteRequests.push(request.url());});
await page.route(/^https?:/i,route=>route.abort());
const open = async (kind, name, text) => {await page.evaluate(({kind,name,text})=>window.harness.open(kind,name,text),{kind,name,text});await page.evaluate(()=>window.harness.settle());};
const inspect = kind => page.evaluate(kind=>window.harness.inspect(kind),kind);
try {
  await page.goto(pathToFileURL(file).href);
  for(const kind of ['live','raw']) {
    // Equal content is not document identity: another note gets fresh history.
    await open(kind,'Original-'+kind+'.md','Original note');
    await page.keyboard.press('Control+End'); await page.keyboard.type(' edited');
    const first = await inspect(kind); assert.equal(first.text,'Original note edited'); assert(first.undo>0);
    await page.evaluate(kind=>window.harness.toggle(kind,false),kind);
    await page.evaluate(kind=>window.harness.toggle(kind,true),kind);
    assert.equal((await inspect(kind)).head,first.head,'edit toggle retains caret');
    await page.keyboard.press('Control+z'); assert.equal((await inspect(kind)).text,'Original note','edit toggle retains undo');
    await page.keyboard.press('Control+y'); assert.equal((await inspect(kind)).text,first.text);
    await open(kind,'Identical-'+kind+'.md',first.text);
    assert.equal((await inspect(kind)).undo,0,'identical-content note must start with empty undo');
    await page.keyboard.press('Control+z'); assert.equal((await inspect(kind)).text,first.text,'undo cannot alter another note');
    assert.equal((await inspect(kind)).head,0,'another note does not inherit the previous caret');

    // Also exercise the live editor savedState while its view is destroyed.
    await page.keyboard.press('Control+End'); await page.keyboard.type(' again');
    const second = await inspect(kind);
    await page.evaluate(kind=>window.harness.toggle(kind,false),kind);
    await open(kind,'Identical-after-toggle-'+kind+'.md',second.text);
    await page.keyboard.press('Control+z'); assert.equal((await inspect(kind)).text,second.text);
    assert.equal((await inspect(kind)).undo,0);

    await open(kind,'Paragraphs-'+kind+'.md','first\n\nlast');
    await page.keyboard.press('Control+Home'); await page.keyboard.press('Control+ArrowDown');
    assert.equal((await inspect(kind)).head,7,'Ctrl+Down reaches final paragraph start');
    await page.keyboard.press('Control+ArrowDown'); assert.equal((await inspect(kind)).head,11,'next Ctrl+Down reaches document end');
    await page.keyboard.press('Control+ArrowUp'); assert.equal((await inspect(kind)).head,0);
    await page.keyboard.press('Control+Shift+ArrowDown'); const selection = await inspect(kind);
    assert.equal(selection.anchor,0); assert.equal(selection.head,7,'paragraph selection keeps its original anchor');
  }
  const decorated = '# Heading [Linked](Linked.md "depends-on")\n\n**Bold [Linked](Linked.md "depends-on") text** and [external](https://example.invalid) `literal`\n\nCaret';
  await open('live','Decorations.md',decorated);
  await page.evaluate(position=>window.harness.focus('live',position),decorated.length);
  await page.evaluate(()=>window.harness.settle());
  assert.equal(await page.locator('#article .cm-wiki').count(),3,'wiki and external widgets coexist with heading/emphasis decorations');
  const previewText = await page.locator('#article .cm-content').innerText();
  assert(!previewText.includes('](Linked.md') && !previewText.includes('depends-on') && !previewText.includes('**'),'preview hides disjoint Markdown ranges without exposing overlapping syntax');
  await page.locator('#article .cm-wiki').nth(1).click();
  await page.evaluate(()=>window.harness.settle());
  assert((await page.locator('#article .cm-content').innerText()).includes('**Bold [Linked](Linked.md "depends-on") text**'),'activating the decorated line reveals its source');
  assert.equal((await inspect('live')).text,decorated,'preview decorations never alter source text');
  await open('live','Empty-line.md','First line\n\nThird line');
  const blank = await page.evaluate(()=>window.harness.clickCoordinates(2));
  await page.mouse.click(blank.x,blank.y);
  assert.equal((await inspect('live')).head,blank.position,'clicking blank-line whitespace places the caret at the line start');
  const blankCaret = await page.evaluate(()=>window.harness.caret());
  await page.keyboard.type('Visible caret'); assert.equal((await inspect('live')).text,'First line\nVisible caret\nThird line');
  await page.evaluate(()=>window.harness.settle());
  const typedCaret = await page.evaluate(()=>window.harness.caret());
  assert(Math.abs(blankCaret.top-typedCaret.top)<1 && Math.abs(blankCaret.bottom-typedCaret.bottom)<1,'the first typed character retains the blank line caret baseline and height');

  const rowGeometry=()=>page.locator('#article .cm-line').evaluateAll(lines=>lines.map(line=>({top:line.getBoundingClientRect().top,bottom:line.getBoundingClientRect().bottom})));
  // The caret can stay fixed while every row below it still jumps. Measure all
  // following rows, and cover insertion/deletion with custom paragraph spacing.
  for(const settings of [{font:'15px',line:'1.5',paragraph:'.45em'},{font:'21px',line:'1.8',paragraph:'1em'}]) {
    await page.evaluate(settings=>{document.documentElement.style.setProperty('--reading-font-size',settings.font);document.documentElement.style.setProperty('--reading-line-height',settings.line);document.documentElement.style.setProperty('--reading-paragraph-spacing',settings.paragraph);},settings);
    for(const text of ['Above\n\nBelow\nLast','# Heading\n\nBelow\nLast','Above\n  \nBelow\nLast','Above\n\n## Below\nLast']) {
      await open('live','Stable-rows.md',text);await page.evaluate(position=>window.harness.focus('live',position),text.indexOf('\n')+1);await page.evaluate(()=>window.harness.settle());
      const before=await rowGeometry();await page.keyboard.type('x');await page.evaluate(()=>window.harness.settle());const after=await rowGeometry();
      for(let row=1;row<before.length;row++) assert(Math.abs(before[row].top-after[row].top)<1 && Math.abs(before[row].bottom-after[row].bottom)<1,'first character preserves geometry of row '+(row+1)+' with '+JSON.stringify(settings));
      await page.keyboard.press('Backspace');await page.evaluate(()=>window.harness.settle());const cleared=await rowGeometry();
      for(let row=1;row<before.length;row++) assert(Math.abs(before[row].top-cleared[row].top)<1 && Math.abs(before[row].bottom-cleared[row].bottom)<1,'removing the last character preserves subsequent row geometry');
    }
  }
  await page.screenshot({path:path.join(output,'weave-editor-stable-rows.png')});
  await page.evaluate(()=>{for(const name of ['--reading-font-size','--reading-line-height','--reading-paragraph-spacing'])document.documentElement.style.removeProperty(name);});

  for(const kind of ['live','raw']) {
    for(const action of ['Backspace','Control+Backspace']) {
      await open(kind,'Visible-separators-'+kind+'.md','Before word');await page.keyboard.press('Control+End');
      const separator=await page.evaluate(kind=>({before:window.harness.position(kind,6).left,after:window.harness.position(kind,7).left}),kind);
      if(action==='Backspace') for(let i=0;i<4;i++)await page.keyboard.press(action);else await page.keyboard.press(action);
      await page.evaluate(()=>window.harness.settle());const current=await inspect(kind),caret=await page.evaluate(()=>window.harness.caret());
      assert.equal(current.text,'Before ');assert.equal(current.head,7);
      assert(separator.after-separator.before>2,'fixture has a measurable word separator');
      assert(Math.abs(caret.left-separator.after)<1,'deleting the word preserves the visible separator and its caret position');
      await page.keyboard.type('next');assert.equal((await inspect(kind)).text,'Before next');
    }
    for(const marker of ['**','*']) {
      await open(kind,'Formatted-heading-'+kind+'.md',marker+'Heading'+marker);await page.keyboard.press('Control+Home');await page.keyboard.type('###');
      assert.equal((await inspect(kind)).text,'### '+marker+'Heading'+marker);
      if(kind==='live')assert.equal(await page.locator('#article .md-h3').count(),1,'heading before formatted text renders at its requested level');
    }
  }

  const mixed='# **Bold heading**\n\nParagraph with **strong text**, *emphasis* and `inline code`.\nA continuation on its own source line.\n\n- First item\n    - Nested item\n\n> Quoted words\n\n```js\nconst x = 1;\n```\n\n| Name | Value |\n| --- | --- |\n| Alpha | `value` |\n\nFinal paragraph.';
  await open('live','Mixed-mode-geometry.md',mixed);await page.evaluate(position=>window.harness.focus('live',position),mixed.length);
  await page.evaluate(()=>window.harness.settle());
  const mixedGeometry=()=>page.locator('#article .cm-line,#article .cm-table-preview').evaluateAll(nodes=>nodes.map(node=>({text:node.textContent,top:node.getBoundingClientRect().top,height:node.getBoundingClientRect().height,left:node.getBoundingClientRect().left,width:node.getBoundingClientRect().width})));
  const editingGeometry=await mixedGeometry();
  for(const mode of ['off','read','edit','both']) {
    await page.evaluate(mode=>document.documentElement.dataset.lineNumbers=mode,mode);
    await page.evaluate(()=>window.harness.toggle('live',false));await page.evaluate(()=>window.harness.settle());
    assert.deepEqual(await mixedGeometry(),editingGeometry,'reading preserves every mixed-article row and table position');
    assert.equal(await page.locator('#article .cm-lineNumbers').evaluate(element=>getComputedStyle(element).visibility),['read','both'].includes(mode)?'visible':'hidden');
    const before=(await inspect('live')).text;await page.locator('#article .cm-table-preview td').first().click();await page.keyboard.type('should not edit');assert.equal((await inspect('live')).text,before,'read-only table cannot enable Markdown editing');
    await page.evaluate(()=>window.harness.toggle('live',true));await page.evaluate(()=>window.harness.settle());
    assert.deepEqual(await mixedGeometry(),editingGeometry,'returning to editing preserves mixed-article geometry');
    assert.equal(await page.locator('#article .cm-lineNumbers').evaluate(element=>getComputedStyle(element).visibility),['edit','both'].includes(mode)?'visible':'hidden');
  }
  await page.screenshot({path:path.join(output,'weave-editor-shared-read-geometry.png')});
  for(const position of [mixed.indexOf('Alpha')+2,mixed.indexOf('Bold')+2,mixed.indexOf('const')+3]) {
    await page.evaluate(position=>window.harness.focus('live',position),position);
    await page.locator('#outside-editor').focus();await page.evaluate(()=>window.harness.settle());
    const outsideGeometry=await mixedGeometry();
    await page.evaluate(()=>window.harness.toggle('live',false,false));await page.evaluate(()=>window.harness.settle());
    assert.deepEqual(await mixedGeometry(),outsideGeometry,'disabling from toolbar keeps the presentation of the exited construct');
    await page.evaluate(()=>window.harness.toggle('live',true,false));await page.evaluate(()=>window.harness.settle());
    assert.deepEqual(await mixedGeometry(),outsideGeometry,'enabling from toolbar does not reveal an unfocused table or formatting');
  }
  await page.evaluate(()=>delete document.documentElement.dataset.lineNumbers);

  const links = 'Before [Linked](Linked.md "depends-on") between [Linked](Linked.md "reads-from") and [external](https://example.invalid) after.';
  await open('live','Precise-links.md',links);
  const focus = async position => {await page.evaluate(position=>window.harness.focus('live',position),position);await page.evaluate(()=>window.harness.settle());};
  for (const position of [0,links.indexOf(' between')+2,links.indexOf(' after')+2,links.length]) {
    await focus(position); assert.equal(await page.locator('#article .cm-wiki').count(),3,'a caret away from links keeps every link rendered');
  }
  // Arrow keys step over a collapsed link, so reaching either edge opens it.
  await focus(links.indexOf('[Linked]')); assert.equal(await page.locator('#article .cm-wiki').count(),2,'a caret at a link edge reveals that link');
  await focus(links.indexOf(' between')); assert.equal(await page.locator('#article .cm-wiki').count(),2,'a caret just after a link reveals that link');
  await focus(links.indexOf('Linked')+2); assert.equal(await page.locator('#article .cm-wiki').count(),2,'only the link containing the caret reveals source');
  await focus(links.indexOf('depends-on')+3); assert.equal(await page.locator('#article .cm-wiki').count(),2,'relationship source remains visible while editing its annotation');
  await focus(links.indexOf('example.invalid')+2); assert.equal(await page.locator('#article .cm-wiki').count(),2,'external links reveal only at their own caret position');
  await focus(links.length); assert.equal((await inspect('live')).text,links);
  for(const link of await page.locator('#article .cm-wiki').all()) assert.equal(await link.getAttribute('title'),'Ctrl click to open','editable link hover hints explain the open gesture');
  await page.evaluate(()=>window.harness.toggle('live',false));
  for(const link of await page.locator('#article .cm-wiki').all()) assert.equal(await link.getAttribute('title'),'Click to open','reading links support ordinary clicks');
  await page.locator('#article .cm-wiki').first().click();assert.deepEqual(await page.evaluate(()=>window.harness.followed.pop()),{path:'Linked.md',external:false});
  await page.evaluate(()=>window.harness.toggle('live',true));

  const formatting = 'Before **bold** between *italic* and `code` after ~~old~~.';
  await open('live','Precise-formatting.md',formatting);
  for(const position of [0,formatting.indexOf('**'),formatting.indexOf(' between'),formatting.length]) {
    await focus(position);
    const preview=await page.locator('#article .cm-content').innerText();
    assert(!preview.includes('*')&&!preview.includes('`')&&!preview.includes('~'),'format markers remain hidden outside their exact constructs');
  }
  for(const [word,marker] of [['bold','**'],['italic','*'],['code','`'],['old','~~']]) {
    await focus(formatting.indexOf(marker+word)+marker.length+1);
    const source=await page.locator('#article .cm-content').innerText();
    assert(source.includes(marker+word+marker),'active '+word+' formatting reveals both delimiters: '+source);
    assert.equal(await page.locator('#article .md-syntax').count(),2,'another construct on the same line keeps its delimiters hidden');
  }
  await page.evaluate(({anchor,head})=>window.harness.select('live',anchor,head),{anchor:formatting.indexOf('bold'),head:formatting.indexOf('italic')+6});
  await page.evaluate(()=>window.harness.settle());
  assert.equal(await page.locator('#article .md-syntax').count(),4,'selection reveals only intersected formatting constructs');
  await page.screenshot({path:path.join(output,'weave-editor-inline-formatting.png')});

  // Hidden inline-code backticks take no width, so revealing them can push a word
  // onto the next row when the code's row is nearly full; where that happens
  // depends on the engine's font metrics. Narrow the article until the wrapped
  // sample still wraps with room for the backticks on the code's row, so the
  // check measures vertical stability rather than where the text wraps.
  const roomForMarkers=async()=>{
    const width=await page.evaluate(()=>{
      const article=document.getElementById('article');
      for(let width=430;width>=280;width-=6) {
        article.style.width=width+'px';
        const line=[...article.querySelectorAll('.cm-line')].find(line=>line.querySelector('.md-code')),code=line.querySelector('.md-code'),box=code.getBoundingClientRect(),middle=(box.top+box.bottom)/2;
        const range=document.createRange();range.selectNodeContents(line);const rects=[...range.getClientRects()].filter(rect=>rect.width>0);
        const wraps=rects.some(rect=>rect.top>box.bottom||rect.bottom<box.top),rowEnd=Math.max(...rects.filter(rect=>rect.top<=middle&&rect.bottom>=middle).map(rect=>rect.right));
        const room=line.getBoundingClientRect().right-parseFloat(getComputedStyle(line).paddingRight)-rowEnd;
        if(wraps&&room>=1.5*parseFloat(getComputedStyle(code).fontSize)) return width;
      }
      return null;
    });
    assert(width,'an article width leaves room for revealed backticks on a wrapped row');
    await page.evaluate(()=>window.harness.settle());
  };
  for(const settings of [{font:'15px',line:'1.5',primary:'Arial',code:'Consolas'},{font:'21px',line:'1.8',primary:'Georgia',code:'Courier New'}]) {
    await page.evaluate(settings=>{document.documentElement.style.setProperty('--reading-font-size',settings.font);document.documentElement.style.setProperty('--reading-line-height',settings.line);document.documentElement.style.setProperty('--reading-font-family',settings.primary);document.documentElement.style.setProperty('--code-font-family',settings.code);document.getElementById('article').style.width='430px';},settings);
    for(const text of ['Above\nBefore `literal code` after\nBelow\nLast','Above\n`code`\nBelow','Above\nA longer line with `resource_name` and surrounding words that may wrap across two lines.\nBelow']) {
      await open('live','Stable-inline-code.md',text);await focus(text.length);
      if(text.includes('wrap')) await roomForMarkers();
      const before=await rowGeometry();
      const textGeometry=()=>page.locator('#article .cm-line').evaluateAll(lines=>lines.map(line=>{const text=[...line.childNodes].find(node=>node.nodeType===Node.TEXT_NODE&&node.textContent.trim());if(!text)return null;const range=document.createRange();range.selectNodeContents(text);return range.getBoundingClientRect().top;}));
      const beforeText=await textGeometry();await focus(text.indexOf('`')+2);const after=await rowGeometry(),afterText=await textGeometry();
      assert.deepEqual(after,before,'inline-code marker reveal preserves every row position, including wrapped rows');
      assert.deepEqual(afterText,beforeText,'inline-code marker reveal preserves surrounding text baselines');
      await focus(text.length);assert.deepEqual(await rowGeometry(),before,'hiding code markers retains the same positions');
    }
  }
  await page.screenshot({path:path.join(output,'weave-editor-stable-inline-code.png')});
  await page.evaluate(()=>{for(const name of ['--reading-font-size','--reading-line-height','--reading-font-family','--code-font-family'])document.documentElement.style.removeProperty(name);document.getElementById('article').style.removeProperty('width');});

  await open('live','Fenced-formatting.md','```js\nconst value = 1;\n```\n\nOutside');
  await focus(36);
  assert(!(await page.locator('#article .cm-content').innerText()).includes('```'),'inactive code fence marks are hidden');
  await focus(12);
  assert.equal(await page.locator('#article .md-syntax').count(),3,'inside a code block reveals its language and both fences');
  await focus(36);await page.evaluate(()=>window.harness.settle());
  const closing=page.locator('#article .md-code-end');const closingBox=await closing.boundingBox();
  await page.mouse.click(closingBox.x+180,closingBox.y+closingBox.height/2);await page.evaluate(()=>window.harness.settle());
  assert.equal((await inspect('live')).head,26,'clicking hidden closing fence places caret after backticks');
  assert.equal(await closing.innerText(),'```','closing fence reveals on first click');
  const caretBox=await page.evaluate(()=>window.harness.caret()),blockBox=await closing.boundingBox();
  assert(caretBox.top>=blockBox.y-1 && caretBox.bottom<=blockBox.y+blockBox.height+1,'closing-fence caret fits inside code background');
  await open('live','Bold-home.md','**Bold start** with trailing prose');
  await page.keyboard.press('End');await page.keyboard.press('Shift+Home');
  assert.equal((await inspect('live')).head,0,'Shift+Home includes hidden leading bold markers');
  // ==Highlights== hide their marks and respond to editing keys exactly as bold does.
  const highlighted='Before ==marked== after';
  await open('live','Highlight-preview.md',highlighted);await focus(highlighted.length);
  assert(!(await page.locator('#article .cm-content').innerText()).includes('='),'inactive highlight marks are hidden');
  assert.equal(await page.locator('#article .md-highlight').innerText(),'marked');
  await focus(highlighted.indexOf('marked')+2);assert((await page.locator('#article .cm-content').innerText()).includes('==marked=='),'the caret reveals both highlight delimiters');
  const keyResults={};
  for(const marker of ['**','==']) {
    const results=keyResults[marker]=[];
    await open('live','Keys-'+marker.length+marker.charCodeAt(0)+'.md',marker+'Lead word'+marker+' tail');await page.keyboard.press('End');await page.keyboard.press('Shift+Home');results.push((await inspect('live')).head);
    await page.keyboard.press('Control+End');await page.keyboard.press('Home');await page.keyboard.type('X');results.push((await inspect('live')).text.replaceAll(marker,'M'));
    await open('live','Keys-end-'+marker.charCodeAt(0)+'.md','Keep '+marker+'two words'+marker);await page.keyboard.press('Control+End');await page.keyboard.press('Control+Backspace');results.push((await inspect('live')).text.replaceAll(marker,'M'));
    await page.keyboard.press('Control+Backspace');results.push((await inspect('live')).text.replaceAll(marker,'M'));
  }
  assert.deepEqual(keyResults['=='],keyResults['**'],'Shift+Home, Home and Ctrl+Backspace treat highlight marks like bold marks');
  assert.equal(keyResults['=='][0],0,'Shift+Home includes hidden leading highlight markers');

  // <u>Underlines</u> hide their tags and follow the same editing keys as bold.
  const underlined='Before <u>lined</u> after';
  await open('live','Underline-preview.md',underlined);await focus(underlined.length);
  assert(!(await page.locator('#article .cm-content').innerText()).includes('<u>'),'inactive underline tags are hidden');
  assert.equal(await page.locator('#article .md-underline').innerText(),'lined');
  assert.equal(await page.locator('#article .md-underline').evaluate(element=>getComputedStyle(element).textDecorationLine),'underline');
  await focus(underlined.indexOf('lined')+2);assert((await page.locator('#article .cm-content').innerText()).includes('<u>lined</u>'),'the caret reveals both underline tags');
  await open('live','Underline-keys.md','<u>Lead word</u> tail');await page.keyboard.press('End');await page.keyboard.press('Shift+Home');
  assert.equal((await inspect('live')).head,0,'Shift+Home includes hidden leading underline tags');
  await page.keyboard.press('Control+End');await page.keyboard.press('Home');await page.keyboard.type('X');
  assert.equal((await inspect('live')).text,'X<u>Lead word</u> tail','Home moves before hidden leading underline tags');
  await open('live','Underline-end.md','Keep <u>two words</u>');await page.keyboard.press('Control+End');await page.keyboard.press('Control+Backspace');
  assert.equal((await inspect('live')).text,'Keep <u>two words','Ctrl+Backspace removes the closing tag as one unit, like bold marks');
  await page.keyboard.press('Control+Backspace');assert.equal((await inspect('live')).text,'Keep <u>two ','a second Ctrl+Backspace removes the last word');
  await open('live','Underline-shortcut.md','plain words');
  await page.keyboard.press('Control+End');await page.keyboard.press('Shift+Home');await page.keyboard.press('Control+U');
  assert.equal((await inspect('live')).text,'<u>plain words</u>','Ctrl+U underlines the selection');
  await page.keyboard.press('Control+U');assert.equal((await inspect('live')).text,'plain words','Ctrl+U again removes the underline');

  await open('live','Escaped-formatting.md','Literal \\*asterisks\\* and \\`ticks\\` and \\[Linked](Linked.md)');
  await page.keyboard.press('Control+End');await page.evaluate(()=>window.harness.settle());
  const escapedPreview=await page.locator('#article .cm-content').innerText();
  assert(!escapedPreview.includes('\\'),'escape backslashes hide in live preview');
  assert(escapedPreview.includes('*asterisks*')&&escapedPreview.includes('`ticks`')&&escapedPreview.includes('[Linked](Linked.md)'));
  assert.equal(await page.locator('#article .cm-wiki,#article .md-em,#article .md-code').count(),0,'escaped delimiters remain literal');
  await focus(9);assert((await page.locator('#article .cm-content').innerText()).includes('\\*'),'caret inside an escape reveals its source');

  for(const kind of ['live','raw']) {
    await open(kind,'Auto-fence-'+kind+'.md','');await page.keyboard.type('```');
    assert.equal((await inspect(kind)).text,'```\n```','the third backtick supplies a closing fence');
    assert.equal((await inspect(kind)).head,3,'caret stays at the language position');
    await page.keyboard.type('js');await page.keyboard.press('Enter');await page.keyboard.type('const x = 1;');
    assert.equal((await inspect(kind)).text,'```js\nconst x = 1;\n```','the generated fence remains below the editable code body');
    if(kind==='live') {
      const codeStyle=await page.locator('#article .md-code-start').evaluate(element=>getComputedStyle(element).borderTopLeftRadius);
      assert.equal(codeStyle,'5px');await page.screenshot({path:path.join(output,'weave-editor-code-block.png')});
    }
    await open(kind,'Delete-word-'+kind+'.md','Keep middle next');await page.evaluate(kind=>window.harness.focus(kind,8),kind);await page.keyboard.press('Control+Backspace');
    assert.equal((await inspect(kind)).text,'Keep  next','Ctrl+Backspace removes the current word while retaining its surrounding spaces');
    await open(kind,'Search-highlights-'+kind+'.md','Exact C++ and c++ survive. Other code.');await page.evaluate(kind=>window.harness.search(kind,'C++'),kind);
    assert.equal(await page.locator((kind==='live'?'#article':'#source-editor')+' .search-match').count(),2,'search terms are literal and case-insensitive');
    assert.equal((await inspect(kind)).text,'Exact C++ and c++ survive. Other code.','highlighting preserves the source');
    if(kind==='live') {await page.evaluate(()=>window.harness.toggle('live',false));assert.equal(await page.locator('#article .search-match').count(),2,'reading mode retains the exact search highlights');await page.evaluate(()=>window.harness.toggle('live',true));}
    await page.evaluate(kind=>window.harness.search(kind,''),kind);assert.equal(await page.locator('.search-match').count(),0,'clearing search removes the highlights');
    await open(kind,'Shortcuts-'+kind+'.md','selected');
    await page.keyboard.press('Control+a');await page.keyboard.press('Control+b');
    assert.equal((await inspect(kind)).text,'**selected**');
    await page.keyboard.press('Control+b');assert.equal((await inspect(kind)).text,'selected','bold toggle removes its own delimiters');
    await page.keyboard.press('Control+i');assert.equal((await inspect(kind)).text,'*selected*');
    await page.keyboard.press('Control+z');assert.equal((await inspect(kind)).text,'selected','formatting participates in undo');
    await page.keyboard.press('Control+k');assert.equal((await inspect(kind)).text,'[selected]()');
    assert.equal((await inspect(kind)).head,11,'link shortcut puts the caret in the URL destination');
    await open(kind,'Wrap-'+kind+'.md','selected');await page.keyboard.press('Control+a');await page.keyboard.type('`');
    assert.equal((await inspect(kind)).text,'`selected`','typing a backtick wraps selected text as inline code');
    await page.keyboard.press('Control+z');assert.equal((await inspect(kind)).text,'selected');
  }
  await open('live','Bullets.md','- First\n- Second\n\nOutside');await page.keyboard.press('Control+End');
  assert.equal(await page.locator('#article .cm-bullet').count(),2,'hyphens render as bullets');
  await focus(7);await page.keyboard.press('Enter');await page.keyboard.type('Inserted');
  assert.equal((await inspect('live')).text,'- First\n- Inserted\n- Second\n\nOutside','Enter continues the Markdown bullet list');
  await page.screenshot({path:path.join(output,'weave-editor-bullets.png')});

  for(const kind of ['live','raw']) {
    await open(kind,'Indent-'+kind+'.md','- Parent\n- Child');await page.keyboard.press('Control+End');await page.keyboard.press('Tab');
    assert.equal((await inspect(kind)).text,'- Parent\n    - Child','Tab nests a bullet before its marker while the caret is in the text');
    await page.keyboard.press('Enter');assert.equal((await inspect(kind)).text,'- Parent\n    - Child\n    - ','continued bullet includes a trailing space and retains its nesting');
    assert.equal((await inspect(kind)).head,(await inspect(kind)).text.length,'generated bullet caret sits after its space');
    if(kind==='live') {
      await page.evaluate(()=>window.harness.settle());
      const caret=await page.evaluate(()=>window.harness.caret()),bullet=await page.locator('#article .cm-bullet').last().boundingBox();
      assert(caret.left-bullet.x-bullet.width>=2,'generated bullet retains a visible space before the caret');
    }
    await page.keyboard.press('Tab');assert.equal((await inspect(kind)).text,'- Parent\n    - Child\n        - ','Tab also nests a freshly generated empty item');
    await page.keyboard.press('Shift+Tab');assert.equal((await inspect(kind)).text,'- Parent\n    - Child\n    - ','Shift+Tab restores an empty item without eating its space');
    await page.keyboard.type('Sibling');assert.equal((await inspect(kind)).text,'- Parent\n    - Child\n    - Sibling');
    await page.keyboard.press('Shift+Tab');assert.equal((await inspect(kind)).text,'- Parent\n    - Child\n- Sibling');
    await page.keyboard.press('Control+z');assert.equal((await inspect(kind)).text,'- Parent\n    - Child\n    - Sibling','indentation uses the shared undo history');
    await open(kind,'Soft-tabs-'+kind+'.md','Plain');await page.keyboard.press('Control+End');await page.keyboard.press('Tab');await page.keyboard.type('text');
    assert.equal((await inspect(kind)).text,'Plain    text','ordinary text inserts a soft tab at the caret');
    await open(kind,'Plain-indent-'+kind+'.md','    Indented');await page.keyboard.press('Control+End');await page.keyboard.press('Enter');
    assert.equal((await inspect(kind)).text,'    Indented\n    ','new prose line inherits indentation');

    await open(kind,'Exit-empty-list-'+kind+'.md','- Parent\n    - Child\n    - ');await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');assert.equal((await inspect(kind)).text,'- Parent\n    - Child\n- ','Enter exits one nesting level without adding a loose-list blank row');
    await page.keyboard.press('Enter');assert.equal((await inspect(kind)).text,'- Parent\n    - Child\n','Enter exits the empty root item');

    // A nested list needs its parent; four spaces at document start are a code block.
    await open(kind,'Autocomplete-indent-'+kind+'.md','- Parent\n    - [Lin]');await page.keyboard.press('Control+End');await page.keyboard.press('ArrowLeft');await page.evaluate(()=>window.harness.settle());
    assert.equal(await page.locator('#suggestions').isVisible(),true,'a caret inside brackets offers article completion');
    await page.keyboard.press('Shift+Tab');assert.equal((await inspect(kind)).text,'- Parent\n- [Lin]','Shift+Tab outdents instead of accepting a link suggestion');
    await page.evaluate(()=>window.harness.settle());
    await page.keyboard.press('Tab');assert.equal((await inspect(kind)).text,'- Parent\n- [Linked article](./Linked.md "links-to")','unmodified Tab still accepts a link suggestion');
    await open(kind,'Autocomplete-close-'+kind+'.md','');await page.keyboard.type('See [Li');await page.evaluate(()=>window.harness.settle());
    assert.equal((await inspect(kind)).text,'See [Li]','[ closes itself');assert.equal(await page.locator('#suggestions').isVisible(),true);
    await page.keyboard.press('Escape');assert.equal(await page.locator('#suggestions').isVisible(),false,'Escape closes the article list');
    await page.keyboard.press('ArrowRight');await page.keyboard.type(' "q');assert.equal((await inspect(kind)).text,'See [Li] "q"','quotes pair; ArrowRight leaves the brackets');
    await open(kind,'Home-'+kind+'.md','**Bold** start');await page.keyboard.press('Control+End');await page.keyboard.press('Home');await page.keyboard.type('X');
    assert.equal((await inspect(kind)).text,'X**Bold** start','Home reaches the line start before hidden emphasis');

    for(const prefix of ['- ','    - ','\t- ','    - [ ] ','    12. [x] ','> - ']) {
      const text=prefix+'Select just the text';await open(kind,'Select-bullet-'+kind+'.md',text);await page.keyboard.press('Control+End');
      await page.keyboard.press('Shift+Home');let selection=await inspect(kind);
      assert.equal(selection.head,prefix.length,'Shift+Home stops after the list prefix '+JSON.stringify(prefix));assert.equal(selection.anchor,text.length);
      await page.keyboard.press('Shift+Home');selection=await inspect(kind);assert.equal(selection.head,prefix.length,'repeated Shift+Home leaves the marker excluded');
      await page.keyboard.press('Backspace');assert.equal((await inspect(kind)).text,prefix,'deleting the selection preserves indentation, marker, and task checkbox');
    }
  }

  const nestedTabs='- Parent\n\t- Child\n\t\t- Grandchild\n\t- Sibling\n- Last';
  await open('live','Literal-tabs.md',nestedTabs);await page.keyboard.press('Control+End');await page.evaluate(()=>window.harness.settle());
  assert.equal(await page.locator('#article .cm-bullet').count(),5,'literal-tab nested items keep their bullet widgets');
  const bulletOffsets=await page.locator('#article .cm-bullet').evaluateAll(items=>items.map(item=>item.getBoundingClientRect().left));
  assert(bulletOffsets[1]>bulletOffsets[0] && bulletOffsets[2]>bulletOffsets[1]);assert.equal(bulletOffsets[1],bulletOffsets[3]);assert.equal(bulletOffsets[0],bulletOffsets[4]);
  await page.screenshot({path:path.join(output,'weave-editor-nested-tabs.png')});
  await page.evaluate(()=>window.harness.toggle('live',false));
  assert.equal(await page.locator('#article .cm-bullet').count(),5,'reading mode retains every literal-tab nested list item');
  const readBulletOffsets=await page.locator('#article .cm-bullet').evaluateAll(items=>items.map(item=>item.getBoundingClientRect().left));assert.deepEqual(readBulletOffsets,bulletOffsets,'reading retains the same three indentation levels');
  await page.screenshot({path:path.join(output,'weave-reader-nested-tabs.png')});
  await page.evaluate(()=>window.harness.toggle('live',true));

  await page.evaluate(()=>{document.documentElement.style.setProperty('--reading-font-size','21px');document.documentElement.style.setProperty('--reading-line-height','1.8');document.documentElement.style.setProperty('--reading-paragraph-spacing','1em');});
  await open('live','Styled-blank.md','Before\n\nAfter');await focus(7);
  const styledBlank=await page.evaluate(()=>window.harness.caret());await page.keyboard.type('Stable');await page.evaluate(()=>window.harness.settle());
  const styledTyped=await page.evaluate(()=>window.harness.caret());
  assert(Math.abs(styledBlank.top-styledTyped.top)<1 && Math.abs(styledBlank.bottom-styledTyped.bottom)<1,'font and line spacing settings preserve blank-line caret geometry');
  await page.screenshot({path:path.join(output,'weave-editor-styled-caret.png')});
  await page.evaluate(()=>{for(const name of ['--reading-font-size','--reading-line-height','--reading-paragraph-spacing'])document.documentElement.style.removeProperty(name);});

  await open('live','Adjacent-heading.md','# Heading\nImmediately below\n\n## Next heading\nAlso below');
  await focus(9); await page.keyboard.press('Enter'); await page.keyboard.type('New paragraph');
  assert.equal((await inspect('live')).text,'# Heading\nNew paragraph\nImmediately below\n\n## Next heading\nAlso below','Enter at heading end inserts an immediately adjacent prose line');
  const headingLines=await page.locator('#article .cm-line').evaluateAll(lines=>lines.slice(0,3).map(e=>({top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom,paddingBottom:getComputedStyle(e).paddingBottom})));
  assert.equal(headingLines[0].paddingBottom,'0px'); assert(Math.abs(headingLines[1].top-headingLines[0].bottom)<1,'no forced gap below a heading');

  const table = '# Audit operations\n\n| Operation SQL effect | |\n| --- | --- |\n| `uspAuditOnStepStart` | Inserts `ExecutionLog`, status `STARTED`. |\n| `uspAuditOnStepAudit` | Inserts sql-platform/etl-audit/audit.auditlog.md counts. |\n| `uspAuditOnStepEnd` | Records `Step completed`. |\n| `uspAuditOnPackageError` / `uspAuditOnStepError` | Sets `ERROR`. |\n| `uspAuditOnProcessEnd` | Updates last completion. |\n| `uspAuditRaiseError` | Raises a severity-15 SQL error. |\n\nAfter the table.';
  await page.evaluate(()=>document.documentElement.dataset.tableEditing='source');
  await open('live','Audit-table.md',table); await focus(table.length);
  assert.equal(await page.locator('#article .cm-table-preview tbody tr').count(),6,'live preview renders every operation row');
  assert.equal(await page.locator('#article .cm-table-preview th').nth(1).innerText(),'','blank table headers are supported');
  assert.equal(await page.locator('#article .cm-table-preview tbody tr').first().locator('code').count(),3,'table inline code is rendered');
  await page.screenshot({path:path.join(output,'weave-editor-table.png')});
  await page.locator('#article .cm-table-preview tbody tr').last().locator('td').nth(1).click();
  assert.equal(await page.locator('#article .cm-table-preview').count(),0,'clicking a table cell reveals editable source');
  assert.equal((await inspect('live')).head,table.indexOf('Raises a severity'),'click lands at the selected cell');
  await page.keyboard.type('Now '); assert((await inspect('live')).text.includes('| Now Raises a severity'));
  await page.keyboard.press('Control+z'); assert.equal((await inspect('live')).text,table,'cell edits use the same undo history');
  await focus(table.length); assert.equal(await page.locator('#article .cm-table-preview').count(),1,'leaving a table renders it again');
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  await page.screenshot({path:path.join(output,'weave-editor-table-dark.png')});
  await page.evaluate(()=>delete document.documentElement.dataset.theme);
  await open('live','Code-table.md','```md\n| A | B |\n| --- | --- |\n| C | D |\n```\n\nAfter');
  await page.keyboard.press('Control+End'); assert.equal(await page.locator('#article .cm-table-preview').count(),0,'fenced table examples stay literal code');
  await open('live','Linked-table.md','Before\n\n| Link | Value |\n| --- | --- |\n| [Linked](Linked.md "depends-on") | A \\| B |\n\nAfter');
  await page.keyboard.press('Control+End');
  assert.equal(await page.locator('.cm-table-preview td').nth(1).innerText(),'A | B');
  await page.locator('.cm-table-preview [data-open="Linked.md"]').click({modifiers:['Control']});
  assert.deepEqual(await page.evaluate(()=>window.harness.followed),[{path:'Linked.md',external:false}]);
  assert.equal(await page.locator('.cm-table-preview').count(),1,'following a table link does not activate table source');
  await page.locator('.cm-table-preview').focus(); await page.keyboard.press('Enter');
  assert.equal((await inspect('live')).head,10,'keyboard activation enters the first table cell');
  await page.evaluate(()=>document.documentElement.dataset.tableEditing='visual');

  const numbered=Array.from({length:10005},(_,index)=>'Line '+(index+1)).join('\n');
  await page.evaluate(()=>{document.documentElement.dataset.lineNumbers='both';document.getElementById('article').style.width='360px';});
  await open('live','Narrow-line-numbers.md',numbered);await page.keyboard.press('Control+End');await page.evaluate(()=>window.harness.settle());
  const numberBounds=await page.locator('#article').evaluate(article=>{const number=[...article.querySelectorAll('.source-line-number')].find(node=>node.textContent==='10005'),line=[...article.querySelectorAll('.cm-line')].find(node=>node.textContent==='Line 10005'),range=document.createRange();range.selectNodeContents(number);const numberBox=range.getBoundingClientRect().toJSON();range.selectNodeContents(line);return {number:numberBox,line:range.getBoundingClientRect().toJSON(),article:article.getBoundingClientRect().toJSON()};});
  assert(numberBounds.number.left>=numberBounds.article.left,'five-digit line numbers remain inside a narrow article');
  assert(numberBounds.number.right<numberBounds.line.left,'five-digit line numbers never intrude into prose');
  await page.screenshot({path:path.join(output,'weave-editor-narrow-line-numbers.png')});
  await page.evaluate(()=>{delete document.documentElement.dataset.lineNumbers;document.getElementById('article').style.removeProperty('width');});
  const paragraphs = Array.from({length:1000},(_,i)=>`Paragraph ${i+1}. Natural editing preserves **focused prose**, \`resource_${i+1}\`, and [Linked](Linked.md "depends-on"). This sentence gives the caret room to move.`);
  const large = paragraphs.join('\n\n');
  await open('live','Large.md',large);
  await page.evaluate(()=>window.harness.prepareMetrics());
  await page.evaluate(position=>window.harness.focus('live',position),large.indexOf('Paragraph 500.')+14);
  await page.evaluate(()=>window.harness.settle());
  async function sampleKeys(category,keys) {
    await page.evaluate(category=>window.harness.measure(category),category);
    for(const key of keys) {
      const count = await page.evaluate(()=>window.harness.samples.length);
      await page.keyboard.press(key);
      await page.waitForFunction(count=>window.harness.samples.length>count,count);
    }
  }
  await sampleKeys('typing',Array.from({length:32},(_,i)=>'polished'[i%8]));
  await sampleKeys('caretWithinLine',Array.from({length:32},(_,i)=>i%2?'ArrowRight':'ArrowLeft'));
  await sampleKeys('caretAcrossLines',Array.from({length:24},()=> 'ArrowDown'));
  const samples = await page.evaluate(()=>window.harness.stopMetrics());
  const summarize = category => {
    const values=samples.filter(s=>s.category===category).map(s=>s.ms).sort((a,b)=>a-b);
    assert(values.length>=24,'benchmark must capture enough actual keyboard updates');
    const round=n=>Math.round(n*100)/100;
    return {samples:values.length,medianMs:round(values[Math.floor(values.length/2)]),p95Ms:round(values[Math.ceil(values.length*.95)-1]),maxMs:round(values.at(-1))};
  };
  const metrics={fixture:{paragraphs:1000,characters:large.length,wikiLinks:1000},browser:await browser.version(),measurement:'Captured keydown to the animation frame after the CodeMirror document or selection update; headless local browser. Informational, without hardware-dependent timing assertions.',typing:summarize('typing'),caretWithinLine:summarize('caretWithinLine'),caretAcrossLines:summarize('caretAcrossLines')};
  assert((await inspect('live')).text.includes('polished'.repeat(4)),'every measured typing input must appear in the document');
  assert.deepEqual(errors,[],'browser errors'); assert.deepEqual(remoteRequests,[],'fixture must remain offline');
  await fs.writeFile(path.join(output,'weave-editor-performance.json'),JSON.stringify(metrics,null,2)+'\n');
  await page.screenshot({path:path.join(output,'weave-editor-large-document.png')});
  const scrollArticle=Array.from({length:500},(_,i)=>`## Section ${i}\n\n${'Long paragraph with **bold** text and wrapped prose. '.repeat(i%8+1)}\n\n\`\`\`js\nconst value = ${i};\n\`\`\`\n\n`).join('');
  for(const kind of ['live','raw']) {
    await open(kind,'Scrollbar-'+kind+'.md',scrollArticle);
    await page.locator('#editor-fixture').evaluate(node=>node.scrollTop=0);await page.evaluate(()=>window.harness.settle());
    const track=page.locator('.article-scrollbar'),thumb=page.locator('.article-scroll-thumb');
    await track.waitFor({state:'visible'});const trackBox=await track.boundingBox(),start=await thumb.boundingBox();
    await page.mouse.move(10,10);
    const idle=await thumb.evaluate(node=>({thumb:getComputedStyle(node).backgroundColor,track:getComputedStyle(node.parentElement).backgroundColor,opacity:getComputedStyle(node).opacity}));
    assert.notEqual(idle.thumb,idle.track,'thumb contrasts with its track without hover');assert.equal(idle.opacity,'1');
    await page.evaluate(()=>document.documentElement.style.setProperty('--line','var(--paper)'));
    assert.equal(await thumb.evaluate(node=>getComputedStyle(node).backgroundColor),idle.thumb,'idle thumb does not disappear when border and paper colours match');
    await page.evaluate(()=>document.documentElement.style.removeProperty('--line'));
    await page.mouse.move(start.x+start.width/2,start.y+start.height/2);await page.mouse.down();
    for(const fraction of [.2,.55,.85,.4]) {
      const y=trackBox.y+trackBox.height*fraction;
      await page.mouse.move(start.x+start.width/2,y,{steps:8});await page.evaluate(()=>window.harness.settle());
      const box=await thumb.boundingBox();assert(Math.abs(box.y+box.height/2-y)<2,kind+' scrollbar remains under the pointer as offscreen rows are measured');
    }
    await page.mouse.up();await thumb.focus();await page.keyboard.press('End');await page.evaluate(()=>window.harness.settle());
    await page.waitForFunction(()=>{const node=document.getElementById('editor-fixture');return Math.abs(node.scrollTop+node.clientHeight-node.scrollHeight)<3;});
    await page.screenshot({path:path.join(output,'weave-'+kind+'-scrollbar.png')});
  }
  // Paste turns formatted clipboard HTML into Markdown; unformatted HTML and Paste as plain text keep the text.
  const pasted = await page.evaluate(() => {
    const {htmlToMarkdown, hasFormatting, pasteText} = window.pasteMarkdown;
    return {
      rich: htmlToMarkdown('<h2>Plan</h2><p>Use <b>bold</b>, <i>italic</i> and <a href="https://example.com/a b">a link</a> with <code>x_y</code>.</p><ul><li>One<ul><li>Nested</li></ul></li><li>Two</li></ul><ol start="3"><li>Third</li></ol><blockquote><p>Quoted</p></blockquote><pre><code class="language-js">let a = 1;\n</code></pre><table><tr><th>A</th><th>B</th></tr><tr><td>1|2</td><td>3</td></tr></table><script>alert(1)</script><a href="javascript:alert(1)">unsafe</a>'),
      escaped: htmlToMarkdown('<p><b>2 * 3</b> [not a link]</p>'),
      underline: [htmlToMarkdown('<p><u>Under</u></p>', {underline: true}), htmlToMarkdown('<p><u>Under</u></p>')],
      docs: hasFormatting('<b style="font-weight:normal" id="docs-internal-guid-1"><span>Plain words</span></b>'),
      editor: hasFormatting('<div><span style="color:#333">  const x = 1;</span></div>'),
      plain: pasteText({html: '<p><b>Bold</b></p>', text: 'Bold'}, {plain: true}),
      formatted: pasteText({html: '<p><b>Bold</b></p>', text: 'Bold'}),
    };
  });
  assert.equal(pasted.rich, ['## Plan', '', 'Use **bold**, *italic* and [a link](<https://example.com/a b>) with `x_y`.', '', '- One', '  - Nested', '- Two', '', '3. Third', '', '> Quoted', '', '```js', 'let a = 1;', '```', '', '| A | B |', '| --- | --- |', String.raw`| 1\|2 | 3 |`, '', 'unsafe'].join('\n'));
  assert.equal(pasted.escaped, String.raw`**2 \* 3** \[not a link\]`);
  assert.deepEqual(pasted.underline, ['<u>Under</u>', 'Under']);
  assert.equal(pasted.docs, false, 'Google Docs wrappers alone are not formatting');
  assert.equal(pasted.editor, false, 'code editor colouring pastes as plain text');
  assert.deepEqual([pasted.plain, pasted.formatted], ['Bold', '**Bold**']);
  console.log('Editor verification passed: history, formatting, fence hit testing, Shift+Home, stable long-document scrollbar dragging, and 1,000-paragraph input benchmark.');
  console.log(JSON.stringify(metrics,null,2));
} finally {await browser.close();}
