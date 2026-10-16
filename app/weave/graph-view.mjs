import {indexes, neighborhood, wrapNodeName} from '../graph-core.js';
import {esc} from './render.mjs';
import {layoutColumns, shufflePositions} from './graph-layout.mjs';
import {displayGraphRelationships} from './graph-display.mjs';
const CLOSE_HEIGHT=60;
export function createGraph(root, onOpen, {onCollapse = () => {}, onExpand = () => {}, onError = () => {}, loadNeighborhood} = {}) {
 const $=id=>root.querySelector('#'+id);
 let data={entities:[],relationships:[]}, index=indexes(data), state={id:null}, palette='pastel';
 let requestSerial=0, frame=0, spacing=1;
 const arrivingNodes=new Map(),arrivingEdges=new Map();
 const graphState={focus:null,positions:new Map(),layouts:new Map(),scale:1,x:0,y:0,graph:null,path:null,overview:false,edge:null};
 const graphFilters=()=>({direction:$('graph-direction').value,inactive:true});
 function typeHue(type){const named={knowledge:275,'data-factory':30,application:210,pipeline:350,'data-platform':165,database:55};return named[type]??[...String(type)].reduce((h,c)=>(h*31+c.codePointAt(0))%360,0);}
function nodeColors(type){
 const hue=typeHue(type),s=palette==='intense'?.64:.65,l=palette==='intense'?.38:.8;
 const f=n=>{const k=(n+hue/30)%12;return l-s*Math.min(l,1-l)*Math.max(-1,Math.min(k-3,9-k,1));};
 const rgb=[f(0),f(8),f(4)],lum=rgb.map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4).reduce((v,c,i)=>v+c*[.2126,.7152,.0722][i],0);
 return {fill:`rgb(${rgb.map(c=>Math.round(c*255)).join(',')})`,ink:1.05/(lum+.05)>(lum+.05)/.05?'#ffffff':'#000000',stroke:`hsl(${hue} 35% ${palette==='intense'?25:55}%)`};
}

 const nodeMetrics=new Map(),textMeasure=document.createElement('canvas').getContext('2d');
