import assert from 'node:assert/strict';
import {menuItem} from './test-browser.mjs';
import path from 'node:path';
import {schemes,colorFields,skins} from './appearance.mjs';
import {skinChain} from './skins.mjs';

export async function ensureAppearanceSection(page,id) {
  if(!await page.locator('#'+id).evaluate(section=>section.open)) await page.locator('#'+id+' > summary').click();
}

// The title-bar row: where the focused strip sits and where the controls are.
const titleRow = page => page.evaluate(async () => {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const box = element => element.getBoundingClientRect(), q = selector => document.querySelector(selector);
  const bar = q('#editor-left .tab-bar'), items = [...bar.querySelectorAll('.file-tab, button')].filter(element => box(element).width);
  return {mode: document.documentElement.dataset.titlebarTabs, barTop: box(bar).top, barHeight: box(bar).height, titleBottom: box(q('#titlebar')).bottom,
    first: Math.min(...items.map(element => box(element).left)), last: Math.max(...items.map(element => box(element).right)),
    start: box(q('.titlebar-start')).right, end: box(q('.titlebar-end')).left,
    rightTop: q('#right-sidebar').hidden ? null : box(q('#right-sidebar')).top};
});
const clearOfControls = (row, label) => {
  assert(row.first >= row.start - .5 && row.last <= row.end + .5, label + ': tabs stay clear of the title bar controls ' + JSON.stringify(row));
  if (row.mode === 'true' && row.rightTop !== null) assert(row.rightTop >= row.titleBottom - .5, label + ': the right sidebar starts below the title-bar row ' + JSON.stringify(row));
};

// Tabs share the title-bar row by default; the menu holds the other actions; the
// Tabs setting brings back the separate title bar.
export async function verifyTitlebarTabs(page) {
  let row = await titleRow(page);
  assert.equal(row.mode, 'true', 'tabs are in the title bar by default');
  assert.equal(row.barTop, 0, 'the tab strip is the top row');assert.equal(row.barHeight, row.titleBottom, 'tab strip and title bar share one row');
  clearOfControls(row, 'sidebar open');
  await page.getByRole('button',{name:'Files',exact:true}).click();
  clearOfControls(await titleRow(page), 'sidebar collapsed');
  await page.getByRole('button',{name:'Files',exact:true}).click();
  await page.locator('#app-menu-button').click();
  assert(await page.locator('#app-menu').isVisible());assert.equal(await page.locator('#app-menu-button').getAttribute('aria-expanded'),'true');
  assert(await page.locator('#app-menu').evaluate(menu => menu.contains(document.activeElement)), 'the menu takes focus');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  assert(await page.locator('#app-menu').isHidden());assert(await page.locator('#app-menu-button').evaluate(button => button === document.activeElement), 'Escape returns focus to the menu button');
  assert.deepEqual(await page.locator('#titlebar .titlebar-end > button:visible').evaluateAll(buttons => buttons.map(button => button.id)), ['view-graph','toggle-right-sidebar','edit-mode','source-toggle'], 'the title bar keeps only Graph, the right sidebar, Edit and Source');
  if (!await page.locator('#source-toggle').isDisabled()) {
    await page.locator('#source-toggle').click();
    assert.equal(await page.locator('#source-mode').getAttribute('aria-pressed'), 'true', 'the Source pill shows the source');assert(await page.locator('#source-editor').isVisible());
    await page.locator('#source-toggle').click();
    assert.equal(await page.locator('#source-toggle').getAttribute('aria-pressed'), 'false');assert(await page.locator('#source-editor').isHidden());
  }
  await page.getByRole('button',{name:'Visual styling',exact:true}).click();
  await ensureAppearanceSection(page,'appearance-tabs');
  await page.locator('#titlebar-tabs').uncheck();
  row = await titleRow(page);
  assert.equal(row.mode, 'false');assert(row.barTop >= row.titleBottom - .5, 'with the option off the tab strip sits below the title bar');
  await page.locator('#titlebar-tabs').check();
  assert.equal((await titleRow(page)).barTop, 0);
  await page.getByRole('button',{name:'Files',exact:true}).click();
}

