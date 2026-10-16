import {ui} from './locale.mjs';
import {EditorSelection,Transaction} from '@codemirror/state';
import {isolateHistory,undo,redo} from '@codemirror/commands';
import {renderNote} from './render.mjs';
import {parseMarkdownTable,formatMarkdownTable,applyTableOperation,tableCellPositions,tableCellInput} from './table-source.mjs';

const preferences=()=>({padded:document.documentElement.dataset.tableAutoFormat!=='false'});
const editable=controller=>controller.owner.enabled && !controller.view.state.readOnly;
const marker=(value,element)=>{element.value=value; element.dispatchEvent(new Event('input',{bubbles:true}));};
let menuOwner=null;

// Every cell keystroke changes the one Markdown document. The textarea remains
// mounted through widget updates, so debounce saves, undo and toolbar actions
// see the current cell text without creating a second document or draft store.
export class VisualTable {
  constructor(owner,view,descriptor,activateSource) {
    Object.assign(this,{owner,view,activateSource});
    this.root=document.createElement('div');this.root.className='cm-table-preview';this.root.tabIndex=0;
    this.root.__weaveTable=this;
    this.root.addEventListener('mousedown',event=>this.pointer(event));
    this.root.addEventListener('contextmenu',event=>this.context(event));
    this.root.addEventListener('click',event=>{if(editable(this)&&event.target.closest('[data-open],[data-chat-entity],a[href]')){event.preventDefault();event.stopPropagation();}});
    this.root.addEventListener('keydown',event=>{
      if(event.target.closest('.table-column-resize'))return;
      if(event.target.closest('.table-cell-input'))return;
      if(editable(this)&&(event.ctrlKey||event.metaKey)&&['z','y'].includes(event.key.toLowerCase())){event.preventDefault();event.stopPropagation();(event.key.toLowerCase()==='y'||event.shiftKey?redo:undo)(this.view);return;}
      if(editable(this) && event.key==='Enter'){event.preventDefault();this.begin(0,0);}
    });
    this.root.addEventListener('pointermove',event=>this.hover(event));
    this.root.addEventListener('pointerleave',()=>{if(this.addRow)this.addRow.hidden=true;});
    this.sync(descriptor);
    this.resizeObserver=new ResizeObserver(entries=>{const width=entries[0].contentRect.width;if(width!==this.layoutWidth){this.layoutWidth=width;this.growInput();}});
    this.resizeObserver.observe(this.root);
  }
  sync(descriptor) {
    const prior=this.model;Object.assign(this,descriptor);this.model=parseMarkdownTable(this.text);
    this.root.dataset.tableFrom=String(this.from);
    this.root.classList.toggle('table-editable',editable(this));
    this.root.dataset.tableMode=this.mode;
    this.root.setAttribute('aria-label',editable(this)?'Markdown table. Press Enter to edit a cell.':'Markdown table');
    if(this.session && (!editable(this)||this.mode!=='visual'))this.finish();
    const sameShape=prior && this.model && prior.rows.length===this.model.rows.length && prior.columnCount===this.model.columnCount;
    if(!sameShape || !this.root.querySelector('table'))this.render();
    else {
      const rendered=this.rendered();
      for(const [index,cell] of [...this.root.querySelectorAll('th,td')].entries()) {
        const replacement=rendered.querySelectorAll('th,td')[index];if(!replacement)continue;
        cell.style.textAlign=replacement.style.textAlign;
        if(!this.session || cell!==this.session.cell)cell.innerHTML='<span class="table-cell-display">'+replacement.innerHTML+'</span>';
      }
      this.mapCells();
      if(this.session && !this.applying) {
        const input=this.session.input,value=tableCellInput(this.model.rows[this.session.row]?.[this.session.column]??'');
        if(input.value!==value){const start=input.selectionStart,end=input.selectionEnd;input.value=value;input.setSelectionRange(Math.min(start,value.length),Math.min(end,value.length));}
      }
    }
    this.columns();this.growInput();
  }
  columns() {
    const table=this.root.querySelector('table');if(!table||!this.model)return;
    const count=this.model.columnCount;
    const widthKey=JSON.stringify(['weave-table-widths',this.owner.workspace?.()||'',this.owner.sourcePath(),this.index]);
    if(widthKey!==this.widthKey)this.widths=null;
    this.widthKey=widthKey;
    if(!this.widths || this.widths.length!==count) {
      let saved;try{saved=JSON.parse(localStorage.getItem(this.widthKey));}catch{}
      this.widths=Array.isArray(saved)&&saved.length===count&&saved.every(n=>Number.isFinite(n)&&n>0&&n<=100) ? saved : Array(count).fill(100/count);
      const total=this.widths.reduce((sum,width)=>sum+width,0);this.widths=this.widths.map(width=>width/total*100);
    }
    let group=table.querySelector('colgroup');
    if(!group){group=document.createElement('colgroup');table.prepend(group);}
    group.replaceChildren(...this.widths.map(width=>{const col=document.createElement('col');col.style.width=width+'%';return col;}));
    for(const [column,cell] of [...table.querySelectorAll('th')].entries()) {
      if(column===count-1 || cell.querySelector('.table-column-resize'))continue;
      const handle=document.createElement('span');handle.className='table-column-resize';handle.tabIndex=0;
      handle.setAttribute('role','separator');handle.setAttribute('aria-orientation','vertical');handle.setAttribute('aria-label','Resize column '+(column+1));handle.title='Drag to resize columns';
      handle.setAttribute('aria-valuenow',String(Math.round(this.widths[column])));
      const resize=delta=>{
        const total=table.getBoundingClientRect().width,minimum=Math.min(64/total*100,(this.widths[column]+this.widths[column+1])/3);
        const amount=Math.max(minimum-this.widths[column],Math.min(this.widths[column+1]-minimum,delta/total*100));
        this.widths[column]+=amount;this.widths[column+1]-=amount;
        [...group.children].forEach((col,index)=>col.style.width=this.widths[index]+'%');
        handle.setAttribute('aria-valuenow',String(Math.round(this.widths[column])));
        this.growInput();this.view.requestMeasure();
      };
      let x=null;
      handle.onpointerdown=event=>{if(event.button!==0)return;event.preventDefault();event.stopPropagation();x=event.clientX;handle.setPointerCapture(event.pointerId);};
      handle.onmousedown=event=>{event.preventDefault();event.stopPropagation();};
      handle.onpointermove=event=>{if(x===null)return;resize(event.clientX-x);x=event.clientX;};
      const save=()=>{x=null;try{localStorage.setItem(this.widthKey,JSON.stringify(this.widths));}catch{}};
      handle.onpointerup=handle.onpointercancel=handle.onlostpointercapture=save;
      handle.onkeydown=event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();event.stopPropagation();resize(event.key==='ArrowRight'?10:-10);save();};
      cell.append(handle);
    }
  }
  growInput() {
    const input=this.session?.input;if(!input)return;
    input.style.height='0px';input.style.height=input.scrollHeight+'px';
    this.view.requestMeasure();
  }
  rendered() {
    const result=document.createElement('div');
    result.innerHTML=renderNote(this.text,this.owner.paths(),this.owner.caseSensitive(),new Map(),this.owner.sourcePath(),{titles:this.owner.titles()});
    return result;
  }
  render() {
    if(this.session)this.finish();
    const rendered=this.rendered();this.root.replaceChildren(...rendered.childNodes);
    for(const cell of this.root.querySelectorAll('th,td')){const display=document.createElement('span');display.className='table-cell-display';display.append(...cell.childNodes);cell.append(display);}
    this.mapCells();
    this.addRow=document.createElement('button');this.addRow.className='table-add-row';this.addRow.type='button';this.addRow.hidden=true;this.addRow.title='Insert row below';this.addRow.setAttribute('aria-label','Insert row below');this.addRow.textContent='+';
    this.addRow.onmousedown=event=>{event.preventDefault();event.stopPropagation();};
    this.addRow.onclick=event=>{event.preventDefault();event.stopPropagation();this.operate({type:'insertRow',index:Number(this.addRow.dataset.row)+1});};
    this.root.append(this.addRow);
  }
  mapCells() {
    const lines=this.text.split('\n');let offset=this.from,row=0;
    const rows=[...this.root.querySelectorAll('tr')];
    for(let i=0;i<lines.length;i++) {
      if(i!==1) {const positions=tableCellPositions(lines[i],offset);for(const [column,cell] of [...(rows[row]?.children||[])].entries()) {
        cell.dataset.tableRow=String(row);cell.dataset.tableColumn=String(column);cell.dataset.tablePosition=String(positions[column]??offset);
        cell.title=editable(this)?this.mode==='source'?'Click to edit this table in Markdown':'Click to edit cell; right-click for table actions':'';
      }row++;}
      offset+=lines[i].length+1;
    }
    for(const link of this.root.querySelectorAll('[data-open],[data-chat-entity],a[href]'))link.title=editable(this)?'Ctrl click to open':'Click to open';
  }
  pointer(event) {
    if(event.button!==0 || event.target.closest('.table-cell-input,.table-add-row,.table-column-resize'))return;
    const cell=event.target.closest('[data-table-row]');if(!cell || !editable(this))return;
    if(event.ctrlKey||event.metaKey) {
      const link=event.target.closest('[data-open],[data-chat-entity],a[href]');if(!link)return;
      event.preventDefault();event.stopPropagation();this.finish();
      this.owner.element.dispatchEvent(new CustomEvent('weave-follow-link',{bubbles:true,detail:{path:link.dataset.open||link.dataset.chatEntity||link.href,external:!!link.href}}));return;
    }
    event.preventDefault();event.stopPropagation();
    if(this.mode==='source'){this.activateSource(Number(cell.dataset.tablePosition),event);return;}
    this.begin(Number(cell.dataset.tableRow),Number(cell.dataset.tableColumn));
  }
  begin(row,column) {
    if(!editable(this)||!this.model)return;
    if(this.mode==='source'){const cell=this.root.querySelector(`[data-table-row="${row}"][data-table-column="${column}"]`);if(cell)this.activateSource(Number(cell.dataset.tablePosition));return;}
    if(this.session?.row===row&&this.session.column===column){this.session.input.focus();return;}
    this.finish();
    const cell=this.root.querySelector(`[data-table-row="${row}"][data-table-column="${column}"]`);if(!cell)return;
    const input=document.createElement('textarea');input.className='table-cell-input';input.value=tableCellInput(this.model.rows[row]?.[column]??'');input.spellcheck=false;input.rows=1;
    input.setAttribute('aria-label',`${row===0?'Header':'Row '+row}, column ${column+1}`);
    const session=this.session={row,column,cell,input,original:input.value,first:true};cell.classList.add('table-cell-active');cell.append(input);
    input.oninput=()=>{
      if(this.session!==session||!editable(this))return;
      this.applying=true;
      try {this.write(applyTableOperation(this.model,{type:'setCell',row,column,value:input.value}),'input.type.table',session.first?'before':null);session.first=false;}
      finally {this.applying=false;this.growInput();}
    };
    input.onblur=()=>{if(this.session===session)this.finish();};
    input.onkeydown=event=>{
      event.stopPropagation();
      if((event.ctrlKey||event.metaKey)&&['z','y'].includes(event.key.toLowerCase())){event.preventDefault();(event.key.toLowerCase()==='y'||event.shiftKey?redo:undo)(this.view);return;}
      if((event.ctrlKey||event.metaKey)&&['b','i'].includes(event.key.toLowerCase())){event.preventDefault();const wrap=event.key.toLowerCase()==='b'?'**':'*',start=input.selectionStart,end=input.selectionEnd;const value=input.value.slice(0,start)+wrap+input.value.slice(start,end)+wrap+input.value.slice(end);marker(value,input);input.setSelectionRange(start+wrap.length,end+wrap.length);return;}
      // Save belongs to the article, including the current cell's latest input.
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();this.owner.element.dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:event.ctrlKey,metaKey:event.metaKey,bubbles:true,cancelable:true}));return;}
      if(event.key==='Escape'){event.preventDefault();const original=session.original;this.finish();this.write(applyTableOperation(this.model,{type:'setCell',row,column,value:original}),'input.table');this.root.focus();return;}
      if(event.key==='Enter'&&event.shiftKey) {
        event.preventDefault();input.setRangeText('\n',input.selectionStart,input.selectionEnd,'end');
        input.dispatchEvent(new Event('input',{bubbles:true}));return;
      }
      if(event.key==='Tab'||event.key==='Enter') {
        event.preventDefault();const rows=this.model.rows.length,columns=this.model.columnCount;
        let nextRow=row,nextColumn=column;
        if(event.key==='Tab'){nextColumn+=event.shiftKey?-1:1;if(nextColumn<0){nextRow--;nextColumn=columns-1;}if(nextColumn>=columns){nextRow++;nextColumn=0;}}
        else nextRow++;
        this.finish();
        if(nextRow<0){this.view.dispatch({selection:EditorSelection.cursor(this.from),scrollIntoView:true});this.view.focus();return;}
        if(nextRow>=rows)this.operate({type:'insertRow',index:rows});
        queueMicrotask(()=>this.begin(nextRow,nextColumn));
      }
    };
    this.growInput();input.focus();input.setSelectionRange(input.value.length,input.value.length);
  }
  finish() {
    const session=this.session;if(!session)return;
    this.session=null;session.input.remove();session.cell.classList.remove('table-cell-active');
    const cell=this.rendered().querySelectorAll('th,td')[session.row*this.model.columnCount+session.column];
    if(cell)session.cell.innerHTML='<span class="table-cell-display">'+cell.innerHTML+'</span>';
    this.columns();this.view.requestMeasure();
  }
  write(model,userEvent='input.table.structure',isolation='full') {
    if(!editable(this)||!model)return false;
    const from=this.from,to=from+this.text.length;
    if(this.view.state.doc.sliceString(from,to)!==this.text)return false;
    const insert=formatMarkdownTable(model,preferences());if(insert===this.text)return true;
    this.view.dispatch({changes:{from,to,insert},annotations:[Transaction.userEvent.of(userEvent),...(isolation?[isolateHistory.of(isolation)]:[])]});return true;
  }
  operate(operation) {
    if(!editable(this))return;this.finish();this.closeMenu();
    if(operation.type==='deleteTable'){
      this.view.dispatch({changes:{from:this.from,to:this.from+this.text.length,insert:''},selection:EditorSelection.cursor(this.from),annotations:[Transaction.userEvent.of('delete.table'),isolateHistory.of('full')]});this.view.focus();return true;
    }
    if(operation.type==='sortRows')operation={...operation,getText:source=>{
      const rendered=document.createElement('div');rendered.innerHTML=renderNote(source,this.owner.paths(),this.owner.caseSensitive(),new Map(),this.owner.sourcePath(),{titles:this.owner.titles()});return rendered.textContent.trim();
    }};
    const result=this.write(applyTableOperation(this.model,operation));this.root.focus();return result;
  }
  hover(event) {
    if(!this.addRow||!editable(this)||this.mode!=='visual'||document.documentElement.dataset.tableHoverControls==='false')return;
    const row=event.target.closest('tr');if(!row||event.target.closest('.table-cell-input'))return;
    const box=row.getBoundingClientRect(),root=this.root.getBoundingClientRect();
    this.addRow.dataset.row=row.firstElementChild.dataset.tableRow;this.addRow.style.top=(box.bottom-root.top-5)+'px';this.addRow.hidden=false;
  }
  context(event) {
    const cell=event.target.closest('[data-table-row]');if(!cell||!editable(this))return;
    event.preventDefault();event.stopPropagation();this.finish();menuOwner?.closeMenu();this.closeMenu();menuOwner=this;
    const row=Number(cell.dataset.tableRow),column=Number(cell.dataset.tableColumn),menu=document.createElement('div');menu.className='table-context-menu';menu.setAttribute('role','menu');
    const add=(label,operation,disabled=false)=>{const button=document.createElement('button');button.type='button';button.role='menuitem';button.textContent=label;button.disabled=disabled;button.onclick=()=>this.operate(operation);menu.append(button);};
    add('Insert row above',{type:'insertRow',index:Math.max(1,row)},row===0);add('Insert row below',{type:'insertRow',index:row+1});add('Delete row',{type:'deleteRow',index:row},row===0);
    add('Move row up',{type:'moveRow',index:row,delta:-1},row<=1);add('Move row down',{type:'moveRow',index:row,delta:1},row===0||row>=this.model.rows.length-1);
    menu.append(document.createElement('hr'));add('Insert column left',{type:'insertColumn',index:column});add('Insert column right',{type:'insertColumn',index:column+1});add('Delete column',{type:'deleteColumn',index:column},this.model.columnCount<=1);
    menu.append(document.createElement('hr'));for(const [alignment,label] of [['left','Align left'],['center','Align centre'],['right','Align right']])add(ui(label),{type:'setAlignment',column,alignment});
    add('Sort A to Z',{type:'sortRows',column,direction:'asc'},row===0&&this.model.rows.length<3);add('Sort Z to A',{type:'sortRows',column,direction:'desc'},row===0&&this.model.rows.length<3);
    menu.append(document.createElement('hr'));add('Clear cell',{type:'setCell',row,column,value:''});add('Delete table',{type:'deleteTable'});
    document.body.append(menu);this.menu=menu;
    menu.style.left=Math.max(4,Math.min(event.clientX,innerWidth-menu.offsetWidth-4))+'px';menu.style.top=Math.max(4,Math.min(event.clientY,innerHeight-menu.offsetHeight-4))+'px';
    this.dismiss=event=>{if(!menu.contains(event.target))this.closeMenu();};document.addEventListener('mousedown',this.dismiss);
    menu.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();this.closeMenu();this.root.focus();}else if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();const buttons=[...menu.querySelectorAll('button:not(:disabled)')],index=buttons.indexOf(document.activeElement);buttons[(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length].focus();}};
    menu.querySelector('button:not(:disabled)').focus();
  }
  closeMenu() {this.menu?.remove();this.menu=null;if(this.dismiss)document.removeEventListener('mousedown',this.dismiss);this.dismiss=null;if(menuOwner===this)menuOwner=null;}
  destroy() {this.resizeObserver?.disconnect();this.closeMenu();this.session=null;}
}

