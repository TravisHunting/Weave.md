import fs from 'node:fs/promises';
import path from 'node:path';
import {collectionId} from './storage.mjs';
import {relativePath} from './files.mjs';

export class SessionStore {
  constructor(runtime) {this.file = path.join(runtime, 'session.json'); this.queue = Promise.resolve();}
  async read() {
    if (this.state) return this.state;
    try {this.state = JSON.parse(await fs.readFile(this.file, 'utf8'));}
    catch (e) {if (e.code !== 'ENOENT') throw new Error('Cannot read workspace session: ' + e.message); this.state = {lastWorkspace: null, workspaces: {}};}
    this.state.workspaces ||= {}; return this.state;
  }
  async get(root) {return (await this.read()).workspaces[collectionId(root)] || {tabs: [], active: null, source: false};}
  update(action) {
    const job = this.queue.then(async () => {
      const state = await this.read(); action(state);
      await fs.mkdir(path.dirname(this.file), {recursive: true});
      await fs.writeFile(this.file + '.tmp', JSON.stringify(state, null, 2)); await fs.rename(this.file + '.tmp', this.file);
    });
    this.queue = job.catch(() => {}); return job;
  }
  opened(root) {return this.update(state => {state.lastWorkspace = root;});}
  async save(root, value) {
    const tabs = [...new Set((Array.isArray(value.tabs) ? value.tabs : []).map(file => relativePath(file)))].filter(file => /\.md$/i.test(file)).slice(0, 100);
    const session = {tabs, active: tabs.includes(value.active) ? value.active : tabs.at(-1) || null, source: value.source === true};
    if (Array.isArray(value.tabState)) {
      const ids = new Set();
      session.tabState = value.tabState.slice(0, 100).map(tab => {
        if (typeof tab.id !== 'string' || !/^[\w-]{1,80}$/.test(tab.id) || ids.has(tab.id)) throw new Error('Invalid tab identity');
        ids.add(tab.id);
        const file = tab.path == null ? null : relativePath(tab.path);
        const history = (Array.isArray(tab.history) ? tab.history : []).slice(-200).map(p => relativePath(p));
        if ([file, ...history].filter(Boolean).some(p => !/\.md$/i.test(p))) throw new Error('Tabs must contain Markdown paths');
        return {id: tab.id, path: file, history, at: Math.min(history.length - 1, Math.max(-1, Number.isInteger(tab.at) ? tab.at : history.length - 1))};
      });
      session.activeTab = ids.has(value.activeTab) ? value.activeTab : session.tabState.at(-1)?.id || null;
    }
    await this.update(state => {state.workspaces[collectionId(root)] = session;}); return session;
  }
}
