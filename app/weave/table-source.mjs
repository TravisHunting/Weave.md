// Pure Markdown table model. Cells contain inline Markdown source, including
// escapes; source layout is retained separately for edits without autoformat.
const alignmentNames = new Set([null, 'left', 'center', 'right']);
const escaped = (text, index) => {let i=index;while(i>0&&text[i-1]==='\\')i--;return (index-i)%2===1;};

function inlineEnd(text, start) {
  if (text[start] === '`' && !escaped(text,start)) {
    let end=start;while(text[end]==='`')end++;
    const count=end-start;
    for(let i=end;i<text.length;) {
      if(text[i]!=='`'){i++;continue;}
      let next=i;while(text[next]==='`')next++;
      if(next-i===count)return next;
      i=next;
    }
  }
  if(text.startsWith('[[',start)&&!escaped(text,start)) {
    for(let i=start+2;i<text.length-1;i++)if(text.startsWith(']]',i)&&!escaped(text,i))return i+2;
  }
  if(text[start]==='['&&!escaped(text,start)) {
    let brackets=1,label=-1;
    for(let i=start+1;i<text.length;i++) {
      if(escaped(text,i))continue;
      if(text[i]==='[')brackets++;
      if(text[i]===']'&&!--brackets){label=text[i+1]==='('?i:-1;break;}
    }
    if(label!==-1) {
      let depth=1;
      for(let i=label+2;i<text.length;i++) {
        if(escaped(text,i))continue;
        if(text[i]==='(')depth++;
        if(text[i]===')'&&!--depth)return i+1;
      }
    }
  }
  return start;
}

function pipePositions(text) {
  const positions=[];
  for(let i=0;i<text.length;i++) {
    const end=inlineEnd(text,i);
    if(end>i){i=end-1;continue;}
    if(text[i]==='|'&&!escaped(text,i))positions.push(i);
  }
  return positions;
}

function lineLayout(line) {
  const pipes=pipePositions(line), allPipes=[...pipes];let start=0,end=line.length,prefix='',suffix='';
  if(pipes.length&&!line.slice(0,pipes[0]).trim()){start=pipes.shift()+1;prefix=line.slice(0,start);}
  if(pipes.length&&!line.slice(pipes.at(-1)+1).trim()){end=pipes.pop();suffix=line.slice(end);}
  const cells=[];
  for(const stop of [...pipes,end]) {
    const raw=line.slice(start,stop),leading=raw.match(/^[ \t]*/)[0],trailing=raw.slice(leading.length).match(/[ \t]*$/)[0];
    const value=raw.slice(leading.length,raw.length-trailing.length);
    cells.push({value,leading,trailing,start:start+leading.length,end:stop-trailing.length});start=stop+1;
  }
  return {line,prefix,suffix,cells,hasPipe:allPipes.length>0};
}

export function splitTableRow(line) {return lineLayout(String(line)).cells.map(cell=>cell.value);}
export function tableCellPositions(line, offset=0) {return lineLayout(String(line)).cells.map(cell=>offset+cell.start);}
export function hasTablePipes(line) {return pipePositions(String(line)).length>0;}

export function decodeTablePipes(value) {
  return String(value).replace(/(\\+)\|/g,(match,slashes)=>slashes.length%2 ? slashes.slice(1)+'|' : match);
}

export function splitTableCellLines(value, decodePipes=true) {
  const text=decodePipes?decodeTablePipes(value):String(value),parts=[];let start=0;
  for(let i=0;i<text.length;i++) {
    const end=inlineEnd(text,i);if(end>i){i=end-1;continue;}
    const br=text.slice(i).match(/^<br\s*\/?\s*>/i);
    if(br&&!escaped(text,i)){parts.push(text.slice(start,i));i+=br[0].length-1;start=i+1;}
  }
  parts.push(text.slice(start));return parts;
}

export const tableCellInput = value => splitTableCellLines(value,false).join('\n');

export function tableCellSource(value) {
  const text=String(value??'').replace(/\r\n?|\n/g,'<br>');let result='';
  for(let i=0;i<text.length;i++) {
    const end=inlineEnd(text,i);
    if(end>i){result+=text.slice(i,end);i=end-1;continue;}
    result+=(text[i]==='|'&&!escaped(text,i)?'\\':'')+text[i];
  }
  return result.trim();
}

const alignment = value => value.startsWith(':') ? value.endsWith(':') ? 'center' : 'left' : value.endsWith(':') ? 'right' : null;
const cloneLayout = layout => layout&&({...layout,cells:layout.cells.map(cell=>({...cell}))});
const clone = table => ({...table,rows:table.rows.map(row=>[...row]),alignments:[...table.alignments],_rows:table._rows?.map(cloneLayout),_separator:cloneLayout(table._separator)});
const blankCell = () => ({value:'',leading:' ',trailing:' '});
const checkAlignment = value => {if(!alignmentNames.has(value))throw new Error('Choose left, center, right or default table alignment.');return value;};

