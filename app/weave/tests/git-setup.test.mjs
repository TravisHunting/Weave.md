import assert from 'node:assert/strict';
import test from 'node:test';
import {sshRemote, deployKeyPage} from '../git-setup.mjs';
import {createHttpClient} from '../http-client.mjs';

test('pasted repository addresses become SSH remotes for deploy keys', () => {
  const github = {url: 'git@github.com:you/notes.git', host: 'github.com', path: 'you/notes'};
  for (const input of ['https://github.com/you/notes', 'https://github.com/you/notes.git', 'https://github.com/you/notes/', 'https://github.com/you/notes/tree/main/docs', 'git@github.com:you/notes.git', 'you/notes', ' you/notes.git ']) assert.deepEqual(sshRemote(input), github, input);
  assert.deepEqual(sshRemote('https://gitlab.example.org/team/sub/wiki'), {url: 'git@gitlab.example.org:team/sub/wiki.git', host: 'gitlab.example.org', path: 'team/sub/wiki'});
  assert.equal(sshRemote('ssh://git@example.org/team/notes').url, 'ssh://git@example.org/team/notes.git');
  for (const input of ['', 'notes', 'file:///srv/notes', 'https://github.com/', 'https://user:secret@github.com/you/notes', 'https://github.com/you/notes?token=1', 'ext::sh -c touch']) assert.equal(sshRemote(input), null, input);
});

test('deploy-key links open the repository settings on GitHub and GitLab only', () => {
  assert.equal(deployKeyPage(sshRemote('you/notes')).url, 'https://github.com/you/notes/settings/keys/new');
  assert.equal(deployKeyPage(sshRemote('https://gitlab.com/team/notes')).site, 'GitLab');
  assert.equal(deployKeyPage(sshRemote('https://git.example.org/team/notes')), null);
  assert.equal(deployKeyPage(null), null);
});

test('browsers create server workspaces by folder name', async () => {
  const requests = [], values = new Map();
  const fetch = async (url, request) => {
    if (url === '/auth/status') return {ok: true, json: async () => ({authenticated: true, csrf: 'c'})};
    const {op, args} = JSON.parse(request.body); requests.push([op, args]);
    const value = op === 'health' ? {instance: 'i', capabilities: {write: true, git: true, session: true, workspaces: true, storage: true, resources: true}} : op === 'serverOpen' ? {scope: 4, workspace: {id: 'kb-new', name: args.name}} : {};
    return {ok: true, json: async () => value};
  };
  const storage = {getItem: k => values.get(k) || null, setItem: (k, v) => values.set(k, v)};
  const client = await createHttpClient({fetch, storage, durable: storage});
  assert.equal(client.capabilities.git, true);
  const created = await client.createWorkspace('Team notes');
  assert.deepEqual(requests.at(-1), ['serverOpen', {name: 'Team notes', create: true}]);
  assert.equal(created.workspace.id, 'kb-new'); assert.equal(client.workspace.id, 'kb-new');
});
