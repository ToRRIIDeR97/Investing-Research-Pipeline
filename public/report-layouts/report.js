import {label,readerText,readerValue,number,safeUrl,historyMatrix,pricePath,exhibitTitle,chapterNames} from './presentation.mjs';

const main=document.querySelector('main');
const params=new URLSearchParams(location.search);
const layout=params.get('layout')==='analysis'?'analysis':'reader';
document.body.dataset.layout=layout;
document.querySelector(`#${layout}-link`).setAttribute('aria-current','page');
let report,active;
const el=(tag,attrs={},...children)=>{
 const node=document.createElement(tag);
 for(const [key,value] of Object.entries(attrs)){
  if(key.startsWith('on'))node.addEventListener(key.slice(2),value);
  else if(value!==false&&value!=null)node.setAttribute(key,value===true?'':String(value));
 }
 node.append(...children.flat(Infinity).filter(c=>c!=null));return node;
};
const button=(text,handler,attrs={})=>el('button',{type:'button',onclick:handler,...attrs},text);
const clean=readerText;
function date(value){return new Date(value).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'});}
function citation(ids){return ids.map(id=>{
 const index=report.evidence.findIndex(e=>e.id===id);if(index<0)return null;
 return button(`[${index+1}]`,()=>showSource(report.evidence[index]),{class:'citation','aria-label':`Read source ${index+1}: ${report.evidence[index].source_title}`});
});}
function showSource(source){
 const dialog=document.querySelector('#source-dialog'),body=document.querySelector('#source-content');
 document.querySelector('#source-title').textContent=source.source_title;
 body.replaceChildren(el('p',{},`Published ${date(source.published_at)}`),el('blockquote',{},source.quote));
 const url=safeUrl(source.url);if(url)body.append(el('a',{href:url,target:'_blank',rel:'noreferrer'},'Open original source'));
 dialog.showModal();
}
document.querySelector('#close-source').addEventListener('click',()=>document.querySelector('#source-dialog').close());
function renderValue(value){
 if(Array.isArray(value))return value.length?el('ul',{class:'value-list'},value.map(v=>el('li',{},renderValue(v)))):el('span',{class:'muted'},'No observations available');
 if(value&&typeof value==='object')return el('dl',{class:'fields'},Object.entries(value).map(([k,v])=>[el('dt',{},k),el('dd',{},renderValue(v))]));
 return el('span',{},String(value??'Not disclosed'));
}
function dataTable(columns,rows,{compact=false,title='Financial comparison'}={}){
 const table=el('table',{class:`data-table${compact?' compact':''}`},el('caption',{class:'sr-only'},title),
  el('thead',{},el('tr',{},columns.map(c=>el('th',{scope:'col'},c)))),
  el('tbody',{},rows.map(row=>el('tr',{},row.map((value,i)=>el(i===0?'th':'td',{scope:i===0?'row':null,class:value==='Not disclosed'?'missing':null},value))))));
 return el('div',{class:'scroll-region',tabindex:'0',role:'region','aria-label':title},table);
}
function historyExhibit(value,title){
 const model=historyMatrix(value),root=el('div',{}),host=el('div',{});
 const order=['Net revenue','Net income','Net interest income','Non-interest income','Credit losses','Loan loss reserve','Deposits','Total assets','Total liabilities','Shareholders’ equity','Loans held for sale','Loans held for investment, net','Interest paid on deposits','Operating cash flow'];
 model.rows.sort((a,b)=>(order.includes(a.name)?order.indexOf(a.name):99)-(order.includes(b.name)?order.indexOf(b.name):99));
 let start=Math.max(0,model.periods.length-5),query='',expanded=false;
 const search=el('input',{type:'search',placeholder:'Find a measure, e.g. loan loss reserve','aria-label':`Search ${title}`,oninput:e=>{query=e.target.value;draw();}});
 const range=el('span',{}),older=button('Earlier',()=>{start=Math.max(0,start-5);draw();}),newer=button('Later',()=>{start=Math.min(Math.max(0,model.periods.length-5),start+5);draw();});
 const reset=button('Latest',()=>{start=Math.max(0,model.periods.length-5);draw();});
 const count=el('span',{'aria-live':'polite'}),expand=button('Expand table',()=>{expanded=!expanded;draw();},{class:'text-button'});
 root.append(el('p',{class:'table-caption'},'Currency values are shown in millions. Units appear beneath each measure. Missing observations are not treated as zero. Hover a value to see its original precision.'),
 el('div',{class:'table-toolbar'},search,el('div',{class:'period-controls'},older,range,newer,reset)),host,el('div',{class:'table-footer'},count,expand));
 function draw(){
  const periods=model.periods.slice(start,start+5),indices=periods.map((_,i)=>start+i);
  const rows=model.rows.filter(r=>`${r.name} ${r.unit} ${r.basis}`.toLowerCase().includes(query.toLowerCase()));
  range.textContent=periods.length?`${periods[0]} to ${periods.at(-1)}`:'';
  older.disabled=start===0;newer.disabled=start+5>=model.periods.length;
  const table=el('table',{class:'data-table'},el('caption',{class:'sr-only'},title),
   el('thead',{},el('tr',{},el('th',{scope:'col'},'Measure'),periods.map(p=>el('th',{scope:'col'},p)))),
   el('tbody',{},rows.map(row=>el('tr',{},el('th',{scope:'row'},row.name,el('span',{class:'row-subtitle'},[row.unit,row.basis].filter(Boolean).join(' · '))),indices.map(i=>el('td',{title:row.exact[i],class:row.values[i]==='Not disclosed'?'missing':null},row.values[i]))))));
  host.replaceChildren(rows.length?el('div',{class:`scroll-region${expanded?' expanded':''}`,tabindex:'0',role:'region','aria-label':title},table):el('p',{class:'empty-results'},'No measures match your search.'));
  count.textContent=`${rows.length} of ${model.rows.length} measures · ${model.observationCount} saved observations`;
  expand.textContent=expanded?'Limit table height':'Expand table';
 }draw();return root;
}
function recordList(rows,title){
 const items=el('div',{class:'record-list'}),search=el('input',{type:'search',placeholder:'Find in these details','aria-label':`Search ${title}`});
 const preferred=['Measure','Kpi','Risk name','Catalyst name','Name','Segment name','Event','Claim','Driver key','Year','Dataset','Strategy name'];
 const records=rows.map((row,i)=>{
  const data=readerValue(row);const key=preferred.find(k=>typeof data[k]==='string')||Object.keys(data).find(k=>typeof data[k]==='string');
  const heading=key?data[key]:`Entry ${i+1}`;
  const node=el('details',{class:'record',open:rows.length<=3},el('summary',{},heading),renderValue(Object.fromEntries(Object.entries(data).filter(([k])=>k!==key))));
  items.append(node);return {node,text:JSON.stringify(data).toLowerCase()};
 });
 const empty=el('p',{class:'empty-results',hidden:true},'No entries match your search.');
 search.addEventListener('input',()=>{let shown=0;for(const record of records){record.node.hidden=!record.text.includes(search.value.toLowerCase());if(!record.node.hidden)shown++;}empty.hidden=shown>0;});
 return el('div',{},rows.length>5?el('div',{class:'table-toolbar'},search):null,items,empty);
}
function generalData(value,title){
 if(!Array.isArray(value))return renderValue(readerValue(value));
 if(!value.length)return el('p',{class:'table-caption'},'No observations available in the saved research.');
 if(value.every(v=>typeof v!=='object'||v==null))return renderValue(readerValue(value));
 const objects=value.map(v=>readerValue(v)),keys=[...new Set(objects.flatMap(Object.keys))];
 const compact=keys.length<=6&&objects.every(r=>Object.values(r).every(v=>typeof v==='string'&&v.length<90));
 if(compact)return dataTable(keys,objects.map(row=>keys.map(k=>row[k]??'Not disclosed')),{title});
 return recordList(value,title);
}
function exhibit(table,index){
 const title=exhibitTitle(table),value=report.data[table.key];
 const wrapper=el('details',{class:'exhibit',open:index===0,id:`exhibit-${index}`},el('summary',{},title));
 const content=el('div',{class:'exhibit-content'});
 if(['observations','ttm_series'].includes(table.path)&&Array.isArray(value)&&value.every(v=>v.metric_key))content.append(historyExhibit(value,title));
 else if(table.path==='price_target_path'&&Array.isArray(value)){
  const path=pricePath(value);content.append(el('p',{class:'table-caption'},'USD per share. These are the saved model’s scenario targets, not reported company results.'),dataTable(path.columns,path.rows,{title,compact:true}),el('details',{class:'record'},el('summary',{},'Valuation methods, assumptions and returns'),generalData(value,title)));
 }else content.append(generalData(value,title));
 wrapper.append(content);return wrapper;
}
function paragraphs(section){return section.paragraphs.map(p=>el('p',{},
 ['assumption','speculation'].includes(p.kind)?el('span',{class:'assumption'},p.kind==='assumption'?'Analyst assumption':'Speculative possibility'):null,clean(p.text),citation(p.evidence_ids)));}
function navigate(id){location.hash=id;}
function updateLinks(id){for(const mode of ['reader','analysis'])document.querySelector(`#${mode}-link`).href=`?layout=${mode}#${id}`;}
function renderChapter(id){
 const section=report.sections.find(s=>s.id===id)||report.sections.find(s=>s.id==='reported_history_ttm')||report.sections[0];active=section.id;
 const index=report.sections.indexOf(section);updateLinks(active);
 document.querySelectorAll('#chapters a').forEach(a=>a.toggleAttribute('aria-current',a.hash===`#${active}`));
 const aside=el('aside',{class:'exhibits',id:'chapter-data','aria-label':'Supporting data'},el('h3',{class:'section-label'},'Supporting data'),el('p',{class:'exhibits-intro'},`${section.tables.length} exhibits from the saved research. Open a heading to read its details.`),section.tables.map(exhibit));
 const narrative=el('div',{class:'narrative',id:'chapter-analysis'},el('div',{class:'prose'},paragraphs(section)),
  el('div',{class:'counter'},el('h3',{},'Counterarguments & alternatives'),el('p',{},clean(section.counterevidence))),
  el('aside',{class:'callout'},el('h3',{},'Investment implication'),el('p',{},clean(section.implication))),
  section.gaps.length?el('details',{class:'callout qualification',open:true},el('summary',{},`Evidence gaps · ${section.gaps.length}`),el('ul',{},section.gaps.map(g=>el('li',{},clean(g))))):null);
 const jump=(target)=>{document.getElementById(target)?.scrollIntoView({block:'start'});};
 const tools=el('div',{class:'chapter-tools'},el('div',{},button('Read analysis',()=>jump('chapter-analysis'),{class:'text-button'}),button(`View ${section.tables.length} exhibits`,()=>jump('chapter-data'),{class:'text-button'})),
  el('span',{class:'quiet'},`${section.paragraphs.length} paragraphs · Source notes open in place`));
 const next=report.sections[index+1],previous=report.sections[index-1];
 const footer=el('nav',{class:'end-nav','aria-label':'Adjacent chapters'},previous?el('a',{href:`#${previous.id}`},el('small',{},'Previous chapter'),chapterNames[previous.id]||previous.title):el('span'),next?el('a',{href:`#${next.id}`},el('small',{},'Next chapter'),chapterNames[next.id]||next.title):el('a',{href:'#research-questions'},'Research questions'));
 main.replaceChildren(el('header',{class:'chapter-header'},el('div',{class:'chapter-meta'},el('span',{},`Chapter ${index+1} of ${report.sections.length}`),el('span',{class:'state'},'Conclusion withheld')),el('h2',{id:'chapter-title',tabindex:'-1',title:clean(section.title)},chapterNames[section.id]||section.title),el('p',{class:'subtitle'},clean(section.title))),tools,
  el('div',{class:'report-body'},narrative,aside),footer);
 document.title=`${chapterNames[section.id]||section.title} | SoFi research`;
}
function renderQuestions(){
 active='research-questions';updateLinks(active);
 main.replaceChildren(el('header',{class:'chapter-header'},el('div',{class:'chapter-meta'},'SoFi Technologies · Research questions'),el('h2',{id:'chapter-title'},'What remains to be resolved'),el('p',{class:'subtitle'},'The saved report’s questions, answers and next evidence needed.')),
 ...report.questions.map(q=>el('details',{class:'question',open:true},el('summary',{},clean(q.question)),el('p',{class:'status-note'},`${label(q.status)} · ${label(q.materiality)}`),el('p',{},clean(q.answer),citation(q.evidence_ids)),q.follow_up?el('div',{class:'callout'},el('h3',{},'Next evidence needed'),el('p',{},clean(q.follow_up))):null)),
 el('section',{class:'exhibits'},el('h3',{class:'section-label'},'Coverage of the research'),recordList(report.coverage.map(c=>({area:label(c.key),outcome:label(c.status),explanation:c.rationale})),'Research coverage')));
}
function renderSources(){
 active='sources';updateLinks(active);
 main.replaceChildren(el('header',{class:'chapter-header'},el('div',{class:'chapter-meta'},'SoFi Technologies · Evidence'),el('h2',{id:'chapter-title'},'Sources & supporting passages'),el('p',{class:'subtitle'},'Source passages from the saved report. Citation numbers remain consistent across chapters.')),
 ...report.evidence.map((source,i)=>el('details',{class:'source-drawer'},el('summary',{},`[${i+1}] ${source.source_title}`),el('p',{},`Published ${date(source.published_at)}`),el('blockquote',{},source.quote),safeUrl(source.url)?el('a',{href:safeUrl(source.url),target:'_blank',rel:'noreferrer'},'Open original source'):null)));
}
function render(){
 const id=decodeURIComponent(location.hash.slice(1));
 if(id==='chapter-title'){document.getElementById('chapter-title')?.focus();return;}
 if(id==='research-questions')renderQuestions();else if(id==='sources')renderSources();else renderChapter(id);
 document.querySelectorAll('.contents a[href^="#"]').forEach(a=>a.toggleAttribute('aria-current',a.hash===`#${active}`));
 window.scrollTo({top:0});
 document.querySelector('.contents a[aria-current]')?.scrollIntoView({block:'nearest',inline:'nearest'});
}
async function start(){
 try{
  const response=await fetch('report-data.json');if(!response.ok)throw Error('The saved report could not be loaded.');report=await response.json();
  document.querySelector('#chapters').append(...report.sections.map(s=>el('a',{href:`#${s.id}`,'data-search':`${chapterNames[s.id]} ${s.title}`.toLowerCase()},chapterNames[s.id]||s.title)));
  document.querySelector('#chapter-search').addEventListener('input',e=>{for(const a of document.querySelectorAll('#chapters a'))a.hidden=!a.dataset.search.includes(e.target.value.toLowerCase());});
  window.addEventListener('hashchange',render);render();
  if(params.get('focus')==='data')document.getElementById('chapter-data')?.scrollIntoView({block:'start'});
 }catch(error){main.replaceChildren(el('h2',{},'Report unavailable'),el('p',{},error.message),button('Try again',()=>location.reload(),{class:'small-button'}));}
}start();
