"use client";

import { useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams, useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { financialStatements, financialPeriod, financialWindow, financialSeries, historyMatrix, label, number, safeUrl } from '@/lib/research/reporting/presentation.mjs';
import styles from './financial-statements.module.css';
import {financialRatios,marketMetrics} from '@/lib/research/reporting/data-views';

type Row = Record<string, any>;
const statements = {all:'All statements', income:'Income statement', balance:'Balance sheet', cashflow:'Cash flow',metrics:'Metrics'};
type Statement = keyof typeof statements;
const summaries = {
  income:['net_revenue','contract_revenue','net_interest_income','net_income'],
  balance:['total_assets','total_liabilities','stockholders_equity','deposits','total_deposits'],
  cashflow:['operating_cash_flow','investing_cash_flow','financing_cash_flow'],
};
const chartMetric = {income:'net_revenue', balance:'total_assets', cashflow:'operating_cash_flow'};
const periodLabel = (period:string) => period.includes('-Q') ? `${period.split('-')[1]} ${period.split('-')[0]}` : period;

export function FinancialStatements({observations, sources, evidence, isTest,filingTables=[]}:{observations:Row[]; sources:Row[]; evidence:Row[]; isTest?:boolean;filingTables?:Row[]}) {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const statement = Object.hasOwn(statements, params.get('statement') ?? '') ? params.get('statement') as Statement : 'all';
  const frequency = params.get('frequency') === 'annual' ? 'annual' : 'quarterly';
  const grouped = financialStatements(observations, frequency);
  const window = financialWindow(observations, frequency, params.get('end') ?? '');
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [selected, setSelected] = useState<Row[]>([]);
  function href(changes:Record<string,string|null>) {
    const next = new URLSearchParams(params.toString());
    next.set('view','financials');
    for (const [key,value] of Object.entries(changes)) value === null ? next.delete(key) : next.set(key,value);
    return `${pathname}?${next}`;
  }
  function showSources(rows:Row[], button:HTMLButtonElement) {
    trigger.current = button;
    setSelected(rows);
    dialog.current?.showModal();
  }
  const available = (value:string) => observations.some(r => r.periodicity === value);
  const selectedRows = observations.filter(r => r.periodicity === frequency);
  const through=window.periods.at(-1)??'';
  const filedCandidates=filingTables.filter(t=>(frequency==='annual'?t.form.startsWith('10-K'):true)&&String(t.fiscal_year)+(frequency==='quarterly'?'Q'+t.fiscal_quarter:'') === through.replace('-','')).sort((a,b)=>b.period_end.localeCompare(a.period_end)||b.filed.localeCompare(a.filed));
  const filedSource=filedCandidates[0]?.source_document_id;
  const filedRows=filedCandidates.filter(t=>t.source_document_id===filedSource);
  const asFiled=params.get('layout')!=='compare'&&filedRows.length>0;
  function originalTables(kind:string) {return <div className={styles.filedTables}>{filedRows.filter(t=>t.statement===kind).map((t,i)=><section key={t.table_index}><h3>{t.title}</h3><p className={styles.note}>{t.form} · Period ended {t.period_end} · Original filing units and comparative periods</p><a className={styles.textLink} href={safeUrl(t.source_url)??undefined} target="_blank" rel="noreferrer">Open original filing</a><div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Complete filing table"><table><tbody>{t.rows.map((r:Row,j:number)=><tr key={j}>{r.cells.map((c:Row,k:number)=>k===0?<th scope="row" key={k} colSpan={c.colspan} rowSpan={c.rowspan}>{c.text}</th>:<td key={k} colSpan={c.colspan} rowSpan={c.rowspan}>{c.text}</td>)}</tr>)}</tbody></table></div></section>)}</div>;}
  const groups = statement === 'all' ? ['income','balance','cashflow'] as const : statement==='metrics'?[]:[statement];

  function table(rows:Row[], title:string, missing:string[] = [], undated = false) {
    const matrix = historyMatrix(rows);
    const units = new Set(matrix.rows.map(row=>[row.unit,row.basis].filter(Boolean).join(' · ')));
    const commonUnit = units.size===1 ? [...units][0] : null;
    const periods = undated ? matrix.periods : window.periods.map(periodLabel);
    if (!rows.length && !missing.length) return <p className={styles.note}>No dated {title.toLowerCase()} observations are available for this frequency.</p>;
    return <div className={styles.tableScroll} tabIndex={0} role="region" aria-label={`${title} table, scroll horizontally for all periods`}>
      <table><caption className={styles.srOnly}>{title}. Select a value for exact amounts and sources.</caption>
        <colgroup><col className={styles.measureColumn}/>{periods.map(p=><col key={p}/>)}</colgroup>
        <thead><tr><th scope="col">Measure{commonUnit&&<small>{commonUnit}</small>}</th>{periods.map(p=><th scope="col" key={p}>{undated?'Period unavailable':p}</th>)}</tr></thead>
        <tbody>{matrix.rows.map((row,index)=><tr key={index}>
          <th scope="row">{row.name}{!commonUnit&&<small>{row.unit}{row.basis ? ` · ${row.basis}` : ''}</small>}</th>
          {periods.map(p=>{const i=matrix.periods.indexOf(p); const records:Row[] = row.observations[i] ?? [];const display=records.length&&records.every(r=>r.value_numeric==null)&&records.some(r=>r.metadata_json?.missing_reason)?(records.some(r=>r.metadata_json?.missing_reason?.startsWith('Not applicable'))?'Not applicable':'Unavailable'):row.values[i];
            return <td key={p}>{records.length ? <button className={styles.value} onClick={e=>showSources(records,e.currentTarget)} title={row.exact[i]} aria-label={`${row.name}, ${undated?'period unavailable':p}: ${display}. Exact values and sources`}>{display}</button> : <span className={styles.missing}>Not disclosed</span>}</td>;
          })}
        </tr>)}{missing.filter(metric=>!rows.some(r=>r.metric_key===metric)).map(metric=><tr key={metric}><th scope="row">{label(metric)}</th>{periods.map(p=><td key={p} className={styles.missing}>Not available</td>)}</tr>)}</tbody>
      </table>
    </div>;
  }

  return <article key={statement+'-'+frequency} className={styles.financials}>
    {isTest&&<p className={styles.note}>Synthetic test research. Not for investment decisions.</p>}
    <header className={styles.heading}><div><h1>Financials</h1><p>{statement==='all'?'Three-statement overview':statements[statement]}</p></div>
    </header>
    <div className={styles.controls}>
      <nav className={styles.tabs} aria-label="Financial statements">{Object.entries(statements).map(([key,title])=><Link scroll={false} key={key} href={href({statement:key})} aria-current={statement===key?'page':undefined}>{title}</Link>)}</nav>
      <div className={styles.frequency} role="group" aria-label="Frequency">{['quarterly','annual'].map(f=>available(f)?<Link scroll={false} key={f} href={href({frequency:f,end:null})} aria-current={frequency===f?'true':undefined}>{label(f)}</Link>:<button key={f} disabled title={`No ${f} observations are saved for this run.`}>{label(f)}</button>)}</div>
    <div className={styles.periodTools}>
      <nav aria-label="Period window">
        {window.earlier?<Link scroll={false} aria-label="Earlier periods" href={href({end:window.earlier})}><ArrowLeft size={16}/></Link>:<button disabled aria-label="Earlier periods"><ArrowLeft size={16}/></button>}
        <label>Period window<select aria-label="Period window" value={window.periods.at(-1)??''} onChange={e=>router.push(href({end:e.target.value}),{scroll:false})} disabled={!window.all.length}>
          {!window.all.length&&<option value="">No periods available</option>}{[...window.all].reverse().map((p,i)=><option key={p} value={p}>{statement!=='all'&&statement!=='metrics'&&asFiled?`${periodLabel(p)} filing`:i===0?`Latest ${Math.min(5,window.all.length)} ${frequency==='annual'?'year':'quarter'}${window.all.length===1?'':'s'}`:`Through ${periodLabel(p)}`}</option>)}
        </select></label>
        {window.later?<Link scroll={false} aria-label="Later periods" href={href({end:window.later})}><ArrowRight size={16}/></Link>:<button disabled aria-label="Later periods"><ArrowRight size={16}/></button>}
      </nav>
    </div>
    </div>
    {!selectedRows.length ? <div className={styles.empty}><h2>No {frequency} financial observations</h2><p>{observations.length?'Choose an available frequency above.':'This run has no saved financial history yet.'}</p></div> : <>
      {statement==='metrics'&&<section className={styles.schedule}><h2>Financial metrics</h2><p className={styles.note}>Select a value for the formula and its inputs. Quarterly returns are annualized. Missing inputs remain unavailable.</p>{table([...marketMetrics(observations,frequency),...financialRatios(observations,frequency)],'Financial metrics')}</section>}
      {statement!=='all'&&statement!=='metrics'&&filedRows.length>0&&<nav className={styles.tabs} aria-label="Statement layout"><Link href={href({layout:'filed'})} scroll={false} aria-current={asFiled?'page':undefined}>As filed</Link><Link href={href({layout:'compare'})} scroll={false} aria-current={!asFiled?'page':undefined}>Compare periods</Link></nav>}
      {groups.map(group=>{
        const allRows:Row[] = grouped[group];
        const summaryKeys = group==='income'&&allRows.some(r=>r.metric_key==='net_revenue') ? summaries.income.filter(key=>key!=='contract_revenue') : summaries[group];
        const rows = allRows.filter(r=>financialPeriod(r) && (statement!=='all'||(summaryKeys.includes(r.metric_key)&&window.periods.includes(financialPeriod(r)))))
          .sort((a,b)=>{if(statement!=='all'&&a.metadata_json?.statement_order!=null&&b.metadata_json?.statement_order!=null)return a.metadata_json.statement_order-b.metadata_json.statement_order;const order=summaries[group];const rank=(key:string)=>order.includes(key)?order.indexOf(key):order.length;return rank(a.metric_key)-rank(b.metric_key);});
        const metric = group==='income' && !allRows.some(r=>r.metric_key==='net_revenue') && allRows.some(r=>r.metric_key==='contract_revenue') ? 'contract_revenue' : chartMetric[group];
        const series = financialSeries(allRows,metric,window.periods);
        return <section key={group} className={styles.statement} data-layout={statement!=='all'&&asFiled?'filed':undefined} aria-label={statements[group]}>
          <div className={styles.sectionTitle}><h2 id={`statement-${group}`}>{statements[group]}</h2><Link scroll={false} className={styles.textLink} href={href({statement:statement==='all'?group:'all'})}>{statement==='all'?'View statement':'Back to all statements'}<ArrowRight size={15}/></Link>
            <Trend series={series} metric={metric}/>
          </div>
          <div className={styles.data}>{statement!=='all'&&asFiled?originalTables(group):<>{table(rows,statements[group],group==='cashflow'?grouped.missingCashFlows:[])}
            <p className={styles.note}>{statement==='all'?'Summary figures. ':''}Select a value for exact amounts and sources.</p>
            {group==='cashflow'&&!!grouped.missingCashFlows.length&&<p className={styles.note}>{grouped.missingCashFlows.map(label).join(', ')}: not available in the saved {frequency} research.</p>}
            {statement!=='all'&&allRows.some(r=>!financialPeriod(r))&&table(allRows.filter(r=>!financialPeriod(r)),'Observations without a fiscal period',[],true)}
          </>}</div>
          {statement!=='all'&&!asFiled&&<div className={styles.detailChart}><h2>{label(metric)}</h2><p className={styles.note}>{series.unit}</p>{series.reason?<p className={styles.note}>{series.reason}</p>:<>
            <div className={styles.barChart} role="img" aria-label={`${label(metric)}. ${series.unit}. Values and sources are in the statement table above.`}><ResponsiveContainer width="100%" height="100%"><BarChart data={series.points.map(p=>({...p,period:periodLabel(p.period)}))} margin={{top:18,right:16,bottom:12,left:4}} accessibilityLayer={false}>
              <CartesianGrid vertical={false} stroke="#e1e4e6"/><XAxis dataKey="period" tick={{fontSize:13,fill:'#626b78'}}/><YAxis width={65} domain={[(v:number)=>Math.min(0,v),(v:number)=>Math.max(0,v)]} tickFormatter={v=>number(v,1)} tick={{fontSize:12,fill:'#626b78'}}/><ReferenceLine y={0} stroke="#626b78"/><Tooltip formatter={v=>[number(v,3),series.unit]}/><Bar dataKey="value" fill="#65738a" isAnimationActive={false}/>
            </BarChart></ResponsiveContainer></div>
            <details className={styles.chartData}><summary>Chart values</summary><ul>{series.points.map(p=><li key={p.period}>{periodLabel(p.period)}: {number(p.value,3)} {series.unit}</li>)}</ul></details>
          </>}</div>}
          {statement!=='all'&&!asFiled&&<details className={styles.filedTables}><summary>Original filed statement</summary>{originalTables(group)}</details>}
        </section>;
      })}
      {statement!=='metrics'&&filedRows.some(t=>t.statement==='equity')&&<details className={styles.other}><summary>Statement of changes in equity · {filedRows[0].form} · {filedRows[0].period_end}</summary>{originalTables('equity')}</details>}
      {!!grouped.other.length&&statement!=='metrics'&&<details className={styles.other}><summary>Other reported metrics</summary>{table(grouped.other.filter(r=>financialPeriod(r)),'Other reported metrics')}{grouped.other.some(r=>!financialPeriod(r))&&table(grouped.other.filter(r=>!financialPeriod(r)),'Other observations without a fiscal period',[],true)}</details>}
    </>}
    <footer className={styles.footnote}>Currency amounts are shown in millions when indicated. Filed tables retain their original units. Select a value for its exact amount and source. Not disclosed means a missing period or value; not available means no numeric series was captured. Neither means zero. Multiple reported values are separated by a slash.</footer>
    <dialog ref={dialog} className={styles.dialog} aria-labelledby="financial-source-title" onClose={()=>trigger.current?.focus()}>
      <header><h2 id="financial-source-title">Reported values & sources</h2><button aria-label="Close source" onClick={()=>dialog.current?.close()}><X size={20}/></button></header>
      {selected.map((row,index)=>{
        const claim = evidence.find(e=>e.id===row.evidence_claim_id);
        const source = sources.find(s=>s.id===(row.source_document_id??claim?.source_document_id));
        const url = safeUrl(row.metadata_json?.source_url || claim?.url || source?.source_url || source?.url);
        return <section key={index}><h3>{row.metadata_json?.statement_label||label(row.metric_key)}{selected.length>1?` · Observation ${index+1}`:''}</h3>
          <p className={styles.exact}>{number(row.value_numeric,12)} {row.unit}</p>{row.value_text&&<p>{row.value_text}</p>}
          {row.formula_or_adjustment&&<p>{row.formula_or_adjustment}</p>}{row.metadata_json?.missing_reason&&<p>{row.metadata_json.missing_reason}</p>}
          {row.metadata_json?.inputs?.map((input:Row,j:number)=><p key={j}>{input.metadata_json?.statement_label||label(input.metric_key)} · {input.fiscal_year}{input.fiscal_quarter?` Q${input.fiscal_quarter}`:''}: {number(input.value_numeric,12)} {input.unit} {safeUrl(input.metadata_json?.source_url)&&<a href={safeUrl(input.metadata_json.source_url)!} target="_blank" rel="noreferrer">Source</a>}</p>)}
          <p>{financialPeriod(row)?periodLabel(financialPeriod(row)!):'Period unavailable'} · {[row.reporting_basis,row.segment,row.geography].filter(Boolean).map(label).join(' · ')}</p>
          {claim||source?<><h4>{claim?.source_title||source?.title||'Saved source'}</h4>{(claim?.location||claim?.source_locator)&&<p>{claim.location||claim.source_locator}</p>}{(claim?.quote||claim?.supporting_quote)&&<blockquote>{claim.quote||claim.supporting_quote}</blockquote>}{url?<a href={url} target="_blank" rel="noreferrer">Open original source</a>:<p>Original source link unavailable.</p>}</>:url?<a href={url} target="_blank" rel="noreferrer">Open original source</a>:!row.metadata_json?.inputs?.some((input:Row)=>safeUrl(input.metadata_json?.source_url))&&<p>Source provenance unavailable in this run.</p>}
        </section>;
      })}
    </dialog>
  </article>;
}

function Trend({series,metric}:{series:ReturnType<typeof financialSeries>;metric:string}) {
  return <figure className={styles.trend}>{series.reason?<p className={styles.note}>{series.reason}</p>:<div role="img" aria-label={`${label(metric)} trend. ${series.points.map(p=>`${periodLabel(p.period)}: ${number(p.value,3)}`).join('; ')}. ${series.unit}.`}>
    <ResponsiveContainer width="100%" height={70}><LineChart data={series.points} margin={{left:8,right:8,top:8,bottom:8}}><YAxis hide domain={['dataMin','dataMax']}/><Line type="linear" dataKey="value" stroke="#596b88" strokeWidth={1.7} dot={{r:2.5}} connectNulls={false} isAnimationActive={false}/></LineChart></ResponsiveContainer>
  </div>}<figcaption>{label(metric)} trend</figcaption></figure>;
}
