import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Workspace} from '../workspace.mjs';

test('new articles use a first-line title; non-Markdown files are listed and move without being indexed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'weave-files-')), w = new Workspace(path.join(root, '.weave'), {});
  try {
    await fs.mkdir(path.join(root, 'Folder')); await fs.writeFile(path.join(root, 'image.png'), Buffer.from([0, 1, 2]));
    await w.open(root); await w.ready; await w.create('Folder/under_score.md');
    assert.equal((await w.getDocument('Folder/under_score.md')).title, 'under_score');
    assert.equal(w.catalog().tree.otherFiles[0].path, 'image.png'); assert.equal(w.documents.size, 1);
    const plan = await w.renamePreview('image.png', 'Folder/renamed.png'); await w.rename(plan.token, true);
    assert.deepEqual(await fs.readFile(path.join(root, 'Folder/renamed.png')), Buffer.from([0, 1, 2]));
    assert.equal(w.documents.size, 1);
  } finally {await w.close(); await fs.rm(root, {recursive:true, force:true});}
});
