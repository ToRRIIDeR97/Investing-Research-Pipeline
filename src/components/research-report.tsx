"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search, X, ArrowLeft, ArrowRight } from 'lucide-react';
import type { ReportDocument } from '@/lib/research/reporting/report';
import type { ReportSection } from '@/lib/research/reporting/contracts';
import { resolveTable } from '@/lib/research/reporting/tables';
import { sectionVisuals } from '@/lib/research/reporting/visual-trial';
import { valuationSummary, scenarioNames } from '@/lib/research/reporting/valuation-summary';
import { price, formatInUnit } from '@/lib/research/reporting/plain-english';
import { label, readerText, readerValue, safeUrl, historyMatrix, pricePath, exhibitTitle, railName, tidyDecimals, compactNumber } from '@/lib/research/reporting/presentation.mjs';
import { ReportVisual } from './report-visual';
import styles from './research-report.module.css';
import {readerSections,readerSectionId} from '@/lib/research/reporting/data-views';
import {KPIDashboard,ValuationDashboard} from './research-dashboards';
import {ChangeLogTable} from './report/change-log-table';
import {ExhibitTile} from './report/exhibit-tile';
import {chapterExhibits} from '@/lib/research/reporting/exhibits';

type RecordValue=Record<string,any>;
const clean=readerText;
const date=(value:string|null)=>value?new Date(value).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}):'Undated';
const pad=(n:number)=>String(n).padStart(2,'0');
// Paths shown elsewhere (Financials tab) or too granular for a chapter.
const hiddenPaths=['observations','ttm_series','coverage.cells','coverage.gaps'];
const nameKeys=['Scenario','Scenario name','Method','Claimed moat','Process node','Segment name','Segment','Risk name','Catalyst name','Name','Measure','Metric','Question','Event','Claim','Driver key','Driver','Indicator','Strategy name','Combination key','Year','Dataset','Title'];
// Reports of this standard store exhibit keys on each section; code builds the exhibits from stored artifacts.
const CODE_BUILT_STANDARD='asset-framework-2.1-adaptive-3';
const isLong=(v:unknown)=>typeof v==='string'&&v.length>90||(!!v&&typeof v==='object');

