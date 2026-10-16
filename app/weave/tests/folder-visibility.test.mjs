import assert from 'node:assert/strict';
import test from 'node:test';
import {folderIsHidden, hiddenFolderPaths, moveHiddenFolders} from '../folder-visibility.mjs';

test('folder hiding matches folder boundaries, nested dot folders and workspace casing', () => {
  const preferences = {hideDotFolders:true,hiddenFolders:['Archive']};
  assert(folderIsHidden('.obsidian', preferences));
  assert(folderIsHidden('Projects/.drafts/Old', preferences));
  assert(folderIsHidden('Archive/2026', preferences));
  assert.equal(folderIsHidden('Archive copy', preferences), false);
  assert.equal(folderIsHidden('archive', preferences), false);
  assert(folderIsHidden('archive', preferences, false));
  assert.equal(folderIsHidden('.obsidian', {hideDotFolders:false}), false);
  assert.equal(folderIsHidden('Release.1', preferences), false);
});

test('stored folder preferences reject malformed paths and follow folder moves', () => {
  assert.deepEqual(hiddenFolderPaths(['Archive','Archive',null,'../secret','C:\\bad','/root','a//b','Normal']), ['Archive','Normal']);
  assert.deepEqual(moveHiddenFolders(['Archive','Archive/Old','Archive copy'], 'Archive','Docs/Archive'), ['Docs/Archive','Docs/Archive/Old','Archive copy']);
});
