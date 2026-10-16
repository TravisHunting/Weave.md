import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';

test('PowerShell syntax checker accepts prose/code and rejects malformed or unsafe wiki links', {skip:process.platform !== 'win32'}, async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'weave-validation-'));
  const script=path.resolve('.agents/scripts/Validate-Knowledge.ps1');
  const check=(...extra)=>spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-KnowledgeRoot',root,...extra],{encoding:'utf8',windowsHide:true});
  try {
    await fs.mkdir(path.join(root,'systems'));await fs.writeFile(path.join(root,'systems/target.md'),'# Target\n\nTopics: SQL.');
    const file=path.join(root,'article.md');
    await fs.writeFile(file,'---\ntype: Note\ntitle: "[Not](a-link.md)"\n---\n# Article\n\n[Target](./systems/target.md "hosted-in").\n[Again](/systems/target.md "A tooltip") [Plain](systems/target.md)\n[Web](https://example.invalid/page.md) [Text](notes.txt)\n\n`[not](a-link.md)`\n<!-- [ignored](x.md) -->\n\\[escaped](x.md)\n```markdown\n[sample](sample.md "example")\n```');
    const good=check('-Path',file);assert.equal(good.status,0,good.stdout+good.stderr);assert.match(good.stdout,/1 articles, 3 filepath links/);
    await fs.writeFile(path.join(root,'systems/bad.md'),'---\ntitle: Missing type\n---\n# Bad\n[Missing](./missing.md)\n[Outside](../../outside.md)\n[Root only](systems/target.md)\n[T](./target.md)@@hosted-in\n[T](./target.md "bad.name")\n[[systems/target.md]]\n[Open](./target.md\n~~~\ncode');
    const bad=check();assert.equal(bad.status,1,bad.stdout+bad.stderr);for(const pattern of [/requires a non-empty type/,/Missing target/,/outside the workspace/,/relative to this article/,/Unsupported @@relationship suffix/,/relationship title uses/,/Wiki links are not supported/,/Unclosed Markdown link/,/Unclosed Markdown code fence/])assert.match(bad.stdout,pattern);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
