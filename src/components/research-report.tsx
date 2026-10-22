"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search, X, ArrowLeft, ArrowRight } from 'lucide-react';
import type { ReportDocument } from '@/lib/research/reporting/report';
import type { ReportSection } from '@/lib/research/reporting/contracts';
import { resolveTable } from '@/lib/research/reporting/tables';
import { sectionVisuals } from '@/lib/research/reporting/visual-trial';
import { label, readerText, readerValue, safeUrl, historyMatrix, pricePath, exhibitTitle, chapterNames } from '@/lib/research/reporting/presentation.mjs';
import { ReportVisual } from './report-visual';
import styles from './research-report.module.css';
import {readerSections,readerSectionId} from '@/lib/research/reporting/data-views';
import {KPIDashboard,ValuationDashboard} from './research-dashboards';
import {ChangeLogTable} from './report/change-log-table';

type RecordValue=Record<string,any>;
const names=chapterNames as Record<string,string>;
const clean=readerText;
const chapterName=(s:ReportSection)=>names[s.id]||clean(s.title);
const date=(value:string|null)=>value?new Date(value).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}):'Undated';

function Values({value}:{value:any}):ReactNode {
  if (Array.isArray(value)) return value.length?<ul>{value.map((v,i)=><li key={i}><Values value={v}/></li>)}</ul>:<span className={styles.muted}>No observations available</span>;
  if (value&&typeof value==='object') return <dl className={styles.fields}>{Object.entries(value).map(([k,v])=><div key={k}><dt>{k}</dt><dd><Values value={v}/></dd></div>)}</dl>;
  return <>{String(value??'Not disclosed')}</>;
}
function Table({columns,rows,title}:{columns:string[];rows:ReactNode[][];title:string}) {
  return <div className={styles.tableScroll} role="region" tabIndex={0} aria-label={title}><table><caption className={styles.srOnly}>{title}</caption><thead><tr>{columns.map((c,i)=><th key={i} scope="col">{c}</th>)}</tr></thead><tbody>{rows.map((row,i)=><tr key={i}>{row.map((value,j)=>j===0?<th scope="row" key={j}>{value}</th>:<td key={j}>{value}</td>)}</tr>)}</tbody></table></div>;
}
function Records({rows,title}:{rows:RecordValue[];title:string}) {
  const [query,setQuery]=useState('');
  const records=rows.map(row=>readerValue(row) as RecordValue);
  const visible=records.filter(r=>JSON.stringify(r).toLowerCase().includes(query.toLowerCase()));
  const preferred=['Claimed moat','Process node','Segment name','Risk name','Catalyst name','Name','Measure','Question','Event','Claim','Driver key','Year','Dataset','Strategy name'];
  return <>{records.length>5&&<input className={styles.searchInput} type="search" aria-label={`Search ${title}`} placeholder="Find in these details" value={query} onChange={e=>setQuery(e.target.value)}/>}
    {visible.map((row,i)=>{const key=preferred.find(k=>typeof row[k]==='string')||Object.keys(row).find(k=>typeof row[k]==='string');
      return <details className={styles.record} key={i}><summary>{key?row[key]:`Entry ${i+1}`}</summary><Values value={Object.fromEntries(Object.entries(row).filter(([k])=>k!==key))}/></details>;
    })}{!visible.length&&<p className={styles.muted}>No entries match your search.</p>}</>;
}
function GeneralData({value,title}:{value:any;title:string}) {
  if(!Array.isArray(value))return <Values value={readerValue(value)}/>;
  if(!value.length)return <p>No observations available.</p>;
  if(value.every(v=>v==null||typeof v!=='object'))return <Values value={readerValue(value)}/>;
  const rows=value.map(v=>readerValue(v)) as RecordValue[];
  const keys=[...new Set(rows.flatMap(Object.keys))];
  if(keys.length<=6&&rows.every(r=>Object.values(r).every(v=>typeof v==='string'&&v.length<90)))return <Table title={title} columns={keys} rows={rows.map(r=>keys.map(k=>r[k]??'Not disclosed'))}/>;
  return <Records rows={value} title={title}/>;
}
function History({value,title}:{value:RecordValue[];title:string}) {
  const model=useMemo(()=>historyMatrix(value),[value]);
  const [start,setStart]=useState(Math.max(0,model.periods.length-5));
  const [query,setQuery]=useState(''); const [expanded,setExpanded]=useState(false);
  const periods=model.periods.slice(start,start+5);
  const rows=model.rows.filter(r=>`${r.name} ${r.basis}`.toLowerCase().includes(query.toLowerCase()));
  return <>
    <p className={styles.caption}>Currency values are shown in millions. Units and reporting basis appear beneath each measure. Missing observations are not zero.</p>
    <div className={styles.tableTools}><input type="search" aria-label={`Search ${title}`} placeholder="Find a measure" value={query} onChange={e=>setQuery(e.target.value)}/><div><button disabled={!start} onClick={()=>setStart(Math.max(0,start-5))}>Earlier</button><span>{periods[0]} to {periods.at(-1)}</span><button disabled={start+5>=model.periods.length} onClick={()=>setStart(Math.min(model.periods.length-5,start+5))}>Later</button><button onClick={()=>setStart(Math.max(0,model.periods.length-5))}>Latest</button></div></div>
    <div className={expanded?styles.expanded:styles.history}><Table title={title} columns={['Measure',...periods]} rows={rows.map(r=>[<><strong>{r.name}</strong><small>{r.unit} · {r.basis}</small></>,...periods.map((_,i)=><span key={i} title={r.exact[start+i]} tabIndex={0} aria-label={`${r.values[start+i]}; original value ${r.exact[start+i]||'Not disclosed'}`}>{r.values[start+i]}</span>)])}/></div>
    {!rows.length&&<p>No measures match your search.</p>}<div className={styles.tableFooter}><span aria-live="polite">{rows.length} {rows.length===1?'measure':'measures'} · {model.observationCount} observations</span><button onClick={()=>setExpanded(!expanded)}>{expanded?'Limit table height':'Expand table'}</button></div>
  </>;
}
function Exhibit({table,document,index}:{table:ReportSection['tables'][number];document:ReportDocument;index:number}) {
  const title=exhibitTitle(table);let value:unknown;
  try{value=resolveTable(table,document.artifacts);}catch{return <p>{title}: supporting data unavailable.</p>;}
  let content:ReactNode;
  if(['observations','ttm_series'].includes(table.path)&&Array.isArray(value)&&value.every(v=>v.metric_key)) content=<History value={value} title={title}/>;
  else if(table.path==='price_target_path'&&Array.isArray(value)){const path=pricePath(value);content=<><p className={styles.caption}>USD per share. Model scenarios, not reported results.</p><Table title={title} columns={path.columns} rows={path.rows}/><details className={styles.record}><summary>Valuation assumptions and returns</summary><GeneralData value={value} title={title}/></details></>;}
  else content=<GeneralData value={value} title={title}/>;
  return <details className={styles.exhibit} open={index===0}><summary>{title}</summary><div className={styles.exhibitBody}>{content}</div></details>;
}

