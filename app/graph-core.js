export function indexes(data) {
  const nodes=new Map(data.entities.map(n=>[n.id,n])),edges=new Map(data.relationships.map(e=>[e.id,e])),adj=new Map(data.entities.map(n=>[n.id,[]]));
  for(const e of data.relationships) {adj.get(e.from)?.push(e);adj.get(e.to)?.push(e);}
  return {nodes,edges,adj};
}
export function collectionData(data,collection) {
  if(collection==='all')return data;
  if(collection==='collections'){const covers=data.entities.filter(n=>n.cover);const entities=covers.length?covers:data.entities;const ids=new Set(entities.map(n=>n.id));return {...data,entities,relationships:data.relationships.filter(e=>ids.has(e.from)&&ids.has(e.to))};}
  const included=new Set(data.entities.filter(n=>n.collection===collection||n.cover&&data.collections.find(c=>c.id===n.collection)?.parent===collection).map(n=>n.id));
  return {...data,entities:data.entities.filter(n=>included.has(n.id)),relationships:data.relationships.filter(e=>included.has(e.from)&&included.has(e.to))};
}
const selected=(values,value)=>values instanceof Set?values.has(value):Array.isArray(values)&&values.includes(value);
export const tagKey=tag=>String(tag).replace(/^#+/,'').toLocaleLowerCase('en');
const tagExcluded=(filters,tag)=>[...(filters.excludeTags||[])].some(value=>tagKey(value)===tagKey(tag));
export function entityAllowed(node,filters={}) {
 if(!node)return false;
 let collection=node.collection;const seen=new Set();
 while(collection&&!seen.has(collection)){if(selected(filters.excludeCollections,collection))return false;seen.add(collection);collection=filters.collectionParents?.[collection];}
 if(selected(filters.excludeTypes,node.type))return false;
 if(node.tags?.some(tag=>tagExcluded(filters,tag)))return false;
 return true;
}
export function edgeAllowed(e,filters,nodes) {
 if(filters.category&&filters.category!=='all'&&e.category!==filters.category)return false;
 if(selected(filters.excludeCategories,e.category)||e.tags?.some(tag=>tagExcluded(filters,tag)))return false;
 if(!entityAllowed(nodes.get(e.from),filters)||!entityAllowed(nodes.get(e.to),filters))return false;
 if(!filters.inactive&&(e.status==='inactive'||e.tags?.some(t=>['inactive','disabled','historical'].includes(t))||[e.from,e.to].some(id=>nodes.get(id)?.status==='inactive'||nodes.get(id)?.tags?.includes('historical'))))return false;
 return true;
}
export function neighborhood(index,start,depth,filters={},limit=Infinity) {
  if(!entityAllowed(index.nodes.get(start),filters))return {nodes:[],edges:[],distances:new Map(),truncated:false};
  const distances=new Map([[start,0]]),queue=[start],included=new Set([start]);let truncated=false;
  for(let i=0;i<queue.length;i++) {
    const current=queue[i],d=distances.get(current);if(d>=depth)continue;
    const edges=(index.adj.get(current)||[]).filter(e=>edgeAllowed(e,filters,index.nodes)).sort((a,b)=>a.id.localeCompare(b.id));
    for(const e of edges) {
      if(filters.direction==='downstream'&&e.from!==current)continue;
      if(filters.direction==='upstream'&&e.to!==current)continue;
      const next=e.from===current?e.to:e.from,n=index.nodes.get(next);if(!entityAllowed(n,filters))continue;
      if(filters.type&&n.type!==filters.type)continue;
      if(filters.tag&&!n.tags.includes(filters.tag)&&!e.tags.includes(filters.tag))continue;
      if(!included.has(next)){if(included.size>=limit){truncated=true;continue;}included.add(next);distances.set(next,d+1);queue.push(next);}
    }
  }
  const edges=[...index.edges.values()].filter(e=>included.has(e.from)&&included.has(e.to)&&edgeAllowed(e,filters,index.nodes));
  return {nodes:[...included].map(id=>index.nodes.get(id)).filter(Boolean),edges,distances,truncated};
}
export function shortestPath(index,start,end,filters={},directed=true) {
  if(!entityAllowed(index.nodes.get(start),filters)||!entityAllowed(index.nodes.get(end),filters))return null;
  const prev=new Map([[start,null]]),queue=[start];
  for(let i=0;i<queue.length;i++) {
    const here=queue[i];if(here===end)break;
    for(const e of index.adj.get(here)||[]) {
      if(!edgeAllowed(e,filters,index.nodes)||directed&&e.from!==here)continue;
      const next=e.from===here?e.to:e.from;if(prev.has(next))continue;
      const n=index.nodes.get(next);if(!entityAllowed(n,filters))continue;if(filters.type&&next!==end&&n.type!==filters.type)continue;
      if(filters.tag&&next!==end&&!n.tags.includes(filters.tag)&&!e.tags.includes(filters.tag))continue;
      prev.set(next,{id:here,edge:e});queue.push(next);
    }
  }
  if(!prev.has(end))return null;
  const nodes=[index.nodes.get(end)],edges=[];let at=end;
  while(prev.get(at)){const p=prev.get(at);edges.unshift(p.edge);nodes.unshift(index.nodes.get(p.id));at=p.id;}
  return {nodes,edges};
}
const normalized=value=>String(value||'').toLocaleLowerCase('en').replace(/#/g,'');
export function relevance(record,query){
 const words=normalized(query).trim().split(/\s+/u).filter(Boolean);
 const name=normalized(record.name||record.label),headings=normalized((record.body||'').split('\n').filter(l=>/^#{1,6} /.test(l)).join(' ')),tags=normalized((record.tags||[]).join(' ')),body=normalized(record.body||record.text||''),type=normalized(record.type);
 if(!words.every(w=>[name,headings,tags,body,type].some(t=>t.includes(w))))return -1;
 return (name===normalized(query).trim()?10000:0)+words.reduce((sum,w)=>sum+(name.includes(w)?1000:headings.includes(w)?500:tags.includes(w)?250:1),0);
}
export function searchEntities(entities,query,filters={}){return entities.filter(n=>entityAllowed(n,filters)).map(n=>({n,score:relevance(n,query)})).filter(r=>r.score>=0).sort((a,b)=>b.score-a.score||compareEntities(a.n,b.n)).map(r=>r.n);}
export function searchIndex(data) {
 return [...data.entities.map(n=>({kind:'entity',id:n.id,label:n.name,type:n.type,collection:n.collection,tags:n.tags,body:n.body,text:JSON.stringify(n)})),...data.relationships.map(e=>({kind:'relationship',id:e.id,label:e.type,type:e.type,category:e.category,from:e.from,to:e.to,tags:e.tags,body:e.description,text:JSON.stringify(e)}))];
}
export function search(records,query,{kind='all',type='',tag='',...filters}={}) {
 return records.filter(r=>{
  if(kind!=='all'&&r.kind!==kind||type&&r.type!==type||tag&&!r.tags.includes(tag))return false;
  if(r.kind==='entity')return entityAllowed(r,filters);
  if(selected(filters.excludeCategories,r.category)||r.tags.some(t=>tagExcluded(filters,t)))return false;
  const nodes=filters.entitiesById;
  return !nodes||entityAllowed(nodes.get(r.from),filters)&&entityAllowed(nodes.get(r.to),filters);
 }).map(r=>({r,score:relevance(r,query)})).filter(x=>x.score>=0).sort((a,b)=>b.score-a.score||a.r.label.localeCompare(b.r.label)).map(x=>x.r);
}

// Preserve every relationship's direction, meaning and identity.
export function displayRelationships(edges){
 return edges.map(e=>({...e,records:[e]}));
}

export function compareEntities(a,b){return a.name.localeCompare(b.name,'en',{sensitivity:'base',numeric:true})||a.id.localeCompare(b.id,'en');}
export function firstEntity(data,collection='collections'){
 if(collection==='collections')return data.entities.filter(n=>n.cover).sort((a,b)=>a.coverDepth-b.coverDepth||compareEntities(a,b))[0]||[...data.entities].sort(compareEntities)[0];
 const cover=data.collections.find(c=>c.id===collection)?.coverId;
 return data.entities.find(n=>n.id===cover)||collectionData(data,collection).entities.sort(compareEntities)[0];
}

// Whitespace is the only wrap boundary: identifiers and long words stay intact.
export function wrapNodeName(name,measure,width=224){
 const words=String(name).trim().split(/\s+/u),lines=[];let line='';
 for(const word of words){const candidate=line?line+' '+word:word;if(line&&measure(candidate)>width){lines.push(line);line=word;}else line=candidate;}
 if(line)lines.push(line);return lines;
}
