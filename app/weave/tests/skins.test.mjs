import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {skins,defaultSkin,skinStylesheets,normalizeSkin,skinChain} from '../skins.mjs';
import {normalizeAppearance,saveColourScheme,colorFields} from '../appearance.mjs';

const dir = path.join(import.meta.dirname, '..');
const read = file => fs.readFile(path.join(dir, file), 'utf8');
const contractTokens = async () => new Set([...(await read('skin-contract.css')).matchAll(/^\s*(--[\w-]+):/gm)].map(match => match[1]));
// Top-level rules of a stylesheet as [selector list, declarations].
const rules = css => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => [match[1].trim(), match[2]]);
// Splits a selector list at top-level commas (not those inside :is(...) etc.).
const selectors = list => {
  const parts = []; let depth = 0, current = '';
  for (const char of list) {
    if (char === '(') depth++; else if (char === ')') depth--;
    if (char === ',' && !depth) {parts.push(current.trim()); current = '';} else current += char;
  }
  return [...parts, current.trim()].filter(Boolean);
};

test('the skin registry is valid and every skin but Classic ships a stylesheet', async () => {
  assert.equal(defaultSkin, 'aurora-flow');
  assert(Object.keys(skins).length >= 4);
  for (const [id, skin] of Object.entries(skins)) {
    assert.match(id, /^[a-z]+(-[a-z]+)*$/);
    assert(skin.name && skin.description, id + ' has a name and description');
    assert(!/[<>"`]/.test(skin.name + skin.description), id + ' text is safe in markup');
  }
  assert.deepEqual(skinStylesheets, Object.keys(skins).filter(id => id !== 'classic').map(id => `skins/${id}.css`));
  for (const file of skinStylesheets) await fs.access(path.join(dir, file));
  // A skin extends only an earlier, non-Classic skin, so its stylesheet loads after its base's.
  const order = Object.keys(skins);
  for (const [id, skin] of Object.entries(skins)) if (skin.extends) {
    assert(order.indexOf(skin.extends) >= 1 && order.indexOf(skin.extends) < order.indexOf(id), id + ' extends an earlier skin');
  }
  assert.deepEqual(skinChain('aurora-flow'), ['aurora', 'aurora-thin', 'aurora-flow']);
  assert.deepEqual(skinChain('classic'), ['classic']);
  assert.deepEqual(skinChain('nonsense'), ['aurora', 'aurora-thin', 'aurora-flow']);
  const files = (await fs.readdir(path.join(dir, 'skins'))).filter(name => name.endsWith('.css')).map(name => 'skins/' + name);
  assert.deepEqual(files.sort(), [...skinStylesheets].sort(), 'no unregistered skin stylesheets');
});

test('skins are scoped to themselves, never set palette colours and only set contract or private tokens', async () => {
  const contract = await contractTokens(), palette = new Set(Object.keys(colorFields).map(key => '--' + key));
  for (const file of skinStylesheets) {
    const id = path.basename(file, '.css'), css = await read(file), own = new Set();
    for (const [list, body] of rules(css)) {
      for (const selector of selectors(list)) assert(selector.startsWith(`:root[data-skin~=${id}]`) || selector.startsWith(`.skin-preview[data-preview~=${id}]`), `${file}: unscoped selector ${selector}`);
      for (const [, token] of body.matchAll(/(--[\w-]+)\s*:/g)) {
        assert(!palette.has(token), `${file} sets the palette colour ${token}; colour schemes own the palette`);
        if (!contract.has(token)) own.add(token);
      }
      assert(!/style\s*=/.test(body));
    }
    for (const token of own) assert(css.includes(`var(${token}`), `${file}: ${token} is neither a contract token nor used by the skin`);
  }
});

test('the base stylesheets resolve every contract token they use', async () => {
  const contract = await contractTokens();
  const css = (await Promise.all(['styles.css', 'workspace.css', 'git.css', 'appearance.css', 'graph.css', 'sidebars.css', 'table-editor.css', 'kanban.css', 'titlebar-tabs.css'].map(read))).join('\n');
  const tokenish = /^--(radius-|shadow-|surface-|ui-|display-font|panel-title-|titlebar-height|footer-height|rail-|tab-(height|font-size|indicator|max-width|title-max-width|curve)|scrollbar-|native-scrollbar-|tree-(row-height|font-size)|sidebar-padding|control-|divider|gutter|indent-guide|app-background|overlay-filter|icon-stroke|danger|warning|edit-|search-match|diff-|pane-bar-)/;
  for (const [, token] of css.matchAll(/var\((--[\w-]+)/g)) if (tokenish.test(token)) assert(contract.has(token), token + ' is defined in skin-contract.css');
});

test('the skin is part of appearance, validated, and not stored in colour schemes', () => {
  assert.equal(normalizeAppearance().skin, 'aurora-flow');
  assert.equal(normalizeAppearance({skin: 'aurora'}).skin, 'aurora');
  for (const bad of ['toString', 'url(x)', 42, null]) assert.equal(normalizeAppearance({skin: bad}).skin, 'aurora-flow');
  assert.equal(normalizeSkin('__proto__'), 'aurora-flow');
  const appearance = normalizeAppearance({preset: 'ocean', skin: 'studio'});
  assert.deepEqual(normalizeAppearance(JSON.parse(JSON.stringify(appearance))), appearance);
  assert.equal(saveColourScheme([], 'Night', appearance)[0].skin, undefined);
});
