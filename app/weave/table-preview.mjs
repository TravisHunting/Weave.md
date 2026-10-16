import {StateField,StateEffect,Transaction} from '@codemirror/state';
import {EditorView,Decoration,WidgetType} from '@codemirror/view';
import {syntaxTree,ensureSyntaxTree} from '@codemirror/language';
import {isolateHistory} from '@codemirror/commands';
import {VisualTable,commitTableEdit} from './table-editing.mjs';
import {parseMarkdownTable,formatMarkdownTable} from './table-source.mjs';
export {tableCellPositions} from './table-source.mjs';
export {insertTableAtSelection,commitTableEdit} from './table-editing.mjs';
export const tableFocusChanged=StateEffect.define();
const tablePreferencesChanged=StateEffect.define();
const mode=()=>document.documentElement.dataset.tableEditing==='source'?'source':'visual';
const preferences=()=>['tableEditing','tableAutoFormat','tableHoverControls'].map(key=>document.documentElement.dataset[key]).join('|');

// Reconfiguration retains the mounted cell editor and its input selection.
export function refreshTablePreferences(view) {
  if(!view||view.__weaveTablePreferences===preferences())return;
  view.__weaveTablePreferences=preferences();
  view.dispatch({effects:tablePreferencesChanged.of(null)});
}
export function formatTablesForSave(view) {
  commitTableEdit(view);
  if(!view||view.state.readOnly||document.documentElement.dataset.tableAutoFormat==='false')return false;
  const changes=[],tree=ensureSyntaxTree(view.state,view.state.doc.length,2000)||syntaxTree(view.state);
  tree.iterate({enter:node=>{
    if(node.name!=='Table')return;
    const text=view.state.doc.sliceString(node.from,node.to),table=parseMarkdownTable(text);
    if(table){const insert=formatMarkdownTable(table);if(insert!==text)changes.push({from:node.from,to:node.to,insert});}
    return false;
  }});
  if(changes.length)view.dispatch({changes,annotations:[Transaction.userEvent.of('input.table.format'),isolateHistory.of('full')]});
  return !!changes.length;
}

class TablePreview extends WidgetType {
  constructor(owner,text,from,mode,readOnly,settings,index){super();Object.assign(this,{owner,text,from,mode,readOnly,settings,index});}
  eq(other){return this.text===other.text&&this.from===other.from&&this.mode===other.mode&&this.readOnly===other.readOnly&&this.settings===other.settings&&this.index===other.index;}
  toDOM(view){return new VisualTable(this.owner,view,this,(position,event)=>{
    view.dispatch({selection:{anchor:event?.shiftKey?view.state.selection.main.anchor:position,head:position},effects:tableFocusChanged.of(true),scrollIntoView:true,userEvent:'select.pointer'});view.focus();
  }).root;}
  updateDOM(root){root.__weaveTable.sync(this);return true;}
  destroy(root){root.__weaveTable?.destroy();}
  ignoreEvent(){return true;}
}

export function tablePreviewField(owner) {
  const build=(state,focused=false)=>{
    const tables=[],decorations=[],display=mode(),settings=preferences();let hasTables=false,index=0;
    syntaxTree(state).iterate({enter:node=>{
      if(node.name!=='Table')return;
      const tableIndex=index++;
      hasTables=true;
      // Source mode retains ordinary Markdown selection/typing. Visual mode
      // edits cells in the rendered widget while using this same document.
      const selected=display==='source'&&focused&&!state.readOnly&&state.selection.ranges.some(r=>r.empty?r.head>node.from&&r.head<node.to:r.from<node.to&&r.to>node.from);
      if(!selected&&node.from===state.doc.lineAt(node.from).from){
        tables.push({from:node.from,to:node.to});
        decorations.push(Decoration.replace({widget:new TablePreview(owner,state.doc.sliceString(node.from,node.to),node.from,display,state.readOnly,settings,tableIndex),block:true,inclusive:false}).range(node.from,node.to));
      }
      return false;
    }});
    const ranges=Decoration.set(decorations,true);
    return {tables,hasTables,focused,decorations:ranges,atomic:display==='visual'?ranges:Decoration.none};
  };
  return StateField.define({create:state=>build(state,!!owner.view?.hasFocus),update(value,tr){
    const focused=tr.effects.find(effect=>effect.is(tableFocusChanged))?.value??value.focused;
    return tr.docChanged||focused!==value.focused||tr.effects.some(effect=>effect.is(tablePreferencesChanged))||tr.state.readOnly!==tr.startState.readOnly||tr.selection&&value.hasTables||syntaxTree(tr.state)!==syntaxTree(tr.startState)?build(tr.state,focused):value;
  },provide:field=>[EditorView.decorations.from(field,value=>value.decorations),EditorView.atomicRanges.of(view=>view.state.field(field).atomic)]});
}