// Every skin keeps the colour scheme, fills the window exactly (title bar and
// status bar at their contract heights, no overflow) and survives scheme changes.
export async function verifySkins(page,output,mode) {
  await page.getByRole('button',{name:'Visual styling',exact:true}).click();
  await ensureAppearanceSection(page,'appearance-skin');
  const skinOf = async () => (await page.locator('html').getAttribute('data-skin')).split(' ').at(-1);
  assert.equal(await skinOf(),'aurora-flow');
  assert(await page.locator('#skin-aurora-flow').isChecked());
  const token = name => page.evaluate(name=>getComputedStyle(document.documentElement).getPropertyValue(name).trim(),name);
  const accent = await token('--accent');
  // The right sidebar is open while skins are checked: it shares the row's controls.
  const rightWasOpen = await page.locator('#toggle-right-sidebar').getAttribute('aria-pressed') === 'true';
  if (!rightWasOpen) await page.locator('#toggle-right-sidebar').click();
  for (const id of Object.keys(skins)) {
    await page.locator(`label[for="skin-${id}"]`).click();
    assert.equal(await skinOf(),id);
    assert.equal(await page.locator('html').getAttribute('data-skin'),skinChain(id).join(' '));
    assert(await page.locator('#skin-'+id).isChecked());
    assert.equal(await token('--accent'),accent,id+' keeps the colour scheme');
    const layout = await page.evaluate(() => {
      const box = selector => document.querySelector(selector).getBoundingClientRect(), root = getComputedStyle(document.documentElement);
      return {titlebar:box('#titlebar').height,footer:box('footer').height,shellBottom:box('.shell').bottom,footerTop:box('footer').top,
        wantTitle:parseFloat(root.getPropertyValue('--titlebar-height')),wantFooter:parseFloat(root.getPropertyValue('--footer-height')),
        overflow:document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight};
    });
    assert.equal(layout.titlebar,layout.wantTitle,id+' title bar height');assert.equal(layout.footer,layout.wantFooter,id+' status bar height');
    assert(Math.abs(layout.shellBottom-layout.footerTop)<0.5,id+' workspace meets the status bar');assert(!layout.overflow,id+' fits the window');
    clearOfControls(await titleRow(page), id);
    if (output) await page.screenshot({path:path.join(output,`weave-${mode}-skin-${id}.png`)});
  }
  if (!rightWasOpen) await page.locator('#toggle-right-sidebar').click();
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('weave:appearance')).skin),Object.keys(skins).at(-1),'the chosen skin is remembered');
  await page.locator('label[for="skin-studio"]').click();
  await ensureAppearanceSection(page,'appearance-colours');
  await page.locator('#appearance-scheme').selectOption('ocean');assert.equal(await skinOf(),'studio','changing scheme keeps the skin');
  await page.locator('#theme').click();assert.equal(await skinOf(),'studio','switching light and dark keeps the skin');
  await page.locator('label[for="skin-classic"]').click();await page.locator('#appearance-scheme').selectOption('grey');
  assert.equal(await skinOf(),'classic');
  await page.getByRole('button',{name:'Files',exact:true}).click();
}