/** Display name for a record: "bear" in a Scenario field reads "Bear case"; a bare key such as "fcfe" reads "FCFE". */
function recordName(row:RecordValue,index:number):{key?:string;name:string} {
  const key=nameKeys.find(k=>typeof row[k]==='string')??Object.keys(row).find(k=>typeof row[k]==='string'&&row[k].length<80);
  if(!key)return {name:`Entry ${index+1}`};
  const raw=String(row[key]);
  if(/^scenario/i.test(key)&&/^(bear|base|bull)$/i.test(raw))return {key,name:`${raw[0].toUpperCase()}${raw.slice(1).toLowerCase()} case`};
  return {key,name:/^[a-z0-9_]+$/.test(raw)?label(raw):raw};
}
/** The opening of a paragraph in bold: its first sentence when short, else its first clause ending at punctuation, else nothing. It never cuts mid-clause. */
function leadIn(text:string,{max=110}:{max?:number;words?:boolean}={}):ReactNode {
  const sentence=text.match(/^(.{12,400}?[.!?])(\s+)([\s\S]*)$/);
  if(sentence&&sentence[1].length<=Math.max(max,60)+30)return <><strong className={styles.lead}>{sentence[1]}</strong>{sentence[2]}{sentence[3]}</>;
  const clause=text.match(new RegExp(`^(.{12,${max}}?)([,;:—–])(\\s[\\s\\S]*)$`))??text.match(/^(.{12,60}?)(:)(\s[\s\S]*)$/);
  if(clause)return <><strong className={styles.lead}>{clause[1]}</strong>{clause[2]}{clause[3]}</>;
  return text;
}
/** Decision thresholds inside a condition: figures with a unit set in semibold. */
function Figures({text}:{text:string}):ReactNode {
  const parts=text.split(/([−-]?\$?\d[\d,]*(?:\.\d+)?\s?(?:%|bps|basis points|[MBK]\b|million|billion)|\$\d[\d,]*(?:\.\d+)?)/);
  return <>{parts.map((part,i)=>i%2?<strong key={i} className={styles.figure}>{part}</strong>:part)}</>;
}
/** A short readable string for a nested value inside a table cell. */
function cellText(value:any):string {
  return compactNumber(tidyDecimals(rawCellText(value)));
}
function rawCellText(value:any):string {
  if(value==null)return '—';
  if(Array.isArray(value))return value.length?value.map(v=>v&&typeof v==='object'?Object.values(v).filter(x=>typeof x!=='object').slice(0,2).join(' · '):String(v)).join('; '):'—';
  if(typeof value==='object')return Object.entries(value).filter(([,v])=>typeof v!=='object').slice(0,4).map(([k,v])=>`${k}: ${v}`).join(' · ')||`${Object.keys(value).length} fields`;
  return String(value);
}
function Value({value,highlight=false}:{value:any;highlight?:boolean}):ReactNode {
  if(Array.isArray(value)){
    if(!value.length)return <span className={styles.muted}>None recorded</span>;
    if(value.every(v=>v==null||typeof v!=='object'))return value.every(v=>String(v).length<=40)?<span>{value.map(String).join(' · ')}</span>:<ul className={styles.inlineList}>{value.map((v,i)=><li key={i}>{highlight?<Figures text={String(v)}/>:String(v)}</li>)}</ul>;
    // A list of flat records (for example one row per forecast year) reads as a small table.
    const keys=[...new Set(value.flatMap(v=>v&&typeof v==='object'?Object.keys(v):[]))];
    if(keys.length<=6&&value.every(v=>v&&typeof v==='object'&&Object.values(v).every(x=>x==null||typeof x!=='object')))
      return <table className={styles.miniTable}><thead><tr>{keys.map(k=><th key={k}>{k}</th>)}</tr></thead><tbody>{value.map((v,i)=><tr key={i}>{keys.map(k=><td key={k}>{cellText(v[k])}</td>)}</tr>)}</tbody></table>;
    return <ul className={styles.inlineList}>{value.map((v,i)=><li key={i}>{cellText(v)}</li>)}</ul>;
  }
  if(value&&typeof value==='object')return <dl className={styles.nested}>{Object.entries(value).map(([k,v])=><div key={k}><dt>{k}</dt><dd><Value value={v}/></dd></div>)}</dl>;
  const text=compactNumber(tidyDecimals(String(value??'Not disclosed')));
  return highlight?<Figures text={String(text)}/>:<>{text}</>;
}
const headerHelp:Record<string,string>={Stability:'0 to 1: how closely the history follows one trend',Confidence:'0 to 1: confidence the model gave this record'};
function Table({columns,rows,title,numeric,prose=false}:{columns:string[];rows:ReactNode[][];title:string;numeric?:boolean[];prose?:boolean}) {
  return <div className={prose?`${styles.tableScroll} ${styles.proseTable}`:styles.tableScroll} role="region" tabIndex={0} aria-label={title}><table><caption className={styles.srOnly}>{title}</caption><thead><tr>{columns.map((c,i)=><th key={i} scope="col" className={numeric?.[i]?styles.num:undefined} title={headerHelp[c]}>{headerHelp[c]?<span className={styles.help}>{c}</span>:c}</th>)}</tr></thead><tbody>{rows.map((row,i)=><tr key={i}>{row.map((value,j)=>j===0?<th scope="row" key={j}>{value}</th>:<td key={j} className={numeric?.[j]?styles.num:undefined}>{value}</td>)}</tr>)}</tbody></table></div>;
}
/** Many records: a table, 10 rows and 7 columns at first; the rest on request. Rows that carry a Unit show every number in it. */
function RecordTable({rows:input,title,proper=[]}:{rows:RecordValue[];title:string;proper?:string[]}) {
  const [all,setAll]=useState(false); const [wide,setWide]=useState(false); const [query,setQuery]=useState('');
  const thin=(r:RecordValue)=>Object.values(r).some(v=>typeof v==='string'&&/^insufficient history$/i.test(v));
  const rows=[...input.filter(r=>!thin(r)),...input.filter(thin)];
  const keys=[...new Set(rows.flatMap(Object.keys))];
  const unitKey=keys.find(k=>/^unit$/i.test(k));
  const first=nameKeys.find(k=>keys.includes(k))??keys[0];
  const ordered=[first,...keys.filter(k=>k!==first&&k!==unitKey)];
  // Prose is decided per column: one column of sentences makes the whole table wrap, and body text is never cut.
  const median=(k:string)=>{const l=rows.map(r=>cellText(r[k]).length).sort((x,y)=>x-y);return l[Math.floor(l.length/2)]??0;};
  // Judged on the columns on screen: a numeric table keeps its seven columns; one with sentences in view shows four and wraps.
  const prose=(wide?ordered:ordered.slice(0,7)).some(k=>k!==first&&median(k)>40);
  const columns=wide?ordered:ordered.slice(0,prose?4:7);
  const visible=rows.filter(r=>!query||JSON.stringify(r).toLowerCase().includes(query.toLowerCase()));
  const shown=all?visible:visible.slice(0,10);
  const numericText=(v:unknown)=>v!=null&&/^[−-]?[$€£]?[\d,.]+%?$/.test(String(v));
  const numeric=columns.map(k=>rows.every(r=>r[k]==null||numericText(r[k])));
  const cell=(r:RecordValue,k:string)=>{
    if(thin(r)&&numericText(r[k])&&k!==first)return '—';
    if(/stability|confidence/i.test(k)&&numericText(r[k])){const n=Number(String(r[k]).replace(/,/g,''));if(Number.isFinite(n)&&Math.abs(n)<=1)return n.toFixed(2);}
    if(unitKey&&numericText(r[k])&&!String(r[k]).includes('%')&&!/stability|confidence|count|ratio|score|probability|weight/i.test(k)){const n=Number(String(r[k]).replace(/[,$€£]/g,'').replace('−','-'));if(Number.isFinite(n))return formatInUnit(n,r[unitKey]);}
    let text=cellText(r[k]);
    for(const name of proper)text=text.replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`,'gi'),name);
    return /^[a-z][a-z ]{2,24}$/.test(text)?text[0].toUpperCase()+text.slice(1):text;
  };
  const counted=rows.length>10||ordered.length>7||(prose&&ordered.length>4)||!!query;
  return <>
    {counted&&<div className={styles.tableTools}>
      {rows.length>8?<input type="search" aria-label={`Search ${title}`} placeholder="Filter rows" value={query} onChange={e=>setQuery(e.target.value)}/>:<span/>}
      <div><span>{visible.length===rows.length?`${rows.length} rows`:`${visible.length} of ${rows.length} rows`}</span>{ordered.length>(prose?4:7)&&<button onClick={()=>setWide(!wide)} aria-expanded={wide}>{wide?'Fewer columns':`All ${ordered.length} columns`}</button>}</div>
    </div>}
    <Table title={title} prose={prose} columns={columns} numeric={numeric} rows={shown.map(r=>columns.map(k=>{const text=cell(r,k);if(/^\$0$|^0$/.test(text)&&unitKey)return <span key={k} className={styles.nowrap} title="A zero reading is recorded in the source data">{text}<sup className={styles.zeroMark}>†</sup></span>;if(r[first]==='Total')return <strong key={k} className={styles.nowrap}>{text}</strong>;return !prose&&text.length<=24?<span key={k} className={styles.nowrap}>{text}</span>:text;}))}/>
    {visible.length>10&&<button className={styles.textButton} onClick={()=>setAll(!all)}>{all?'Show first 10 rows':`Show all ${visible.length} rows`}</button>}
    {unitKey&&shown.some(r=>columns.some(k=>/^\$0$|^0$/.test(cell(r,k))))&&<p className={styles.caption}>† A zero reading is recorded in the source data.</p>}
  </>;
}
/** Two to four records that share fields: a comparison grid, fields as rows and records as columns. */
type LeadRow={label:string;values:string[]};
function RecordMatrix({rows,title,lead=[]}:{rows:RecordValue[];title:string;lead?:LeadRow[]}) {
  const [all,setAll]=useState(false);
  const names=rows.map((r,i)=>recordName(r,i));
  const fields=[...new Set(rows.flatMap((r,i)=>Object.keys(r).filter(k=>k!==names[i].key)))];
  const has=(f:string)=>rows.filter(r=>r[f]!=null&&r[f]!=='').length;
  const shared=rows.length>=3?fields.filter(f=>has(f)>1):fields;
  const single=fields.filter(f=>!shared.includes(f));
  const shown=all?shared:shared.slice(0,6);
  return <>
    <div className={styles.matrixScroll} role="region" tabIndex={0} aria-label={title}>
      <table className={styles.matrix}>
        <caption className={styles.srOnly}>{title}</caption>
        <thead><tr><th scope="col"><span className={styles.srOnly}>Field</span></th>{names.map((n,i)=><th scope="col" key={i}>{n.name.replace(/[.;:,]+$/,'')}</th>)}</tr></thead>
        <tbody>{lead.map(l=><tr key={l.label} className={styles.leadRow}><th scope="row">{l.label}</th>{l.values.map((v,i)=><td key={i} className={/^−/.test(v)&&/%$/.test(v)?styles.down:/^\+/.test(v)?styles.up:undefined}>{v}</td>)}</tr>)}{shown.map(f=><tr key={f}><th scope="row">{f}</th>{rows.map((r,i)=><td key={i}>{r[f]==null?<span className={styles.muted}>—</span>:<Value value={r[f]}/>}</td>)}</tr>)}</tbody>
      </table>
    </div>
    {!!single.length&&<dl className={styles.matrixNote}>{single.map(f=>{const i=rows.findIndex(r=>r[f]!=null&&r[f]!=='');return <div key={f}><dt>{f} <span className={styles.muted}>· {names[i].name} only</span></dt><dd><Value value={rows[i][f]}/></dd></div>;})}</dl>}
    {shared.length>6&&<button className={styles.textButton} aria-expanded={all} onClick={()=>setAll(!all)}>{all?'Show fewer fields':`Show all ${shared.length} fields`}</button>}
  </>;
}
function ExhibitData({value,title,lead,proper}:{value:any;title:string;lead?:LeadRow[];proper?:string[]}) {
  // An artifact root that only wraps one list (for example { bottlenecks: [...] }) shows that list.
  if(value&&typeof value==='object'&&!Array.isArray(value)){
    const fields=Object.entries(value).filter(([k])=>k!=='artifact_type');
    if(fields.length===1&&Array.isArray(fields[0][1]))return <ExhibitData value={fields[0][1]} title={title}/>;
    const record=readerValue(Object.fromEntries(fields)) as RecordValue;
    const first=(k:string)=>/must hold|disproving|threshold|decision/i.test(k)?0:1;
    const horizon=typeof record.Horizon==='string'&&record.Horizon.length<60?record.Horizon:null;
    const entries=Object.entries(record).filter(([k])=>!(horizon&&k==='Horizon')).sort((a,b)=>first(a[0])-first(b[0]));
    return <>{horizon&&<p className={styles.caption}>Horizon: {horizon}</p>}<dl className={styles.facts}>{entries.map(([k,v])=><div key={k}><dt>{k}</dt><dd><div className={styles.measureText}><Value value={v} highlight={/must hold|disproving|threshold/i.test(k)}/></div></dd></div>)}</dl></>;
  }
  if(!Array.isArray(value))return <p>{String(readerValue(value))}</p>;
  if(!value.length)return <p className={styles.muted}>No observations available.</p>;
  if(value.every(v=>v==null||typeof v!=='object'))return <ul className={styles.inlineList}>{value.map((v,i)=><li key={i}>{String(readerValue(v))}</li>)}</ul>;
  const rows=value.map(v=>readerValue(v)) as RecordValue[];
  const keys=[...new Set(rows.flatMap(Object.keys))];
  const long=rows.some(r=>Object.values(r).some(isLong));
  if(rows.length<=4&&(long||keys.length>6))return <RecordMatrix rows={rows} title={title} lead={lead}/>;
  return <RecordTable rows={rows} title={title} proper={proper}/>;
}
function History({value,title}:{value:RecordValue[];title:string}) {
  const model=useMemo(()=>historyMatrix(value),[value]);
  const [start,setStart]=useState(Math.max(0,model.periods.length-5));
  const [query,setQuery]=useState('');
  const periods=model.periods.slice(start,start+5);
  const rows=model.rows.filter(r=>`${r.name} ${r.basis}`.toLowerCase().includes(query.toLowerCase()));
  return <>
    <p className={styles.caption}>Currency values in millions. Units and reporting basis appear beneath each measure. Missing observations are not zero.</p>
    <div className={styles.tableTools}><input type="search" aria-label={`Search ${title}`} placeholder="Find a measure" value={query} onChange={e=>setQuery(e.target.value)}/><div><button disabled={!start} onClick={()=>setStart(Math.max(0,start-5))}>Earlier</button><span>{periods[0]} to {periods.at(-1)}</span><button disabled={start+5>=model.periods.length} onClick={()=>setStart(Math.min(model.periods.length-5,start+5))}>Later</button></div></div>
    <Table title={title} columns={['Measure',...periods]} numeric={[false,...periods.map(()=>true)]} rows={rows.map(r=>[<><strong>{r.name}</strong><small>{r.unit} · {r.basis}</small></>,...periods.map((_,i)=><span key={i} title={r.exact[start+i]}>{r.values[start+i]}</span>)])}/>
  </>;
}
/** Segment names as the run spells them, so labels like "Financial services revenue" keep the proper noun. */
function properNames(document:ReportDocument):string[] {
  const names=new Set<string>();
  for(const a of document.artifacts){const segs=(a.content_json as RecordValue)?.segments;if(Array.isArray(segs))for(const s of segs){const n=s?.segment_name??s?.name;if(typeof n==='string'&&/[A-Z]/.test(n)&&n.length<40)names.add(n);}}
  return [...names];
}
/** Numbers first for bear/base/bull records: weight, value per share, return and value today, from the valuation summary. */
function scenarioLead(value:unknown,document:ReportDocument):LeadRow[]|undefined {
  if(!Array.isArray(value)||value.length<2||value.length>4)return undefined;
  const types=value.map(v=>String(v?.scenario_type??v?.scenario??'').toLowerCase());
  if(!types.every(t=>['bear','base','bull'].includes(t)))return undefined;
  const s=valuationSummary(document.artifacts,{conclusionStatus:document.conclusion_status});
  if(!s)return undefined;
  const c=s.currency, at=(t:string)=>s.scenarios.find(x=>x.type===t), calc=(t:string)=>s.calculations.find(x=>x.type===t);
  const pct=(r:number|null|undefined)=>r==null?'—':`${r<0?'−':'+'}${Math.abs(r*100).toFixed(1)}%`;
  return [
    {label:'Weight',values:types.map(t=>at(t)?.probability!=null?`${Math.round(at(t)!.probability!*100)}%`:'—')},
    {label:`Value per share${s.terminalYear?` ${s.terminalYear}`:''}`,values:types.map(t=>price(at(t)?.value,c,true))},
    {label:'Return vs last price',values:types.map(t=>pct(at(t)?.return))},
    {label:'Worth today',values:types.map(t=>price(calc(t)?.valuePerShare,c,true))},
  ];
}
function Exhibit({table,document,id}:{table:ReportSection['tables'][number];document:ReportDocument;id:string}) {
  const title=exhibitTitle(table);let value:unknown;
  const root=document.artifacts.find(a=>a.id===table.artifact_id)?.content_json as RecordValue|undefined;
  const units=table.path&&typeof root?.units==='string'?root.units.replace(/^usd\b/i,'USD'):null;
  try{value=resolveTable(table,document.artifacts);}catch{return <section id={id} className={styles.tile} data-tile data-exhibit><header className={styles.tileHead}><h3 data-tile-title>{title}</h3></header><p className={`${styles.tileBody} ${styles.muted}`}>Supporting data unavailable.</p></section>;}
  let content:ReactNode;
  if(['observations','ttm_series'].includes(table.path)&&Array.isArray(value)&&value.every(v=>v.metric_key)) content=<History value={value} title={title}/>;
  else if(table.path==='price_target_path'&&Array.isArray(value)){const path=pricePath(value);content=<><p className={styles.caption}>USD per share. Model scenarios, not reported results.</p><Table title={title} columns={path.columns} numeric={path.columns.map((_:string,i:number)=>i>0)} rows={path.rows}/></>;}
  else {
    // Measures without a unit (for example trend diagnoses) take it from the historical record, so a row reads $1.2B, not 1,206.
    if(Array.isArray(value)&&value.some(v=>v?.metric_key&&v.unit==null)){
      const history=document.artifacts.find(a=>a.artifact_type==='historical_record')?.content_json as RecordValue|undefined;
      const unitOf=new Map<string,string>();
      for(const o of Array.isArray(history?.observations)?history.observations:[])if(o?.metric_key&&o.unit&&!unitOf.has(o.metric_key))unitOf.set(o.metric_key,o.unit);
      value=value.map(v=>v?.metric_key&&v.unit==null&&unitOf.has(v.metric_key)?{...v,unit:unitOf.get(v.metric_key)}:v);
    }
    // Segment forecast: operating margin per segment and a total row.
    if(Array.isArray(value)&&value.length>1&&value.every(v=>v&&typeof v==='object')){
      const head=(value as RecordValue[])[0];const keys=Object.keys(head);const rev=keys.find(k=>/revenue/i.test(k)&&typeof head[k]==='number');const inc=keys.find(k=>/operating_income|operating income/i.test(k)&&typeof head[k]==='number');const name=keys.find(k=>/segment/i.test(k));
      if(rev&&inc&&name&&(value as RecordValue[]).every(v=>typeof v[rev]==='number'&&typeof v[inc]==='number')){
        const sum=(k:string)=>(value as RecordValue[]).reduce((n,v)=>n+v[k],0);
        const margin=(r:number,i:number)=>r?`${(i/r*100).toFixed(1)}%`:'—';
        value=[...(value as RecordValue[]).map(v=>({...v,operating_margin:margin(v[rev],v[inc]),share_of_revenue:`${(v[rev]/sum(rev)*100).toFixed(1)}%`})),{[name]:'Total',[rev]:sum(rev),[inc]:sum(inc),operating_margin:margin(sum(rev),sum(inc)),share_of_revenue:'100.0%'}];
      }
    }
    const asOf=Array.isArray(value)&&value.some(v=>v?.metric_key&&v.current_level!==undefined)?`Current level is the latest observation in the research corpus as of ${date(document.cutoff)}.`:null;
    const proper=properNames(document);
    const injectUnits=!!units&&Array.isArray(value)&&value.every(v=>v&&typeof v==='object'&&v.unit==null);
    if(injectUnits)value=(value as RecordValue[]).map(v=>({...v,unit:units}));
    content=<>{units&&!injectUnits&&<p className={styles.caption}>Values in {units}.</p>}{asOf&&<p className={styles.caption}>{asOf}</p>}<ExhibitData value={value} title={title} lead={scenarioLead(value,document)} proper={proper}/></>;
  }
  return <section id={id} className={styles.tile} data-tile data-exhibit><header className={styles.tileHead}><h3 data-tile-title>{title}</h3></header><div className={styles.tileBody}>{content}</div></section>;
}
/** The report's answer on every chapter: stance, price, weighted target and the three scenarios. */
function Verdict({document}:{document:ReportDocument}) {
  const s=useMemo(()=>valuationSummary(document.artifacts,{conclusionStatus:document.conclusion_status}),[document]);
  const decision=document.artifacts.find(a=>((a as RecordValue).type??a.artifact_type)==='decision_record')?.content_json as RecordValue|undefined;
  const stance=typeof decision?.decision==='string'?label(decision.decision):document.conclusion_status==='withheld'?'Withheld':label(document.conclusion_status);
  const c=s?.currency??'USD';
  const gap=s?.weightedReturn;
  return <section className={`${styles.tile} ${styles.verdict}`} data-tile data-verdict aria-label="Report verdict">
    <div><span className={styles.statLabel}>Status</span><strong>{statusWord(document.conclusion_status)}</strong><span className={styles.statNote}>Decision: {stance}</span></div>
    <div><span className={styles.statLabel}>Last price</span><strong>{price(s?.price,c,true)}</strong><span className={styles.statNote}>{s?.priceVerified?'Verified close':'Unverified'}</span></div>
    <div><span className={styles.statLabel}>Weighted target{s?.terminalYear?` ${s.terminalYear}`:''}</span><strong>{price(s?.weighted,c,true)}</strong>{gap!=null&&<span className={gap<0?styles.down:styles.up}>{gap<0?'−':'+'}{Math.abs(gap*100).toFixed(1)}% vs price</span>}</div>
    {(s?.scenarios??[]).map(x=><div key={x.type}><span className={styles.statLabel}>{scenarioNames[x.type]}{x.probability!=null?` · ${Math.round(x.probability*100)}%`:''}</span><strong>{price(x.value,c,true)}</strong>{x.return!=null&&<span className={x.return<0?styles.down:styles.up}>{x.return<0?'−':'+'}{Math.abs(x.return*100).toFixed(1)}%</span>}</div>)}
  </section>;
}
const statusWord=(s:string)=>s==='withheld'?'Conclusion withheld':s==='qualified'?'Qualified research':'Ready for review';
function Citations({ids,document,onSource}:{ids:string[];document:ReportDocument;onSource:(id:string)=>void}) {
  const [open,setOpen]=useState(false);
  const found=ids.map(id=>({id,i:document.evidence.findIndex(e=>e.id===id)})).filter(x=>x.i>=0);
  if(!found.length)return null;
  const shown=open?found:found.slice(0,3);
  return <span className={styles.citations}>{shown.map(({id,i})=><button key={id} onClick={()=>onSource(id)} className={styles.citation} aria-label={`Read source ${i+1}: ${document.evidence[i].source_title}`}>{i+1}</button>)}{found.length>3&&!open&&<button className={styles.citation} onClick={()=>setOpen(true)} aria-label={`Show ${found.length-3} more sources`}>+{found.length-3}</button>}</span>;
}
function Gaps({gaps}:{gaps:string[]}) {
  const [all,setAll]=useState(false);
  return <section className={styles.tile} data-tile data-gaps>
    <header className={styles.tileHead}><h3 data-tile-title>Evidence gaps</h3><span className={styles.muted}>{gaps.length} open</span></header>
    <ul className={`${styles.tileBody} ${styles.gapList}`}>{(all?gaps:gaps.slice(0,4)).map((g,i)=><li key={i}>{clean(g)}</li>)}</ul>
    {gaps.length>4&&<button className={`${styles.textButton} ${styles.tileFoot}`} aria-expanded={all} onClick={()=>setAll(!all)}>{all?'Show fewer':`Show all ${gaps.length} gaps`}</button>}
  </section>;
}
const questionStatus:Record<string,string>={answered:'completed',qualified:'pending',blocked:'failed'};

export function ResearchReport({document,financialsHref,liveArtifacts}:{document:ReportDocument;onBack?:()=>void;financialsHref?:string;liveArtifacts?:Record<string,any>[]}) {
  const sections=useMemo(()=>readerSections(document.sections),[document]);
  const [active,setActive]=useState(sections[0]?.id??'');
  const [query,setQuery]=useState(''); const [source,setSource]=useState<string|null>(null); const [qFilter,setQFilter]=useState<string|null>(null); const [place,setPlace]=useState('chapter-takeaway');
  // Which part of the chapter is under the header, for the rail's in-chapter marker.
  useEffect(()=>{const ids=['chapter-takeaway','chapter-lead','chapter-analysis','chapter-exhibits'];const on=()=>{let current=ids[0];for(const id of ids){const el=window.document.getElementById(id);if(el&&el.getBoundingClientRect().top<140)current=id;}setPlace(current);};on();window.addEventListener('scroll',on,{passive:true});return()=>window.removeEventListener('scroll',on);},[active]);
  const dialog=useRef<HTMLDialogElement>(null); const heading=useRef<HTMLHeadingElement>(null); const root=useRef<HTMLElement>(null);
  useEffect(()=>{
    const read=()=>{let hash='';try{hash=readerSectionId(decodeURIComponent(window.location.hash.slice(1)).replace(/^report-/,''));}catch{}if(sections.some(s=>s.id===hash)||['sources','research-questions'].includes(hash))setActive(hash);else if(!['chapter-analysis','chapter-evidence','content'].includes(hash)&&!hash.startsWith('exhibit-'))setActive(sections[0]?.id??'');};
    read();window.addEventListener('hashchange',read);window.addEventListener('popstate',read);return()=>{window.removeEventListener('hashchange',read);window.removeEventListener('popstate',read);};
  },[document,sections]);
  const section=sections.find(s=>s.id===active); const index=sections.findIndex(s=>s.id===active);
  const visuals=useMemo(()=>sectionVisuals(document,active),[document,active]);
  const codeBuilt=document.standard_version===CODE_BUILT_STANDARD;
  const built=useMemo(()=>codeBuilt?chapterExhibits(document,active):[],[codeBuilt,document,active]);
  const evidence=document.evidence.find(e=>e.id===source);
  function showSource(id:string){setSource(id);dialog.current?.showModal();}
  function navigate(id:string){setActive(id);window.location.hash=`report-${id}`;const top=root.current?root.current.getBoundingClientRect().top+window.scrollY-68:0;window.scrollTo({top:Math.max(0,top)});requestAnimationFrame(()=>heading.current?.focus({preventScroll:true}));}
  function jump(id:string){window.document.getElementById(id)?.scrollIntoView({block:'start'});}
  const chapters=sections.map((s,i)=>({s,i})).filter(({s})=>`${s.title} ${railName(s)}`.toLowerCase().includes(query.toLowerCase()));
  const status=document.conclusion_status==='withheld'?{label:'Conclusion withheld',tone:'pending'}:document.conclusion_status==='qualified'?{label:'Qualified research',tone:'pending'}:{label:'Ready for review',tone:'completed'};
  if(!sections.length)return <p role="status">No report chapters are available yet.</p>;

  // Earlier standards keep the model's table requests and the view's own Exhibit heuristics.
  const exhibits=section&&!codeBuilt?section.tables.filter(t=>!hiddenPaths.includes(t.path)&&!(section.coverage.includes('valuation')&&t.path==='method_schedules')):[];
  const exhibitTitles=codeBuilt?built.map(e=>e.title):exhibits.map(t=>exhibitTitle(t));
  const cited=section?new Set(section.paragraphs.flatMap(p=>p.evidence_ids)).size:0;
  const titleText=section?railName(section):active==='sources'?'Sources':'Research questions';
  // The subtitle carries what the short name leaves out: the title minus its own short prefix.
  const rest=section?clean(section.title).replace(new RegExp(`^${titleText.replace(/[.*+?^${}()|[\]\\…]/g,'\\$&')}[\\s:,—–-]*`,'i'),''):'';
  const afterColon=section&&clean(section.title).includes(': ')?clean(section.title).slice(clean(section.title).indexOf(': ')+2):'';
  const subtitleText=afterColon||(section&&rest&&rest!==clean(section.title)?rest:section&&clean(section.title)!==titleText?clean(section.title):'');
  const fullTitle=subtitleText?subtitleText.charAt(0).toUpperCase()+subtitleText.slice(1):null;
  const prev=index>0?sections[index-1]:null, next=index>=0&&index<sections.length-1?sections[index+1]:null;
  const adjacent=<nav className={styles.adjacent} aria-label="Adjacent chapters">{prev?<button onClick={()=>navigate(prev.id)}><ArrowLeft size={14}/><span><small>Previous</small>{railName(prev)}</span></button>:<span/>}{next&&<button onClick={()=>navigate(next.id)}><span><small>Next</small>{railName(next)}</span><ArrowRight size={14}/></button>}</nav>;

  return <article className={styles.report} data-report ref={root}>
    <div className={styles.layout}>
      <aside className={`${styles.tile} ${styles.rail}`} data-rail data-tile aria-label="Report contents">
        <div className={styles.railHead}><p className={styles.railTitle}>Contents</p><p className={styles.muted}>As of {date(document.cutoff)} · {sections.length} chapters</p></div>
        <label className={styles.chapterSearch}><Search size={14} aria-hidden="true"/><input type="search" aria-label="Find a chapter" placeholder="Find a chapter" value={query} onChange={e=>setQuery(e.target.value)}/></label>
        <nav aria-label="Report chapters">{chapters.map(({s,i})=><a href={`#report-${s.id}`} key={s.id} title={clean(s.title)} aria-current={active===s.id?'page':undefined} onClick={e=>{e.preventDefault();navigate(s.id);}}><span className={styles.railNum}>{pad(i+1)}</span>{railName(s)}</a>).flatMap((link,j)=>chapters[j].s.id===active&&section?[link,<span key="within" className={styles.within} aria-label="In this chapter">{[['chapter-takeaway','Takeaway'],...(section.coverage.includes('valuation')?[['chapter-lead','Valuation detail']]:section.coverage.includes('monitoring')?[['chapter-lead','KPI health']]:[]),['chapter-analysis','Analysis'],...(exhibitTitles.length?[['chapter-exhibits',`Exhibits ${exhibitTitles.length}`]]:[])].map(([id,name])=><a key={id} href={`#${id}`} aria-current={place===id?'location':undefined} onClick={e=>{e.preventDefault();jump(id);}}>{name}</a>)}</span>]:[link])}{!chapters.length&&<p className={styles.muted}>No chapters match.</p>}</nav>
        <label className={styles.railSelect}><span className={styles.srOnly}>Chapter</span><select value={active} onChange={e=>navigate(e.target.value)}>{sections.map((s,i)=><option key={s.id} value={s.id}>{pad(i+1)} {railName(s)}</option>)}<option value="research-questions">Research questions ({document.questions.length})</option><option value="sources">Sources ({document.evidence.length})</option></select></label>
        <div className={styles.railFoot}>
          <a href="#report-research-questions" aria-current={active==='research-questions'?'page':undefined} onClick={e=>{e.preventDefault();navigate('research-questions');}}>Research questions<span>{document.questions.length}</span></a>
          <a href="#report-sources" aria-current={active==='sources'?'page':undefined} onClick={e=>{e.preventDefault();navigate('sources');}}>Sources<span>{document.evidence.length}</span></a>
        </div>
      </aside>

      <div className={styles.main} id="report-content">
        {document.is_test&&<p className={styles.notice}>Synthetic test report. Not for investment decisions.</p>}
        <Verdict document={document}/>
        <header className={`${styles.tile} ${styles.chapterHead}`} data-tile>
          <div className={styles.chapterTop}>
            <p className={styles.eyebrow} data-chapter-eyebrow>{section?`Chapter ${index+1} of ${sections.length}`:'Appendix'}{section?.coverage.length?` · ${section.coverage.map(c=>label(c)).join(', ')}`:''}</p>
            {section&&<span className={styles.stepper}><button aria-label={prev?`Previous chapter: ${railName(prev)}`:'No previous chapter'} disabled={!prev} onClick={()=>prev&&navigate(prev.id)}><ArrowLeft size={14}/></button><button aria-label={next?`Next chapter: ${railName(next)}`:'No next chapter'} disabled={!next} onClick={()=>next&&navigate(next.id)}><ArrowRight size={14}/></button></span>}
          </div>
          <h2 ref={heading} tabIndex={-1}>{titleText}</h2>
          {fullTitle&&<p className={styles.fullTitle}>{fullTitle}</p>}
          {active==='research-questions'&&<div className={styles.questionSummary} role="group" aria-label="Filter questions by status">
            <span>{document.questions.length} questions</span>
            {(['answered','qualified','blocked'] as const).map(k=>{const n=document.questions.filter(q=>q.status===k).length;return <button key={k} aria-pressed={qFilter===k} disabled={!n} onClick={()=>setQFilter(qFilter===k?null:k)}><span className={styles.status} data-status={questionStatus[k]}>{n} {label(k).toLowerCase()}</span></button>;})}
            {qFilter&&<span>Showing {document.questions.filter(q=>q.status===qFilter).length} of {document.questions.length} · <button className={styles.textButton} onClick={()=>setQFilter(null)}>Clear</button></span>}
          </div>}
          {section&&<p className={styles.meta}><span>{section.paragraphs.length} paragraphs</span><span>{cited} sources cited</span>{!!exhibitTitles.length&&<span>{exhibitTitles.length} exhibits</span>}</p>}
        </header>

        {section?<>
          <section id="chapter-takeaway" className={`${styles.tile} ${styles.takeaway}`} data-tile data-takeaway>
            <header className={styles.tileHead}><h3 data-tile-title>Takeaway</h3></header>
            <div className={styles.tileBody}>{clean(section.implication).split(/\n{2,}/).map((t,i)=><p key={i}>{leadIn(t,{words:true})}</p>)}</div>
          </section>
          {section.coverage.includes('valuation')&&<section id="chapter-lead" className={styles.tile} data-tile><header className={styles.tileHead}><h3 data-tile-title>Valuation detail</h3></header><div className={styles.tileBody}><ValuationDashboard artifacts={document.artifacts} conclusionStatus={document.conclusion_status} hideHero/></div></section>}
          {section.coverage.includes('monitoring')&&<section id={section.coverage.includes('valuation')?undefined:'chapter-lead'} className={styles.tile} data-tile><header className={styles.tileHead}><h3 data-tile-title>KPI health</h3></header><div className={styles.tileBody}><KPIDashboard artifacts={liveArtifacts??document.artifacts} compact/></div></section>}
          {visuals.map((visual,i)=><section className={styles.tile} data-tile key={`${active}-${i}`}><div className={styles.tileBody}><ReportVisual visual={visual} document={document} onSource={showSource}/></div></section>)}
          <div className={styles.split}>
            <section id="chapter-analysis" className={styles.tile} data-tile data-analysis>
              <header className={styles.tileHead}><h3 data-tile-title>Analysis</h3></header>
              <div className={`${styles.tileBody} ${styles.narrative}`}>{section.paragraphs.map((p,i)=><p key={i}>{['assumption','speculation'].includes(p.kind)&&<span className={styles.assumption}>{p.kind==='assumption'?'Analyst assumption':'Speculative'}</span>}{leadIn(clean(p.text))}<Citations ids={p.evidence_ids} document={document} onSource={showSource}/></p>)}
                {financialsHref&&(codeBuilt?built.some(e=>e.home==='history'):section.tables.some(t=>t.path==='observations'))&&<p className={styles.caption}><a href={financialsHref}>Open Financials for the income statement, balance sheet and cash flow.</a></p>}
              </div>
            </section>
            <div className={styles.side}>
              <section className={styles.tile} data-tile data-counterarguments>
                <header className={styles.tileHead}><h3 data-tile-title>Counterarguments</h3></header>
                <div className={styles.tileBody}>{clean(section.counterevidence).split(/\n{2,}/).map((t,i)=><p key={i}>{leadIn(t,{max:60})}</p>)}</div>
              </section>
              {!!section.gaps.length&&<Gaps key={active} gaps={section.gaps}/>}
            </div>
          </div>
          {!!exhibitTitles.length&&<nav id="chapter-exhibits" className={`${styles.tile} ${styles.exhibitIndex}`} aria-label="Exhibits in this chapter" data-tile>
            <h3 data-tile-title>Exhibits <span className={styles.muted}>{exhibitTitles.length}</span></h3>
            <ol>{exhibitTitles.map((title,i)=><li key={i}><a href={`#exhibit-${active}-${i}`} onClick={e=>{e.preventDefault();jump(`exhibit-${active}-${i}`);}}><span className={styles.railNum}>{i+1}</span>{title}</a></li>)}</ol>
          </nav>}
          {codeBuilt
            ?built.map((e,i)=><ExhibitTile key={`${active}-${e.key}`} id={`exhibit-${active}-${i}`} exhibit={e}/>)
            :exhibits.map((t,i)=><Exhibit key={`${active}-${i}`} id={`exhibit-${active}-${i}`} table={t} document={document}/>)}
          {adjacent}
        </>:active==='sources'?<section className={styles.tile} data-tile>
          <header className={styles.tileHead}><h3 data-tile-title>Sources and supporting passages</h3><span className={styles.muted}>{document.evidence.length}</span></header>
          <ol className={styles.sourceList}>{document.evidence.map((e,i)=><li key={e.id} data-source><details><summary><span className={styles.railNum}>{i+1}</span><span>{e.source_title}<small>{date(e.published_at)} · {clean(e.location)}</small></span></summary><blockquote>{e.quote}</blockquote>{safeUrl(e.url)&&<a href={safeUrl(e.url)!} target="_blank" rel="noreferrer">Open original source</a>}</details></li>)}</ol>
        </section>:<>
          {document.questions.filter(q=>!qFilter||q.status===qFilter).map(q=><section key={q.id} className={styles.tile} data-tile data-question>
            <header className={styles.tileHead}><h3 data-tile-title>{clean(q.question)}</h3><span className={styles.questionMeta}>{new Set(document.questions.map(x=>x.materiality)).size>1&&<span>{label(q.materiality)}</span>}<span className={styles.status} data-status={questionStatus[q.status]??''}>{label(q.status)}</span></span></header>
            <div className={`${styles.tileBody} ${styles.questionBody}`}><p>{clean(q.answer)}<Citations ids={q.evidence_ids} document={document} onSource={showSource}/></p>{q.follow_up&&<p className={styles.nextEvidence}><span className={styles.statLabel}>Next evidence needed</span>{clean(q.follow_up)}</p>}</div>
          </section>)}
          <section className={styles.tile} data-tile><header className={styles.tileHead}><h3 data-tile-title>What changed since the last run</h3></header><div className={styles.tileBody}><ChangeLogTable artifacts={document.artifacts}/></div></section>
          <section className={styles.tile} data-tile><header className={styles.tileHead}><h3 data-tile-title>Research coverage</h3></header><div className={styles.tileBody}><ExhibitData title="Research coverage" value={document.coverage.map(c=>({area:label(c.key),outcome:label(c.status),reason:c.rationale}))}/></div></section>
        </>}
      </div>
    </div>
    <dialog ref={dialog} className={styles.dialog} onClose={()=>setSource(null)} aria-labelledby="source-title"><div className={styles.dialogHead}><h2 id="source-title">{evidence?.source_title??'Source note'}</h2><button aria-label="Close source" onClick={()=>dialog.current?.close()}><X size={18}/></button></div>{evidence&&<><p>{date(evidence.published_at)} · {clean(evidence.location)}</p><blockquote>{evidence.quote}</blockquote>{safeUrl(evidence.url)&&<a href={safeUrl(evidence.url)!} target="_blank" rel="noreferrer">Open original source</a>}</>}</dialog>
  </article>;
}
