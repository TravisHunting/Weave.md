import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {renderPage, readWorkspace, ROOT} from './build.mjs';

import {launchBrowser} from './test-browser.mjs';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'weave-graph-')), output = path.join(ROOT, 'test-results');
await fs.mkdir(output, {recursive:true});
await fs.mkdir(path.join(root, 'Systems'));
const names = Array.from({length:27}, (_, i) => `System ${String(i + 1).padStart(2, '0')}`);
await Promise.all(names.map(name => fs.writeFile(path.join(root, 'Systems', name + '.md'), `# ${name}\n\nConnected system.\n`)));
await fs.mkdir(path.join(root, 'Deep'));
await fs.appendFile(path.join(root,'Systems',names[0]+'.md'),'\n[Layer2](Deep/Layer2.md)\n');
await fs.writeFile(path.join(root,'Deep','Layer2.md'),'# Second layer\n\n[Layer3](Deep/Layer3.md)\n');
await fs.writeFile(path.join(root,'Deep','Layer3.md'),'# Third layer\n');
await fs.writeFile(path.join(root, 'Overview.md'), '# Graph workspace\n\n' + names.map(name => `[${name}](<Systems/${name}.md> "depends-on")`).join('\n\n') + '\n\n' + Array.from({length:30}, (_, i) => `Reading paragraph ${i + 1}. This article stays comfortable to read with a large graph above it.`).join('\n\n'));
await fs.appendFile(path.join(root,'Overview.md'),'\n\n[System 01](<Systems/System 01.md> "writes-to")\n\n[System 01](<Systems/System 01.md>)\n');
await fs.appendFile(path.join(root,'Systems',names[0]+'.md'),'\n[Overview](Overview.md "hosted-in")\n');
const file = path.join(output, 'weave-graph-fixture.html');
const fixture=await readWorkspace(root);
await fs.writeFile(file, await renderPage(fixture));
const browser = await launchBrowser();
const page = await browser.newPage({locale:'en-GB',viewport:{width:1500, height:1000}}), errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(pathToFileURL(file).href);
  await page.locator('[data-tree-path="Overview.md"]').click();
  await page.locator('#view-graph').click();
  await page.locator('#graph-nodes [data-node]').first().waitFor();
  assert.equal(await page.locator('#graph-edges-svg path.graph-edge').count(),27,'each connected pair has one visible arrow');
  const firstAuthored=fixture.graph.relationships.find(edge=>edge.from==='Overview.md'&&edge.to==='Systems/System 01.md'&&edge.type==='depends-on');
  assert.equal(await page.locator('#graph-edges-svg path.graph-edge').evaluateAll((paths,id)=>paths.filter(path=>path.parentElement.dataset.edge===id).length,firstAuthored.id),1,'the first named relationship in the current article supplies the arrow');
  await page.locator('#graph-nodes [data-node="Systems/System 01.md"]').evaluate(node=>node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})));
  await page.waitForFunction(()=>document.getElementById('graph-panel').dataset.graphComplete==='true'&&document.querySelectorAll('#graph-nodes [data-node]').length===3);
  const reverseAuthored=fixture.graph.relationships.find(edge=>edge.from==='Systems/System 01.md'&&edge.to==='Overview.md'&&edge.type==='hosted-in');
  assert.equal(await page.locator('#graph-edges-svg path.graph-edge').evaluateAll((paths,id)=>paths.filter(path=>path.parentElement.dataset.edge===id).length,reverseAuthored.id),1,'navigating to the opposite article selects its named relationship and direction');
  await page.locator('[data-tree-path="Overview.md"]').click();
  await page.waitForFunction(()=>document.getElementById('graph-panel').dataset.graphComplete==='true'&&document.querySelectorAll('#graph-nodes [data-node]').length===28);
  await page.screenshot({path:path.join(output,'weave-graph-controls.png')});
  const positions=()=>page.locator('#graph-nodes [data-node]').evaluateAll(nodes=>Object.fromEntries(nodes.map(node=>{const matrix=node.transform.baseVal.getItem(0).matrix;return [node.dataset.node,{x:matrix.e,y:matrix.f}];})));
  const originalPositions=await positions();
  // Node spacing is an optional control (Visual styling > Graph controls).
  await page.evaluate(() => {document.documentElement.dataset.graphSpacing = 'true';});
  await page.locator('#graph-spacing').fill('200');await page.locator('#graph-spacing').dispatchEvent('input');
  const spaced=await positions();
  for(const id of Object.keys(spaced))assert.deepEqual(spaced[id],{x:originalPositions[id].x*2,y:originalPositions[id].y*2},'spacing doubles distances without moving the center');
  await page.locator('#graph-shuffle').click();const shuffled=await positions();
  assert.deepEqual(shuffled['Overview.md'],{x:0,y:0});assert.notDeepEqual(shuffled,spaced);
  assert.deepEqual(Object.keys(shuffled).sort(),Object.keys(spaced).sort(),'shuffle keeps every node');
  await page.screenshot({path:path.join(output,'weave-graph-shuffled.png')});
  await page.locator('#graph-spacing').fill('100');await page.locator('#graph-spacing').dispatchEvent('input');
  const contracted=await positions();for(const id of Object.keys(contracted))assert.deepEqual(contracted[id],{x:shuffled[id].x/2,y:shuffled[id].y/2},'changing spacing preserves the shuffled arrangement');
  await page.locator('#graph-fit').click();
  for (const direction of ['both','downstream']) {
    await page.locator('#graph-direction').selectOption(direction, {force:true});
    await page.waitForFunction(() => document.getElementById('graph-panel').dataset.graphComplete === 'true');
    const counts = await page.locator('#graph-nodes [data-node]').evaluateAll(nodes => {
      const columns = {};
      for (const node of nodes) {
        const x = node.transform.baseVal.getItem(0).matrix.e;
        columns[x] = (columns[x] || 0) + 1;
      }
      return Object.values(columns);
    });
    assert.equal(counts.reduce((a,b) => a + b), 28);
    assert(counts.every(count => count <= 5), direction + ' graph columns contain at most five nodes');
  }
  // One bar separates graph and article: the graph's own lower edge.
  const bars = () => page.evaluate(() => [...document.querySelectorAll('#editor-left [role=separator][aria-orientation=horizontal]')].filter(e => e.getBoundingClientRect().height > 0).map(e => e.id));
  assert.deepEqual(await bars(), ['graph-resize'], 'one bar separates the graph from the article');
  let grip = await page.locator('#graph-resize').boundingBox();
  const panelTop = (await page.locator('#graph-panel').boundingBox()).y;
  await page.mouse.move(grip.x + 100, grip.y + 4);await page.mouse.down();
  await page.mouse.move(grip.x + 100, panelTop + 64, {steps:10});
  assert(Math.abs((await page.locator('#graph-panel').boundingBox()).height-64)<10,'the divider follows the pointer without a minimum-height jump');
  await page.mouse.move(grip.x + 100, panelTop + 94, {steps:4});await page.mouse.up();
  assert(Math.abs((await page.locator('#graph-panel').boundingBox()).height-94)<10,'the graph keeps the small height it was dragged to');
  grip = await page.locator('#graph-resize').boundingBox();
  await page.mouse.move(grip.x + 100, grip.y + 4);await page.mouse.down();
  await page.mouse.move(grip.x + 100, grip.y - 900, {steps:12});await page.mouse.up();
  assert(await page.locator('#graph-panel').isHidden(), 'dragging the bar nearly shut hides the graph');
  for (const id of ['view-graph','toggle-graph']) assert.equal(await page.locator('#' + id).getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#view-article').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await bars(), [], 'a hidden graph leaves no bar behind');
  assert.equal(await page.locator('#graph-restore').count(), 0, 'there is no separate restore strip');
  await page.screenshot({path:path.join(output,'weave-graph-minimized.png')});
  await page.locator('#view-graph').click();
  assert(await page.locator('#graph-panel').isVisible(), 'the Graph button shows the graph again');
  assert.equal(await page.locator('#view-graph').getAttribute('aria-pressed'), 'true');
  assert(Math.abs((await page.locator('#graph-panel').boundingBox()).height-94)<10, 'the graph reopens at its last height');
  assert.deepEqual(await bars(), ['graph-resize']);
  grip = await page.locator('#graph-resize').boundingBox();
  await page.mouse.move(grip.x + 100, grip.y + 4);await page.mouse.down();
  await page.mouse.move(grip.x + 100, grip.y + 260, {steps:12});await page.mouse.up();
  assert((await page.locator('#graph-panel').boundingBox()).height > 300, 'dragging the bar down enlarges the graph');
  assert.equal(await page.locator('.graph-bar').count(),0,'old controls bar is removed');
  assert(await page.locator('.graph-controls').isVisible(),'graph controls are always visible');
  await page.locator('#graph-depth').selectOption('3');
  await page.waitForFunction(() => document.getElementById('graph-panel').dataset.graphComplete === 'true' && document.querySelectorAll('#graph-nodes [data-node]').length === 30);
  assert.equal(await page.locator('#graph-panel').getAttribute('data-rendered-depth'),'3','depth chunks finish in order');
  await page.locator('#graph-depth').selectOption('1');
  await page.waitForFunction(() => document.getElementById('graph-panel').dataset.graphComplete === 'true' && document.querySelectorAll('#graph-nodes [data-node]').length === 28);
  await page.locator('#graph-resize').evaluate(element => element.focus({preventScroll:true}));
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowDown');
  const expanded = await page.locator('#graph-panel').boundingBox();
  assert(expanded.height > 850, 'graph can grow without a viewport-height clamp');
  const reading = await page.locator('#note-panel').boundingBox();
  assert(reading.height > 800, 'expanded graph preserves a useful article area');
  await page.locator('#editor-left').evaluate(element => element.scrollTop = 0);
  const graph = await page.locator('#graph').boundingBox();
  await page.mouse.move(graph.x + graph.width / 2, graph.y + 100);
  const zoom = await page.locator('#zoom-label').innerText();
  await page.mouse.wheel(0, -180);
  await page.waitForFunction(previous => document.getElementById('zoom-label').textContent !== previous, zoom);
  assert.equal(await page.locator('#editor-left').evaluate(element => element.scrollTop), 0, 'ordinary wheel zooms graph without scrolling page');
  const zoomed = await page.locator('#zoom-label').innerText();
  await page.screenshot({path:path.join(output, 'weave-graph-expanded.png')});
  const scrollport=page.locator('#graph-scrollport');
  assert.equal(await scrollport.evaluate(node=>getComputedStyle(node).overflowX),'hidden','no graph horizontal scrollbar');
  await page.locator('#zoom-in').evaluate(button=>{for(let i=0;i<6;i++)button.click();});
  const transform=await page.locator('#graph-viewport').getAttribute('transform');
  await scrollport.evaluate(element=>{element.scrollTop=element.scrollHeight;element.scrollLeft=element.scrollWidth;});
  await page.waitForFunction(previous=>document.getElementById('graph-viewport').getAttribute('transform')!==previous,transform);
  assert.equal(await page.locator('#editor-left').evaluate(element=>element.scrollTop),0,'graph scrollbar pans only graph');
  // The far-right scrollbar is independent and still reveals the article when
  // the enlarged graph fills the viewport.
  await page.locator('#editor-left').evaluate(element=>element.scrollTop=1100);
  await page.waitForFunction(() => document.getElementById('editor-left').scrollTop > 850);
  const tab = await page.locator('#tab-bar').boundingBox();
  assert((await page.locator('#graph-panel').boundingBox()).y + expanded.height <= tab.y + tab.height, 'graph scrolls fully out of the article viewport');
  await page.screenshot({path:path.join(output, 'weave-graph-scrolled-to-article.png')});
  // Scrolling over article text continues the same outer surface.
  const before = await page.locator('#editor-left').evaluate(element => element.scrollTop);
  await page.mouse.move(reading.x + 150, 400);await page.mouse.wheel(0, 250);
  await page.waitForFunction(value => document.getElementById('editor-left').scrollTop > value, before);
  const articleScroll = await page.evaluate(() => Math.max(0, document.getElementById('editor-left').scrollTop - document.getElementById('graph-panel').getBoundingClientRect().height));
  await page.locator('#graph-resize').evaluate(element => element.focus({preventScroll:true}));
  await page.keyboard.press('Home');
  assert(await page.locator('#graph-panel').isHidden(), 'keyboard close uses the same graph state');
  assert.equal(await page.locator('#view-graph').getAttribute('aria-pressed'), 'false');
  assert(Math.abs(await page.locator('#note-panel').evaluate(element => element.scrollTop) - articleScroll) < 2, 'closing graph preserves the article reading position');
  assert.deepEqual(errors, []);
  console.log('Graph browser verification passed: depth chunks, short columns, one bar that hides and reopens the graph, floating controls, independent scrollbars, article scrolling and wheel zoom.');
} finally {
  await browser.close();
  await fs.rm(root, {recursive:true, force:true});
}