function nodeBox(n){
 const key=n.type+'\n'+n.name+'\n'+n.tags.join('|');if(nodeMetrics.has(key))return nodeMetrics.get(key);
 textMeasure.font='600 13px Segoe UI, system-ui, Arial, sans-serif';
 const measure=t=>textMeasure.measureText(t).width;
 const words=n.name.trim().split(/\s+/u),wordWidth=Math.max(...words.map(measure));
 const lines=wrapNodeName(n.name,measure,Math.max(216,wordWidth));
 const nameWidth=Math.max(...lines.map(measure));
 textMeasure.font='400 14px Segoe UI, system-ui, Arial, sans-serif';
 const kind=n.type.replaceAll('-',' ').toUpperCase(),kindWidth=textMeasure.measureText(kind).width+(kind.length-1)*1.25;
 const tags=n.tags.slice(0,3).map(t=>'#'+t.replace(/^#+/,''));textMeasure.font='400 11px Segoe UI, system-ui, Arial, sans-serif';const tagWidth=textMeasure.measureText(tags.join('   ')).width;
 const box={width:Math.ceil(Math.max(244,nameWidth+32,kindWidth+32,tagWidth+32)),height:Math.max(104,lines.length*18+72),lines,tags};
 nodeMetrics.set(key,box);return box;
}
function layoutGraph(g, preserve=false){
 const types=[...new Set(g.nodes.map(n=>n.type))].sort(),columnWidth=(Math.max(244,...g.nodes.map(n=>nodeBox(n).width))+110)*spacing,rowHeight=(Math.max(92,...g.nodes.map(n=>nodeBox(n).height))+40)*spacing;
 const neighbors=g.nodes.filter(n=>n.id!==graphState.focus&&(g.distances?.get(n.id)||1)===1).sort((a,b)=>a.name.localeCompare(b.name));
 const buckets=new Map();for(const n of g.nodes){let col=types.indexOf(n.type);
 if(!graphState.overview){const d=g.distances?.get(n.id)||1;col=n.id===graphState.focus?0:graphFilters().direction==='upstream'?-d:graphFilters().direction==='downstream'?d:g.edges.some(e=>e.to===graphState.focus&&e.from===n.id)?-d:d;}
 if(!graphState.overview&&graphFilters().direction==='both'&&neighbors.length>4&&neighbors.includes(n))col=neighbors.indexOf(n)<Math.ceil(neighbors.length/2)?-1:1;
 if(!buckets.has(col))buckets.set(col,[]);buckets.get(col).push(n);}
 const key=JSON.stringify([graphState.overview?'overview':graphState.focus,graphFilters().direction,$('graph-depth').value,spacing,g.nodes.map(n=>n.id).sort()]);
 if(!graphState.layouts.has(key))graphState.layouts.set(key,layoutColumns(buckets,columnWidth,rowHeight,{overview:graphState.overview}));
 const positions=graphState.layouts.get(key);
 if(preserve&&graphState.positions.size){
  // Later depth layers extend outward without shifting nodes the reader has
  // already seen or moved. Each side gets its own free horizontal space.
  const old=graphState.positions, added=g.nodes.filter(n=>!old.has(n.id));
  for(const side of [-1,1]){
   const nodes=added.filter(n=>Math.sign(positions.get(n.id).x||1)===side);if(!nodes.length)continue;
   const boundary=side*Math.max(...g.nodes.filter(n=>old.has(n.id)).map(n=>side*old.get(n.id).x+nodeBox(n).width/2));
   const near=side*Math.min(...nodes.map(n=>side*positions.get(n.id).x-nodeBox(n).width/2));
   const shift=boundary-near+side*110*spacing;
   for(const n of nodes){const p=positions.get(n.id);old.set(n.id,{x:p.x+shift,y:p.y});}
  }
  graphState.positions=old;
 }else graphState.positions=new Map([...positions].map(([id,p])=>[id,{...p}]));
}

 function edgeGeometry(e){
 const a=graphState.positions.get(e.from),b=graphState.positions.get(e.to),same=a.x===b.x,reverse=b.x<a.x,aw=nodeBox(index.nodes.get(e.from)).width/2,bw=nodeBox(index.nodes.get(e.to)).width/2,ax=a.x+(reverse?-aw:aw),bx=b.x+(reverse?bw:-bw),mid=(ax+bx)/2;
 const peers=graphState.displayEdges.filter(x=>(x.from===e.from&&x.to===e.to)||(x.from===e.to&&x.to===e.from)).sort((a,b)=>a.id.localeCompare(b.id)),offset=(peers.findIndex(x=>x.id===e.id)-(peers.length-1)/2)*64;
 if(e.from===e.to)return {d:`M${a.x+aw-22},${a.y-34} C${a.x+aw+90},${a.y-110} ${a.x+aw+90},${a.y+30} ${a.x+aw},${a.y+15}`,x:a.x+aw+65,y:a.y-46};
 if(same){const outer=Math.max(aw,bw)+98;return {d:`M${a.x+aw},${a.y} C${a.x+outer+offset},${a.y} ${b.x+outer+offset},${b.y} ${b.x+bw},${b.y}`,x:a.x+outer-25+offset*.75,y:(a.y+b.y)/2-7};}
 return {d:`M${ax},${a.y} C${mid},${a.y+offset} ${mid},${b.y+offset} ${bx},${b.y}`,x:mid,y:(a.y+b.y)/2+offset*.75-8};
}
function drawGraph(addedNodes=new Set(),addedEdges=new Set()){
 const g=graphState.graph;if(!g)return;const colors={lineage:'#4f9069',execution:'#bb8848',structure:'#82987c',dependency:'#6389aa'};
 const now=performance.now();for(const id of addedNodes)arrivingNodes.set(id,now+240);for(const id of addedEdges)arrivingEdges.set(id,now+240);
 for(const [id,until] of arrivingNodes)if(until>now)addedNodes.add(id);else arrivingNodes.delete(id);
 for(const [id,until] of arrivingEdges)if(until>now)addedEdges.add(id);else arrivingEdges.delete(id);
 graphState.displayEdges=displayGraphRelationships(g.edges,graphState.focus);
 $('graph-edges-svg').innerHTML=graphState.displayEdges.map(e=>{const p=edgeGeometry(e);return `<g class="${addedEdges.has(e.id)?'graph-arriving':''}" data-edge="${esc(e.id)}" tabindex="0" role="button" aria-label="${esc(e.type+': '+e.description)}"><title>${esc(e.description)}</title><path class="graph-edge ${e.records.some(r=>r.id===graphState.edge)?'selected':''}" d="${p.d}" stroke="${colors[e.category]}" marker-end="url(#arrow-${e.category})" ${e.status==='inactive'?'stroke-dasharray="6 5"':''}/><path class="edge-hit" d="${p.d}"/><text class="edge-label" x="${p.x}" y="${p.y}" text-anchor="middle">${esc(e.type.replaceAll('-',' '))}${e.status==='inactive'?' · inactive':''}</text></g>`;}).join('');
 // Keep all labels above every path and its pointer hit area.
 const labels=document.createElementNS('http://www.w3.org/2000/svg','g');labels.setAttribute('aria-hidden','true');
 for(const label of $('graph-edges-svg').querySelectorAll('.edge-label')){const wrapper=document.createElementNS('http://www.w3.org/2000/svg','g');wrapper.dataset.edge=label.parentElement.dataset.edge;if(addedEdges.has(wrapper.dataset.edge))wrapper.classList.add('graph-arriving');wrapper.append(label);labels.append(wrapper);}
 $('graph-edges-svg').append(labels);
 $('graph-nodes').innerHTML=g.nodes.map(n=>{const p=graphState.positions.get(n.id),color=nodeColors(n.type),box=nodeBox(n),w=box.width/2,h=box.height/2;return `<g class="graph-node ${n.id===state.id?'focus':''} ${addedNodes.has(n.id)?'graph-arriving':''}" transform="translate(${p.x},${p.y})" data-node="${esc(n.id)}" data-type="${esc(n.type)}" tabindex="0" role="button" aria-label="Select ${esc(n.name)}"><title>${esc(n.name+' · '+n.type)}</title><rect class="node-selection" x="${-w-5}" y="${-h-5}" width="${box.width+10}" height="${box.height+10}" rx="13"/><rect class="node-body" fill="${color.fill}" stroke="${color.stroke}" x="${-w}" y="${-h}" width="${box.width}" height="${box.height}" rx="9"/><text class="node-kind" fill="${color.ink}" x="0" y="${-h+21}" text-anchor="middle">${esc(n.type.replaceAll('-',' ').toUpperCase())}</text><text class="node-name" fill="${color.ink}" text-anchor="middle">${box.lines.map((line,i)=>`<tspan x="0" y="${i*18}">${esc(line)}</tspan>`).join('')}</text><text class="node-tags" x="0" y="${h-14}" text-anchor="middle" fill="${color.ink==='#ffffff'?'#d2d8d4':'#56615b'}">${esc(box.tags.join('   '))}</text></g>`;}).join('');
 // Centre the actual glyph bounds, rather than guessing from a font baseline.
 // Redrawing for a later depth keeps earlier arrivals at their current opacity
 // instead of restarting their fade from zero.
 for(const item of root.querySelectorAll('.graph-arriving')){const until=item.dataset.node?arrivingNodes.get(item.dataset.node):arrivingEdges.get(item.dataset.edge);item.style.animationDelay=-Math.max(0,now-(until-240))+'ms';}
 for(const text of $('graph-nodes').querySelectorAll('.node-name')){const box=text.getBBox();text.setAttribute('transform',`translate(0,${-box.y-box.height/2})`);}
 applyGraphTransform();
}
function applyGraphTransform(sync=true,animate=false){$('graph-viewport').classList.toggle('graph-camera-arriving',animate);$('graph-viewport').setAttribute('transform',`translate(${graphState.x},${graphState.y}) scale(${graphState.scale})`);$('zoom-label').textContent=Math.round(graphState.scale*100)+'%';if(sync)syncScrollbars();}
function graphBounds(){const nodes=graphState.graph?.nodes||[];if(!nodes.length)return null;const boxes=nodes.map(n=>{const p=graphState.positions.get(n.id),b=nodeBox(n);return {left:p.x-b.width/2-30,right:p.x+b.width/2+70,top:p.y-b.height/2-30,bottom:p.y+b.height/2+30};});return {left:Math.min(...boxes.map(b=>b.left)),right:Math.max(...boxes.map(b=>b.right)),top:Math.min(...boxes.map(b=>b.top)),bottom:Math.max(...boxes.map(b=>b.bottom))};}
function fitGraph(animate=false){const b=graphBounds();if(!b)return;const width=scrollport.clientWidth,height=Math.max(80,scrollport.clientHeight-controls.offsetHeight-24);if(!width)return;graphState.scale=Math.max(.02,Math.min(1.3,(width-30)/(b.right-b.left),(height-20)/(b.bottom-b.top)));graphState.x=width/2-(b.left+b.right)/2*graphState.scale;graphState.y=height/2-(b.top+b.bottom)/2*graphState.scale;applyGraphTransform(true,animate===true);}
function zoomGraph(factor,x=$('graph').clientWidth/2,y=$('graph').clientHeight/2){graphState.interacted=true;const old=graphState.scale,next=Math.max(.02,Math.min(32,old*factor));graphState.x=x-(x-graphState.x)*next/old;graphState.y=y-(y-graphState.y)*next/old;graphState.scale=next;applyGraphTransform();}

 function render(fit=true){
  const serial=++requestSerial;cancelAnimationFrame(frame);frame=0;
  arrivingNodes.clear();arrivingEdges.clear();
  graphState.interacted=false;
  // A streamed neighbourhood starts from the article itself; the native host
  // sends its nodes, so the whole workspace graph is never loaded here.
  const focus=index.nodes.get(graphState.focus)||(loadNeighborhood&&graphState.focus?{id:graphState.focus}:null)||data.entities.find(n=>!n.broken);
  if(!focus){$('graph-nodes').innerHTML='';$('graph-edges-svg').innerHTML='';return;}
  graphState.focus=focus.id;
  $('graph-count').textContent='Loading graph…';
  const nodes=new Map(),edges=new Map(),distances=new Map(),pending=[];let first=true;
  const apply=()=>{
   frame=0;if(serial!==requestSerial)return;const chunk=pending.shift();if(!chunk)return;
   for(const node of chunk.nodes){nodes.set(node.id,node);index.nodes.set(node.id,node);}
   for(const edge of chunk.edges)edges.set(edge.id,edge);
   for(const [id,depth] of chunk.distances)distances.set(id,depth);
   const g={nodes:[...nodes.values()],edges:[...edges.values()],distances,truncated:chunk.truncated};
   graphState.graph=g;layoutGraph(g,!first);drawGraph(first?new Set():new Set(chunk.nodes.map(n=>n.id)),first?new Set():new Set(chunk.edges.map(e=>e.id)));
   $('graph-count').textContent=g.nodes.length+' notes · '+g.edges.length+' links'+(g.truncated?' · limited to 100 notes':chunk.complete?'':' · loading more…');
   root.dataset.renderedDepth=String(chunk.depth);root.dataset.graphComplete=String(chunk.complete);
   // Keep node coordinates stable while the camera smoothly makes room for new
   // layers, so their arrival remains visible without an extra Fit action.
   if(fit&&!graphState.interacted)fitGraph(!first);first=false;
   if(pending.length)frame=requestAnimationFrame(apply);
  };
  const receive=chunk=>{if(serial!==requestSerial||chunk.requestId!==String(serial))return;pending.push(chunk);if(!frame)frame=requestAnimationFrame(apply);};
  const query={path:focus.id,depth:Number($('graph-depth').value),direction:graphFilters().direction,limit:100,revision:data.revision,requestId:String(serial)};
  root.dataset.graphComplete='false';
  if(loadNeighborhood){Promise.resolve(loadNeighborhood(query,receive)).catch(error=>{if(serial!==requestSerial)return;$('graph-count').textContent='Graph unavailable';onError(error);});}
  else{
   // Standalone and read-only web readers have no native process. Preserve the
   // same depth-delta contract using their in-memory graph.
   const sentNodes=new Set(),sentEdges=new Set();
   for(let depth=1;depth<=query.depth;depth++){
    const g=neighborhood(index,focus.id,depth,graphFilters(),100),addedNodes=g.nodes.filter(n=>!sentNodes.has(n.id)),addedEdges=g.edges.filter(e=>!sentEdges.has(e.id));
    for(const n of addedNodes)sentNodes.add(n.id);for(const e of addedEdges)sentEdges.add(e.id);
    receive({requestId:query.requestId,depth,nodes:addedNodes,edges:addedEdges,distances:[...g.distances],truncated:g.truncated,complete:depth===query.depth||g.truncated});if(g.truncated)break;
   }
  }
 }
 const svg=$('graph'),stage=document.createElement('div'),scrollport=document.createElement('div'),space=document.createElement('div');let drag=null,scrollX=0,scrollY=0;
 stage.id='graph-stage';scrollport.id='graph-scrollport';scrollport.tabIndex=0;scrollport.setAttribute('aria-label','Graph scrollbar: pan the graph');space.id='graph-scroll-space';root.append(stage);stage.append(scrollport);scrollport.append(space);space.append(svg);
 const controls=root.querySelector('.graph-controls');controls.setAttribute('role','group');controls.setAttribute('aria-label','Graph controls');controls.append($('graph-count'));stage.append(controls);root.querySelector('.graph-bar').remove();
 const help=document.createElement('span');help.className='graph-scroll-hint';help.textContent='Scroll or pinch to zoom';controls.append(help);$('graph-count').classList.add('graph-counts');help.classList.add('graph-counts');
 function positionControls(){const bounds=stage.getBoundingClientRect(),page=root.parentElement.getBoundingClientRect();controls.style.bottom=Math.max(26,bounds.bottom-Math.min(bounds.bottom,page.bottom)+12)+'px';}
 root.parentElement.addEventListener('scroll',positionControls,{passive:true});
 function syncScrollbars(){const b=graphBounds(),width=scrollport.clientWidth,height=scrollport.clientHeight;if(!width||!height)return;svg.style.width=width+'px';svg.style.height=height+'px';if(!b)return;const left=Math.max(0,-(b.left*graphState.scale+graphState.x)),top=Math.max(0,-(b.top*graphState.scale+graphState.y));const right=Math.max(0,b.right*graphState.scale+graphState.x-width),bottom=Math.max(0,b.bottom*graphState.scale+graphState.y-height);space.style.width=Math.ceil(width+left+right)+'px';space.style.height=Math.ceil(height+top+bottom)+'px';scrollport.scrollLeft=left;scrollport.scrollTop=top;scrollX=scrollport.scrollLeft;scrollY=scrollport.scrollTop;}
 scrollport.addEventListener('scroll',()=>{const dx=scrollport.scrollLeft-scrollX,dy=scrollport.scrollTop-scrollY;scrollX=scrollport.scrollLeft;scrollY=scrollport.scrollTop;if(!dx&&!dy)return;graphState.interacted=true;graphState.x-=dx;graphState.y-=dy;applyGraphTransform(false);});
 // Two fingers pinch: the graph point under their midpoint stays under it as they spread or close.
 const fingers=new Map();let pinch=null;
 function pinchState(){const [a,b]=[...fingers.values()],r=svg.getBoundingClientRect();return {d:Math.hypot(a.x-b.x,a.y-b.y)||1,x:(a.x+b.x)/2-r.left,y:(a.y+b.y)/2-r.top};}
 svg.addEventListener('pointerdown',e=>{if(e.button!==0)return;graphState.interacted=true;fingers.set(e.pointerId,{x:e.clientX,y:e.clientY});svg.setPointerCapture(e.pointerId);e.preventDefault();
  if(fingers.size>1){if(drag?.id&&drag.moved)drawGraph();drag=null;if(fingers.size===2)pinch={...pinchState(),scale:graphState.scale,gx:graphState.x,gy:graphState.y};return;}
  const node=e.target.closest('[data-node]');drag={id:node?.dataset.node,sx:e.clientX,sy:e.clientY,x:graphState.x,y:graphState.y,p:node?{...graphState.positions.get(node.dataset.node)}:null,moved:false};});
 svg.addEventListener('pointermove',e=>{if(fingers.has(e.pointerId))fingers.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(pinch){if(fingers.size<2)return;const now=pinchState(),next=Math.max(.02,Math.min(32,pinch.scale*now.d/pinch.d));graphState.x=now.x-(pinch.x-pinch.gx)*next/pinch.scale;graphState.y=now.y-(pinch.y-pinch.gy)*next/pinch.scale;graphState.scale=next;applyGraphTransform();return;}
  if(!drag)return;const dx=e.clientX-drag.sx,dy=e.clientY-drag.sy;if(Math.hypot(dx,dy)>4)drag.moved=true;if(!drag.moved)return;if(drag.id){graphState.positions.set(drag.id,{x:drag.p.x+dx/graphState.scale,y:drag.p.y+dy/graphState.scale});drawGraph();}else{graphState.x=drag.x+dx;graphState.y=drag.y+dy;applyGraphTransform();}});
 // A finger left after a pinch does nothing until it lifts, so the pinch never ends in a click.
 const end=e=>{fingers.delete(e.pointerId);if(svg.hasPointerCapture(e.pointerId))svg.releasePointerCapture(e.pointerId);if(pinch){if(!fingers.size)pinch=null;return;}if(!drag)return;const old=drag;drag=null;if(svg.hasPointerCapture(e.pointerId))svg.releasePointerCapture(e.pointerId);if(e.type!=='pointercancel'&&!old.moved&&old.id){state.id=old.id;drawGraph();onOpen(index.nodes.get(old.id));}};
 svg.addEventListener('pointerup',end);svg.addEventListener('pointercancel',end);
 svg.setAttribute('aria-label','Interactive relationship graph. Scroll or pinch to zoom; drag or use the graph scrollbars to pan.');
 stage.addEventListener('wheel',e=>{e.preventDefault();e.stopPropagation();const r=svg.getBoundingClientRect(),delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?r.height:1);zoomGraph(Math.exp(-Math.max(-1000,Math.min(1000,delta))*(e.ctrlKey?.01:.001)),e.clientX-r.left,e.clientY-r.top);},{passive:false});
 // Touchpad pinches arrive as Ctrl+wheel (zoomed faster above, as their deltas are small), or as Safari's gesture events.
 let gesture=null;
 stage.addEventListener('gesturestart',e=>{e.preventDefault();gesture=graphState.scale;},{passive:false});
 stage.addEventListener('gesturechange',e=>{e.preventDefault();if(gesture===null||pinch)return;const r=svg.getBoundingClientRect();zoomGraph(gesture*e.scale/graphState.scale,e.clientX-r.left,e.clientY-r.top);},{passive:false});
 stage.addEventListener('gestureend',e=>{e.preventDefault();gesture=null;},{passive:false});
 svg.addEventListener('keydown',e=>{const node=e.target.closest('[data-node]');if(!node)return;if(['Enter',' '].includes(e.key)){e.preventDefault();onOpen(index.nodes.get(node.dataset.node));}if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();const p=graphState.positions.get(node.dataset.node);p.x+=e.key==='ArrowRight'?20:e.key==='ArrowLeft'?-20:0;p.y+=e.key==='ArrowDown'?20:e.key==='ArrowUp'?-20:0;drawGraph();[...svg.querySelectorAll('[data-node]')].find(n=>n.dataset.node===node.dataset.node)?.focus();}});
 for(const id of ['graph-depth','graph-direction'])$(id).onchange=()=>render();
 $('graph-fit').onclick=fitGraph;$('graph-reset').onclick=()=>{graphState.layouts.clear();render();};
 $('graph-spacing').oninput=()=>{
  const previous=spacing;spacing=Number($('graph-spacing').value)/100;$('graph-spacing-value').textContent=Math.round(spacing*100)+'%';
  if(!graphState.graph)return;
  const center=graphState.positions.get(graphState.focus)||{x:0,y:0},factor=spacing/previous;
  graphState.positions=new Map([...graphState.positions].map(([id,p])=>[id,{x:center.x+(p.x-center.x)*factor,y:center.y+(p.y-center.y)*factor}]));
  graphState.interacted=true;drawGraph();
 };
 $('graph-shuffle').onclick=()=>{
  if(!graphState.graph)return;
  graphState.interacted=true;layoutGraph(graphState.graph);
  const boxes=graphState.graph.nodes.map(nodeBox);graphState.positions=shufflePositions(graphState.positions,graphState.focus,Math.random,{width:(Math.max(244,...boxes.map(b=>b.width))+40)*spacing,height:(Math.max(92,...boxes.map(b=>b.height))+30)*spacing});drawGraph();
  // Keep the current article at the middle of the visible graph, retaining zoom.
  graphState.x=scrollport.clientWidth/2;graphState.y=Math.max(80,scrollport.clientHeight-controls.offsetHeight-24)/2;applyGraphTransform();
 };
 $('zoom-in').onclick=()=>zoomGraph(1.25);$('zoom-out').onclick=()=>zoomGraph(.8);
 const resize=document.createElement('div');resize.id='graph-resize';resize.tabIndex=0;resize.setAttribute('role','separator');resize.setAttribute('aria-label','Resize graph vertically; drag up to close');resize.setAttribute('aria-orientation','horizontal');resize.title='Drag up to close the graph. Arrow keys resize; Home closes.';root.append(resize);
 const dragSurface=root.parentElement;let size=null;
 function startResize(e,closed=false){
  if(e.button!==0)return;
  size={y:e.clientY,height:closed?8:root.getBoundingClientRect().height,closed,moved:false,previous:root.style.height};
  dragSurface.setPointerCapture(e.pointerId);e.preventDefault();
 }
 dragSurface.addEventListener('pointermove',e=>{
  if(!size)return;
  const dy=e.clientY-size.y;if(!size.moved&&Math.abs(dy)<=4)return;
  if(!size.moved){size.moved=true;root.classList.add('graph-resizing');if(size.closed)onExpand();}
  const height=Math.max(8,size.height+dy);root.style.height=height+'px';resize.setAttribute('aria-valuenow',String(Math.round(height)));
 });
 function endResize(e){
  if(!size)return;
  const prior=size;size=null;
  if(dragSurface.hasPointerCapture(e.pointerId))dragSurface.releasePointerCapture(e.pointerId);
  const height=root.getBoundingClientRect().height;root.classList.remove('graph-resizing');
  if(e.type==='pointercancel'){root.style.height=prior.previous;if(prior.closed)onCollapse();return;}
  if(!prior.moved){if(prior.closed)onExpand();return;}
  // Any height the user drags to is kept; dragging it nearly shut hides the graph
  // entirely, bar included, and the Graph button brings it back at its last height.
  if(height<CLOSE_HEIGHT){root.style.height=prior.previous;onCollapse();}else setHeight(height);
 }
 dragSurface.addEventListener('pointerup',endResize);dragSurface.addEventListener('pointercancel',endResize);
 function setHeight(height){if(height<CLOSE_HEIGHT){onCollapse();return false;}root.style.height=height+'px';resize.setAttribute('aria-valuenow',String(Math.round(height)));return true;}
 resize.onpointerdown=e=>startResize(e);
 resize.onkeydown=e=>{if(['ArrowUp','ArrowDown','Home'].includes(e.key)){e.preventDefault();setHeight(e.key==='Home'?0:root.getBoundingClientRect().height+(e.key==='ArrowDown'?50:-50));}};
 $('graph-palette').onclick=()=>{palette=palette==='pastel'?'intense':'pastel';drawGraph();};
 new ResizeObserver(()=>{if(scrollport.clientWidth){syncScrollbars();fitGraph();positionControls();}}).observe(scrollport);
 return {update(next,focus){const changed=graphState.focus!==focus,unchanged=!changed&&next===data;data=next;index=indexes(data);state.id=focus;graphState.focus=focus;if(!unchanged)render(changed);},fit:fitGraph,setHeight,setVisible(visible,available){if(!available){requestSerial++;cancelAnimationFrame(frame);}}};
}