export function commitTableEdit(view) {
  if(!view)return;
  for(const element of view.dom.querySelectorAll('.cm-table-preview')) {
    const table=element.__weaveTable,session=table?.session;
    if(session&&editable(table))table.write(applyTableOperation(table.model,{type:'setCell',row:session.row,column:session.column,value:session.input.value}),'input.type.table',null);
  }
}

export function insertTableAtSelection(view,{rows=3,columns=3,position=view.state.selection.main.head,headers=true}={}) {
  if(view.state.readOnly)return false;
  rows=Math.max(1,Math.min(200,Math.round(Number(rows)||3)));columns=Math.max(1,Math.min(30,Math.round(Number(columns)||3)));
  const model={rows:Array.from({length:rows+1},(_,row)=>Array.from({length:columns},(_,column)=>row===0&&headers?'Column '+(column+1):'')),alignments:Array(columns).fill(null),columnCount:columns};
  const at=view.state.doc.lineAt(Math.max(0,Math.min(position,view.state.doc.length))).to,before=view.state.doc.sliceString(0,at),after=view.state.doc.sliceString(at);
  const prefix=before?before.endsWith('\n')?'\n':'\n\n':'',suffix=after.startsWith('\n\n')?'':after.startsWith('\n')?'\n':'\n\n',insert=prefix+formatMarkdownTable(model,preferences())+suffix;
  view.dispatch({changes:{from:at,insert},selection:EditorSelection.cursor(at+prefix.length),scrollIntoView:true,annotations:[Transaction.userEvent.of('input.table.structure'),isolateHistory.of('full')]});
  view.focus();queueMicrotask(()=>{const table=[...view.dom.querySelectorAll('.cm-table-preview')].find(element=>Number(element.dataset.tableFrom)===at+prefix.length);table?.__weaveTable?.begin(0,0);});return true;
}
