// Regenerates the README screenshots in docs/images from the read-only dynamic
// preview of knowledge-example: node scripts/readme-screenshots.mjs [name]
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createServer} from '../app/weave/server.mjs';
import {launchBrowser} from '../app/weave/test-browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs/images');
const shots = [
  {name: 'aurora-flow-lavender', skin: 'aurora-flow', preset: 'lavender', file: 'projects/customer-360.md', graph: true},
  {name: 'aurora-flow-graphite', skin: 'aurora-flow', preset: 'graphite', file: 'data-warehouse/mart-sales-daily.md', graph: true},
  {name: 'editorial-paper', skin: 'editorial', preset: 'paper', file: 'guides/nightly-warehouse-refresh.md'},
  {name: 'compact-ocean', skin: 'compact', preset: 'ocean', file: 'data-warehouse/fact-orders.md', graph: true},
  {name: 'studio-flow-sage', skin: 'studio-flow', preset: 'sage', file: 'projects/partner-data-sharing.md', graph: true}
];
const only = process.argv[2];

await fs.mkdir(out, {recursive: true});
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'weave-screenshots-'));
const server = await createServer({root: path.join(root, 'knowledge-example'), port: 0, runtime});
const browser = await launchBrowser();
try {
  for (const shot of shots) {
    if (only && shot.name !== only) continue;
    const page = await browser.newPage({locale: 'en-GB', viewport: {width: 1680, height: 1000}, deviceScaleFactor: 1.25});
    await page.addInitScript(({skin, preset}) => localStorage.setItem('weave:appearance', JSON.stringify({preset, skin})), shot);
    await page.goto(server.url);
    const folder = shot.file.split('/')[0];
    await page.locator(`[data-tree-path="${folder}"]`).click();
    await page.locator(`[data-tree-path="${shot.file}"]`).click();
    if (shot.graph) await page.locator('#view-graph').click();
    await page.waitForTimeout(5000); // graph layers, diagrams and fonts settle
    // The status bar names the workspace by its path; show the folder name instead.
    await page.evaluate(() => {document.getElementById('workspace-name').textContent = 'knowledge-example';});
    await page.mouse.move(5, 995);
    await page.screenshot({path: path.join(out, shot.name + '.png')});
    console.log('wrote docs/images/' + shot.name + '.png');
    await page.close();
  }
} finally {
  await browser.close();
  await fs.rm(runtime, {recursive: true, force: true}).catch(() => {}); // the preview keeps its database open
  process.exit(0);
}
