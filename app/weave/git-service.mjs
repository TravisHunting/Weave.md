import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {decode, encode} from './files.mjs';

const OUTPUT_LIMIT = 4 * 1024 * 1024;
const CONFLICT_LIMIT = 1024 * 1024;
const contentHash = bytes => createHash('sha256').update(bytes).digest('hex');
// Equals-only lines are also valid Markdown setext headings; opening/closing
// conflict markers identify an unfinished merge without rejecting those headings.
const hasConflictMarkers = text => /^(?:<{7,}|>{7,})(?: |\r?$)/m.test(text);
const privatePath = value => value.split('/').some(part => part.toLowerCase() === '.weave' || part.toLowerCase() === '.git' || part.toLowerCase().startsWith('.weave-'));
export function sanitizeGitOutput(value) {
  return String(value).replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:access_token|token|key|sig|signature|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(authorization:\s*(?:bearer|basic)\s+)\S+/gi, '$1[redacted]');
}
function gitPath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\\') || /[\x00-\x1f:]/.test(value) || path.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..') || privatePath(value)) throw new Error('Choose a file inside this repository. Private Weave data cannot be staged.');
  return value;
}
function refName(value) {
  if (typeof value !== 'string' || !value || value.length > 200 || value.startsWith('-') || /[\x00-\x20~^:?*\[\\]/.test(value) || value.includes('..') || value.includes('@{') || value.endsWith('.') || value.endsWith('/') || value.endsWith('.lock')) throw new Error('Use a valid Git branch name.');
  return value;
}
function commitMessage(value) {
  if (value !== undefined && (typeof value !== 'string' || value.length > 10000 || value.includes('\0'))) throw new Error('Use a commit message of at most 10,000 characters.');
  return value?.trim() || new Date().toISOString();
}
function parseStatus(raw) {
  const result = {branch: '', oid: '', upstream: '', ahead: 0, behind: 0, files: [], privateStaged: false};
  const records = raw.split('\0');
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (row.startsWith('# branch.')) {
      const [, field, ...parts] = row.split(' '), value = parts.join(' ');
      if (field === 'branch.head') result.branch = value;
      if (field === 'branch.oid') result.oid = value;
      if (field === 'branch.upstream') result.upstream = value;
      if (field === 'branch.ab') {const match = value.match(/^\+(\d+) -(\d+)$/); if (match) {result.ahead = Number(match[1]); result.behind = Number(match[2]);}}
      continue;
    }
    if (!row) continue;
    let file;
    if (row.startsWith('? ')) file = {path: row.slice(2), index: '?', worktree: '?', untracked: true};
    else if (['1', '2', 'u'].includes(row[0])) {
      const fields = row.split(' '), offset = row[0] === 'u' ? 10 : row[0] === '2' ? 9 : 8;
      file = {path: fields.slice(offset).join(' '), index: fields[1][0], worktree: fields[1][1], conflict: row[0] === 'u', submodule: fields[2] !== 'N...'};
      if (row[0] === '2') file.previousPath = records[++i];
    }
    if (!file) continue;
    if (privatePath(file.path) || file.previousPath && privatePath(file.previousPath)) {if (!file.untracked && file.index !== '.') result.privateStaged = true; continue;}
    result.files.push(file);
  }
  result.unborn = result.oid === '(initial)'; result.detached = result.branch === '(detached)';
  return result;
}

