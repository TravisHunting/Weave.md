import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {GitService as JavaScriptGitService, sanitizeGitOutput} from '../git-service.mjs';
import {NativeGitService} from './native-git-adapter.mjs';
const nativeGit = process.env.WEAVE_TEST_GIT !== 'javascript';
const GitService = nativeGit ? NativeGitService : JavaScriptGitService;
import {diffRows, conflictHunks} from '../git-ui.mjs';

const exec = promisify(execFile);
const git = (cwd, ...args) => exec('git', args, {cwd, windowsHide: true});
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'weave-git-')), service = new GitService(root);
  t.after(async () => {await service.close(); await fs.rm(root, {recursive: true, force: true});});
  await service.action({action: 'init'}); await git(root, 'config', 'user.name', 'Weave Test'); await git(root, 'config', 'user.email', 'weave@example.invalid');
  await git(root, 'config', 'commit.gpgsign', 'false');
  return {root, service, write: (file, text) => fs.writeFile(path.join(root, file), text)};
}
async function firstCommit({write, service}) {await write('Article.md', '# Article\n\nFirst paragraph.\n'); await service.action({action: 'stageAll'}); await service.action({action: 'commit', message: 'Initial article'});}

test('.gitignore editor creates, preserves format, rejects stale saves and leaves staging alone', async t => {
  const {root,service,write} = await fixture(t);
  const missing = await service.readIgnore(); assert.equal(missing.revision,null);
  await service.action({action:'saveIgnore',revision:null,text:'cache/\n'});
  assert.equal(await fs.readFile(path.join(root,'.gitignore'),'utf8'),'cache/\n');
  assert((await service.status()).files.find(file=>file.path==='.gitignore').untracked);
  await write('.gitignore','logs/\r\n'); const snapshot=await service.readIgnore();
  await service.action({action:'saveIgnore',revision:snapshot.revision,text:'logs/\ntemp/\n'});
  assert.equal(await fs.readFile(path.join(root,'.gitignore'),'utf8'),'logs/\r\ntemp/\r\n');
  await assert.rejects(service.action({action:'saveIgnore',revision:snapshot.revision,text:'stale'}),/changed outside/);
  await fs.unlink(path.join(root,'.gitignore'));await fs.mkdir(path.join(root,'.gitignore'));
  await assert.rejects(service.readIgnore(),/ordinary text file/);
});

