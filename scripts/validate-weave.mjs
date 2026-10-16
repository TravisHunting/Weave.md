import fs from 'node:fs/promises';
import path from 'node:path';
import {scanTree} from '../app/weave/files.mjs';
import {parseLinks, createResolver} from '../app/weave/links.mjs';
const root = path.resolve(process.argv[2] || 'knowledge-example'), tree = await scanTree(root), resolve = createResolver(tree.files.map(f => f.path));
let links = 0; const errors = [];
for (const file of tree.files) {
  const text = await fs.readFile(path.join(root, file.path), 'utf8'), parsed = parseLinks(text, file.path);
  if (/```yaml|\]\(entity:|— id:|^id:/m.test(text)) errors.push(file.path + ': static metadata remains');
  if (/--[^/]+\.md$/i.test(file.path)) errors.push(file.path + ': ID suffix remains');
  if (/^## Connections\s*$/m.test(text)) errors.push(file.path + ': explicit Connections section remains');
  for (const d of parsed.diagnostics) errors.push(file.path + ': ' + d.message);
  for (const l of parsed.links) {
    links++; const r = resolve(l.target, file.path);
    if (!r.resolved) errors.push(file.path + ': unresolved ' + l.target);
    else if (r.fallback) errors.push(file.path + ': write a path relative to the article (./ or ../) ' + l.raw);
    if (!l.label) errors.push(file.path + ': link without a label ' + l.raw);
  }
}
if (errors.length) {console.error(errors.join('\n')); process.exitCode = 1;} else console.log(`${tree.files.length} articles, ${links} filepath links: valid`);