/** A fixed Git vocabulary scoped to an explicitly opened repository root. */
export class GitService {
  constructor(root, {stateDirectory} = {}) {
    this.root = path.resolve(root); this.queue = Promise.resolve(); this.busy = null; this.closed = false; this.children = new Set();
    this.pullFile = path.join(stateDirectory || path.join(this.root,'.weave','git'),createHash('sha256').update(this.root).digest('hex').slice(0,24)+'.json');
  }
  async executable() {
    if (this.binary) return this.binary;
    const candidates = process.platform === 'win32' ? [process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git/cmd/git.exe'), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs/Git/cmd/git.exe')].filter(Boolean) : [];
    for (const candidate of candidates) if (await fs.stat(candidate).catch(() => null)) return this.binary = candidate;
    return this.binary = 'git';
  }
  async run(args, {allowFailure = false, timeout = 90000, input, limit = OUTPUT_LIMIT, binary: binaryOutput = false} = {}) {
    if (this.closed) throw new Error('This workspace is closed.');
    const binary = await this.executable();
    return new Promise((resolve, reject) => {
      // Git's argument parser receives separate literal arguments; no shell or user commands.
      const env = {...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat'};
      // Inherited repository routing must never override the active workspace.
      for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(key)) delete env[key];
      const child = spawn(binary, ['--no-pager', '--literal-pathspecs', '-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false', ...args], {cwd: this.root, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe']});
      this.children.add(child); let stdout = [], stderr = [], bytes = 0, failure;
      const timer = setTimeout(() => {failure = new Error('Git took too long. Check your connection and authenticate using Git, then retry.'); child.kill();}, timeout); timer.unref();
      const capture = target => chunk => {bytes += chunk.length; if (bytes > limit) {failure = new Error('Git output is too large to display. Narrow the changes or use an external Git client.'); child.kill();} else target.push(chunk);};
      child.stdout.on('data', capture(stdout)); child.stderr.on('data', capture(stderr)); child.stdin.on('error', () => {});
      child.on('error', error => {failure = error.code === 'ENOENT' ? new Error('Git is not installed. Install Git for Windows, then reopen Weave.') : error;});
      child.on('close', code => {
        clearTimeout(timer); this.children.delete(child);
        const result = {code, stdout: binaryOutput ? Buffer.concat(stdout) : Buffer.concat(stdout).toString('utf8'), stderr: sanitizeGitOutput(Buffer.concat(stderr).toString('utf8'))};
        if (failure) reject(failure);
        else if (code && !allowFailure) reject(new Error(sanitizeGitOutput(result.stderr.trim() || result.stdout.toString().trim() || 'Git could not complete this operation.').slice(0, 10000)));
        else resolve(result);
      });
      child.stdin.end(input);
    });
  }
  async repository() {
    const result = await this.run(['rev-parse', '--show-toplevel'], {allowFailure: true});
    if (result.code) {
      if (/not a git repository/i.test(result.stderr)) return {available: true, repository: false, root: this.root};
      throw new Error(result.stderr.trim() || 'Cannot read this Git repository.');
    }
    const actual = await fs.realpath(result.stdout.trim()), root = await fs.realpath(this.root);
    if ((process.platform === 'win32' ? actual.toLowerCase() === root.toLowerCase() : actual === root)) return {available: true, repository: true, root};
    return {available: true, repository: false, root, parentRepository: actual};
  }
  async requireRepository() {const info = await this.repository(); if (!info.repository) throw new Error(info.parentRepository ? 'Open the repository root to use Source control: ' + info.parentRepository : 'This workspace is not a Git repository.'); return info;}
  async status() {
    let info;
    try {info = await this.repository();} catch (error) {return {available: false, repository: false, error: error.message};}
    if (!info.repository) return info;
    const [state, branchResult, remotesResult, stashResult, mergeResult] = await Promise.all([
      this.run(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
      this.run(['for-each-ref', '--format=%(refname:short)%00%(HEAD)%00%(upstream:short)', 'refs/heads/']),
      this.run(['remote', '-v']), this.run(['stash', 'list', '--format=%gd%x00%gs']), this.run(['rev-parse', '--verify', '-q', 'MERGE_HEAD'], {allowFailure: true})
    ]);
    const remotes = new Map();
    for (const line of remotesResult.stdout.trim().split('\n')) {const match = line.match(/^(\S+)\s+(.+) \((fetch|push)\)$/); if (match) {const remote = remotes.get(match[1]) || {name: match[1]}; remote[match[3]] = sanitizeGitOutput(match[2]); remotes.set(match[1], remote);}}
    const branches = branchResult.stdout.trim().split('\n').filter(Boolean).map(line => {const [name, current, upstream] = line.split('\0'); return {name, current: current === '*', upstream};});
    const stashes = stashResult.stdout.trim().split('\n').filter(Boolean).map(line => {const [ref, ...message] = line.split('\0'); return {ref, message: message.join(' ')};});
    const remoteList = [...remotes.values()];
    const status=parseStatus(state.stdout),pendingFiles=new Set(status.files.map(file=>file.path));
    if(status.ahead>0 && status.upstream) {
      const outgoing=await this.run(['diff','--name-only','-z','HEAD@{upstream}...HEAD','--']);
      for(const file of outgoing.stdout.split('\0'))if(file && !privatePath(file))pendingFiles.add(file);
    }
    return {...info, ...status, pendingFileCount:pendingFiles.size, branches, remotes: remoteList, ...await this.remotePreferences(remoteList), stashes, merging: mergeResult.code === 0, recentPulls:await this.recentPulls(), busy: this.busy};
  }
  async remotePreferences(remotes) {
    if (this.savedRemotePreferences === undefined) {
      try {this.savedRemotePreferences = JSON.parse(await fs.readFile(this.pullFile + '.remotes', 'utf8'));}
      catch {this.savedRemotePreferences = null;}
    }
    const saved = this.savedRemotePreferences, exists = name => remotes.some(remote => remote.name === name);
    const syncRemote = exists(saved?.syncRemote) ? saved.syncRemote : remotes.find(remote => remote.name === 'origin')?.name || remotes[0]?.name || '';
    const pushRemotes = Array.isArray(saved?.pushRemotes) ? [...new Set(saved.pushRemotes.filter(exists))] : syncRemote ? [syncRemote] : [];
    return {syncRemote, pushRemotes};
  }
  pushTargets(args, state, primary) {
    const names = args.pushRemotes ?? (args.remote ? [primary.name] : state.pushRemotes);
    if (!Array.isArray(names) || !names.length || names.length > 100 || names.some(name => typeof name !== 'string' || !state.remotes.some(remote => remote.name === name))) throw new Error('Select at least one existing remote for pushes.');
    return [...new Set(names)];
  }
  async pushToRemotes(state, names, primary, primaryBranch = state.branch) {
    const branch = refName(state.branch), succeeded = [], failures = [];
    // Only the sync remote sets the upstream. Additional destinations never
    // change future pulls; every push is a regular, non-forced branch push.
    for (const name of names) {
      const isPrimary = name === primary.name, destination = refName(isPrimary ? primaryBranch : branch);
      try {
        await this.run(['push', ...(isPrimary ? ['--set-upstream'] : []), '--', name, branch + ':refs/heads/' + destination]);
        succeeded.push(name);
      } catch (error) {failures.push(name + ': ' + error.message);}
    }
    if (failures.length) throw new Error((succeeded.length ? 'Pushed to ' + succeeded.join(', ') + '. ' : '') + 'Push failed for ' + failures.join('; ') + ' Successful pushes are retained.');
    return {stdout: 'Pushed to ' + succeeded.join(', ') + '.'};
  }
  async recentPulls() {
    if (this.pullHistory) return this.pullHistory;
    try {
      const value = JSON.parse(await fs.readFile(this.pullFile,'utf8'));
      this.pullHistory = Array.isArray(value) ? value.filter(p=>p && /^[a-f0-9]{40,64}$/.test(p.from) && /^[a-f0-9]{40,64}$/.test(p.to) && Array.isArray(p.files)
        && typeof p.remote==='string' && typeof p.branch==='string' && Number.isFinite(Date.parse(p.at)) && Number.isSafeInteger(p.totalFiles) && p.totalFiles>=0
        && p.files.length<=200 && p.files.every(f=>f && typeof f.path==='string' && /^[AMDRCT]$/.test(f.status) && (f.previousPath===undefined || typeof f.previousPath==='string'))).slice(0,5) : [];
    } catch {this.pullHistory = [];}
    return this.pullHistory;
  }
  async recordPull(from, remote, branch) {
    const to = (await this.run(['rev-parse','HEAD'])).stdout.trim();
    if (from === to) return;
    const result = await this.run(['diff','--name-status','-z','--find-renames',from,to,'--']);
    const tokens = result.stdout.split('\0'), files = [];
    for (let i=0;i<tokens.length && tokens[i];) {
      const status=tokens[i++], first=tokens[i++], renamed=/^[RC]/.test(status), file=renamed?tokens[i++]:first;
      if (!file || privatePath(file) || renamed && privatePath(first)) continue;
      try {gitPath(file);if(renamed)gitPath(first);} catch {continue;}
      files.push({path:file,status:status[0],...(renamed?{previousPath:first}:{})});
    }
    const entry = {from,to,remote,branch,at:new Date().toISOString(),totalFiles:files.length,files:files.slice(0,200)};
    this.pullHistory = [entry,...await this.recentPulls()].slice(0,5);
    try {
      await fs.mkdir(path.dirname(this.pullFile),{recursive:true});
      await fs.writeFile(this.pullFile+'.tmp',JSON.stringify(this.pullHistory,null,2));
      await fs.rename(this.pullFile+'.tmp',this.pullFile);
    } catch { /* Pull succeeded; an unavailable history cache must not report a Git failure. */ }
  }
  async safeFile(value, {allowMissing = true} = {}) {
    const file = gitPath(value); let current = this.root;
    for (const segment of file.split('/')) {
      current = path.join(current, segment);
      try {const stat = await fs.lstat(current); if (stat.isSymbolicLink()) throw new Error('Linked files and folders must be managed in an external Git client.');}
      catch (error) {if (error.code !== 'ENOENT' || !allowMissing) throw error;}
    }
    return file;
  }
  async readIgnore() {
    await this.requireRepository();
    await this.safeFile('.gitignore');
    const full = path.join(this.root,'.gitignore');
    const stat = await fs.lstat(full).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
    if (!stat) return {text:'',revision:null,format:{}};
    if (!stat.isFile() || stat.size > CONFLICT_LIMIT) throw new Error('.gitignore must be an ordinary text file of at most 1 MB.');
    const bytes = await fs.readFile(full);
    if (bytes.length > CONFLICT_LIMIT) throw new Error('.gitignore exceeds 1 MB.');
    const {text,...format} = decode(bytes);
    return {text,format,revision:contentHash(bytes)};
  }
  async saveIgnore(args) {
    if (typeof args.text !== 'string' || args.text.includes('\0') || Buffer.byteLength(args.text) > CONFLICT_LIMIT) throw new Error('Use text of at most 1 MB.');
    const current = await this.readIgnore();
    const verify = snapshot => {if (args.revision !== snapshot.revision) throw new Error('.gitignore changed outside Weave. Your draft is retained; reopen it to load the current version.');};
    verify(current);
    const full = path.join(this.root,'.gitignore'), temporary = path.join(this.root,'.weave-'+randomUUID()+'.tmp');
    // A textarea normalizes CRLF; retain the file's existing newline convention.
    const text = current.text.includes('\r\n') ? args.text.replace(/\r\n?/g,'\n').replace(/\n/g,'\r\n') : args.text;
    try {
      await fs.writeFile(temporary,encode(text,current.format),{flag:'wx'});
      verify(await this.readIgnore());
      await fs.rename(temporary,full);
    } finally {await fs.unlink(temporary).catch(()=>{});}
    return {message:'Saved .gitignore.',status:await this.status()};
  }
  async discardUntracked(value) {
    const file = await this.safeFile(value,{allowMissing:false}), full = path.join(this.root,file);
    const before = await fs.lstat(full);
    if (!before.isFile()) throw new Error('Only ordinary untracked files can be deleted. Folders and linked files require an external Git client.');
    // Hold Git's standard index lock while checking and deleting. A concurrent
    // Git process cannot stage the file after our last untracked-status check.
    const index = (await this.run(['rev-parse','--git-path','index'])).stdout.trim();
    const lockPath = path.resolve(this.root,index) + '.lock';
    let lock;
    try {lock = await fs.open(lockPath,'wx');}
    catch (error) {if (error.code === 'EEXIST') throw new Error('Git is updating its index. Wait for that operation to finish, then retry.');throw error;}
    try {
      const current = parseStatus((await this.run(['status','--porcelain=v2','-z','--untracked-files=all','--',file])).stdout).files.find(item=>item.path===file);
      if (!current?.untracked) throw new Error('This file is no longer untracked. Refresh Source control before discarding it.');
      await this.safeFile(file,{allowMissing:false});
      const latest = await fs.lstat(full);
      if (!latest.isFile() || latest.dev !== before.dev || latest.ino !== before.ino || latest.size !== before.size || latest.mtimeMs !== before.mtimeMs) throw new Error('This file changed before deletion. Refresh Source control and review it again.');
      await fs.unlink(full);
    } finally {await lock.close();await fs.unlink(lockPath);}
  }
  async conflictSnapshot(value) {
    const file = await this.safeFile(value);
    const raw = (await this.run(['ls-files', '--unmerged', '-z', '--', file])).stdout;
    const stages = {};
    for (const record of raw.split('\0').filter(Boolean)) {
      const match = record.match(/^(\d+) ([a-f0-9]{40,64}) ([123])\t/);
      if (match) stages[match[3]] = {mode: match[1], id: match[2]};
    }
    if (!Object.keys(stages).length) throw new Error('This file no longer has a conflict. Refresh Source control.');
    const full = path.join(this.root, file), stat = await fs.lstat(full).catch(error => {if (error.code !== 'ENOENT') throw error; return null;});
    const unsupported = Object.values(stages).some(stage => !/^100(?:644|755)$/.test(stage.mode)) || stat && !stat.isFile();
    if (unsupported) return {path: file, unsupported: true, reason: 'Linked files, submodules and directory conflicts need an external Git client.'};
    const sizes = await Promise.all(Object.values(stages).map(async stage => Number((await this.run(['cat-file', '-s', stage.id])).stdout.trim())));
    if (stat?.size > CONFLICT_LIMIT || sizes.some(size => size > CONFLICT_LIMIT)) return {path: file, unsupported: true, reason: 'Conflict files larger than 1 MB need an external Git client.'};
    const bytes = stat ? await fs.readFile(full) : null;
    const revision = contentHash(JSON.stringify({raw, worktree: bytes === null ? null : contentHash(bytes), mode: stat?.mode}));
    return {path: file, stages, bytes, revision, mode: stat?.mode};
  }
  async conflict(value) {
    await this.requireRepository();
    const snapshot = await this.conflictSnapshot(value);
    if (snapshot.unsupported) return snapshot;
    const version = async stage => {
      if (!stage) return {deleted: true, text: '', binary: false};
      const bytes = (await this.run(['cat-file', 'blob', stage.id], {binary: true})).stdout;
      const text = bytes.toString('utf8'), binary = bytes.includes(0) || !Buffer.from(text).equals(bytes);
      return {deleted: false, binary, text: binary ? '' : text};
    };
    const [ours, theirs, base] = await Promise.all([version(snapshot.stages[2]), version(snapshot.stages[3]), version(snapshot.stages[1])]);
    const bytes = snapshot.bytes, text = bytes?.toString('utf8') || '';
    const binary = ours.binary || theirs.binary || bytes !== null && (bytes.includes(0) || !Buffer.from(text).equals(bytes));
    return {path: snapshot.path, revision: snapshot.revision, ours, theirs, base, binary, text: binary ? '' : text, deleted: bytes === null};
  }
  async resolveConflict(args) {
    const snapshot = await this.conflictSnapshot(args.path);
    if (snapshot.unsupported) throw new Error(snapshot.reason);
    if (typeof args.revision !== 'string' || args.revision !== snapshot.revision) throw new Error('This conflict changed on disk or in Git. Reopen the conflict before saving; your resolution remains in the editor.');
    let bytes, mode = snapshot.mode;
    if (args.choice === 'ours' || args.choice === 'theirs') {
      const stage = snapshot.stages[args.choice === 'ours' ? 2 : 3];
      bytes = stage ? (await this.run(['cat-file', 'blob', stage.id], {binary: true})).stdout : null;
      if (stage) mode = stage.mode === '100755' ? 0o755 : 0o644;
    } else if (args.choice === 'manual') {
      if (typeof args.text !== 'string' || Buffer.byteLength(args.text) > CONFLICT_LIMIT || args.text.includes('\0')) throw new Error('Enter a text resolution of at most 1 MB.');
      bytes = Buffer.from(args.text, 'utf8');
    } else throw new Error('Choose the current version, incoming version, or an edited text resolution.');
    if (args.stage !== false && bytes && hasConflictMarkers(bytes.toString('utf8'))) throw new Error('Resolve all conflict markers before staging. Save a draft to continue later.');
    const full = path.join(this.root, snapshot.path);
    // A sibling temporary file makes the replacement atomic. Recheck after preparing it,
    // so stale dialogs and another editor's changes cannot silently overwrite a file.
    const temporary = path.join(path.dirname(full), '.weave-conflict-' + createHash('sha256').update(String(Date.now()) + Math.random()).digest('hex').slice(0, 16));
    try {
      if (bytes !== null) await fs.writeFile(temporary, bytes, {flag: 'wx', mode});
      const current = await this.conflictSnapshot(snapshot.path);
      if (current.revision !== snapshot.revision) throw new Error('This conflict changed while saving. Reopen it and review the current versions.');
      if (bytes === null) {if (snapshot.bytes !== null) await fs.unlink(full);}
      else await fs.rename(temporary, full);
    } finally {await fs.unlink(temporary).catch(error => {if (error.code !== 'ENOENT') throw error;});}
    if (args.stage !== false) {
      const current = await this.conflictSnapshot(snapshot.path);
      if (JSON.stringify(current.stages) !== JSON.stringify(snapshot.stages) || (current.bytes === null ? null : contentHash(current.bytes)) !== (bytes === null ? null : contentHash(bytes))) throw new Error('The resolution was saved, but the file or Git index changed before staging. Review it before staging.');
      await this.run(['add', '--all', '--', snapshot.path]);
    }
    return {message: args.stage === false ? 'Resolution draft saved. Review and stage it when ready.' : 'Conflict resolved and staged. Commit when every conflict is resolved.', status: await this.status()};
  }
  async diff({path: value, staged = false, pullId, conflict = false} = {}) {
    if (conflict) return this.conflict(value);
    if (pullId) {
      await this.requireRepository(); const file = await this.safeFile(value);
      const entry = (await this.recentPulls()).find(item=>item.to===pullId), changed = entry?.files.find(item=>item.path===file);
      if (!changed) throw new Error('Choose a file from recently pulled changes.');
      const paths=[file];if(changed.previousPath)paths.push(await this.safeFile(changed.previousPath));
      const result=await this.run(['diff','--no-ext-diff','--no-textconv','--no-color','--unified=5',entry.from,entry.to,'--',...paths]);
      return {path:file,text:result.stdout,pulled:true,deleted:changed.status==='D',from:entry.from,to:entry.to,binary:/\nBinary files /.test(result.stdout)};
    }
    await this.requireRepository(); const file = await this.safeFile(value), status = await this.status(), entry = status.files.find(item => item.path === file);
    if (!entry) return {path: file, staged, text: '', empty: true};
    if (entry.untracked) {
      const full = path.join(this.root, file), stat = await fs.stat(full);
      if (!stat.isFile() || stat.size > 1024 * 1024) return {path: file, staged: false, binary: true, text: 'New file is too large to preview (maximum 1 MB).'};
      const bytes = await fs.readFile(full); if (bytes.includes(0)) return {path: file, staged: false, binary: true, text: 'Binary file — preview unavailable.'};
      const content = bytes.toString('utf8').replace(/\r\n/g, '\n'), lines = content.split('\n'); if (lines.at(-1) === '') lines.pop();
      return {path: file, staged: false, text: `diff --git a/${file} b/${file}\nnew file\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n` + lines.map(line => '+' + line).join('\n')};
    }
    const paths = [file]; if (entry.previousPath) paths.push(await this.safeFile(entry.previousPath));
    const result = await this.run(['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=5', ...(staged ? ['--cached'] : []), '--', ...paths]);
    return {path: file, staged, text: result.stdout, binary: /\nBinary files /.test(result.stdout)};
  }
  async history() {
    await this.requireRepository();
    const result = await this.run(['log', '-40', '--date=iso-strict', '--format=%H%x00%h%x00%an%x00%ad%x00%s%x00%D%x1e'], {allowFailure: true});
    if (result.code) {if (/does not have any commits/i.test(result.stderr)) return []; throw new Error(result.stderr);}
    return result.stdout.split('\x1e').map(row => row.trim()).filter(Boolean).map(row => {const [id, short, author, date, subject, refs] = row.split('\0'); return {id, short, author, date, subject, refs};});
  }
  async commitDiff({id} = {}) {
    await this.requireRepository(); if (typeof id !== 'string' || !/^[a-f0-9]{40,64}$/.test(id)) throw new Error('Choose a commit from the history.');
    const names = await this.run(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--root', id]);
    const paths = names.stdout.split('\0').filter(file => file && !privatePath(file)).map(gitPath);
    if (!paths.length) return {path: id.slice(0, 8), text: 'This commit has no viewable file changes.'};
    const result = await this.run(['show', '--format=fuller', '--no-ext-diff', '--no-textconv', '--no-color', '--stat', '--patch', '--unified=3', id, '--', ...paths]);
    return {path: id.slice(0, 8), text: result.stdout};
  }
  action(args = {}) {
    const pending = this.queue.then(async () => {
      this.busy = args.action;
      try {return await this.perform(args);} finally {this.busy = null;}
    }); this.queue = pending.catch(() => {}); return pending;
  }
  async perform(args) {
    const action = args.action;
    if (action === 'init') {
      const state = await this.repository(); if (state.repository || state.parentRepository) throw new Error('This folder already belongs to a Git repository.');
      await this.run(['init', '--initial-branch=main']);
      return {message: 'Initialized Git repository.', status: await this.status()};
    }
    await this.requireRepository(); const state = await this.status(); let result;
    if (action === 'saveIgnore') return this.saveIgnore(args);
    if (action === 'resolveConflict') return this.resolveConflict(args);
    if (action === 'sync') return this.sync(args,state);
    if (action === 'configureRemotes') {
      if (!state.remotes.some(remote => remote.name === args.remote)) throw new Error('Choose an existing remote for fetching and pulling.');
      if (!Array.isArray(args.pushRemotes) || args.pushRemotes.length > 100 || args.pushRemotes.some(name => typeof name !== 'string' || !state.remotes.some(remote => remote.name === name))) throw new Error('Choose existing remotes for pushes.');
      const preferences = {syncRemote: args.remote, pushRemotes: [...new Set(args.pushRemotes)]};
      await fs.mkdir(path.dirname(this.pullFile), {recursive: true});
      await fs.writeFile(this.pullFile + '.remotes.tmp', JSON.stringify(preferences));
      await fs.rename(this.pullFile + '.remotes.tmp', this.pullFile + '.remotes');
      this.savedRemotePreferences = preferences;
      result = {stdout: 'Remote preferences saved.'};
    } else if (['stage', 'unstage', 'stageAll', 'unstageAll'].includes(action)) {
      const staging = action.startsWith('stage');
      const files = action.endsWith('All') ? state.files.filter(f => staging ? f.untracked || f.worktree !== '.' || f.conflict : !f.untracked && f.index !== '.') : state.files.filter(f => f.path === args.path);
      if (!files.length) throw new Error('There are no matching changes. Refresh Source control.');
      if (staging) for (const file of files.filter(file => file.conflict)) {
        const snapshot = await this.conflictSnapshot(file.path);
        if (snapshot.unsupported) throw new Error(snapshot.reason);
        if (!snapshot.stages[2] || !snapshot.stages[3] || snapshot.bytes && (snapshot.bytes.includes(0) || !Buffer.from(snapshot.bytes.toString('utf8')).equals(snapshot.bytes))) throw new Error('Choose a version in the conflict resolver for ' + file.path + ' before staging.');
        if (snapshot.bytes && hasConflictMarkers(snapshot.bytes.toString('utf8'))) throw new Error('Resolve conflict markers in ' + file.path + ' before staging.');
      }
      const paths = [...new Set(files.flatMap(f => [f.path, ...(f.previousPath ? [f.previousPath] : [])]))]; for (const file of paths) await this.safeFile(file);
      // Explicit path lists keep private data out of Stage all and avoid pathspec injection.
      for (let offset = 0; offset < paths.length; offset += 100) {
        const batch = paths.slice(offset, offset + 100);
        result = await this.run(staging ? ['add', '--all', '--', ...batch] : state.unborn ? ['rm', '--cached', '--force', '--ignore-unmatch', '--', ...batch] : ['restore', '--staged', '--', ...batch]);
      }
    } else if (action === 'commit') {
      const message = commitMessage(args.message);
      if (state.privateStaged) throw new Error('Private Weave data is staged. Unstage it in an external Git client before committing.');
      if (state.files.some(file => file.conflict)) throw new Error('Resolve and stage all conflicted files before committing.');
      if (!state.merging && !state.files.some(file => !file.untracked && file.index !== '.')) throw new Error('Stage your changes before committing.');
      result = await this.run(['commit', '--file=-'], {input: message});
    } else if (action === 'fetch' || action === 'pull' || action === 'push') {
      const remote = state.remotes.find(item => item.name === (args.remote || state.syncRemote));
      if (!remote) throw new Error('Choose or add a Git remote first.');
      if (action === 'fetch') result = await this.run(['fetch', '--prune', '--', remote.name]);
      else {
        if (state.unborn || state.detached) throw new Error('Create a commit on a named branch before pulling or pushing.');
        if (action === 'pull') {
          if (state.files.length) throw new Error('Commit or stash your changes before pulling.');
          if (!state.upstream) throw new Error('Push this branch to set its upstream before pulling.');
          const branch = state.upstream.startsWith(remote.name + '/') ? state.upstream.slice(remote.name.length + 1) : state.branch;
          result = await this.run(['pull', '--ff-only', '--no-rebase', '--', remote.name, refName(branch)]);
          await this.recordPull(state.oid,remote.name,branch);
        } else result = await this.pushToRemotes(state, this.pushTargets(args, state, remote), remote, state.upstream.startsWith(remote.name + '/') ? state.upstream.slice(remote.name.length + 1) : state.branch);
      }
    } else if (action === 'switch' || action === 'createBranch') {
      const name = refName(args.branch); if (state.files.length) throw new Error('Commit or stash your changes before switching branches.');
      if (action === 'switch' && !state.branches.some(branch => branch.name === name)) throw new Error('Choose an existing local branch.');
      result = await this.run(action === 'createBranch' ? ['switch', '-c', name] : ['switch', '--', name]);
    } else if (action === 'addRemote') {
      if (typeof args.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(args.name)) throw new Error('Use a remote name containing letters, numbers, dots, underscores or hyphens.');
      const url = args.url;
      if (typeof url !== 'string' || url.length > 2000 || /[\s\x00-\x1f?#]/.test(url) || !(/^(?:https?|ssh):\/\//i.test(url) || /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[\w./-]+$/.test(url))) throw new Error('Enter an HTTP(S) or SSH Git URL without passwords, tokens or query parameters.');
      if (/^https?:\/\//i.test(url) && new URL(url).username || /^ssh:\/\//i.test(url) && new URL(url).password) throw new Error('Use your system Git credentials; do not include credentials in remote URLs.');
      result = await this.run(['remote', 'add', args.name, url]);
    } else if (action === 'stash') {
      if (!state.files.length || state.unborn || state.files.some(file => file.conflict)) throw new Error('Stashing needs a commit and changes without unresolved conflicts.');
      const tracked = state.files.filter(file => !file.untracked);
      if (!tracked.length) throw new Error('Stage new files first to include them in a stash.');
      const paths = [...new Set(tracked.flatMap(file => [file.path, ...(file.previousPath ? [file.previousPath] : [])]))]; for (const file of paths) await this.safeFile(file);
      result = await this.run(['stash', 'push', '-m', 'Weave workspace changes', '--', ...paths]);
    } else if (action === 'applyStash') {
      if (state.files.length) throw new Error('Commit or stash current changes before applying a stash.');
      if (!/^stash@\{\d+\}$/.test(args.ref || '') || !state.stashes.some(stash => stash.ref === args.ref)) throw new Error('Choose an existing stash.');
      result = await this.run(['stash', 'apply', args.ref]);
    } else if (action === 'discard') {
      if (args.confirmed !== true) throw new Error('Confirm before discarding working changes.');
      const file = await this.safeFile(args.path), entry = state.files.find(item => item.path === file);
      if (args.untracked === true) {
        if (!entry?.untracked) throw new Error('This file is no longer untracked. Refresh Source control before discarding it.');
        await this.discardUntracked(file); result = {stdout:'Untracked file deleted.'};
      } else {
        if (!entry || entry.untracked || entry.conflict || entry.worktree === '.') throw new Error('Only tracked, unstaged changes can be restored. Confirm deletion separately for an untracked file.');
        result = await this.run(['restore', '--worktree', '--', file]);
      }
    } else throw new Error('Unknown Git action.');
    return {message: sanitizeGitOutput((result?.stdout || result?.stderr || 'Git operation completed.').trim()).slice(0, 6000), status: await this.status()};
  }
  async sync(args,state) {
    const remote=state.remotes.find(r=>r.name===(args.remote || state.syncRemote));
    if (!remote) throw new Error('Choose or add a Git remote before syncing.');
    const pushRemotes = this.pushTargets(args, state, remote);
    if (state.detached) throw new Error('Switch to a named branch before syncing.');
    if (state.unborn && !state.files.length) throw new Error('Create an article before committing and syncing this new repository.');
    if (state.privateStaged) throw new Error('Private Weave data is staged. Unstage it before syncing.');
    if (state.files.some(file=>file.conflict)) throw new Error('Resolve and stage conflicted files before syncing.');
    const message = state.files.length || state.merging ? commitMessage(args.message) : undefined;
    const localBranch=refName(state.branch), branch=refName(state.upstream?.startsWith(remote.name+'/')?state.upstream.slice(remote.name.length+1):localBranch);
    let committed=false, phase='commit';
    try {
      if (state.files.length || state.merging) {
        if (state.files.some(file=>file.untracked || file.worktree!=='.')) await this.perform({action:'stageAll'});
        await this.perform({action:'commit',message}); committed=true;
      }
      const before=(await this.run(['rev-parse','HEAD'])).stdout.trim();
      phase='fetch'; await this.run(['fetch','--prune','--',remote.name]);
      const remoteRef='refs/remotes/'+remote.name+'/'+branch;
      const found=await this.run(['show-ref','--verify','--quiet',remoteRef],{allowFailure:true});
      if (!found.code) {
        phase='merge'; await this.run(['merge','--ff','--no-edit','--no-autostash',remoteRef]);
        await this.recordPull(before,remote.name,branch);
      }
      phase='push'; await this.pushToRemotes(state, pushRemotes, remote, branch);
      return {committed,message:committed?'All changes committed and synced.':'Workspace synced.',status:await this.status()};
    } catch(error) {
      const prefix=committed?'Changes were committed locally. ':'';
      throw new Error(prefix+'Sync stopped during '+phase+'. '+(phase==='merge'?'Resolve any merge conflicts in the listed files, stage them, and commit before syncing again. ':'')+error.message);
    }
  }
  async close() {this.closed = true; for (const child of this.children) child.kill(); await this.queue.catch(() => {});}
}
