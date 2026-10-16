import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMarkdownTable,formatMarkdownTable,applyTableOperation,splitTableRow,tableCellPositions,tableCellSource,tableCellText,decodeTablePipes,splitTableCellLines} from '../table-source.mjs';
import {renderNote} from '../render.mjs';
import {parseLinks} from '../links.mjs';

test('table row parsing respects escaped pipes, code delimiters, wiki aliases and Markdown link destinations',()=>{
  const source='| a\\|b | `x|y` | [label](Folder/Target.md "depends-on") | [site](https://example.com/a|b) |';
  assert.deepEqual(splitTableRow(source),[String.raw`a\|b`,'`x|y`','[label](Folder/Target.md "depends-on")','[site](https://example.com/a|b)']);
  for(const [i,position] of tableCellPositions(source,100).entries())assert.equal(source.slice(position-100,position-100+splitTableRow(source)[i].length),splitTableRow(source)[i]);
  assert.deepEqual(splitTableRow('| ``a`|b`` | c |'),['``a`|b``','c']);
  assert.deepEqual(splitTableRow('| `unclosed | c |'),['`unclosed','c'],'unmatched backticks never swallow the rest of a row');
  assert.deepEqual(splitTableRow(String.raw`a\\|b`),[String.raw`a\\`,'b'],'an even backslash count leaves a real separator');
  assert.deepEqual(splitTableRow('| [unmatched | [site](https://example.com) |'),['[unmatched','[site](https://example.com)']);
});

test('parse and format retain every cell, alignment, code span and authored wiki relationship',()=>{
  const source=['| Name | Connection | Amount |','| :--- | :---: | ---: |','| **A** | [old label](Folder/Target.md "reads-from") | `x|y` |','| B | short |'].join('\n');
  const table=parseMarkdownTable(source);
  assert.equal(table.columnCount,3);assert.deepEqual(table.alignments,['left','center','right']);assert.deepEqual(table.rows.at(-1),['B','short','']);
  const formatted=formatMarkdownTable(table),parsed=parseMarkdownTable(formatted);
  assert.deepEqual(parsed.rows,table.rows);assert.deepEqual(parsed.alignments,table.alignments);
  assert.deepEqual(parseLinks(formatted).links.map(link=>[link.target,link.relationship]),parseLinks(source).links.map(link=>[link.target,link.relationship]));
  assert.equal(formatMarkdownTable(parsed),formatted,'canonical formatting is idempotent');
  const extra=parseMarkdownTable('| A | B |\n| --- | --- |\n| one | two | keep me |');
  assert.equal(extra.columnCount,3);assert.equal(parseMarkdownTable(formatMarkdownTable(extra)).rows[1][2],'keep me','over-wide authored rows never lose source cells');
  assert.deepEqual(parseMarkdownTable(formatMarkdownTable(extra,{padded:false})).rows,extra.rows,'minimal edits still keep header and delimiter widths consistent for over-wide body rows');
  assert.equal(formatMarkdownTable(table,{padded:false}),source,'short body rows keep their original formatting without autoformat');
});

test('autoformat pads source columns and keeps at least three dashes inside alignment markers',()=>{
  const table=parseMarkdownTable('| A | XY |\n| :--- | ---: |\n| longer | z |');
  assert.equal(formatMarkdownTable(table),'| A      | XY   |\n| :----- | ---: |\n| longer | z    |');
  const centered=applyTableOperation(parseMarkdownTable('| x |\n| --- |'),{type:'setAlignment',column:0,alignment:'center'});
  assert.equal(formatMarkdownTable(centered),'| x     |\n| :---: |');
});

