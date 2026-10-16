import test from 'node:test';
import assert from 'node:assert/strict';
import {isMermaidInfo, sourceHash, mermaidConfig, parseColour, mermaidPalettes} from '../mermaid.mjs';
import {normalizeAppearance, readingDefaults} from '../appearance.mjs';
import {renderChatMarkdown} from '../../chat-markdown.mjs';

const lavender = {paper: '#fcfaff', ink: '#36303f', muted: '#70667f', line: '#d9d0e5', accent: '#735494', code: '#eee8f4', wash: '#e8e0f0', bg: '#eeebf2'};
const graphite = {paper: '#292a2d', ink: '#e8eaed', muted: '#b0b3bb', line: '#474950', accent: '#abc4ef', code: '#34363c', wash: '#383e49', bg: '#202124'};

test('Mermaid fences are recognised by their info string', () => {
  for (const info of ['mermaid', 'Mermaid', ' mermaid ', 'mermaid title="x"']) assert.equal(isMermaidInfo(info), true, info);
  for (const info of ['', 'js', 'mermaidjs', 'not mermaid']) assert.equal(isMermaidInfo(info), false, info);
});

test('source hashes are stable and distinguish edits', () => {
  const source = 'flowchart LR\n  A --> B';
  assert.equal(sourceHash(source), sourceHash(source));
  assert.notEqual(sourceHash(source), sourceHash(source + ' '));
  assert.notEqual(sourceHash('ab'), sourceHash('ba'));
});

test('every palette keeps the strict security level and the skin tokens', () => {
  for (const palette of Object.keys(mermaidPalettes)) {
    const config = mermaidConfig({colours: lavender, tokens: {font: 'Georgia, serif', radius: '6px', stroke: '1.5px'}, settings: {palette}});
    assert.equal(config.securityLevel, 'strict', palette);
    assert.equal(config.startOnLoad, false);
    assert.equal(config.fontFamily, 'Georgia, serif');
    assert.match(config.themeCSS, /rx:6px/);
    assert.match(config.themeCSS, /stroke-width:1\.5px/);
  }
});

test('the theme follows the colour scheme, light or dark', () => {
  const light = mermaidConfig({colours: lavender}), dark = mermaidConfig({colours: graphite});
  assert.equal(light.theme, 'base');
  assert.equal(light.themeVariables.darkMode, false);
  assert.equal(dark.themeVariables.darkMode, true);
  assert.equal(light.themeVariables.textColor, lavender.ink);
  assert.equal(dark.themeVariables.background, graphite.paper);
  assert.equal(mermaidConfig({colours: lavender, settings: {palette: 'mermaid'}}).theme, 'default');
  assert.equal(mermaidConfig({colours: graphite, settings: {palette: 'mermaid'}}).theme, 'dark');
});

test('accent, connectors, style and the frame surface change the configuration', () => {
  const base = mermaidConfig({colours: lavender});
  assert.notEqual(mermaidConfig({colours: lavender, settings: {accent: '#2a7ab0'}}).themeVariables.primaryBorderColor, base.themeVariables.primaryBorderColor);
  assert.equal(mermaidConfig({colours: lavender, settings: {curve: 'straight'}}).flowchart.curve, 'linear');
  assert.equal(mermaidConfig({colours: lavender, settings: {curve: 'stepped'}}).flowchart.curve, 'step');
  assert.equal(mermaidConfig({colours: lavender, settings: {look: 'handDrawn'}}).look, 'handDrawn');
  assert.equal(base.look, 'classic');
  assert.equal(base.themeVariables.edgeLabelBackground, lavender.paper, 'without a frame, labels sit on the article');
  assert.equal(mermaidConfig({colours: lavender, tokens: {surface: 'color(srgb 0.9 0.8 0.7)'}}).themeVariables.edgeLabelBackground, '#e6ccb3');
  assert.equal(mermaidConfig({colours: lavender, tokens: {surface: 'rgba(0, 0, 0, 0)'}}).themeVariables.edgeLabelBackground, lavender.paper, 'a transparent frame falls back to the article');
});

test('colours parse from hex, rgb() and computed colour-mix() forms', () => {
  assert.deepEqual(parseColour('#abc'), [170, 187, 204]);
  assert.deepEqual(parseColour('rgb(1, 2, 3)'), [1, 2, 3]);
  assert.equal(parseColour('rgba(1, 2, 3, 0)'), null);
  assert.deepEqual(parseColour('color(srgb 1 0 0.5)'), [255, 0, 127.5]);
  assert.equal(parseColour('var(--x)'), null);
});

test('diagram preferences are normalised with the appearance', () => {
  const defaults = normalizeAppearance().reading;
  assert.equal(defaults.mermaid, true);
  assert.equal(defaults.mermaidPalette, 'scheme');
  assert.equal(defaults.mermaidAccent, null);
  const chosen = normalizeAppearance({reading: {mermaid: false, mermaidPreview: false, mermaidPalette: 'pastel', mermaidAccent: '#AABBCC', mermaidLook: 'handDrawn', mermaidCurve: 'stepped', mermaidFrame: 'plain', mermaidSize: 'natural', mermaidAlign: 'left'}}).reading;
  assert.deepEqual([chosen.mermaid, chosen.mermaidPreview, chosen.mermaidPalette, chosen.mermaidAccent, chosen.mermaidLook, chosen.mermaidCurve, chosen.mermaidFrame, chosen.mermaidSize, chosen.mermaidAlign], [false, false, 'pastel', '#aabbcc', 'handDrawn', 'stepped', 'plain', 'natural', 'left']);
  const invalid = normalizeAppearance({reading: {mermaid: 'no', mermaidPalette: 'neon', mermaidAccent: 'red', mermaidCurve: 'wobbly'}}).reading;
  assert.deepEqual([invalid.mermaid, invalid.mermaidPalette, invalid.mermaidAccent, invalid.mermaidCurve], [readingDefaults.mermaid, 'scheme', null, 'smooth']);
});

test('rendered Markdown marks a fence with its language for diagram previews', () => {
  assert.match(renderChatMarkdown('```mermaid\nflowchart LR\n  A --> B\n```'), /<pre><code data-language="mermaid">flowchart LR\n  A --&gt; B<\/code><\/pre>/);
  assert.match(renderChatMarkdown('```\nplain\n```'), /<pre><code>plain<\/code><\/pre>/);
  assert.match(renderChatMarkdown('```"><x\ncode\n```'), /data-language="&quot;&gt;&lt;x"/);
});