test('Git index workflow preserves unstaged edits, literal paths, and private data', async t => {
  const f = await fixture(t), {root, service, write} = f;
  assert.equal((await service.status()).unborn, true);
  await write('Article.md', '# Article\n\nFirst paragraph.\n'); await write('-strange [name].md', '# Literal path\n');
  await fs.mkdir(path.join(root, '.weave')); await write('.weave/secret.txt', 'do not commit');
  assert.equal((await service.status()).files.length, 2);
  assert.match((await service.diff({path: 'Article.md'})).text, /\+# Article/);
  await service.action({action: 'stageAll'}); assert.equal((await service.status()).files.every(file => file.index === 'A'), true);
  await write('-strange [name].md', '# Literal path\n\nChanged after staging.\n');
  await service.action({action: 'unstage', path: '-strange [name].md'}); assert.equal((await service.status()).files.find(file => file.path.startsWith('-')).untracked, true);
  assert.match(await fs.readFile(path.join(root, '-strange [name].md'), 'utf8'), /Changed after staging/);
  await service.action({action: 'stage', path: '-strange [name].md'});
  await service.action({action: 'commit', message: 'Initial articles'});
  assert.equal((await service.status()).files.length, 0); assert.doesNotMatch((await git(root, 'ls-files')).stdout, /secret/);
  await write('Article.md', '# Article\n\nStaged paragraph.\n'); await service.action({action: 'stage', path: 'Article.md'});
  await write('Article.md', '# Article\n\nUnstaged paragraph.\n');
  assert.match((await service.diff({path: 'Article.md', staged: true})).text, /\+Staged paragraph/);
  assert.match((await service.diff({path: 'Article.md'})).text, /\+Unstaged paragraph/);
  await service.action({action: 'commit', message: 'Only staged version'});
  assert.match((await git(root, 'show', 'HEAD:Article.md')).stdout, /Staged paragraph/);
  assert.match(await fs.readFile(path.join(root, 'Article.md'), 'utf8'), /Unstaged paragraph/);
  const history = await service.history(); assert.equal(history.length, 2); assert.equal(history[0].subject, 'Only staged version');
  assert.match((await service.commitDiff({id: history[0].id})).text, /\+Staged paragraph/);
  await service.action({action: 'stageAll'}); await service.action({action: 'unstageAll'}); assert.equal((await service.status()).files[0].index, '.');
});

test('Git branch and stash workflow protects dirty files and allows deliberate discard', async t => {
  const f = await fixture(t); await firstCommit(f); const {service, write, root} = f;
  await service.action({action: 'createBranch', branch: 'notes/polish'}); assert.equal((await service.status()).branch, 'notes/polish');
  await write('Article.md', '# Article\n\nDraft changes.\n');
  await assert.rejects(service.action({action: 'switch', branch: 'main'}), /Commit or stash/);
  await service.action({action: 'stash'}); assert.equal((await service.status()).files.length, 0); assert.equal((await service.status()).stashes.length, 1);
  await service.action({action: 'switch', branch: 'main'}); await service.action({action: 'applyStash', ref: 'stash@{0}'});
  assert.match(await fs.readFile(path.join(root, 'Article.md'), 'utf8'), /Draft changes/);
  await assert.rejects(service.action({action: 'discard', path: 'Article.md'}), /Confirm/);
  await service.action({action: 'discard', path: 'Article.md', confirmed: true}); assert.equal((await service.status()).files.length, 0);
  assert.equal((await service.status()).stashes.length, 1, 'applying retains recovery stash');
});

test('discarding an untracked file requires explicit deletion confirmation and keeps other files', async t => {
  const f = await fixture(t); await firstCommit(f); const {service,root,write} = f;
  await write('New [draft].md','# New draft\n');await write('Keep.md','# Keep\n');
  await assert.rejects(service.action({action:'discard',path:'New [draft].md',untracked:true}),/Confirm/);
  await assert.rejects(service.action({action:'discard',path:'New [draft].md',confirmed:true}),/Confirm deletion separately/);
  assert.equal(await fs.readFile(path.join(root,'New [draft].md'),'utf8'),'# New draft\n');
  await service.action({action:'discard',path:'New [draft].md',confirmed:true,untracked:true});
  await assert.rejects(fs.stat(path.join(root,'New [draft].md')),{code:'ENOENT'});
  assert.equal(await fs.readFile(path.join(root,'Keep.md'),'utf8'),'# Keep\n');
  await assert.rejects(fs.stat(path.join(root,'.git','index.lock')),{code:'ENOENT'});
  await service.action({action:'stage',path:'Keep.md'});
});

test('untracked discard rejects staged promotion and prevents staging during its final check', async t => {
  const f = await fixture(t); await firstCommit(f); const {service,root,write} = f;
  await write('Promoted.md','# Promoted\n');
  if(nativeGit){
    await git(root,'add','--','Promoted.md');
    await assert.rejects(service.action({action:'discard',path:'Promoted.md',confirmed:true,untracked:true}),/no longer untracked/);
    await service.action({action:'unstage',path:'Promoted.md'});
    const lock=path.join(root,'.git','index.lock');await fs.writeFile(lock,'external lock',{flag:'wx'});
    try{await assert.rejects(service.action({action:'discard',path:'Promoted.md',confirmed:true,untracked:true}),/Git is updating its index/);assert.equal(await fs.readFile(path.join(root,'Promoted.md'),'utf8'),'# Promoted\n');}
    finally{await fs.rm(lock);}
    await service.action({action:'discard',path:'Promoted.md',confirmed:true,untracked:true});
    await assert.rejects(fs.stat(path.join(root,'Promoted.md')),{code:'ENOENT'});return;
  }
  const originalRun = service.run.bind(service); let promoted = false;
  service.run = async (args,options) => {
    if (!promoted && args[0]==='rev-parse' && args[1]==='--git-path') {promoted=true;await git(root,'add','--','Promoted.md');}
    return originalRun(args,options);
  };
  await assert.rejects(service.action({action:'discard',path:'Promoted.md',confirmed:true,untracked:true}),/no longer untracked/);
  assert.equal(await fs.readFile(path.join(root,'Promoted.md'),'utf8'),'# Promoted\n');
  await assert.rejects(fs.stat(path.join(root,'.git','index.lock')),{code:'ENOENT'});
  service.run = originalRun;
  await service.action({action:'unstage',path:'Promoted.md'});
  let prevented = false;
  service.run = async (args,options) => {
    if (args[0]==='status' && !args.includes('--branch')) {await assert.rejects(git(root,'add','--','Promoted.md'),/index\.lock/);prevented=true;}
    return originalRun(args,options);
  };
  await service.action({action:'discard',path:'Promoted.md',confirmed:true,untracked:true});
  assert(prevented);await assert.rejects(fs.stat(path.join(root,'Promoted.md')),{code:'ENOENT'});
});

test('untracked discard rejects private paths, directory trees, symlinks and path escapes', async t => {
  const f = await fixture(t); await firstCommit(f); const {service,root,write} = f;
  await fs.mkdir(path.join(root,'.weave'));await write('.weave/private.md','private');
  await fs.mkdir(path.join(root,'Folder'));await write('Folder/Keep.md','keep');
  for (const value of ['../escape.md','C:/escape.md','.weave/private.md','.git/config']) await assert.rejects(service.action({action:'discard',path:value,confirmed:true,untracked:true}),/inside this repository/);
  if(nativeGit)await assert.rejects(service.action({action:'discard',path:'Folder',confirmed:true,untracked:true}),/ordinary|Refresh/);else await assert.rejects(service.discardUntracked('Folder'),/ordinary untracked files/);
  const linked = path.join(root,'Linked');
  await fs.symlink(path.join(root,'Folder'),linked,process.platform==='win32'?'junction':'dir');
  await assert.rejects(service.action({action:'discard',path:'Linked/Keep.md',confirmed:true,untracked:true}),/Linked files/);
  assert.equal(await fs.readFile(path.join(root,'Folder/Keep.md'),'utf8'),'keep');
  assert.equal(await fs.readFile(path.join(root,'.weave/private.md'),'utf8'),'private');
});

test('Git fetch, push, and fast-forward pull work with an offline bare remote', async t => {
  const f = await fixture(t); await firstCommit(f); const {root, service, write} = f;
  const remoteRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'weave-git-remote-')); t.after(() => fs.rm(remoteRoot, {recursive: true, force: true}));
  const bare = path.join(remoteRoot, 'remote.git'), peer = path.join(remoteRoot, 'peer'); await git(remoteRoot, 'init', '--bare', '--initial-branch=main', bare); await git(root, 'remote', 'add', 'origin', bare);
  await service.action({action: 'push', remote: 'origin'}); assert.equal((await service.status()).upstream, 'origin/main');
  await git(remoteRoot, 'clone', bare, peer); await git(peer, 'config', 'user.name', 'Peer'); await git(peer, 'config', 'user.email', 'peer@example.invalid'); await git(peer, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(peer, 'From remote.md'), '# From remote\n'); await git(peer, 'add', '.'); await git(peer, 'commit', '-m', 'Peer update'); await git(peer, 'push');
  await service.action({action: 'fetch'}); assert.equal((await service.status()).behind, 1);
  await service.action({action: 'pull'}); assert.match(await fs.readFile(path.join(root, 'From remote.md'), 'utf8'), /From remote/); assert.equal((await service.status()).behind, 0);
  await write('Local.md', '# Local\n'); await service.action({action: 'stageAll'}); await service.action({action: 'commit', message: 'Local update'}); assert.equal((await service.status()).ahead, 1);
  assert.equal((await service.status()).pendingFileCount,1,'unpushed committed files count as pending');
  await write('Local.md','# Local\nFurther edit');assert.equal((await service.status()).pendingFileCount,1,'a working edit to an outgoing file is counted once');
  await service.action({action:'discard',path:'Local.md',confirmed:true});
  await service.action({action: 'push'}); assert.equal((await service.status()).ahead, 0);assert.equal((await service.status()).pendingFileCount,0);
  await write('Article.md', 'Dirty'); await assert.rejects(service.action({action: 'pull'}), /Commit or stash/);
});

