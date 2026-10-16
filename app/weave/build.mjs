import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {scanTree, readNote} from './files.mjs';
import {noteMetadata} from './metadata.mjs';
import {GraphIndex} from './graph.mjs';
import {build as bundle} from 'esbuild';
import {paneStyles} from './panes.mjs';
import {skinStylesheets} from './skins.mjs';

export const ROOT = path.resolve(import.meta.dirname, '../..');
/** Placeholder the desktop app replaces with a workspace's JSON when exporting. */
export const EXPORT_DATA_TOKEN = '"__WEAVE_EXPORT_DATA__"';
// Hunspell dictionaries (SCOWL, via dictionary-en and dictionary-en-gb) for spell
// checking. Only the desktop page embeds them; read-only readers do not edit.
async function dictionaries() {
  const read = async name => ({aff: await fs.readFile(path.join(ROOT, 'node_modules', name, 'index.aff'), 'utf8'), dic: await fs.readFile(path.join(ROOT, 'node_modules', name, 'index.dic'), 'utf8')});
  return {'en-US': await read('dictionary-en'), 'en-GB': await read('dictionary-en-gb')};
}
// Mermaid is large, so the page carries it as inert text (<script type="text/plain"
// id="weave-mermaid-runtime">), which costs no JavaScript parsing at start-up.
// mermaid.mjs runs it as an inline script the first time an article shows a
// diagram; its hash is in script-src (Tauri hashes every non-empty <script> of the
// desktop page itself). One minified build serves every page variant of a run.
let mermaidBuild = null;
export function mermaidRuntime() {
  return mermaidBuild ??= bundle({entryPoints: [path.join(ROOT, 'app/weave/mermaid-runtime.mjs')], bundle: true, write: false, format: 'iife', globalName: 'weaveMermaidModule', platform: 'browser', target: 'es2022', minify: true, legalComments: 'inline'})
    .then(result => `(()=>{${result.outputFiles[0].text}\nglobalThis.weaveMermaid=weaveMermaidModule.default;})();`.replace(/\r\n?/g, '\n').replace(/<\/script/gi, '<\\/script'));
}
// The saved skin, scheme and layout choices are applied by a small script in
// <head> (appearance-boot.mjs), before the body is parsed, so the first frame
// already has them; the main script runs only after the whole body.
let bootBuild = null;
function bootScript() {
  return bootBuild ??= bundle({entryPoints: [path.join(ROOT, 'app/weave/appearance-boot.mjs')], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', minify: true, legalComments: 'none'})
    .then(result => result.outputFiles[0].text.trim().replace(/\r\n?/g, '\n'));
}
export async function renderPage(data = {}, {dynamic = false, desktop = false, server = false, exportTemplate = false} = {}) {
  const bundled = await bundle({entryPoints: [path.join(ROOT, 'app/weave/ui.mjs')], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', minifyWhitespace: true, lineLimit: 120, legalComments: 'inline'});
  const boot = (await bootScript()).replace(/<\/script/gi, '<\\/script');
  const script = `(async()=>{\n${bundled.outputFiles[0].text}\n})().catch(e=>{document.getElementById('message').textContent=e.message;});`.replace(/\r\n?/g, '\n');
  let html = await fs.readFile(path.join(ROOT, 'app/weave/index.html'), 'utf8');
  const spelling = desktop || server ? await dictionaries() : null;
  const css = (await Promise.all(['skin-contract.css','styles.css','workspace.css','git.css','appearance.css','graph.css','sidebars.css','table-editor.css','mermaid.css','kanban.css',...skinStylesheets,'titlebar-tabs.css','mobile.css'].map(file=>fs.readFile(path.join(ROOT, 'app/weave',file),'utf8')))).join('\n').replace(/\r\n?/g,'\n');
  const styles = paneStyles(css);
  const icon = await fs.readFile(path.join(ROOT, 'app/weave/icon.svg'), 'utf8');
  const digest = createHash('sha256').update(script).digest('base64'), bootDigest = createHash('sha256').update(boot).digest('base64'), mermaid = await mermaidRuntime();
  const mermaidDigest = createHash('sha256').update(mermaid).digest('base64');
  const styleDigest = createHash('sha256').update(styles).digest('base64');
  const csp = `default-src 'none'; script-src 'sha256-${bootDigest}' 'sha256-${digest}' 'sha256-${mermaidDigest}'; style-src ${server ? "'sha256-" + styleDigest + "'" : "'unsafe-inline'"}; img-src data: blob:; connect-src ${desktop ? 'ipc: http://ipc.localhost' : dynamic || server ? "'self'" : "'none'"}; base-uri 'none'; form-action 'none'; object-src 'none'`;
  return html.replace('<!--CSP-->', () => (desktop ? '' : `<meta http-equiv="Content-Security-Policy" content="${csp}">`) + `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(icon)}">`)
    .replace('/*STYLES*/', () => styles).replace('<!--BOOT-->', () => '<script>' + boot + '</script>').replace('/*DATA*/', () => exportTemplate ? EXPORT_DATA_TOKEN : JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026'))
    .replace('<!--SCRIPT-->', () => (spelling ? '<script id="weave-dictionaries" type="application/json">' + JSON.stringify(spelling).replaceAll('<', '\\u003c') + '</script>' : '') + '<script id="weave-mermaid-runtime" type="text/plain">' + mermaid + '</script><script>' + script.replace(/<\/script/gi, '<\\/script') + '</script>').replace(/\r\n?/g, '\n');
}
export async function readWorkspace(root) {
  if (!await fs.stat(root).catch(() => null)) return {documents: [], graph: {entities: [], relationships: []}, folders: []};
  root = await fs.realpath(root);
  const tree = await scanTree(root), documents = [], graph = new GraphIndex(':memory:', root, process.platform !== 'win32');
  try {
    for (const file of tree.files) {const doc = await readNote(root, file.path); documents.push({...doc, ...noteMetadata(doc.text, file.path)}); graph.upsert(doc.path, doc.text, doc.mtime);}
    return {root: path.basename(root), documents, folders: tree.folders, otherFiles: tree.otherFiles, graph: graph.snapshot()};
  } finally {graph.close();}
}
/** Weave Lite: the standalone read-only reader with no articles embedded. Users
 * open a Markdown folder in the browser; portable workspace exports come from
 * the desktop app instead. */
export async function build() {
  await fs.writeFile(path.join(ROOT, 'weave_lite.html'), await renderPage({}));
  console.log('Built weave_lite.html (no embedded articles; open a Markdown folder in the browser).');
}
export async function buildDesktop() {
  await buildServer();
  const output = path.join(ROOT, 'dist/desktop'); await fs.mkdir(output, {recursive: true});
  await fs.writeFile(path.join(output, 'index.html'), await renderPage({mode: 'desktop'}, {desktop: true}));
  // The reader page embedded in the desktop executable for "Export workspace":
  // the same page as weave_lite.html, with a placeholder for the workspace data.
  await fs.writeFile(path.join(ROOT, 'dist/export-template.html'), await renderPage({}, {exportTemplate: true}));
  console.log('Built Weave desktop shell (no embedded workspace) and the portable export template.');
}
export async function buildServer() {
  const output = path.join(ROOT, 'dist/server'); await fs.mkdir(output, {recursive: true});
  await fs.writeFile(path.join(output, 'index.html'), await renderPage({mode: 'server'}, {server: true}));
  await fs.writeFile(path.join(ROOT, 'dist/export-template.html'), await renderPage({}, {exportTemplate: true}));
  console.log('Built Weave server shell and portable export template.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {if (process.argv.includes('--desktop')) await buildDesktop(); else if (process.argv.includes('--server')) await buildServer(); else await build();}