test('the compact audit-operation table expands to aligned Markdown without changing its content',()=>{
  const source=[
    '| Operation | SQL effect |',
    '| --- | --- |',
    '| `uspAuditOnStepStart` | Inserts `ExecutionLog`, status `STARTED`, if tracing is enabled. |',
    '| `uspAuditOnStepAudit` | Inserts [audit.auditlog](sql-platform/etl-audit/audit.auditlog.md) counts supplied by the transformation. Does not change execution status. |',
    '| `uspAuditOnStepEnd` | Updates the given execution to `COMPLETED`, records end time and `Step completed`. |',
    '| `uspAuditOnPackageError` / `uspAuditOnStepError` | Updates the given execution to `ERROR`, with an error message and end time. Requires an actual call. |',
    "| `uspAuditOnProcessEnd` | Updates the process's last completion timestamp; does not itself complete execution rows. |",
    '| `uspAuditRaiseError` | Raises a severity-15 SQL error to its caller. Does not write an audit table. |',
  ].join('\n');
  const table=parseMarkdownTable(source),formatted=formatMarkdownTable(table),lines=formatted.split('\n');
  assert.notEqual(formatted,source);
  const pipes=lines[0].matchAll(/\|/g).map(match=>match.index).toArray();
  for(const line of lines)assert.deepEqual([...line.matchAll(/\|/g)].map(match=>match.index),pipes,'every source row has aligned column boundaries');
  const cells=lines[1].split('|').slice(1,-1);
  for(const cell of cells)assert.match(cell,/^ -{3,} $/,'separator hyphens fill the padded column');
  assert.deepEqual(parseMarkdownTable(formatted).rows,table.rows,'code spans, article paths and all prose remain unchanged');
  assert.equal(formatMarkdownTable(parseMarkdownTable(formatted)),formatted,'repeated saves do not add padding');
  assert.equal(formatMarkdownTable(table,{padded:false}),source,'disabled autoformat retains the compact source exactly');
});

test('non-autoformatted cell editing preserves untouched bytes and safely stores pipes and newlines',()=>{
  const source='| A  |B |\r\n| ---| :---:|\r\n| one  | two |\r\n';
  const table=parseMarkdownTable(source);
  assert.equal(formatMarkdownTable(table,{padded:false}),source);
  const changed=applyTableOperation(table,{type:'setCell',row:1,column:1,value:'new | value\nnext'});
  assert.equal(formatMarkdownTable(changed,{padded:false}),'| A  |B |\r\n| ---| :---:|\r\n| one  | new \\| value<br>next |\r\n');
  assert.equal(table.rows[1][1],'two','operations leave the original model unchanged');
  assert.equal(tableCellSource(String.raw`already\|escaped`),String.raw`already\|escaped`);
  assert.equal(tableCellSource('`a|b` and [alias](Target.md)'),'`a|b` and [alias](Target.md)');
  assert.equal(decodeTablePipes(String.raw`a\|b and a\\\|b`),String.raw`a|b and a\\|b`);
});

test('row and column operations preserve source content and corresponding alignment',()=>{
  const original=parseMarkdownTable(' A | B\n :--- | ---:\n one | two\n three | four');
  let table=applyTableOperation(original,{type:'insertRow',index:2,values:['new','row']});
  table=applyTableOperation(table,{type:'insertColumn',index:1,alignment:'center',values:['C','x','y','z']});
  assert.deepEqual(table.rows,[['A','C','B'],['one','x','two'],['new','y','row'],['three','z','four']]);
  assert.deepEqual(table.alignments,['left','center','right']);
  const compact=formatMarkdownTable(table,{padded:false});assert(compact.includes(' one | x | two'),'existing cell spaces survive column insertion');
  assert.deepEqual(parseMarkdownTable(compact).rows,table.rows);
  table=applyTableOperation(table,{type:'moveColumn',index:2,delta:-2});
  assert.deepEqual(table.rows[0],['B','A','C']);assert.deepEqual(table.alignments,['right','left','center']);
  table=applyTableOperation(table,{type:'moveRow',index:3,delta:-2});assert.deepEqual(table.rows[1],['four','three','z']);
  table=applyTableOperation(table,{type:'deleteRow',index:2});table=applyTableOperation(table,{type:'deleteColumn',index:2});
  assert.deepEqual(table.rows,[['B','A'],['four','three'],['row','new']]);
  assert.deepEqual(parseMarkdownTable(formatMarkdownTable(table,{padded:false})).rows,table.rows);
  assert.deepEqual(original.rows,[['A','B'],['one','two'],['three','four']]);
});