test('Remote preferences persist, push to every selected remote and keep one upstream', async t => {
  const f = await fixture(t); await firstCommit(f); const {root, service, write} = f;
  const remoteRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'weave-multi-remote-'));
  t.after(() => fs.rm(remoteRoot, {recursive: true, force: true}));
  const remotes = Object.fromEntries(['origin', 'backup', 'unchecked'].map(name => [name, path.join(remoteRoot, name + '.git')]));
  for (const [name, directory] of Object.entries(remotes)) {await git(remoteRoot, 'init', '--bare', '--initial-branch=main', directory); await git(root, 'remote', 'add', name, directory);}
  assert.deepEqual((await service.status()).pushRemotes, ['origin']);
  await service.action({action: 'configureRemotes', remote: 'origin', pushRemotes: ['origin', 'backup']});
  const reopened = new GitService(root); t.after(() => reopened.close());
  assert.deepEqual((await reopened.status()).pushRemotes, ['origin', 'backup']);
  assert.equal((await reopened.status()).syncRemote, 'origin');
  await service.action({action: 'push'});
  const initial = (await git(root, 'rev-parse', 'HEAD')).stdout;
  for (const name of ['origin', 'backup']) assert.equal((await git(remotes[name], 'rev-parse', 'main')).stdout, initial);
  await assert.rejects(git(remotes.unchecked, 'rev-parse', '--verify', 'main'));
  assert.equal((await service.status()).upstream, 'origin/main');
  await write('Article.md', '# Article\n\nSynced to both remotes.\n');
  await service.action({action: 'sync', message: 'Multiple destinations'});
  const synced = (await git(root, 'rev-parse', 'HEAD')).stdout;
  for (const name of ['origin', 'backup']) assert.equal((await git(remotes[name], 'rev-parse', 'main')).stdout, synced);
  await service.action({action: 'configureRemotes', remote: 'origin', pushRemotes: ['backup']});
  await write('Article.md', '# Backup only\n'); await service.action({action: 'sync'});
  assert.equal((await git(remotes.origin, 'rev-parse', 'main')).stdout, synced, 'unchecked primary is not pushed');
  assert.equal((await git(remotes.backup, 'rev-parse', 'main')).stdout, (await git(root, 'rev-parse', 'HEAD')).stdout);
  assert.equal((await service.status()).upstream, 'origin/main', 'secondary push does not replace the upstream');
  await service.action({action: 'configureRemotes', remote: 'origin', pushRemotes: []});
  await write('Uncommitted.md', '# Retain this draft\n');
  await assert.rejects(service.action({action: 'sync'}), /Select at least one/);
  assert((await service.status()).files.find(file => file.path === 'Uncommitted.md').untracked, 'empty push selection is rejected before staging');
  for (const pushRemotes of ['origin', ['--all'], ['missing']]) await assert.rejects(service.action({action: 'push', pushRemotes}), /existing remote/);
  await assert.rejects(service.action({action: 'configureRemotes', remote: 'missing', pushRemotes: ['origin']}), /existing remote/);
});

