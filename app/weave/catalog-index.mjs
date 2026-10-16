// One workspace's catalog as the reader uses it: articles with titles, other
// files and folders. It is built once from a catalog and then changed in place
// by catalog deltas, so typing, saving and rendering never revisit every path:
// links resolve through maps, titles are looked up by path and the Files tree
// sorts only the folders it shows.
import {PathResolver} from './links.mjs';

const parentOf = path => path.split('/').slice(0, -1).join('/');
const stem = path => path.split('/').at(-1).replace(/\.md$/i, '');
const collator = new Intl.Collator();

export class CatalogIndex {
  constructor(tree = {}, {caseSensitive = true} = {}) {
    this.caseSensitive = caseSensitive;
    this.files = new Map(); this.other = new Set(); this.folders = new Set();
    this.children = new Map(); this.sorted = new Map();
    this.resolver = new PathResolver([], {caseSensitive}); this.list = null;
    for (const file of tree.files || []) this.addFile(file.path, file.title);
    for (const file of tree.otherFiles || []) this.addOther(file.path);
    for (const folder of tree.folders || []) this.addFolder(folder);
    // Titles have the shape of a Map lookup: an article's title, else its filename.
    this.titles = {get: path => {const file = this.files.get(path); return file ? file.title || stem(path) : undefined;}};
  }
  /** Article paths. The list keeps its identity until an article is added or removed. */
  get paths() {return this.list ||= [...this.files.keys()];}
  get size() {return this.files.size;}
  has(path) {return this.files.has(path);}
  isFolder(path) {return this.folders.has(path);}
  /** The article whose path matches `path` ignoring case where the workspace does. */
  find(path) {return this.resolver.exact.get(this.resolver.key(path))?.[0] ?? null;}
  link(path) {const parent = parentOf(path); let set = this.children.get(parent); if (!set) this.children.set(parent, set = new Set()); set.add(path); this.sorted.delete(parent);}
  unlink(path) {const parent = parentOf(path), set = this.children.get(parent); if (set?.delete(path)) {this.sorted.delete(parent); if (!set.size) this.children.delete(parent);}}
  addFile(path, title) {
    const known = this.files.get(path);
    if (known) {const changed = (known.title || undefined) !== (title || undefined); known.title = title || undefined; if (changed) {this.sorted.delete(parentOf(path)); this.haystack = null;} return changed;}
    this.forget(path);
    this.files.set(path, {path, title: title || undefined}); this.resolver.add(path); this.link(path); this.list = this.haystack = null;
    return true;
  }
  addOther(path) {if (this.other.has(path)) return false; this.forget(path); this.other.add(path); this.link(path); return true;}
  addFolder(path) {if (this.folders.has(path)) return false; this.forget(path); this.folders.add(path); this.link(path); return true;}
  /** Removes a path of any kind; true when it was listed. */
  forget(path) {
    let found = false;
    if (this.files.delete(path)) {this.resolver.remove(path); this.list = this.haystack = null; found = true;}
    if (this.other.delete(path)) found = true;
    if (this.folders.delete(path)) found = true;
    if (found) this.unlink(path);
    return found;
  }
  /** Applies a `catalogChanges` result. Returns whether paths or titles changed. */
  apply({files = [], otherFiles = [], folders = [], removed = []} = {}) {
    let paths = false, titles = false;
    for (const path of removed) if (this.forget(path)) paths = true;
    for (const folder of folders) if (this.addFolder(folder)) paths = true;
    for (const file of otherFiles) if (this.addOther(file.path)) paths = true;
    for (const file of files) {const added = !this.files.has(file.path); if (this.addFile(file.path, file.title)) {if (added) paths = true; else titles = true;}}
    return {paths, titles, changed: paths || titles};
  }
  /** Up to `limit` article paths whose path or title contains every word,
   * shortest first. The lower-cased text is built on first use and kept until
   * articles or titles change, so each query is one pass without allocation. */
  match(words, limit = 30) {
    if (!this.haystack) {const paths = this.paths; this.haystack = {paths, text: paths.map(path => (path + ' ' + (this.files.get(path)?.title || '')).toLowerCase())};}
    const {paths, text} = this.haystack, found = [];
    for (let i = 0; i < text.length; i++) if (words.every(word => text[i].includes(word))) found.push(paths[i]);
    return found.sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, limit);
  }
  /** A folder's entries, folders first, each sorted by path; cached until the folder changes. */
  childrenOf(parent) {
    let list = this.sorted.get(parent);
    if (!list) {
      list = [...this.children.get(parent) || []].map(path => ({path, folder: this.folders.has(path), other: this.other.has(path), title: this.files.get(path)?.title}));
      list.sort((a, b) => Number(b.folder) - Number(a.folder) || collator.compare(a.path, b.path));
      this.sorted.set(parent, list);
    }
    return list;
  }
}
