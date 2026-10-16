import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Workspace} from '../workspace.mjs';
import {parseLinks, rewriteTargets} from '../links.mjs';
import {renderNote} from '../render.mjs';
import {noteMetadata} from '../metadata.mjs';

test('Markdown links keep labels, literal identifiers, annotations and rename offsets', () => {
  const text='[under_score](/Systems/under_score.md "Writes_To") and `[Ignored](Ignored.md "no")` and [spaced](<../Systems/under_score.md>)';
  const links=parseLinks(text,'Notes/Source.md').links;assert.equal(links.length,2);assert.equal(links[0].relationship,'writes-to');
  const changes=new Map([['Systems/under_score.md','New Folder/New.md']]);
  assert.equal(rewriteTargets(text,links.map(link=>({...link,resolvedPath:'Systems/under_score.md'})),changes,{source:'Notes/Source.md'}),'[under_score](</New Folder/New.md> "Writes_To") and `[Ignored](Ignored.md "no")` and [spaced](<../New Folder/New.md>)','each link keeps its bundle-relative or relative form; spaces use angle brackets');
  assert.equal(rewriteTargets('[A](../Systems/a.md) [B](/Systems/a.md)',parseLinks('[A](../Systems/a.md) [B](/Systems/a.md)','Notes/Source.md').links.map(link=>({...link,resolvedPath:'Systems/a.md'})),new Map(),{source:'Notes/Source.md',nextSource:'Notes/Deep/Source.md'}),'[A](../../Systems/a.md) [B](/Systems/a.md)','moving the source rewrites only its relative links');
  const html=renderNote(text+' PROD.SYSTEM.SALES_ANALYTICS ls_sql_sales_dataplatform',['Systems/under_score.md']);assert(!html.includes('<em>'));assert(html.includes('under_score'));assert(!html.includes('writes-to'));assert.equal(noteMetadata('# Other title','file_name.md').title,'Other title');
});