export function parseMarkdownTable(text) {
  text=String(text??'');const newline=text.includes('\r\n')?'\r\n':'\n',trailing=text.match(/(?:\r?\n)+$/)?.[0]||'';
  const lines=(trailing?text.slice(0,-trailing.length):text).split(/\r?\n/);
  if(lines.length<2||lines.some(line=>!line.trim()))return null;
  const layouts=lines.map(lineLayout),header=layouts[0],separator=layouts[1];
  if(!header.hasPipe&&!separator.hasPipe)return null;
  if(separator.cells.length!==header.cells.length||!separator.cells.every(cell=>/^:?-{3,}:?$/.test(cell.value)))return null;
  if(layouts.slice(2).some(row=>!row.hasPipe))return null;
  const rowLayouts=[header,...layouts.slice(2)],columnCount=Math.max(...rowLayouts.map(row=>row.cells.length));
  const rows=rowLayouts.map(row=>Array.from({length:columnCount},(_,i)=>row.cells[i]?.value||''));
  return {rows,columnCount,alignments:Array.from({length:columnCount},(_,i)=>separator.cells[i]?alignment(separator.cells[i].value):null),
    newline,trailing,indent:lines[0].match(/^[ \t]*/)[0],_rows:rowLayouts,_separator:separator};
}

function delimiter(align,width=3) {
  checkAlignment(align);
  const left=align==='left'||align==='center'?':':'',right=align==='right'||align==='center'?':':'';
  return left+'-'.repeat(Math.max(3,width-left.length-right.length))+right;
}

function minimalLine(values, layout, preserveShort=false) {
  if(!layout)return '| '+values.join(' | ')+' |';
  if(typeof layout.line==='string'&&(values.length===layout.cells.length||preserveShort&&values.length>layout.cells.length)&&values.every((value,i)=>value===(layout.cells[i]?.value||'')))return layout.line;
  const cells=values.map((value,i)=>{const style=layout.cells[i]||blankCell();return style.leading+value+style.trailing;});
  let prefix=layout.prefix,suffix=layout.suffix;
  if(cells.length===1&&!prefix&&!suffix){prefix='|';suffix='|';}
  return prefix+cells.join('|')+suffix;
}

function validateModel(table) {
  if(!table||!Number.isInteger(table.columnCount)||table.columnCount<1||!Array.isArray(table.rows)||!table.rows.length)throw new Error('A Markdown table needs a header and at least one column.');
  if(!Array.isArray(table.alignments)||table.alignments.length!==table.columnCount)throw new Error('Each table column needs an alignment setting.');
  if(table.rows.some(row=>!Array.isArray(row)||row.length>table.columnCount))throw new Error('Table rows must fit their columns.');
  table.alignments.forEach(checkAlignment);
}

export function formatMarkdownTable(table,{padded=true}={}) {
  validateModel(table);
  const rows=table.rows.map(row=>Array.from({length:table.columnCount},(_,i)=>tableCellSource(row[i])));
  let lines;
  if(padded) {
    const widths=table.alignments.map((align,column)=>Math.max(delimiter(align).length,...rows.map(row=>row[column].length)));
    const line=values=>(table.indent||'')+'| '+values.map((value,column)=>value.padEnd(widths[column])).join(' | ')+' |';
    lines=[line(rows[0]),line(table.alignments.map((align,column)=>delimiter(align,widths[column]))),...rows.slice(1).map(line)];
  } else {
    const separators=table.alignments.map((align,column)=>{
      const original=table._separator?.cells[column]?.value;
      return original&&/^:?-{3,}:?$/.test(original)&&alignment(original)===align?original:delimiter(align,original?.length);
    });
    lines=[minimalLine(rows[0],table._rows?.[0]),minimalLine(separators,table._separator),...rows.slice(1).map((row,i)=>minimalLine(row,table._rows?.[i+1],true))];
  }
  return lines.join(table.newline||'\n')+(table.trailing||'');
}

function index(value,min,max,name) {
  if(!Number.isInteger(value)||value<min||value>max)throw new Error('Invalid table '+name+'.');return value;
}
function expandedLayout(layout, count) {
  const result=cloneLayout(layout)||{prefix:'|',suffix:'|',cells:[],line:''};
  while(result.cells.length<count)result.cells.push(blankCell());
  // Structural operations invalidate exact whole-line reuse, while preserving
  // each remaining cell's whitespace and the original outer-pipe style.
  result.line=null;return result;
}
function move(items,from,to){const [item]=items.splice(from,1);items.splice(to,0,item);}

