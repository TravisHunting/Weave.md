import fs from 'node:fs/promises';
import {watch} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {hash} from './graph.mjs';
import {logicalPath} from './platform.mjs';
import {checkedPath, relativePath, readNote, atomicWrite, scanTree, detectCaseSensitivity, ignored} from './files.mjs';

const relative = (value, kind = 'file') => relativePath(logicalPath(value, kind).slice(1));

/** Desktop implementation of the workspace storage port. Public paths start at
 * the logical workspace '/', regardless of where/how the provider stores data.
 * Only this implementation resolves those paths to physical files. Recoverable
 * multi-file transactions are a provider responsibility, not a reader concern. */
export class DirectoryStorage {
  constructor(runtime) {this.runtime = runtime;}
  async open(location) {
    this.root = await fs.realpath(location);
    if (!(await fs.stat(this.root)).isDirectory()) throw new Error('Choose a Markdown workspace folder.');
    this.caseSensitive = await detectCaseSensitivity(this.root);
    return {identity: this.root, displayPath: this.root, nativeDirectory: this.root, caseSensitive: this.caseSensitive};
  }
  scan() {return scanTree(this.root);}
  read(file) {return readNote(this.root, relative(file));}
  write(file, text, expectedHash, format) {return atomicWrite(this.root, relative(file), text, expectedHash, format);}
  async create(file, directory = false, text = null) {
    const name = relative(file, directory ? 'directory' : 'file');
    if (directory) await fs.mkdir(await checkedPath(this.root, name, {allowMissing: true}));
    else await atomicWrite(this.root, name, text ?? '# ' + path.basename(name).replace(/\.md$/i, '').replace(/([\\`*_\[\]<>])/g, '\\$1') + '\n\n', null);
  }
  subscribe(changed, failed) {
    const watcher = watch(this.root, {recursive: true}, (_event, file) => {
      if (file && ignored(String(file))) return;
      changed(file ? '/' + String(file).replaceAll('\\', '/') : null);
    });
    watcher.on('error', failed);
    return {close: () => watcher.close()};
  }
  async manifest(full) {
    const entries = [];
    const visit = async (current, logical = '') => {
      const stat = await fs.lstat(current); if (stat.isSymbolicLink()) throw new Error('Moving or deleting folders containing linked paths is not supported.');
      if (stat.isDirectory()) {entries.push([logical, 'folder']); for (const name of (await fs.readdir(current)).sort()) await visit(path.join(current, name), logical + '/' + name);}
      else entries.push([logical, hash(await fs.readFile(current))]);
    };
    await visit(full); return JSON.stringify(entries);
  }
  async prepareMove(sourcePath, destinationPath) {
    const from = relative(sourcePath, 'entry'), to = relative(destinationPath, 'entry');
    const source = await checkedPath(this.root, from), stat = await fs.stat(source);
    if (!stat.isDirectory() && /\.md$/i.test(from) && !/\.md$/i.test(to)) throw new Error('Keep the .md extension when renaming a note.');
    const dest = await checkedPath(this.root, to, {allowMissing: true});
    try {const existing = await fs.stat(dest); if (existing.ino !== stat.ino || existing.dev !== stat.dev || this.caseSensitive) throw new Error('The destination already exists.');} catch (e) {if (e.code !== 'ENOENT') throw e;}
    return {from, to, manifest: await this.manifest(source)};
  }
  async move(plan, {changes, updateLinks}) {
    const source = await checkedPath(this.root, plan.from), dest = await checkedPath(this.root, plan.to, {allowMissing: true});
    if (await this.manifest(source) !== plan.manifest) throw new Error('The resource changed since the rename preview. Preview it again.');
    if (updateLinks) for (const change of changes) if ((await this.read(change.path)).hash !== change.original.hash) throw new Error('An affected note changed. Preview the rename again.');
    const recovery = path.join(this.runtime, 'operations', randomUUID()); await fs.mkdir(recovery);
    // Keep desktop recovery journals compatible with the existing relative
    // Markdown paths, while the storage port receives only logical paths.
    const journalChanges = changes.map(change => ({...change, path: relative(change.path), nextPath: relative(change.nextPath), original: {...change.original, path: relative(change.original.path)}}));
    const journal = {state: 'prepared', root: this.root, from: plan.from, to: plan.to, updateLinks, changes: journalChanges};
    await fs.writeFile(path.join(recovery, 'journal.json'), JSON.stringify(journal, null, 2));
    const applied = []; let moved = false;
    try {
      const intermediate = path.join(path.dirname(source), '.weave-move-' + randomUUID());
      await fs.rename(source, intermediate);
      try {if (await fs.lstat(dest).then(() => true, e => {if (e.code === 'ENOENT') return false; throw e;})) throw new Error('Destination appeared during rename.'); await fs.rename(intermediate, dest);}
      catch (e) {await fs.rename(intermediate, source); throw e;}
      moved = true;
      if (updateLinks) for (const change of changes) {
        const written = await this.write(change.nextPath, change.text, change.original.hash, change.original); applied.push({change, hash: written.hash});
      }
      journal.state = 'complete'; await fs.writeFile(path.join(recovery, 'journal.json'), JSON.stringify(journal, null, 2));
    } catch (e) {
      const failures = [];
      for (const item of applied.reverse()) try {await this.write(item.change.nextPath, item.change.original.text, item.hash, item.change.original);} catch (failure) {failures.push(failure.message);}
      if (moved && !failures.length) try {await fs.rename(dest, source);} catch (failure) {failures.push(failure.message);}
      journal.state = failures.length ? 'recovery-needed' : 'rolled-back'; journal.error = e.message; journal.failures = failures;
      await fs.writeFile(path.join(recovery, 'journal.json'), JSON.stringify(journal, null, 2));
      throw new Error(e.message + ' Recovery journal: ' + recovery + (failures.length ? '. Manual recovery required: ' + failures.join('; ') : '. Changes rolled back.'));
    }
    return {recovery};
  }
  async delete(file) {
    const name = relative(file, 'entry'), full = await checkedPath(this.root, name), original = await this.manifest(full);
    const trash = path.join(this.runtime, 'trash', randomUUID()); await fs.mkdir(trash);
    await fs.cp(full, path.join(trash, path.basename(full)), {recursive: true, errorOnExist: true});
    if (await this.manifest(full) !== original) throw new Error('The resource changed while making its recovery copy. Nothing was deleted.');
    await fs.writeFile(path.join(trash, 'restore.json'), JSON.stringify({root: this.root, path: name}));
    await checkedPath(this.root, name); await fs.rm(full, {recursive: true}); return {recovery: trash};
  }
}
