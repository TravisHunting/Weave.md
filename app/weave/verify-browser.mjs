import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {NativeHarness} from './tests/native-harness.mjs';
import {renderPage, readWorkspace, buildDesktop, ROOT} from './build.mjs';
import {createServer} from './server.mjs';
import {verifyAppearance,ensureAppearanceSection} from './verify-appearance.mjs';
import {verifySidebars} from './verify-sidebars.mjs';
import {unstamped, stamped} from './verify-stamps.mjs';
import {verifyFolders} from './verify-folders.mjs';
import {verifyTableIntegration} from './verify-table-integration.mjs';
import {launchBrowser, menuItem} from './test-browser.mjs';
const desktop=process.argv.includes('--desktop'), dynamic=process.argv.includes('--dynamic'), mode=desktop?'desktop':dynamic?'dynamic':'standalone';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'weave-browser-')), output=path.join(ROOT,'test-results');await fs.mkdir(output,{recursive:true});
await fs.writeFile(path.join(root,'sample.txt'),'Non-Markdown fixture');
await fs.mkdir(path.join(root,'.obsidian'));await fs.writeFile(path.join(root,'.obsidian','settings.json'),'{}');
await fs.mkdir(path.join(root,'Systems'));await fs.mkdir(path.join(root,'Teams'));
await fs.writeFile(path.join(root,'Overview.md'),'# Data platform\n\nPolicy records travel through typed connections.\n\n[Azure Data Factory](<Systems/Azure Data Factory.md> "depends-on")\n\n[Missing service](<Missing service.md> "owned-by")');
await fs.writeFile(path.join(root,'Systems/Azure Data Factory.md'),'# Azure Data Factory\n\nADF copies policy records ABC-901 into the reporting warehouse.\n\n## `PROD.SYSTEM.SALES_ANALYTICS`\n\n### Execution\n\n[Snowflake](Systems/Snowflake.md "writes-to")\n\n[Data Platform](<Teams/Data Platform.md> "owned-by")\n\nTopics: API, SQL.');
await fs.writeFile(path.join(root,'Systems/Snowflake.md'),'# Snowflake\n\nThe REPORT schema holds policy records for analysis.');
await fs.writeFile(path.join(root,'Teams/Data Platform.md'),'# Data Platform\n\nMaintains the shared systems.');
let service,server, storageSelection=null;
const browser=await launchBrowser(), page=await browser.newPage({locale:'en-GB',viewport:{width:1500,height:1000}}), errors=[], requests=[];
// The root's appearance as the body starts: appearance-boot.mjs must already have applied it.
await page.addInitScript(()=>{new MutationObserver((_,observer)=>{if(!document.body)return;observer.disconnect();const root=document.documentElement;window.__weaveFirstAppearance={skin:root.dataset.skin,scheme:root.dataset.scheme,titlebarTabs:root.dataset.titlebarTabs,bg:root.style.getPropertyValue('--bg')};}).observe(document,{childList:true,subtree:true});});
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('request',r=>requests.push(r.url()));
try {
  if(desktop){
    await buildDesktop(); service=new NativeHarness(path.join(root,'.weave'));await service.open(root);
    let hasChosen=false;
  await page.exposeFunction('__WEAVE_TEST_INVOKE__',async(command,input)=>{
      if(command==='choose_storage_directory')return storageSelection;
      if(command==='choose_workspace'){hasChosen=true;return service.open(root);}
      if(command==='window_action')return {maximized:input.action==='maximize',decorated:false};
      if(command==='editor_state'||command==='open_resource')return;
      const {op,args}=input;if(op==='restore'&&!hasChosen)return null;
      if(op==='revealPath'){await service.call(op,args);return {revealed:true};}
      return service.call(op,args);
    });
    await page.goto(pathToFileURL(path.join(ROOT,'dist/desktop/index.html')).href);
    await page.locator('#welcome-open').click();await page.locator('[data-tree-path="Overview.md"]').waitFor();
  }else if(dynamic){server=await createServer({root,port:0,runtime:path.join(root,'.weave')});await page.goto(server.url);}
  else {const file=path.join(output,'weave-standalone-fixture.html');await fs.writeFile(file,await renderPage(await readWorkspace(root)));await page.goto(pathToFileURL(file).href);}
  await page.waitForFunction(()=>document.querySelector('[data-tree-path="Overview.md"] .tree-name')?.textContent === 'Data platform');
  assert.equal(await page.locator('[data-tree-path="Overview.md"] .tree-name').innerText(),'Data platform');
  assert.deepEqual(await page.evaluate(()=>window.__weaveFirstAppearance),await page.evaluate(()=>{const root=document.documentElement;return {skin:root.dataset.skin,scheme:root.dataset.scheme,titlebarTabs:root.dataset.titlebarTabs,bg:root.style.getPropertyValue('--bg')};}),'the saved appearance applies before the body is parsed');
  assert.equal(await page.locator('#file-labels').inputValue(),'title-first','file labels default to title and filename');
  assert.equal(await page.locator('[data-tree-path="Overview.md"] .tree-secondary').innerText(),'Overview');
  assert.equal(await page.locator('.rail #refresh + [data-panel="appearance"]').count(),1,'refresh sits immediately above visual styling');
  const filesHeader=await page.locator('#panel-title').boundingBox(), newFolderBox=await page.locator('#new-folder').boundingBox();assert(Math.abs(filesHeader.y-newFolderBox.y)<10,'file actions share the heading row');
  const sidebarBox=await page.locator('#sidebar').boundingBox(),actionsBox=await page.locator('#file-actions').boundingBox();assert(Math.abs(actionsBox.x+actionsBox.width/2-sidebarBox.x-sidebarBox.width/2)<2,'creation icons are centered in the sidebar');
  assert.equal(await page.locator('[data-tree-path="Systems"]').evaluate(e=>getComputedStyle(e).fontSize),'13px');
  const alignment=await page.locator('[data-tree-path="Systems"]').evaluate(row=>{const icon=row.querySelector('svg').getBoundingClientRect(),text=row.querySelector('.tree-name').getBoundingClientRect();return Math.abs(icon.y+icon.height/2-text.y-text.height/2);});
  assert(alignment<1,'folder chevrons and names share a vertical center');
  for (const name of ['files','settings','git','search','appearance']) {
    const button=page.locator(`[data-panel="${name}"]`);
    if (!await button.isVisible()) continue;
    if(await button.getAttribute('aria-pressed')!=='true')await button.click();
    await button.click(); assert(await page.locator('body').evaluate(e=>e.classList.contains('sidebar-collapsed')),name+' toggles closed');
    assert.equal(await button.getAttribute('aria-pressed'),'false');
    await button.click(); assert.equal(await page.locator('body').evaluate(e=>e.classList.contains('sidebar-collapsed')),false,name+' reopens');
    assert.equal(await button.getAttribute('aria-pressed'),'true');
  }
  await page.getByRole('button',{name:'Files',exact:true}).click();
  await page.getByRole('button',{name:'Control panel',exact:true}).click();
  await page.locator('#show-all-files').check();await page.locator('#show-extensions').check();await page.getByRole('button',{name:'Visual styling',exact:true}).click();await ensureAppearanceSection(page,'appearance-files');await page.locator('#file-labels').selectOption('filename-first');
  await page.getByRole('button',{name:'Files',exact:true}).click();
  assert.equal(await page.locator('[data-tree-path="Overview.md"] .tree-name').innerText(),'Overview.md');assert.equal(await page.locator('[data-tree-path="Overview.md"] .tree-secondary').innerText(),'Data platform');assert(await page.locator('[data-tree-path="sample.txt"]').isVisible());
  await page.getByRole('button',{name:'Visual styling',exact:true}).click();await ensureAppearanceSection(page,'appearance-files');await page.locator('#file-labels').selectOption('title-first');await page.getByRole('button',{name:'Files',exact:true}).click();assert.equal(await page.locator('[data-tree-path="Overview.md"] .tree-secondary').innerText(),'Overview.md');
  await page.locator('[data-tree-path="Systems"]').click();await page.evaluate(()=>document.documentElement.style.setProperty('--sidebar','180px'));
  const clipped=await page.locator('[data-tree-path="Systems/Azure Data Factory.md"]').evaluate(row=>{const primary=row.querySelector('.tree-name'),secondary=row.querySelector('.tree-secondary'),labels=row.querySelector('.tree-labels');return {primaryClipped:primary.scrollWidth>primary.clientWidth,secondaryStart:secondary.getBoundingClientRect().left,clipEnd:labels.getBoundingClientRect().right};});
  assert(clipped.primaryClipped);assert(clipped.secondaryStart>=clipped.clipEnd,'secondary text is hidden while primary text is truncated');
  await page.evaluate(()=>document.documentElement.style.removeProperty('--sidebar'));
  await page.getByRole('button',{name:'Visual styling',exact:true}).click();await ensureAppearanceSection(page,'appearance-files');await page.locator('#file-labels').selectOption('title');await page.getByRole('button',{name:'Control panel',exact:true}).click();await page.locator('#show-all-files').uncheck();await page.locator('#show-extensions').uncheck();await page.getByRole('button',{name:'Files',exact:true}).click();
  await page.locator('[data-tree-path="Overview.md"]').click();await page.locator('#article .md-h1').waitFor();assert.equal(await page.locator('#article .md-h1').innerText(),'Data platform');assert.equal(await page.locator('#article .cm-wiki.broken').count(),1);
  await verifyAppearance(page,output,mode);
  await page.locator('[data-tree-path="Systems"]').click();
  await page.locator('#files-panel').click({position:{x:15,y:450}});
  assert.equal(await page.locator('#tree .selected').count(),0,'blank file pane selects the root');
  assert.equal(await page.locator('#article .md-h1').innerText(),'Data platform','root selection leaves the article open');
  await page.locator('#article [data-editor-link="Systems/Azure Data Factory.md"]').click();await page.waitForFunction(()=>document.getElementById('note-path').dataset.path==='Systems/Azure Data Factory.md');
  await page.locator('#toggle-graph').click();await page.locator('#graph-nodes [data-node="Systems/Snowflake.md"]').waitFor();assert(await page.locator('#graph-count').isHidden(),'graph counts are hidden by default');
  assert.equal(await page.locator('[data-node="Systems/Azure Data Factory.md"]').getAttribute('data-type'),'Systems');assert.match(await page.locator('[data-node="Systems/Azure Data Factory.md"] .node-tags').textContent(),/#API.*#SQL/);
  assert.notEqual(await page.locator('[data-node="Systems/Azure Data Factory.md"] .node-body').getAttribute('fill'),await page.locator('[data-node="Teams/Data Platform.md"] .node-body').getAttribute('fill'));
  const zoom=await page.locator('#zoom-label').innerText();await page.locator('#zoom-in').click();assert.notEqual(await page.locator('#zoom-label').innerText(),zoom);assert(await page.locator('#graph-fit').isVisible(),'graph controls remain exposed');await page.locator('#graph-fit').click();assert.equal(await page.locator('#graph-panel .graph-bar').count(),0,'the old graph toolbar is removed');
  const height=await page.locator('#graph-panel').evaluate(e=>e.clientHeight);await page.locator('#graph-resize').focus();await page.keyboard.press('ArrowDown');assert((await page.locator('#graph-panel').evaluate(e=>e.clientHeight))>height);
  await page.locator('#graph-nodes [data-node="Systems/Snowflake.md"]').click();await page.waitForFunction(()=>document.getElementById('note-path').dataset.path==='Systems/Snowflake.md');
  assert(await page.locator('[data-tree-path="Systems/Snowflake.md"]').isVisible());assert.equal(await page.locator('#file-tabs [role="tab"]').count(),1);
  const indent=await page.locator('[data-tree-path="Systems/Snowflake.md"] .tree-icon').boundingBox(), parentIcon=await page.locator('[data-tree-path="Systems"] .tree-icon').boundingBox();assert(indent.x-parentIcon.x>=20,'child files are visibly indented');
  await page.locator('#nav-back').click();await page.waitForFunction(()=>document.getElementById('note-path').dataset.path==='Systems/Azure Data Factory.md');await page.locator('#nav-forward').click();await page.waitForFunction(()=>document.getElementById('note-path').dataset.path==='Systems/Snowflake.md');
  assert.equal(await page.locator('#view-article').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('#view-graph').getAttribute('aria-pressed'),'true');
  await menuItem(page,'view-article');assert(await page.locator('#editor-left').evaluate(e=>e.classList.contains('article-minimized')));const minimized=await page.locator('#note-panel').boundingBox();assert(minimized.height<40);assert(minimized.y+minimized.height>950);
  await page.locator('#view-graph').click();assert.equal(await page.locator('#view-article').getAttribute('aria-pressed'),'true');assert(await page.locator('#graph-panel').isHidden());
  await page.locator('#view-graph').click();await menuItem(page,'view-article');await menuItem(page,'view-article');assert.equal(await page.locator('#editor-left').evaluate(e=>e.classList.contains('article-minimized')),false);
  await menuItem(page,'view-article');const grip=await page.locator('#article-resize').boundingBox();await page.mouse.move(grip.x+80,grip.y+10);await page.mouse.down();await page.mouse.move(grip.x+80,grip.y-260,{steps:8});await page.mouse.up();assert.equal(await page.locator('#view-article').getAttribute('aria-pressed'),'true');assert((await page.locator('#note-panel').boundingBox()).height>200);
  await page.locator('#new-tab').click();assert(await page.locator('#welcome').isVisible());assert.equal(await page.locator('#file-tabs [role="tab"]').count(),2);await page.locator('[data-tree-path="Overview.md"]').click();assert.equal(await page.locator('#file-tabs [role="tab"]').count(),2);
  await page.locator('#file-tabs [role="tab"]').first().click();await page.waitForFunction(()=>document.getElementById('note-path').dataset.path==='Systems/Snowflake.md');assert.equal(await page.locator('#nav-back').isDisabled(),false);
  await page.locator('#file-tabs [role="tab"]').last().click({button:'right'});await page.locator('#context-close-tab').click();assert.equal(await page.locator('#file-tabs [role="tab"]').count(),1);
  await page.keyboard.press('Control+t');await page.waitForFunction(()=>document.querySelectorAll('#file-tabs [role="tab"]').length===2);await page.locator('#file-tabs [role="tab"]').last().click({button:'middle'});await page.waitForFunction(()=>document.querySelectorAll('#file-tabs [role="tab"]').length===1);
  assert.equal(await page.locator('#search-panel input[type="checkbox"]').count(),0);assert.equal(await page.locator('#use-semantic').count(),0);assert.equal(await page.locator('#settings-panel #use-connections').isChecked(),true);
  await page.getByRole('button',{name:'Search',exact:true}).click();await page.locator('#search-query').fill('ABC-901');await page.locator('#search-results .result').first().waitFor();assert.match(await page.locator('#search-results').innerText(),/Azure Data Factory/);
  assert.equal(await page.locator('#search-query').evaluate(element=>getComputedStyle(element).outlineStyle),'none','focused search has no clipped outline');
  await page.locator('#search-results .search-match').first().waitFor();assert.equal(await page.locator('#search-results .search-match').first().innerText(),'ABC-901');
  await page.locator('#search-results .result').first().click();await page.locator('#article .search-match').first().waitFor();
  assert.equal(await page.locator('#article .search-match').first().innerText(),'ABC-901','opening a result highlights its exact query in the article');
  await page.screenshot({path:path.join(output,'weave-'+mode+'-reader.png'),fullPage:true});
  if(desktop){
    await page.locator('#search-results .result').first().click();
    assert.doesNotMatch(await page.locator('#article').innerText(),/@@/);
    await page.waitForFunction(()=>document.querySelector('#article .md-h1')?.textContent === 'Azure Data Factory');
    const font=await page.evaluate(()=>getComputedStyle(document.querySelector('#article .md-h1')).fontSize);
    const readProseY=await page.locator('#article .cm-line').filter({hasText:'ADF copies'}).evaluate(e=>e.getBoundingClientRect().top-e.closest('article').getBoundingClientRect().top);
    const subheadingFont=await page.locator('#article .md-h2 .md-code').evaluate(e=>getComputedStyle(e).fontSize),thirdFont=await page.locator('#article .md-h3').evaluate(e=>getComputedStyle(e).fontSize);
    await page.locator('#edit-mode').click();
    assert.equal(await page.locator('#app-menu #source-mode').count(),1);assert.equal(await page.locator('.note-toolbar').count(),0);
    assert.equal(await page.locator('footer #workspace-name').innerText(),service.root);assert.match(await page.locator('#note-path').innerText(),/[\\/]Systems[\\/]Azure Data Factory\.md$/);
    const heading=page.locator('#article .md-h1');assert.equal(await heading.evaluate(e=>getComputedStyle(e).fontSize),font);
    assert.equal(await page.locator('#article .md-h2 .md-code').evaluate(e=>getComputedStyle(e).fontSize),subheadingFont);assert.equal(await page.locator('#article .md-h3').evaluate(e=>getComputedStyle(e).fontSize),thirdFont);
    await heading.click();assert.equal(await heading.evaluate(e=>getComputedStyle(e).fontSize),font);
    const prose=page.locator('#article .cm-line').filter({hasText:'ADF copies'});
    const editProseY=await prose.evaluate(e=>e.getBoundingClientRect().top-e.closest('article').getBoundingClientRect().top);assert(Math.abs(readProseY-editProseY)<3, 'read/edit paragraph spacing agrees');
    // Empty-line clicks work across the whole width, including after focus leaves.
    for(const fraction of [.08,.85]) {
      await page.locator('#view-graph').focus();
      const blank=page.locator('#article .md-blank').first(),box=await blank.boundingBox();
      await page.mouse.click(box.x+box.width*fraction,box.y+box.height/2);
      await page.waitForFunction(x=>{const caret=document.querySelector('#article .cm-editor.cm-focused .cm-cursor')?.getBoundingClientRect();return caret?.height>=18&&Math.abs(caret.x-x)<3;},box.x);
      const caret=await page.locator('#article .cm-cursor').first().boundingBox();
      assert(caret.width>=2,'caret is clearly visible');assert(Math.abs(caret.x-box.x)<3,'empty line caret starts at the left');
      await page.keyboard.type('Blank line probe');
      assert.equal(await page.locator('#article .cm-line').nth(1).innerText(),'Blank line probe','typing goes into clicked empty line');
      await page.keyboard.press('Control+z');
    }
    const marginBox=await page.locator('#article').boundingBox(),lineBox=await prose.boundingBox();
    await page.mouse.click(marginBox.x+8,lineBox.y+lineBox.height/2);await page.keyboard.type('MarginProbe');
    assert.match(await prose.innerText(),/^MarginProbeADF/,'left document padding maps to nearest paragraph');await page.keyboard.press('Control+z');
    await prose.click();assert.equal(await page.locator('#article .cm-content').evaluate(e=>getComputedStyle(e).outlineStyle),'none');
    await page.keyboard.type('X');assert.match(await prose.innerText(),/X/);await page.keyboard.press('Control+z');assert.doesNotMatch(await prose.innerText(),/X/);
    assert.deepEqual(errors,[], 'editor runtime errors');assert.match(await page.locator('#article .cm-content').innerText(),/Azure Data Factory/,'undo preserves heading');
    const headingBox=await heading.boundingBox(),proseBox=await prose.boundingBox();
    await page.mouse.move(headingBox.x+5,headingBox.y+headingBox.height/2);await page.mouse.down();await page.mouse.move(proseBox.x+200,proseBox.y+proseBox.height/2,{steps:12});await page.mouse.up();
    assert.match(await page.evaluate(()=>getSelection().toString()),/Azure Data Factory[\s\S]*ADF/,'mouse selection crosses paragraphs');
    assert.equal(await prose.evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)','no hover-line highlighting');
    await page.keyboard.press('Control+Home');for(let i=0;i<3;i++){await page.keyboard.press('Control+Shift+ArrowDown');}
    assert.match(await page.evaluate(()=>getSelection().toString()),/Azure Data Factory[\s\S]*ADF copies/,'selection spans heading and prose');
    await page.keyboard.press('Control+a');await page.keyboard.insertText('# Editing feels natural\n\nClick any empty line to continue writing.\n\n```js\nconst greeting = "Hello, Weave";\n\nconsole.log(greeting);\n```\n\nA final paragraph.\n\n');
    const codeLine=page.locator('#article .md-code-line').filter({hasText:'const greeting'});
    assert.equal(await codeLine.evaluate(e=>parseFloat(getComputedStyle(e).paddingLeft)),14,'editable code has a left inset');
    const emptyCode=page.locator('#article .md-code-line.md-blank'),emptyCodeBox=await emptyCode.boundingBox();await emptyCode.click({position:{x:100,y:12}});await page.keyboard.type('// Code line');
    assert.match(await page.locator('#article .cm-line').nth(6).innerText(),/Code line/);await page.keyboard.press('Control+z');
    await page.locator('#view-graph').click();await page.getByRole('button',{name:'Files',exact:true}).click();
    await codeLine.click();await page.locator('#note-panel').evaluate(e=>e.scrollTop=0);await page.screenshot({path:path.join(output,'weave-desktop-editor-polish.png'),fullPage:true});
    await page.locator('#theme').click();await page.screenshot({path:path.join(output,'weave-desktop-editor-polish-dark.png'),fullPage:true});await page.locator('#theme').click();
    // Reading and returning to editing keeps document history intact.
    await page.keyboard.press('Control+End');await page.keyboard.type('History stays');await menuItem(page,'save');await page.waitForFunction(()=>document.getElementById('save-status').textContent==='Saved');
    await page.locator('#edit-mode').click();await page.locator('#edit-mode').click();await page.locator('#article .cm-content').click();await page.keyboard.press('Control+z');
    assert.doesNotMatch(await page.locator('#article .cm-content').innerText(),/History stays/,'undo survives an edit/read toggle');
    await page.locator('#view-graph').click();
    // The click leaves focus on the button. Chromium's Select All follows the
    // selection still inside the editor and WebKit's selects the page, so focus
    // the editor before replacing the article.
    await page.locator('#article .cm-content').focus();
    await page.keyboard.press('Control+a');await page.keyboard.insertText('# Azure Data Factory\n\nUpdated policy records ABC-901 and PROD.SYSTEM.SALES_ANALYTICS.\n\n[Snowflake](Systems/Snowflake.md "writes-to")\n\n[Data Platform](<Teams/Data Platform.md> "owned-by")\n\nTopics: API, SQL.');
    await menuItem(page,'save');
    await page.waitForFunction(()=>document.getElementById('save-status').textContent==='Saved');assert.match(await fs.readFile(path.join(root,'Systems/Azure Data Factory.md'),'utf8'),/Updated/);
    assert.equal(await page.locator('[data-panel="files"]').getAttribute('aria-pressed'),'true');
    await page.locator('[data-tree-path="Systems/Snowflake.md"]').click();
    await page.keyboard.press('F2');await page.locator('#prompt-dialog').waitFor({state:'visible'});assert.equal(await page.locator('#prompt-title').innerText(),'Retitle Article');assert.equal(await page.locator('#prompt-value').inputValue(),'Snowflake');
    await page.locator('#prompt-value').fill('Snowflake warehouse');await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelector('[data-tree-path="Systems/Snowflake.md"] .tree-name')?.textContent==='Snowflake warehouse');
    const retitled=await fs.readFile(path.join(root,'Systems/Snowflake.md'),'utf8');assert.match(unstamped(retitled),/^# Snowflake warehouse/);assert(stamped(retitled),'retitling stamps the article');
    assert.match(await fs.readFile(path.join(root,'Systems/Azure Data Factory.md'),'utf8'),/\[Snowflake\]\(Systems\/Snowflake.md "writes-to"\)/,'F2 leaves incoming links unchanged');
    await page.locator('[data-tree-path="Systems/Snowflake.md"]').click({button:'right'});await page.locator('[data-file-action="rename"]').click();
    assert.equal(await page.locator('#prompt-title').innerText(),'Rename file');assert.equal(await page.locator('#prompt-value').inputValue(),'Snowflake');await page.locator('#prompt-value').fill('Warehouse');await page.keyboard.press('Enter');await page.waitForFunction(()=>document.getElementById('prompt-title').textContent==='Update links?');assert.match(await page.locator('#prompt-description').innerText(),/1 link across 1 note/);assert.equal(await page.locator('#prompt-ok').evaluate(e=>e===document.activeElement),true,'update links is the default');await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.getElementById('note-path').dataset.path==='Systems/Warehouse.md');assert.match(await fs.readFile(path.join(root,'Systems/Azure Data Factory.md'),'utf8'),/\[Snowflake\]\(\.\/Warehouse\.md "writes-to"\)/,'rename keeps relative links relative');
    await page.locator('[data-tree-path="Systems"]').click({button:'right'});assert.match(await page.locator('[data-file-action="rename"]').innerText(),/Rename folder/);await page.locator('[data-file-action="create"]').click();assert.equal(await page.locator('#prompt-value').inputValue(),'Untitled');await page.locator('#prompt-value').fill('New_article_name.md');await page.locator('#prompt-ok').click();await page.waitForFunction(()=>document.getElementById('note-path').dataset.path==='Systems/New_article_name.md');
    assert.equal((await service.getDocument('Systems/New_article_name.md')).title,'New_article_name');assert.match(await page.locator('#note-path').innerText(),/New_article_name/);assert.equal(await page.locator('#note-path em').count(),0);
    await page.locator('#article .cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.type('\n\nSee [');await page.waitForFunction(()=>!document.getElementById('suggestions').hidden&&document.querySelectorAll('#suggestions button').length>1);
    assert.match(await page.locator('#article .cm-content').innerText(),/See \[\]$/m,'typing [ closes the bracket and opens the article list');
    await page.keyboard.type('Ware');await page.waitForFunction(()=>document.querySelectorAll('#suggestions button').length===1);
    assert.match(await page.locator('#suggestions button span').first().innerText(),/Snowflake/);await page.keyboard.press('Enter');assert.match(await page.locator('#article .cm-content').innerText(),/See \[Snowflake warehouse\]\(\.\/Warehouse\.md "links-to"\)$/m,'choosing an article writes a relative OKF link naming its relationship');
    // The caret sits after the link, which stays open for editing; replace links-to.
    await page.keyboard.press('ArrowLeft');await page.keyboard.press('ArrowLeft');for(let i=0;i<'links-to'.length;i++)await page.keyboard.press('Backspace');await page.keyboard.type('custom-type');await menuItem(page,'save');
    await page.waitForFunction(()=>document.getElementById('save-status').textContent==='Saved');assert.match(unstamped(await fs.readFile(path.join(root,'Systems/New_article_name.md'),'utf8')),/^---\ntype: Note\ntitle: New_article_name\n---\n# New\\_article\\_name\n/,'new articles start with OKF frontmatter titled from the filename');assert.equal((await service.getOutgoingRelationships('Systems/New_article_name.md'))[0].relationship_type,'custom-type');
    assert.match(await fs.readFile(path.join(root,'Systems/New_article_name.md'),'utf8'),/See \[Snowflake warehouse\]\(\.\/Warehouse\.md "custom-type"\)/,'quotes pair and the closing quote is typed over');
    await page.locator('#article .cm-wiki').click();await page.waitForFunction(()=>document.getElementById('article').innerText.includes('"custom-type"'));
    await page.screenshot({path:path.join(output,'weave-desktop-editor.png'),fullPage:true});
    await page.locator('#edit-mode').click();assert.equal(await page.locator('#article .cm-content').getAttribute('contenteditable'),'false');const readText=await page.locator('#article .cm-content').innerText();await page.locator('#article').click();await page.keyboard.type('Read only');assert.equal(await page.locator('#article .cm-content').innerText(),readText);
    assert(!((await page.locator('#article').innerText()).includes('@@')));
    await menuItem(page,'source-mode');assert.equal(await page.locator('#source-editor .cm-content').getAttribute('contenteditable'),'false');assert.match(await page.locator('#source-editor').innerText(),/"custom-type"/);
    await page.locator('#edit-mode').click();await page.locator('#source-editor .cm-content').click();await page.keyboard.press('Control+a');
    const longSource='# New heading\n\n[Warehouse](Systems/Warehouse.md "custom-type")\n\n'+Array.from({length:35},(_,i)=>'Paragraph '+i+' contains source text.').join('\n\n')+'\n\nTags: test, source.';
    await page.keyboard.insertText(longSource);await menuItem(page,'save');await page.waitForFunction(()=>document.getElementById('save-status').textContent==='Saved');const savedSource=await fs.readFile(path.join(root,'Systems/New_article_name.md'),'utf8');assert.equal(unstamped(savedSource),longSource);assert(stamped(savedSource),'saving in Source mode stamps the article');assert.match(await page.locator('#source-editor').innerText(),/updated_at: /,'Source mode shows the new timestamps');
    assert(await page.evaluate(()=>[document.getElementById('editor-left'),document.getElementById('note-panel')].some(e=>e.scrollHeight>e.clientHeight)));assert.equal(await page.locator('#source-editor').evaluate(e=>getComputedStyle(e).maxHeight),'none');assert.equal(await page.locator('#source-editor textarea:visible').count(),0);
    if(await page.locator('#view-graph').getAttribute('aria-pressed')!=='true') await page.locator('#view-graph').click();
    await page.locator('#source-editor .cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.press('Control+Home');
    await page.waitForFunction(()=>{const caret=document.querySelector('#source-editor .cm-cursor')?.getBoundingClientRect(),tabs=document.getElementById('tab-bar').getBoundingClientRect();return caret && caret.top>=tabs.bottom && caret.bottom<innerHeight-27;});
    await page.screenshot({path:path.join(output,'weave-desktop-source.png'),fullPage:true});
    await page.locator('#edit-mode').click();await menuItem(page,'source-mode');
    await page.locator('#new-tab').click();await page.locator('[data-tree-path="Overview.md"]').click();await page.waitForFunction(()=>document.getElementById('note-path').dataset.path==='Overview.md');await page.locator('#file-tabs [role="tab"]').first().click();await page.waitForFunction(()=>location.hash.includes('New_article_name'));
    const tabCount=await page.locator('#file-tabs [role="tab"]').count();await page.reload();await page.waitForFunction(()=>document.getElementById('note-path').dataset.path==='Systems/New_article_name.md');assert.equal(await page.locator('#file-tabs [role="tab"]').count(),tabCount);
    await page.locator('#close-tabs').click();await page.locator('#welcome').waitFor();assert(await page.locator('#graph-panel').isHidden());await page.reload();await page.locator('#tree .tree-row').first().waitFor();assert.equal(await page.locator('#file-tabs [role="tab"]').count(),0);assert(await page.locator('#welcome').isVisible());
    await page.locator('[data-tree-path="Overview.md"]').click();await page.locator('#view-graph').click();
    await page.getByRole('button',{name:'Search',exact:true}).click();await page.locator('#search-query').fill('ABC-901');await page.locator('#search-query').press('Enter');await page.locator('.evidence-card').first().waitFor();assert.match(await page.locator('#evidence').innerText(),/Warehouse/);assert.match(await page.locator('#evidence-notices').innerText(),/No generated answer/);assert.doesNotMatch(await page.locator('#evidence').innerText(),/Matched the question|Included through|@@/);
    await page.screenshot({path:path.join(output,'weave-desktop-evidence.png'),fullPage:true});
    const expandedCount=await page.locator('.evidence-card').count();await page.getByRole('button',{name:'Control panel',exact:true}).click();
    await page.waitForFunction(()=>document.getElementById('database-directory').textContent.length>0);
    assert.equal(await page.locator('#use-semantic,#embed,#download-model,#rebuild-qmd,#rebuild-graph').count(),0);
    await page.screenshot({path:path.join(output,'weave-desktop-controls.png'),fullPage:true});
    await page.locator('#use-connections').uncheck();await page.getByRole('button',{name:'Search',exact:true}).click();await page.locator('#search-query').press('Enter');await page.waitForFunction(count=>document.querySelectorAll('.evidence-card').length<count,expandedCount);assert.equal(await page.locator('.evidence-card').count(),1);
    await page.reload();await page.locator('#tree .tree-row').first().waitFor();assert.equal(await page.locator('#use-connections').isChecked(),false);
    await page.getByRole('button',{name:'Control panel',exact:true}).click();await page.locator('#use-connections').check();
    storageSelection=path.join(root,'.weave','..','..',path.basename(root)+'-data');await fs.mkdir(storageSelection);await page.locator('[data-storage="dataDirectory"]').click();
    await page.waitForFunction(()=>document.getElementById('message').textContent.includes('Restart Weave'));
    assert.equal((await service.controlPanel()).pendingDataDirectory,path.join(await fs.realpath(storageSelection),'.weave'));
    assert.equal((await service.call('searchKnowledge',{query:'ABC-901'})).results[0].method,'bm25');
    await page.locator('#message').evaluate(e=>e.textContent='');
    await page.getByRole('button',{name:'Files',exact:true}).click();await page.locator('#edit-mode').click();
    await page.locator('[data-tree-path="Systems"]').click();await page.locator('#files-panel').click({position:{x:80,y:500}});await page.locator('#new-note').click();
    assert.match(await page.locator('#prompt-description').innerText(),/Workspace root/);await page.locator('#prompt-value').fill('Root note');await page.locator('#prompt-ok').click();await page.waitForFunction(()=>document.getElementById('note-path').dataset.path==='Root note.md');
    const rootNote=await fs.readFile(path.join(root,'Root note.md'),'utf8');assert.equal(unstamped(rootNote),'---\ntype: Note\ntitle: Root note\n---\n# Root note\n\n');assert(stamped(rootNote),'new articles carry created_at and updated_at');
    await page.locator('[data-tree-path="Root note.md"]').click({button:'right'});assert.match(await page.locator('[data-file-action="rename"]').innerText(),/Rename file/);await page.locator('[data-file-action="move"]').click();await page.locator('#prompt-value').fill('Teams');await page.locator('#prompt-ok').click();await page.waitForFunction(()=>document.getElementById('note-path').dataset.path==='Teams/Root note.md');assert.equal(await page.locator('#prompt-dialog').isVisible(),false,'zero-link move has no link confirmation');
    await page.keyboard.press('Control+n');assert.equal(await page.locator('#prompt-title').innerText(),'New article');assert.equal(await page.locator('#prompt-value').inputValue(),'Untitled');assert.match(await page.locator('#prompt-description').innerText(),/Workspace root/);
    await page.locator('#prompt-value').fill('Shortcut article');await page.locator('#prompt-ok').click();await page.waitForFunction(()=>document.getElementById('note-path').dataset.path==='Shortcut article.md');assert.equal(unstamped(await fs.readFile(path.join(root,'Shortcut article.md'),'utf8')),'---\ntype: Note\ntitle: Shortcut article\n---\n# Shortcut article\n\n');
    await page.locator('[data-tree-path="Shortcut article.md"]').click({button:'right'});await page.locator('[data-file-action="rename"]').click();assert.equal(await page.locator('#prompt-value').inputValue(),'Shortcut article');await page.locator('#prompt-value').fill('Stable filename');await page.locator('#prompt-ok').click();await page.waitForFunction(()=>document.getElementById('note-path').dataset.path==='Stable filename.md');assert.equal(await page.locator('#prompt-dialog').isVisible(),false,'zero-link rename has no link confirmation');
    await page.locator('[data-tree-path="Stable filename.md"]').click({button:'right'});await page.locator('[data-file-action="retitle"]').click();await page.waitForFunction(()=>document.getElementById('prompt-dialog').open && document.getElementById('prompt-title').textContent==='Retitle Article');assert.equal(await page.locator('#prompt-value').inputValue(),'Shortcut article');await page.locator('#prompt-value').fill('A readable title');await page.locator('#prompt-ok').click();await page.waitForFunction(()=>document.querySelector('[data-tree-path="Stable filename.md"] .tree-name')?.textContent==='A readable title');assert.equal(unstamped(await fs.readFile(path.join(root,'Stable filename.md'),'utf8')),'---\ntype: Note\ntitle: A readable title\n---\n# A readable title\n\n');assert.equal(await page.locator('#note-path').getAttribute('data-path'),'Stable filename.md','retitling leaves filename unchanged');
    await page.locator('#collapse-panel').click();await page.locator('#article .cm-content').click();const wide=await page.locator('#article .cm-content').boundingBox();assert(wide.width>1350,'collapsed-sidebar editing uses nearly the whole window');await page.screenshot({path:path.join(output,'weave-desktop-wide-editor.png'),fullPage:true});await page.getByRole('button',{name:'Files',exact:true}).click();

  }
  await verifySidebars(page,output,mode);
  await verifyFolders(page,output,mode);
  if(desktop)await verifyTableIntegration(page,output,root);
  assert(await page.locator('#graph-panel').evaluate(e => !!(e.compareDocumentPosition(document.getElementById('note-panel')) & Node.DOCUMENT_POSITION_FOLLOWING)));
  const drag=await page.locator('#sidebar-resize').boundingBox(),sidebarBefore=(await page.locator('#sidebar').boundingBox()).width;await page.mouse.move(drag.x+2,drag.y+100);await page.mouse.down();
  // The sidebar follows the pointer below its minimum and collapses only on release.
  await page.mouse.move(drag.x-sidebarBefore+60,drag.y+100,{steps:4});const following=(await page.locator('#sidebar').boundingBox()).width;assert(following>0&&following<120,'the left sidebar follows the pointer: '+following);assert.equal(await page.locator('body').evaluate(e=>e.classList.contains('sidebar-collapsed')),false);
  await page.mouse.move(70,drag.y+100);await page.mouse.up();assert(await page.locator('body').evaluate(e=>e.classList.contains('sidebar-collapsed')));await page.getByRole('button',{name:'Files',exact:true}).click();assert.equal(await page.locator('body').evaluate(e=>e.classList.contains('sidebar-collapsed')),false);assert(Math.abs((await page.locator('#sidebar').boundingBox()).width-sidebarBefore)<2,'reopening restores the width before the drag');
  await page.setViewportSize({width:800,height:600});await page.screenshot({path:path.join(output,'weave-'+mode+'-compact.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'horizontal page overflow');
  assert.deepEqual(errors,[]);assert(requests.every(url=>url.startsWith('file:')||url.startsWith(server?.url||'file:')),'unexpected network request');
  console.log(mode+' browser verification passed: navigation, broken links, graph, search'+(desktop?', editing, rename rewriting, creation, Ask':'')+', compact layout, no external requests.');
}catch(error){console.error(await page.evaluate(()=>({path:document.getElementById('note-path').textContent,tabs:document.getElementById('file-tabs').textContent,message:document.getElementById('message').textContent})));await page.screenshot({path:path.join(output,'weave-'+mode+'-failure.png'),fullPage:true});throw error;}finally{await browser.close();await service?.close();await server?.close();await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});if(storageSelection)await fs.rm(storageSelection,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