export async function verifyAppearance(page,output,mode) {
  assert.equal(await page.locator('html').getAttribute('data-scheme'),'lavender');
  await verifyTitlebarTabs(page);
  await verifySkins(page,output,mode);
  await page.getByRole('button',{name:'Visual styling',exact:true}).click();
  assert.equal(await page.locator('#code-font').inputValue(),'cascadiaMono');
  assert.equal(await page.locator('#line-number-opacity').inputValue(),'50');assert.equal(await page.locator('#table-border-width').inputValue(),'2');assert(await page.locator('#table-striped').isChecked());
  await ensureAppearanceSection(page,'appearance-colours');
  const color = async key => page.evaluate(key=>getComputedStyle(document.documentElement).getPropertyValue('--'+key).trim(),key);
  for(const [preset,scheme] of Object.entries(schemes)) {
    await page.locator('#appearance-scheme').selectOption(preset);
    assert.equal(await page.locator('html').getAttribute('data-theme'),scheme.mode);
    for(const [i,key] of Object.keys(colorFields).entries()) assert.equal(await color(key),scheme.colors[i]);
  }
  await page.locator('#appearance-scheme').selectOption('grey');
  await page.locator('.appearance-colors summary').click();
  for(const key of Object.keys(colorFields)) {
    if(key==='tableBorder') await ensureAppearanceSection(page,'appearance-tables');
    await page.locator('#color-'+key).fill('#647382');
    assert.equal(await color(key),'#647382');
  }
  await page.locator('#reset-colors').click();
  assert.equal(await color('ink'),schemes.grey.colors[2]);
  await page.locator('#color-accent').fill('#654b89');
  await page.locator('#color-titleBar').fill('#dce5ea');assert.equal(await color('titleBar'),'#dce5ea');
  await ensureAppearanceSection(page,'appearance-tabs');await page.locator('#titlebar-tabs').uncheck();
  assert.equal(await page.locator('#titlebar').evaluate(element=>getComputedStyle(element).backgroundColor),'rgb(220, 229, 234)');
  await page.locator('#titlebar-tabs').check();
  await page.locator('#color-tableBorder').fill('#8c6879');assert.equal(await color('tableBorder'),'#8c6879');assert.equal(await color('line'),schemes.grey.colors[4]);
  await page.locator('.appearance-colors summary').click();
  await page.locator('#scheme-name').fill('Evening notes'); await page.getByRole('button',{name:'Save colour scheme',exact:true}).click();
  assert.equal(await page.locator('#scheme-name').getAttribute('placeholder'),'Theme name');
  const setAccent=value=>page.locator('#color-accent').evaluate((input,value)=>{input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));},value);
  await page.locator('#scheme-name').fill('');await page.locator('#scheme-name').blur();await setAccent('#654b8a');
  assert.equal(await page.locator('#scheme-name').inputValue(),'Evening notes','editing a custom theme keeps its name ready to save');
  await setAccent('#654b89');
  assert.equal(await page.locator('#appearance-scheme').inputValue(),'saved:0');
  await page.locator('#appearance-scheme').selectOption('ocean'); assert.equal(await color('accent'),schemes.ocean.colors[5]);
  await page.locator('#appearance-scheme').selectOption({label:'Evening notes'}); assert.equal(await color('accent'),'#654b89');
  const range = async (id,value) => page.locator('#'+id).fill(String(value));
  await ensureAppearanceSection(page,'appearance-reading');
  assert.equal(await page.locator('#reading-height').inputValue(),'1.7');
  assert.equal(await page.locator('#reading-gap').inputValue(),'0');
  const stroke=async weight=>{await range('reading-weight',weight);return parseFloat(await page.locator('#article').evaluate(node=>getComputedStyle(node).webkitTextStrokeWidth));};
  const strokes=[];for(const weight of [400,430,460,490])strokes.push(await stroke(weight));
  assert(strokes[1]>strokes[0]&&strokes[2]>strokes[1]&&strokes[3]>strokes[2],'prose weight changes visibly between static font faces: '+strokes);
  assert.equal(await page.evaluate(()=>{const code=document.querySelector('#article :is(code,.md-code,.md-code-line)');return code?getComputedStyle(code).webkitTextStrokeWidth:'0px';}),'0px','code keeps its own variable-font weight');
  await range('reading-weight',550);assert.equal(await page.locator('#article').evaluate(node=>getComputedStyle(node).fontWeight),'550');
  await range('reading-size',20); await range('reading-height',1.8); await range('reading-gap',.8);
  await page.locator('#reading-font').selectOption('serif');await page.locator('#reading-limit').check();await range('reading-width',720);
  assert(await page.locator('#reading-font option').count()>=10);assert(await page.locator('#code-font option').count()>=6);
  await ensureAppearanceSection(page,'appearance-code');
  await page.locator('#code-font').selectOption('courier');assert.match(await color('code-font-family'),/Courier New/);
  await range('code-size',13);assert.equal(await color('code-font-size'),'13px');
  await range('code-spacing',-.3);assert.equal(await color('code-line-height'),'1.5');
  await range('reading-height',2);assert.equal(await color('code-line-height'),'1.7');
  await range('code-spacing',.2);assert.equal(await color('code-line-height'),'2.2');
  await range('code-spacing',0);await range('reading-height',1.8);
  await range('article-zoom',150);assert.equal(await color('reading-font-size'),'30px');assert.equal(await color('code-font-size'),'19.5px');
  assert.equal(await page.locator('#reading-size').inputValue(),'20');assert.equal(await page.locator('#code-size').inputValue(),'13');
  await page.locator('#reset-article-zoom').click();assert.equal(await color('reading-font-size'),'20px');assert.equal(await color('code-font-size'),'13px');
  await range('article-indent',80);assert.equal(await color('article-indent'),'80px');
  await ensureAppearanceSection(page,'appearance-lines');
  for(const value of ['read','edit','both']) {await page.locator('#line-numbers').selectOption(value);assert.equal(await page.locator('html').getAttribute('data-line-numbers'),value);}
  await page.locator('#line-number-color').fill('#2468ab');await range('line-number-opacity',35);
  assert.equal(await color('line-number-color'),'#2468ab');assert.equal(await color('line-number-opacity'),'0.35');
  await range('line-number-size',14);assert.equal(await color('line-number-size'),'14px');assert.equal(await page.locator('#line-number-size-value').innerText(),'14 px');
  await ensureAppearanceSection(page,'appearance-tables');
  assert.equal(await page.locator('#table-editing').inputValue(),'visual');assert(await page.locator('#table-auto-format').isChecked());assert(await page.locator('#table-hover-controls').isChecked());
  await page.locator('#table-editing').selectOption('source');await page.locator('#table-auto-format').uncheck();await page.locator('#table-hover-controls').uncheck();
  assert.equal(await page.locator('html').getAttribute('data-table-editing'),'source');assert.equal(await page.locator('html').getAttribute('data-table-auto-format'),'false');assert.equal(await page.locator('html').getAttribute('data-table-hover-controls'),'false');
  await range('table-padding',5);await page.locator('#table-borders').selectOption('rows');await range('table-border-width',2);await range('table-header-tint',65);await page.locator('#table-striped').check();
  assert.equal(await color('table-cell-padding'),'5px');assert.equal(await color('table-border-width'),'2px');assert.equal(await color('table-header-tint'),'65%');
  if(await page.locator('#article .chat-table').count()) {
    const table=await page.locator('#article .chat-table').first().evaluate(element=>{const cell=element.querySelector('th'),style=getComputedStyle(cell),rows=[...element.querySelectorAll('tbody tr td:first-child')].map(cell=>getComputedStyle(cell).backgroundColor);return {padding:style.paddingTop,border:style.borderBottomWidth,color:style.borderBottomColor,right:style.borderRightWidth,rows};});
    assert.equal(table.padding,'5px');assert.equal(table.border,'2px');assert.equal(table.color,'rgb(140, 104, 121)');assert.equal(table.right,'0px');assert.notEqual(table.rows[0],table.rows[1]);
  }
  const metrics = async selector => page.locator(selector).first().evaluate(element=>{const style=getComputedStyle(element);return {size:style.fontSize,line:style.lineHeight,font:style.fontFamily,max:style.maxWidth};});
  const reading=await metrics('#article');assert.equal(reading.size,'20px');assert.equal(reading.line,'36px');assert.match(reading.font,/Georgia/);assert.equal(reading.max,'720px');
  assert.equal(await page.locator('#article .cm-line:not(.md-heading,.md-code-line,.md-table-line)').first().evaluate(e=>getComputedStyle(e).paddingBottom),'16px');
  if(mode==='desktop') {
    await page.locator('#edit-mode').click();
    const editing=await metrics('#article .cm-line:not(.md-heading)');assert.equal(editing.size,'20px');assert.equal(editing.line,'36px');assert.match(editing.font,/Georgia/);
    await menuItem(page,'source-mode');assert.equal((await metrics('#source-editor .cm-line')).size,'13px');assert.match((await metrics('#source-editor .cm-line')).font,/Courier New/);
    await menuItem(page,'source-mode');await page.locator('#edit-mode').click();
  }
  await page.screenshot({path:path.join(output,'weave-'+mode+'-appearance.png'),fullPage:true});
  await page.reload();await page.locator('[data-tree-path="Overview.md"]').waitFor();
  await page.locator('[data-tree-path="Overview.md"]').click();await page.locator('#article :is(h1,.md-h1)').waitFor();
  await page.getByRole('button',{name:'Visual styling',exact:true}).click();
  assert.equal(await page.locator('#appearance-panel > details[open]').count(),0,'appearance sections start collapsed after reloading');
  assert.equal(await color('accent'),'#654b89');assert.equal(await page.locator('#reading-size').inputValue(),'20');assert.equal((await metrics('#article')).max,'720px');
  assert.equal(await page.locator('#code-font').inputValue(),'courier');assert.match(await color('code-font-family'),/Courier New/);
  assert.equal(await page.locator('#code-size').inputValue(),'13');assert.equal(await color('code-font-size'),'13px');
  assert.equal(await page.locator('#line-numbers').inputValue(),'both');assert.equal(await color('line-number-color'),'#2468ab');assert.equal(await color('line-number-opacity'),'0.35');
  assert.equal(await page.locator('#table-padding').inputValue(),'5');assert.equal(await page.locator('#table-borders').inputValue(),'rows');assert(await page.locator('#table-striped').isChecked());
  assert.equal(await color('article-indent'),'80px');assert.equal(await color('tableBorder'),'#8c6879');assert.equal(await color('titleBar'),'#dce5ea');assert.equal(await page.locator('#table-editing').inputValue(),'source');assert.equal(await page.locator('#table-auto-format').isChecked(),false);assert.equal(await page.locator('#table-hover-controls').isChecked(),false);
  assert.equal(await page.locator('#appearance-scheme').inputValue(),'saved:0');
  await page.locator('#theme').click();assert.equal(await page.locator('#appearance-scheme').inputValue(),'graphite');assert.equal((await metrics('#article')).size,'20px');
  await page.screenshot({path:path.join(output,'weave-'+mode+'-appearance-dark.png'),fullPage:true});
  await ensureAppearanceSection(page,'appearance-colours');
  await page.locator('#appearance-scheme').selectOption({label:'Evening notes'});assert.equal(await color('accent'),'#654b89');assert.equal((await metrics('#article')).size,'20px');
  await page.locator('#reset-appearance').click();assert.equal(await page.locator('html').getAttribute('data-scheme'),'lavender');assert.equal((await page.locator('html').getAttribute('data-skin')).split(' ').at(-1),'aurora-flow');assert.equal((await metrics('#article')).size,'15px');assert.equal((await metrics('#article')).max,'none');
  assert.equal(await page.locator('#saved-schemes option').count(),1,'restoring appearance defaults retains saved schemes');
  assert.equal(await page.locator('#reading-width').isDisabled(),true);
  assert.equal(await page.locator('#code-font').inputValue(),'cascadiaMono');assert.equal(await color('code-font-size'),'15px');assert.equal(await page.locator('#line-numbers').inputValue(),'both');assert.equal(await page.locator('#table-borders').inputValue(),'grid');
  assert.equal(await color('article-indent'),'40px');assert.equal(await color('line-number-opacity'),'0.5');assert.equal(await color('table-border-width'),'2px');assert(await page.locator('#table-striped').isChecked());assert.equal(await page.locator('#table-editing').inputValue(),'visual');assert(await page.locator('#table-auto-format').isChecked());assert(await page.locator('#table-hover-controls').isChecked());
  await page.locator('#open-settings').click();
  await page.locator('#settings-categories .settings-nav-item').filter({hasText:'Colours and Themes'}).click();
  await page.locator('#settings-content .appearance-colors summary').click();
  assert(await page.locator('#settings-content #color-titleBar').isVisible());
  await page.locator('#color-titleBar').fill('#aabbcc');
  await page.locator('#settings-categories .settings-nav-item').filter({hasText:'Tables'}).click();
  assert(await page.locator('#settings-content #color-tableBorder').isVisible());
  await page.locator('#color-tableBorder').fill('#445566');
  await page.locator('.settings-close').click();
  assert.equal(await page.locator('#appearance-panel #color-titleBar').inputValue(),'#aabbcc');
  assert.equal(await page.locator('#appearance-panel #color-tableBorder').inputValue(),'#445566');
  assert.equal(await color('titleBar'),'#aabbcc');assert.equal(await color('tableBorder'),'#445566');
  await page.getByRole('button',{name:'Files',exact:true}).click();
}