export function tableCellText(source) {
  const literals=[];let text=String(source??'');
  const literal=value=>`\u0000${literals.push(value)-1}\u0000`;
  text=text.replace(/(`+)([\s\S]*?)\1/g,(_,ticks,value)=>literal(decodeTablePipes(value).trim()));
  text=text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g,(_,value)=>literal(value));
  text=text.replace(/!?\[([^\]]*)\]\((?:<[^>]*>|[^)]*)\)(?:@@[\p{L}\p{N}_-]+)?/gu,'$1').replace(/!?\[([^\]]*)\]\[[^\]]*\]/g,'$1');
  text=text.replace(/<br\s*\/?\s*>/gi,' ').replace(/[*_~`]/g,'');
  text=text.replace(/&(?:amp|lt|gt|quot|apos|#39|nbsp);/gi,entity=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&#39;':"'",'&nbsp;':' '}[entity.toLowerCase()]));
  return text.replace(/\u0000(\d+)\u0000/g,(_,i)=>literals[Number(i)]).replace(/\s+/g,' ').trim();
}

export function applyTableOperation(table,operation) {
  validateModel(table);const next=clone(table),op=operation||{},columns=next.columnCount;
  switch(op.type) {
    case 'setCell': {
      const row=index(op.row,0,next.rows.length-1,'row'),column=index(op.column,0,columns-1,'column');
      next.rows[row][column]=tableCellSource(op.value);break;
    }
    case 'insertRow': {
      const at=index(op.index,1,next.rows.length,'row');
      if(op.values?.length>columns)throw new Error('The new row has more cells than the table.');
      next.rows.splice(at,0,Array.from({length:columns},(_,i)=>tableCellSource(op.values?.[i])));
      next._rows||=[];const style=expandedLayout(next._rows[Math.min(at,next._rows.length-1)],columns);
      style.cells=style.cells.map(cell=>({...cell,value:''}));next._rows.splice(at,0,style);break;
    }
    case 'deleteRow': {const at=index(op.index,1,next.rows.length-1,'row');next.rows.splice(at,1);next._rows?.splice(at,1);break;}
    case 'insertColumn': {
      const at=index(op.index,0,columns,'column');next.alignments.splice(at,0,checkAlignment(op.alignment??null));
      next.rows.forEach((row,i)=>row.splice(at,0,tableCellSource(op.values?.[i])));
      next._rows=next.rows.map((row,i)=>{const style=expandedLayout(next._rows?.[i],columns);style.cells.splice(at,0,blankCell());return style;});
      next._separator=expandedLayout(next._separator,columns);next._separator.cells.splice(at,0,{...blankCell(),value:'---'});next.columnCount++;break;
    }
    case 'deleteColumn': {
      if(columns===1)throw new Error('Keep at least one table column.');const at=index(op.index,0,columns-1,'column');
      next.alignments.splice(at,1);next.rows.forEach(row=>row.splice(at,1));
      next._rows=next.rows.map((row,i)=>{const style=expandedLayout(next._rows?.[i],columns);style.cells.splice(at,1);return style;});
      next._separator=expandedLayout(next._separator,columns);next._separator.cells.splice(at,1);next.columnCount--;break;
    }
    case 'moveRow': {const from=index(op.index,1,next.rows.length-1,'row'),to=index(from+op.delta,1,next.rows.length-1,'row');move(next.rows,from,to);if(next._rows)move(next._rows,from,to);break;}
    case 'moveColumn': {
      const from=index(op.index,0,columns-1,'column'),to=index(from+op.delta,0,columns-1,'column');
      next.rows.forEach(row=>move(row,from,to));move(next.alignments,from,to);
      next._rows=next.rows.map((row,i)=>{const style=expandedLayout(next._rows?.[i],columns);move(style.cells,from,to);return style;});
      next._separator=expandedLayout(next._separator,columns);move(next._separator.cells,from,to);break;
    }
    case 'setAlignment': {next.alignments[index(op.column,0,columns-1,'column')]=checkAlignment(op.alignment??null);break;}
    case 'sortRows': {
      const column=index(op.column,0,columns-1,'column'),direction=op.direction==='desc'?-1:1,collator=new Intl.Collator(undefined,{sensitivity:'base'});
      const key=typeof op.getText==='function'?op.getText:tableCellText;
      const sorted=next.rows.slice(1).map((row,i)=>({row,style:next._rows?.[i+1],order:i,key:key(row[column])})).sort((a,b)=>direction*collator.compare(a.key,b.key)||a.order-b.order);
      next.rows=[next.rows[0],...sorted.map(item=>item.row)];if(next._rows)next._rows=[next._rows[0],...sorted.map(item=>item.style)];break;
    }
    default: throw new Error('Unknown table operation: '+op.type);
  }
  return next;
}