test('alphabetical sorting uses readable cell text, stays stable for ties, and never sorts the header',()=>{
  const table=parseMarkdownTable('| Name | ID |\n| --- | --- |\n| **banana** | first |\n| [Apple](https://example.com) | second |\n| *apple* | third |\n| `Cherry` | fourth |');
  const sorted=applyTableOperation(table,{type:'sortRows',column:0,direction:'asc'});
  assert.deepEqual(sorted.rows.map(row=>row[1]),['ID','second','third','first','fourth']);
  const descending=applyTableOperation(table,{type:'sortRows',column:0,direction:'desc'});
  assert.deepEqual(descending.rows.map(row=>row[1]),['ID','fourth','first','second','third']);
  assert.equal(tableCellText('[Target label](Folder/Target.md "reads-from")'),'Target label');
  assert.equal(tableCellText('\\*literal\\* and `*code*`'),'*literal* and *code*');
  assert.equal(formatMarkdownTable(sorted,{padded:false}).split('\n')[2],'| [Apple](https://example.com) | second |','sorting moves complete original row formatting');
});

test('invalid table shapes and destructive header or final-column operations are rejected',()=>{
  for(const source of ['ordinary prose','| A | B |\n| --- |','| A | B |\n| no | --- |','| A |\n| --- |\n\nparagraph'])assert.equal(parseMarkdownTable(source),null);
  const table=parseMarkdownTable('| A |\n| --- |\n| value |');
  assert.throws(()=>applyTableOperation(table,{type:'deleteRow',index:0}),/row/);
  assert.throws(()=>applyTableOperation(table,{type:'moveRow',index:1,delta:-1}),/row/);
  assert.throws(()=>applyTableOperation(table,{type:'deleteColumn',index:0}),/at least one/);
  assert.throws(()=>applyTableOperation(table,{type:'setAlignment',column:0,alignment:'url(evil)'}),/alignment/);
});

test('safe table rendering supports alignment, single columns, code pipes, wiki links and line breaks',()=>{
  const source='| Syntax | Link |\n| :--- | ---: |\n| `a|b` and x\\|y | [](Folder/Target.md "depends-on") |';
  const html=renderNote(source,['Folder/Target.md'],true,new Map(),'Source.md',{titles:new Map([['Folder/Target.md','Readable title']])});
  assert.equal((html.match(/<th(?: |\>)/g)||[]).length,2);assert.equal((html.match(/<td(?: |\>)/g)||[]).length,2);
  assert(html.includes('<code>a|b</code> and x|y'));assert(html.includes('style="text-align:right"'));assert(html.includes('Readable title'));assert(!html.includes('@@depends-on'));
  const single=renderNote('| One |\n| :---: |\n| first<br>next `x<br>y` <img src=x onerror=alert(1)> |',[]);
  assert(single.includes('<th style="text-align:center">One</th>'));assert(single.includes('first<br>next <code>x&lt;br&gt;y</code>'));assert(!single.includes('<img'));
  assert.deepEqual(splitTableCellLines('a<br>b `c<br>d`'),['a','b `c<br>d`']);
  const surrounding=renderNote('Paragraph first line\ncontinued line\n| One |\n| --- |\n| Body |\n\nAfter the table.',[]);
  assert(surrounding.includes('<p>Paragraph first line continued line</p>'));
  assert(surrounding.includes('<th>One</th>'));assert(surrounding.endsWith('<p>After the table.</p>'));
});