// Focused appearance coverage uses an ordinary offline reader containing real
// Markdown code and tables, without requiring desktop/indexing fixtures.
if(process.argv.includes('--focused')) {
  const [{default:fs},{default:os},{pathToFileURL},{renderPage,readWorkspace,ROOT}] = await Promise.all([import('node:fs/promises'),import('node:os'),import('node:url'),import('./build.mjs')]);
  const {launchBrowser}=await import('./test-browser.mjs');
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'weave-appearance-')),output=path.join(ROOT,'test-results');
  const browser=await launchBrowser(),page=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  try {
    await fs.mkdir(output,{recursive:true});
    await fs.writeFile(path.join(temporary,'Overview.md'),'# Appearance preview\n\nReadable prose stays independent from code typography.\n\n```js\nconst article = "Weave";\nconsole.log(article);\n```\n\n| Setting | Choice |\n| --- | --- |\n| Font | Cascadia Mono |\n| Borders | Horizontal |\n| Rows | Alternating |\n');
    const file=path.join(output,'weave-appearance-fixture.html');await fs.writeFile(file,await renderPage(await readWorkspace(temporary)));await page.goto(pathToFileURL(file).href);
    await page.locator('[data-tree-path="Overview.md"]').click();await page.locator('#article .md-h1').waitFor();
    assert.equal(await page.locator('#appearance-panel > details').count(),10);assert.equal(await page.locator('#appearance-panel > details[open]').count(),0);
    await verifyAppearance(page,output,'standalone');assert.deepEqual(errors,[]);
    console.log('Verified independent code typography, line-number controls, styled tables, theme compatibility, persistence and restoring defaults.');
  } catch(error) {await page.screenshot({path:path.join(output,'weave-appearance-failure.png')}).catch(()=>{});if(errors.length)console.error(errors);throw error;}
  finally {await browser.close();await fs.rm(temporary,{recursive:true,force:true});}
}