test('Multi-remote push reports partial failures and still attempts the remaining selected remotes', async t => {
  const f = await fixture(t); await firstCommit(f); const {root, service} = f;
  const remoteRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'weave-partial-push-'));
  t.after(() => fs.rm(remoteRoot, {recursive: true, force: true}));
  const backup = path.join(remoteRoot, 'backup.git');
  await git(remoteRoot, 'init', '--bare', '--initial-branch=main', backup);
  await git(root, 'remote', 'add', 'origin', path.join(remoteRoot, 'missing.git')); await git(root, 'remote', 'add', 'backup', backup);
  await assert.rejects(service.action({action: 'push', remote: 'origin', pushRemotes: ['origin', 'backup']}), /Pushed to backup.*Push failed for origin/s);
  assert.equal((await git(backup, 'rev-parse', 'main')).stdout, (await git(root, 'rev-parse', 'HEAD')).stdout);
  assert.equal((await service.status()).upstream, '', 'successful secondary push does not set the upstream');
});

test('Commit defaults to the current timestamp while preserving custom messages', async t => {
  const f = await fixture(t); await f.write('Article.md', '# Timestamp\n'); await f.service.action({action: 'stageAll'});
  const before = Date.now(); await f.service.action({action: 'commit', message: ''}); const after = Date.now();
  const message = (await f.service.history())[0].subject;
  assert.match(message, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert(Date.parse(message) >= before && Date.parse(message) <= after);
  await f.write('Article.md', '# Custom\n'); await f.service.action({action: 'stageAll'}); await f.service.action({action: 'commit', message: 'A reviewed update'});
  assert.equal((await f.service.history())[0].subject, 'A reviewed update');
});

test('Git rejects argument injection, arbitrary paths, unsafe remotes, and parent-repo scope', async t => {
  const f = await fixture(t); await firstCommit(f); const {root, service, write} = f;
  for (const value of ['../outside', '/outside', 'C:/outside', ':!Article.md', '.weave/secret', 'folder/../../file']) await assert.rejects(service.diff({path: value}), /inside this repository/);
  await assert.rejects(service.action({action: 'createBranch', branch: '--detach'}), /valid Git branch/);
  await assert.rejects(service.commitDiff({id: 'HEAD;whoami'}), /Choose a commit/);
  await assert.rejects(service.action({action: 'shell', command: 'whoami'}), /Unknown Git action/);
  for (const url of ['ext::sh -c whoami', 'https://token@example.com/repo.git', 'https://example.com/repo?token=secret', 'file:///outside']) await assert.rejects(service.action({action: 'addRemote', name: 'origin', url}), /URL|credentials/);
  await service.action({action: 'addRemote', name: 'example', url: 'https://example.invalid/notes.git'}); assert.equal((await service.status()).remotes[0].name, 'example');
  await fs.mkdir(path.join(root, 'Nested')); const nested = new GitService(path.join(root, 'Nested')); t.after(() => nested.close());
  assert.equal((await nested.status()).parentRepository, await fs.realpath(root)); await assert.rejects(nested.action({action: 'commit', message: 'unsafe'}), /repository root/);
  await fs.mkdir(path.join(root, '.weave')); await write('.weave/private.md', 'hidden token'); await git(root, 'add', '-f', '.weave/private.md');
  await assert.rejects(service.action({action: 'commit', message: 'private'}), /Private Weave data/);
  await git(root, 'commit', '-m', 'Private fixture'); const privateCommit = (await service.history())[0]; assert.doesNotMatch((await service.commitDiff({id: privateCommit.id})).text, /hidden token/);
  assert.equal(sanitizeGitOutput('https://user:secret@host/repo?token=secret&sig=abc'), 'https://[redacted]@host/repo?token=[redacted]&sig=[redacted]');
});

test('Git reports renames, deletions, binary files and conflicted changes', async t => {
  const f = await fixture(t); await firstCommit(f); const {root, service, write} = f;
  await git(root, 'mv', 'Article.md', 'Renamed article.md');
  let status = await service.status(); assert.equal(status.files[0].previousPath, 'Article.md'); assert.match((await service.diff({path: 'Renamed article.md', staged: true})).text, /rename from Article.md/);
  await service.action({action: 'unstageAll'}); await service.action({action: 'stageAll'}); await service.action({action: 'commit', message: 'Rename'});
  await write('image.bin', Buffer.from([0, 255, 1])); assert.equal((await service.diff({path: 'image.bin'})).binary, true);
  await service.action({action: 'stageAll'}); await service.action({action: 'commit', message: 'Binary file'});
  await fs.unlink(path.join(root, 'image.bin')); await service.action({action: 'stageAll'}); assert.equal((await service.status()).files[0].index, 'D');
  await service.action({action: 'commit', message: 'Remove binary'});
  await service.action({action: 'createBranch', branch: 'conflict'}); await write('Renamed article.md', '# Conflict side\n'); await service.action({action: 'stageAll'}); await service.action({action: 'commit', message: 'Side'});
  await service.action({action: 'switch', branch: 'main'}); await write('Renamed article.md', '# Main side\n'); await service.action({action: 'stageAll'}); await service.action({action: 'commit', message: 'Main'});
  await git(root, 'merge', 'conflict').catch(() => {}); status = await service.status(); assert.equal(status.files[0].conflict, true);
  await assert.rejects(service.action({action: 'commit', message: 'Unresolved'}), /Resolve and stage/);
  await write('Renamed article.md', '# Resolved\n'); await service.action({action: 'stageAll'}); await service.action({action: 'commit', message: 'Resolved'}); assert.equal((await service.status()).files.length, 0);
});

test('Diff parsing preserves line numbering for added, removed and context lines', () => {
  const rows = diffRows('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -2,2 +2,3 @@\n keep\n-old\n+new\n+extra\n');
  assert.deepEqual(rows.filter(row => ['add', 'remove', 'context'].includes(row.kind)), [{kind: 'context', old: 2, next: 2, text: 'keep'}, {kind: 'remove', old: 3, text: 'old'}, {kind: 'add', next: 3, text: 'new'}, {kind: 'add', next: 4, text: 'extra'}]);
  const rules = diffRows('--- a/a\n+++ b/a\n@@ -1,1 +1,1 @@\n----\n++++\ndiff --git a/b b/b\n--- a/b\n+++ b/b');
  assert.deepEqual(rules.filter(row => ['add', 'remove'].includes(row.kind)), [{kind: 'remove', old: 1, text: '---'}, {kind: 'add', next: 1, text: '+++'}]);
  assert.equal(rules.at(-1).kind, 'meta');
});

test('Conflict hunk parsing preserves surrounding text, empty sides, CRLF and diff3 bases', () => {
  const text = 'Before\r\n<<<<<<< HEAD\r\nCurrent\r\n||||||| base\r\nBase\r\n=======\r\nIncoming\r\n>>>>>>> branch\r\nMiddle\r\n<<<<<<< HEAD\r\n=======\r\nAdded\r\n>>>>>>> branch\r\nAfter';
  const hunks = conflictHunks(text);
  assert.equal(hunks.length, 2); assert.equal(hunks[0].ours, 'Current\r\n'); assert.equal(hunks[0].theirs, 'Incoming\r\n');
  assert.equal(hunks[1].ours, ''); assert.equal(hunks[1].theirs, 'Added\r\n');
  let resolved = text; for (const hunk of [...hunks].reverse()) resolved = resolved.slice(0, hunk.from) + hunk.ours + hunk.theirs + resolved.slice(hunk.to);
  assert.equal(resolved, 'Before\r\nCurrent\r\nIncoming\r\nMiddle\r\nAdded\r\nAfter');
});

async function conflictFixture(t, {file = 'Article.md', base = '# Base\n', ours = '# Current\n', theirs = '# Incoming\n'} = {}) {
  const f = await fixture(t);
  await f.write(file, base); await f.service.action({action:'stageAll'}); await f.service.action({action:'commit',message:'Base'});
  await f.service.action({action:'createBranch',branch:'incoming'});
  if (theirs === null) await fs.unlink(path.join(f.root,file)); else await f.write(file,theirs);
  await f.service.action({action:'stageAll'}); await f.service.action({action:'commit',message:'Incoming'});
  await f.service.action({action:'switch',branch:'main'});
  if (ours === null) await fs.unlink(path.join(f.root,file)); else await f.write(file,ours);
  await f.service.action({action:'stageAll'}); await f.service.action({action:'commit',message:'Current'});
  await git(f.root,'merge','incoming').catch(()=>{});
  assert((await f.service.status()).files.some(item=>item.path===file && item.conflict));
  return {...f,file};
}

test('Conflict resolution previews versions, rejects unresolved staging and protects externally changed files and index', async t => {
  const {service,root,write}=await conflictFixture(t);
  let conflict=await service.diff({path:'Article.md',conflict:true});
  assert.equal(conflict.ours.text,'# Current\n'); assert.equal(conflict.theirs.text,'# Incoming\n'); assert.equal(conflict.base.text,'# Base\n');
  await assert.rejects(service.action({action:'stageAll'}),/Resolve conflict markers/);
  await assert.rejects(service.action({action:'resolveConflict',path:'Article.md',revision:conflict.revision,choice:'manual',text:conflict.text}),/Resolve all conflict markers/);
  await write('Article.md','# Changed in another editor\n');
  await assert.rejects(service.action({action:'resolveConflict',path:'Article.md',revision:conflict.revision,choice:'ours'}),/changed on disk or in Git/);
  assert.equal(await fs.readFile(path.join(root,'Article.md'),'utf8'),'# Changed in another editor\n');
  conflict=await service.diff({path:'Article.md',conflict:true});
  await service.action({action:'resolveConflict',path:'Article.md',revision:conflict.revision,choice:'manual',text:'# Both reviewed\n',stage:false});
  assert((await service.status()).files[0].conflict,'saving a draft preserves unmerged index stages');
  assert.equal(await fs.readFile(path.join(root,'Article.md'),'utf8'),'# Both reviewed\n');
  conflict=await service.diff({path:'Article.md',conflict:true});
  const stageLine=(await git(root,'ls-files','-u','--','Article.md')).stdout.split('\n')[0];
  const match=stageLine.match(/^(\d+) ([a-f0-9]+) 1\t/); assert(match);
  await git(root,'update-index','--cacheinfo',match[1],match[2],'Article.md');
  await assert.rejects(service.action({action:'resolveConflict',path:'Article.md',revision:conflict.revision,choice:'theirs'}),/no longer has a conflict/);
  assert.equal(await fs.readFile(path.join(root,'Article.md'),'utf8'),'# Both reviewed\n');
});

test('Reviewed manual resolutions are staged and can complete a merge', async t => {
  const {service,root}=await conflictFixture(t);
  const conflict=await service.diff({path:'Article.md',conflict:true});
  await service.action({action:'resolveConflict',path:'Article.md',revision:conflict.revision,choice:'manual',text:'# Current\n# Incoming\n'});
  assert(!(await service.status()).files.some(file=>file.conflict));
  assert.equal((await git(root,'show',':Article.md')).stdout,'# Current\n# Incoming\n');
  await service.action({action:'commit',message:'Resolve both versions'});
  assert.equal((await service.status()).files.length,0);
});

test('Choosing current content still permits the pending merge commit without staged file changes', async t => {
  const {service,root}=await conflictFixture(t), conflict=await service.diff({path:'Article.md',conflict:true});
  await service.action({action:'resolveConflict',path:'Article.md',revision:conflict.revision,choice:'ours'});
  const state=await service.status(); assert.equal(state.files.length,0); assert.equal(state.merging,true);
  await service.action({action:'commit',message:'Retain current content'});
  assert.equal((await service.status()).merging,false);
  assert.equal((await git(root,'rev-list','--parents','-n','1','HEAD')).stdout.trim().split(' ').length,3,'a merge commit retains both parents');
});

test('Whole-file resolution preserves binary bytes and accepts deletion conflicts', async t => {
  const f=await conflictFixture(t,{file:'image.bin',base:Buffer.from([0,1,255]),ours:Buffer.from([0,2,254]),theirs:Buffer.from([0,3,253])});
  const conflict=await f.service.diff({path:f.file,conflict:true}); assert.equal(conflict.binary,true);
  await assert.rejects(f.service.action({action:'stageAll'}),/Choose a version in the conflict resolver/);
  await f.service.action({action:'resolveConflict',path:f.file,revision:conflict.revision,choice:'theirs'});
  assert.deepEqual(await fs.readFile(path.join(f.root,f.file)),Buffer.from([0,3,253]));
  assert(!(await f.service.status()).files.some(file=>file.conflict));
  const d=await conflictFixture(t,{theirs:null}), deleted=await d.service.diff({path:d.file,conflict:true});
  assert.equal(deleted.theirs.deleted,true);
  await assert.rejects(d.service.action({action:'stageAll'}),/Choose a version in the conflict resolver/);
  await d.service.action({action:'resolveConflict',path:d.file,revision:deleted.revision,choice:'theirs'});
  assert.equal(await fs.stat(path.join(d.root,d.file)).catch(()=>null),null);
  assert(!(await d.service.status()).files.some(file=>file.conflict));
  assert.equal((await git(d.root,'ls-files','--',d.file)).stdout,'');
});

async function remoteFixture(t) {
  const f=await fixture(t); await firstCommit(f);
  const remoteRoot=await fs.mkdtemp(path.join(os.tmpdir(),'weave-sync-'));
  t.after(()=>fs.rm(remoteRoot,{recursive:true,force:true}));
  const bare=path.join(remoteRoot,'remote.git'), peer=path.join(remoteRoot,'peer');
  await git(remoteRoot,'init','--bare','--initial-branch=main',bare); await git(f.root,'remote','add','origin',bare);
  await f.service.action({action:'push'}); await git(remoteRoot,'clone',bare,peer);
  await git(peer,'config','user.name','Peer'); await git(peer,'config','user.email','peer@example.invalid'); await git(peer,'config','commit.gpgsign','false');
  return {...f,bare,peer,async publish(file,text) {await fs.writeFile(path.join(peer,file),text);await git(peer,'add','.');await git(peer,'commit','-m','Peer update');await git(peer,'push');}};
}

test('Commit all and sync merges incoming work, pushes, excludes private files and persists pulled diffs', async t => {
  const {root,service,write,bare,peer,publish}=await remoteFixture(t);
  await publish('Remote.md','# Remote update\n'); await write('Local.md','# Local update\n');
  await fs.mkdir(path.join(root,'.weave')); await write('.weave/private.txt','private');
  await assert.rejects(service.action({action:'sync',message:'\0'}),/Use a commit message/);
  assert.equal((await service.status()).files[0].untracked,true,'message validation happens before staging');
  await git(root,'config','merge.ff','only');
  const result=await service.action({action:'sync',message:'Local update'});
  assert.equal(result.committed,true); assert.equal(result.status.files.length,0);
  assert.equal(result.status.ahead,0); assert.equal(result.status.behind,0);
  assert.match((await git(bare,'show','main:Local.md')).stdout,/Local update/);
  assert.match(await fs.readFile(path.join(root,'Remote.md'),'utf8'),/Remote update/);
  assert.doesNotMatch((await git(root,'ls-files')).stdout,/private/);
  const pulls=result.status.recentPulls; assert.equal(pulls.length,1);
  assert.deepEqual(pulls[0].files,[{path:'Remote.md',status:'A'}],'incoming list excludes this sync’s own local commit');
  assert.match((await service.diff({path:'Remote.md',pullId:pulls[0].to})).text,/\+# Remote update/);
  await assert.rejects(service.diff({path:'Local.md',pullId:pulls[0].to}),/Choose a file/);
  const restored=new GitService(root); t.after(()=>restored.close()); assert.deepEqual((await restored.status()).recentPulls,pulls);
  assert.equal((await service.action({action:'sync'})).committed,false,'clean sync needs no message or empty commit');
  assert.deepEqual((await service.status()).recentPulls,pulls,'no-op sync retains the most recent incoming files');
  await git(peer,'pull','--ff-only'); await git(peer,'mv','Remote.md','Renamed.md'); await git(peer,'rm','Article.md'); await git(peer,'commit','-m','Rename and remove'); await git(peer,'push');
  await service.action({action:'pull'});
  const recent=(await service.status()).recentPulls[0];
  assert.deepEqual(recent.files,[{path:'Article.md',status:'D'},{path:'Renamed.md',status:'R',previousPath:'Remote.md'}]);
  assert.equal((await service.diff({path:'Article.md',pullId:recent.to})).deleted,true);
  assert.match((await service.diff({path:'Renamed.md',pullId:recent.to})).text,/rename from Remote.md/);
});

test('Sync conflict retains the local commit, never pushes, and resumes after resolving and staging', async t => {
  const {root,service,write,bare,publish}=await remoteFixture(t);
  await publish('Article.md','# Remote side\n'); const remoteHead=(await git(bare,'rev-parse','main')).stdout;
  await write('Article.md','# Local side\n');
  await assert.rejects(service.action({action:'sync',message:'Local side'}),/Changes were committed locally.*Sync stopped during merge/s);
  assert.equal((await service.history())[0].subject,'Local side');
  assert.equal((await service.status()).files[0].conflict,true);
  assert.equal((await git(bare,'rev-parse','main')).stdout,remoteHead,'conflict never pushes');
  await assert.rejects(service.action({action:'sync',message:'Still conflicted'}),/Resolve and stage/);
  await write('Article.md','# Both sides resolved\n'); await service.action({action:'stageAll'});
  await service.action({action:'sync',message:'Resolve both sides'});
  assert.match((await git(bare,'show','main:Article.md')).stdout,/Both sides resolved/);
  assert.equal((await service.status()).files.length,0);
  assert.equal((await git(root,'rev-parse','HEAD')).stdout,(await git(bare,'rev-parse','main')).stdout);
});
