import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {hash} from './graph.mjs';

export const ignoredNames = new Set(['.weave', '.git', '.agents', '.codex', 'node_modules', 'target', 'dist', 'build', 'test-results']);
export const ignored = file => file.replaceAll('\\', '/').split('/').some(p => ignoredNames.has(p.toLowerCase()) || p.toLowerCase() === 'agents.md' || p.startsWith('.weave-'));
export function relativePath(value, {includeExcluded = false} = {}) {
  if (typeof value !== 'string' || !value || value.length > 2048) throw new Error('Use a workspace-relative path.');
  const relative = value.replaceAll('\\', '/');
  const parts = relative.split('/');
  if (parts.length > 64 || parts.some(p => !p || p === '.' || p === '..' || /[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)) || (!includeExcluded && ignored(relative)) || parts.some(p=>['.git','.weave'].includes(p.toLowerCase()) || p.toLowerCase().startsWith('.weave-'))) throw new Error('That path is reserved or leaves the Markdown workspace.');
  return relative;
}
export async function checkedPath(root, relative, {allowMissing = false, includeExcluded = false} = {}) {
  relative = relativePath(relative, {includeExcluded});
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Linked files and folders are not supported.');
      const real = await fs.realpath(current), within = path.relative(root, real);
      if (within === '..' || within.startsWith('..' + path.sep) || path.isAbsolute(within)) throw new Error('The path leaves the workspace.');
    } catch (e) { if (e.code !== 'ENOENT' || !allowMissing) throw e; }
  }
  return current;
}
export async function revealTarget(root, relative) {
  let target = await checkedPath(root, relative, {allowMissing:true,includeExcluded:true});
  // Deleted Git entries reveal their nearest surviving parent.
  while (target !== root) {
    try {await fs.lstat(target); break;} catch (error) {if (error.code !== 'ENOENT') throw error;}
    target = path.dirname(target);
  }
  return target;
}
export function decode(bytes) {
  const utf16 = bytes[0] === 255 && bytes[1] === 254;
  if (utf16 && bytes.length % 2) throw new Error('Invalid UTF-16 Markdown.');
  const encoding = utf16 ? 'utf16le' : 'utf8';
  let text;
  if (utf16) text = new TextDecoder('utf-16le', {fatal: true}).decode(bytes);
  else text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  return {text, encoding, bom: utf16 || bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]))};
}
export function encode(text, format = {}) {
  const body = Buffer.from(text, format.encoding || 'utf8');
  return format.bom ? Buffer.concat([Buffer.from(format.encoding === 'utf16le' ? [255, 254] : [239, 187, 191]), body]) : body;
}
export async function readNote(root, relative) {
  if (!/\.md$/i.test(relative)) throw new Error('Only Markdown notes can be read.');
  const full = await checkedPath(root, relative), stat = await fs.stat(full);
  if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('Notes must be ordinary Markdown files, at most 4 MB.');
  const bytes = await fs.readFile(full);
  if (bytes.length > 4 * 1024 * 1024) throw new Error('Note exceeds 4 MB.');
  return {path: relative, ...decode(bytes), hash: hash(bytes), mtime: stat.mtimeMs, size: bytes.length};
}
export async function atomicWrite(root, relative, text, expectedHash, format) {
  if (!/\.md$/i.test(relative) || Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Choose a Markdown note of at most 4 MB.');
  const full = await checkedPath(root, relative, {allowMissing: true});
  const verify = async () => {
    let current = null;
    try { current = hash(await fs.readFile(full)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (current !== expectedHash) throw new Error('This note changed outside Weave. Your draft is retained. Reload the disk version or copy your draft before resolving the conflict.');
  };
  await verify();
  const temporary = path.join(path.dirname(full), '.weave-' + randomUUID() + '.tmp');
  const handle = await fs.open(temporary, 'wx');
  try {
    const bytes = encode(text, format); await handle.writeFile(bytes); await handle.sync(); await handle.close();
    await checkedPath(root, relative, {allowMissing: true}); await verify();
    if (expectedHash === null) { await fs.link(temporary, full); await fs.unlink(temporary); }
    else await fs.rename(temporary, full);
    return await readNote(root, relative);
  } finally { await handle.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
}
export async function scanTree(root) {
  const files = [], otherFiles = [], folders = [], warnings = []; let total = 0;
  async function visit(directory, prefix = '', depth = 0) {
    if (depth > 64) { warnings.push('Folder nesting exceeds 64: ' + prefix); return; }
    const entries = await fs.readdir(directory, {withFileTypes: true});
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + entry.name;
      if (ignored(relative) || entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { folders.push(relative); await visit(full, relative + '/', depth + 1); }
      else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        try {
          const stat = await fs.stat(full); total += stat.size;
          if (files.length >= 50000 || total > 512 * 1024 * 1024) throw new Error('Workspace exceeds 50,000 notes or 512 MB.');
          files.push({path: relative, mtime: stat.mtimeMs, size: stat.size});
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
      } else if (entry.isFile() && otherFiles.length < 50000) otherFiles.push({path: relative});
    }
  }
  await visit(root); return {files, otherFiles, folders, warnings};
}
export async function detectCaseSensitivity(root) {
  // No probe is written into the user's Markdown workspace.
  const base = path.basename(root), toggled = base.replace(/[a-zA-Z]/, c => c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());
  if (base !== toggled) {
    try { const a = await fs.stat(root), b = await fs.stat(path.join(path.dirname(root), toggled)); return a.ino !== b.ino || a.dev !== b.dev; } catch (e) { if (e.code === 'ENOENT') return true; }
  }
  return process.platform !== 'win32';
}
export async function prepareRuntime(directory) {
  try {
    await fs.mkdir(directory, {recursive: true});
    const probe = path.join(directory, '.write-' + randomUUID());
    const handle = await fs.open(probe, 'wx'); await handle.writeFile('Weave'); await handle.sync(); await handle.close(); await fs.unlink(probe);
    for (const folder of ['graphs', 'operations', 'trash']) await fs.mkdir(path.join(directory, folder), {recursive: true});
  } catch (e) { throw new Error('Cannot write Weave data at ' + directory + ': ' + e.message); }
}
export async function acquireRuntimeLock(directory) {
  const file = path.join(directory, 'runtime.lock'), token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {const handle = await fs.open(file, 'wx'); await handle.writeFile(JSON.stringify({pid: process.pid, token})); await handle.sync(); await handle.close();
      return async () => {try {if (JSON.parse(await fs.readFile(file, 'utf8')).token === token) await fs.unlink(file);} catch {}};
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let previous; try {previous = JSON.parse(await fs.readFile(file, 'utf8'));} catch {throw new Error('Weave is starting or its runtime.lock needs recovery. Close other Weave instances before removing that lock.');}
      if (!Number.isInteger(previous.pid) || previous.pid < 1) throw new Error('Invalid runtime.lock. Close Weave and remove the lock file to recover.');
      try {process.kill(previous.pid, 0);} catch (error) {if (error.code === 'ESRCH') {await fs.unlink(file);continue;}}
      throw new Error('Another Weave instance is using this data folder. Close it before opening this copy.');
    }
  }
  throw new Error('Could not acquire the Weave runtime lock.');
}