export function ResearchReport({document,onBack,financialsHref,liveArtifacts}:{document:ReportDocument;onBack?:()=>void;financialsHref?:string;liveArtifacts?:Record<string,any>[]}) {
  const sections=useMemo(()=>readerSections(document.sections),[document]);
  const [active,setActive]=useState(sections[0]?.id??'');
  const [mode,setMode]=useState<'reader'|'analysis'>('reader');
  const [query,setQuery]=useState(''); const [source,setSource]=useState<string|null>(null);
  const dialog=useRef<HTMLDialogElement>(null); const heading=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{
    const read=()=>{let hash='';try{hash=readerSectionId(decodeURIComponent(window.location.hash.slice(1)).replace(/^report-/,''));}catch{}if(sections.some(s=>s.id===hash)||['sources','research-questions'].includes(hash))setActive(hash);else if(!['chapter-analysis','chapter-evidence','content'].includes(hash))setActive(sections[0]?.id??'');const m=new URLSearchParams(window.location.search).get('layout');setMode(m==='analysis'?'analysis':'reader');};
    read();window.addEventListener('hashchange',read);window.addEventListener('popstate',read);return()=>{window.removeEventListener('hashchange',read);window.removeEventListener('popstate',read);};
  },[document,sections]);
  const section=sections.find(s=>s.id===active); const index=sections.findIndex(s=>s.id===active);
  // KPI and valuation chapters open on their own summary; the left rail names the chapter.
  const dashboard=!!section&&(section.coverage.includes('valuation')||section.coverage.includes('monitoring'));
  const visuals=useMemo(()=>sectionVisuals(document,active),[document,active]);
  const evidence=document.evidence.find(e=>e.id===source);
  function showSource(id:string){setSource(id);dialog.current?.showModal();}
  function navigate(id:string){setActive(id);window.location.hash=`report-${id}`;window.scrollTo({top:0});requestAnimationFrame(()=>heading.current?.focus({preventScroll:true}));}
  function changeMode(value:'reader'|'analysis'){setMode(value);const url=new URL(window.location.href);url.searchParams.set('layout',value);window.history.replaceState(null,'',url);}
  function citations(ids:string[]){return ids.map(id=>{const i=document.evidence.findIndex(e=>e.id===id);return i<0?null:<button key={id} onClick={()=>showSource(id)} className={styles.citation} aria-label={`Read source ${i+1}: ${document.evidence[i].source_title}`}>[{i+1}]</button>;});}
  const chapters=sections.filter(s=>`${s.title} ${chapterName(s)}`.toLowerCase().includes(query.toLowerCase()));
  const adjacent=<nav className={styles.adjacent} aria-label="Adjacent chapters">{index>0?<button onClick={()=>navigate(sections[index-1].id)}><ArrowLeft size={16}/>{chapterName(sections[index-1])}</button>:<span/>}{index>=0&&index<sections.length-1&&<button onClick={()=>navigate(sections[index+1].id)}>{chapterName(sections[index+1])}<ArrowRight size={16}/></button>}</nav>;
  if(!sections.length)return <p role="status">No report chapters are available yet.</p>;
  return <article className={styles.report} data-layout={mode}>
    <div className={styles.reportBar}><div role="group" aria-label="Report layout"><button aria-pressed={mode==='reader'} onClick={()=>changeMode('reader')}>Reading view</button><button aria-pressed={mode==='analysis'} onClick={()=>changeMode('analysis')}>Analysis view</button></div>{onBack&&<button className={styles.back} onClick={onBack}>Research summary</button>}<a href="#report-content" className={styles.skip} onClick={e=>{e.preventDefault();heading.current?.focus();}}>Skip to chapter</a></div>
    <div className={styles.shell}><aside className={styles.contents}>
      <div className={styles.company}><h2>{document.asset_name.replace(/,? Inc\.?$/,'')}</h2><p>Full initiation research</p></div>
      <label className={styles.chapterSearch}><Search size={17}/><input type="search" aria-label="Find a chapter" placeholder="Search chapters" value={query} onChange={e=>setQuery(e.target.value)}/></label>
      <nav aria-label="Report chapters">{chapters.map(s=><a href={`#report-${s.id}`} key={s.id} aria-current={active===s.id?'page':undefined} onClick={e=>{e.preventDefault();navigate(s.id);}}>{chapterName(s)}</a>)}{!chapters.length&&<p>No chapters match.</p>}</nav>
      <div className={styles.railFoot}><a href="#report-research-questions" aria-current={active==='research-questions'?'page':undefined} onClick={e=>{e.preventDefault();navigate('research-questions');}}>Research questions</a><a href="#report-sources" aria-current={active==='sources'?'page':undefined} onClick={e=>{e.preventDefault();navigate('sources');}}>Sources</a><p>Research as of<br/>{date(document.cutoff)}</p></div>
    </aside><div className={styles.chapter} id="report-content">
      {document.is_test&&<p className={styles.notice}>Synthetic test report. Not for investment decisions.</p>}
      {!dashboard&&<div className={styles.chapterMeta}><span className={styles.status}>{document.conclusion_status==='withheld'?'Conclusion withheld':document.conclusion_status==='qualified'?'Qualified research':'Ready for review'}</span></div>}
      <h2 className={dashboard?styles.srOnly:styles.chapterTitle} ref={heading} tabIndex={-1}>{section?chapterName(section):active==='sources'?'Sources & supporting passages':'What remains to be resolved'}</h2>
      {section?<>
        {financialsHref&&section.tables.some(t=>t.path==='observations')&&<p className={styles.caption}><a href={financialsHref}>Open Financials for income statement, balance sheet and cash flow.</a></p>}
        {section.coverage.includes('valuation')&&<ValuationDashboard artifacts={document.artifacts} conclusionStatus={document.conclusion_status}/>}
        {section.coverage.includes('monitoring')&&<KPIDashboard artifacts={liveArtifacts??document.artifacts} compact/>}
        {visuals.map((visual,i)=><ReportVisual key={`${active}-${i}`} visual={visual} document={document} onSource={showSource}/>)}
        <div className={styles.body}>
          <div className={styles.narrative} id="chapter-analysis"><h3>Analysis</h3>{section.paragraphs.map((p,i)=><p key={i}>{['assumption','speculation'].includes(p.kind)&&<span className={styles.assumption}>{p.kind==='assumption'?'Analyst assumption':'Speculative possibility'}</span>}{clean(p.text)}{citations(p.evidence_ids)}</p>)}
            <h3>Counterarguments & alternatives</h3><p>{clean(section.counterevidence)}</p><h3>Investment implication</h3><p>{clean(section.implication)}</p>
            {!!section.gaps.length&&<details className={styles.evidenceGaps}><summary>Evidence gaps</summary><ul>{section.gaps.map((g,i)=><li key={i}>{clean(g)}</li>)}</ul></details>}
          </div>
          {mode==='analysis'&&!!section.tables.length&&<aside className={styles.exhibits} id="chapter-evidence"><h3>Further details</h3>{section.tables.filter(t=>!['observations','ttm_series','coverage.cells','coverage.gaps'].includes(t.path)).map((t,i)=><Exhibit key={`${active}-${i}`} table={t} document={document} index={i}/>)}</aside>}
        </div>{adjacent}
      </>:active==='sources'?document.evidence.map((e,i)=><details className={styles.source} key={e.id}><summary>[{i+1}] {e.source_title}</summary><p>{date(e.published_at)} · {clean(e.location)}</p><blockquote>{e.quote}</blockquote>{safeUrl(e.url)&&<a href={safeUrl(e.url)!} target="_blank" rel="noreferrer">Open original source</a>}</details>):<>
        {document.questions.map(q=><details key={q.id} className={styles.question} open><summary>{clean(q.question)}</summary><p className={styles.caption}>{label(q.status)} · {label(q.materiality)}</p><p>{clean(q.answer)}{citations(q.evidence_ids)}</p>{q.follow_up&&<p><strong>Next evidence needed. </strong>{clean(q.follow_up)}</p>}</details>)}
        <ChangeLogTable artifacts={document.artifacts}/>
        <h3>Research coverage</h3><GeneralData title="Research coverage" value={document.coverage.map(c=>({area:label(c.key),outcome:label(c.status),reason:c.rationale}))}/>
      </>}
    </div></div>
    <dialog ref={dialog} className={styles.dialog} onClose={()=>setSource(null)} aria-labelledby="source-title"><div className={styles.dialogHead}><h2 id="source-title">{evidence?.source_title??'Source note'}</h2><button aria-label="Close source" onClick={()=>dialog.current?.close()}><X size={20}/></button></div>{evidence&&<><p>{date(evidence.published_at)} · {clean(evidence.location)}</p><blockquote>{evidence.quote}</blockquote>{safeUrl(evidence.url)&&<a href={safeUrl(evidence.url)!} target="_blank" rel="noreferrer">Open original source</a>}</>}</dialog>
  </article>;
}
