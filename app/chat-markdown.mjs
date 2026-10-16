// Safe chat Markdown: raw HTML and images never become active DOM. Article
// targets resolve only against records in the currently open library.
import {parseMarkdownTable,hasTablePipes,splitTableCellLines} from './weave/table-source.mjs';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Protect escaped ASCII punctuation before matching emphasis/link delimiters.
// Code spans keep their backslashes verbatim, as do fenced code blocks.
function protectEscapes(value) {
  let prefix='\uE000WEAVEESC';
  while(value.includes(prefix))prefix+='X';
  const escaped=[];
  let text='',i=0;
  while(i<value.length){
    if(value[i]==='\\' && /[!-/:-@\[-`{-~]/.test(value[i+1]||'')){
      text+=prefix+escaped.length+'\uE001';escaped.push(value[i+1]);i+=2;continue;
    }
    if(value[i]==='`'){
      const opening=value.slice(i).match(/^`+/)[0];
      const tail=value.slice(i+opening.length), closing=new RegExp('(?<!`)`{'+opening.length+'}(?!`)').exec(tail);
      if(closing){const end=i+opening.length+closing.index+opening.length;text+=value.slice(i,end);i=end;continue;}
    }
    text+=value[i++];
  }
  return {text,restore:part=>part.replace(new RegExp(prefix+'(\\d+)\uE001','g'),(_,index)=>escaped[Number(index)])};
}
export function articleResolver(entities=[]) {
  const ids=new Map(entities.map(e=>[e.id,e])),aliases=new Map();
  for(const entity of entities)for(const alias of [entity.name,entity.pipelineName,entity.file,entity.file?.replace(/^knowledge\//,'')].filter(Boolean)){
    aliases.set(alias,aliases.has(alias)&&aliases.get(alias)!==entity.id?null:entity.id);
  }
  return value=>{
    let target=String(value).trim();
    try{target=decodeURIComponent(target);}catch{}
    if(ids.has(target))return target;
    if(target.startsWith('entity:')&&ids.has(target.slice(7)))return target.slice(7);
    if(target.startsWith('#')){const params=new URLSearchParams(target.slice(1));if(ids.has(params.get('id')))return params.get('id');}
    if(/^(?:\.\/)?[^:]+\.md(?:#.*)?$/i.test(target))target=target.replace(/^\.\//,'').split('#')[0];
    return aliases.get(target)||null;
  };
}
const UNDERLINED_TOKENS=/(\x60+)([\s\S]*?)\1|!?\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(\*\*|__)(.+?)\5|(\*|_)([^*_\n]+?)\7|~~(.+?)~~|==([^=\s](?:.*?[^=\s])?)==|<u>(.+?)<\/u>/g;
const PLAIN_TOKENS=new RegExp(UNDERLINED_TOKENS.source.replace('|<u>(.+?)<\\/u>','|(?!)()'),'g');
export function renderChatMarkdown(text,entities=[],resolveLink,{headingSpacing=false,linkTitle='',underline=true}={}) {
  const resolve=resolveLink||articleResolver(entities);
  const hint=linkTitle ? ' title="'+esc(linkTitle)+'"' : '';
  const button=(id,label)=>'<button type="button" class="entity-link chat-article-link" data-chat-entity="'+esc(id)+'"'+hint+'>'+label+'</button>';
  const plain=(value,links=true)=>links?value.split(/((?:[\p{L}\p{N}_-]+:)+[^\s<>()\[\]{}"'\x60.,;!?]+)/u).map(s=>{const id=resolve(s);return id?button(id,esc(s)):esc(s);}).join(''):esc(value);
  function inline(value,links=true,depth=0,restore){
    if(!restore){const protectedText=protectEscapes(value);value=protectedText.text;restore=protectedText.restore;}
    if(depth>8)return esc(restore(value));
    // With underlines off, <u> tags stay literal text like other inline HTML.
    const tokens=underline?UNDERLINED_TOKENS:PLAIN_TOKENS;tokens.lastIndex=0;
    let html='',start=0;
    for(const match of value.matchAll(tokens)){
      // CommonMark does not treat underscores inside identifiers as emphasis.
      if ((match[5] === '__' || match[7] === '_') && (/\w/u.test(value[match.index - 1] || '') || /\w/u.test(value[match.index + match[0].length] || ''))) continue;
      html+=plain(restore(value.slice(start,match.index)),links);start=match.index+match[0].length;
      if(match[1]){const id=links&&resolve(match[2]);html+=id?button(id,'<code>'+esc(match[2])+'</code>'):'<code>'+esc(match[2])+'</code>';continue;}
      if(match[3]){
        const label=inline(match[3],false,depth+1,restore),target=restore(match[4]),id=links&&resolve(target);
        if(match[0].startsWith('!'))html+=label;
        else if(id)html+=button(id,label);
        else if(links&&/^https?:\/\//i.test(target)){
          try{const url=new URL(target);html+=url.username||url.password?label:'<a href="'+esc(url.href)+'" target="_blank" rel="noopener noreferrer"'+hint+'>'+label+'</a>';}catch{html+=label;}
        }else html+=label;
        continue;
      }
      if(match[5])html+='<strong>'+inline(match[6],links,depth+1,restore)+'</strong>';
      else if(match[7])html+='<em>'+inline(match[8],links,depth+1,restore)+'</em>';
      else if(match[9]!==undefined)html+='<del>'+inline(match[9],links,depth+1,restore)+'</del>';
      else if(match[10]!==undefined)html+='<mark class="md-highlight">'+inline(match[10],links,depth+1,restore)+'</mark>';
      else html+='<u>'+inline(match[11],links,depth+1,restore)+'</u>';
    }
    return html+plain(restore(value.slice(start)),links);
  }
  const listItem=line=>line.match(/^([ \t]*)([-+*]|\d+[.)])([ \t]+)(.*)$/);
  // Markdown tabs advance to four-column stops. Counting characters and slicing
  // two of them used to swallow a nested item's marker after a literal tab.
  const columns=whitespace=>{let column=0;for(const char of whitespace)column+=char==='\t'?4-column%4:1;return column;};
  const stripIndent=(line,width)=>{
    let column=0,index=0;
    while(index<line.length && column<width && /[ \t]/.test(line[index])) {column+=line[index]==='\t'?4-column%4:1;index++;}
    return ' '.repeat(Math.max(0,column-width))+line.slice(index);
  };
  const tableCell=(value,tag,alignment)=>'<'+tag+(alignment?' style="text-align:'+alignment+'"':'')+'>'+splitTableCellLines(value).map(part=>inline(part)).join('<br>')+'</'+tag+'>';
  function blocks(lines,depth=0){
    if(depth>12)return '<pre>'+esc(lines.join('\n'))+'</pre>';
    let html='',i=0;
    while(i<lines.length){
      const line=lines[i];if(!line.trim()){i++;continue;}
      const fence=line.match(/^\s*(\x60{3,}|~{3,})(.*)$/);
      if(fence){const body=[];i++;while(i<lines.length&&!new RegExp('^\\s*'+fence[1][0]+'{'+fence[1].length+',}\\s*$').test(lines[i]))body.push(lines[i++]);if(i<lines.length)i++;const language=fence[2].trim().split(/\s+/)[0];html+='<pre><code'+(language?' data-language="'+esc(language)+'"':'')+'>'+esc(body.join('\n'))+'</code></pre>';continue;}
      const heading=line.match(/^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?$/);
      if(heading){html+='<h'+heading[1].length+(headingSpacing && i+1<lines.length && !lines[i+1].trim()?' class="heading-spaced"':'')+'>'+inline(heading[2])+'</h'+heading[1].length+'>';i++;continue;}
      if(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)){html+='<hr>';i++;continue;}
      if(/^\s*>/.test(line)){const quote=[];while(i<lines.length&&/^\s*>/.test(lines[i]))quote.push(lines[i++].replace(/^\s*>\s?/,''));html+='<blockquote>'+blocks(quote,depth+1)+'</blockquote>';continue;}
      if(parseMarkdownTable(line+'\n'+(lines[i+1]||''))){
        const source=[line,lines[i+1]];i+=2;
        while(i<lines.length&&hasTablePipes(lines[i])&&lines[i].trim())source.push(lines[i++]);
        const table=parseMarkdownTable(source.join('\n'));
        html+='<div class="chat-table"><table><thead><tr>'+table.rows[0].map((cell,column)=>tableCell(cell,'th',table.alignments[column])).join('')+'</tr></thead><tbody>';
        for(const row of table.rows.slice(1))html+='<tr>'+row.map((cell,column)=>tableCell(cell,'td',table.alignments[column])).join('')+'</tr>';
        html+='</tbody></table></div>';continue;
      }
      const item=listItem(line);
      if(item){
        const indent=columns(item[1]),ordered=/^\d/.test(item[2]),tag=ordered?'ol':'ul';
        html+='<'+tag+(ordered?' start="'+parseInt(item[2],10)+'"':'')+'>';
        while(i<lines.length){
          const next=listItem(lines[i]);if(!next||columns(next[1])!==indent||/^\d/.test(next[2])!==ordered)break;
          const contentIndent=columns(next[1]+next[2]+next[3]),body=[next[4]];i++;
          while(i<lines.length){
            if(!lines[i].trim()){if(i+1<lines.length&&(/^\s+/.test(lines[i+1])||listItem(lines[i+1]))){body.push('');i++;continue;}break;}
            const other=listItem(lines[i]);if(other&&columns(other[1])<=indent)break;
            if(columns(lines[i].match(/^[ \t]*/)[0])<=indent)break;
            body.push(stripIndent(lines[i],contentIndent));i++;
          }
          html+='<li>'+blocks(body,depth+1)+'</li>';
          while(i<lines.length&&!lines[i].trim())i++;
        }
        html+='</'+tag+'>';continue;
      }
      const paragraph=[line];i++;
      while(i<lines.length&&lines[i].trim()&&!/^\s*(?:#{1,6}\s|>|\x60{3,}|~{3,}|-{3,}\s*$|\*{3,}\s*$)/.test(lines[i])&&!listItem(lines[i])&&!parseMarkdownTable(lines[i]+'\n'+(lines[i+1]||'')))paragraph.push(lines[i++]);
      html+='<p>'+paragraph.map((p,n)=>{
        const hardBreak=/ {2,}$/.test(p)||(p.match(/\\+$/)?.[0].length||0)%2===1;
        const content=hardBreak?p.replace(/(?: {2,}|\\)$/,''):p;
        return inline(content)+(n<paragraph.length-1?(hardBreak?'<br>':' '):'');
      }).join('')+'</p>';
    }
    return html;
  }
  return blocks(String(text).replace(/\r\n?/g,'\n').split('\n'));
}
