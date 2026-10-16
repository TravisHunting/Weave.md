import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {renderPage, ROOT} from './build.mjs';

import {launchBrowser, menuItem} from './test-browser.mjs';
const output = path.join(ROOT,'test-results'); await fs.mkdir(output,{recursive:true});
const text = '# Heading alignment\n\nBody text with `inline code` and ordinary words.\n\n' + 'A wrapped body line with text. '.repeat(13) + '\n\n```js\nconst code = 123;\n```\n\nFinal row.';
const fixture = path.join(output,'weave-article-layout-fixture.html');
await fs.writeFile(fixture,await renderPage({root:'Layout',folders:[],documents:[{path:'Overview.md',title:'Heading alignment',text}],graph:{entities:[{id:'Overview.md',file:'Overview.md',name:'Heading alignment'}],relationships:[]}}));
const browser = await launchBrowser();
const page = await browser.newPage({locale:'en-GB',viewport:{width:1200,height:1000}}), errors=[];
page.on('pageerror',error=>errors.push(error.message));
const settle = () => page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))));
const sizes = () => page.evaluate(()=>Object.fromEntries(['--reading-font-size','--code-font-size'].map(key=>[key,parseFloat(getComputedStyle(document.documentElement).getPropertyValue(key))])));
const checkNumbers = async (selector, kind) => {
  await settle();
  const measured = await page.locator(selector).evaluate(root => {
    const rows=[...root.querySelectorAll('.cm-line')], numbers=[...root.querySelectorAll('.source-line-number')];
    return rows.flatMap((row,index)=> {
      const number=numbers.find(node=>Number(node.dataset.sourceLine)===index+1);
      if(!number)return [];
      const walker=document.createTreeWalker(row,NodeFilter.SHOW_TEXT),range=document.createRange(); let node;
      while(walker.nextNode()) if(walker.currentNode.nodeValue.trim()){node=walker.currentNode;break;}
      if(!node)return [];
      range.selectNodeContents(node); const textRect=range.getClientRects()[0];
      if(!textRect?.height)return [];
      const numRange=document.createRange();numRange.selectNodeContents(number);const digit=numRange.getBoundingClientRect();
      const rootRect=root.getBoundingClientRect(),indent=parseFloat(getComputedStyle(root).paddingLeft);
      return [{line:index+1,code:row.classList.contains('md-code-line'),dy:Math.abs((digit.top+digit.bottom-textRect.top-textRect.bottom)/2),dx:Math.abs((digit.left+digit.right)/2-(rootRect.left+indent/2))}];
    });
  });
  assert(measured.length>=5,kind+' has enough measured source rows');
  if(selector==='#article') assert(measured.some(row=>row.code),kind+' measures a code row');
  for(const row of measured){assert(row.dy<1.25,`${kind} line ${row.line} vertical offset ${row.dy}`);assert(row.dx<1,`${kind} line ${row.line} horizontal offset ${row.dx}`);}
};
try {
  await page.goto(pathToFileURL(fixture).href);await page.locator('[data-tree-path="Overview.md"]').click();await page.locator('#article .md-h1').waitFor();
  const chrome=await page.evaluate(()=>({expectedFooter:parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--footer-height')),footer:document.querySelector('footer').getBoundingClientRect().height,divider:document.querySelector('.tab-bar-divider').getBoundingClientRect().width,shellBottom:document.querySelector('.shell').getBoundingClientRect().bottom,footerTop:document.querySelector('footer').getBoundingClientRect().top}));
  assert.equal(chrome.footer,chrome.expectedFooter);assert.equal(chrome.divider,1);assert.equal(chrome.shellBottom,chrome.footerTop,'workspace meets the compact status bar');
  await checkNumbers('#article','read');
  await page.locator('.rail [data-panel="appearance"]').click();
  await page.locator('#appearance-panel details').filter({has:page.locator('#reading-size')}).locator('summary').first().click();
  const range=async(id,value)=>page.locator('#'+id).evaluate((input,value)=>{input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));},value);
  await range('article-indent',96);await range('reading-size',20);
  await page.locator('#appearance-panel details').filter({has:page.locator('#code-size')}).locator('summary').first().click();
  await range('code-size',12);await checkNumbers('#article','custom fonts/indent');
  const before=await sizes();await page.locator('#article .md-h1').hover();await page.keyboard.down('Control');await page.mouse.wheel(0,-120);await page.keyboard.up('Control');await settle();
  const after=await sizes();assert.equal(after['--reading-font-size']/before['--reading-font-size'],1.1);assert(Math.abs(after['--code-font-size']/before['--code-font-size']-1.1)<.0001);
  await checkNumbers('#article','zoomed read');await page.screenshot({path:path.join(output,'weave-article-zoom-gutters.png'),fullPage:true});
  await page.mouse.wheel(0,120);assert.deepEqual(await sizes(),after,'plain wheel does not change fonts');
  await menuItem(page,'source-mode');await page.locator('#source-editor .cm-content').waitFor();await checkNumbers('#source-editor','source');
  await page.locator('#source-editor .cm-line').first().hover();await page.keyboard.down('Control');await page.mouse.wheel(0,120);await page.keyboard.up('Control');await settle();assert.deepEqual(await sizes(),before);
  await checkNumbers('#source-editor','zoomed source');await page.screenshot({path:path.join(output,'weave-source-centered-gutters.png'),fullPage:true});
  await page.reload();await page.locator('#source-editor .cm-content').waitFor();assert.deepEqual(await sizes(),before,'zoom and independent font sizes persist');
  assert.deepEqual(errors,[]);console.log('Verified article/source Ctrl+wheel zoom, independent base sizes, persistence, and vertically/horizontally centered line numbers.');
} finally {await browser.close();}
